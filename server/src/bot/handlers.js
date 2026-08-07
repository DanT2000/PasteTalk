'use strict';

const keys = require('../keys');
const usage = require('../usage');
const { langOf, text: t, activateError } = require('./strings');

/**
 * Что бот делает с одним обновлением от Telegram.
 *
 * Ни сети, ни токенов здесь нет: и Telegram, и очередь приходят снаружи
 * отдельными объектами. Так поведение бота — что именно он скажет
 * человеку — проверяется тестами целиком, без единого запроса наружу.
 */

// Пятнадцать минут: голосовое длиннее этого в Telegram и не запишешь без
// ухищрений, а проверка до скачивания бережёт и трафик, и время человека.
const MAX_SECONDS = 15 * 60;

// Кнопки в столбик, а не в ряд: «Почистить и переписать» рядом с
// «Почистить» Telegram ужимает до многоточия, и человек видит две
// одинаковые кнопки. В столбик каждая занимает всю ширину.
// Подписи — на языке того, кто их увидит.
function modeButtons(lang) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: t(lang, 'buttonClean'), callback_data: 'clean' }],
        [{ text: t(lang, 'buttonBoth'), callback_data: 'both' }],
      ],
    },
  };
}

function who(from) {
  return keys.byExternal('telegram', String(from));
}

/** Шесть цифр и ничего кроме — это попытка привязаться. */
function looksLikeCode(text) {
  return /^\d{6}$/.test(String(text || '').trim());
}

async function onCode(update, { tg }, text) {
  const chatId = update.message.chat.id;
  const from = String(update.message.from.id);
  const lang = langOf(update.message.from);
  try {
    keys.activate(text.trim(), 'telegram', from, update.message.from.first_name || '', `tg:${from}`);
    await tg.sendMessage(chatId, t(lang, 'linked'));
  } catch (error) {
    await tg.sendMessage(chatId, activateError(lang, error.message));
  }
}

async function onVoice(update, { tg, queue }, device) {
  const message = update.message;
  const chatId = message.chat.id;
  const lang = langOf(message.from);
  const voice = message.voice || message.audio;

  if ((voice.duration || 0) > MAX_SECONDS) {
    await tg.sendMessage(chatId, t(lang, 'tooLong', { minutes: MAX_SECONDS / 60 }));
    return;
  }

  // Сначала отклик, потом работа: человек должен сразу видеть, что его
  // услышали, а не гадать, дошло ли сообщение.
  const placeholder = await tg.sendMessage(chatId, t(lang, 'transcribing'));

  let audio;
  try {
    audio = await tg.download(voice.file_id);
  } catch (error) {
    await tg.editMessage(chatId, placeholder.message_id, t(lang, 'downloadFailed', { message: error.message }));
    return;
  }

  try {
    const result = await queue.transcribe({
      audio, filename: 'voice.oga', language: null,
      // Telegram сам говорит, сколько секунд в голосовом, — своей оценки
      // для ogg у нас нет, а без длительности расход считается нулём.
      clientSeconds: voice.duration || 0,
    });
    const text = (result.text || '').trim();
    if (!text) {
      await tg.editMessage(chatId, placeholder.message_id, t(lang, 'silence'));
      return;
    }

    usage.record({
      keyId: device.keyId,
      deviceKind: 'telegram',
      audioSeconds: result.seconds || 0,
      executedBy: result.executedBy,
      sttProvider: result.provider || null,
      sttModel: result.model || null,
    });

    await tg.editMessage(chatId, placeholder.message_id, text, modeButtons(lang));
  } catch (error) {
    await tg.editMessage(chatId, placeholder.message_id, error.message);
  }
}

async function onButton(update, { tg, queue }, device) {
  const query = update.callback_query;
  const chatId = query.message.chat.id;
  const lang = langOf(query.from);
  const source = query.message.text || '';
  const mode = query.data;

  await tg.answerCallback(query.id, t(lang, 'accepted'));
  if (!source.trim()) return;

  // Распознанный текст не трогаем вовсе: он остаётся в переписке как был.
  // Кнопки на время работы прячем — видно, что нажатие принято, и второй
  // клик не запустит ту же обработку ещё раз.
  await tg.editMarkup(chatId, query.message.message_id, undefined).catch(() => {});

  // Отправка «Чищу…» — внутри try: если она не пройдёт (сеть моргнула),
  // finally всё равно вернёт кнопки. Снаружи try их не возвращал никто,
  // и после единственного сбоя текст оставался без кнопок навсегда.
  let placeholder;
  try {
    placeholder = await tg.sendMessage(
      chatId, t(lang, mode === 'both' ? 'rewriting' : 'cleaning'),
    );
    const result = await queue.improve({ text: source, mode });
    usage.record({
      keyId: device.keyId,
      deviceKind: 'telegram',
      audioSeconds: 0,
      executedBy: result.executedBy,
      llmProvider: result.provider || null,
      llmModel: result.model || null,
      tokensIn: result.tokensIn || 0,
      tokensOut: result.tokensOut || 0,
    });
    // Улучшенный — отдельным сообщением: сначала распознанный, под ним
    // причёсанный, и оба на руках.
    await tg.editMessage(chatId, placeholder.message_id, result.text);
  } catch (error) {
    // Без плейсхолдера сообщать некуда — до Telegram не достучаться;
    // пробрасываем, чтобы цикл опроса записал сбой в журнал.
    if (!placeholder) throw error;
    await tg.editMessage(
      chatId, placeholder.message_id, t(lang, 'improveFailed', { message: error.message }),
    );
  } finally {
    // Кнопки возвращаются на распознанное: можно попробовать другой режим.
    await tg.editMarkup(chatId, query.message.message_id, modeButtons(lang).reply_markup)
      .catch(() => {});
  }
}

async function handle(update, deps) {
  const { tg } = deps;

  if (update.callback_query) {
    const device = who(update.callback_query.from.id);
    if (!device) {
      await tg.answerCallback(update.callback_query.id, t(langOf(update.callback_query.from), 'revoked'));
      return;
    }
    await onButton(update, deps, device);
    return;
  }

  const message = update.message;
  if (!message || !message.chat || !message.from) return;
  const chatId = message.chat.id;
  const lang = langOf(message.from);
  const text = String(message.text || '').trim();

  // /id — единственное, что работает у всех без исключения: иначе
  // владельцу неоткуда взять номер для ручной привязки.
  if (text === '/id') {
    await tg.sendMessage(chatId, t(lang, 'yourId', { id: message.from.id }));
    return;
  }

  const device = who(message.from.id);

  if (!device && looksLikeCode(text)) {
    await onCode(update, deps, text);
    return;
  }

  if (!device) {
    // Отвечаем только на осмысленные обращения: молчаливый бот в чате
    // лучше бота, который огрызается на каждый стикер.
    if (text === '/start' || text || message.voice || message.audio) {
      await tg.sendMessage(chatId, t(lang, 'needCode'));
    }
    return;
  }

  if (message.voice || message.audio) {
    await onVoice(update, deps, device);
    return;
  }

  if (text === '/start') {
    await tg.sendMessage(chatId, t(lang, 'start'));
  }
}

module.exports = { handle, MAX_SECONDS, modeButtons };
