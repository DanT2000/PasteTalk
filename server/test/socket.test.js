'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const agents = require('../src/agents');
const keys = require('../src/keys');
const socket = require('../src/agent/socket');

test.beforeEach(() => { db.close(); db.open(':memory:'); keys.forgetMisses(); socket.forget(); });

function machine(name = 'ДОМ-ПК') {
  return agents.add(name);
}

function hello(key, name = 'ДОМ-ПК') {
  return JSON.stringify({ type: 'hello', key, name });
}

test('без машин задача сразу говорит, что ПК не на связи', async () => {
  assert.strictEqual(socket.online(), false);
  await assert.rejects(() => socket.send({ kind: 'stt', payload: {} }), /не на связи/i);
});

test('машина с ключом выходит на связь', () => {
  const made = machine();
  const sent = [];
  const fake = { send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };

  socket.handle(fake, hello(made.key));

  assert.strictEqual(socket.online(), true);
  assert.strictEqual(sent[0].type, 'welcome');
  assert.strictEqual(socket.state().agents.find((a) => a.id === made.id).online, true);
});

test('чужой без ключа не проходит', () => {
  const sent = [];
  const fake = { send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };

  socket.handle(fake, JSON.stringify({ type: 'hello', name: 'ЧУЖОЙ' }));
  assert.strictEqual(socket.online(), false);
  assert.strictEqual(sent[0].type, 'denied');

  socket.handle(fake, hello('pt_выдуманный'));
  assert.strictEqual(socket.online(), false);
});

test('код человека машиной не делает', () => {
  const key = keys.issue('Мама');
  const person = keys.activate(key.code, 'android', null, 'Redmi', '1.1.1.1');
  const sent = [];
  const fake = { send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };

  socket.handle(fake, hello(person.token));

  assert.strictEqual(socket.online(), false, 'код на телефон не даёт принимать чужой звук');
  assert.strictEqual(sent[0].type, 'denied');
});

test('задача уходит машине и ответ возвращается', async () => {
  const made = machine();
  const sent = [];
  const fake = { send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
  socket.handle(fake, hello(made.key));

  const promise = socket.send({ kind: 'stt', payload: { filename: 'a.ogg' } });
  const job = sent.find((m) => m.type === 'job');
  socket.handle(fake, JSON.stringify({ type: 'result', id: job.id, result: { text: 'привет' } }));

  assert.deepStrictEqual(await promise, { text: 'привет' });
  assert.strictEqual(agents.list()[0].jobs_done, 1);
});

test('две машины: задача идёт первой по порядку', async () => {
  const one = machine('Первый');
  const two = machine('Второй');
  const gotOne = []; const gotTwo = [];
  const fakeOne = { send: (raw) => gotOne.push(JSON.parse(raw)), close: () => {} };
  const fakeTwo = { send: (raw) => gotTwo.push(JSON.parse(raw)), close: () => {} };
  socket.handle(fakeOne, hello(one.key, 'Первый'));
  socket.handle(fakeTwo, hello(two.key, 'Второй'));

  const promise = socket.send({ kind: 'stt', payload: {} });
  const job = gotOne.find((m) => m.type === 'job');
  assert.ok(job, 'первая по порядку машина получает задачу');
  assert.strictEqual(gotTwo.filter((m) => m.type === 'job').length, 0);

  socket.handle(fakeOne, JSON.stringify({ type: 'result', id: job.id, result: { ok: 1 } }));
  await promise;
});

test('порядок можно поменять, и первой станет другая', async () => {
  const one = machine('Первый');
  const two = machine('Второй');
  agents.move(two.id, true);

  const gotOne = []; const gotTwo = [];
  socket.handle({ send: (raw) => gotOne.push(JSON.parse(raw)), close: () => {} }, hello(one.key, 'Первый'));
  const fakeTwo = { send: (raw) => gotTwo.push(JSON.parse(raw)), close: () => {} };
  socket.handle(fakeTwo, hello(two.key, 'Второй'));

  const promise = socket.send({ kind: 'stt', payload: {} });
  const job = gotTwo.find((m) => m.type === 'job');
  assert.ok(job, 'после перестановки первым опрашивается бывший второй');
  socket.handle(fakeTwo, JSON.stringify({ type: 'result', id: job.id, result: { ok: 1 } }));
  await promise;
});

test('вторая машина не мешает первой и остаётся на связи', () => {
  const one = machine('Первый');
  const two = machine('Второй');
  socket.handle({ send: () => {}, close: () => {} }, hello(one.key, 'Первый'));
  socket.handle({ send: () => {}, close: () => {} }, hello(two.key, 'Второй'));

  const rows = socket.state().agents;
  assert.strictEqual(rows.filter((a) => a.online).length, 2);
});

test('переподключение той же машины отпускает её задачи', async () => {
  const made = machine();
  const first = { send: () => {}, close: () => {} };
  socket.handle(first, hello(made.key));
  const pending = socket.send({ kind: 'stt', payload: {} });

  const second = { send: () => {}, close: () => {} };
  socket.handle(second, hello(made.key));

  await assert.rejects(() => pending, /переподключ/i);
  assert.strictEqual(socket.online(), true);
});

test('новый ключ отрезает старый', () => {
  const made = machine();
  socket.handle({ send: () => {}, close: () => {} }, hello(made.key));
  assert.strictEqual(socket.online(), true);

  agents.reissue(made.id);
  socket.dropAgent(made.id, 'ключ перевыпущен');
  assert.strictEqual(socket.online(), false);

  const sent = [];
  socket.handle({ send: (raw) => sent.push(JSON.parse(raw)), close: () => {} }, hello(made.key));
  assert.strictEqual(sent[0].type, 'denied', 'старый ключ больше не подходит');
});

test('удалённая машина слетает с линии при первом же обращении', () => {
  const made = machine();
  socket.handle({ send: () => {}, close: () => {} }, hello(made.key));
  agents.remove(made.id);
  assert.strictEqual(socket.online(), false);
});

test('мусор не роняет сервер', () => {
  const fake = { send: () => {}, close: () => {} };
  assert.doesNotThrow(() => socket.handle(fake, 'это не json'));
  assert.doesNotThrow(() => socket.handle(fake, JSON.stringify({ type: 'что-то' })));
  assert.doesNotThrow(() => socket.handle(fake, JSON.stringify({ type: 'result', id: 'нет' })));
});
