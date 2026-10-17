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
const realMake = telegram.makeTelegram;

test.beforeEach(() => {
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
  telegram.makeTelegram = realMake;
  watch.stop();
});

test('всё цело — сторож молчит', async () => {
  socket.online = () => true;
  probe.check = async () => ({ stt: { ok: true }, llm: { ok: true } });
  await watch.tick({ probeNow: true, at: 0 });
  await watch.tick({ probeNow: true, at: 30 * MINUTE });
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
  probe.check = async () => ({
    stt: bad ? { ok: false, error: 'ключ не принят' } : { ok: true },
    llm: { ok: true },
  });

  await watch.tick({ probeNow: true, at: 0 });
  assert.deepStrictEqual(sent, [], 'одна пятисотка — не поломка');

  await watch.tick({ probeNow: true, at: 15 * MINUTE });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /Облако «aitunnel»/);
  assert.match(sent[0], /распознавание: ключ не принят/);

  bad = false;
  await watch.tick({ probeNow: true, at: 30 * MINUTE });
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1], /снова в строю/);
});

test('проверяем только тех, кем сервер пользуется', async () => {
  socket.online = () => true;
  settings.set('chain.stt', ['custom']);
  settings.set('chain.llm', []);
  const asked = [];
  probe.check = async (id) => { asked.push(id); return { stt: { ok: true }, llm: { ok: false, error: 'нет ключа' } }; };
  await watch.tick({ probeNow: true, at: 0 });
  await watch.tick({ probeNow: true, at: 15 * MINUTE });
  assert.deepStrictEqual(asked, ['custom', 'custom']);
  assert.deepStrictEqual(sent, [], 'текстовая часть не из нашей цепочки — не наше дело');
});

test('без номера в настройках ничего не отправляется и ничего не падает', async () => {
  settings.set('alerts.chat', '');
  socket.online = () => false;
  await watch.tick({ at: 0 });
  await watch.tick({ at: 20 * MINUTE });
  assert.deepStrictEqual(sent, []);
});
