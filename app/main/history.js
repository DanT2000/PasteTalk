'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const log = require('./logger').scoped('history');

/**
 * Последние распознанные тексты.
 *
 * Зачем: продиктовал, вставил, ушёл дальше — а через пять минут понял,
 * что текст надо было причесать. Буфер обмена к тому моменту уже другой,
 * и обратиться не к чему. Поэтому храним сказанное отдельно и даём
 * вернуться к любой записи: скопировать заново или прогнать через модель.
 *
 * Хранится только на этом компьютере, обычным JSON рядом с настройками.
 */

/** Сколько хранить. Человек задаёт сам — «Настройки → История». */
function limit() {
  const value = Number(require('./config').get('history.keep', 50));
  return Number.isFinite(value) && value > 0 ? Math.min(value, 1000) : 50;
}

let items = null;

function file() {
  return path.join(app.getPath('userData'), 'history.json');
}

function load() {
  if (items) return items;
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    items = Array.isArray(saved) ? saved.slice(0, limit()) : [];
  } catch {
    items = [];
  }
  return items;
}

let writeTimer = null;
function save() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      const target = file();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temp = `${target}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(items, null, 1), 'utf8');
      fs.renameSync(temp, target);
    } catch (error) {
      log.warn(`не удалось сохранить историю: ${error.message}`);
    }
  }, 500);
}

/**
 * Добавить текст. Улучшенный вариант не заводит новую запись, а
 * дописывается к той же: это один и тот же надиктованный кусок, и в
 * списке он должен быть один, с обоими вариантами.
 */
function add({ text, improved = false, seconds = 0 }) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  load();

  if (improved && items[0] && !items[0].improved) {
    items[0].improved = clean;
    items[0].improvedAt = Date.now();
    save();
    return items[0];
  }

  const entry = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: clean,
    improved: improved ? clean : '',
    seconds: Math.round(seconds),
    at: Date.now(),
  };
  items.unshift(entry);
  const keep = limit();
  if (items.length > keep) items.length = keep;
  save();
  return entry;
}

function all() {
  return load().map((item) => ({ ...item }));
}

function find(id) {
  return load().find((item) => item.id === id) || null;
}

/** Последняя запись — к ней возвращаются чаще всего. */
function latest() {
  return load()[0] || null;
}

function setImproved(id, improved) {
  const entry = find(id);
  if (!entry) return null;
  entry.improved = String(improved || '').trim();
  entry.improvedAt = Date.now();
  save();
  return entry;
}

function remove(id) {
  load();
  const before = items.length;
  items = items.filter((item) => item.id !== id);
  if (items.length !== before) save();
  return items.length !== before;
}

function clear() {
  items = [];
  save();
}

module.exports = { add, all, find, latest, setImproved, remove, clear, file };
