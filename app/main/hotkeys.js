'use strict';

const { globalShortcut } = require('electron');

const config = require('./config');
const log = require('./logger').scoped('hotkeys');

/** Горячие клавиши приложения. */

let handlers = {};

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

function unregister() {
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
