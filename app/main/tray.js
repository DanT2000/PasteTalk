'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Tray, Menu, nativeImage, nativeTheme, shell, app } = require('electron');

const config = require('./config');
const engine = require('./engine');
const logger = require('./logger');
const hotkeys = require('./hotkeys');

/**
 * Значок рядом с часами — единственное постоянное место программы.
 * Отсюда: настройки, пауза, перезапуск движка, журнал и выход.
 */

let tray = null;
let paused = false;
let actions = {};

/**
 * Значок в трее — силуэт микрофона без подложки, как у системных.
 *
 * Windows не сообщает, светлая у панели задач тема или тёмная, поэтому
 * берём цвет из общей темы системы: на светлой панели нужен тёмный
 * значок и наоборот.
 */
function iconPath() {
  const dir = path.join(__dirname, '..', '..', 'build');
  const file = nativeTheme.shouldUseDarkColors ? 'tray-light.ico' : 'tray-dark.ico';
  const tray = path.join(dir, file);
  return fs.existsSync(tray) ? tray : path.join(dir, 'icon.ico');
}

function stateLine() {
  if (paused) return 'На паузе';
  switch (engine.state) {
    case 'ready': return `Готов · ${config.get('model.name', 'large-v3')}`;
    case 'starting': return 'Движок запускается…';
    case 'failed': return `Сбой: ${engine.lastError}`;
    default: return 'Движок остановлен';
  }
}

function build() {
  const map = config.get('hotkeys', {});
  const menu = Menu.buildFromTemplate([
    { label: `PasteTalk ${app.getVersion()}`, enabled: false },
    { label: stateLine(), enabled: false },
    { type: 'separator' },
    {
      label: `Начать запись\t${hotkeys.label(map.record)}`,
      enabled: !paused && engine.isReady,
      click: () => actions.record(),
    },
    {
      label: paused ? 'Снять с паузы' : 'Поставить на паузу',
      click: () => actions.setPaused(!paused),
    },
    { type: 'separator' },
    { label: 'Настройки…', click: () => actions.settings() },
    { label: 'Журнал работы', click: () => shell.openPath(logger.logFile()) },
    { label: 'Папка с настройками', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Перезапустить движок', click: () => actions.restartEngine() },
    { label: 'Выйти из PasteTalk', click: () => actions.quit() },
  ]);
  if (tray) {
    tray.setContextMenu(menu);
    tray.setToolTip(`PasteTalk — ${stateLine()}`);
  }
}

function applyIcon() {
  if (!tray || tray.isDestroyed()) return;
  const image = nativeImage.createFromPath(iconPath());
  if (!image.isEmpty()) tray.setImage(image);
}

function create(handlers) {
  actions = handlers;
  const image = nativeImage.createFromPath(iconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.on('click', () => actions.settings());
  tray.on('double-click', () => actions.settings());
  // Тему переключают на ходу — значок должен оставаться различимым.
  nativeTheme.on('updated', applyIcon);
  build();
  return tray;
}

function setPaused(value) {
  paused = value;
  build();
}

module.exports = { create, refresh: build, setPaused, isPaused: () => paused };
