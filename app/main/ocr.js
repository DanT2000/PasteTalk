'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, clipboard } = require('electron');

const engine = require('./engine');
const log = require('./logger').scoped('ocr');

/**
 * Распознавание текста на картинках.
 *
 * Саму работу делает движок: там уже есть отдельный процесс, а из
 * основного процесса Electron встроенный распознаватель Windows просто
 * не заводится — асинхронные вызовы WinRT падают с AggregateException,
 * хоть напрямую, хоть через посредника. Из обычного процесса те же
 * вызовы проходят, поэтому картинки читает движок, как и речь.
 *
 * Здесь остаётся то, что удобнее делать в приложении: достать картинку
 * из буфера обмена и положить её во временный файл.
 */

function tempImage() {
  const dir = path.join(app?.getPath ? app.getPath('temp') : os.tmpdir(), 'pastetalk');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `clip-${Date.now()}.png`);
}

/** Какие языки Windows умеет распознавать на этой машине. */
async function languages() {
  try {
    const answer = await engine.request('GET', '/ocr/languages', null, 30000);
    return answer.languages || [];
  } catch (error) {
    log.warn(`не удалось получить список языков: ${error.message}`);
    return [];
  }
}

/** Распознать текст на картинке по пути к файлу. */
async function fromFile(imagePath, language = '') {
  if (!fs.existsSync(imagePath)) throw new Error('Файл не найден');
  const started = Date.now();
  const answer = await engine.request('POST', '/ocr', { path: imagePath, language: language || '' }, 90000);
  const text = (answer.text || '').trim();
  log.info(`картинка распознана за ${Date.now() - started} мс, символов: ${text.length}`);
  return text;
}

/** Распознать картинку, лежащую в буфере обмена. */
async function fromClipboard(language = '') {
  const image = clipboard.readImage();
  if (image.isEmpty()) throw new Error('EMPTY_CLIPBOARD');
  const target = tempImage();
  fs.writeFileSync(target, image.toPNG());
  try {
    return await fromFile(target, language);
  } finally {
    fs.rm(target, { force: true }, () => {});
  }
}

function hasClipboardImage() {
  return !clipboard.readImage().isEmpty();
}

module.exports = { fromFile, fromClipboard, hasClipboardImage, languages };
