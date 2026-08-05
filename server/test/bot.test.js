'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const keys = require('../src/keys');
const usage = require('../src/usage');
const settings = require('../src/settings');
const bot = require('../src/bot/handlers');

/**
 * Бот проверяется без сети: вместо Telegram подставляем запись действий,
 * вместо очереди — предсказуемый ответ. Так видно, что именно бот скажет
 * человеку, а не то, что где-то что-то не упало.
 */
function fakeTelegram() {
  const sent = [];
  return {
    sent,
    sendMessage: async (chatId, text, extra) => {
      sent.push({ do: 'send', chatId, text, extra });
      return { message_id: 100 + sent.length };
    },
    editMessage: async (chatId, messageId, text, extra) => {
      sent.push({ do: 'edit', chatId, messageId, text, extra });
    },
    answerCallback: async (id, text) => { sent.push({ do: 'answer', id, text }); },
    download: async () => Buffer.from('звук'),
  };
}

const okQueue = {
  transcribe: async () => ({ text: 'сказанное вслух', seconds: 4, executedBy: 'agent', model: 'large-v3' }),
  improve: async () => ({ text: 'Сказанное вслух.', executedBy: 'agent', model: 'gemma3:12b', tokensIn: 0, tokensOut: 0 }),
};

const voice = (from) => ({
  message: { message_id: 7, chat: { id: from }, from: { id: from }, voice: { file_id: 'f1', duration: 4 } },
});
const said = (from, text) => ({
  message: { message_id: 7, chat: { id: from }, from: { id: from }, text },
});

test.beforeEach(() => { db.close(); db.open(':memory:'); keys.forgetMisses(); });

test('незнакомцу бот отказывает и денег не тратит', async () => {
  const tg = fakeTelegram();
  let touched = false;
  await bot.handle(voice(555), {
    tg,
    queue: { transcribe: async () => { touched = true; return {}; } },
  });

  assert.match(tg.sent[0].text, /код доступа/i);
  assert.strictEqual(touched, false, 'чужой не должен доходить до распознавания');
  assert.strictEqual(usage.monthly().rub, 0);
});

test('шесть цифр привязывают человека', async () => {
  const key = keys.issue('Мама');
  const tg = fakeTelegram();

  await bot.handle(said(555, key.code), { tg, queue: okQueue });

  assert.match(tg.sent[0].text, /Готово|привяз/i);
  assert.strictEqual(keys.byExternal('telegram', '555').keyId, key.id);
});

test('неверный код — честный отказ, а не молчание', async () => {
  keys.issue('Мама');
  const tg = fakeTelegram();
  await bot.handle(said(555, '000000'), { tg, queue: okQueue });
  assert.match(tg.sent[0].text, /кода нет/i);
});

test('голосовое: сначала «Распознаю», потом тот же текст правится', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();

  await bot.handle(voice(555), { tg, queue: okQueue });

  assert.strictEqual(tg.sent[0].do, 'send');
  assert.match(tg.sent[0].text, /Распознаю/i);
  assert.strictEqual(tg.sent[1].do, 'edit');
  // Правится именно то сообщение, которое только что отправили, — иначе
  // в переписке копилось бы «Распознаю…».
  assert.strictEqual(tg.sent[1].messageId, 101);
  assert.strictEqual(tg.sent.filter((item) => item.do === 'send').length, 1);
  assert.strictEqual(tg.sent[1].text, 'сказанное вслух');
});

test('под распознанным текстом — две кнопки с теми же названиями, что на ПК', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();

  await bot.handle(voice(555), { tg, queue: okQueue });

  const buttons = tg.sent[1].extra.reply_markup.inline_keyboard.flat();
  assert.deepStrictEqual(buttons.map((b) => b.text), ['Почистить', 'Почистить и переписать']);
  assert.deepStrictEqual(buttons.map((b) => b.callback_data), ['clean', 'both']);
});

test('распознавание пишется в расход на нужный ключ', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();

  await bot.handle(voice(555), { tg, queue: okQueue });

  const rows = usage.perKey();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].key_id, key.id);
});

test('нет связи с распознаванием — говорим прямо', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();

  await bot.handle(voice(555), {
    tg,
    queue: { transcribe: async () => { throw new Error('Связи с распознаванием нет'); } },
  });

  assert.match(tg.sent[1].text, /Связи с распознаванием нет/);
});

test('кнопка улучшает тот же текст', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();

  await bot.handle({
    callback_query: {
      id: 'cb1', data: 'clean', from: { id: 555 },
      message: { message_id: 101, chat: { id: 555 }, text: 'сказанное вслух' },
    },
  }, { tg, queue: okQueue });

  const edit = tg.sent.find((item) => item.do === 'edit');
  assert.strictEqual(edit.text, 'Сказанное вслух.');
});

test('улучшение не вышло — текст остаётся при человеке', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();

  await bot.handle({
    callback_query: {
      id: 'cb1', data: 'both', from: { id: 555 },
      message: { message_id: 101, chat: { id: 555 }, text: 'сказанное вслух' },
    },
  }, { tg, queue: { improve: async () => { throw new Error('модель молчит'); } } });

  const edit = tg.sent.find((item) => item.do === 'edit');
  assert.match(edit.text, /сказанное вслух/);
  assert.match(edit.text, /не вышло|не удалось/i);
});

test('/id работает у всех, даже у непривязанных', async () => {
  const tg = fakeTelegram();
  await bot.handle(said(555, '/id'), { tg, queue: okQueue });
  assert.match(tg.sent[0].text, /555/);
});

test('слишком длинная запись отсекается до скачивания', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();
  let downloaded = false;
  tg.download = async () => { downloaded = true; return Buffer.alloc(0); };

  await bot.handle({
    message: {
      message_id: 7, chat: { id: 555 }, from: { id: 555 },
      voice: { file_id: 'f1', duration: bot.MAX_SECONDS + 1 },
    },
  }, { tg, queue: okQueue });

  assert.match(tg.sent[0].text, /длинная/i);
  assert.strictEqual(downloaded, false);
});

test('отозванный ключ отрезает и телеграм', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  keys.revoke(key.id);
  const tg = fakeTelegram();

  await bot.handle(voice(555), { tg, queue: okQueue });
  assert.match(tg.sent[0].text, /код доступа/i);
});

test('мусор и чужие сообщения бот молча пропускает', async () => {
  const tg = fakeTelegram();
  await bot.handle({}, { tg, queue: okQueue });
  await bot.handle({ message: { chat: { id: 1 }, from: { id: 1 }, sticker: {} } }, { tg, queue: okQueue });
  assert.strictEqual(tg.sent.length, 0);
});

test('без токена опрос не поднимается', () => {
  const runner = require('../src/bot/telegram');
  assert.strictEqual(settings.get('bot.token', ''), '');
  assert.strictEqual(runner.running(), false);
  runner.sync();
  assert.strictEqual(runner.running(), false);
});
