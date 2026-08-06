'use strict';

const keys = require('../keys');
const usage = require('../usage');

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
const MODE_BUTTONS = {
  reply_markup: {
    inline_keyboard: [
      [{ text: 'Почистить', callback_data: 'clean' }],
      [{ text: 'Почистить и переписать', callback_data: 'both' }],
    ],
  },
};

const NEED_CODE = 'Нужен код доступа. Попросите его у владельца и пришлите сюда шесть цифр.';

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
  try {
    keys.activate(text.trim(), 'telegram', from, update.message.from.first_name || '', `tg:${from}`);
    await tg.sendMessage(chatId, 'Готово, вы привязаны. Присылайте голосовое.');
  } catch (error) {
    await tg.sendMessage(chatId, error.message);
  }
}

async function onVoice(update, { tg, queue }, device) {
  const message = update.message;
  const chatId = message.chat.id;
  const voice = message.voice || message.audio;

  if ((voice.duration || 0) > MAX_SECONDS) {
    await tg.sendMessage(chatId, `Слишком длинная запись. Предел — ${MAX_SECONDS / 60} минут.`);
    return;
  }

  // Сначала отклик, потом работа: человек должен сразу видеть, что его
  // услышали, а не гадать, дошло ли сообщение.
  const placeholder = await tg.sendMessage(chatId, 'Распознаю…');

  let audio;
  try {
    audio = await tg.download(voice.file_id);
  } catch (error) {
    await tg.editMessage(chatId, placeholder.message_id, `Не удалось забрать запись: ${error.message}`);
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
      await tg.editMessage(chatId, placeholder.message_id, 'Тишина — ничего не разобрал.');
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

    await tg.editMessage(chatId, placeholder.message_id, text, MODE_BUTTONS);
  } catch (error) {
    await tg.editMessage(chatId, placeholder.message_id, error.message);
  }
}

async function onButton(update, { tg, queue }, device) {
  const query = update.callback_query;
  const chatId = query.message.chat.id;
  const source = query.message.text || '';

  await tg.answerCallback(query.id, 'Причёсываю…');
  if (!source.trim()) return;

  try {
    const result = await queue.improve({ text: source, mode: query.data });
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
    await tg.editMessage(chatId, query.message.message_id, result.text, MODE_BUTTONS);
  } catch (error) {
    // Текст остаётся при человеке: улучшение — надстройка, а не условие.
    await tg.editMessage(
      chatId, query.message.message_id,
      `${source}\n\n— причесать не вышло: ${error.message}`,
      MODE_BUTTONS,
    );
  }
}

async function handle(update, deps) {
  const { tg } = deps;

  if (update.callback_query) {
    const device = who(update.callback_query.from.id);
    if (!device) {
      await tg.answerCallback(update.callback_query.id, 'Доступ отозван');
      return;
    }
    await onButton(update, deps, device);
    return;
  }

  const message = update.message;
  if (!message || !message.chat || !message.from) return;
  const chatId = message.chat.id;
  const text = String(message.text || '').trim();

  // /id — единственное, что работает у всех без исключения: иначе
  // владельцу неоткуда взять номер для ручной привязки.
  if (text === '/id') {
    await tg.sendMessage(chatId, `Ваш номер в Telegram: ${message.from.id}`);
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
      await tg.sendMessage(chatId, NEED_CODE);
    }
    return;
  }

  if (message.voice || message.audio) {
    await onVoice(update, deps, device);
    return;
  }

  if (text === '/start') {
    await tg.sendMessage(chatId, 'Присылайте голосовое — верну текстом. Под текстом будут кнопки, чтобы его причесать.');
  }
}

module.exports = { handle, MAX_SECONDS, MODE_BUTTONS, NEED_CODE };
