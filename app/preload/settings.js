'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Всё, что окну настроек можно делать с системой. Ничего лишнего. */
const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('pastetalk', {
  i18n: {
    get: () => ipcRenderer.invoke('i18n:get'),
  },
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
  models: {
    dir: () => ipcRenderer.invoke('models:dir'),
    pickDir: () => ipcRenderer.invoke('models:pickDir'),
    changeDir: (target) => ipcRenderer.invoke('models:changeDir', target),
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
    improve: (payload) => ipcRenderer.invoke('files:improve', payload),
    onImproveProgress: on('files:improveProgress'),
    status: (id) => ipcRenderer.invoke('files:status', id),
    cancel: (id) => ipcRenderer.invoke('files:cancel', id),
    save: (payload) => ipcRenderer.invoke('files:save', payload),
  },
  app: {
    state: () => ipcRenderer.invoke('app:state'),
    displays: () => ipcRenderer.invoke('app:displays'),
    onDisplays: on('displays:changed'),
    setPaused: (value) => ipcRenderer.invoke('app:setPaused', value),
    logs: () => ipcRenderer.invoke('app:logs'),
    errors: (limit) => ipcRenderer.invoke('app:errors', limit),
    clipboardHistory: () => ipcRenderer.invoke('app:clipboardHistory'),
    checkUpdates: () => ipcRenderer.invoke('updates:check'),
    quietCheckUpdates: () => ipcRenderer.invoke('updates:quiet'),
    installUpdate: () => ipcRenderer.invoke('updates:install'),
    sendReport: (choices) => ipcRenderer.invoke('report:send', choices),
    onUpdateProgress: on('update:progress'),
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
  recognition: {
    providers: () => ipcRenderer.invoke('recognition:providers'),
    pair: (code) => ipcRenderer.invoke('recognition:pair', code),
    check: () => ipcRenderer.invoke('recognition:check'),
  },
  relay: {
    state: () => ipcRenderer.invoke('relay:state'),
    refresh: () => ipcRenderer.invoke('relay:refresh'),
    pair: (code) => ipcRenderer.invoke('relay:pair', code),
    onState: on('relay:state'),
  },
  history: {
    all: () => ipcRenderer.invoke('history:all'),
    copy: (id, improved) => ipcRenderer.invoke('history:copy', { id, improved }),
    improve: (id) => ipcRenderer.invoke('history:improve', id),
    recognize: (id) => ipcRenderer.invoke('history:recognize', id),
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
