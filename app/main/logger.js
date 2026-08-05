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

const recent = [];
let stream = null;
let listener = null;

function logDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function logFile() {
  return path.join(logDir(), 'pastetalk.log');
}

function open() {
  if (stream) return stream;
  const target = logFile();
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    // Ротация в один шаг: старый файл становится .1, новый начинается пустым.
    if (fs.existsSync(target) && fs.statSync(target).size > MAX_BYTES) {
      fs.rmSync(`${target}.1`, { force: true });
      fs.renameSync(target, `${target}.1`);
    }
    stream = fs.createWriteStream(target, { flags: 'a' });
  } catch {
    stream = null;
  }
  return stream;
}

function write(level, scope, message) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `${stamp} ${level.padEnd(5)} ${scope.padEnd(9)} ${message}`;

  recent.push(line);
  if (recent.length > MEMORY_LINES) recent.shift();

  const out = open();
  if (out) out.write(`${line}\n`);
  if (level === 'ERROR') console.error(line);
  else if (process.env.PASTETALK_VERBOSE) console.log(line);

  if (listener) listener(line);
}

function scoped(scope) {
  return {
    info: (message) => write('INFO', scope, message),
    warn: (message) => write('WARN', scope, message),
    error: (message) => write('ERROR', scope, String(message && message.stack ? message.stack : message)),
  };
}

module.exports = {
  scoped,
  tail: () => recent.slice(),
  onLine: (fn) => { listener = fn; },
  logFile,
  logDir,
};
