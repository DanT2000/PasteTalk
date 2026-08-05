'use strict';

const crypto = require('node:crypto');

const db = require('./db');

/**
 * Доступ: ключ — это человек, а не устройство.
 *
 * Код намеренно не одноразовый: один и тот же человек вводит его и в боте,
 * и на телефоне. Плата за удобство — узнавший код чужой тоже привяжется,
 * поэтому устройств на ключ не больше пяти, каждое видно в админке и любое
 * отвязывается отдельно.
 */

const MAX_DEVICES = 5;
const MAX_TRIES = 3;
const PAUSE_MS = 10 * 60 * 1000;

// Промахи считаем в памяти: перезапуск сервера снимает запрет, и это не
// страшно — перебор шести цифр требует тысяч попыток, а не десятка.
const misses = new Map();

function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sixDigits() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function issue(name) {
  const database = db.open();
  const title = String(name || '').trim() || 'Без имени';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = sixDigits();
    if (database.prepare('SELECT 1 FROM keys WHERE code = ?').get(code)) continue;
    const info = database
      .prepare('INSERT INTO keys (name, code, created_at) VALUES (?, ?, ?)')
      .run(title, code, Date.now());
    return { id: Number(info.lastInsertRowid), name: title, code };
  }
  throw new Error('Не удалось подобрать свободный код');
}

function list() {
  const database = db.open();
  const rows = database.prepare('SELECT * FROM keys ORDER BY created_at DESC').all();
  const byKey = database.prepare('SELECT * FROM devices WHERE key_id = ? ORDER BY first_seen');
  return rows.map((row) => ({ ...row, devices: byKey.all(row.id) }));
}

function revoke(id) {
  const info = db.open()
    .prepare('UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), id);
  return info.changes > 0;
}

function unbind(deviceId) {
  return db.open().prepare('DELETE FROM devices WHERE id = ?').run(deviceId).changes > 0;
}

function noteMiss(source) {
  const state = misses.get(source) || { count: 0, until: 0 };
  state.count += 1;
  if (state.count >= MAX_TRIES) state.until = Date.now() + PAUSE_MS;
  misses.set(source, state);
}

/** Сбросить счётчик промахов. Нужно тестам, чтобы соседние проверки не мешали друг другу. */
function forgetMisses() {
  misses.clear();
}

function countDevices(keyId) {
  return db.open().prepare('SELECT COUNT(*) AS n FROM devices WHERE key_id = ?').get(keyId).n;
}

function attach(keyId, kind, externalId, title) {
  if (countDevices(keyId) >= MAX_DEVICES) {
    throw new Error(`Больше ${MAX_DEVICES} устройств на этот код не привязать`);
  }
  const now = Date.now();
  const token = crypto.randomBytes(32).toString('base64url');
  const info = db.open().prepare(`
    INSERT INTO devices (key_id, kind, external_id, token_hash, title, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(keyId, kind, externalId === null ? null : String(externalId),
    hash(token), String(title || ''), now, now);
  return { token, deviceId: Number(info.lastInsertRowid) };
}

function activate(code, kind, externalId, title, source = '') {
  const database = db.open();
  const now = Date.now();

  const state = misses.get(source);
  if (state && state.until > now) {
    throw new Error(`Слишком много попыток. Подождите ${Math.ceil((state.until - now) / 60000)} мин.`);
  }

  const key = database
    .prepare('SELECT * FROM keys WHERE code = ? AND revoked_at IS NULL')
    .get(String(code || '').trim());
  if (!key) {
    noteMiss(source);
    throw new Error('Такого кода нет');
  }

  misses.delete(source);
  const bound = attach(key.id, kind, externalId, title);

  if (!key.first_used_at) {
    database.prepare('UPDATE keys SET first_used_at = ? WHERE id = ?').run(now, key.id);
  }

  return { ...bound, keyId: key.id };
}

/**
 * Привязка владельцем вручную — запасной путь, когда человек потерял код.
 * Проверок на попытки здесь нет: это делает уже вошедший в админку хозяин.
 */
function bind(keyId, kind, externalId, title) {
  const key = db.open()
    .prepare('SELECT id FROM keys WHERE id = ? AND revoked_at IS NULL').get(keyId);
  if (!key) throw new Error('Такого ключа нет');
  return attach(keyId, kind, externalId, title);
}

/** Кто это, если известен только его номер в телеграме. */
function byExternal(kind, externalId) {
  const row = db.open().prepare(`
    SELECT d.id AS device_id, d.key_id, d.kind
    FROM devices d
    JOIN keys k ON k.id = d.key_id
    WHERE d.kind = ? AND d.external_id = ? AND k.revoked_at IS NULL
  `).get(kind, String(externalId));
  return row ? { keyId: row.key_id, deviceId: row.device_id, kind: row.kind } : null;
}

function authenticate(token) {
  if (!token) return null;
  const database = db.open();
  const row = database.prepare(`
    SELECT d.id AS device_id, d.key_id, d.kind
    FROM devices d
    JOIN keys k ON k.id = d.key_id
    WHERE d.token_hash = ? AND k.revoked_at IS NULL
  `).get(hash(token));
  if (!row) return null;
  database.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), row.device_id);
  return { keyId: row.key_id, deviceId: row.device_id, kind: row.kind };
}

module.exports = {
  issue, list, revoke, unbind, bind, byExternal, activate, authenticate, forgetMisses,
  MAX_DEVICES, MAX_TRIES, PAUSE_MS,
};
