'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const subscribe = channel => callback => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('relinkPlugin', Object.freeze({
  // API v3. Older hosts do not define these; check before calling.
  getHostInfo: () => ipcRenderer.invoke('relink:plugin:host-info'),
  // API v4: declared-host network, secret status, channel chat, slash commands, notifications and storage.
  fetch: (url, init) => ipcRenderer.invoke('relink:plugin:fetch', url, { ...(init || {}), stream: false }),
  /** Streams the response text to `onChunk`; resolves with `{ status, headers }` when it ends. `init.id` lets `abortFetch(id)` stop it. */
  fetchStream: (url, init, onChunk) => {
    const id = typeof init?.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(init.id) ? init.id : crypto.randomUUID();
    const listener = (_event, value) => { if (value?.id === id && typeof onChunk === 'function') onChunk(value.text); };
    ipcRenderer.on('relink:plugin:fetch-chunk', listener);
    return ipcRenderer.invoke('relink:plugin:fetch', url, { ...(init || {}), stream: true }, id)
      .finally(() => ipcRenderer.removeListener('relink:plugin:fetch-chunk', listener));
  },
  abortFetch: id => ipcRenderer.invoke('relink:plugin:fetch-abort', id),
  getSecretStatus: () => ipcRenderer.invoke('relink:plugin:secrets'),
  getChat: () => ipcRenderer.invoke('relink:plugin:chat'),
  onChat: subscribe('relink:plugin:chat'),
  sendChat: value => ipcRenderer.invoke('relink:plugin:chat-send', value),
  editChat: value => ipcRenderer.invoke('relink:plugin:chat-edit', value),
  deleteChat: id => ipcRenderer.invoke('relink:plugin:chat-delete', id),
  onChatEvent: subscribe('relink:plugin:chat-event'),
  getChatChannels: () => ipcRenderer.invoke('relink:plugin:chat-channels'),
  getChatHistory: query => ipcRenderer.invoke('relink:plugin:chat-history', query),
  onVoiceEvent: subscribe('relink:plugin:voice-event'),
  onChatCommand: subscribe('relink:plugin:chat-command'),
  notify: value => ipcRenderer.invoke('relink:plugin:notify', value),
  storage: Object.freeze({
    get: key => ipcRenderer.invoke('relink:plugin:storage', 'get', key),
    set: (key, value) => ipcRenderer.invoke('relink:plugin:storage', 'set', key, value),
    remove: key => ipcRenderer.invoke('relink:plugin:storage', 'remove', key),
    keys: () => ipcRenderer.invoke('relink:plugin:storage', 'keys'),
  }),
  getParticipants: () => ipcRenderer.invoke('relink:plugin:participants'),
  onParticipants: subscribe('relink:plugin:participants'),
  onCommand: subscribe('relink:plugin:command'),
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
