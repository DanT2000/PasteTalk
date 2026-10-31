'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const settings = require('../src/settings');
const handlers = require('../src/bot/handlers');
const telegram = require('../src/bot/telegram');

/**
 * Смещение опроса: сообщение, упавшее на моргнувшей сети, не должно
 * пропадать. Telegram считает доставленным всё, что осталось позади
 * смещения, — значит двигать его можно только после обработки.
 */

const realHandle = handlers.handle;

test.beforeEach(() => { db.close(); db.open(':memory:'); });
test.after(() => { handlers.handle = realHandle; });

const update = (id) => ({ update_id: id, message: { chat: { id: 1 }, from: { id: 2 }, text: 'привет' } });

test('обработали — смещение сдвинулось', async () => {
  handlers.handle = async () => {};
  const state = { offset: 0, stop: false };
  await telegram.runUpdates(state, [update(10), update(11)], {});
  assert.strictEqual(state.offset, 12);
  assert.strictEqual(Number(settings.get('bot.offset', 0)), 12);
});

test('сеть моргнула — смещение стоит, сообщение придёт снова', async () => {
  handlers.handle = async () => { throw new Error('fetch failed'); };
  const state = { offset: 10, stop: false };
  await telegram.runUpdates(state, [update(10), update(11)], {});
  assert.strictEqual(state.offset, 10, 'смещение не сдвинулось — Telegram принесёт заново');
  assert.strictEqual(state.retry.id, 10);
  assert.strictEqual(state.retry.n, 1);
});

test('после трёх попыток шагаем дальше, чтобы не запереть очередь', async () => {
  handlers.handle = async () => { throw new Error('fetch failed'); };
  const state = { offset: 10, stop: false };
  for (let i = 0; i < telegram.UPDATE_TRIES; i++) {
    await telegram.runUpdates(state, [update(10)], {});
  }
  assert.strictEqual(state.offset, 11, 'битое сообщение пропущено');
});

test('отказ самого Telegram не повторяем — он будет таким же', async () => {
  handlers.handle = async () => { throw new Error('chat not found'); };
  const state = { offset: 10, stop: false };
  await telegram.runUpdates(state, [update(10)], {});
  assert.strictEqual(state.offset, 11, 'шагнули сразу, без трёх кругов');
});

/**
 * Дорога до Telegram. Эти два теста идут в таком порядке не случайно:
 * удачный обход прокси запоминается на десять минут, и проверять «не
 * пускает никто» после него было бы уже не то.
 */
test('не пускает ни прокси, ни прямая дорога — ошибка про прокси, как и была', async () => {
  settings.set('proxy.url', 'http://127.0.0.1:9');
  const real = global.fetch;
  global.fetch = async (_where, options) => {
    throw new Error(options && options.dispatcher ? 'через прокси: fetch failed' : 'напрямую: fetch failed');
  };
  try {
    await assert.rejects(() => telegram.reach('https://api.telegram.org/x', () => ({})),
      /через прокси/);
  } finally { global.fetch = real; }
});

test('прокси не пускает, а Telegram виден сам — идём напрямую и запоминаем дорогу', async () => {
  settings.set('proxy.url', 'http://127.0.0.1:9');
  const real = global.fetch;
  let routes = [];
  global.fetch = async (_where, options) => {
    const viaProxy = Boolean(options && options.dispatcher);
    routes.push(viaProxy ? 'прокси' : 'напрямую');
    if (viaProxy) throw new Error('fetch failed');
    return { ok: true };
  };
  try {
    const got = await telegram.reach('https://api.telegram.org/x', () => ({}));
    assert.strictEqual(got.ok, true, 'запрос всё-таки прошёл');
    assert.deepStrictEqual(routes, ['прокси', 'напрямую']);

    routes = [];
    await telegram.reach('https://api.telegram.org/x', () => ({}));
    assert.deepStrictEqual(routes, ['напрямую'], 'пока дорога держится, прокси не трогаем');
  } finally { global.fetch = real; }
});

test('основной прокси не пускает — бот идёт через запасной', async () => {
  telegram.stop();   // забыть дорогу, выбранную прошлым тестом
  settings.set('proxy.url', 'http://127.0.0.1:9');
  settings.set('proxy.spare', 'http://127.0.0.2:9');
  const real = global.fetch;
  // У каждой дороги свой переходник — по нему и узнаём, через какую пошли.
  const proxy = require('../src/proxy');
  const mainWay = proxy.through('telegram', {}).dispatcher;
  const spareWay = proxy.throughSpare({}).dispatcher;
  assert.ok(mainWay && spareWay && mainWay !== spareWay, 'у основного и запасного переходники разные');
  const seen = [];
  global.fetch = async (_where, options) => {
    const way = options && options.dispatcher;
    const road = way === mainWay ? 'основной' : (way === spareWay ? 'запасной' : 'напрямую');
    seen.push(road);
    if (road === 'основной') throw new Error('fetch failed');
    return { ok: true };
  };
  try {
    const got = await telegram.reach('https://api.telegram.org/x', () => ({}));
    assert.strictEqual(got.ok, true);
    assert.deepStrictEqual(seen, ['основной', 'запасной'], 'прямую дорогу не трогали — есть запасной');
  } finally {
    global.fetch = real;
    telegram.stop();
    settings.set('proxy.spare', '');
  }
});

test('сетевую икоту отличаем от отказа', () => {
  for (const text of ['fetch failed', 'The operation was aborted due to timeout', 'Bad Gateway',
    'socket hang up', 'connect ECONNRESET 1.2.3.4:443']) {
    assert.ok(telegram.wobble(new Error(text)), text);
  }
  for (const text of ['chat not found', 'message is not modified', 'Unauthorized',
    'Conflict: terminated by other getUpdates request']) {
    assert.ok(!telegram.wobble(new Error(text)), text);
  }
});
