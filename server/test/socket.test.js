'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const keys = require('../src/keys');
const socket = require('../src/agent/socket');

test.beforeEach(() => { db.close(); db.open(':memory:'); keys.forgetMisses(); socket.forget(); });

/** Агент без токена сервером не признаётся, поэтому заводим настоящий. */
function agentToken() {
  const key = keys.issue('Домашний ПК');
  return keys.activate(key.code, 'desktop', null, 'ДОМ-ПК', '1.1.1.1').token;
}

function hello(name = 'ДОМ-ПК') {
  return JSON.stringify({ type: 'hello', name, token: agentToken() });
}

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

  socket.handle(fake, hello());

  assert.strictEqual(socket.online(), true);
  assert.strictEqual(socket.state().name, 'ДОМ-ПК');
  assert.strictEqual(sent[0].type, 'welcome');
  assert.strictEqual(db.open().prepare('SELECT COUNT(*) AS n FROM agents').get().n, 1);
});

test('задача уходит агенту и её ответ возвращается вызвавшему', async () => {
  const sent = [];
  const fake = { send: (raw) => sent.push(JSON.parse(raw)) };
  socket.handle(fake, hello());

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
  socket.handle(fake, hello());

  const promise = socket.send({ kind: 'llm', payload: {} });
  const job = sent.find((message) => message.type === 'job');
  socket.handle(fake, JSON.stringify({ type: 'error', id: job.id, message: 'модель не загружена' }));

  await assert.rejects(() => promise, /модель не загружена/);
});

test('обрыв посреди задачи не оставляет вызвавшего висеть навсегда', async () => {
  const fake = { send: () => {} };
  socket.handle(fake, hello());

  const promise = socket.send({ kind: 'stt', payload: {} });
  socket.drop('ПК отключился');

  await assert.rejects(() => promise, /отключился/);
  assert.strictEqual(socket.online(), false);
});

test('чужой без токена агентом не становится', () => {
  const sent = [];
  const fake = { send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };

  socket.handle(fake, JSON.stringify({ type: 'hello', name: 'ЧУЖОЙ' }));
  assert.strictEqual(socket.online(), false, 'без токена — не агент');
  assert.strictEqual(sent[0].type, 'denied');

  socket.handle(fake, JSON.stringify({ type: 'hello', name: 'ЧУЖОЙ', token: 'выдуманный' }));
  assert.strictEqual(socket.online(), false);
});

test('переподключение отпускает задачи прежнего сокета', async () => {
  const first = { send: () => {}, close: () => {} };
  socket.handle(first, hello());
  const pending = socket.send({ kind: 'stt', payload: {} });

  // Сеть моргнула: ПК пришёл новым сокетом раньше, чем сервер увидел close.
  const second = { send: () => {}, close: () => {} };
  socket.handle(second, hello());

  await assert.rejects(() => pending, /переподключ/i);
  assert.strictEqual(socket.online(), true);
});

test('мусор вместо json не роняет сервер', () => {
  const fake = { send: () => {}, close: () => {} };
  assert.doesNotThrow(() => socket.handle(fake, 'это не json'));
  assert.doesNotThrow(() => socket.handle(fake, JSON.stringify({ type: 'что-то своё' })));
});

test('ответ на неизвестную задачу тихо отбрасывается', () => {
  const fake = { send: () => {} };
  socket.handle(fake, hello());
  assert.doesNotThrow(() => {
    socket.handle(fake, JSON.stringify({ type: 'result', id: 'нет такой', result: {} }));
  });
});

test('телефон агентом не становится, даже со своим токеном', () => {
  const sent = [];
  const fake = { send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
  const key = keys.issue('Мама');
  const phone = keys.activate(key.code, 'android', null, 'Redmi', '1.1.1.1');

  socket.handle(fake, JSON.stringify({ type: 'hello', name: 'ЧУЖОЙ', token: phone.token }));

  assert.strictEqual(socket.online(), false, 'иначе телефон получал бы чужие диктовки звуком');
  assert.strictEqual(sent[0].type, 'denied');
});

test('чужой сокет не освежает жизнь настоящего агента', () => {
  const real = { send: () => {}, close: () => {} };
  socket.handle(real, hello());
  const was = socket.state().lastSeen;

  const stranger = { send: () => {}, close: () => {} };
  socket.handle(stranger, JSON.stringify({ type: 'pong' }));

  assert.strictEqual(socket.state().lastSeen, was, 'мусор от постороннего не продлевает связь');
});
