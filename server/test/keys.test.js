'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const keys = require('../src/keys');

test.beforeEach(() => { db.close(); db.open(':memory:'); keys.forgetMisses(); });

test('код привязывает и телефон, и телеграм к одному ключу', () => {
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
  keys.issue('Кто-то');
  for (let i = 0; i < keys.MAX_TRIES; i += 1) {
    assert.throws(() => keys.activate('000000', 'android', null, '', '9.9.9.9'), /кода нет/i);
  }
  assert.throws(() => keys.activate('000000', 'android', null, '', '9.9.9.9'), /подожд/i);
});

test('запертый источник не мешает остальным', () => {
  const key = keys.issue('Мама');
  for (let i = 0; i < keys.MAX_TRIES; i += 1) {
    assert.throws(() => keys.activate('000000', 'android', null, '', '9.9.9.9'));
  }
  // Другой адрес не при чём — его запирать не за что.
  assert.ok(keys.activate(key.code, 'android', null, 'Телефон', '1.1.1.1').token);
});

test('отзыв ключа отрезает все его устройства разом', () => {
  const key = keys.issue('Папа');
  const phone = keys.activate(key.code, 'android', null, 'Телефон', '1.1.1.1');
  const tg = keys.activate(key.code, 'telegram', '42', 'Папа', '1.1.1.1');

  assert.ok(keys.revoke(key.id));
  assert.strictEqual(keys.authenticate(phone.token), null);
  assert.strictEqual(keys.authenticate(tg.token), null);
});

test('одно устройство отвязывается, не трогая остальные', () => {
  const key = keys.issue('Мама');
  const phone = keys.activate(key.code, 'android', null, 'Телефон', '1.1.1.1');
  const tg = keys.activate(key.code, 'telegram', '42', 'Мама', '1.1.1.1');

  const deviceId = keys.authenticate(phone.token).deviceId;
  assert.ok(keys.unbind(deviceId));
  assert.strictEqual(keys.authenticate(phone.token), null);
  assert.ok(keys.authenticate(tg.token));
});

test('владелец может привязать телеграм вручную, без кода', () => {
  const key = keys.issue('Мама');
  const bound = keys.bind(key.id, 'telegram', '123456789', 'Мама');

  assert.ok(bound.token);
  assert.strictEqual(keys.authenticate(bound.token).keyId, key.id);
  assert.strictEqual(keys.byExternal('telegram', '123456789').keyId, key.id);
  assert.strictEqual(keys.byExternal('telegram', '999'), null);
});

test('список показывает ключ вместе с его устройствами', () => {
  const key = keys.issue('Мама');
  keys.activate(key.code, 'android', null, 'Redmi', '1.1.1.1');

  const all = keys.list();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].name, 'Мама');
  assert.strictEqual(all[0].devices.length, 1);
  assert.strictEqual(all[0].devices[0].title, 'Redmi');
});

test('токен в базе не хранится в открытом виде', () => {
  const key = keys.issue('Мама');
  const phone = keys.activate(key.code, 'android', null, 'Телефон', '1.1.1.1');
  const rows = db.open().prepare('SELECT token_hash FROM devices').all();
  assert.ok(rows.every((row) => !row.token_hash.includes(phone.token)));
});

test('отозванный ключ по коду больше не активируется', () => {
  const key = keys.issue('Мама');
  keys.revoke(key.id);
  assert.throws(() => keys.activate(key.code, 'android', null, '', '1.1.1.1'), /кода нет/i);
});
