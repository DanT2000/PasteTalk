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
  assert.deepStrictEqual(buttons.map((b) => b.text), ['Почистить', 'Почистить и переписать', '🔁 Распознать ещё раз']);
  assert.deepStrictEqual(buttons.map((b) => b.callback_data), ['clean', 'both', 'retry']);
});

test('заглушка «Распознаю» — реплаем на голосовое: из него берётся вторая попытка', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();

  await bot.handle(voice(555), { tg, queue: okQueue });

  assert.strictEqual(tg.sent[0].extra.reply_to_message_id, voice(555).message.message_id);
});

test('кнопка «Распознать ещё раз» скачивает голосовое заново и правит то же сообщение', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();

  await bot.handle({
    callback_query: {
      id: 'q1',
      from: { id: 555, language_code: 'ru' },
      data: 'retry',
      message: {
        message_id: 42,
        chat: { id: 555 },
        text: 'Тишина — ничего не разобрал.',
        reply_to_message: { message_id: 7, voice: { file_id: 'f-retry', duration: 13 } },
      },
    },
  }, { tg, queue: okQueue });

  const edits = tg.sent.filter((item) => item.do === 'edit');
  assert.strictEqual(edits[edits.length - 1].messageId, 42);
  assert.strictEqual(edits[edits.length - 1].text, 'сказанное вслух');
});

test('«Распознать ещё раз» без исходного голосового честно извиняется', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();

  await bot.handle({
    callback_query: {
      id: 'q2',
      from: { id: 555, language_code: 'ru' },
      data: 'retry',
      message: { message_id: 43, chat: { id: 555 }, text: 'Тишина — ничего не разобрал.' },
    },
  }, { tg, queue: okQueue });

  const answered = tg.sent.find((item) => item.do === 'answer');
  assert.match(answered.text, /пришлите ещё раз/i);
  assert.strictEqual(tg.sent.filter((item) => item.do === 'edit').length, 0);
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
  assert.deepStrictEqual(buttons.map((b) => b.text), ['Clean up', 'Clean up and rewrite', '🔁 Transcribe again']);
  assert.deepStrictEqual(buttons.map((b) => b.callback_data), ['clean', 'both', 'retry']);
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

// ---------- открытый бот и закрытые привязки ----------

test('открытый бот: гость распознаёт без кода, привязки не появляется', async () => {
  settings.set('access.botOpen', true);
  const tg = fakeTelegram();
  await bot.handle(voice(777), { tg, queue: okQueue });

  assert.strictEqual(tg.sent[1].text, 'сказанное вслух');
  // Привязка не создаётся нарочно: выключил тумблер — гость отвалился.
  assert.ok(!keys.byExternal('telegram', '777'));
  assert.ok(keys.list().some((key) => key.name === 'Гости бота'), 'расход гостей должен иметь профиль');
});

test('тумблер выключили — гость снова получает отказ', async () => {
  settings.set('access.botOpen', false);
  const tg = fakeTelegram();
  await bot.handle(voice(777), { tg, queue: okQueue });
  assert.match(tg.sent[0].text, /код доступа/i);
});

test('код работает и при открытом боте: личная привязка важнее гостевой', async () => {
  settings.set('access.botOpen', true);
  const key = keys.issue('Тестировщик');
  const tg = fakeTelegram();
  await bot.handle(said(888, key.code), { tg, queue: okQueue });
  assert.strictEqual(keys.byExternal('telegram', '888').keyId, key.id);
});

test('привязки закрыты: код отклоняется, уже привязанные работают', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  settings.set('access.newCodes', false);
  const fresh = keys.issue('Новичок');
  const tg = fakeTelegram();

  await bot.handle(said(999, fresh.code), { tg, queue: okQueue });
  assert.match(tg.sent[0].text, /закрыты владельцем/i);

  await bot.handle(voice(555), { tg, queue: okQueue });
  assert.strictEqual(tg.sent[2].text, 'сказанное вслух');
});

// ---------- ссылки на записи ----------

const links = require('../src/bot/links');

const linkMsg = (from, url) => said(from, `глянь ${url}`);
const fakeLinks = (calls, behave = {}) => async (url) => {
  calls.push(url);
  if (behave.tooLong) {
    const error = new Error('слишком длинная запись');
    error.code = 'tooLong';
    error.seconds = 3 * 3600;
    throw error;
  }
  if (behave.fail) throw new Error('запись закрытая — видна только после входа');
  return { audio: Buffer.from('звук'), filename: 'link.mp3', seconds: 90, title: 'Лекция' };
};

test('links.find: наша ссылка — берём, чужая — отказ, без ссылок — ничего', () => {
  assert.deepStrictEqual(links.find({ text: 'см https://vkvideo.ru/video-1_2 и https://vk.com/wall-1_3' }), { url: 'https://vkvideo.ru/video-1_2' });
  assert.deepStrictEqual(links.find({ text: 'https://youtu.be/abc.' }), { url: 'https://youtu.be/abc' });
  assert.deepStrictEqual(links.find({ text: 'https://example.com/x https://vk.com/video-1_2' }), { url: 'https://vk.com/video-1_2' });
  assert.deepStrictEqual(links.find({ text: 'https://example.com/x' }), { url: 'https://example.com/x', unsupported: true });
  assert.strictEqual(links.find({ text: 'привет' }), null);
  assert.deepStrictEqual(
    links.find({ text: 'вот', entities: [{ type: 'text_link', offset: 0, length: 3, url: 'https://rutube.ru/video/abc/' }] }),
    { url: 'https://rutube.ru/video/abc/' },
  );
  assert.strictEqual(links.supported('ftp://vk.com/x'), false);
  assert.strictEqual(links.supported('https://notvk.com/x'), false);
});

test('ссылка на VK Видео: «Забираю…», потом «Распознаю…», потом текст с кнопками', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();
  const calls = [];
  let given = null;
  const queue = { ...okQueue, transcribe: async (job) => { given = job; return okQueue.transcribe(); } };

  await bot.handle(linkMsg(555, 'https://vkvideo.ru/video-1_2'), { tg, queue, links: fakeLinks(calls) });

  assert.deepStrictEqual(calls, ['https://vkvideo.ru/video-1_2']);
  assert.strictEqual(tg.sent[0].do, 'send');
  assert.match(tg.sent[0].text, /Забираю/);
  assert.strictEqual(tg.sent[0].extra.reply_to_message_id, 7);
  assert.strictEqual(tg.sent[1].do, 'edit');
  assert.match(tg.sent[1].text, /Распознаю/);
  assert.strictEqual(tg.sent[1].messageId, 101);
  assert.strictEqual(tg.sent[2].text, 'сказанное вслух');
  assert.deepStrictEqual(tg.sent[2].extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['clean', 'both', 'retry']);
  assert.strictEqual(given.filename, 'link.mp3');
  assert.strictEqual(given.clientSeconds, 90);
});

test('ссылку с чужого сайта бот отклоняет и ничего не качает', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();
  const calls = [];

  await bot.handle(linkMsg(555, 'https://example.com/a'), { tg, queue: okQueue, links: fakeLinks(calls) });

  assert.deepStrictEqual(calls, []);
  assert.match(tg.sent[0].text, /только с ВКонтакте/);
});

test('слишком длинная запись по ссылке — в ответе и длина, и предел', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();

  await bot.handle(linkMsg(555, 'https://vk.com/video-1_2'), { tg, queue: okQueue, links: fakeLinks([], { tooLong: true }) });

  assert.strictEqual(tg.sent[1].do, 'edit');
  assert.match(tg.sent[1].text, /180 мин/);
  assert.match(tg.sent[1].text, /120 мин/);
});

test('сайт не отдал запись — причина и кнопка второй попытки', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();

  await bot.handle(linkMsg(555, 'https://vk.com/video-1_2'), { tg, queue: okQueue, links: fakeLinks([], { fail: true }) });

  assert.match(tg.sent[1].text, /Не удалось забрать запись по ссылке: запись закрытая/);
  assert.deepStrictEqual(tg.sent[1].extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['retry']);
});

test('«Распознать ещё раз» под ссылкой скачивает запись заново', async () => {
  const key = keys.issue('Мама');
  keys.bind(key.id, 'telegram', '555', 'Мама');
  const tg = fakeTelegram();
  const calls = [];

  await bot.handle({
    callback_query: {
      id: 'q1', data: 'retry', from: { id: 555, language_code: 'ru' },
      message: {
        message_id: 101, chat: { id: 555 }, text: 'Тишина — ничего не разобрал.',
        reply_to_message: linkMsg(555, 'https://vk.com/video-1_2').message,
      },
    },
  }, { tg, queue: okQueue, links: fakeLinks(calls) });

  assert.deepStrictEqual(calls, ['https://vk.com/video-1_2']);
  assert.ok(tg.sent.some((item) => item.do === 'edit' && /Забираю/.test(item.text)));
  const last = tg.sent[tg.sent.length - 1];
  assert.strictEqual(last.text, 'сказанное вслух');
  assert.strictEqual(last.messageId, 101);
});

test('незнакомцу ссылка тоже не по карману: код доступа, а не скачивание', async () => {
  const tg = fakeTelegram();
  const calls = [];
  await bot.handle(linkMsg(555, 'https://vk.com/video-1_2'), { tg, queue: okQueue, links: fakeLinks(calls) });
  assert.deepStrictEqual(calls, []);
  assert.match(tg.sent[0].text, /код доступа/i);
});

