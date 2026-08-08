'use strict';

const { app } = require('electron');

const config = require('./config');

/**
 * Язык интерфейса.
 *
 * Исходный язык строк в коде — русский: он написан и вычитан руками.
 * Английский — словарь «русская строка → английская» в locales/en.json.
 * Такой подход не требует перелопачивать весь код на ключи: строка без
 * перевода просто остаётся русской, ничего не падает и не пустеет.
 *
 * По умолчанию язык берётся из системы: русская Windows — русский,
 * любая другая — английский. В настройках можно выбрать явно.
 */

// Словарь собирается из всех en*.json в locales/: разным частям
// приложения удобнее жить в своих файлах, а склейка — здесь.
let dict = {};
try {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'locales');
  for (const name of fs.readdirSync(dir)) {
    if (/^en.*\.json$/i.test(name)) {
      const part = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      for (const [key, value] of Object.entries(part)) {
        // Один ключ с разными переводами в разных файлах — тихая порча:
        // побеждает файл, что позже по алфавиту, и правка проигравшего
        // молча ни на что не влияет. Пусть хотя бы будет видно в журнале.
        if (key in dict && dict[key] !== value) {
          console.warn(`[i18n] «${key}» переведён по-разному, побеждает ${name}`);
        }
        dict[key] = value;
      }
    }
  }
} catch { /* без словаря интерфейс остаётся русским */ }

function locale() {
  const chosen = String(config.get('ui.locale', '') || '');
  if (chosen === 'ru' || chosen === 'en') return chosen;
  try {
    return String(app.getLocale() || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
  } catch {
    return 'en';
  }
}

/** Перевести строку, если включён английский. Незнакомая — как есть. */
function tr(text) {
  if (locale() !== 'en') return text;
  return dict[text] || text;
}

/** Словарь и язык для окон: они переводят свой DOM сами. */
function forRenderer() {
  return { locale: locale(), dict: locale() === 'en' ? dict : {} };
}

module.exports = { tr, locale, forRenderer };
