'use strict';

const db = require('./db');

/**
 * Настройки парами ключ-значение.
 *
 * Ключи провайдеров сюда же, но наружу они уходят звёздочками: один раз
 * показанный на экране ключ рано или поздно окажется на чужом экране.
 * Пустой ключ при этом остаётся пустым — иначе по звёздочкам не отличить
 * «ключ задан» от «ключа нет», а это как раз то, что надо видеть.
 */

const SECRET_KEYS = ['key.openai', 'key.deepseek', 'key.aitunnel', 'key.custom', 'bot.token'];

function decode(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function get(key, fallback = null) {
  const row = db.open().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? decode(row.value) : fallback;
}

function set(key, value) {
  db.open().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value));
}

function all() {
  const rows = db.open().prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const row of rows) {
    const value = decode(row.value);
    out[row.key] = SECRET_KEYS.includes(row.key) && value ? '***' : value;
  }
  return out;
}

module.exports = { get, set, all, SECRET_KEYS };
