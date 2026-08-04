'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('poke', {
  addView: () => ipcRenderer.invoke('addView'),
  removeView: (slot) => ipcRenderer.invoke('removeView', slot),
  reloadGame: (slot) => ipcRenderer.invoke('reloadGame', slot),
  selectAccount: (slot) => ipcRenderer.invoke('selectAccount', slot),
  reorderViews: (order) => ipcRenderer.invoke('reorderViews', order),
  setGameMode: (mode) => ipcRenderer.invoke('setGameMode', mode),
  winMinimize: () => ipcRenderer.invoke('winMinimize'),
  winMaximize: () => ipcRenderer.invoke('winMaximize'),
  winClose: () => ipcRenderer.invoke('winClose'),
  toggleConfig: () => ipcRenderer.invoke('toggleConfig'),
  closeConfig: () => ipcRenderer.invoke('closeConfig'),
  setSidebar: (hidden) => ipcRenderer.invoke('setSidebar', hidden),
  setBoxOpen: (open) => ipcRenderer.invoke('setBoxOpen', open),
  getBox: () => ipcRenderer.invoke('getBox'),
  getDiag: () => ipcRenderer.invoke('getDiag'),
  setDiag: (on) => ipcRenderer.invoke('setDiag', on),
  isDev: () => ipcRenderer.invoke('isDev'),
  getSoundSettings: () => ipcRenderer.invoke('getSoundSettings'),
  setSoundEnabled: (on) => ipcRenderer.invoke('setSoundEnabled', on),
  setSoundVolume: (v) => ipcRenderer.invoke('setSoundVolume', v),
  pickSoundFile: () => ipcRenderer.invoke('pickSoundFile'),
  resetSound: () => ipcRenderer.invoke('resetSound'),
  testSound: () => ipcRenderer.invoke('testSound'),
  onShinyCaught: (cb) => { const h = (_e, p) => { try { cb(p); } catch {} }; ipcRenderer.on('shiny-caught', h); return () => ipcRenderer.removeListener('shiny-caught', h); },
  onSoundConfig: (cb) => { const h = (_e, p) => { try { cb(p); } catch {} }; ipcRenderer.on('sound-config', h); return () => ipcRenderer.removeListener('sound-config', h); },
  onPlaySound: (cb) => { const h = (_e, p) => { try { cb(p); } catch {} }; ipcRenderer.on('play-sound', h); return () => ipcRenderer.removeListener('play-sound', h); },
  openDumpFolder: () => ipcRenderer.invoke('openDumpFolder'),
  getVersion: () => ipcRenderer.invoke('getVersion'),
  checkForUpdate: () => ipcRenderer.invoke('checkForUpdate'),
  installUpdate: () => ipcRenderer.invoke('installUpdate'),
  getChangelog: () => ipcRenderer.invoke('getChangelog'),
  onAccounts: (cb) => {
    const h = (_e, payload) => { try { cb(payload); } catch {} };
    ipcRenderer.on('accounts', h);
    return () => ipcRenderer.removeListener('accounts', h);
  },
  onUpdateStatus: (cb) => {
    const h = (_e, payload) => { try { cb(payload); } catch {} };
    ipcRenderer.on('update-status', h);
    return () => ipcRenderer.removeListener('update-status', h);
  },
});
