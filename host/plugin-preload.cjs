'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('relinkPlugin', Object.freeze({
  getState: () => ipcRenderer.invoke('relink:plugin:state'),
  action: name => ipcRenderer.invoke('relink:plugin:action', name),
  onState: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('relink:plugin:state', listener);
    return () => ipcRenderer.removeListener('relink:plugin:state', listener);
  },
}));
