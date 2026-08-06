'use strict';

const { app, BaseWindow, WebContentsView, ipcMain, safeStorage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { autoUpdater } = require('electron-updater');
const { COMMUNITY_PREFERENCE_VERSION, createCommunityClient, resolveShareStatsSetting } = require('./community');
const { enqueueStateUpdate, recordObservation } = require('./hunt-metrics');

const GAME_URL = 'https://pokedream.com.br/';
const GAME_DOMAIN = 'pokedream.com.br';
const MAXV = 4;
const BAR = 46;
const SIDE_W = 220;
const GAP = 3;
const COMMUNITY_SEND_INTERVAL_MS = 5 * 60 * 1000 + 5000;
const COMMUNITY_QUIT_TIMEOUT_MS = 3000;
const COMMUNITY_HUB_WAIT_MS = 1500;

// userData persistente (nao some ao fechar)
app.setPath('userData', path.join(app.getPath('appData'), 'poke-dream-launcher'));

let win = null;
let dashView = null;
const games = [];
let selectedSlot = null;
let gameMode = 'grid';
let storageDir = null;
let cfgView = null;      // overlay do menu de config (view própria, por cima das telas do jogo)
let cfgOpen = false;
let sidebarHidden = false;   // barra da esquerda escondida -> telas do jogo ocupam a largura toda
let boxOpen = false;         // Box unificada aberta -> esconde as telas do jogo pra mostrar o painel
let diagOn = false;      // modo diagnóstico: grava frames WS + respostas REST num dump (pra ver o que o jogo manda)
let DUMP_FILE = null;
let SESSION_FILE = null;   // guarda quantas telas estavam abertas, pra reabrir na próxima vez
let SETTINGS_FILE = null;  // preferências (som)
let COMMUNITY_FILE = null; // identidade/revisão comunitária, redundante às preferências
let HUNTLOG_FILE = null;   // histórico acumulado de caçada por espécie
let soundEnabled = true;   // tocar som ao capturar shiny
let soundVolume = 0.8;     // 0..1
let soundPath = null;      // caminho de um áudio do PC do usuário; null = som padrão embutido
let itemVis = { poke_ball: true, ultra_ball: true, premier_ball: true, potion: true, revive: true };  // quais itens aparecem na barra
let itemAlert = { poke_ball: 2000, ultra_ball: 2000, premier_ball: 2000, potion: 2000, revive: 500 };  // limite p/ borda vermelha (0 = sem alerta)
let clientId = null;        // id anônimo e aleatório; só serve pra deduplicar o envio ao banco comunitário
let shareStats = true;      // ligado por padrão; o usuário pode desligar nas configurações
let communityToken = null;  // segredo aleatório desta instalação; nunca é exposto à interface
let communityRevision = 0;  // ordem monotônica dos snapshots (evita um envio antigo sobrescrever o novo)
let communityLastSuccessAt = 0;
let communityLastError = null;
let communitySubmitInFlight = null;
let communitySyncInFlight = null;
let communityTimer = null;
let communityNextSyncAt = 0;
let huntLogSaveTimer = null;
let persistentStateLoaded = false;
let communityQuitPending = false;
let communityQuitFlushed = false;
const communityClient = createCommunityClient();
let diagLines = 0;

// ---- diagnóstico: captura de rede (só grava quando diagOn) ----
function diagWrite(obj) {
  if (!DUMP_FILE || diagLines > 40000) return;   // teto pra não virar GB
  try { fs.appendFileSync(DUMP_FILE, JSON.stringify(obj) + '\n'); diagLines++; } catch {}
}
// as 4 telas mandam praticamente a mesma coisa -> grava só a PRIMEIRA tela (1º card da lista) pra não poluir o dump
function isDumpSlot(slot) { return games.length > 0 && games[0].slot === slot; }
function dumpWs(slot, dir, payload, isBinary) {
  if (isBinary) {   // frames binários podem conter credenciais e não são gravados em claro
    const size = Math.floor(String(payload || '').length * 3 / 4);
    diagWrite({ slot, ts: Date.now(), kind: 'ws', dir, type: 'binary', raw: '<binary omitted>', size });
    return;
  }
  let type = 'unknown';
  try {
    const s = String(payload);
    // Socket.IO: "42/namespace,[\"evento\",...]" ou "42[\"evento\",...]"; Engine.IO: só dígitos ("2","3")
    const m = s.match(/^\d+(\/[^,[]+)?,?(\[[\s\S]*)$/);
    if (m && m[2]) {
      const arr = JSON.parse(m[2]);
      if (Array.isArray(arr) && typeof arr[0] === 'string') type = (m[1] ? m[1].slice(1) + ' ' : '') + arr[0];
    } else if (/^\d+$/.test(s)) {
      type = 'engineio/' + s;   // ping/pong/handshake — ruído
    } else {
      const j = JSON.parse(s); if (j && j.type) type = j.type;
    }
  } catch {}
  diagWrite({ slot, ts: Date.now(), kind: 'ws', dir, type, raw: diagWsPayload(payload) });
}
const REDACT = /([?&](?:token|access_token|jwt|auth|refresh(?:Token)?|password)=)[^&]*/gi;
const SENSITIVE_DIAG_KEY = /^(?:(?:access|refresh|auth|id)?_?token|jwt|password|authorization|secret|email|api_?key|character_?id|user_?id|account_?id)$/i;
const IDENTITY_DIAG_KEY = /^(?:id|name|display_?name|username)$/i;
function diagUrl(url) {
  return String(url).replace(REDACT, '$1<redacted>').replace(/(\/characters\/)[^/?]+/gi, '$1<redacted>');
}
function redactDiagValue(value, depth = 0, redactIdentity = false) {
  if (depth > 12 || value == null) return value;
  if (Array.isArray(value)) return value.map((entry) => redactDiagValue(entry, depth + 1, redactIdentity));
  if (typeof value === 'object') {
    const clean = {};
    for (const [key, entry] of Object.entries(value)) {
      clean[key] = (SENSITIVE_DIAG_KEY.test(key) || (redactIdentity && IDENTITY_DIAG_KEY.test(key)))
        ? '<redacted>'
        : redactDiagValue(entry, depth + 1, redactIdentity);
    }
    return clean;
  }
  if (typeof value === 'string' && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return '<redacted-jwt>';
  return value;
}
function isIdentityDiagUrl(url) {
  return /\/auth(?:\/|\?|$)|\/characters(?:\?|$)/i.test(String(url || ''));
}
function diagBody(body, url) {
  const redactIdentity = isIdentityDiagUrl(url);
  try { return JSON.stringify(redactDiagValue(JSON.parse(body), 0, redactIdentity)); }
  catch {
    let text = String(body || '')
      .replace(REDACT, '$1<redacted>')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
      .replace(/("(?:accessToken|refreshToken|token|password|email)"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2');
    if (redactIdentity) text = text.replace(/("(?:id|name|displayName|username)"\s*:\s*)(?:"[^"]*"|[0-9]+)/gi, '$1"<redacted>"');
    return text;
  }
}
function diagWsPayload(payload) {
  const text = String(payload || '');
  const socket = text.match(/^(\d+(?:\/[^,[]+)?,?)(\[[\s\S]*)$/);
  if (socket) {
    try { return socket[1] + JSON.stringify(redactDiagValue(JSON.parse(socket[2]))); }
    catch {}
  }
  return diagBody(text);
}
function dumpHttp(slot, url, body, b64) {
  let raw = body; if (b64) { try { raw = Buffer.from(body, 'base64').toString('utf8'); } catch {} }
  raw = diagBody(raw, url);
  if (raw && raw.length > 1000000) raw = raw.slice(0, 1000000) + '…[truncado]';
  diagWrite({ slot, ts: Date.now(), kind: 'http', url: diagUrl(url), raw });
}
function dumpHttpReq(slot, url, body) {   // corpo do REQUEST (ex.: POST /save carrega o estado)
  let raw = diagBody(body, url); if (raw && raw.length > 1000000) raw = raw.slice(0, 1000000) + '…[truncado]';
  diagWrite({ slot, ts: Date.now(), kind: 'http-req', url: diagUrl(url), raw });
}

// ---- extrai nome / hunt / pokémon ATIVO do estado pra alimentar a sidebar ----
// progress.activeUid = uid do pokémon ativo na hunt (muda quando você troca). Casa com o box pelo uid.
// shiny = a entrada do box tem `shiny:true`.
// XP por nível (fórmula do jogo: floor(xpBase * level^xpExp), xpBase=20, xpExp=1.5)
function xpNeeded(level) { return Math.floor(20 * Math.pow(Math.max(1, level || 1), 1.5)); }
function xpPct(p) { if (!p || p.xp == null || p.level == null) return null; const n = xpNeeded(p.level); if (!n) return 0; return Math.max(0, Math.min(100, Math.round(p.xp / n * 100))); }
function pokeView(g, uid) { const p = g._box && g._box[uid]; if (!p) return null; return { species: p.species, level: p.level, shiny: !!p.shiny, xpPct: xpPct(p) }; }

// recomputa g.active (pokémon ativo na hunt) + g.party2 (2º da party) -> devolve true se algo mudou
function refreshActive(g) {
  const active = g._activeUid != null ? pokeView(g, g._activeUid) : null;
  const p2uid = (Array.isArray(g._party) && g._party.length > 1) ? g._party[1] : null;
  const party2 = p2uid != null ? pokeView(g, p2uid) : null;
  const sig = JSON.stringify([active, party2]);
  if (sig === g._sig) return false;
  g._sig = sig; g.active = active; g.party2 = party2;
  return true;
}
// reconstrói o box a partir do array completo (vem em /offline e tbm no /save quando há captura)
// e detecta shiny NOVO -> dispara o som. Baseline: o 1º box visto (carga) não toca nada.
function rebuildBox(g, boxArr) {
  g._box = {};
  for (const p of boxArr) if (p && p.uid != null) g._box[p.uid] = { uid: p.uid, species: p.species, level: p.level, xp: p.xp, shiny: !!p.shiny, potential: p.potential, essence: p.essence, stored: p.stored };
  g._freshShinyBatch = checkShinyCaptures(g);
}
function checkShinyCaptures(g) {
  const known = g._shinyUids || (g._shinyUids = new Set());
  const first = !g._baselineDone;
  const fresh = [];
  for (const uid in g._box) { const p = g._box[uid]; if (p && p.shiny && !known.has(uid)) { known.add(uid); if (!first) fresh.push(p); } }
  g._baselineDone = true;
  if (!first && dashView) for (const p of fresh) send(dashView, 'shiny-caught', { slot: g.slot, species: p.species });
  return fresh.map((p) => p.species);
}
// estatísticas: guarda os contadores que o jogo manda (cheios no /offline, parciais no /save)
// + um baseline com timestamp, pra calcular as taxas da sessão (por hora).
const STAT_NUMS = ['totalCaught', 'kills', 'shinyKills', 'money', 'trainerLevel', 'trainerXp', 'level'];
function grabStats(g, prog) {
  if (!prog) return;
  const s = g._stats || (g._stats = {});
  for (const k of STAT_NUMS) if (typeof prog[k] === 'number') s[k] = prog[k];
  // espécie da hunt atual: o wilds traz a grafia exata (ex. "MrMime"), melhor que derivar do huntId
  if (Array.isArray(prog.wilds)) {
    const species = [...new Set(prog.wilds.map(x => x && (x.spawnSpecies || x.species)).filter(Boolean))];
    s.huntSpeciesList = species;
    s.huntSpecies = species[0] || null;
  }
  // baseline da sessão: 1ª leitura vira a referência pras taxas /h
  if (!g._statBase && s.kills != null) g._statBase = { ts: Date.now(), totalCaught: s.totalCaught, kills: s.kills, shinyKills: s.shinyKills, money: s.money };
  if (g._statBase) {
    for (const k of ['totalCaught', 'kills', 'shinyKills', 'money']) {
      if (g._statBase[k] == null && s[k] != null) g._statBase[k] = s[k];
    }
  }
  // baseline da HUNT: zera sempre que a hunt muda, pra medir só a caçada atual
  if (s.kills != null && (!g._huntBase || g._huntBase.huntId !== g.hunt)) {
    g._huntBase = { huntId: g.hunt, ts: Date.now(), totalCaught: s.totalCaught, kills: s.kills, shinyKills: s.shinyKills };
  }
  if (g._huntBase) {
    for (const k of ['totalCaught', 'kills', 'shinyKills']) {
      if (g._huntBase[k] == null && s[k] != null) g._huntBase[k] = s[k];
    }
  }
  accumulateHuntLog(g, prog, s);
}

// ---- histórico acumulado por espécie (persiste em disco; soma todas as contas) ----
// As bolas são agrupadas por chance de captura: Poke de um lado, Ultra+Premier do outro.
const BALL_A = ['poke_ball'], BALL_B = ['ultra_ball', 'premier_ball'];
const MAX_GAP_MS = 60000;   // pausa maior que isso não conta como tempo de caçada
let huntLog = {}, huntLogDirty = false, legacyHuntLog = null;

function sumBalls(bag, keys) { let n = 0; for (const k of keys) n += (bag && bag[k]) || 0; return n; }
function huntEntry(sp) {
  return huntLog[sp] || (huntLog[sp] = { ms: 0, kills: 0, caught: 0, shinies: 0, shinyCaught: 0, thrownA: 0, thrownB: 0, caughtA: 0, caughtB: 0, captureDryBalls: 0, dryBalls: 0, dryKills: 0, updated: 0 });
}
function accumulateHuntLog(g, prog, s) {
  const sp = s.huntSpecies;
  const speciesList = Array.isArray(s.huntSpeciesList) && s.huntSpeciesList.length ? s.huntSpeciesList : (sp ? [sp] : []);
  const prev = g._accPrev;
  const now = Date.now();
  // a bag só vem no /save quando muda; sem isso a leitura viraria null e o delta seguinte se perdia
  const bag = prog.bag || g._bag;
  // shinyKills conta shinies encontrados/derrotados; capturas continuam separadas em totalCaught.
  const cur = { ts: now, huntId: g.hunt, species: sp, speciesCount: speciesList.length, kills: s.kills, caught: s.totalCaught, shinies: s.shinyKills,
                ballA: bag ? sumBalls(bag, BALL_A) : null, ballB: bag ? sumBalls(bag, BALL_B) : null };
  g._accPrev = cur;
  const primaryObserver = g._charId ? games.find((other) => other._charId === g._charId) : null;
  if (primaryObserver && primaryObserver !== g) return;
  // Os contadores globais não dizem qual espécie mudou. Em hunts com várias espécies, o
  // launcher não inventa uma atribuição por espécie.
  if (!sp || speciesList.length !== 1 || !prev || prev.speciesCount !== 1 || prev.huntId !== g.hunt || prev.species !== sp) return;

  const e = huntEntry(sp);
  const gap = now - prev.ts;
  const timeAdvanced = gap > 0 && gap < MAX_GAP_MS;

  const dKills = (cur.kills != null && prev.kills != null) ? Math.max(cur.kills - prev.kills, 0) : 0;
  const dCaught = (cur.caught != null && prev.caught != null) ? Math.max(cur.caught - prev.caught, 0) : 0;
  const dShiny = (cur.shinies != null && prev.shinies != null) ? Math.max(cur.shinies - prev.shinies, 0) : 0;
  // bolas: só QUEDA conta como lançamento (aumento é drop/compra)
  const tA = (cur.ballA != null && prev.ballA != null) ? Math.max(prev.ballA - cur.ballA, 0) : 0;
  const tB = (cur.ballB != null && prev.ballB != null) ? Math.max(prev.ballB - cur.ballB, 0) : 0;
  const confirmedShinyCaught = dCaught && Array.isArray(g._freshShinyBatch)
    ? g._freshShinyBatch.filter((species) => species === sp).length
    : 0;
  if (recordObservation(e, {
    ms: timeAdvanced ? gap : 0,
    kills: dKills,
    caught: dCaught,
    shinies: dShiny,
    shinyCaught: confirmedShinyCaught,
    thrownA: tA,
    thrownB: tB,
    now,
  })) huntLogDirty = true;
}
// v3: nova época confiável, formada apenas por diferenças observadas pelo launcher em hunts
// de uma única espécie. Históricos anteriores são descartados para não carregar atribuições mistas.
const HUNTLOG_V = 3;
function loadHuntLog() {
  const j = readJsonWithBackup(HUNTLOG_FILE);
  const valid = !!(j && j.v === HUNTLOG_V && j.data && typeof j.data === 'object');
  huntLog = valid ? j.data : {};
  legacyHuntLog = j && !valid ? j : null;
  if (legacyHuntLog) huntLogDirty = true;
}
function preserveLegacyHuntLog() {
  if (!legacyHuntLog) return true;
  const version = Number.isSafeInteger(legacyHuntLog.v) && legacyHuntLog.v >= 0 ? `v${legacyHuntLog.v}` : 'legacy';
  const file = `${HUNTLOG_FILE}.${version}.bak`;
  try {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (existing && existing.v === legacyHuntLog.v) { legacyHuntLog = null; return true; }
  } catch {}
  if (!writeJsonAtomic(file, legacyHuntLog)) return false;
  legacyHuntLog = null;
  return true;
}
function saveHuntLog() {
  if (!huntLogDirty || !HUNTLOG_FILE) return;
  if (!preserveLegacyHuntLog()) return;
  if (writeJsonAtomic(HUNTLOG_FILE, { v: HUNTLOG_V, data: huntLog })) huntLogDirty = false;
}
function updateHunt(g, huntId) {
  if (huntId == null || huntId === g.hunt) return false;
  g.hunt = huntId;
  g._accPrev = null;
  if (g._stats) { g._stats.huntSpecies = null; g._stats.huntSpeciesList = []; }
  return true;
}
function applyState(g, state) {   // estado COMPLETO (/offline ou /save cheio): guarda o box e o ativo
  if (!state) return false;
  const prog = state.progress || state;
  let changed = false;
  g._freshShinyBatch = [];
  if (updateHunt(g, state.huntId)) changed = true;
  if (Array.isArray(prog.box)) rebuildBox(g, prog.box);
  grabStats(g, prog);
  if (prog.bag && typeof prog.bag === 'object') g._bag = prog.bag;   // mochila (item -> qtd); vem cheia
  if (prog.money != null) g._money = prog.money;
  if (Array.isArray(prog.party)) g._party = prog.party.slice();
  if (prog.activeUid != null) g._activeUid = prog.activeUid;
  if (refreshActive(g)) changed = true;
  return changed;
}
function applyPatch(g, patch) {   // delta descomprimido: campos que MUDARAM (activeUid, huntId, boxDelta com xp, box cheio na captura)
  let changed = false;
  g._freshShinyBatch = [];
  if (updateHunt(g, patch.huntId)) changed = true;
  const prog = patch.progress || {};
  if (Array.isArray(prog.box)) rebuildBox(g, prog.box);   // captura online reenvia o box inteiro aqui
  else if (patch.boxDelta && g._box) for (const uid in patch.boxDelta) { const d = patch.boxDelta[uid], e = g._box[uid]; if (e && d) { if (d.level != null) e.level = d.level; if (d.xp != null) e.xp = d.xp; } }
  grabStats(g, prog);
  if (prog.bag && typeof prog.bag === 'object') g._bag = prog.bag;   // o /save reenvia a bag inteira quando ela muda
  if (prog.money != null) g._money = prog.money;
  if (Array.isArray(prog.party)) g._party = prog.party.slice();
  if (prog.activeUid != null) g._activeUid = prog.activeUid;
  if (refreshActive(g)) changed = true;
  return changed;
}
function resetCurrentHuntSequences(g) {
  const s = g._stats || {};
  const species = Array.isArray(s.huntSpeciesList) && s.huntSpeciesList.length === 1 ? s.huntSpeciesList[0] : null;
  const entry = species && huntLog[species];
  if (!entry) return;
  entry.captureDryBalls = 0;
  entry.dryBalls = 0;
  entry.dryKills = 0;
  entry.pend = 0;
  huntLogDirty = true;
}
function resetUncertainHuntWindow(g) {
  g._accPrev = null;
  resetCurrentHuntSequences(g);
}
function resetCharacterState(g) {
  g._stats = null; g._statBase = null; g._huntBase = null; g._accPrev = null;
  g._box = {}; g._party = []; g._activeUid = null; g._bag = null; g._money = null;
  g._sig = null; g.active = null; g.party2 = null; g.hunt = null;
  g._shinyUids = new Set(); g._baselineDone = false; g._stateOrder = null; g.charName = null;
}
function payloadStateVersion(envelope) {
  const baseVersion = Number(envelope && envelope.baseVersion);
  if (Number.isSafeInteger(baseVersion) && baseVersion >= 0 && baseVersion < Number.MAX_SAFE_INTEGER) return baseVersion + 1;
  const version = Number(envelope && envelope.version);
  return Number.isSafeInteger(version) && version >= 0 ? version : null;
}
function feedState(g, url, body) {   // usado por /offline (resposta) e /save (request)
  const m = url.match(/\/characters\/([^/]+)\//);
  let j; try { j = JSON.parse(body); } catch { return; }
  if (m && g._charId && g._charId !== m[1]) resetCharacterState(g);
  if (m) g._charId = m[1];
  const stateVersion = payloadStateVersion(j);
  const st = j.state || j;
  let decoded, full;
  if (st.patchGz || st.stateGz) {
    const packed = st.patchGz || st.stateGz;
    try { decoded = JSON.parse(zlib.gunzipSync(Buffer.from(packed, 'base64')).toString('utf8')); } catch { return; }
    full = !!st.stateGz;
  } else {
    decoded = st.progress ? st : (j.state || null);
    full = true;
  }
  if (!decoded) return;
  const order = g._stateOrder || (g._stateOrder = { version: null, pending: new Map() });
  const ready = enqueueStateUpdate(order, { version: stateVersion, full, decoded });
  let changed = false;
  for (const update of ready) {
    if (update.resetBaseline) resetUncertainHuntWindow(g);
    changed = (update.full ? applyState(g, update.decoded) : applyPatch(g, update.decoded)) || changed;
    if (update.resetBaseline) resetCurrentHuntSequences(g);
  }
  resolveName(g);
  if (changed || m) pushAccounts();
}
function isInfoUrl(url) { return /\/characters(\?|$)/.test(url) || /\/characters\/[^/]+\/offline$/.test(url); }
function isStateReqUrl(url) { return /\/characters\/[^/]+\/(save|actions)$/.test(url); }   // POSTs com o estado
function parseInfo(g, url, body) {
  let j; try { j = JSON.parse(body); } catch { return; }
  if (Array.isArray(j) && j[0] && j[0].id && j[0].name) {   // GET /characters -> lista de personagens
    g._charNames = {}; for (const c of j) if (c && c.id) g._charNames[c.id] = c.name;
    resolveName(g); pushAccounts(); return;
  }
  feedState(g, url, body);   // GET /characters/<id>/offline -> estado completo
}
function resolveName(g) { if (g._charNames && g._charId && g._charNames[g._charId]) g.charName = g._charNames[g._charId]; }
function pushAccounts() { if (dashView) send(dashView, 'accounts', buildAccountsPayload()); }

// anexa o CDP na tela do jogo. SEMPRE lê /characters + /offline (pra sidebar); só grava o dump quando diagOn.
function attachCapture(g) {
  const wc = g.view.webContents;
  const reqs = new Map();   // requestId -> url (das chamadas AJAX que interessam)
  try { wc.debugger.attach('1.3'); } catch (e) { console.error('[diag] attach', g.slot, e && e.message); return; }
  wc.debugger.sendCommand('Network.enable').catch(() => {});
  wc.debugger.on('message', (_e, method, params) => {
    try {
      if (method === 'Network.requestWillBeSent') {
        // POST /save (e /actions) carregam o estado ATUAL no corpo -> alimenta a sidebar ao vivo + dump
        const req = params.request, url = req && req.url;
        if (!url || !isStateReqUrl(url)) return;
        const handle = (pd) => { if (pd == null) return; if (diagOn && isDumpSlot(g.slot)) dumpHttpReq(g.slot, url, pd); feedState(g, url, pd); };
        if (req.postData != null) handle(req.postData);
        else if (req.hasPostData) wc.debugger.sendCommand('Network.getRequestPostData', { requestId: params.requestId }).then((r) => handle(r && r.postData)).catch(() => {});
      } else if (method === 'Network.webSocketCreated') {
        if (diagOn && isDumpSlot(g.slot)) diagWrite({ slot: g.slot, ts: Date.now(), kind: 'ws-open', url: String(params.url || '').split('?')[0] });
      } else if (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') {
        if (!diagOn || !isDumpSlot(g.slot)) return;
        const r = params.response, dir = method === 'Network.webSocketFrameSent' ? 'sent' : 'recv';
        if (r && r.payloadData != null && (r.opcode === 1 || r.opcode === 2)) dumpWs(g.slot, dir, r.payloadData, r.opcode === 2);
      } else if (method === 'Network.responseReceived') {
        const t = params.type, url = params.response && params.response.url;
        if (url && (t === 'XHR' || t === 'Fetch')) reqs.set(params.requestId, url);
      } else if (method === 'Network.loadingFinished') {
        const url = reqs.get(params.requestId); if (url == null) return; reqs.delete(params.requestId);
        const info = isInfoUrl(url), dump = diagOn && isDumpSlot(g.slot);
        if (!info && !dump) return;
        wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then((res) => {
          if (!res || res.body == null) return;
          const text = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
          if (dump) dumpHttp(g.slot, url, res.body, res.base64Encoded);
          if (info) try { parseInfo(g, url, text); } catch {}
        }).catch(() => {});
      }
    } catch {}
  });
}

function activeSlots() { return games.map(g => g.slot); }
function nextFreeSlot() { for (let s = 1; s <= MAXV; s++) if (!activeSlots().includes(s)) return s; return null; }

// ---- persistencia de cookies (sessao -> persistentes 60 dias) ----
async function persistCookies(g) {
  try {
    const ses = g.view.webContents.session;
    const cookies = await ses.cookies.get({ domain: GAME_DOMAIN });
    const far = Math.floor(Date.now() / 1000) + 60 * 24 * 3600; // 60 dias
    for (const c of cookies) {
      if (!c.session) continue;
      const host = String(c.domain || '').replace(/^\./, '');
      if (!host) continue;
      const url = (c.secure ? 'https://' : 'http://') + host + (c.path || '/');
      // preserva o sameSite ORIGINAL do cookie (forçar 'lax' quebrava cookies cross-site que
      // precisam de 'no_restriction'); só cai pra 'lax' quando o valor vem indefinido.
      const sameSite = ['no_restriction', 'lax', 'strict'].includes(c.sameSite) ? c.sameSite : 'lax';
      try {
        await ses.cookies.set({ url, name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite, expirationDate: far });
      } catch {}
    }
    await ses.cookies.flushStore();
  } catch {}
}

// ---- backup/restore de localStorage e sessionStorage ----
// SEGURANÇA: o storage do jogo costuma guardar o TOKEN de login. Antes isso ia pro disco em
// TEXTO PURO (storage-accN.json) — qualquer um que lesse o arquivo roubava a sessão. Agora
// criptografamos com safeStorage (DPAPI no Windows / Keychain no macOS / libsecret no Linux).
function storageFile(slot) { return path.join(storageDir, `storage-acc${slot}.bin`); }
function legacyStorageFile(slot) { return path.join(storageDir, `storage-acc${slot}.json`); }

function writeStorageEncrypted(slot, json) {
  try {
    const buf = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)                 // criptografado pelo SO
      : Buffer.from('PLAIN:' + json, 'utf8');           // fallback raro (SO sem cripto disponível)
    fs.writeFileSync(storageFile(slot), buf);
  } catch {}
}
function readStorageDecrypted(slot) {
  // formato novo (.bin criptografado)
  try {
    if (fs.existsSync(storageFile(slot))) {
      const buf = fs.readFileSync(storageFile(slot));
      const json = buf.slice(0, 6).toString('utf8') === 'PLAIN:' ? buf.slice(6).toString('utf8') : safeStorage.decryptString(buf);
      return JSON.parse(json);
    }
  } catch {}
  // migração: lê o .json antigo (texto puro), re-salva criptografado e apaga o antigo
  try {
    const old = legacyStorageFile(slot);
    if (fs.existsSync(old)) {
      const raw = fs.readFileSync(old, 'utf8');
      writeStorageEncrypted(slot, raw);
      try { fs.unlinkSync(old); } catch {}
      return JSON.parse(raw);
    }
  } catch {}
  return null;
}

async function saveStorage(g) {
  try {
    const wc = g.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    const data = await wc.executeJavaScript('({ls:JSON.parse(JSON.stringify(localStorage)),ss:JSON.parse(JSON.stringify(sessionStorage))})', true);
    const json = JSON.stringify(data);
    const hash = crypto.createHash('sha1').update(json).digest('hex');
    if (g._storageHash === hash) return;   // nada mudou desde o último save → não regrava (economiza I/O)
    g._storageHash = hash;
    writeStorageEncrypted(g.slot, json);
  } catch {}
}

async function restoreStorage(g) {
  const data = readStorageDecrypted(g.slot);
  if (!data) return;
  try {
    const wc = g.view.webContents;
    if (data.ls) {
      await wc.executeJavaScript(`Object.entries(${JSON.stringify(data.ls)}).forEach(function(e){try{localStorage.setItem(e[0],e[1])}catch(_){}})`, true);
    }
    if (data.ss) {
      await wc.executeJavaScript(`Object.entries(${JSON.stringify(data.ss)}).forEach(function(e){try{sessionStorage.setItem(e[0],e[1])}catch(_){}})`, true);
    }
  } catch {}
}

// ---- layout (grid / foco) ----
function _tiles(count, x, y, w, h) {
  if (count <= 1) return [{ x, y, width: w, height: h }];
  const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
  if (count === 2) return [{ x, y, width: hw, height: h }, { x: x + hw, y, width: w - hw, height: h }];
  if (count === 3) return [{ x, y, width: hw, height: hh }, { x: x + hw, y, width: w - hw, height: hh }, { x, y: y + hh, width: w, height: h - hh }];
  return [{ x, y, width: hw, height: hh }, { x: x + hw, y, width: w - hw, height: hh }, { x, y: y + hh, width: hw, height: h - hh }, { x: x + hw, y: y + hh, width: w - hw, height: h - hh }];
}

function tileRects(count, x, y, w, h) {
  return _tiles(count, x, y, w, h).map(r => ({ x: r.x + GAP, y: r.y + GAP, width: Math.max(r.width - GAP * 2, 20), height: Math.max(r.height - GAP * 2, 20) }));
}

function setViewBounds(v, r) {
  try { const c = v.getBounds(); if (c.x === r.x && c.y === r.y && c.width === r.width && c.height === r.height) return; } catch {}
  v.setBounds(r);
}

function layout() {
  if (!win) return;
  const b = win.getContentBounds();
  setViewBounds(dashView, { x: 0, y: 0, width: b.width, height: b.height });

  const x0 = sidebarHidden ? 0 : SIDE_W, y0 = BAR, w = Math.max(b.width - x0, 100), h = Math.max(b.height - y0, 100);
  const target = new Map();

  // Box aberta: nenhuma tela do jogo visível, pra o painel da Box (no dashView) aparecer
  if (!boxOpen) {
    if (gameMode === 'grid') {
      const rects = tileRects(games.length, x0, y0, w, h);
      games.forEach((g, i) => { if (rects[i]) target.set(g.slot, rects[i]); });
    } else if (gameMode === 'single' && selectedSlot != null) {
      if (games.some(x => x.slot === selectedSlot)) {
        target.set(selectedSlot, { x: x0, y: y0, width: w, height: h });
      }
    }
  }

  games.forEach(g => {
    const r = target.get(g.slot);
    if (r) { setViewBounds(g.view, r); if (!g._shown) { g.view.setVisible(true); g._shown = true; } }
    else if (g._shown) { g.view.setVisible(false); g._shown = false; }
  });

  if (cfgOpen) positionCfg();   // mantém o menu de config no canto ao redimensionar
}

// posiciona o overlay de config no canto superior direito (sobre a area do jogo)
function positionCfg() {
  if (!win || !cfgView) return;
  const b = win.getContentBounds();
  const W = 300, H = 400;
  const width = Math.min(W, Math.max(b.width - SIDE_W - 12, 180));
  const height = Math.min(H, Math.max(b.height - BAR - 14, 140));
  const x = Math.max(b.width - width - 10, SIDE_W + 4);
  setViewBounds(cfgView, { x, y: BAR + 6, width, height });
}

// abre/fecha o menu de config (traz a view pro TOPO da ordem z, por cima das telas do jogo)
function setConfigOpen(open) {
  if (!cfgView) return cfgOpen;
  cfgOpen = !!open;
  if (cfgOpen) {
    try { win.contentView.addChildView(cfgView); } catch {}   // re-adiciona = vai pro topo
    positionCfg();
    cfgView.setVisible(true);
    try { cfgView.webContents.focus(); } catch {}
  } else {
    cfgView.setVisible(false);
  }
  return cfgOpen;
}

// ---- criar/fechar telas ----
function createGame(slot) {
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:acc${slot}`,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const g = { view, slot, _shown: false, _persistTimer: null, _restored: false, _loopGuard: false, _loads: [] };
  const wc = view.webContents;

  // persiste cookies+storage de forma DEBOUNCED (agrupa rajadas de navegação num único save)
  const persistSoon = () => {
    if (g._persistTimer) clearTimeout(g._persistTimer);
    g._persistTimer = setTimeout(() => { persistCookies(g).catch(() => {}); saveStorage(g).catch(() => {}); }, 1200);
  };

  wc.on('did-navigate', persistSoon);
  wc.on('did-navigate-in-page', persistSoon);

  wc.on('did-finish-load', () => {
    const now = Date.now();
    g._loads = g._loads.filter(t => now - t < 12000); g._loads.push(now);

    // DETECTOR DE LOOP: 5+ carregamentos em 12s = a pagina esta recarregando sozinha.
    // Suspeito nº1 e a injecao de storage do restoreStorage -> paramos de injetar pra quebrar o ciclo.
    if (g._loads.length >= 5) {
      if (!g._loopGuard) { g._loopGuard = true; console.warn(`[launcher] acc${slot}: loop de reload detectado — restauracao de storage suspensa pra quebrar o ciclo`); }
      return;
    }
    if (g._loopGuard) return;
    // restaura o storage UMA VEZ so (se injetar a cada load e o jogo reagir recarregando, vira loop)
    if (g._restored) return;
    g._restored = true;
    restoreStorage(g).catch(() => {});
  });

  // rede de segurança periódica (o saveStorage só grava de fato quando algo mudou)
  g._saveInterval = setInterval(() => { if (!g._loopGuard) { persistCookies(g).catch(() => {}); saveStorage(g).catch(() => {}); } }, 30000);

  attachCapture(g);   // CDP pra o dump de diagnóstico (só grava quando ligado nas config)
  wc.loadURL(GAME_URL).catch(e => console.error('[launcher] loadURL', slot, e && e.message));
  win.contentView.addChildView(view);
  view.setVisible(false);
  games.push(g);
  return g;
}

function addGame() {
  if (games.length >= MAXV) return activeSlots();
  const slot = nextFreeSlot(); if (!slot) return activeSlots();
  createGame(slot);
  layout();
  send(dashView, 'accounts', buildAccountsPayload());
  saveSession();
  return activeSlots();
}

function removeGame(slot) {
  const i = games.findIndex(g => g.slot === slot);
  if (i < 0) return activeSlots();
  const g = games[i];
  if (g._saveInterval) clearInterval(g._saveInterval);
  if (g._persistTimer) clearTimeout(g._persistTimer);
  saveStorage(g).catch(() => {});   // salva antes de fechar
  try { win.contentView.removeChildView(g.view); } catch {}
  games.splice(i, 1);
  if (selectedSlot === slot) {
    selectedSlot = games.length ? games[0].slot : null;
    if (selectedSlot) gameMode = 'single';
    else gameMode = 'grid';
  }
  layout();
  send(dashView, 'accounts', buildAccountsPayload());
  saveSession();
  return activeSlots();
}

// resumo de itens da conta pra sidebar: 3 balls + potion/revive agregados (+ money)
function sumBag(bag, re) { if (!bag) return 0; let s = 0; for (const k in bag) if (re.test(k)) s += (bag[k] || 0); return s; }
function itemSummary(g) {
  const bag = g._bag || {};
  return {
    money: g._money || 0,
    poke_ball: bag.poke_ball || 0,
    ultra_ball: bag.ultra_ball || 0,
    premier_ball: bag.premier_ball || 0,
    potion: sumBag(bag, /potion/i),   // agrega qualquer *_potion
    revive: sumBag(bag, /revive/i),   // agrega revive + max_revive etc.
  };
}
function buildAccountsPayload() {
  const info = {};
  for (const g of games) info[g.slot] = { name: g.charName || null, hunt: g.hunt || null, active: g.active || null, party2: g.party2 || null, items: itemSummary(g) };
  return { slots: activeSlots(), selected: selectedSlot, mode: gameMode, info };
}

function send(target, ch, payload) {
  try { if (target && !target.webContents.isDestroyed()) target.webContents.send(ch, payload); } catch {}
}

// ---- lembra quantas telas estavam abertas, pra reabrir na próxima vez ----
function saveSession() { try { if (SESSION_FILE) fs.writeFileSync(SESSION_FILE, JSON.stringify({ views: games.length })); } catch {} }
function loadSessionCount() {
  try { const j = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); const n = parseInt(j.views, 10); if (n >= 1 && n <= MAXV) return n; } catch {}
  return 1;
}

// ---- preferências (som) ----
function readJsonWithBackup(file) {
  if (!file) return null;
  for (const candidate of [file, file + '.bak']) {
    try { return JSON.parse(fs.readFileSync(candidate, 'utf8')); } catch {}
  }
  return null;
}
function writeJsonAtomic(file, value) {
  if (!file) return false;
  const temp = file + '.tmp';
  const backup = file + '.bak';
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.copyFileSync(file, backup);
    } catch {}
    fs.renameSync(temp, file);
    return true;
  } catch {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
    return false;
  }
}
function validCommunityIdentity(value) {
  return !!value
    && typeof value.clientId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.clientId)
    && typeof value.communityToken === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(value.communityToken);
}
function saveCommunityState() {
  return writeJsonAtomic(COMMUNITY_FILE, { clientId, communityToken, communityRevision, communityLastSuccessAt });
}
function loadSettings() {
  const j = readJsonWithBackup(SETTINGS_FILE) || {};
  try {
    soundEnabled = j.soundEnabled !== false;
    if (typeof j.soundVolume === 'number') soundVolume = Math.max(0, Math.min(1, j.soundVolume));
    soundPath = (typeof j.soundPath === 'string' && j.soundPath) ? j.soundPath : null;
    if (j.itemVis && typeof j.itemVis === 'object') for (const k in itemVis) itemVis[k] = j.itemVis[k] !== false;
    if (j.itemAlert && typeof j.itemAlert === 'object') for (const k in itemAlert) { const n = Number(j.itemAlert[k]); if (Number.isFinite(n) && n >= 0) itemAlert[k] = Math.round(n); }
    shareStats = resolveShareStatsSetting(j);
  } catch { soundEnabled = true; soundVolume = 0.8; soundPath = null; }

  const storedCommunity = readJsonWithBackup(COMMUNITY_FILE);
  const identity = validCommunityIdentity(storedCommunity) ? storedCommunity : (validCommunityIdentity(j) ? j : null);
  if (identity) {
    clientId = identity.clientId;
    communityToken = identity.communityToken;
    const copies = [storedCommunity, j].filter((value) => validCommunityIdentity(value)
      && value.clientId === clientId && value.communityToken === communityToken);
    for (const copy of copies) {
      if (Number.isSafeInteger(copy.communityRevision) && copy.communityRevision >= 0) communityRevision = Math.max(communityRevision, copy.communityRevision);
      if (Number.isFinite(copy.communityLastSuccessAt) && copy.communityLastSuccessAt > 0) communityLastSuccessAt = Math.max(communityLastSuccessAt, copy.communityLastSuccessAt);
    }
  }
  let created = false;
  if (!clientId) { clientId = crypto.randomUUID(); created = true; }
  if (!communityToken) { communityToken = crypto.randomBytes(32).toString('base64url'); created = true; }
  if (created || !validCommunityIdentity(storedCommunity)) saveCommunityState();
  if (created) saveSettings();   // id/token são gerados uma vez e reutilizados nesta instalação
}
function saveSettings() { return writeJsonAtomic(SETTINGS_FILE, { soundEnabled, soundVolume, soundPath, itemVis, itemAlert, clientId, shareStats, communityPreferenceVersion: COMMUNITY_PREFERENCE_VERSION, communityToken, communityRevision, communityLastSuccessAt }); }
function pushItemConfig() { if (dashView) send(dashView, 'item-config', { vis: itemVis, alert: itemAlert }); }

// ---- sincronização com o banco comunitário ----
function communityStatus() {
  return {
    available: true,
    enabled: shareStats,
    clientId,
    lastSuccessAt: communityLastSuccessAt || null,
    nextSyncAt: shareStats && communityNextSyncAt ? communityNextSyncAt : null,
    lastError: communityLastError,
  };
}
function friendlyCommunityError(error) {
  const status = Number(error && error.status);
  if (error && error.code === 'local_persistence') return 'Não foi possível salvar o histórico local; o envio foi cancelado para não perder números.';
  if (error && error.code === 'invalid_local_snapshot') {
    const species = error.species ? ' de ' + error.species : '';
    return 'Os dados locais' + species + ' estão inconsistentes; nada foi alterado no servidor.';
  }
  if (status === 401 || status === 403) return 'O servidor recusou a conexão. Tentaremos novamente após uma atualização.';
  if (status === 429) return 'Envio recente demais; os dados serão enviados na próxima janela.';
  return 'Sem conexão com a comunidade no momento; tentaremos novamente automaticamente.';
}
async function submitCommunityStats() {
  if (!shareStats || !persistentStateLoaded) return { skipped: true };
  if (communitySubmitInFlight) return communitySubmitInFlight;

  saveHuntLog();
  if (huntLogDirty) {
    const error = new Error('local hunt history was not persisted');
    error.code = 'local_persistence';
    communityLastError = friendlyCommunityError(error);
    throw error;
  }

  const revision = communityRevision + 1;
  communitySubmitInFlight = communityClient.submitStats({
    appVersion: app.getVersion(),
    clientId,
    clientToken: communityToken,
    revision,
    huntLog,
  }).then((result) => {
    const savedRevision = Number(result && result.revision);
    communityRevision = Number.isSafeInteger(savedRevision) && savedRevision >= revision ? savedRevision : revision;
    communityLastSuccessAt = Date.now();
    communityLastError = null;
    communityClient.clearCache();
    saveCommunityState();
    saveSettings();
    return result;
  }).catch((error) => {
    const serverRevision = Number(error && error.data && error.data.revision);
    const revisionConflict = Number(error && error.status) === 409
      && (error.code === 'stale_revision' || error.code === 'revision_conflict')
      && Number.isSafeInteger(serverRevision) && serverRevision >= 0;
    if (revisionConflict) {
      communityRevision = Math.max(communityRevision, serverRevision);
      communityLastError = 'A ordem dos envios foi reconciliada; tentaremos novamente automaticamente.';
      saveCommunityState();
      saveSettings();
    } else if (!(error && error.code === 'aborted' && !shareStats)) {
      communityLastError = friendlyCommunityError(error);
    }
    throw error;
  }).finally(() => { communitySubmitInFlight = null; });

  return communitySubmitInFlight;
}
function scheduleCommunitySync(delayMs) {
  if (communityTimer) clearTimeout(communityTimer);
  const requestedDelay = Math.max(0, Number(delayMs) || 0);
  const rateLimitDelay = shareStats && communityLastSuccessAt
    ? Math.max(0, communityLastSuccessAt + COMMUNITY_SEND_INTERVAL_MS - Date.now())
    : 0;
  const effectiveDelay = Math.max(requestedDelay, rateLimitDelay);
  communityNextSyncAt = Date.now() + effectiveDelay;
  communityTimer = setTimeout(() => {
    communityTimer = null;
    communityNextSyncAt = 0;
    runCommunitySync();
  }, effectiveDelay);
}
function runCommunitySync() {
  if (communitySyncInFlight) return communitySyncInFlight;
  communitySyncInFlight = submitCommunityStats().catch(() => null).finally(() => {
    communitySyncInFlight = null;
    scheduleCommunitySync(COMMUNITY_SEND_INTERVAL_MS);
  });
  return communitySyncInFlight;
}
function startCommunitySync() {
  if (communityTimer || communitySyncInFlight) return;
  scheduleCommunitySync(shareStats ? 5000 : COMMUNITY_SEND_INTERVAL_MS);
}
function waitAtMost(promise, timeoutMs) {
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
function flushCommunityBeforeQuit() {
  saveHuntLog();
  return shareStats ? waitAtMost(submitCommunityStats(), COMMUNITY_QUIT_TIMEOUT_MS) : Promise.resolve();
}
async function quitAndInstallSafely() {
  try { await flushCommunityBeforeQuit(); } catch {}
  communityQuitFlushed = true;
  try { autoUpdater.quitAndInstall(); } catch (e) { console.error('[updater] quitAndInstall', e && e.message); }
}

// ---- som (shiny capturado) ----
const DEFAULT_SOUND = path.join(__dirname, 'sounds', 'shiny-default.mp3');
function currentSoundFile() { return (soundPath && fs.existsSync(soundPath)) ? soundPath : DEFAULT_SOUND; }
function soundName() { return soundPath ? path.basename(soundPath) : 'Padrão'; }
function soundDataUrl() {   // devolve o áudio como data URL (a dashView toca isso)
  try {
    const f = currentSoundFile(); const buf = fs.readFileSync(f);
    const ext = path.extname(f).toLowerCase();
    const mime = ext === '.wav' ? 'audio/wav' : ext === '.ogg' ? 'audio/ogg' : ext === '.m4a' ? 'audio/mp4' : 'audio/mpeg';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch { return null; }
}
function pushSoundConfig() { if (dashView) send(dashView, 'sound-config', { enabled: soundEnabled, volume: soundVolume, dataUrl: soundDataUrl() }); }

function createWindow() {
  storageDir = path.join(app.getPath('userData'), 'storage');
  fs.mkdirSync(storageDir, { recursive: true });
  if (!persistentStateLoaded) {
    DUMP_FILE = path.join(app.getPath('userData'), 'ws-dump.jsonl');
    SESSION_FILE = path.join(app.getPath('userData'), 'session.json');
    SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
    COMMUNITY_FILE = path.join(app.getPath('userData'), 'community.json');
    HUNTLOG_FILE = path.join(app.getPath('userData'), 'huntlog.json');
    loadSettings();
    loadHuntLog();
    persistentStateLoaded = true;
    huntLogSaveTimer = setInterval(saveHuntLog, 30000);   // um só timer, mesmo se a janela for recriada
    startCommunitySync();
  }

  win = new BaseWindow({
    width: 1400, height: 860,
    minWidth: 800, minHeight: 500,
    frame: false,
    backgroundColor: '#0a0d13',
    icon: undefined,
  });

  dashView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.contentView.addChildView(dashView);
  dashView.webContents.loadFile(path.join(__dirname, 'app.html'));

  // overlay do menu de config: view PRÓPRIA, fica por cima das telas do jogo (o jogo continua visível atrás)
  cfgView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  try { cfgView.setBackgroundColor('#111621'); } catch {}
  win.contentView.addChildView(cfgView);
  cfgView.setVisible(false);
  cfgView.webContents.loadFile(path.join(__dirname, 'config.html'));

  win.on('resize', () => layout());
  win.on('closed', () => {
    // salva o storage de todas as telas antes de fechar
    for (const g of games) {
      if (g._saveInterval) clearInterval(g._saveInterval);
      saveStorage(g).catch(() => {});
    }
    win = null;
  });

  layout();

  // reabre a mesma quantidade de telas que estava aberta da última vez
  setTimeout(() => { const n = loadSessionCount(); for (let k = 0; k < n; k++) setTimeout(() => addGame(), k * 400); }, 500);
}

// ---- IPC handlers ----
ipcMain.handle('addView', async () => addGame());
ipcMain.handle('removeView', async (_e, slot) => removeGame(slot));
ipcMain.handle('reloadGame', async (_e, slot) => {
  const g = games.find(x => x.slot === slot);
  if (g) g.view.webContents.reload();
});
ipcMain.handle('selectAccount', async (_e, slot) => {
  if (gameMode === 'single' && selectedSlot === slot) {
    gameMode = 'grid';
    selectedSlot = null;
  } else {
    gameMode = 'single';
    selectedSlot = slot;
  }
  layout();
  send(dashView, 'accounts', buildAccountsPayload());
});
ipcMain.handle('setGameMode', async (_e, mode) => {
  gameMode = mode;
  if (mode === 'grid') selectedSlot = null;
  layout();
  send(dashView, 'accounts', buildAccountsPayload());
});
// reordena as telas conforme a ordem dos cards arrastados na barra
ipcMain.handle('reorderViews', (_e, orderedSlots) => {
  if (!Array.isArray(orderedSlots)) return activeSlots();
  const bySlot = new Map(games.map(g => [g.slot, g]));
  const next = [];
  for (const s of orderedSlots) { const g = bySlot.get(+s); if (g && !next.includes(g)) next.push(g); }
  for (const g of games) if (!next.includes(g)) next.push(g);   // garante que nada se perca
  if (next.length === games.length) { games.length = 0; games.push(...next); }
  layout();
  send(dashView, 'accounts', buildAccountsPayload());
  return activeSlots();
});
ipcMain.handle('winMinimize', async () => { if (win) win.minimize(); });
ipcMain.handle('winMaximize', async () => { if (win) win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.handle('winClose', async () => { app.quit(); });
ipcMain.handle('toggleConfig', () => setConfigOpen(!cfgOpen));
ipcMain.handle('closeConfig', () => setConfigOpen(false));
ipcMain.handle('setSidebar', (_e, hidden) => { sidebarHidden = !!hidden; layout(); return sidebarHidden; });
ipcMain.handle('setBoxOpen', (_e, open) => { boxOpen = !!open; layout(); return boxOpen; });
// Box unificada: coleção (bag+depot) de todas as contas, com nome e slot
ipcMain.handle('getBox', () => games.map(g => ({ slot: g.slot, name: g.charName || ('Tela ' + g.slot), pokes: g._box ? Object.values(g._box) : [] })));
// ---- diagnóstico (dump de rede) ----
ipcMain.handle('getDiag', () => diagOn);
ipcMain.handle('setDiag', (_e, on) => {
  diagOn = !!on;
  if (diagOn) {
    try { fs.writeFileSync(DUMP_FILE, ''); } catch {}   // começa limpo
    diagLines = 0;
    games.forEach(g => { try { g.view.webContents.reload(); } catch {} });   // recarrega pra capturar o estado inicial
  }
  return diagOn;
});
ipcMain.handle('openDumpFolder', () => {
  try { if (DUMP_FILE && fs.existsSync(DUMP_FILE)) shell.showItemInFolder(DUMP_FILE); else shell.openPath(app.getPath('userData')); } catch {}
});

ipcMain.handle('isDev', () => !app.isPackaged);

// ---- som ----
ipcMain.handle('getSoundSettings', () => ({ enabled: soundEnabled, volume: soundVolume, name: soundName(), custom: !!soundPath }));
ipcMain.handle('setSoundEnabled', (_e, on) => { soundEnabled = !!on; saveSettings(); pushSoundConfig(); return soundEnabled; });
ipcMain.handle('setSoundVolume', (_e, v) => { const n = Number(v); if (Number.isFinite(n)) soundVolume = Math.max(0, Math.min(1, n)); saveSettings(); pushSoundConfig(); return soundVolume; });
ipcMain.handle('pickSoundFile', async () => {
  try {
    const r = await dialog.showOpenDialog(win, { title: 'Escolher som', properties: ['openFile'], filters: [{ name: 'Áudio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }] });
    if (!r.canceled && r.filePaths && r.filePaths[0]) { soundPath = r.filePaths[0]; saveSettings(); pushSoundConfig(); }
  } catch {}
  return { name: soundName(), custom: !!soundPath };
});
ipcMain.handle('resetSound', () => { soundPath = null; saveSettings(); pushSoundConfig(); return { name: soundName(), custom: false }; });

// stats da CAÇADA atual: o jogo não manda contador por hunt, então medimos o delta
// desde que a hunt começou (ou desde que o launcher passou a observar, o que vier depois).
function huntStats(g) {
  const s = g._stats || {}, b = g._huntBase;
  if (!b) return null;
  const speciesList = Array.isArray(s.huntSpeciesList) && s.huntSpeciesList.length
    ? s.huntSpeciesList
    : (s.huntSpecies ? [s.huntSpecies] : []);
  const mixed = speciesList.length > 1;
  const sp = speciesList.length === 1 ? speciesList[0] : null;
  const d = (k) => (s[k] != null && b[k] != null) ? Math.max(s[k] - b[k], 0) : 0;
  const kills = d('kills'), caught = d('totalCaught'), shinies = d('shinyKills');
  return {
    id: g.hunt || null,
    species: sp,
    mixed,
    speciesCount: speciesList.length,
    kills, caught, shinies,
    ms: Date.now() - b.ts,
    catchRate: kills ? Math.round(caught / kills * 1000) / 10 : null,
    shinyRatio: shinies ? Math.round(kills / shinies) : null,
  };
}

// ---- estatísticas por conta: somente diferenças observadas nesta sessão ----
ipcMain.handle('getStats', () => {
  const seenCharacters = new Set();
  return games.filter((g) => {
    const key = g._charId ? `id:${g._charId}` : `slot:${g.slot}`;
    if (seenCharacters.has(key)) return false;
    seenCharacters.add(key);
    return true;
  }).map((g) => {
    const s = g._stats || {}, b = g._statBase;
    const elapsed = b ? Math.max((Date.now() - b.ts) / 3600000, 0) : 0;   // horas desde o baseline
    const rate = (k) => (b && elapsed > 0.0015 && s[k] != null && b[k] != null) ? Math.round((s[k] - b[k]) / elapsed) : null;  // só depois de ~5s
    const delta = (k) => (b && s[k] != null && b[k] != null) ? s[k] - b[k] : 0;
    const caught = Math.max(delta('totalCaught'), 0), kills = Math.max(delta('kills'), 0), shinies = Math.max(delta('shinyKills'), 0);
    return {
      slot: g.slot,
      name: g.charName || ('Tela ' + g.slot),
      caught, kills, shinies,
      money: delta('money'),
      trainerLevel: s.trainerLevel != null ? s.trainerLevel : null,
      activeLevel: s.level != null ? s.level : null,
      catchRate: kills ? Math.round(caught / kills * 1000) / 10 : null,
      hunt: huntStats(g),
      sessionMs: b ? (Date.now() - b.ts) : 0,
      perHour: { caught: rate('totalCaught'), kills: rate('kills'), shinies: rate('shinyKills'), money: rate('money') },
    };
  });
});

// histórico acumulado de uma espécie (ou de todas, se species vier vazio)
ipcMain.handle('getHuntLog', async (_e, species) => {
  saveHuntLog();
  if (!species) return huntLog;
  const d = Object.assign({}, huntLog[species] || {});
  let huntingNow = 0;
  let mixedNow = 0;
  const seenCharacters = new Set();
  for (const g of games) {
    const characterKey = g._charId ? 'id:' + g._charId : 'slot:' + g.slot;
    if (seenCharacters.has(characterKey)) continue;
    seenCharacters.add(characterKey);
    const s = g._stats || {};
    const activeSpecies = Array.isArray(s.huntSpeciesList) ? s.huntSpeciesList : (s.huntSpecies ? [s.huntSpecies] : []);
    if (activeSpecies.includes(species)) {
      if (activeSpecies.length === 1) huntingNow++;
      else mixedNow++;
    }
  }
  d.huntingNow = huntingNow;
  d.mixedNow = mixedNow;
  let communityWaitTimer = null;
  try {
    d.community = await Promise.race([
      communityClient.getSpeciesStats(species),
      new Promise((_resolve, reject) => {
        communityWaitTimer = setTimeout(() => reject(new Error('community_hub_timeout')), COMMUNITY_HUB_WAIT_MS);
      }),
    ]);
  } catch { d.community = null; d.communityError = true; }
  finally { if (communityWaitTimer) clearTimeout(communityWaitTimer); }
  return (huntLog[species] || huntingNow || mixedNow || d.community || d.communityError) ? d : null;
});

// ---- compartilhar estatísticas com o banco comunitário ----
ipcMain.handle('getShareStats', () => communityStatus());
ipcMain.handle('setShareStats', (_e, on) => {
  const previous = shareStats;
  shareStats = !!on;
  communityLastError = null;
  if (!saveSettings()) {
    shareStats = previous;
    throw new Error('Não foi possível salvar a preferência de compartilhamento.');
  }
  if (!shareStats) {
    communityClient.abortSubmissions();
    scheduleCommunitySync(COMMUNITY_SEND_INTERVAL_MS);
  } else {
    scheduleCommunitySync(0);
  }
  return communityStatus();
});
ipcMain.handle('forceCommunitySync', async () => {
  if (app.isPackaged) throw new Error('Envio manual disponível somente no modo de desenvolvimento.');
  if (!shareStats) throw new Error('Ative o compartilhamento antes de enviar.');
  if (communityTimer) clearTimeout(communityTimer);
  communityTimer = null;
  communityNextSyncAt = 0;
  try {
    const result = await submitCommunityStats();
    scheduleCommunitySync(COMMUNITY_SEND_INTERVAL_MS);
    return { status: communityStatus(), saved: Number(result && result.saved) || 0 };
  } catch (error) {
    scheduleCommunitySync(COMMUNITY_SEND_INTERVAL_MS);
    throw new Error(friendlyCommunityError(error));
  }
});

// ---- visibilidade dos itens na barra + alerta de item baixo ----
ipcMain.handle('getItemVis', () => itemVis);
ipcMain.handle('setItemVis', (_e, key, on) => { if (key in itemVis) { itemVis[key] = !!on; saveSettings(); pushItemConfig(); } return itemVis; });
ipcMain.handle('getItemAlert', () => itemAlert);
ipcMain.handle('setItemAlert', (_e, key, val) => { if (key in itemAlert) { const n = Number(val); itemAlert[key] = (Number.isFinite(n) && n >= 0) ? Math.round(n) : 0; saveSettings(); pushItemConfig(); } return itemAlert; });
ipcMain.handle('testSound', () => { if (dashView) send(dashView, 'play-sound', { dataUrl: soundDataUrl(), volume: soundVolume }); });

// ---- auto-update (via GitHub Releases) ----
ipcMain.handle('getVersion', () => app.getVersion());
ipcMain.handle('checkForUpdate', () => {
  if (!app.isPackaged) { sendUpdate('error', { message: 'atualização só funciona no app instalado (não no npm start)' }); return; }
  try { autoUpdater.checkForUpdates(); } catch (e) { sendUpdate('error', { message: e && e.message }); }
});
ipcMain.handle('installUpdate', () => quitAndInstallSafely());
// novidades por versão: busca o changelog.json do repo (sempre atualizado); cai no empacotado se offline
ipcMain.handle('getChangelog', async () => {
  try {
    const r = await fetch('https://raw.githubusercontent.com/marcos3777/poke-dream-launcher/master/changelog.json', { cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch {}
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'changelog.json'), 'utf8')); } catch {}
  return [];
});

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Mantém o jogo rodando quando a janela minimiza/fica coberta (jogo em canvas para o rAF ao ser
// considerado "oculto"). Estas flags desligam os freios do Chromium pra janela em segundo plano.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');   // o do "minimizou e parou" no Windows

// avisa a UI do andamento da atualização (o menu de config mostra o status)
function sendUpdate(state, extra) { send(cfgView, 'update-status', Object.assign({ state }, extra || {})); }

// Ao abrir, checa se há versão nova no repo; baixa em segundo plano; a UI/config mostra o progresso
// e oferece "reiniciar e instalar". (No `npm start` de dev o autoUpdater nem tenta.)
function setupAutoUpdate() {
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
    autoUpdater.on('update-available', (i) => sendUpdate('available', { version: i && i.version }));
    autoUpdater.on('update-not-available', () => sendUpdate('none'));
    autoUpdater.on('download-progress', (p) => sendUpdate('downloading', { percent: Math.round(p && p.percent || 0) }));
    autoUpdater.on('update-downloaded', (i) => {
      const version = i && i.version;
      sendUpdate('downloaded', { version });
      // pergunta ao usuário se quer reiniciar agora pra instalar (se disser "Depois", instala ao fechar o app)
      dialog.showMessageBox({
        type: 'info',
        title: 'Atualização disponível',
        message: `Nova versão ${version ? 'v' + version : ''} baixada!`,
        detail: 'Quer reiniciar agora para instalar? Se escolher "Depois", ela será instalada quando você fechar o app.',
        buttons: ['Reiniciar e instalar', 'Depois'],
        defaultId: 0,
        cancelId: 1,
      }).then((r) => { if (r.response === 0) quitAndInstallSafely(); }).catch(() => {});
    });
    autoUpdater.on('error', (e) => sendUpdate('error', { message: e && e.message }));
    if (app.isPackaged) {
      autoUpdater.checkForUpdates();
      setInterval(() => { try { autoUpdater.checkForUpdates(); } catch {} }, 12 * 60 * 60 * 1000);   // re-checa a cada 12h
    }
  } catch (e) { console.error('[updater] falha ao iniciar:', e && e.message); }
}

app.whenReady().then(() => {
  createWindow();
  // espera a UI carregar antes de checar (pra não perder os eventos de status)
  dashView.webContents.once('did-finish-load', () => { setTimeout(setupAutoUpdate, 1500); pushSoundConfig(); pushItemConfig(); });
  app.on('activate', () => { if (BaseWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', (event) => {
  saveHuntLog();
  if (communityQuitFlushed || !shareStats || !persistentStateLoaded) return;
  event.preventDefault();
  if (communityQuitPending) return;
  communityQuitPending = true;
  flushCommunityBeforeQuit().finally(() => {
    communityQuitPending = false;
    communityQuitFlushed = true;
    app.quit();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
