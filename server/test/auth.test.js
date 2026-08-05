'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const auth = require('../src/admin/auth');

test.beforeEach(() => { db.close(); db.open(':memory:'); auth.forgetMisses(); });

test('свободная панель никого не пускает: пароля ещё нет', async () => {
  assert.strictEqual(auth.changed(), false);
  assert.strictEqual((await auth.allowed('admin', '192.168.2.30')).ok, false);
  assert.strictEqual((await auth.allowed('', '192.168.2.30')).ok, false);
  assert.strictEqual(await auth.check('admin'), false);
});

test('первый введённый пароль становится настоящим', async () => {
  await auth.claim('korabl-veter-kamen');
  assert.strictEqual(auth.changed(), true);
  // Откуда угодно, а не только из домашней сети.
  assert.strictEqual((await auth.allowed('korabl-veter-kamen', '188.18.55.140')).ok, true);
});

test('занятую панель второй раз не занять', async () => {
  await auth.claim('korabl-veter-kamen');
  await assert.rejects(() => auth.claim('chuzhoy-parol-drugoy'), /уже занята/i);
  assert.strictEqual(await auth.check('chuzhoy-parol-drugoy'), false);
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

test('слишком короткий пароль не принимается', async () => {
  await assert.rejects(() => auth.change('корот'), new RegExp(`короче ${auth.MIN_LENGTH}`));
  await assert.rejects(() => auth.claim('коротк'), new RegExp(`короче ${auth.MIN_LENGTH}`));
  // Панель после отказа осталась свободной.
  assert.strictEqual(auth.changed(), false);
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

test('одновременные попытки не проскакивают мимо счётчика', async () => {
  await auth.change('корабль-ветер-камень');
  // Полсотни разом: раньше синхронный scrypt их выстраивал, а с
  // асинхронным они все проходили гейт до записи первого промаха.
  const wave = await Promise.all(
    Array.from({ length: 50 }, () => auth.allowed('мимо', '203.0.113.9')),
  );
  const locked = wave.filter((r) => /подожд/i.test(r.error || '')).length;
  assert.ok(locked >= 40, `лимитом отбито ${locked} из 50`);
});
