'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Всё, что окну настроек можно делать с системой. Ничего лишнего. */
const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('pastetalk', {
  config: {
    all: () => ipcRenderer.invoke('config:all'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
    onChanged: on('config:changed'),
  },
  engine: {
    health: () => ipcRenderer.invoke('engine:health'),
    model: () => ipcRenderer.invoke('engine:model'),
    loadModel: (model) => ipcRenderer.invoke('engine:loadModel', model),
    deleteModel: (name) => ipcRenderer.invoke('engine:deleteModel', name),
    benchmark: () => ipcRenderer.invoke('engine:benchmark'),
    restart: () => ipcRenderer.invoke('engine:restart'),
    onState: on('engine:state'),
  },
  llm: {
    check: (overrides) => ipcRenderer.invoke('llm:check', overrides),
    models: (overrides) => ipcRenderer.invoke('llm:models', overrides),
    providers: () => ipcRenderer.invoke('llm:providers'),
  },
  hotkeys: {
    isFree: (accelerator) => ipcRenderer.invoke('hotkeys:isFree', accelerator),
    onConflict: on('hotkeys:conflict'),
  },
  files: {
    pick: () => ipcRenderer.invoke('files:pick'),
    start: (options) => ipcRenderer.invoke('files:start', options),
    status: (id) => ipcRenderer.invoke('files:status', id),
    cancel: (id) => ipcRenderer.invoke('files:cancel', id),
    save: (payload) => ipcRenderer.invoke('files:save', payload),
  },
  app: {
    state: () => ipcRenderer.invoke('app:state'),
    setPaused: (value) => ipcRenderer.invoke('app:setPaused', value),
    logs: () => ipcRenderer.invoke('app:logs'),
    openPath: (target) => ipcRenderer.invoke('app:openPath', target),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    onPaused: on('app:paused'),
    onGoto: on('settings:goto'),
    onHistory: on('history:add'),
    onTheme: on('theme:changed'),
  },
  clipboard: {
    write: (text) => ipcRenderer.invoke('clipboard:write', text),
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    hide: () => ipcRenderer.invoke('window:hide'),
  },
  media: {
    devices: () => navigator.mediaDevices.enumerateDevices(),
  },
});
