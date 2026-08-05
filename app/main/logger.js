'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * Журнал в файл плюс кольцевой буфер в памяти — окно «Логи» читает
 * последние строки, не разбирая файл целиком.
 */

const MEMORY_LINES = 400;
const MAX_BYTES = 1024 * 1024;

// Ошибки живут отдельно от общего журнала. В журнал за день набегают
// тысячи строк, и найти среди них поломку невозможно; а если одна и та
// же ошибка сыплется тысячу раз, человеку нужна не тысяча строк, а одна
// с числом повторов.
const ERROR_MEMORY = 200;
const ERROR_WINDOW_MS = 24 * 60 * 60 * 1000;

const recent = [];
const errors = [];
let stream = null;
let errorStream = null;
let listener = null;

function logDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function logFile() {
  return path.join(logDir(), 'pastetalk.log');
}

function errorFile() {
  return path.join(logDir(), 'errors.log');
}

function openFile(target) {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    // Ротация в один шаг: старый файл становится .1, новый начинается пустым.
    if (fs.existsSync(target) && fs.statSync(target).size > MAX_BYTES) {
      fs.rmSync(`${target}.1`, { force: true });
      fs.renameSync(target, `${target}.1`);
    }
    return fs.createWriteStream(target, { flags: 'a' });
  } catch {
    return null;
  }
}

function open() {
  if (!stream) stream = openFile(logFile());
  return stream;
}

function openErrors() {
  if (!errorStream) errorStream = openFile(errorFile());
  return errorStream;
}

/**
 * Свести повторы в один пункт.
 *
 * Ключ — область и текст без чисел: «не ответил за 5012 мс» и «не ответил
 * за 5310 мс» — это одна и та же беда, и показывать её дважды незачем.
 */
function remember(scope, message, at) {
  const key = `${scope}|${String(message).replace(/\d+/g, '#').slice(0, 200)}`;
  const existing = errors.find((item) => item.key === key);
  if (existing) {
    existing.count += 1;
    existing.last = at;
    existing.message = message;
    return;
  }
  errors.push({ key, scope, message, first: at, last: at, count: 1 });
  if (errors.length > ERROR_MEMORY) errors.shift();
}

function write(level, scope, message) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `${stamp} ${level.padEnd(5)} ${scope.padEnd(9)} ${message}`;

  recent.push(line);
  if (recent.length > MEMORY_LINES) recent.shift();

  const out = open();
  if (out) out.write(`${line}\n`);

  if (level === 'ERROR') {
    console.error(line);
    remember(scope, message, Date.now());
    const errorsOut = openErrors();
    if (errorsOut) errorsOut.write(`${line}\n`);
  } else if (process.env.PASTETALK_VERBOSE) {
    console.log(line);
  }

  if (listener) listener(line);
}

function scoped(scope) {
  return {
    info: (message) => write('INFO', scope, message),
    warn: (message) => write('WARN', scope, message),
    error: (message) => write('ERROR', scope, String(message && message.stack ? message.stack : message)),
  };
}

/** Ошибки за сутки, свежие сверху, не больше запрошенного числа. */
function recentErrors(limit = 20) {
  const since = Date.now() - ERROR_WINDOW_MS;
  return errors
    .filter((item) => item.last >= since)
    .sort((a, b) => b.last - a.last)
    .slice(0, limit)
    .map(({ scope, message, first, last, count }) => ({ scope, message, first, last, count }));
}

module.exports = {
  scoped,
  tail: () => recent.slice(),
  errors: recentErrors,
  onLine: (fn) => { listener = fn; },
  logFile,
  errorFile,
  logDir,
};
