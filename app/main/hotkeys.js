'use strict';

const { globalShortcut } = require('electron');

const config = require('./config');
const log = require('./logger').scoped('hotkeys');

/**
 * Горячие клавиши. Electron умеет только «нажали» — удержания не даёт,
 * поэтому панель быстрых параметров держится на таймере: пока сочетание
 * жмут, события идут потоком, замолчали — через полсекунды прячем.
 */

const HOLD_GRACE_MS = 600;

let handlers = {};
let holdTimer = null;

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
    ['quickPanel', () => holdQuickPanel(actions)],
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

function holdQuickPanel(actions) {
  actions.quickPanel(true);
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => actions.quickPanel(false), HOLD_GRACE_MS);
}

function unregister() {
  clearTimeout(holdTimer);
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

module.exports = { register, unregister, isFree, label, handlers: () => handlers };
