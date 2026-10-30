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
