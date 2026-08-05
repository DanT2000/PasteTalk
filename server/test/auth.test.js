'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const auth = require('../src/admin/auth');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

test('пароль по умолчанию admin работает из локальной сети', () => {
  const result = auth.allowed('admin', '192.168.2.30');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.mustChange, true);
});

test('пароль по умолчанию снаружи не принимается', () => {
  const result = auth.allowed('admin', '188.18.55.140');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /локальной сети/i);
});

test('после смены пароль работает откуда угодно, а admin — нет', () => {
  auth.change('корабль-ветер-камень');

  assert.strictEqual(auth.allowed('корабль-ветер-камень', '188.18.55.140').ok, true);
  assert.strictEqual(auth.allowed('корабль-ветер-камень', '188.18.55.140').mustChange, false);
  assert.strictEqual(auth.allowed('admin', '192.168.2.30').ok, false);
});

test('неверный пароль не проходит и из локальной сети', () => {
  const result = auth.allowed('не-admin', '192.168.2.30');
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

test('короткий пароль и повтор admin отвергаются', () => {
  assert.throws(() => auth.change('корот'), new RegExp(`короче ${auth.MIN_LENGTH}`));
  assert.throws(() => auth.change('admin'), /знают все/i);
});

test('пароль в базе лежит хэшем, а не текстом', () => {
  auth.change('корабль-ветер-камень');
  const row = db.open().prepare("SELECT value FROM settings WHERE key = 'admin.password'").get();
  assert.ok(!row.value.includes('корабль'));
  assert.ok(row.value.includes(':'));
});

test('пароль можно сменить второй раз', () => {
  auth.change('корабль-ветер-камень');
  auth.change('другой-длинный-пароль');
  assert.strictEqual(auth.check('другой-длинный-пароль'), true);
  assert.strictEqual(auth.check('корабль-ветер-камень'), false);
});
