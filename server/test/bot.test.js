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
    editMarkup: async (chatId, messageId, markup) => {
      sent.push({ do: 'markup', chatId, messageId, markup });
    },
    answerCallback: async (id, text) => { sent.push({ do: 'answer', id, text }); },
    download: async () => Buffer.from('звук'),
  };
}

const okQueue = {
  transcribe: async () => ({ text: 'сказанное вслух', seconds: 4, executedBy: 'agent', model: 'large-v3' }),
  improve: async () => ({ text: 'Сказанное вслух.', executedBy: 'agent', model: 'gemma3:12b', tokensIn: 0, tokensOut: 0 }),
};

// language_code: 'ru' — как у настоящего русского Telegram; без него бот
// по праву ответил бы по-английски, и проверки русских текстов бы врали.
const voice = (from) => ({
  message: {
    message_id: 7, chat: { id: from }, from: { id: from, language_code: 'ru' },
    voice: { file_id: 'f1', duration: 4 },
  },
});
const said = (from, text) => ({
  message: { message_id: 7, chat: { id: from }, from: { id: from, language_code: 'ru' }, text },
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

test('улучшение приходит отдельным сообщением, распознанное не трогается', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();

  await bot.handle({
    callback_query: {
      id: 'cb1', data: 'clean', from: { id: 555, language_code: 'ru' },
      message: { message_id: 101, chat: { id: 555 }, text: 'сказанное вслух' },
    },
  }, { tg, queue: okQueue });

  // Распознанное сообщение текстом не редактировалось ни разу.
  assert.ok(!tg.sent.some((s) => s.do === 'edit' && s.messageId === 101));
  // Пока шла работа — «Чищу…», у распознанного пропали кнопки.
  const placeholder = tg.sent.find((s) => s.do === 'send');
  assert.match(placeholder.text, /Чищу/);
  const hidden = tg.sent.findIndex((s) => s.do === 'markup');
  const asked = tg.sent.findIndex((s) => s.do === 'send');
  assert.ok(hidden >= 0 && hidden < asked, 'кнопки прячутся до «Чищу…»');
  assert.strictEqual(tg.sent[hidden].markup, undefined);
  // Улучшенный текст встал на место «Чищу…».
  const edit = tg.sent.find((s) => s.do === 'edit');
  assert.strictEqual(edit.text, 'Сказанное вслух.');
  // Кнопки вернулись на распознанное: можно попробовать другой режим.
  const restored = tg.sent.filter((s) => s.do === 'markup').pop();
  assert.strictEqual(restored.messageId, 101);
  assert.ok(restored.markup);
});

test('улучшение не вышло — текст остаётся при человеке', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();

  await bot.handle({
    callback_query: {
      id: 'cb1', data: 'both', from: { id: 555, language_code: 'ru' },
      message: { message_id: 101, chat: { id: 555 }, text: 'сказанное вслух' },
    },
  }, { tg, queue: { improve: async () => { throw new Error('модель молчит'); } } });

  // Распознанное цело, ошибка пришла на месте «Переписываю…», кнопки вернулись.
  assert.ok(!tg.sent.some((s) => s.do === 'edit' && s.messageId === 101));
  const edit = tg.sent.find((item) => item.do === 'edit');
  assert.match(edit.text, /не вышло/i);
  const restored = tg.sent.filter((s) => s.do === 'markup').pop();
  assert.ok(restored.markup);
});

test('не ушло даже «Чищу…» — кнопки всё равно возвращаются', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();
  tg.sendMessage = async () => { throw new Error('сеть моргнула'); };

  await assert.rejects(bot.handle({
    callback_query: {
      id: 'cb1', data: 'clean', from: { id: 555, language_code: 'ru' },
      message: { message_id: 101, chat: { id: 555 }, text: 'сказанное вслух' },
    },
  }, { tg, queue: okQueue }), /сеть моргнула/);

  // Кнопки спрятали и вернули: человек может нажать ещё раз.
  const markups = tg.sent.filter((s) => s.do === 'markup');
  assert.strictEqual(markups.length, 2);
  assert.ok(markups[1].markup, 'последним действием кнопки возвращены');
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
      message_id: 7, chat: { id: 555 }, from: { id: 555, language_code: 'ru' },
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

test('без language_code бот отвечает по-английски', async () => {
  const tg = fakeTelegram();

  await bot.handle({
    message: { message_id: 7, chat: { id: 777 }, from: { id: 777 }, text: '/start' },
  }, { tg, queue: okQueue });

  assert.match(tg.sent[0].text, /access code/i);
  assert.doesNotMatch(tg.sent[0].text, /[а-яё]/i, 'русских букв быть не должно');
});

test('английский пользователь получает английские тексты и кнопки', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '777', 'Mom');
  const tg = fakeTelegram();

  await bot.handle({
    message: {
      message_id: 7, chat: { id: 777 }, from: { id: 777, language_code: 'en' },
      voice: { file_id: 'f1', duration: 4 },
    },
  }, { tg, queue: okQueue });

  assert.match(tg.sent[0].text, /Transcribing/);
  // Распознанный текст остаётся как распознан, а вот подписи кнопок — английские.
  const buttons = tg.sent[1].extra.reply_markup.inline_keyboard.flat();
  assert.deepStrictEqual(buttons.map((b) => b.text), ['Clean up', 'Clean up and rewrite']);
  assert.deepStrictEqual(buttons.map((b) => b.callback_data), ['clean', 'both']);
});

test('английскому пользователю и ошибки привязки приходят по-английски', async () => {
  keys.issue('Мама');
  const tg = fakeTelegram();

  await bot.handle({
    message: { message_id: 7, chat: { id: 777 }, from: { id: 777, language_code: 'en' }, text: '000000' },
  }, { tg, queue: okQueue });

  assert.match(tg.sent[0].text, /no such code/i);
});

test('без токена опрос не поднимается', () => {
  const runner = require('../src/bot/telegram');
  assert.strictEqual(settings.get('bot.token', ''), '');
  assert.strictEqual(runner.running(), false);
  runner.sync();
  assert.strictEqual(runner.running(), false);
});
