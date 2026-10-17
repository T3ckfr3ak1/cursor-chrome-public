'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cursorChrome', {
  getState: () => ipcRenderer.invoke('ui:get-state'),
  createTab: (opts) => ipcRenderer.invoke('ui:create-tab', opts),
  focusTab: (id) => ipcRenderer.invoke('ui:focus-tab', id),
  closeTab: (id) => ipcRenderer.invoke('ui:close-tab', id),
  navigate: (id, url) => ipcRenderer.invoke('ui:navigate', { id, url }),
  minimize: () => ipcRenderer.invoke('ui:minimize'),
  hide: () => ipcRenderer.invoke('ui:hide'),
  show: () => ipcRenderer.invoke('ui:show'),
  handoffDone: (note) => ipcRenderer.invoke('ui:handoff-done', note),
  guideClose: () => ipcRenderer.invoke('ui:guide-close'),
  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('ui:state', handler);
    return () => ipcRenderer.removeListener('ui:state', handler);
  },
});
