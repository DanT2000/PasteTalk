'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const auth = require('../src/admin/auth');

test.beforeEach(() => { db.close(); db.open(':memory:'); auth.forgetMisses(); });

test('пароль по умолчанию admin работает из локальной сети', async () => {
  const result = await auth.allowed('admin', '192.168.2.30');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.mustChange, true);
});

test('пароль по умолчанию снаружи не принимается', async () => {
  const result = await auth.allowed('admin', '188.18.55.140');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /локальной сети/i);
});

test('после смены пароль работает откуда угодно, а admin — нет', async () => {
  await auth.change('корабль-ветер-камень');

  assert.strictEqual((await auth.allowed('корабль-ветер-камень', '188.18.55.140')).ok, true);
  assert.strictEqual((await auth.allowed('корабль-ветер-камень', '188.18.55.140')).mustChange, false);
  assert.strictEqual((await auth.allowed('admin', '192.168.2.30')).ok, false);
});

test('неверный пароль не проходит и из локальной сети', async () => {
  const result = await auth.allowed('не-admin', '192.168.2.30');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /не подходит/i);
});

test('локальными считаются только частные диапазоны', () => {
  assert.strictEqual(auth.isLocal('192.168.3.8'), true);
  assert.strictEqual(auth.isLocal('10.0.0.5'), true);
  assert.strictEqual(auth.isLocal('172.16.4.1'), true);
  assert.strictEqual(auth.isLocal('172.31.255.255'), true);
  assert.strictEqual(auth.isLocal('172.32.4.1'), false);
  assert.strictEqual(auth.isLocal('172.15.4.1'), false);
  assert.strictEqual(auth.isLocal('127.0.0.1'), true);
  assert.strictEqual(auth.isLocal('::1'), true);
  assert.strictEqual(auth.isLocal('::ffff:192.168.1.5'), true);
  assert.strictEqual(auth.isLocal('188.18.55.140'), false);
  assert.strictEqual(auth.isLocal(''), false);
});

test('короткий пароль и повтор admin отвергаются', async () => {
  await assert.rejects(() => auth.change('корот'), new RegExp(`короче ${auth.MIN_LENGTH}`));
  await assert.rejects(() => auth.change('admin'), /знают все/i);
});

test('пароль в базе лежит хэшем, а не текстом', async () => {
  await auth.change('корабль-ветер-камень');
  const row = db.open().prepare("SELECT value FROM settings WHERE key = 'admin.password'").get();
  assert.ok(!row.value.includes('корабль'));
  assert.ok(row.value.includes(':'));
});

test('пароль можно сменить второй раз', async () => {
  await auth.change('корабль-ветер-камень');
  await auth.change('другой-длинный-пароль');
  assert.strictEqual(await auth.check('другой-длинный-пароль'), true);
  assert.strictEqual(await auth.check('корабль-ветер-камень'), false);
});

test('пароль панели не перебирается без ограничений', async () => {
  await auth.change('корабль-ветер-камень');
  for (let i = 0; i < auth.MAX_TRIES; i += 1) {
    const attempt = await auth.allowed('мимо', '203.0.113.7');
    assert.strictEqual(attempt.ok, false);
  }
  const locked = await auth.allowed('корабль-ветер-камень', '203.0.113.7');
  assert.strictEqual(locked.ok, false, 'после пяти промахов верный пароль тоже ждёт');
  assert.match(locked.error, /подожд/i);

  // Другой адрес не при чём.
  assert.strictEqual((await auth.allowed('корабль-ветер-камень', '192.168.2.30')).ok, true);
});
