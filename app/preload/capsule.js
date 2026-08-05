'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  ipcRenderer.on(channel, (_event, payload) => handler(payload));
};

contextBridge.exposeInMainWorld('capsule', {
  onState: on('capsule:state'),
  onCountdown: on('capsule:countdown'),
  onLevel: on('capsule:level'),
  onPartial: on('capsule:partial'),
  onConfig: on('config:changed'),
  onTheme: on('theme:changed'),
  action: (name) => ipcRenderer.send('capsule:action', name),
  config: () => ipcRenderer.invoke('config:all'),
});
