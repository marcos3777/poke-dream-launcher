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
  onAccounts: (cb) => {
    const h = (_e, payload) => { try { cb(payload); } catch {} };
    ipcRenderer.on('accounts', h);
    return () => ipcRenderer.removeListener('accounts', h);
  },
});
