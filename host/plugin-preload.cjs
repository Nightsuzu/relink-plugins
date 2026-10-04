'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('relinkPlugin', Object.freeze({
  getSettings:()=>ipcRenderer.invoke('relink:plugin:settings'),
  updateSettings:patch=>ipcRenderer.invoke('relink:plugin:settings-update',patch),
  onSettings:callback=>{if(typeof callback!=='function')return ()=>{};const listener=(_e,value)=>callback(value);ipcRenderer.on('relink:plugin:settings',listener);return ()=>ipcRenderer.removeListener('relink:plugin:settings',listener);},
  getMedia: () => ipcRenderer.invoke('relink:plugin:media'),
  controlMedia: value => ipcRenderer.invoke('relink:plugin:media-control', value),
  getChannels: () => ipcRenderer.invoke('relink:plugin:channels'),
  switchChannel: value => ipcRenderer.invoke('relink:plugin:switch-channel', value),
  getState: () => ipcRenderer.invoke('relink:plugin:state'),
  action: name => ipcRenderer.invoke('relink:plugin:action', name),
  setDisplayState: (value, transition) => ipcRenderer.invoke('relink:plugin:display-state', value, transition),
  completeDisplayTransition: transition => ipcRenderer.invoke('relink:plugin:display-settled', transition),
  onDismiss: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('relink:plugin:dismiss', listener);
    return () => ipcRenderer.removeListener('relink:plugin:dismiss', listener);
  },
  getPresentation: () => ipcRenderer.invoke('relink:plugin:presentation'),
  onPresentation: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, presentation) => callback(presentation);
    ipcRenderer.on('relink:plugin:presentation', listener);
    return () => ipcRenderer.removeListener('relink:plugin:presentation', listener);
  },
  onState: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('relink:plugin:state', listener);
    return () => ipcRenderer.removeListener('relink:plugin:state', listener);
  },
}));
