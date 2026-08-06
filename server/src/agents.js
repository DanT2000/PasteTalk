'use strict';

const crypto = require('node:crypto');

const db = require('./db');

/**
 * Компьютеры, которые считают за других.
 *
 * Отдельно от людей намеренно. Человек диктует: у него разовый код,
 * устройства, минуты и рубли. Компьютер не диктует — он служит, и ему
 * нужен постоянный ключ, который вставляют один раз и забывают.
 *
 * Когда это было одним списком, приходилось заводить фиктивного человека
 * ради машины и искать её среди родственников. А главное — код, выданный
 * на телефон, давал право принимать чужие диктовки звуком.
 */

function hash(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Завести компьютер и выдать ему ключ. Ключ показывается один раз. */
function add(name, priority) {
  const database = db.open();
  const title = String(name || '').trim() || 'Компьютер';
  const key = `pt_${crypto.randomBytes(24).toString('base64url')}`;
  const now = Date.now();

  const order = Number(priority) > 0 ? Number(priority) : nextPriority(database);
  const info = database.prepare(`
    INSERT INTO agents (name, key_hash, priority, paired_at, last_seen)
    VALUES (?, ?, ?, ?, 0)
  `).run(title, hash(key), order, now);

  return { id: Number(info.lastInsertRowid), name: title, key, priority: order };
}

function nextPriority(database) {
  const row = database.prepare('SELECT MAX(priority) AS top FROM agents').get();
  return (row?.top || 0) + 1;
}

/** Новый ключ тому же компьютеру: прежний перестаёт работать сразу. */
function reissue(id) {
  const database = db.open();
  const row = database.prepare('SELECT name FROM agents WHERE id = ?').get(id);
  if (!row) throw new Error('Такого компьютера нет');
  const key = `pt_${crypto.randomBytes(24).toString('base64url')}`;
  database.prepare('UPDATE agents SET key_hash = ? WHERE id = ?').run(hash(key), id);
  return { id, name: row.name, key };
}

/**
 * Принять машину со старым токеном человека: переходный путь.
 *
 * Из токена заводится обычная строка в agents — с тем же ключом, чтобы
 * следующее подключение прошло уже по основной ветке. Задачи, порядок,
 * пинг и админка работают как у любой машины.
 */
function adopt(oldToken, name) {
  const database = db.open();
  const existing = database
    .prepare('SELECT id, name, priority FROM agents WHERE key_hash = ?')
    .get(hash(oldToken));
  if (existing) return existing;
  const now = Date.now();
  const info = database.prepare(`
    INSERT INTO agents (name, key_hash, priority, paired_at, last_seen)
    VALUES (?, ?, ?, ?, 0)
  `).run(String(name || 'ПК').trim() || 'ПК', hash(oldToken), nextPriority(database), now);
  return { id: Number(info.lastInsertRowid), name, priority: 0 };
}

/** Кто это, если известен только ключ. */
function byKey(key) {
  if (!key) return null;
  return db.open()
    .prepare('SELECT id, name, priority FROM agents WHERE key_hash = ?')
    .get(hash(key)) || null;
}

/** Жив ли ещё компьютер под этим номером: его могли удалить. */
function exists(id) {
  return Boolean(db.open().prepare('SELECT 1 FROM agents WHERE id = ?').get(id));
}

/** Все компьютеры по порядку опроса. */
function list() {
  return db.open()
    .prepare('SELECT id, name, priority, paired_at, last_seen, jobs_done FROM agents'
      + ' ORDER BY priority, id')
    .all();
}

function remove(id) {
  return db.open().prepare('DELETE FROM agents WHERE id = ?').run(id).changes > 0;
}

function rename(id, name) {
  const title = String(name || '').trim();
  if (!title) throw new Error('Имя не может быть пустым');
  return db.open().prepare('UPDATE agents SET name = ? WHERE id = ?').run(title, id).changes > 0;
}

/** Подвинуть в очереди опроса: обмен местами с соседом. */
function move(id, up) {
  const database = db.open();
  const all = list();
  const index = all.findIndex((row) => row.id === Number(id));
  if (index < 0) return false;
  const target = up ? index - 1 : index + 1;
  if (target < 0 || target >= all.length) return false;

  // После миграции у старых строк приоритеты совпадают, и обмен местами
  // 1↔1 ничего бы не менял. Поэтому не обмениваем, а перенумеровываем
  // весь список по его нынешнему порядку с переставленной парой.
  [all[index], all[target]] = [all[target], all[index]];
  const renumber = database.transaction(() => {
    all.forEach((row, position) => {
      database.prepare('UPDATE agents SET priority = ? WHERE id = ?').run(position + 1, row.id);
    });
  });
  renumber();
  return true;
}

function noteSeen(id) {
  db.open().prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(Date.now(), id);
}

function noteJob(id) {
  db.open().prepare('UPDATE agents SET jobs_done = jobs_done + 1, last_seen = ? WHERE id = ?')
    .run(Date.now(), id);
}

module.exports = {
  add, adopt, reissue, byKey, exists, list, remove, rename, move, noteSeen, noteJob,
};
