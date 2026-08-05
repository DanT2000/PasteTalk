'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

/**
 * Хранилище счётчиков.
 *
 * SQLite, а не отдельная база: считать надо десяток человек, а поднимать,
 * настраивать и бэкапить ради этого сервер баз данных незачем.
 *
 * Ни звука, ни распознанного текста здесь нет и не будет. Владелец видит,
 * сколько человек надиктовал, но не видит, что именно, — и таблицы
 * устроены так, что положить туда содержимое просто некуда.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  code          TEXT,
  code_until    INTEGER,
  created_at    INTEGER NOT NULL,
  first_used_at INTEGER,
  revoked_at    INTEGER
);

CREATE TABLE IF NOT EXISTS devices (
  id          INTEGER PRIMARY KEY,
  key_id      INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  external_id TEXT,
  token_hash  TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL DEFAULT '',
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id             INTEGER PRIMARY KEY,
  key_id         INTEGER REFERENCES keys(id) ON DELETE SET NULL,
  device_kind    TEXT NOT NULL,
  at             INTEGER NOT NULL,
  audio_seconds  REAL NOT NULL DEFAULT 0,
  executed_by    TEXT NOT NULL,
  stt_provider   TEXT,
  stt_model      TEXT,
  stt_cost_rub   REAL NOT NULL DEFAULT 0,
  llm_provider   TEXT,
  llm_model      TEXT,
  llm_tokens_in  INTEGER NOT NULL DEFAULT 0,
  llm_tokens_out INTEGER NOT NULL DEFAULT 0,
  llm_cost_rub   REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agents (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  jobs_done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
CREATE INDEX IF NOT EXISTS devices_key ON devices(key_id);
`;

/**
 * Столбцы, добавленные после первого выпуска.
 *
 * CREATE TABLE IF NOT EXISTS существующую таблицу не трогает — а том живёт
 * дольше образа. Без этого списка любое обновление схемы валит уже
 * развёрнутый сервер с «no such column», и заметно это становится только
 * тогда, когда человек не может войти.
 */
const ADDED = [
  { table: 'keys', column: 'code_until', ddl: 'INTEGER' },
];

function migrate(database) {
  for (const { table, column, ddl } of ADDED) {
    const exists = database.prepare(`PRAGMA table_info(${table})`).all()
      .some((row) => row.name === column);
    if (exists) continue;
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    process.stdout.write(`База: добавлен столбец ${table}.${column}
`);
  }
}

let current = null;

function defaultFile() {
  return process.env.PASTETALK_DB || path.join(process.cwd(), 'data', 'pastetalk.db');
}

function open(file = defaultFile()) {
  if (current) return current;
  if (file !== ':memory:') {
    // Говорим вслух, нашли базу или заводим новую. Молчание тут дорого
    // стоит: если том подключён неправильно, база тихо пересоздаётся при
    // каждом развёртывании, и пропажа ключей замечается только тогда,
    // когда человек не может войти.
    const existed = fs.existsSync(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    process.stdout.write(existed
      ? `База найдена: ${file}\n`
      : `База не найдена, завожу новую: ${file}. Если это не первый запуск — том подключён неправильно\n`);
  }
  current = new Database(file);
  current.pragma('journal_mode = WAL');
  current.pragma('foreign_keys = ON');
  current.exec(SCHEMA);
  migrate(current);
  return current;
}

function close() {
  if (current) current.close();
  current = null;
}

module.exports = { open, close, SCHEMA };
