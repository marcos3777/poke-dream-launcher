'use strict';

const { app, BaseWindow, WebContentsView, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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

  const x0 = SIDE_W, y0 = BAR, w = Math.max(b.width - x0, 100), h = Math.max(b.height - y0, 100);
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
  return { slots: activeSlots(), selected: selectedSlot, mode: gameMode };
}

function send(target, ch, payload) {
  try { if (target && !target.webContents.isDestroyed()) target.webContents.send(ch, payload); } catch {}
}

function createWindow() {
  storageDir = path.join(app.getPath('userData'), 'storage');
  fs.mkdirSync(storageDir, { recursive: true });

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

// ---- auto-update (via GitHub Releases) ----
ipcMain.handle('getVersion', () => app.getVersion());
ipcMain.handle('checkForUpdate', () => {
  if (!app.isPackaged) { sendUpdate('error', { message: 'atualização só funciona no app instalado (não no npm start)' }); return; }
  try { autoUpdater.checkForUpdates(); } catch (e) { sendUpdate('error', { message: e && e.message }); }
});
ipcMain.handle('installUpdate', () => { try { autoUpdater.quitAndInstall(); } catch (e) { console.error('[updater] quitAndInstall', e && e.message); } });

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// avisa a UI do andamento da atualização (para o painel de config mostrar o status)
function sendUpdate(state, extra) { send(dashView, 'update-status', Object.assign({ state }, extra || {})); }

// Ao abrir, checa se há versão nova no repo; baixa em segundo plano; a UI/config mostra o progresso
// e oferece "reiniciar e instalar". (No `npm start` de dev o autoUpdater nem tenta.)
function setupAutoUpdate() {
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
    autoUpdater.on('update-available', (i) => sendUpdate('available', { version: i && i.version }));
    autoUpdater.on('update-not-available', () => sendUpdate('none'));
    autoUpdater.on('download-progress', (p) => sendUpdate('downloading', { percent: Math.round(p && p.percent || 0) }));
    autoUpdater.on('update-downloaded', (i) => sendUpdate('downloaded', { version: i && i.version }));
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
