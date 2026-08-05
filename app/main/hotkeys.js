'use strict';

const { globalShortcut } = require('electron');

const config = require('./config');
const log = require('./logger').scoped('hotkeys');

/**
 * Горячие клавиши.
 *
 * Важное ограничение: Windows сообщает приложению только о нажатии
 * сочетания, но не об отпускании. Узнать, держат клавишу или уже нет,
 * без перехвата всей клавиатуры невозможно — а ставить такой перехват
 * ради одной панели неправильно. Поэтому панель быстрых параметров
 * работает переключателем: нажали — открылась, нажали ещё раз — закрылась.
 */

let handlers = {};
let quickVisible = false;

function label(accelerator) {
  return String(accelerator || '')
    .replace(/Control/g, 'Ctrl')
    .replace(/Return/g, 'Enter');
}

function register(actions) {
  handlers = actions;
  unregister();

  const map = config.get('hotkeys', {});
  const bindings = [
    ['record', () => actions.record()],
    ['recordAndImprove', () => actions.recordAndImprove()],
    ['improveClipboard', () => actions.improveClipboard()],
    ['quickPanel', () => toggleQuickPanel(actions)],
  ];

  const failed = [];
  for (const [name, callback] of bindings) {
    const accelerator = map[name];
    if (!accelerator) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, callback);
    } catch (error) {
      log.warn(`${name}: ${error.message}`);
    }
    if (ok) log.info(`${name} → ${label(accelerator)}`);
    else failed.push({ name, accelerator });
  }

  if (failed.length) {
    log.warn(`заняты другой программой: ${failed.map((f) => label(f.accelerator)).join(', ')}`);
  }
  return failed;
}

function toggleQuickPanel(actions) {
  quickVisible = !quickVisible;
  actions.quickPanel(quickVisible);
}

/** Панель закрывают не только клавишей — надо знать об этом. */
function quickPanelClosed() {
  quickVisible = false;
}

function unregister() {
  quickVisible = false;
  globalShortcut.unregisterAll();
}

/** Свободно ли сочетание — нужно окну настроек при записи новой клавиши. */
function isFree(accelerator) {
  if (!accelerator) return false;
  if (globalShortcut.isRegistered(accelerator)) return false;
  try {
    const taken = globalShortcut.register(accelerator, () => {});
    if (taken) globalShortcut.unregister(accelerator);
    return taken;
  } catch {
    return false;
  }
}

module.exports = { register, unregister, isFree, label, quickPanelClosed, handlers: () => handlers };
