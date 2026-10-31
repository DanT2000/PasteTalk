'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const settings = require('../src/settings');
const socket = require('../src/agent/socket');
const probe = require('../src/providers/probe');
const telegram = require('../src/bot/telegram');
const watch = require('../src/watch');

const MINUTE = 60 * 1000;
let sent = [];
const realOnline = socket.online;
const realCheck = probe.check;
const realModels = probe.models;
const realMake = telegram.makeTelegram;
const realHealth = telegram.health;

test.beforeEach(() => {
  telegram.health = realHealth;
  db.close();
  db.open(':memory:');
  settings.set('bot.token', 'test-token');
  settings.set('alerts.chat', '42');
  settings.set('chain.stt', ['aitunnel']);
  settings.set('chain.llm', ['aitunnel']);
  sent = [];
  watch.stop();
  telegram.makeTelegram = () => ({ sendMessage: async (chat, text) => { sent.push(`${chat}: ${text}`); } });
});

test.after(() => {
  socket.online = realOnline;
  probe.check = realCheck;
  probe.models = realModels;
  telegram.makeTelegram = realMake;
  telegram.health = realHealth;
  watch.stop();
});

/** Канал, который можно уронить: сообщения сторожа идут через того же бота. */
function channel() {
  const live = { up: true };
  telegram.makeTelegram = () => ({
    sendMessage: async (chat, text) => {
      if (!live.up) throw new Error('fetch failed');
      sent.push(`${chat}: ${text}`);
    },
  });
  return live;
}

test('всё цело — сторож молчит', async () => {
  socket.online = () => true;
  probe.models = async () => ({ all: 2, stt: ['whisper-large-v3-turbo'], llm: ['deepseek-chat'] });
  await watch.tick({ at: 0 });
  await watch.tick({ at: 30 * MINUTE });
  assert.deepStrictEqual(sent, []);
});

test('ПК пропал ненадолго — молчим, пропал надолго — одно сообщение', async () => {
  socket.online = () => false;
  await watch.tick({ at: 0 });
  await watch.tick({ at: 10 * MINUTE });
  assert.deepStrictEqual(sent, [], 'перезагрузка компьютера не повод писать');

  await watch.tick({ at: 16 * MINUTE });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /Домашний компьютер — не на связи/);

  await watch.tick({ at: 30 * MINUTE });
  assert.strictEqual(sent.length, 1, 'повторно о том же не пишем');
});

test('ПК вернулся — сообщение с тем, сколько его не было', async () => {
  socket.online = () => false;
  await watch.tick({ at: 0 });
  await watch.tick({ at: 20 * MINUTE });
  socket.online = () => true;
  await watch.tick({ at: 80 * MINUTE });
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1], /снова в строю/);
  assert.match(sent[1], /1 ч 20 мин/);
});

test('провайдер: одиночный сбой прощаем, второй подряд — сообщение', async () => {
  socket.online = () => true;
  let bad = true;
  probe.models = async () => {
    if (bad) throw new Error('AITunnel не принял ключ');
    return { all: 2, stt: ['whisper-large-v3-turbo'], llm: ['deepseek-chat'] };
  };

  await watch.tick({ at: 0 });
  assert.deepStrictEqual(sent, [], 'одна пятисотка — не поломка');

  await watch.tick({ at: 15 * MINUTE });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /Облако «aitunnel»/);
  assert.match(sent[0], /не принял ключ/);

  bad = false;
  await watch.tick({ at: 30 * MINUTE });
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1], /снова в строю/);
});

test('429 — не поломка: молчим час, потом говорим и объясняем', async () => {
  socket.online = () => true;
  probe.models = async () => { throw new Error('AITunnel ответил 429'); };

  for (const minutes of [0, 15, 30]) await watch.tick({ at: minutes * MINUTE });
  assert.deepStrictEqual(sent, [], 'всплеск частоты не повод писать');

  await watch.tick({ at: 45 * MINUTE });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /429/);
  assert.match(sent[0], /ограничение частоты, а не поломка/);
});

test('проверяем только тех, кем сервер пользуется', async () => {
  socket.online = () => true;
  settings.set('chain.stt', ['custom']);
  settings.set('chain.llm', []);
  const asked = [];
  probe.models = async (id) => { asked.push(id); return { all: 1, stt: ['whisper'], llm: [] }; };
  await watch.tick({ at: 0 });
  await watch.tick({ at: 15 * MINUTE });
  assert.deepStrictEqual(asked, ['custom'], 'пока всё хорошо — не чаще раза в час');
  assert.deepStrictEqual(sent, [], 'текстовых моделей нет, но текстовая цепочка пуста — не наше дело');
});

test('без номера в настройках ничего не отправляется и ничего не падает', async () => {
  settings.set('alerts.chat', '');
  socket.online = () => false;
  await watch.tick({ at: 0 });
  await watch.tick({ at: 20 * MINUTE });
  assert.deepStrictEqual(sent, []);
});

test('обычная проверка бесплатна, полная — раз в сутки', async () => {
  socket.online = () => true;
  const cheap = [];
  const deep = [];
  probe.models = async (id) => { cheap.push(id); return { all: 2, stt: ['whisper'], llm: ['deepseek-chat'] }; };
  probe.check = async (id) => { deep.push(id); return { stt: { ok: true }, llm: { ok: true } }; };

  const day = 24 * 60 * MINUTE;
  await watch.tick({ at: 10 * MINUTE });
  await watch.tick({ at: 25 * MINUTE });
  assert.deepStrictEqual(deep, [], 'каждые четверть часа платных запросов не делаем');
  assert.strictEqual(cheap.length, 1, 'здоровый провайдер — не чаще раза в час');

  await watch.tick({ at: 75 * MINUTE });
  assert.strictEqual(cheap.length, 2, 'через час — снова бесплатная проверка');

  await watch.tick({ at: day + MINUTE });
  assert.deepStrictEqual(deep, ['aitunnel'], 'раз в сутки — полная проба');
  assert.deepStrictEqual(sent, []);
});

test('бот моргнул — молчим, молчал полчаса — скажем, когда связь вернётся', async () => {
  socket.online = () => true;
  probe.models = async () => ({ all: 2, stt: ['whisper'], llm: ['deepseek-chat'] });
  const live = channel();
  // Опрос перестал удаваться на пятой минуте, и связи с Telegram нет —
  // значит и сторожу сказать некуда.
  live.up = false;
  telegram.health = () => ({ running: true, failingSince: 5 * MINUTE });

  await watch.tick({ at: 10 * MINUTE });
  assert.deepStrictEqual(sent, [], 'пять минут без опроса — моргание, а не поломка');

  await watch.tick({ at: 20 * MINUTE });
  assert.deepStrictEqual(sent, [], 'сказать некому: сторож пишет тем же каналом');

  live.up = true;
  telegram.health = () => ({ running: true, failingSince: 0 });
  await watch.tick({ at: 65 * MINUTE });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /Опрос Telegram — снова в строю/);
  assert.match(sent[0], /1 ч 0 мин/, 'срок считаем от настоящего начала, а не от обхода');
  assert.match(sent[0], /Сказать сразу не вышло/);
});

test('бот выключен — сторож о нём не говорит', async () => {
  socket.online = () => true;
  probe.models = async () => ({ all: 2, stt: ['whisper'], llm: ['deepseek-chat'] });
  telegram.health = () => ({ running: false, failingSince: 0 });
  await watch.tick({ at: 0 });
  await watch.tick({ at: 60 * MINUTE });
  assert.deepStrictEqual(sent, []);
});

test('сообщение не доставилось — повторяем на следующем обходе', async () => {
  socket.online = () => false;
  probe.models = async () => ({ all: 2, stt: ['whisper'], llm: ['deepseek-chat'] });
  const live = channel();
  live.up = false;

  await watch.tick({ at: 0 });
  await watch.tick({ at: 20 * MINUTE });
  assert.deepStrictEqual(sent, [], 'доставить не вышло');

  live.up = true;
  await watch.tick({ at: 25 * MINUTE });
  assert.strictEqual(sent.length, 1, 'сказали, как только стало куда');
  assert.match(sent[0], /Домашний компьютер — не на связи/);

  await watch.tick({ at: 40 * MINUTE });
  assert.strictEqual(sent.length, 1, 'и не повторяем, когда уже сказали');
});
