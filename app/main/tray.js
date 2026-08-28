'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Tray, Menu, nativeImage, nativeTheme, shell, app } = require('electron');

const config = require('./config');
const engine = require('./engine');
const logger = require('./logger');
const hotkeys = require('./hotkeys');
const { tr } = require('./i18n');

/**
 * Значок рядом с часами — единственное постоянное место программы.
 * Отсюда: настройки, пауза, перезапуск движка, журнал и выход.
 */

let tray = null;
let paused = false;
let actions = {};

/**
 * Значок в трее — тот же микрофон и тем же фирменным цветом, что логотип,
 * только без подложки. Оранжевый одинаково читается и на светлой панели
 * задач, и на тёмной, так что подстраиваться под тему незачем.
 *
 * В собранном приложении иконки лежат в ресурсах, в разработке — в build.
 */
function iconPath() {
  const places = [
    path.join(process.resourcesPath || '', 'build', 'tray.ico'),
    path.join(__dirname, '..', '..', 'build', 'tray.ico'),
    path.join(__dirname, '..', '..', 'build', 'icon.ico'),
  ];
  return places.find((file) => file && fs.existsSync(file)) || places[1];
}

function stateLine() {
  if (paused) return tr('На паузе');
  switch (engine.state) {
    case 'ready': return `${tr('Готов')} · ${config.get('model.name', 'large-v3')}`;
    case 'starting': return tr('Движок запускается…');
    case 'sleeping': return tr('Спит — проснётся при записи');
    case 'failed': return `${tr('Сбой:')} ${tr(engine.lastError)}`;
    default: return tr('Движок остановлен');
  }
}

function build() {
  const map = config.get('hotkeys', {});
  const menu = Menu.buildFromTemplate([
    { label: `PasteTalk ${app.getVersion()}`, enabled: false },
    { label: stateLine(), enabled: false },
    { type: 'separator' },
    {
      label: `${tr('Начать запись')}\t${hotkeys.label(map.record)}`,
      enabled: !paused && engine.canWork,
      click: () => actions.record(),
    },
    {
      label: paused ? tr('Снять с паузы') : tr('Поставить на паузу'),
      click: () => actions.setPaused(!paused),
    },
    { type: 'separator' },
    { label: tr('Настройки…'), click: () => actions.settings() },
    { label: tr('Журнал работы'), click: () => shell.openPath(logger.logFile()) },
    { label: tr('Папка с настройками'), click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: tr('Перезапустить движок'), click: () => actions.restartEngine() },
    { label: tr('Выйти из PasteTalk'), click: () => actions.quit() },
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
