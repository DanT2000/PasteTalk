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
 * Полный путь к файлу голоса записи. В новых записях хранится только имя
 * файла: на портативной флешке буква диска меняется от компьютера к
 * компьютеру, и абсолютный путь мертвеет. Старые записи с абсолютным
 * путём продолжают работать, а если путь умер — пробуем по имени.
 */
function voiceFile(entry) {
  if (!entry || !entry.voice) return '';
  if (path.isAbsolute(entry.voice) && fs.existsSync(entry.voice)) return entry.voice;
  return path.join(app.getPath('userData'), 'voice', path.basename(entry.voice));
}

/**
 * Прибрать осиротевшие wav в папке голосов: файл мог остаться от
 * сломанного JSON или упавшего между записями приложения. Зовётся один
 * раз на старте, до первой записи, — чтобы не задеть свежий стэш.
 * Сравниваем по именам файлов: буква диска могла смениться.
 */
function sweepVoices() {
  try {
    const dir = path.join(app.getPath('userData'), 'voice');
    const known = new Set(load().filter((i) => i.voice).map((i) => path.basename(i.voice)));
    for (const name of fs.readdirSync(dir)) {
      if (!known.has(name)) fs.unlinkSync(path.join(dir, name));
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
    fs.unlinkSync(voiceFile(entry));
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
function add({ text, improved = false, seconds = 0, voice = '' }) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  load();

  // Улучшение дописывается к последней записи С ТЕКСТОМ: это тот же
  // надиктованный кусок. Голос у записи теперь бывает и при тексте.
  if (improved && items[0] && !items[0].improved && items[0].text) {
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
  // Звук рядом с текстом: если модель дала ерунду, запись можно
  // распознать заново другой моделью прямо из истории. Храним только имя
  // файла — полный путь собирает voiceFile().
  if (voice) entry.voice = path.basename(voice);
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
    voice: path.basename(file),
    seconds: Math.round(seconds),
    at: Date.now(),
  };
  items.unshift(entry);
  prune();
  save();
  return entry;
}

/** Распознавание задним числом удалось: у записи появляется текст. */
function setText(id, text) {
  const entry = find(id);
  if (!entry) return null;
  entry.text = String(text || '').trim();
  // Улучшение делалось из старого текста — с новым оно больше не пара.
  entry.improved = '';
  // Голос НЕ удаляем: распознать можно ещё раз, другой моделью. Файл
  // уйдёт вместе с записью — по лимиту, кнопкой «Убрать» или очисткой.
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

module.exports = { add, addVoice, setText, all, find, latest, setImproved, remove, clear, file, sweepVoices, voiceFile };
