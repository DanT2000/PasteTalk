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
    const list = Array.isArray(saved) ? saved : [];
    items = list.slice(0, limit());
    // Записи за пределом выпадают — их голосовые файлы тоже.
    for (const dropped of list.slice(limit())) unlinkVoice(dropped);
  } catch {
    items = [];
  }
  return items;
}

/**
 * Прибрать осиротевшие wav в папке голосов: файл мог остаться от
 * сломанного JSON или упавшего между записями приложения. Зовётся один
 * раз на старте, до первой записи, — чтобы не задеть свежий стэш.
 */
function sweepVoices() {
  try {
    const dir = path.join(app.getPath('userData'), 'voice');
    const known = new Set(load().filter((i) => i.voice).map((i) => path.resolve(i.voice)));
    for (const name of fs.readdirSync(dir)) {
      const full = path.resolve(dir, name);
      if (!known.has(full)) fs.unlinkSync(full);
    }
  } catch { /* папки может не быть вовсе — значит, и прибирать нечего */ }
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

/** Стереть файл голоса записи, если он есть. Файл мог уйти и сам. */
function unlinkVoice(entry) {
  if (!entry || !entry.voice) return;
  try {
    fs.unlinkSync(entry.voice);
  } catch { /* уже нет — и хорошо */ }
}

/** Обрезать список до предела, прибрав файлы выпавших записей. */
function prune() {
  const keep = limit();
  if (items.length <= keep) return;
  for (const dropped of items.slice(keep)) unlinkVoice(dropped);
  items.length = keep;
}

function makeId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

  if (improved && items[0] && !items[0].improved && !items[0].voice) {
    items[0].improved = clean;
    items[0].improvedAt = Date.now();
    save();
    return items[0];
  }

  const entry = {
    id: makeId(),
    text: clean,
    improved: improved ? clean : '',
    seconds: Math.round(seconds),
    at: Date.now(),
  };
  items.unshift(entry);
  prune();
  save();
  return entry;
}

/**
 * Голос, который не удалось распознать. Текста нет — есть wav-файл и
 * возможность распознать его позже: движок мог упасть, сервер — молчать,
 * а наговорённое пропадать не должно.
 */
function addVoice({ file, seconds = 0 }) {
  load();
  const entry = {
    id: makeId(),
    text: '',
    improved: '',
    voice: file,
    seconds: Math.round(seconds),
    at: Date.now(),
  };
  items.unshift(entry);
  prune();
  save();
  return entry;
}

/** Распознавание задним числом удалось: голос превращается в текст. */
function setText(id, text) {
  const entry = find(id);
  if (!entry) return null;
  entry.text = String(text || '').trim();
  unlinkVoice(entry);
  delete entry.voice;
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
  unlinkVoice(find(id));
  items = items.filter((item) => item.id !== id);
  if (items.length !== before) save();
  return items.length !== before;
}

function clear() {
  load();
  for (const item of items) unlinkVoice(item);
  items = [];
  save();
}

module.exports = { add, addVoice, setText, all, find, latest, setImproved, remove, clear, file, sweepVoices };
