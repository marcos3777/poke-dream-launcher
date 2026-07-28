'use strict';

const { app, BaseWindow, WebContentsView, ipcMain, safeStorage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { autoUpdater } = require('electron-updater');

const GAME_URL = 'https://pokedream.com.br/';
const GAME_DOMAIN = 'pokedream.com.br';
const MAXV = 4;
const BAR = 46;
const SIDE_W = 220;
const GAP = 3;

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
let diagOn = false;      // modo diagnóstico: grava frames WS + respostas REST num dump (pra ver o que o jogo manda)
let DUMP_FILE = null;
let diagLines = 0;

// ---- diagnóstico: captura de rede (só grava quando diagOn) ----
function diagWrite(obj) {
  if (!DUMP_FILE || diagLines > 40000) return;   // teto pra não virar GB
  try { fs.appendFileSync(DUMP_FILE, JSON.stringify(obj) + '\n'); diagLines++; } catch {}
}
function dumpWs(slot, dir, payload, isBinary) {
  if (isBinary) {   // frame binário (opcode 2) — payload vem base64; guarda cru pra decodificar na análise
    let raw = payload; if (raw && raw.length > 200000) raw = raw.slice(0, 200000);
    diagWrite({ slot, ts: Date.now(), kind: 'ws', dir, type: 'binary', b64: true, raw });
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
  diagWrite({ slot, ts: Date.now(), kind: 'ws', dir, type, raw: payload });
}
const REDACT = /([?&](?:token|access_token|jwt|auth|refresh(?:Token)?|password)=)[^&]*/gi;
function dumpHttp(slot, url, body, b64) {
  let raw = body; if (b64) { try { raw = Buffer.from(body, 'base64').toString('utf8'); } catch {} }
  if (raw && raw.length > 1000000) raw = raw.slice(0, 1000000) + '…[truncado]';
  diagWrite({ slot, ts: Date.now(), kind: 'http', url: String(url).replace(REDACT, '$1<redacted>'), raw });
}
function dumpHttpReq(slot, url, body) {   // corpo do REQUEST (ex.: POST /save carrega o estado)
  let raw = body; if (raw && raw.length > 1000000) raw = raw.slice(0, 1000000) + '…[truncado]';
  diagWrite({ slot, ts: Date.now(), kind: 'http-req', url: String(url).replace(REDACT, '$1<redacted>'), raw });
}

// ---- extrai nome / hunt / pokémon ATIVO do estado pra alimentar a sidebar ----
// progress.activeUid = uid do pokémon ativo na hunt (muda quando você troca). Casa com o box pelo uid.
// shiny = a entrada do box tem `shiny:true`.
function setActive(g, uid) {   // resolve o uid ativo no box mantido -> atualiza g.active (devolve true se mudou)
  const p = g._box && g._box[uid];
  const key = uid + (p ? '|' + p.species + '|' + p.level + '|' + (p.shiny ? 1 : 0) : '|?');
  if (key === g._activeKey) return false;
  g._activeKey = key;
  if (p) g.active = { species: p.species, level: p.level, shiny: p.shiny };
  return !!p;
}
function applyState(g, state) {   // estado COMPLETO (/offline ou /save cheio): guarda o box e o ativo
  if (!state) return false;
  const prog = state.progress || state;
  let changed = false;
  if (state.huntId != null && state.huntId !== g.hunt) { g.hunt = state.huntId; changed = true; }
  if (Array.isArray(prog.box)) {
    g._box = {}; for (const p of prog.box) if (p && p.uid != null) g._box[p.uid] = { species: p.species, level: p.level, shiny: !!p.shiny };
  }
  if (prog.activeUid != null && setActive(g, prog.activeUid)) changed = true;
  return changed;
}
function applyPatch(g, patch) {   // delta descomprimido: campos que MUDARAM (activeUid na troca, huntId, boxDelta)
  let changed = false;
  if (patch.huntId != null && patch.huntId !== g.hunt) { g.hunt = patch.huntId; changed = true; }
  if (patch.boxDelta && g._box) for (const uid in patch.boxDelta) { const d = patch.boxDelta[uid]; if (g._box[uid] && d && d.level != null) g._box[uid].level = d.level; }
  const prog = patch.progress || {};
  if (prog.activeUid != null && setActive(g, prog.activeUid)) changed = true;
  return changed;
}
function feedState(g, url, body) {   // usado por /offline (resposta) e /save (request)
  const m = url.match(/\/characters\/([^/]+)\//); if (m) g._charId = m[1];
  let j; try { j = JSON.parse(body); } catch { return; }
  const st = j.state || j;
  let changed;
  if (st.patchGz) {   // /save delta: patch gzipado -> descomprime e aplica só o que mudou
    let patch; try { patch = JSON.parse(zlib.gunzipSync(Buffer.from(st.patchGz, 'base64')).toString('utf8')); } catch { return; }
    changed = applyPatch(g, patch);
  } else {
    changed = applyState(g, st.progress ? st : (j.state || null));
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
        const handle = (pd) => { if (pd == null) return; if (diagOn) dumpHttpReq(g.slot, url, pd); feedState(g, url, pd); };
        if (req.postData != null) handle(req.postData);
        else if (req.hasPostData) wc.debugger.sendCommand('Network.getRequestPostData', { requestId: params.requestId }).then((r) => handle(r && r.postData)).catch(() => {});
      } else if (method === 'Network.webSocketCreated') {
        if (diagOn) diagWrite({ slot: g.slot, ts: Date.now(), kind: 'ws-open', url: String(params.url || '').split('?')[0] });
      } else if (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') {
        if (!diagOn) return;
        const r = params.response, dir = method === 'Network.webSocketFrameSent' ? 'sent' : 'recv';
        if (r && r.payloadData != null && (r.opcode === 1 || r.opcode === 2)) dumpWs(g.slot, dir, r.payloadData, r.opcode === 2);
      } else if (method === 'Network.responseReceived') {
        const t = params.type, url = params.response && params.response.url;
        if (url && (t === 'XHR' || t === 'Fetch')) reqs.set(params.requestId, url);
      } else if (method === 'Network.loadingFinished') {
        const url = reqs.get(params.requestId); if (url == null) return; reqs.delete(params.requestId);
        const info = isInfoUrl(url), dump = diagOn;
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

  if (gameMode === 'grid') {
    const rects = tileRects(games.length, x0, y0, w, h);
    games.forEach((g, i) => { if (rects[i]) target.set(g.slot, rects[i]); });
  } else if (gameMode === 'single' && selectedSlot != null) {
    if (games.some(x => x.slot === selectedSlot)) {
      target.set(selectedSlot, { x: x0, y: y0, width: w, height: h });
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
  const W = 300, H = 340;
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
  return activeSlots();
}

function buildAccountsPayload() {
  const info = {};
  for (const g of games) info[g.slot] = { name: g.charName || null, hunt: g.hunt || null, active: g.active || null };
  return { slots: activeSlots(), selected: selectedSlot, mode: gameMode, info };
}

function send(target, ch, payload) {
  try { if (target && !target.webContents.isDestroyed()) target.webContents.send(ch, payload); } catch {}
}

function createWindow() {
  storageDir = path.join(app.getPath('userData'), 'storage');
  fs.mkdirSync(storageDir, { recursive: true });
  DUMP_FILE = path.join(app.getPath('userData'), 'ws-dump.jsonl');

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

  setTimeout(() => addGame(), 500);
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
ipcMain.handle('winMinimize', async () => { if (win) win.minimize(); });
ipcMain.handle('winMaximize', async () => { if (win) win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.handle('winClose', async () => { app.quit(); });
ipcMain.handle('toggleConfig', () => setConfigOpen(!cfgOpen));
ipcMain.handle('closeConfig', () => setConfigOpen(false));
ipcMain.handle('setSidebar', (_e, hidden) => { sidebarHidden = !!hidden; layout(); return sidebarHidden; });
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

// ---- auto-update (via GitHub Releases) ----
ipcMain.handle('getVersion', () => app.getVersion());
ipcMain.handle('checkForUpdate', () => {
  if (!app.isPackaged) { sendUpdate('error', { message: 'atualização só funciona no app instalado (não no npm start)' }); return; }
  try { autoUpdater.checkForUpdates(); } catch (e) { sendUpdate('error', { message: e && e.message }); }
});
ipcMain.handle('installUpdate', () => { try { autoUpdater.quitAndInstall(); } catch (e) { console.error('[updater] quitAndInstall', e && e.message); } });

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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
      }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); }).catch(() => {});
    });
    autoUpdater.on('error', (e) => sendUpdate('error', { message: e && e.message }));
    if (app.isPackaged) autoUpdater.checkForUpdates();
  } catch (e) { console.error('[updater] falha ao iniciar:', e && e.message); }
}

app.whenReady().then(() => {
  createWindow();
  // espera a UI carregar antes de checar (pra não perder os eventos de status)
  dashView.webContents.once('did-finish-load', () => setTimeout(setupAutoUpdate, 1500));
  app.on('activate', () => { if (BaseWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
