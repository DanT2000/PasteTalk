# PasteTalk Server — план реализации первой части

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поднять сервер, который принимает звук от телефона и Telegram, отдаёт его на распознавание домашнему компьютеру, а когда того нет на связи — в облако, и считает расход в админке.

**Architecture:** Fastify на Node держит SQLite со счётчиками и WebSocket, в который домашний PasteTalk звонит сам. Клиентские запросы уходят либо вниз по этому сокету, либо к облачному провайдеру по цепочке с перебором. Содержимое диктовок нигде не сохраняется.

**Tech Stack:** Node 22, Fastify 5, `@fastify/websocket`, `better-sqlite3`, `ws` (в десктопном приложении), встроенный `node:test`.

## Global Constraints

- Замысел: [docs/superpowers/specs/2026-08-05-pastetalk-server-design.md](../specs/2026-08-05-pastetalk-server-design.md). Расхождения с ним недопустимы без правки замысла.
- Node ≥ 22.21.0. В десктопном приложении Electron 33 (Node 20.18) — там глобального `WebSocket` нет, нужен пакет `ws`.
- Весь текст, который видит человек, — по-русски. Сообщения об ошибках говорят, что случилось, а не «что-то пошло не так».
- Комментарии в коде — по-русски, и объясняют «почему», а не «что». Это правило действующего кода проекта, см. `app/main/llm.js`.
- Ни звук, ни распознанный текст не сохраняются: ни в базу, ни на диск, ни в журнал.
- Тесты — `node --test` без аргументов: он сам находит `*.test.js`. Путь `node --test test/` на Windows не работает — Node принимает папку за модуль. Никаких jest, vitest и mocha.
- Отступ 2 пробела, `'use strict'` в начале каждого файла CommonJS — как в `app/main/`.
- Названия режимов улучшения: `clean` → «Почистить», `both` → «Почистить и переписать». Ровно те же, что на десктопе.
- Файл базы: путь берётся из `PASTETALK_DB`, по умолчанию `./data/pastetalk.db`.
- Пароль админки по умолчанию `admin`; до первой смены принимается только из локальной сети.

## Структура файлов

```
shared/
  modes.js              промпты улучшения — единственный источник для ПК и сервера
  providers.js          таблица облачных провайдеров, общая для ПК и сервера

server/
  package.json
  Dockerfile
  README.md
  src/
    index.js            запуск: собрать Fastify, подцепить маршруты, слушать порт
    db.js               открыть SQLite, накатить схему
    keys.js             ключи, коды, устройства, ограничение попыток
    prices.js           прайс-лист и подсчёт стоимости
    usage.js            запись строки расхода и сводки для админки
    settings.js         пары ключ-значение в базе, с сокрытием секретов
    providers/
      stt.js            распознавание через OpenAI-совместимый /audio/transcriptions
      llm.js            улучшение через /chat/completions
      chains.js         перебор по цепочке: не ответил первый — идём ко второму
    agent/
      socket.js         WebSocket: привязка, ping/pong, отправка задач
      queue.js          очередь к агенту и уход в облако по таймауту
    routes/
      client.js         /v1/*
      admin.js          /admin/*
    admin/
      auth.js           пароль, принудительная смена, проверка локальной сети
      ui.js             отдача статических страниц админки
      pages/            html-страницы админки
  test/
    keys.test.js
    prices.test.js
    usage.test.js
    chains.test.js
    queue.test.js
    auth.test.js
    client.test.js

app/main/
  relay.js              агент: соединение с сервером, приём задач
```

---

### Task 1: Каркас сервера и общие модули

**Files:**
- Create: `shared/modes.js`
- Create: `shared/providers.js`
- Create: `server/package.json`
- Create: `server/src/index.js`
- Create: `server/src/db.js`
- Test: `server/test/smoke.test.js`

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `shared/modes.js` → `{ MODES: { clean: string, both: string }, TAIL: string, instruction(mode: string, prompt?: string): string }`
  - `shared/providers.js` → `{ CLOUD: Record<string, {title, kind, baseUrl, needsKey, stt?: boolean, defaultModel?: string}> }`
  - `server/src/db.js` → `{ open(file?: string): Database, close(): void }`, где `Database` — экземпляр `better-sqlite3`
  - `server/src/index.js` → `{ build(): FastifyInstance, start(): Promise<void> }`

- [ ] **Шаг 1: Написать падающий тест**

`server/test/smoke.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { build } = require('../src/index');
const { MODES, instruction } = require('../../shared/modes');
const { CLOUD } = require('../../shared/providers');

test('сервер отвечает, что жив', async () => {
  const app = build();
  const reply = await app.inject({ method: 'GET', url: '/health' });
  assert.strictEqual(reply.statusCode, 200);
  assert.strictEqual(reply.json().ok, true);
  await app.close();
});

test('промпты улучшения общие с десктопом', () => {
  assert.ok(MODES.clean.includes('слова-паразиты'));
  assert.ok(MODES.both.includes('раздели на абзацы'));
  assert.ok(instruction('clean').startsWith(MODES.clean));
});

test('DeepSeek не предлагается для распознавания речи', () => {
  assert.strictEqual(CLOUD.deepseek.stt, false);
  assert.strictEqual(CLOUD.openai.stt, true);
  assert.strictEqual(CLOUD.aitunnel.stt, true);
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `cd server && node --test test/smoke.test.js`
Expected: FAIL — `Cannot find module '../src/index'`

- [ ] **Шаг 3: Создать `server/package.json`**

```json
{
  "name": "pastetalk-server",
  "version": "0.1.0",
  "description": "Сервер PasteTalk: диктовка с телефона и из Telegram через домашний компьютер",
  "license": "MIT",
  "private": true,
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test"
  },
  "dependencies": {
    "@fastify/websocket": "^11.0.1",
    "better-sqlite3": "^11.5.0",
    "fastify": "^5.1.0"
  }
}
```

Затем: `cd server && npm install`

- [ ] **Шаг 4: Создать `shared/modes.js`**

Текст промптов копируется дословно из `app/main/llm.js:105-123` — это тот самый общий источник, ради которого модуль и заводится.

```js
'use strict';

/**
 * Промпты улучшения текста — один источник для компьютера и для сервера.
 *
 * Живут отдельно от llm.js именно потому, что их читает и серверная часть.
 * Разъехавшиеся промпты означали бы, что «Почистить» на телефоне и на
 * компьютере дают разный результат, а человек этого не поймёт.
 */

const MODES = {
  // Осторожный режим: правим только то, что человек и сам бы поправил,
  // перечитав написанное. Формулировки и порядок мыслей — его.
  clean:
    'Убери слова-паразиты, повторы и оговорки. Исправь грамматические ошибки и знаки препинания. '
    + 'Формулировки, порядок мыслей и манеру речи оставь как есть — '
    + 'не переписывай то, что и так сказано понятно, и ничего не добавляй от себя.',

  // Здесь модель именно переписывает. Живая речь идёт как придётся:
  // мысль начинается, обрывается, к ней возвращаются через две минуты.
  // Задача — собрать это в текст, который читается с первого раза.
  both:
    'Сначала убери слова-паразиты, повторы и оговорки, исправь грамматику и знаки препинания. '
    + 'Затем перепиши получившееся так, чтобы читалось легко: переформулируй, где выйдет яснее, '
    + 'собери разбросанные куски одной мысли вместе, даже если в речи они шли вразнобой, '
    + 'выстрой изложение от главного к подробностям, раздели на абзацы, '
    + 'перечисления оформи списком, устную интонацию замени на письменную. '
    + 'Ни одного факта не потеряй и ни одного не придумай.',
};

const TAIL = ' В ответ верни только готовый текст, без пояснений и без кавычек.';

function instruction(mode, prompt = '') {
  const body = mode === 'custom' ? (prompt || MODES.clean) : (MODES[mode] || MODES.clean);
  return body + TAIL;
}

module.exports = { MODES, TAIL, instruction };
```

- [ ] **Шаг 5: Создать `shared/providers.js`**

```js
'use strict';

/**
 * Облачные провайдеры, доступные и компьютеру, и серверу.
 *
 * Поле stt отвечает на единственный вопрос, который стоит дорого: умеет ли
 * провайдер распознавать речь. У DeepSeek распознавания нет — если бы его
 * можно было выбрать аварийным, владелец узнал бы об этом ночью, когда с
 * телефона не получилось бы продиктовать.
 */

const CLOUD = {
  openai: {
    title: 'ChatGPT (OpenAI)',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    stt: true,
    defaultModel: 'gpt-4o-mini',
    defaultSttModel: 'whisper-1',
  },
  deepseek: {
    title: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    stt: false,
    defaultModel: 'deepseek-chat',
  },
  aitunnel: {
    title: 'AITunnel',
    kind: 'openai',
    baseUrl: 'https://api.aitunnel.ru/v1',
    needsKey: true,
    stt: true,
    defaultModel: 'deepseek-chat',
    defaultSttModel: 'whisper-large-v3-turbo',
  },
  custom: {
    title: 'Своё, OpenAI-совместимое',
    kind: 'openai',
    baseUrl: '',
    needsKey: false,
    stt: true,
  },
};

module.exports = { CLOUD };
```

- [ ] **Шаг 6: Создать `server/src/db.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

/**
 * Хранилище счётчиков.
 *
 * SQLite, а не отдельная база: считать надо десяток человек, а поднимать,
 * настраивать и бэкапить ради этого сервер баз данных незачем.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  code          TEXT NOT NULL UNIQUE,
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

let current = null;

function open(file = process.env.PASTETALK_DB || path.join(process.cwd(), 'data', 'pastetalk.db')) {
  if (current) return current;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  current = new Database(file);
  current.pragma('journal_mode = WAL');
  current.pragma('foreign_keys = ON');
  current.exec(SCHEMA);
  return current;
}

function close() {
  if (current) current.close();
  current = null;
}

module.exports = { open, close, SCHEMA };
```

- [ ] **Шаг 7: Создать `server/src/index.js`**

```js
'use strict';

const Fastify = require('fastify');

function build(options = {}) {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024, ...options });

  app.get('/health', async () => ({ ok: true }));

  return app;
}

async function start() {
  const app = build();
  const port = Number(process.env.PORT || 3000);
  await app.listen({ port, host: '0.0.0.0' });
  process.stdout.write(`PasteTalk Server слушает порт ${port}\n`);
}

if (require.main === module) start();

module.exports = { build, start };
```

Предел тела в 32 МБ: голосовое на двадцать минут в ogg весит около 10 МБ, и упереться в предел на длинной диктовке было бы обидно.

- [ ] **Шаг 8: Убедиться, что тесты проходят**

Run: `cd server && node --test test/smoke.test.js`
Expected: PASS, три теста

- [ ] **Шаг 9: Коммит**

```bash
git add shared/ server/package.json server/package-lock.json server/src/ server/test/
git commit -m "Каркас сервера и общие с десктопом промпты"
```

---

### Task 2: Ключи, коды и устройства

**Files:**
- Create: `server/src/keys.js`
- Test: `server/test/keys.test.js`

**Interfaces:**
- Consumes: `db.open()` из Task 1.
- Produces: `server/src/keys.js` →
  - `issue(name: string): { id: number, name: string, code: string }`
  - `list(): Array<{id, name, code, created_at, first_used_at, revoked_at, devices: Array}>`
  - `revoke(id: number): boolean`
  - `activate(code: string, kind: 'telegram'|'android', externalId: string|null, title: string, source: string): { token: string, keyId: number }`
  - `authenticate(token: string): { keyId: number, deviceId: number, kind: string } | null`
  - `unbind(deviceId: number): boolean`
  - `bind(keyId: number, kind: 'telegram'|'android', externalId: string, title: string): { token: string, deviceId: number }` — привязка владельцем вручную, минуя код
  - `byExternal(kind: string, externalId: string): { keyId, deviceId, kind } | null`
  - `MAX_DEVICES: 5`, `MAX_TRIES: 3`, `PAUSE_MS: 600000`

- [ ] **Шаг 1: Написать падающий тест**

`server/test/keys.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

test('код привязывает и телефон, и телеграм к одному ключу', () => {
  const keys = require('../src/keys');
  const key = keys.issue('Мама');
  assert.match(key.code, /^\d{6}$/);

  const phone = keys.activate(key.code, 'android', null, 'Redmi Note 12', '1.1.1.1');
  const tg = keys.activate(key.code, 'telegram', '123456789', 'Мама', '1.1.1.1');

  assert.strictEqual(phone.keyId, tg.keyId);
  assert.notStrictEqual(phone.token, tg.token);
  assert.strictEqual(keys.authenticate(phone.token).keyId, key.id);
  assert.strictEqual(keys.authenticate(tg.token).kind, 'telegram');
});

test('больше пяти устройств на ключ не привязывается', () => {
  const keys = require('../src/keys');
  const key = keys.issue('Общий');
  for (let i = 0; i < keys.MAX_DEVICES; i += 1) {
    keys.activate(key.code, 'android', null, `Телефон ${i}`, '1.1.1.1');
  }
  assert.throws(
    () => keys.activate(key.code, 'android', null, 'Лишний', '1.1.1.1'),
    /устройств/i,
  );
});

test('три промаха подряд запирают источник', () => {
  const keys = require('../src/keys');
  keys.issue('Кто-то');
  for (let i = 0; i < keys.MAX_TRIES; i += 1) {
    assert.throws(() => keys.activate('000000', 'android', null, '', '9.9.9.9'), /код/i);
  }
  assert.throws(() => keys.activate('000000', 'android', null, '', '9.9.9.9'), /подожд/i);
});

test('отзыв ключа отрезает все его устройства разом', () => {
  const keys = require('../src/keys');
  const key = keys.issue('Папа');
  const phone = keys.activate(key.code, 'android', null, 'Телефон', '1.1.1.1');
  const tg = keys.activate(key.code, 'telegram', '42', 'Папа', '1.1.1.1');

  assert.ok(keys.revoke(key.id));
  assert.strictEqual(keys.authenticate(phone.token), null);
  assert.strictEqual(keys.authenticate(tg.token), null);
});

test('одно устройство отвязывается, не трогая остальные', () => {
  const keys = require('../src/keys');
  const key = keys.issue('Мама');
  const phone = keys.activate(key.code, 'android', null, 'Телефон', '1.1.1.1');
  const tg = keys.activate(key.code, 'telegram', '42', 'Мама', '1.1.1.1');

  const deviceId = keys.authenticate(phone.token).deviceId;
  assert.ok(keys.unbind(deviceId));
  assert.strictEqual(keys.authenticate(phone.token), null);
  assert.ok(keys.authenticate(tg.token));
});

test('владелец может привязать телеграм вручную, без кода', () => {
  const keys = require('../src/keys');
  const key = keys.issue('Мама');
  const bound = keys.bind(key.id, 'telegram', '123456789', 'Мама');

  assert.ok(bound.token);
  assert.strictEqual(keys.authenticate(bound.token).keyId, key.id);
  assert.strictEqual(keys.byExternal('telegram', '123456789').keyId, key.id);
  assert.strictEqual(keys.byExternal('telegram', '999'), null);
});

test('токен в базе не хранится в открытом виде', () => {
  const keys = require('../src/keys');
  const key = keys.issue('Мама');
  const phone = keys.activate(key.code, 'android', null, 'Телефон', '1.1.1.1');
  const rows = db.open().prepare('SELECT token_hash FROM devices').all();
  assert.ok(rows.every((row) => !row.token_hash.includes(phone.token)));
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `cd server && node --test test/keys.test.js`
Expected: FAIL — `Cannot find module '../src/keys'`

- [ ] **Шаг 3: Написать `server/src/keys.js`**

```js
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

// Промахи считаем в памяти: перезапуск сервера снимает запрет, и это
// не страшно — перебор шести цифр требует тысяч попыток, а не десятка.
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
    const exists = database.prepare('SELECT 1 FROM keys WHERE code = ?').get(code);
    if (exists) continue;
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
  const devices = database.prepare('SELECT * FROM devices WHERE key_id = ? ORDER BY first_seen').all;
  return rows.map((row) => ({ ...row, devices: devices.call(
    database.prepare('SELECT * FROM devices WHERE key_id = ? ORDER BY first_seen'), row.id,
  ) }));
}

function revoke(id) {
  const database = db.open();
  const info = database.prepare('UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), id);
  return info.changes > 0;
}

function unbind(deviceId) {
  const info = db.open().prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
  return info.changes > 0;
}

function noteMiss(source) {
  const now = Date.now();
  const state = misses.get(source) || { count: 0, until: 0 };
  state.count += 1;
  if (state.count >= MAX_TRIES) state.until = now + PAUSE_MS;
  misses.set(source, state);
}

function activate(code, kind, externalId, title, source = '') {
  const database = db.open();
  const now = Date.now();

  const state = misses.get(source);
  if (state && state.until > now) {
    const left = Math.ceil((state.until - now) / 60000);
    throw new Error(`Слишком много попыток. Подождите ${left} мин.`);
  }

  const key = database
    .prepare('SELECT * FROM keys WHERE code = ? AND revoked_at IS NULL')
    .get(String(code || '').trim());
  if (!key) {
    noteMiss(source);
    throw new Error('Такого кода нет');
  }

  const count = database
    .prepare('SELECT COUNT(*) AS n FROM devices WHERE key_id = ?')
    .get(key.id).n;
  if (count >= MAX_DEVICES) {
    throw new Error(`Больше ${MAX_DEVICES} устройств на этот код не привязать`);
  }

  misses.delete(source);
  const token = crypto.randomBytes(32).toString('base64url');
  const info = database.prepare(`
    INSERT INTO devices (key_id, kind, external_id, token_hash, title, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(key.id, kind, externalId, hash(token), String(title || ''), now, now);

  if (!key.first_used_at) {
    database.prepare('UPDATE keys SET first_used_at = ? WHERE id = ?').run(now, key.id);
  }

  return { token, keyId: key.id, deviceId: Number(info.lastInsertRowid) };
}

/**
 * Привязка владельцем вручную — запасной путь, когда человек потерял код.
 * Проверок на попытки здесь нет: это делает уже вошедший в админку хозяин.
 */
function bind(keyId, kind, externalId, title) {
  const database = db.open();
  const key = database.prepare('SELECT * FROM keys WHERE id = ? AND revoked_at IS NULL').get(keyId);
  if (!key) throw new Error('Такого ключа нет');

  const count = database.prepare('SELECT COUNT(*) AS n FROM devices WHERE key_id = ?').get(keyId).n;
  if (count >= MAX_DEVICES) {
    throw new Error(`Больше ${MAX_DEVICES} устройств на этот ключ не привязать`);
  }

  const now = Date.now();
  const token = crypto.randomBytes(32).toString('base64url');
  const info = database.prepare(`
    INSERT INTO devices (key_id, kind, external_id, token_hash, title, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(keyId, kind, String(externalId), hash(token), String(title || ''), now, now);

  return { token, deviceId: Number(info.lastInsertRowid) };
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
  const row = db.open().prepare(`
    SELECT d.id AS device_id, d.key_id, d.kind
    FROM devices d
    JOIN keys k ON k.id = d.key_id
    WHERE d.token_hash = ? AND k.revoked_at IS NULL
  `).get(hash(token));
  if (!row) return null;
  db.open().prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), row.device_id);
  return { keyId: row.key_id, deviceId: row.device_id, kind: row.kind };
}

module.exports = {
  issue, list, revoke, unbind, bind, byExternal, activate, authenticate,
  MAX_DEVICES, MAX_TRIES, PAUSE_MS,
};
```

- [ ] **Шаг 4: Упростить `list()` — в написанном виде он запутан**

Заменить тело `list()` на:

```js
function list() {
  const database = db.open();
  const keysRows = database.prepare('SELECT * FROM keys ORDER BY created_at DESC').all();
  const byKey = database.prepare('SELECT * FROM devices WHERE key_id = ? ORDER BY first_seen');
  return keysRows.map((row) => ({ ...row, devices: byKey.all(row.id) }));
}
```

- [ ] **Шаг 5: Убедиться, что тесты проходят**

Run: `cd server && node --test test/keys.test.js`
Expected: PASS, шесть тестов

- [ ] **Шаг 6: Коммит**

```bash
git add server/src/keys.js server/test/keys.test.js
git commit -m "Ключи, коды и привязка устройств"
```

---

### Task 3: Прайс-лист и подсчёт денег

**Files:**
- Create: `server/src/settings.js`
- Create: `server/src/prices.js`
- Test: `server/test/prices.test.js`

**Interfaces:**
- Consumes: `db.open()`.
- Produces:
  - `settings.js` → `get(key, fallback?): any`, `set(key, value): void`, `all(): object`, `SECRET_KEYS: string[]`
  - `prices.js` → `sttCost(model: string, seconds: number): number`, `llmCost(model: string, tokensIn: number, tokensOut: number): number`, `table(): object`, `setTable(next: object): void`, `DEFAULTS: object`

- [ ] **Шаг 1: Написать падающий тест**

`server/test/prices.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

test('распознавание считается по минутам звука', () => {
  const prices = require('../src/prices');
  prices.setTable({ stt: { 'whisper-large-v3-turbo': 0.6 }, llm: {} });
  // Полторы минуты по 0.6 ₽ за минуту.
  assert.strictEqual(Math.round(prices.sttCost('whisper-large-v3-turbo', 90) * 100) / 100, 0.9);
});

test('улучшение считается по токенам в обе стороны', () => {
  const prices = require('../src/prices');
  prices.setTable({ stt: {}, llm: { 'deepseek-chat': { in: 20, out: 60 } } });
  // 500 000 входных по 20 ₽/млн + 250 000 выходных по 60 ₽/млн = 10 + 15.
  assert.strictEqual(prices.llmCost('deepseek-chat', 500_000, 250_000), 25);
});

test('незнакомая модель стоит ноль, а не ломает подсчёт', () => {
  const prices = require('../src/prices');
  prices.setTable({ stt: {}, llm: {} });
  assert.strictEqual(prices.sttCost('какая-то-новая', 60), 0);
  assert.strictEqual(prices.llmCost('какая-то-новая', 1000, 1000), 0);
});

test('секреты не отдаются наружу в открытом виде', () => {
  const settings = require('../src/settings');
  settings.set('key.aitunnel', 'sk-aitunnel-секрет');
  const shown = settings.all();
  assert.strictEqual(shown['key.aitunnel'], '***');
  assert.strictEqual(settings.get('key.aitunnel'), 'sk-aitunnel-секрет');
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `cd server && node --test test/prices.test.js`
Expected: FAIL — `Cannot find module '../src/settings'`

- [ ] **Шаг 3: Написать `server/src/settings.js`**

```js
'use strict';

const db = require('./db');

/**
 * Настройки парами ключ-значение.
 *
 * Ключи провайдеров сюда же, но наружу они уходят звёздочками: один раз
 * показанный на экране ключ рано или поздно окажется на чужом экране.
 */

const SECRET_KEYS = ['key.openai', 'key.deepseek', 'key.aitunnel', 'key.custom', 'bot.token'];

function get(key, fallback = null) {
  const row = db.open().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function set(key, value) {
  db.open()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function all() {
  const rows = db.open().prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const row of rows) {
    let value;
    try { value = JSON.parse(row.value); } catch { value = row.value; }
    out[row.key] = SECRET_KEYS.includes(row.key) && value ? '***' : value;
  }
  return out;
}

module.exports = { get, set, all, SECRET_KEYS };
```

- [ ] **Шаг 4: Написать `server/src/prices.js`**

```js
'use strict';

const settings = require('./settings');

/**
 * Во сколько обошлась диктовка.
 *
 * Считаем сами, а не спрашиваем провайдера: AITunnel объявляет заголовки
 * cost-rub и balance, но фактически их не присылает — ни в ответе, ни
 * отдельной ручкой. Поэтому в админке эта цифра подписана как оценка по
 * своему прайсу, а не как факт.
 *
 * Цены: распознавание — рублей за минуту звука, улучшение — рублей за
 * миллион токенов отдельно на вход и на выход.
 */

const DEFAULTS = {
  stt: {
    'whisper-1': 0.6,
    'whisper-large-v3-turbo': 0.4,
  },
  llm: {
    'deepseek-chat': { in: 20, out: 60 },
    'gpt-4o-mini': { in: 14, out: 55 },
  },
};

function table() {
  return settings.get('prices', DEFAULTS);
}

function setTable(next) {
  settings.set('prices', next);
}

function sttCost(model, seconds) {
  const perMinute = table().stt?.[model];
  if (!perMinute) return 0;
  return (seconds / 60) * perMinute;
}

function llmCost(model, tokensIn, tokensOut) {
  const row = table().llm?.[model];
  if (!row) return 0;
  return (tokensIn / 1_000_000) * row.in + (tokensOut / 1_000_000) * row.out;
}

module.exports = { table, setTable, sttCost, llmCost, DEFAULTS };
```

- [ ] **Шаг 5: Убедиться, что тесты проходят**

Run: `cd server && node --test test/prices.test.js`
Expected: PASS, четыре теста

- [ ] **Шаг 6: Коммит**

```bash
git add server/src/settings.js server/src/prices.js server/test/prices.test.js
git commit -m "Прайс-лист и подсчёт расхода"
```

---

### Task 4: Запись расхода и сводки для админки

**Files:**
- Create: `server/src/usage.js`
- Test: `server/test/usage.test.js`

**Interfaces:**
- Consumes: `db.open()`, `prices.sttCost`, `prices.llmCost`.
- Produces: `usage.js` →
  - `record(entry: {keyId, deviceKind, audioSeconds, executedBy, sttProvider?, sttModel?, llmProvider?, llmModel?, tokensIn?, tokensOut?}): number` — возвращает id строки
  - `monthly(now?: number): { agentMinutes: number, cloudMinutes: number, rub: number, byModel: Array<{model, rub, count}> }`
  - `perKey(now?: number): Array<{key_id, minutes, rub}>`

- [ ] **Шаг 1: Написать падающий тест**

`server/test/usage.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

test('диктовка через свой ПК ничего не стоит, но минуты считаются', () => {
  const usage = require('../src/usage');
  const keys = require('../src/keys');
  const key = keys.issue('Мама');

  usage.record({ keyId: key.id, deviceKind: 'android', audioSeconds: 120, executedBy: 'agent' });

  const month = usage.monthly();
  assert.strictEqual(month.agentMinutes, 2);
  assert.strictEqual(month.cloudMinutes, 0);
  assert.strictEqual(month.rub, 0);
});

test('облачная диктовка складывает распознавание и улучшение', () => {
  const usage = require('../src/usage');
  const prices = require('../src/prices');
  const keys = require('../src/keys');
  const key = keys.issue('Папа');
  prices.setTable({
    stt: { 'whisper-large-v3-turbo': 0.6 },
    llm: { 'deepseek-chat': { in: 20, out: 60 } },
  });

  usage.record({
    keyId: key.id, deviceKind: 'telegram', audioSeconds: 60, executedBy: 'cloud',
    sttProvider: 'aitunnel', sttModel: 'whisper-large-v3-turbo',
    llmProvider: 'deepseek', llmModel: 'deepseek-chat',
    tokensIn: 1_000_000, tokensOut: 1_000_000,
  });

  const month = usage.monthly();
  assert.strictEqual(month.cloudMinutes, 1);
  assert.strictEqual(month.rub, 80.6);
});

test('содержимое диктовки в базу не попадает', () => {
  const usage = require('../src/usage');
  const columns = db.open().prepare('PRAGMA table_info(usage)').all().map((c) => c.name);
  assert.ok(!columns.includes('text'));
  assert.ok(!columns.includes('audio'));
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `cd server && node --test test/usage.test.js`
Expected: FAIL — `Cannot find module '../src/usage'`

- [ ] **Шаг 3: Написать `server/src/usage.js`**

```js
'use strict';

const db = require('./db');
const prices = require('./prices');

/**
 * Строка на каждую диктовку: когда, чей ключ, сколько секунд, где считали
 * и во сколько обошлось. Ни звука, ни текста — владелец видит, сколько
 * человек надиктовал, но не видит, что именно.
 */

function record(entry) {
  const sttCost = entry.executedBy === 'cloud' && entry.sttModel
    ? prices.sttCost(entry.sttModel, entry.audioSeconds || 0)
    : 0;
  const llmCost = entry.llmModel
    ? prices.llmCost(entry.llmModel, entry.tokensIn || 0, entry.tokensOut || 0)
    : 0;

  const info = db.open().prepare(`
    INSERT INTO usage (
      key_id, device_kind, at, audio_seconds, executed_by,
      stt_provider, stt_model, stt_cost_rub,
      llm_provider, llm_model, llm_tokens_in, llm_tokens_out, llm_cost_rub
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.keyId ?? null, entry.deviceKind, Date.now(), entry.audioSeconds || 0, entry.executedBy,
    entry.sttProvider ?? null, entry.sttModel ?? null, sttCost,
    entry.llmProvider ?? null, entry.llmModel ?? null,
    entry.tokensIn || 0, entry.tokensOut || 0, llmCost,
  );
  return Number(info.lastInsertRowid);
}

function monthStart(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function monthly(now = Date.now()) {
  const database = db.open();
  const since = monthStart(now);

  const totals = database.prepare(`
    SELECT
      SUM(CASE WHEN executed_by = 'agent' THEN audio_seconds ELSE 0 END) AS agent_seconds,
      SUM(CASE WHEN executed_by = 'cloud' THEN audio_seconds ELSE 0 END) AS cloud_seconds,
      SUM(stt_cost_rub + llm_cost_rub) AS rub
    FROM usage WHERE at >= ?
  `).get(since);

  const byModel = database.prepare(`
    SELECT model, SUM(rub) AS rub, COUNT(*) AS count FROM (
      SELECT stt_model AS model, stt_cost_rub AS rub FROM usage WHERE at >= ? AND stt_model IS NOT NULL
      UNION ALL
      SELECT llm_model AS model, llm_cost_rub AS rub FROM usage WHERE at >= ? AND llm_model IS NOT NULL
    ) GROUP BY model ORDER BY rub DESC
  `).all(since, since);

  return {
    agentMinutes: round((totals.agent_seconds || 0) / 60),
    cloudMinutes: round((totals.cloud_seconds || 0) / 60),
    rub: round(totals.rub || 0),
    byModel: byModel.map((row) => ({ ...row, rub: round(row.rub) })),
  };
}

function perKey(now = Date.now()) {
  return db.open().prepare(`
    SELECT key_id, SUM(audio_seconds) / 60.0 AS minutes, SUM(stt_cost_rub + llm_cost_rub) AS rub
    FROM usage WHERE at >= ? GROUP BY key_id
  `).all(monthStart(now)).map((row) => ({
    key_id: row.key_id, minutes: round(row.minutes), rub: round(row.rub),
  }));
}

module.exports = { record, monthly, perKey };
```

- [ ] **Шаг 4: Убедиться, что тесты проходят**

Run: `cd server && node --test test/usage.test.js`
Expected: PASS, три теста

- [ ] **Шаг 5: Коммит**

```bash
git add server/src/usage.js server/test/usage.test.js
git commit -m "Учёт расхода и сводки для админки"
```

---

### Task 5: Облачные провайдеры и перебор по цепочке

**Files:**
- Create: `server/src/providers/stt.js`
- Create: `server/src/providers/llm.js`
- Create: `server/src/providers/chains.js`
- Test: `server/test/chains.test.js`

**Interfaces:**
- Consumes: `shared/providers.js` → `CLOUD`, `shared/modes.js` → `instruction`, `settings.get`.
- Produces:
  - `stt.js` → `transcribe(providerId, {audio: Buffer, filename: string, language?: string}): Promise<{text: string, seconds: number, model: string}>`
  - `llm.js` → `improve(providerId, {text: string, mode: string}): Promise<{text: string, tokensIn: number, tokensOut: number, model: string}>`
  - `chains.js` → `sttChain(): string[]`, `llmChain(): string[]`, `runStt(payload): Promise<{...,provider}>`, `runLlm(payload): Promise<{...,provider}>`, `AllFailed` (класс ошибки)

- [ ] **Шаг 1: Написать падающий тест**

`server/test/chains.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

test('упал первый — отвечает второй', async () => {
  const chains = require('../src/providers/chains');
  const calls = [];
  const attempt = async (id) => {
    calls.push(id);
    if (id === 'openai') throw new Error('503');
    return { text: 'готово', model: 'whisper-large-v3-turbo' };
  };

  const result = await chains.run(['openai', 'aitunnel'], attempt);
  assert.deepStrictEqual(calls, ['openai', 'aitunnel']);
  assert.strictEqual(result.provider, 'aitunnel');
  assert.strictEqual(result.text, 'готово');
});

test('молчат все — говорим об этом честно', async () => {
  const chains = require('../src/providers/chains');
  const attempt = async () => { throw new Error('503'); };
  await assert.rejects(
    () => chains.run(['openai', 'aitunnel'], attempt),
    (error) => error instanceof chains.AllFailed && /связи/i.test(error.message),
  );
});

test('в цепочку распознавания DeepSeek не попадает', () => {
  const chains = require('../src/providers/chains');
  const settings = require('../src/settings');
  settings.set('chain.stt', ['deepseek', 'aitunnel']);
  assert.deepStrictEqual(chains.sttChain(), ['aitunnel']);
});

test('пустая цепочка — это тоже честная ошибка, а не тишина', async () => {
  const chains = require('../src/providers/chains');
  await assert.rejects(
    () => chains.run([], async () => ({})),
    (error) => error instanceof chains.AllFailed,
  );
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `cd server && node --test test/chains.test.js`
Expected: FAIL — `Cannot find module '../src/providers/chains'`

- [ ] **Шаг 3: Написать `server/src/providers/chains.js`**

```js
'use strict';

const { CLOUD } = require('../../../shared/providers');
const settings = require('../settings');

/**
 * Перебор по цепочке: не ответил первый — идём ко второму.
 *
 * Отдельный модуль, потому что цепочек две — распознавание и улучшение, —
 * и правило перебора у них одно, а списки провайдеров разные.
 */

class AllFailed extends Error {
  constructor(what, causes) {
    super(`Связи с ${what} нет`);
    this.name = 'AllFailed';
    this.causes = causes;
  }
}

async function run(providerIds, attempt, what = 'облаком') {
  const causes = [];
  for (const id of providerIds) {
    try {
      const result = await attempt(id);
      return { ...result, provider: id };
    } catch (error) {
      causes.push(`${id}: ${error.message}`);
    }
  }
  throw new AllFailed(what, causes);
}

function sttChain() {
  const saved = settings.get('chain.stt', ['aitunnel']);
  // DeepSeek и подобные попадают сюда только по недосмотру: распознавания
  // речи у них нет, и молча оставить их в списке значит подарить владельцу
  // аварийку, которая не работает.
  return saved.filter((id) => CLOUD[id]?.stt === true);
}

function llmChain() {
  const saved = settings.get('chain.llm', ['deepseek']);
  return saved.filter((id) => Boolean(CLOUD[id]));
}

module.exports = { run, sttChain, llmChain, AllFailed };
```

Путь `../../../shared/providers` считается от `server/src/providers/` — три уровня вверх до корня репозитория.

- [ ] **Шаг 4: Написать `server/src/providers/stt.js`**

```js
'use strict';

const { CLOUD } = require('../../../shared/providers');
const settings = require('./../settings');

/**
 * Распознавание речи облаком: обычный OpenAI-совместимый
 * /audio/transcriptions. Whisper у всех шлюзов зовётся одинаково, поэтому
 * отдельного кода под каждого провайдера не нужно.
 */

const TIMEOUT_MS = 5 * 60 * 1000;

async function transcribe(providerId, { audio, filename, language }) {
  const preset = CLOUD[providerId];
  if (!preset) throw new Error(`Провайдер ${providerId} неизвестен`);

  const baseUrl = settings.get(`url.${providerId}`, preset.baseUrl);
  const key = settings.get(`key.${providerId}`, '');
  if (preset.needsKey && !key) throw new Error(`Для ${preset.title} не задан ключ`);
  const model = settings.get(`model.stt.${providerId}`, preset.defaultSttModel || 'whisper-1');

  const form = new FormData();
  form.set('file', new Blob([audio]), filename || 'voice.ogg');
  form.set('model', model);
  if (language) form.set('language', language);
  form.set('response_format', 'verbose_json');

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${preset.title} ответил ${response.status}`);
  }
  const data = await response.json();
  return {
    text: (data.text || '').trim(),
    seconds: Number(data.duration || 0),
    model,
  };
}

module.exports = { transcribe };
```

- [ ] **Шаг 5: Написать `server/src/providers/llm.js`**

```js
'use strict';

const { CLOUD } = require('../../../shared/providers');
const { instruction } = require('../../../shared/modes');
const settings = require('./../settings');

/**
 * Улучшение текста облаком. Думать модели запрещаем явно: рассуждающие
 * модели на простой вычитке уходят в размышления на десятки секунд, и это
 * уже измерялось при работе над десктопной версией.
 */

const TIMEOUT_MS = 3 * 60 * 1000;
const NO_THINKING = { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'none' };

async function ask(url, key, body) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function improve(providerId, { text, mode }) {
  const preset = CLOUD[providerId];
  if (!preset) throw new Error(`Провайдер ${providerId} неизвестен`);

  const baseUrl = settings.get(`url.${providerId}`, preset.baseUrl);
  const key = settings.get(`key.${providerId}`, '');
  if (preset.needsKey && !key) throw new Error(`Для ${preset.title} не задан ключ`);
  const model = settings.get(`model.llm.${providerId}`, preset.defaultModel || '');

  const base = {
    model,
    messages: [
      { role: 'system', content: instruction(mode) },
      { role: 'user', content: text },
    ],
    temperature: 0.3,
  };

  let response = await ask(`${baseUrl}/chat/completions`, key, { ...base, ...NO_THINKING });
  // Не все шлюзы знают эти поля и отвечают на них 400. Тогда повторяем без них.
  if (response.status === 400) {
    response = await ask(`${baseUrl}/chat/completions`, key, base);
  }
  if (!response.ok) throw new Error(`${preset.title} ответил ${response.status}`);

  const data = await response.json();
  const out = (data.choices?.[0]?.message?.content || '').trim();
  if (!out) throw new Error(`${preset.title} вернул пустой ответ`);
  return {
    text: out,
    tokensIn: data.usage?.prompt_tokens || 0,
    tokensOut: data.usage?.completion_tokens || 0,
    model,
  };
}

module.exports = { improve };
```

- [ ] **Шаг 6: Убедиться, что тесты проходят**

Run: `cd server && node --test test/chains.test.js`
Expected: PASS, четыре теста

- [ ] **Шаг 7: Коммит**

```bash
git add server/src/providers/ server/test/chains.test.js
git commit -m "Облачные провайдеры и перебор по цепочке"
```

---

### Task 6: Соединение с домашним компьютером

**Files:**
- Create: `server/src/agent/socket.js`
- Modify: `server/src/index.js` — подключить `@fastify/websocket` и маршрут `/agent`
- Test: `server/test/socket.test.js`

**Interfaces:**
- Consumes: `keys.activate`, `keys.authenticate`, `db.open()`.
- Produces: `agent/socket.js` →
  - `register(app: FastifyInstance): void`
  - `online(): boolean`
  - `send(job: {kind: 'stt'|'llm', payload: object}): Promise<object>`
  - `state(): { online: boolean, name: string|null, lastSeen: number|null, jobsDone: number }`
  - `PING_MS: 20000`, `DEAD_MS: 60000`

- [ ] **Шаг 1: Написать падающий тест**

`server/test/socket.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

test('без агента отправка задачи сразу говорит, что ПК не на связи', async () => {
  const socket = require('../src/agent/socket');
  assert.strictEqual(socket.online(), false);
  await assert.rejects(
    () => socket.send({ kind: 'stt', payload: {} }),
    /не на связи/i,
  );
});

test('состояние без агента читается и не падает', () => {
  const socket = require('../src/agent/socket');
  const state = socket.state();
  assert.strictEqual(state.online, false);
  assert.strictEqual(state.name, null);
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `cd server && node --test test/socket.test.js`
Expected: FAIL — `Cannot find module '../src/agent/socket'`

- [ ] **Шаг 3: Написать `server/src/agent/socket.js`**

```js
'use strict';

const crypto = require('node:crypto');

const db = require('../db');

/**
 * Соединение с домашним компьютером.
 *
 * Звонит всегда он: обратное направление требовало бы проброса порта на
 * каждом домашнем роутере, постоянного IP и открытого наружу порта с
 * распознаванием. Здесь наружу не торчит ничего, а признак «на связи»
 * получается сам собой — сокет жив или мёртв.
 *
 * Агент один: это домашний компьютер владельца, а не ферма.
 */

const PING_MS = 20 * 1000;
const DEAD_MS = 60 * 1000;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

let live = null;              // { socket, name, lastSeen, agentId }
const waiting = new Map();    // id задачи → { resolve, reject, timer }

function online() {
  return Boolean(live) && Date.now() - live.lastSeen < DEAD_MS;
}

function state() {
  const row = db.open().prepare('SELECT * FROM agents ORDER BY last_seen DESC LIMIT 1').get();
  return {
    online: online(),
    name: live?.name || row?.name || null,
    lastSeen: live?.lastSeen || row?.last_seen || null,
    jobsDone: row?.jobs_done || 0,
  };
}

function drop(reason) {
  for (const [, pending] of waiting) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  waiting.clear();
  live = null;
}

function send(job) {
  if (!online()) return Promise.reject(new Error('ПК не на связи'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('ПК не ответил вовремя'));
    }, JOB_TIMEOUT_MS);
    waiting.set(id, { resolve, reject, timer });
    live.socket.send(JSON.stringify({ type: 'job', id, ...job }));
  });
}

function handle(socket, message) {
  let data;
  try { data = JSON.parse(message); } catch { return; }

  if (data.type === 'hello') {
    const now = Date.now();
    const database = db.open();
    const existing = database.prepare('SELECT id FROM agents WHERE name = ?').get(data.name || 'ПК');
    const agentId = existing
      ? existing.id
      : Number(database.prepare('INSERT INTO agents (name, paired_at, last_seen) VALUES (?, ?, ?)')
        .run(data.name || 'ПК', now, now).lastInsertRowid);
    live = { socket, name: data.name || 'ПК', lastSeen: now, agentId };
    socket.send(JSON.stringify({ type: 'welcome' }));
    return;
  }

  if (!live) return;
  live.lastSeen = Date.now();

  if (data.type === 'pong') return;

  if (data.type === 'result' || data.type === 'error') {
    const pending = waiting.get(data.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    waiting.delete(data.id);
    if (data.type === 'error') {
      pending.reject(new Error(data.message || 'ПК не смог обработать'));
      return;
    }
    db.open().prepare('UPDATE agents SET jobs_done = jobs_done + 1, last_seen = ? WHERE id = ?')
      .run(Date.now(), live.agentId);
    pending.resolve(data.result);
  }
}

function register(app) {
  app.get('/agent', { websocket: true }, (socket) => {
    const ping = setInterval(() => {
      if (live && Date.now() - live.lastSeen > DEAD_MS) {
        drop('ПК перестал отвечать');
        try { socket.close(); } catch { /* уже закрыт */ }
        return;
      }
      try { socket.send(JSON.stringify({ type: 'ping' })); } catch { /* закрывается */ }
    }, PING_MS);

    socket.on('message', (raw) => handle(socket, raw.toString()));
    socket.on('close', () => {
      clearInterval(ping);
      if (live?.socket === socket) drop('ПК отключился');
    });
  });
}

module.exports = { register, online, send, state, PING_MS, DEAD_MS };
```

- [ ] **Шаг 4: Подключить в `server/src/index.js`**

Заменить тело `build()` на:

```js
function build(options = {}) {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024, ...options });

  app.register(require('@fastify/websocket'));
  app.register(async (scope) => {
    require('./agent/socket').register(scope);
  });

  app.get('/health', async () => ({ ok: true }));

  return app;
}
```

- [ ] **Шаг 5: Убедиться, что тесты проходят**

Run: `cd server && node --test test/socket.test.js test/smoke.test.js`
Expected: PASS

- [ ] **Шаг 6: Коммит**

```bash
git add server/src/agent/socket.js server/src/index.js server/test/socket.test.js
git commit -m "Соединение с домашним компьютером по WebSocket"
```

---

### Task 7: Очередь и уход в облако

**Files:**
- Create: `server/src/agent/queue.js`
- Test: `server/test/queue.test.js`

**Interfaces:**
- Consumes: `agent/socket.js` → `online`, `send`; `providers/chains.js` → `run`, `sttChain`, `llmChain`; `providers/stt.js`, `providers/llm.js`.
- Produces: `agent/queue.js` →
  - `transcribe({audio, filename, language}): Promise<{text, seconds, executedBy, provider?, model?}>`
  - `improve({text, mode}): Promise<{text, tokensIn, tokensOut, executedBy, provider?, model?}>`
  - `SPILL_MS: 30000`

- [ ] **Шаг 1: Написать падающий тест**

`server/test/queue.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

test('две задачи к агенту идут по одной, а не разом', async () => {
  const queue = require('../src/agent/queue');
  let inFlight = 0;
  let maxSeen = 0;
  const fake = async () => {
    inFlight += 1;
    maxSeen = Math.max(maxSeen, inFlight);
    await new Promise((done) => setTimeout(done, 20));
    inFlight -= 1;
    return { text: 'ок', seconds: 1 };
  };

  await Promise.all([queue.throughAgent(fake), queue.throughAgent(fake)]);
  assert.strictEqual(maxSeen, 1);
});

test('ждать дольше предела нельзя — уходим в облако', async () => {
  const queue = require('../src/agent/queue');
  const slow = () => new Promise((done) => setTimeout(done, 60));
  const spilled = await queue.withSpill(slow, async () => 'облако', 10);
  assert.strictEqual(spilled, 'облако');
});

test('успел вовремя — облако не трогаем', async () => {
  const queue = require('../src/agent/queue');
  let cloudCalled = false;
  const quick = async () => 'агент';
  const result = await queue.withSpill(quick, async () => { cloudCalled = true; return 'облако'; }, 50);
  assert.strictEqual(result, 'агент');
  assert.strictEqual(cloudCalled, false);
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `cd server && node --test test/queue.test.js`
Expected: FAIL — `Cannot find module '../src/agent/queue'`

- [ ] **Шаг 3: Написать `server/src/agent/queue.js`**

```js
'use strict';

const socket = require('./socket');
const chains = require('../providers/chains');
const stt = require('../providers/stt');
const llm = require('../providers/llm');
const settings = require('../settings');

/**
 * Кому отдать задачу.
 *
 * Компьютер держит одну модель в видеопамяти, поэтому берёт диктовки по
 * одной. Если очередь к нему растянулась, задача уходит в облако: копейки
 * дешевле, чем человек, сидящий перед пустым экраном.
 */

const SPILL_MS = 30 * 1000;

let tail = Promise.resolve();

/** Поставить задачу в хвост очереди к агенту. */
function throughAgent(job) {
  const mine = tail.then(job, job);
  // Хвост не должен обрываться из-за одной упавшей задачи.
  tail = mine.then(() => {}, () => {});
  return mine;
}

/** Дождаться агента, но не дольше предела — иначе взять облако. */
function withSpill(agentJob, cloudJob, ms = SPILL_MS) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cloudJob().then(resolve, reject);
    }, ms);

    agentJob().then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cloudJob().then(resolve, reject);
      },
    );
  });
}

function spillAllowed() {
  return settings.get('spillToCloud', true) !== false;
}

async function transcribe({ audio, filename, language }) {
  const cloud = async () => {
    const result = await chains.run(
      chains.sttChain(),
      (id) => stt.transcribe(id, { audio, filename, language }),
      'распознаванием',
    );
    return { ...result, executedBy: 'cloud' };
  };

  if (!socket.online()) return cloud();

  const agent = () => throughAgent(async () => {
    const result = await socket.send({
      kind: 'stt',
      payload: { audio: audio.toString('base64'), filename, language },
    });
    return { ...result, executedBy: 'agent' };
  });

  return spillAllowed() ? withSpill(agent, cloud) : agent().catch(cloud);
}

async function improve({ text, mode }) {
  const cloud = async () => {
    const result = await chains.run(
      chains.llmChain(),
      (id) => llm.improve(id, { text, mode }),
      'улучшением текста',
    );
    return { ...result, executedBy: 'cloud' };
  };

  if (!socket.online()) return cloud();

  const agent = () => throughAgent(async () => {
    const result = await socket.send({ kind: 'llm', payload: { text, mode } });
    return { ...result, executedBy: 'agent' };
  });

  return spillAllowed() ? withSpill(agent, cloud) : agent().catch(cloud);
}

module.exports = { transcribe, improve, throughAgent, withSpill, SPILL_MS };
```

- [ ] **Шаг 4: Убедиться, что тесты проходят**

Run: `cd server && node --test test/queue.test.js`
Expected: PASS, три теста

- [ ] **Шаг 5: Коммит**

```bash
git add server/src/agent/queue.js server/test/queue.test.js
git commit -m "Очередь к агенту и уход в облако по таймауту"
```

---

### Task 8: Клиентский интерфейс

**Files:**
- Create: `server/src/routes/client.js`
- Modify: `server/src/index.js` — подключить маршруты
- Test: `server/test/client.test.js`

**Interfaces:**
- Consumes: `keys.activate`, `keys.authenticate`, `agent/queue.js`, `usage.record`, `agent/socket.state`.
- Produces: `routes/client.js` → `register(app: FastifyInstance): void`; маршруты `POST /v1/activate`, `POST /v1/transcribe`, `POST /v1/improve`, `GET /v1/state`.

- [ ] **Шаг 1: Написать падающий тест**

`server/test/client.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

test('без токена распознавание не пускает', async () => {
  const { build } = require('../src/index');
  const app = build();
  const reply = await app.inject({
    method: 'POST', url: '/v1/transcribe', payload: { audio: 'AAAA' },
  });
  assert.strictEqual(reply.statusCode, 401);
  await app.close();
});

test('код меняется на токен, отозванный ключ — на отказ', async () => {
  const { build } = require('../src/index');
  const keys = require('../src/keys');
  const app = build();
  const key = keys.issue('Мама');

  const ok = await app.inject({
    method: 'POST', url: '/v1/activate',
    payload: { code: key.code, kind: 'android', title: 'Redmi' },
  });
  assert.strictEqual(ok.statusCode, 200);
  const token = ok.json().token;
  assert.ok(token);

  keys.revoke(key.id);
  const after = await app.inject({
    method: 'POST', url: '/v1/transcribe',
    headers: { authorization: `Bearer ${token}` },
    payload: { audio: 'AAAA' },
  });
  assert.strictEqual(after.statusCode, 401);
  assert.match(after.json().error, /отозван/i);
  await app.close();
});

test('состояние показывает, на связи ли ПК', async () => {
  const { build } = require('../src/index');
  const app = build();
  const reply = await app.inject({ method: 'GET', url: '/v1/state' });
  assert.strictEqual(reply.statusCode, 200);
  assert.strictEqual(reply.json().agentOnline, false);
  await app.close();
});

test('улучшение принимает текст от клиента — в базе его нет', async () => {
  const { build } = require('../src/index');
  const keys = require('../src/keys');
  const app = build();
  const key = keys.issue('Мама');
  const { token } = keys.activate(key.code, 'android', null, 'Redmi', '1.1.1.1');

  const reply = await app.inject({
    method: 'POST', url: '/v1/improve',
    headers: { authorization: `Bearer ${token}` },
    payload: { mode: 'clean' },
  });
  assert.strictEqual(reply.statusCode, 400);
  assert.match(reply.json().error, /текст/i);
  await app.close();
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `cd server && node --test test/client.test.js`
Expected: FAIL — маршрутов нет, ответ 404

- [ ] **Шаг 3: Написать `server/src/routes/client.js`**

```js
'use strict';

const keys = require('../keys');
const queue = require('../agent/queue');
const usage = require('../usage');
const socket = require('../agent/socket');

/**
 * Всё, что видят телефон и бот.
 *
 * Улучшение принимает текст от клиента, а не достаёт из базы, — потому что
 * в базе его нет и не будет. Распознанный текст доходит до человека до
 * улучшения: отвалится ИИ, а пользоваться уже есть чем.
 */

function source(request) {
  return request.headers['x-forwarded-for']?.split(',')[0].trim() || request.ip;
}

function who(request) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return keys.authenticate(token);
}

function register(app) {
  app.post('/v1/activate', async (request, reply) => {
    const { code, kind, externalId = null, title = '' } = request.body || {};
    if (!['telegram', 'android'].includes(kind)) {
      return reply.code(400).send({ error: 'Неизвестный вид устройства' });
    }
    try {
      const result = keys.activate(code, kind, externalId, title, source(request));
      return { token: result.token };
    } catch (error) {
      return reply.code(403).send({ error: error.message });
    }
  });

  app.get('/v1/state', async () => {
    const agent = socket.state();
    return { ok: true, agentOnline: agent.online, agentName: agent.name };
  });

  app.post('/v1/transcribe', async (request, reply) => {
    const device = who(request);
    if (!device) return reply.code(401).send({ error: 'Доступ отозван или токен неверный' });

    const { audio, filename = 'voice.ogg', language = null } = request.body || {};
    if (!audio) return reply.code(400).send({ error: 'Не приложен звук' });

    try {
      const result = await queue.transcribe({
        audio: Buffer.from(audio, 'base64'), filename, language,
      });
      usage.record({
        keyId: device.keyId,
        deviceKind: device.kind,
        audioSeconds: result.seconds || 0,
        executedBy: result.executedBy,
        sttProvider: result.provider || null,
        sttModel: result.model || null,
      });
      return { text: result.text, seconds: result.seconds || 0, where: result.executedBy };
    } catch (error) {
      return reply.code(502).send({ error: error.message });
    }
  });

  app.post('/v1/improve', async (request, reply) => {
    const device = who(request);
    if (!device) return reply.code(401).send({ error: 'Доступ отозван или токен неверный' });

    const { text, mode = 'clean' } = request.body || {};
    if (!text || !String(text).trim()) {
      return reply.code(400).send({ error: 'Не передан текст для улучшения' });
    }

    try {
      const result = await queue.improve({ text: String(text), mode });
      usage.record({
        keyId: device.keyId,
        deviceKind: device.kind,
        audioSeconds: 0,
        executedBy: result.executedBy,
        llmProvider: result.provider || null,
        llmModel: result.model || null,
        tokensIn: result.tokensIn || 0,
        tokensOut: result.tokensOut || 0,
      });
      return { text: result.text, where: result.executedBy };
    } catch (error) {
      return reply.code(502).send({ error: error.message });
    }
  });
}

module.exports = { register };
```

- [ ] **Шаг 4: Подключить маршруты в `server/src/index.js`**

Добавить в `build()` перед `return app`:

```js
  require('./routes/client').register(app);
```

- [ ] **Шаг 5: Убедиться, что тесты проходят**

Run: `cd server && node --test`
Expected: PASS — все тесты всех задач

- [ ] **Шаг 6: Коммит**

```bash
git add server/src/routes/client.js server/src/index.js server/test/client.test.js
git commit -m "Клиентский интерфейс: активация, распознавание, улучшение"
```

---

### Task 9: Вход в админку

**Files:**
- Create: `server/src/admin/auth.js`
- Test: `server/test/auth.test.js`

**Interfaces:**
- Consumes: `settings.get`, `settings.set`.
- Produces: `admin/auth.js` →
  - `check(password: string): boolean`
  - `changed(): boolean`
  - `change(next: string): void`
  - `isLocal(address: string): boolean`
  - `allowed(password: string, address: string): { ok: boolean, mustChange: boolean, error?: string }`

- [ ] **Шаг 1: Написать падающий тест**

`server/test/auth.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

test('пароль по умолчанию admin работает из локальной сети', () => {
  const auth = require('../src/admin/auth');
  const result = auth.allowed('admin', '192.168.2.30');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.mustChange, true);
});

test('пароль по умолчанию снаружи не принимается', () => {
  const auth = require('../src/admin/auth');
  const result = auth.allowed('admin', '188.18.55.140');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /локальной сети/i);
});

test('после смены пароль работает откуда угодно, а admin — нет', () => {
  const auth = require('../src/admin/auth');
  auth.change('корабль-ветер-камень');

  assert.strictEqual(auth.allowed('корабль-ветер-камень', '188.18.55.140').ok, true);
  assert.strictEqual(auth.allowed('корабль-ветер-камень', '188.18.55.140').mustChange, false);
  assert.strictEqual(auth.allowed('admin', '192.168.2.30').ok, false);
});

test('локальными считаются только частные диапазоны', () => {
  const auth = require('../src/admin/auth');
  assert.strictEqual(auth.isLocal('192.168.3.8'), true);
  assert.strictEqual(auth.isLocal('10.0.0.5'), true);
  assert.strictEqual(auth.isLocal('172.16.4.1'), true);
  assert.strictEqual(auth.isLocal('172.32.4.1'), false);
  assert.strictEqual(auth.isLocal('127.0.0.1'), true);
  assert.strictEqual(auth.isLocal('188.18.55.140'), false);
});

test('пароль в базе лежит хэшем, а не текстом', () => {
  const auth = require('../src/admin/auth');
  auth.change('корабль-ветер-камень');
  const row = db.open().prepare("SELECT value FROM settings WHERE key = 'admin.password'").get();
  assert.ok(!row.value.includes('корабль'));
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `cd server && node --test test/auth.test.js`
Expected: FAIL — `Cannot find module '../src/admin/auth'`

- [ ] **Шаг 3: Написать `server/src/admin/auth.js`**

```js
'use strict';

const crypto = require('node:crypto');

const settings = require('./../settings');

/**
 * Вход в админку.
 *
 * Пароль по умолчанию admin — так попросил владелец, и менять это решение
 * нельзя. Но панель висит на публичном адресе и держит токен бота, ключи
 * провайдеров и выдачу доступов, а зайти владелец может и через неделю
 * после запуска. Поэтому до первой смены пароль admin принимается только
 * из домашней сети: окно, в котором пароль знают все, закрыто снаружи.
 */

const DEFAULT = 'admin';

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function changed() {
  return Boolean(settings.get('admin.password', null));
}

function change(next) {
  const password = String(next || '').trim();
  if (password.length < 8) throw new Error('Пароль короче восьми знаков');
  if (password === DEFAULT) throw new Error('Этот пароль и так знают все');
  const salt = crypto.randomBytes(16).toString('hex');
  settings.set('admin.password', `${salt}:${hash(password, salt)}`);
}

function check(password) {
  const saved = settings.get('admin.password', null);
  if (!saved) return String(password) === DEFAULT;
  const [salt, digest] = String(saved).split(':');
  const given = Buffer.from(hash(String(password), salt), 'hex');
  const known = Buffer.from(digest, 'hex');
  return given.length === known.length && crypto.timingSafeEqual(given, known);
}

function isLocal(address) {
  const ip = String(address || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  // 172.16.0.0 — 172.31.255.255, но не 172.32.x и не 172.15.x.
  const match = /^172\.(\d+)\./.exec(ip);
  if (match) {
    const second = Number(match[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

function allowed(password, address) {
  if (!check(password)) return { ok: false, mustChange: false, error: 'Пароль不 подходит' };
  if (!changed()) {
    if (!isLocal(address)) {
      return {
        ok: false,
        mustChange: true,
        error: 'Пароль ещё не менялся — первый вход возможен только из локальной сети',
      };
    }
    return { ok: true, mustChange: true };
  }
  return { ok: true, mustChange: false };
}

module.exports = { check, changed, change, isLocal, allowed, DEFAULT };
```

- [ ] **Шаг 4: Исправить опечатку**

В `allowed()` строка `'Пароль不 подходит'` содержит посторонний иероглиф. Заменить на `'Пароль не подходит'`.

- [ ] **Шаг 5: Убедиться, что тесты проходят**

Run: `cd server && node --test test/auth.test.js`
Expected: PASS, пять тестов

- [ ] **Шаг 6: Коммит**

```bash
git add server/src/admin/auth.js server/test/auth.test.js
git commit -m "Вход в админку с принудительной сменой пароля"
```

---

### Task 10: Экраны админки

**Files:**
- Create: `server/src/routes/admin.js`
- Create: `server/src/admin/pages/index.html`
- Modify: `server/src/index.js` — подключить маршруты админки
- Test: `server/test/admin.test.js`

**Interfaces:**
- Consumes: `admin/auth.js`, `keys.js`, `usage.js`, `settings.js`, `prices.js`, `agent/socket.state`.
- Produces: `routes/admin.js` → `register(app): void`; маршруты `POST /admin/login`, `POST /admin/password`, `GET /admin/api/people`, `POST /admin/api/keys`, `DELETE /admin/api/keys/:id`, `DELETE /admin/api/devices/:id`, `GET /admin/api/spend`, `GET /admin/api/agent`, `GET|POST /admin/api/settings`, `GET /admin/`.

- [ ] **Шаг 1: Написать падающий тест**

`server/test/admin.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

async function login(app, password = 'admin', address = '192.168.2.30') {
  const reply = await app.inject({
    method: 'POST', url: '/admin/login',
    headers: { 'x-forwarded-for': address },
    payload: { password },
  });
  return reply;
}

test('без входа списки не отдаются', async () => {
  const { build } = require('../src/index');
  const app = build();
  const reply = await app.inject({ method: 'GET', url: '/admin/api/people' });
  assert.strictEqual(reply.statusCode, 401);
  await app.close();
});

test('первый вход из локальной сети требует сменить пароль', async () => {
  const { build } = require('../src/index');
  const app = build();
  const reply = await login(app);
  assert.strictEqual(reply.statusCode, 200);
  assert.strictEqual(reply.json().mustChange, true);
  await app.close();
});

test('ключ заводится с именем и удаляется', async () => {
  const { build } = require('../src/index');
  const app = build();
  const session = (await login(app)).json().session;
  const headers = { 'x-admin-session': session };

  const made = await app.inject({
    method: 'POST', url: '/admin/api/keys', headers, payload: { name: 'Мама' },
  });
  assert.strictEqual(made.statusCode, 200);
  assert.match(made.json().code, /^\d{6}$/);

  const people = await app.inject({ method: 'GET', url: '/admin/api/people', headers });
  assert.strictEqual(people.json().people[0].name, 'Мама');

  const gone = await app.inject({
    method: 'DELETE', url: `/admin/api/keys/${made.json().id}`, headers,
  });
  assert.strictEqual(gone.statusCode, 200);
  await app.close();
});

test('расход подписан как оценка по своему прайсу', async () => {
  const { build } = require('../src/index');
  const app = build();
  const session = (await login(app)).json().session;
  const spend = await app.inject({
    method: 'GET', url: '/admin/api/spend', headers: { 'x-admin-session': session },
  });
  assert.match(spend.json().note, /оценка/i);
  await app.close();
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Run: `cd server && node --test test/admin.test.js`
Expected: FAIL — маршруты отсутствуют, ответ 404

- [ ] **Шаг 3: Написать `server/src/routes/admin.js`**

```js
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const auth = require('../admin/auth');
const keys = require('../keys');
const usage = require('../usage');
const settings = require('../settings');
const prices = require('../prices');
const socket = require('../agent/socket');

/**
 * Админка: четыре экрана и ничего лишнего.
 *
 * Сессии держим в памяти. Перезапуск сервера выкидывает владельца из
 * панели — это не беда, зато нечего красть с диска.
 */

const sessions = new Map();
const SESSION_MS = 12 * 60 * 60 * 1000;

function source(request) {
  return request.headers['x-forwarded-for']?.split(',')[0].trim() || request.ip;
}

function guard(request, reply) {
  const id = request.headers['x-admin-session'];
  const session = sessions.get(id);
  if (!session || session.until < Date.now()) {
    reply.code(401).send({ error: 'Нужно войти заново' });
    return null;
  }
  return session;
}

function register(app) {
  app.post('/admin/login', async (request, reply) => {
    const { password } = request.body || {};
    const verdict = auth.allowed(password, source(request));
    if (!verdict.ok) return reply.code(403).send({ error: verdict.error });

    const id = crypto.randomBytes(24).toString('base64url');
    sessions.set(id, { until: Date.now() + SESSION_MS });
    return { session: id, mustChange: verdict.mustChange };
  });

  app.post('/admin/password', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    try {
      auth.change((request.body || {}).password);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.get('/admin/api/people', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    const spend = new Map(usage.perKey().map((row) => [row.key_id, row]));
    return {
      people: keys.list().map((key) => ({
        id: key.id,
        name: key.name,
        code: key.code,
        revoked: Boolean(key.revoked_at),
        minutes: spend.get(key.id)?.minutes || 0,
        rub: spend.get(key.id)?.rub || 0,
        devices: key.devices.map((device) => ({
          id: device.id, kind: device.kind, title: device.title, lastSeen: device.last_seen,
        })),
      })),
    };
  });

  app.post('/admin/api/keys', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    return keys.issue((request.body || {}).name);
  });

  app.delete('/admin/api/keys/:id', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    return { ok: keys.revoke(Number(request.params.id)) };
  });

  app.delete('/admin/api/devices/:id', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    return { ok: keys.unbind(Number(request.params.id)) };
  });

  // Запасной путь, когда человек потерял код: владелец вписывает его номер
  // в телеграме руками. Номер человек берёт командой /id в самом боте.
  app.post('/admin/api/keys/:id/bind', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    const { externalId, title = '' } = request.body || {};
    if (!externalId) return reply.code(400).send({ error: 'Не указан номер в телеграме' });
    try {
      keys.bind(Number(request.params.id), 'telegram', externalId, title);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.get('/admin/api/spend', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    return {
      ...usage.monthly(),
      note: 'Оценка по своему прайсу: провайдеры фактическую стоимость не присылают',
    };
  });

  app.get('/admin/api/agent', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    return socket.state();
  });

  app.get('/admin/api/settings', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    return { settings: settings.all(), prices: prices.table() };
  });

  app.post('/admin/api/settings', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    const body = request.body || {};
    for (const [key, value] of Object.entries(body.settings || {})) {
      // Звёздочки означают «не трогали» — иначе сохранение формы стёрло бы ключ.
      if (value === '***') continue;
      settings.set(key, value);
    }
    if (body.prices) prices.setTable(body.prices);
    return { ok: true };
  });

  app.get('/admin/', async (request, reply) => {
    const file = path.join(__dirname, '..', 'admin', 'pages', 'index.html');
    reply.type('text/html; charset=utf-8');
    return fs.readFileSync(file, 'utf8');
  });
}

module.exports = { register };
```

- [ ] **Шаг 4: Создать страницу админки**

`server/src/admin/pages/index.html`:

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PasteTalk — админка</title>
<style>
/* Всё в rem: страницу читает человек со слабым зрением, и увеличение
   шрифта в браузере обязано растягивать вёрстку целиком, а не рвать её. */
:root { color-scheme: light dark; --pad: 1rem; }
* { box-sizing: border-box; }
body { margin: 0; font: 1rem/1.5 system-ui, sans-serif; padding: var(--pad); max-width: 60rem; }
h1 { font-size: 1.5rem; margin: 0 0 1rem; }
nav { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
nav button { font: inherit; padding: 0.5rem 1rem; border: 1px solid currentColor;
  border-radius: 0.5rem; background: transparent; color: inherit; cursor: pointer; }
nav button[aria-selected="true"] { background: currentColor; }
nav button[aria-selected="true"] span { filter: invert(1); }
.card { border: 1px solid; border-radius: 0.75rem; padding: var(--pad); margin-bottom: 1rem; }
.page { display: none; }
.page.on { display: block; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid; vertical-align: top; }
input { font: inherit; padding: 0.4rem; width: 100%; max-width: 22rem; }
button.act { font: inherit; padding: 0.4rem 0.75rem; cursor: pointer; }
.note { opacity: 0.75; font-size: 0.875rem; }
.err { color: #c0392b; font-weight: bold; }
.wrap { overflow-x: auto; }
</style>
</head>
<body>

<div id="gate">
  <h1>PasteTalk</h1>
  <div class="card">
    <p><label>Пароль <input type="password" id="pass" autocomplete="current-password"></label></p>
    <p><button class="act" id="enter">Войти</button></p>
    <p class="err" id="gate-err"></p>
  </div>
</div>

<div id="change" hidden>
  <h1>Смените пароль</h1>
  <div class="card">
    <p class="note">Пока пароль не сменён, панель работает только из домашней сети.</p>
    <p><label>Новый пароль <input type="password" id="pass2" autocomplete="new-password"></label></p>
    <p><button class="act" id="save-pass">Сохранить</button></p>
    <p class="err" id="change-err"></p>
  </div>
</div>

<main id="app" hidden>
  <h1>PasteTalk</h1>
  <nav>
    <button data-tab="people" aria-selected="true"><span>Люди</span></button>
    <button data-tab="spend" aria-selected="false"><span>Расход</span></button>
    <button data-tab="agent" aria-selected="false"><span>ПК</span></button>
    <button data-tab="settings" aria-selected="false"><span>Настройки</span></button>
  </nav>

  <section class="page on" data-page="people">
    <div class="card">
      <label>Имя нового ключа <input id="new-name" placeholder="Мама"></label>
      <p><button class="act" id="make-key">Выдать код</button></p>
      <p id="made"></p>
    </div>
    <div class="card wrap"><table id="people"></table></div>
  </section>

  <section class="page" data-page="spend">
    <div class="card" id="spend"></div>
  </section>

  <section class="page" data-page="agent">
    <div class="card" id="agent"></div>
  </section>

  <section class="page" data-page="settings">
    <div class="card" id="settings"></div>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
let session = sessionStorage.getItem('pastetalk-admin') || '';

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Session': session, ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Сервер ответил ${response.status}`);
  return data;
}

$('enter').addEventListener('click', async () => {
  $('gate-err').textContent = '';
  try {
    const data = await api('/admin/login', {
      method: 'POST', body: JSON.stringify({ password: $('pass').value }),
    });
    session = data.session;
    sessionStorage.setItem('pastetalk-admin', session);
    $('gate').hidden = true;
    if (data.mustChange) $('change').hidden = false;
    else { $('app').hidden = false; refresh(); }
  } catch (error) {
    $('gate-err').textContent = error.message;
  }
});

$('save-pass').addEventListener('click', async () => {
  $('change-err').textContent = '';
  try {
    await api('/admin/password', { method: 'POST', body: JSON.stringify({ password: $('pass2').value }) });
    $('change').hidden = true;
    $('app').hidden = false;
    refresh();
  } catch (error) {
    $('change-err').textContent = error.message;
  }
});

document.querySelectorAll('nav button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-selected', String(b === button)));
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('on', p.dataset.page === button.dataset.tab));
    refresh();
  });
});

$('make-key').addEventListener('click', async () => {
  const key = await api('/admin/api/keys', { method: 'POST', body: JSON.stringify({ name: $('new-name').value }) });
  $('made').textContent = `Код для «${key.name}»: ${key.code}`;
  $('new-name').value = '';
  refresh();
});

function when(ms) {
  return ms ? new Date(ms).toLocaleString('ru') : '—';
}

async function drawPeople() {
  const { people } = await api('/admin/api/people');
  const rows = people.map((person) => `
    <tr>
      <td>${person.name}${person.revoked ? ' <span class="note">(отозван)</span>' : ''}</td>
      <td>${person.code}</td>
      <td>${person.minutes} мин</td>
      <td>${person.rub} ₽</td>
      <td>${person.devices.map((d) =>
        `${d.kind === 'telegram' ? 'Telegram' : 'Android'}: ${d.title || '—'}
         <button class="act" data-device="${d.id}">убрать</button>`).join('<br>') || '—'}</td>
      <td><button class="act" data-key="${person.id}">удалить</button></td>
    </tr>`).join('');
  $('people').innerHTML = `<tr><th>Имя</th><th>Код</th><th>За месяц</th><th>Расход</th><th>Устройства</th><th></th></tr>${rows}`;

  $('people').querySelectorAll('[data-key]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/admin/api/keys/${button.dataset.key}`, { method: 'DELETE' });
      drawPeople();
    });
  });
  $('people').querySelectorAll('[data-device]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/admin/api/devices/${button.dataset.device}`, { method: 'DELETE' });
      drawPeople();
    });
  });
}

async function drawSpend() {
  const data = await api('/admin/api/spend');
  $('spend').innerHTML = `
    <p>Через свой компьютер: <strong>${data.agentMinutes} мин</strong> — бесплатно</p>
    <p>Через облако: <strong>${data.cloudMinutes} мин</strong> на <strong>${data.rub} ₽</strong></p>
    <p class="note">${data.note}</p>
    <div class="wrap"><table>
      <tr><th>Модель</th><th>Рублей</th><th>Обращений</th></tr>
      ${data.byModel.map((m) => `<tr><td>${m.model}</td><td>${m.rub}</td><td>${m.count}</td></tr>`).join('')}
    </table></div>`;
}

async function drawAgent() {
  const data = await api('/admin/api/agent');
  $('agent').innerHTML = `
    <p>${data.online ? 'На связи' : 'Не на связи'}${data.name ? ` — ${data.name}` : ''}</p>
    <p class="note">Последний отклик: ${when(data.lastSeen)}. Задач сделано: ${data.jobsDone}</p>`;
}

async function drawSettings() {
  const data = await api('/admin/api/settings');
  $('settings').innerHTML = `
    <p class="note">Введённые ключи обратно не показываются — вместо них звёздочки. Пустое поле оставляет ключ как был.</p>
    <p><label>Ключ AITunnel <input data-set="key.aitunnel" value="${data.settings['key.aitunnel'] || ''}"></label></p>
    <p><label>Ключ OpenAI <input data-set="key.openai" value="${data.settings['key.openai'] || ''}"></label></p>
    <p><label>Ключ DeepSeek <input data-set="key.deepseek" value="${data.settings['key.deepseek'] || ''}"></label></p>
    <p><label>Цепочка распознавания <input data-set="chain.stt" value="${(data.settings['chain.stt'] || ['aitunnel']).join(',')}"></label></p>
    <p><label>Цепочка улучшения <input data-set="chain.llm" value="${(data.settings['chain.llm'] || ['deepseek']).join(',')}"></label></p>
    <p><label>Прайс-лист (JSON) <input data-set="prices" value='${JSON.stringify(data.prices)}'></label></p>
    <p><button class="act" id="save-settings">Сохранить</button></p>`;

  $('save-settings').addEventListener('click', async () => {
    const body = { settings: {}, prices: null };
    document.querySelectorAll('[data-set]').forEach((field) => {
      const key = field.dataset.set;
      if (key === 'prices') { body.prices = JSON.parse(field.value); return; }
      if (key.startsWith('chain.')) { body.settings[key] = field.value.split(',').map((s) => s.trim()).filter(Boolean); return; }
      body.settings[key] = field.value;
    });
    await api('/admin/api/settings', { method: 'POST', body: JSON.stringify(body) });
    drawSettings();
  });
}

function refresh() {
  const active = document.querySelector('nav button[aria-selected="true"]').dataset.tab;
  const draw = { people: drawPeople, spend: drawSpend, agent: drawAgent, settings: drawSettings }[active];
  draw().catch((error) => { $('gate-err').textContent = error.message; });
}

if (session) {
  $('gate').hidden = true;
  $('app').hidden = false;
  refresh();
}
</script>
</body>
</html>
```

- [ ] **Шаг 5: Подключить в `server/src/index.js`**

Добавить в `build()` перед `return app`:

```js
  require('./routes/admin').register(app);
```

- [ ] **Шаг 6: Убедиться, что тесты проходят**

Run: `cd server && node --test`
Expected: PASS — все тесты

- [ ] **Шаг 7: Проверить админку живьём при 150 % шрифта**

```bash
cd server && npm start
```

Открыть `http://localhost:3000/admin/`, войти паролем `admin`, сменить пароль, завести ключ «Мама». В инструменте разработчика поставить `document.documentElement.style.fontSize = '150%'` и убедиться, что ничего не наезжает и не обрезается.

- [ ] **Шаг 8: Коммит**

```bash
git add server/src/routes/admin.js server/src/admin/pages/ server/src/index.js server/test/admin.test.js
git commit -m "Админка: люди, расход, ПК, настройки"
```

---

### Task 11: Локальный агент в десктопном приложении

**Files:**
- Create: `app/main/relay.js`
- Modify: `package.json` — добавить зависимость `ws`
- Modify: `app/renderer/settings/index.html` — раздел «Интеграция» (кнопка навигации и страница)
- Modify: `app/renderer/settings/index.js` — обработчики раздела
- Modify: `app/main/index.js` — запуск `relay` при старте
- Modify: `app/main/config.js` — значения по умолчанию для `relay.*`

**Interfaces:**
- Consumes: `engine.js` (распознавание файла), `llm.js` → `improve`, `config.js`, `logger.js`.
- Produces: `app/main/relay.js` →
  - `connect(): void`, `disconnect(): void`, `state(): { status: 'off'|'connecting'|'online'|'error', hint: string }`
  - события `EventEmitter`: `'state'`

- [ ] **Шаг 1: Добавить зависимость**

В `package.json` в `dependencies` добавить `"ws": "^8.18.0"`.

Electron 33 работает на Node 20.18, где глобального `WebSocket` ещё нет, поэтому нужен пакет.

Правку `package.json` делать **инструментом Write, а не PowerShell**: `Set-Content -Encoding UTF8` дописывает BOM, и `package.json` перестаёт быть корректным JSON. На этом проекте сборка уже дважды падала по этой причине.

Затем: `npm install`

- [ ] **Шаг 2: Добавить значения по умолчанию в `app/main/config.js`**

В объект `DEFAULTS` рядом с блоком `engine` (строка 78) добавить:

```js
  relay: {
    // Выключено по умолчанию: связь с чужим сервером человек включает
    // сам и осознанно, а не обнаруживает включённой после обновления.
    enabled: false,
    url: '',
    token: '',
    name: '',
  },
```

- [ ] **Шаг 3: Написать `app/main/relay.js`**

```js
'use strict';

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const config = require('./config');
const engine = require('./engine');
const llm = require('./llm');
const log = require('./logger').scoped('relay');

/**
 * Связь с сервером PasteTalk.
 *
 * Звоним всегда мы: сервер не знает, где стоит этот компьютер, и знать не
 * должен. Ни портов пробрасывать, ни IP держать постоянным не требуется —
 * достаточно исходящего соединения, которое умеет пережить обрыв.
 */

const RETRY_MS = [2000, 5000, 15000, 30000, 60000];

class Relay extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.status = 'off';
    this.hint = '';
    this.attempt = 0;
    this.timer = null;
  }

  state() {
    return { status: this.status, hint: this.hint };
  }

  setState(status, hint = '') {
    this.status = status;
    this.hint = hint;
    this.emit('state', this.state());
  }

  connect() {
    if (!config.get('relay.enabled', false)) return;
    const url = config.get('relay.url', '');
    const token = config.get('relay.token', '');
    if (!url || !token) {
      this.setState('error', 'Не задан адрес сервера или код не введён');
      return;
    }

    clearTimeout(this.timer);
    this.setState('connecting');
    const socket = new WebSocket(`${url.replace(/\/$/, '')}/agent`);
    this.socket = socket;

    socket.on('open', () => {
      this.attempt = 0;
      socket.send(JSON.stringify({
        type: 'hello',
        token,
        name: config.get('relay.name', require('node:os').hostname()),
      }));
      this.setState('online');
      log.info('соединение с сервером установлено');
    });

    socket.on('message', (raw) => this.handle(raw.toString()));
    socket.on('error', (error) => {
      this.setState('error', error.message);
      log.warn(`связь с сервером: ${error.message}`);
    });
    socket.on('close', () => {
      if (this.status !== 'off') this.retry();
    });
  }

  retry() {
    const wait = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.attempt += 1;
    this.setState('connecting', `Переподключение через ${Math.round(wait / 1000)} с`);
    this.timer = setTimeout(() => this.connect(), wait);
  }

  disconnect() {
    clearTimeout(this.timer);
    this.setState('off');
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      try { socket.close(); } catch { /* уже закрыт */ }
    }
  }

  async handle(raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'ping') {
      this.socket?.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (data.type !== 'job') return;

    try {
      const result = data.kind === 'stt'
        ? await this.doStt(data.payload)
        : await this.doLlm(data.payload);
      this.socket?.send(JSON.stringify({ type: 'result', id: data.id, result }));
    } catch (error) {
      this.socket?.send(JSON.stringify({ type: 'error', id: data.id, message: error.message }));
    }
  }

  async doStt(payload) {
    const audio = Buffer.from(payload.audio, 'base64');
    const result = await engine.transcribeBuffer(audio, {
      filename: payload.filename,
      language: payload.language,
    });
    return { text: result.text, seconds: result.durationS, model: result.model };
  }

  async doLlm(payload) {
    // llm.improve(text, overrides) — второй аргумент подмешивается поверх
    // сохранённых настроек, см. resolve() в llm.js:158. Так режим приходит
    // с телефона, а провайдер и ключ берутся здешние.
    const text = await llm.improve(payload.text, { mode: payload.mode });
    // Токены посчитать неоткуда: llm.improve возвращает только текст.
    // Ноль здесь честнее выдуманного числа — своя модель и так бесплатна.
    return { text, tokensIn: 0, tokensOut: 0, model: config.get('ai.model', '') };
  }
}

module.exports = new Relay();
```

- [ ] **Шаг 4: Добавить `engine.transcribeBuffer`**

В `app/main/engine.js` рядом с `startFile` (строка 269) добавить метод, который пишет полученный буфер во временный файл и прогоняет его существующим файловым заданием. Новый путь распознавания заводить не надо — файловые задания уже умеют всё нужное.

Готового `waitFile` в `engine.js` нет: есть `startFile(options)` и `fileStatus(id)`, а ожидание крутится в renderer. Поэтому опрос пишем здесь.

```js
  /**
   * Распознать звук, пришедший в памяти.
   *
   * Движок принимает только путь к файлу, поэтому буфер кладём во временный
   * и сразу убираем: чужой звук на диске не залёживается — обещали не
   * хранить, значит не храним.
   */
  async transcribeBuffer(buffer, { filename = 'voice.ogg', language = null } = {}) {
    const os = require('node:os');
    const fsp = require('node:fs/promises');
    const safe = filename.replace(/[^\w.-]/g, '_');
    const temp = path.join(os.tmpdir(), `pastetalk-${Date.now()}-${safe}`);
    await fsp.writeFile(temp, buffer);
    try {
      const job = await this.startFile({ path: temp, language, timestamps: false });
      for (;;) {
        const state = await this.fileStatus(job.id);
        if (state.state === 'done') {
          return { text: state.text || '', durationS: state.durationS || 0, model: state.model || '' };
        }
        if (state.state === 'error') throw new Error(state.error || 'Движок не справился');
        await new Promise((wait) => setTimeout(wait, 500));
      }
    } finally {
      await fsp.rm(temp, { force: true });
    }
  }
```

- [ ] **Шаг 5: Добавить раздел «Интеграция» в настройки**

В `app/renderer/settings/index.html`:

Кнопку навигации добавить после `data-goto="ai"` (строка 48):

```html
      <button class="nav-item" data-goto="relay">
        <span>Интеграция</span>
      </button>
```

Страницу добавить после секции `data-page="ai"`:

```html
      <section class="page" data-page="relay">
        <h2>Интеграция</h2>
        <p class="lede">Позволяет диктовать с телефона и из Telegram, пользуясь этим компьютером. Соединение устанавливает сам компьютер — ничего пробрасывать на роутере не нужно.</p>

        <div class="card">
          <div class="row">
            <div class="row-label">
              <span>Работать как агент сервера</span>
              <small>Пока выключено, телефон и бот будут пользоваться облаком</small>
            </div>
            <div class="row-control">
              <input type="checkbox" id="relay-enabled" data-cfg="relay.enabled">
            </div>
          </div>

          <div class="row">
            <div class="row-label">
              <span>Адрес сервера</span>
              <small>Например, wss://appswire.ru</small>
            </div>
            <div class="row-control">
              <input type="text" id="relay-url" data-cfg="relay.url" placeholder="wss://appswire.ru">
            </div>
          </div>

          <div class="row">
            <div class="row-label">
              <span>Код доступа</span>
              <small>Шесть цифр из админки. Вводится один раз</small>
            </div>
            <div class="row-control">
              <input type="text" id="relay-code" inputmode="numeric" maxlength="6" placeholder="000000">
              <button class="btn" id="relay-pair">Привязать</button>
            </div>
          </div>

          <div class="row">
            <div class="row-label">
              <span>Состояние</span>
            </div>
            <div class="row-control">
              <span id="relay-state">Выключено</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="row">
            <div class="row-label">
              <span>Локальный доступ для своих программ</span>
              <small>Другие программы на этом компьютере могут пользоваться распознаванием по адресу ниже. Наружу порт не открыт</small>
            </div>
            <div class="row-control">
              <span id="relay-local">localhost:—</span>
            </div>
          </div>
        </div>
      </section>
```

- [ ] **Шаг 6: Обработчики раздела**

В `app/preload/settings.js` (мосты окна настроек лежат там, не в корне `app/`) добавить:

```js
  relay: {
    pair: (code) => ipcRenderer.invoke('relay:pair', code),
    state: () => ipcRenderer.invoke('relay:state'),
    onState: (fn) => ipcRenderer.on('relay:state', (_event, state) => fn(state)),
  },
```

В `app/main/index.js` рядом с остальными `ipcMain.handle`:

```js
const relay = require('./relay');

ipcMain.handle('relay:state', () => ({
  ...relay.state(),
  // Порт движка человек уже настраивает в «Основных»; здесь его только
  // показываем, чтобы было что вписать в свою программу.
  enginePort: config.get('engine.port', 0),
}));

ipcMain.handle('relay:pair', async (_event, code) => {
  const url = config.get('relay.url', '').replace(/\/$/, '');
  if (!url) return { ok: false, error: 'Сначала укажите адрес сервера' };
  const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  try {
    const response = await fetch(`${httpUrl}/v1/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, kind: 'android', title: require('node:os').hostname() }),
    });
    const data = await response.json();
    if (!response.ok) return { ok: false, error: data.error || `Сервер ответил ${response.status}` };
    config.set('relay.token', data.token);
    relay.disconnect();
    relay.connect();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

relay.on('state', (state) => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('relay:state', state);
});
```

В `app/renderer/settings/index.js` в конце файла:

```js
// ---------- Интеграция ----------

const RELAY_WORDS = {
  off: 'Выключено',
  connecting: 'Подключаюсь…',
  online: 'На связи с сервером',
  error: 'Не подключилось',
};

function showRelay(state) {
  const where = $('relay-state');
  if (!where) return;
  where.textContent = state.hint
    ? `${RELAY_WORDS[state.status] || state.status} — ${state.hint}`
    : (RELAY_WORDS[state.status] || state.status);
  const local = $('relay-local');
  if (local) {
    local.textContent = state.enginePort
      ? `localhost:${state.enginePort}`
      : 'localhost — движок ещё не запущен';
  }
}

$('relay-pair')?.addEventListener('click', async () => {
  const field = $('relay-code');
  const button = $('relay-pair');
  button.disabled = true;
  const result = await api.relay.pair(field.value.trim());
  button.disabled = false;
  if (result.ok) {
    field.value = '';
    $('relay-state').textContent = 'Код принят, подключаюсь…';
  } else {
    $('relay-state').textContent = result.error;
  }
});

api.relay.onState(showRelay);
api.relay.state().then(showRelay);
```

Обращения через `?.` не случайны: модуль настроек умирает целиком от одной ошибки на уровне модуля, и обработчик, ссылающийся на отсутствующий элемент, уже однажды убивал на этом проекте всё окно настроек.

- [ ] **Шаг 7: Проверить, что настройки не сломались**

Запустить `npm run dev`, открыть настройки, перейти в «Интеграция».

Модуль настроек умирает целиком от одной ошибки на уровне модуля — на этом проекте так уже случалось, когда обработчик ссылался на удалённую кнопку. Поэтому проверить в консоли окна, что ошибок нет и остальные разделы продолжают открываться.

- [ ] **Шаг 8: Проверить при 150 % масштаба**

В настройках выставить масштаб интерфейса 150 % и убедиться, что раздел «Интеграция» не разъезжается: поле кода и кнопка «Привязать» должны оставаться на одной строке или честно переноситься, не наезжая друг на друга.

- [ ] **Шаг 9: Коммит**

```bash
git add app/main/relay.js app/main/engine.js app/main/index.js app/preload.js app/renderer/settings/ package.json package-lock.json
git commit -m "Раздел «Интеграция»: компьютер как агент сервера"
```

---

### Task 12: Развёртывание

**Files:**
- Create: `server/Dockerfile`
- Create: `server/.dockerignore`
- Create: `server/README.md`
- Modify: `.gitignore` — исключить `server/data/`

**Interfaces:**
- Consumes: всё предыдущее.
- Produces: образ, разворачиваемый Coolify из подпапки `server/`.

- [ ] **Шаг 1: Написать `server/Dockerfile`**

Собирается из корня репозитория, потому что `shared/` лежит выше `server/`.

```dockerfile
FROM node:22-slim

# better-sqlite3 собирается из исходников — нужен компилятор.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY shared/ ./shared/
COPY server/src/ ./server/src/

ENV NODE_ENV=production
ENV PASTETALK_DB=/data/pastetalk.db
VOLUME /data
EXPOSE 3000

CMD ["node", "server/src/index.js"]
```

- [ ] **Шаг 2: Написать `server/.dockerignore`**

```
node_modules
data
test
```

- [ ] **Шаг 3: Собрать и проверить образ**

```bash
docker build -f server/Dockerfile -t pastetalk-server .
docker run --rm -p 3000:3000 -v pastetalk-data:/data pastetalk-server
```

Проверить: `curl http://localhost:3000/health` → `{"ok":true}`

- [ ] **Шаг 4: Написать `server/README.md`**

Содержание: что это, как развернуть в Coolify (Base Directory `/`, Dockerfile `server/Dockerfile`, том на `/data`, порт 3000), какой пароль при первом входе и почему он работает только из локальной сети, как завести первый ключ, как подключить домашний компьютер.

Отдельным разделом — что сервер **не** хранит: ни звука, ни текста.

- [ ] **Шаг 5: Исключить базу из репозитория**

В `.gitignore` добавить:

```
server/data/
server/node_modules/
```

- [ ] **Шаг 6: Прогнать все тесты**

Run: `cd server && node --test`
Expected: PASS — все тесты всех задач

- [ ] **Шаг 7: Коммит**

```bash
git add server/Dockerfile server/.dockerignore server/README.md .gitignore
git commit -m "Развёртывание сервера через Docker и Coolify"
```

---

## Что остаётся непроверенным после этого плана

Записать честно, а не умолчать:

- **Живая связка с настоящим сервером.** Тесты гоняют Fastify через `inject`, без сети. Первое реальное развёртывание в Coolify — отдельная проверка руками.
- **Облачные провайдеры.** Их ответы в тестах не подделываются и не вызываются: это стоило бы денег на каждом прогоне. Проверяются вручную один раз, после ввода ключей в админке.
- **Обрыв связи посреди задачи.** Проверен только на уровне очереди; поведение при настоящем разрыве Wi-Fi проверяется руками.
- **Страница админки.** Тестами покрыт её интерфейс данных, но не вёрстка. Проверка при 150 % шрифта — шагом 7 задачи 10, руками.

## Следующие части

Бот, лендинг, Android и свои ключи пользователя получат свои замыслы и планы. К этому плану они не относятся.
