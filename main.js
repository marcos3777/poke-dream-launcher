'use strict';

const { app, BaseWindow, WebContentsView, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

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
      try {
        await ses.cookies.set({ url, name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: 'lax', expirationDate: far });
      } catch {}
    }
    await ses.cookies.flushStore();
  } catch {}
}

// ---- backup/restore de localStorage e sessionStorage ----
function storageFile(slot) { return path.join(storageDir, `storage-acc${slot}.json`); }

async function saveStorage(g) {
  try {
    const wc = g.view.webContents;
    const data = await wc.executeJavaScript('({ls:JSON.parse(JSON.stringify(localStorage)),ss:JSON.parse(JSON.stringify(sessionStorage))})', true);
    fs.writeFileSync(storageFile(g.slot), JSON.stringify(data), 'utf8');
  } catch {}
}

async function restoreStorage(g) {
  const f = storageFile(g.slot);
  if (!fs.existsSync(f)) return;
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
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
  const g = { view, slot, _shown: false };

  view.webContents.on('did-finish-load', async () => {
    // restaura storage salvo antes do jogo iniciar
    await restoreStorage(g);
    // espera o login acontecer, depois converte cookies de sessao em persistentes
    setTimeout(async () => { await persistCookies(g); await saveStorage(g); }, 6000);
    // salva o storage a cada 30s enquanto a conta estiver aberta
    g._saveInterval = setInterval(() => { saveStorage(g).catch(() => {}); }, 30000);
  });

  view.webContents.loadURL(GAME_URL).catch(e => console.error('[launcher] loadURL', slot, e && e.message));
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

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BaseWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
