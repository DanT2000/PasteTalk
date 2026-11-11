'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorderBridge', {
  onStart: (handler) => ipcRenderer.on('audio:start', (_event, payload) => handler(payload)),
  onStop: (handler) => ipcRenderer.on('audio:stop', () => handler()),
  chunk: (pcm, peak) => ipcRenderer.send('audio:chunk', { pcm, peak }),
  level: (value) => ipcRenderer.send('audio:level', { level: value }),
  failed: (message) => ipcRenderer.send('audio:error', { message }),
  note: (message) => ipcRenderer.send('audio:note', { message }),
  // Микрофон ещё не нашёлся: панель обязана сказать об этом, пока ждём.
  waiting: (on) => ipcRenderer.send('audio:waiting', { on }),
});
