'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
    /**
     * Путь перетащенного файла. Свойство File.path убрали в Electron 32,
     * и перетаскивание молча переставало работать: обработчик получал
     * undefined и ничего не делал.
     */
    pathOf: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
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
    errors: (limit) => ipcRenderer.invoke('app:errors', limit),
    clipboardHistory: () => ipcRenderer.invoke('app:clipboardHistory'),
    checkUpdates: () => ipcRenderer.invoke('updates:check'),
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
  history: {
    all: () => ipcRenderer.invoke('history:all'),
    copy: (id, improved) => ipcRenderer.invoke('history:copy', { id, improved }),
    improve: (id) => ipcRenderer.invoke('history:improve', id),
    remove: (id) => ipcRenderer.invoke('history:remove', id),
    clear: () => ipcRenderer.invoke('history:clear'),
    onChanged: on('history:changed'),
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    hide: () => ipcRenderer.invoke('window:hide'),
  },
  media: {
    /**
     * Через мост можно передавать только простые данные. MediaDeviceInfo —
     * объект платформы: за границу он проходит пустым, и список устройств
     * в окне настроек оказывался пустым тоже. Раскладываем по полям здесь.
     */
    devices: async () => {
      const list = await navigator.mediaDevices.enumerateDevices();
      return list.map((device) => ({
        kind: device.kind,
        deviceId: device.deviceId,
        label: device.label,
        groupId: device.groupId,
      }));
    },
  },
});
