'use strict';

const path = require('node:path');
const { BrowserWindow, screen, nativeTheme } = require('electron');

const config = require('./config');
const i18n = require('./i18n');

/**
 * Окон три:
 *   settings — обычное окно настроек, крестик его прячет, а не закрывает;
 *   capsule  — панель записи: поверх всех, без рамки, не забирает фокус;
 *   audio    — скрытое окно, которое только пишет звук с микрофона.
 *
 * Звук отделён от панели намеренно: панель не должна получать фокус, а
 * захват микрофона удобнее вести в обычном окне, пусть и невидимом.
 */

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload');

const windows = { settings: null, capsule: null, audio: null };

function themeSource() {
  const theme = config.get('appearance.theme', 'system');
  return theme === 'system' ? 'system' : theme;
}

function applyTheme() {
  nativeTheme.themeSource = themeSource();
}

// ---------- настройки ----------

function createSettings() {
  if (windows.settings && !windows.settings.isDestroyed()) return windows.settings;

  // С запасом под крупный масштаб (150 %): подсветке знакомства и карточке
  // сбоку от неё должно хватать места. Но не больше рабочей области:
  // на ноутбуке 1366×768 или при системных 150 % окно в 800 точек высоты
  // уехало бы под панель задач.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1200, area.width - 32),
    height: Math.min(800, area.height - 32),
    minWidth: 720,
    minHeight: 520,
    show: false,
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1B1B1F' : '#EDEDF1',
    title: i18n.tr('PasteTalk — Настройки'),
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(PRELOAD, 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(RENDERER, 'settings', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Крестик прячет окно. Программа продолжает слушать горячую клавишу —
  // ради этого она и живёт в трее.
  win.on('close', (event) => {
    if (!global.pastetalkQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  windows.settings = win;
  return win;
}

function showSettings(page) {
  const win = createSettings();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (page) win.webContents.send('settings:goto', page);
}

// ---------- панель записи ----------

/** Размер панели считается из масштаба: та же арифметика, что в вёрстке. */
function capsuleSize() {
  const scale = Number(config.get('appearance.scale', 100)) || 100;
  const compact = config.get('appearance.capsuleSize', 'full') === 'compact';
  const rem = (scale / 100) * 16;
  return {
    width: Math.round((compact ? 13.5 : 26) * rem) + 24,
    height: Math.round(8.4 * rem),
  };
}

/** Экран для панели: закреплённый настройкой или тот, где курсор. */
function pickDisplay(cursor) {
  const wanted = String(config.get('appearance.capsuleDisplay', 'cursor'));
  if (wanted === 'cursor') return screen.getDisplayNearestPoint(cursor);
  if (wanted === 'primary') return screen.getPrimaryDisplay();
  const pinned = screen.getAllDisplays().find((d) => String(d.id) === wanted);
  // Закреплённый экран могли отключить — тогда ведём себя как раньше.
  return pinned || screen.getDisplayNearestPoint(cursor);
}

function capsuleBounds() {
  const { width, height } = capsuleSize();
  const cursor = screen.getCursorScreenPoint();
  const display = pickDisplay(cursor);
  const area = display.workArea;
  const position = config.get('appearance.capsulePosition', 'bottom');

  let x = Math.round(area.x + (area.width - width) / 2);
  let y = Math.round(area.y + area.height - height - 24);

  if (position === 'top') y = area.y + 24;
  else if (position === 'cursor') {
    x = Math.round(cursor.x - width / 2);
    y = Math.round(cursor.y + 28);
  }

  // Держим панель внутри рабочей области: без этого она однажды уезжает
  // за край экрана, и от неё виден только огрызок.
  x = Math.min(Math.max(x, area.x + 8), area.x + area.width - width - 8);
  y = Math.min(Math.max(y, area.y + 8), area.y + area.height - height - 8);

  return { x, y, width, height };
}

function createCapsule() {
  if (windows.capsule && !windows.capsule.isDestroyed()) return windows.capsule;

  const win = new BrowserWindow({
    ...capsuleBounds(),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Фокус остаётся в чужом окне — иначе Ctrl+V прилетит нам самим.
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'capsule.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.removeMenu();
  win.loadFile(path.join(RENDERER, 'capsule', 'index.html'));

  windows.capsule = win;
  return win;
}

/**
 * Показать панель ровно там, где ей положено.
 *
 * Прозрачным окнам без рамки Windows не всегда применяет setBounds, пока
 * они скрыты, — и панель после пары показов оказывается у края экрана.
 * Поэтому размер и положение ставим по отдельности и повторяем уже
 * после показа, когда окно точно существует на экране.
 */
function place(win, bounds) {
  const current = win.getBounds();
  if (current.width !== bounds.width || current.height !== bounds.height) {
    win.setSize(bounds.width, bounds.height, false);
  }
  win.setPosition(bounds.x, bounds.y, false);
}

function showCapsule() {
  const win = createCapsule();
  const bounds = capsuleBounds();
  place(win, bounds);
  win.showInactive();
  place(win, bounds);
  win.setAlwaysOnTop(true, 'screen-saver');
}

function hideCapsule() {
  if (windows.capsule && !windows.capsule.isDestroyed()) windows.capsule.hide();
}

// ---------- скрытый захват звука ----------

function createAudio() {
  if (windows.audio && !windows.audio.isDestroyed()) return windows.audio;

  const win = new BrowserWindow({
    width: 360,
    height: 240,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(PRELOAD, 'audio.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(RENDERER, 'audio', 'index.html'));
  windows.audio = win;
  return win;
}

// ---------- общее ----------

function send(name, channel, payload) {
  const win = windows[name];
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function broadcast(channel, payload) {
  for (const name of Object.keys(windows)) send(name, channel, payload);
}

/** Перечитать HTML всех окон — например, после смены языка интерфейса. */
function reloadAll() {
  for (const name of Object.keys(windows)) {
    const win = windows[name];
    if (win && !win.isDestroyed()) win.webContents.reload();
  }
}

module.exports = {
  windows,
  applyTheme,
  createSettings,
  showSettings,
  createCapsule,
  showCapsule,
  hideCapsule,
  capsuleBounds,
  createAudio,
  send,
  broadcast,
  reloadAll,
};
