'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('poke', {
  addView: () => ipcRenderer.invoke('addView'),
  removeView: (slot) => ipcRenderer.invoke('removeView', slot),
  reloadGame: (slot) => ipcRenderer.invoke('reloadGame', slot),
  selectAccount: (slot) => ipcRenderer.invoke('selectAccount', slot),
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
  getTelemetry: () => ipcRenderer.invoke('getTelemetry'),
  setTelemetry: (on) => ipcRenderer.invoke('setTelemetry', on),
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
