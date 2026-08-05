'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const keys = require('../src/keys');
const { build } = require('../src/index');

test.beforeEach(() => { db.close(); db.open(':memory:'); keys.forgetMisses(); });

test('без токена распознавание не пускает', async () => {
  const app = build();
  const reply = await app.inject({
    method: 'POST', url: '/v1/transcribe', payload: { audio: 'AAAA' },
  });
  assert.strictEqual(reply.statusCode, 401);
  await app.close();
});

test('код меняется на токен', async () => {
  const app = build();
  const key = keys.issue('Мама');

  const reply = await app.inject({
    method: 'POST', url: '/v1/activate',
    payload: { code: key.code, kind: 'android', title: 'Redmi' },
  });
  assert.strictEqual(reply.statusCode, 200);
  assert.ok(reply.json().token);
  await app.close();
});

test('неверный код отвечает словами, а не молчанием', async () => {
  const app = build();
  const reply = await app.inject({
    method: 'POST', url: '/v1/activate',
    payload: { code: '000000', kind: 'android' },
  });
  assert.strictEqual(reply.statusCode, 403);
  assert.match(reply.json().error, /кода нет/i);
  await app.close();
});

test('неизвестный вид устройства отвергается', async () => {
  const app = build();
  const key = keys.issue('Мама');
  const reply = await app.inject({
    method: 'POST', url: '/v1/activate',
    payload: { code: key.code, kind: 'холодильник' },
  });
  assert.strictEqual(reply.statusCode, 400);
  await app.close();
});

test('отозванный ключ перестаёт пускать по уже выданному токену', async () => {
  const app = build();
  const key = keys.issue('Мама');
  const { token } = keys.activate(key.code, 'android', null, 'Redmi', '1.1.1.1');

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
  const app = build();
  const reply = await app.inject({ method: 'GET', url: '/v1/state' });
  assert.strictEqual(reply.statusCode, 200);
  assert.strictEqual(reply.json().agentOnline, false);
  await app.close();
});

test('улучшение принимает текст от клиента — в базе его нет', async () => {
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

test('распознавание без звука отвечает понятно', async () => {
  const app = build();
  const key = keys.issue('Мама');
  const { token } = keys.activate(key.code, 'android', null, 'Redmi', '1.1.1.1');

  const reply = await app.inject({
    method: 'POST', url: '/v1/transcribe',
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });
  assert.strictEqual(reply.statusCode, 400);
  assert.match(reply.json().error, /звук/i);
  await app.close();
});

test('когда ни ПК, ни облака нет — говорим об этом прямо', async () => {
  const app = build();
  const key = keys.issue('Мама');
  const { token } = keys.activate(key.code, 'android', null, 'Redmi', '1.1.1.1');
  const settings = require('../src/settings');
  settings.set('chain.stt', []);

  const reply = await app.inject({
    method: 'POST', url: '/v1/transcribe',
    headers: { authorization: `Bearer ${token}` },
    payload: { audio: Buffer.from('звук').toString('base64') },
  });
  assert.strictEqual(reply.statusCode, 502);
  assert.match(reply.json().error, /Связи с распознаванием нет/);
  await app.close();
});

test('неудачная диктовка не пишется в расход', async () => {
  const app = build();
  const usage = require('../src/usage');
  const settings = require('../src/settings');
  const key = keys.issue('Мама');
  const { token } = keys.activate(key.code, 'android', null, 'Redmi', '1.1.1.1');
  settings.set('chain.stt', []);

  await app.inject({
    method: 'POST', url: '/v1/transcribe',
    headers: { authorization: `Bearer ${token}` },
    payload: { audio: Buffer.from('звук').toString('base64') },
  });

  assert.strictEqual(usage.monthly().agentMinutes, 0);
  assert.strictEqual(usage.monthly().rub, 0);
  await app.close();
});
