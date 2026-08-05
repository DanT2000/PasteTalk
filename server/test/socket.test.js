'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const socket = require('../src/agent/socket');

test.beforeEach(() => { db.close(); db.open(':memory:'); socket.forget(); });

test('без агента отправка задачи сразу говорит, что ПК не на связи', async () => {
  assert.strictEqual(socket.online(), false);
  await assert.rejects(() => socket.send({ kind: 'stt', payload: {} }), /не на связи/i);
});

test('состояние без агента читается и не падает', () => {
  const state = socket.state();
  assert.strictEqual(state.online, false);
  assert.strictEqual(state.name, null);
  assert.strictEqual(state.jobsDone, 0);
});

test('поздоровавшийся агент считается живым и попадает в базу', () => {
  const sent = [];
  const fake = { send: (raw) => sent.push(JSON.parse(raw)) };

  socket.handle(fake, JSON.stringify({ type: 'hello', name: 'ДОМ-ПК' }));

  assert.strictEqual(socket.online(), true);
  assert.strictEqual(socket.state().name, 'ДОМ-ПК');
  assert.strictEqual(sent[0].type, 'welcome');
  assert.strictEqual(db.open().prepare('SELECT COUNT(*) AS n FROM agents').get().n, 1);
});

test('задача уходит агенту и её ответ возвращается вызвавшему', async () => {
  const sent = [];
  const fake = { send: (raw) => sent.push(JSON.parse(raw)) };
  socket.handle(fake, JSON.stringify({ type: 'hello', name: 'ДОМ-ПК' }));

  const promise = socket.send({ kind: 'stt', payload: { filename: 'a.ogg' } });
  const job = sent.find((message) => message.type === 'job');
  assert.strictEqual(job.kind, 'stt');

  socket.handle(fake, JSON.stringify({ type: 'result', id: job.id, result: { text: 'привет' } }));
  assert.deepStrictEqual(await promise, { text: 'привет' });
  assert.strictEqual(socket.state().jobsDone, 1);
});

test('ошибка от агента доходит до вызвавшего словами, а не молчанием', async () => {
  const sent = [];
  const fake = { send: (raw) => sent.push(JSON.parse(raw)) };
  socket.handle(fake, JSON.stringify({ type: 'hello', name: 'ДОМ-ПК' }));

  const promise = socket.send({ kind: 'llm', payload: {} });
  const job = sent.find((message) => message.type === 'job');
  socket.handle(fake, JSON.stringify({ type: 'error', id: job.id, message: 'модель не загружена' }));

  await assert.rejects(() => promise, /модель не загружена/);
});

test('обрыв посреди задачи не оставляет вызвавшего висеть навсегда', async () => {
  const fake = { send: () => {} };
  socket.handle(fake, JSON.stringify({ type: 'hello', name: 'ДОМ-ПК' }));

  const promise = socket.send({ kind: 'stt', payload: {} });
  socket.drop('ПК отключился');

  await assert.rejects(() => promise, /отключился/);
  assert.strictEqual(socket.online(), false);
});

test('мусор вместо json не роняет сервер', () => {
  const fake = { send: () => {} };
  assert.doesNotThrow(() => socket.handle(fake, 'это не json'));
  assert.doesNotThrow(() => socket.handle(fake, JSON.stringify({ type: 'что-то своё' })));
});

test('ответ на неизвестную задачу тихо отбрасывается', () => {
  const fake = { send: () => {} };
  socket.handle(fake, JSON.stringify({ type: 'hello', name: 'ДОМ-ПК' }));
  assert.doesNotThrow(() => {
    socket.handle(fake, JSON.stringify({ type: 'result', id: 'нет такой', result: {} }));
  });
});
