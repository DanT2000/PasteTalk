'use strict';

const keys = require('../keys');
const usage = require('../usage');
const { langOf, text: t, activateError } = require('./strings');
const links = require('./links');

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
function modeButtons(lang, { withModes = true } = {}) {
  const rows = [];
  if (withModes) {
    rows.push([{ text: t(lang, 'buttonClean'), callback_data: 'clean' }]);
    rows.push([{ text: t(lang, 'buttonBoth'), callback_data: 'both' }]);
  }
  // Вторая попытка доступна всегда: распознавание бывает корявым, а
  // «Тишина» — ложной. Голосовое достаём из reply, ничего не храня.
  rows.push([{ text: t(lang, 'buttonRetry'), callback_data: 'retry' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function who(from) {
  return keys.byExternal('telegram', String(from));
}

/**
 * Гость открытого бота. Пока тумблер в админке включён, любой может
 * пользоваться ботом без кода; расход пишется в профиль «Гости бота».
 * Привязка не создаётся нарочно: выключили тумблер — гости отвалились
 * в ту же секунду, а привязанные по коду продолжают работать.
 */
function guest(from) {
  if (require('../settings').get('access.botOpen', false) !== true) return null;
  // «Удалить» у владельца значит «забанить», а не «перевести в гости»:
  // отозванный номер в гости не пускаем даже при открытом боте.
  if (keys.wasRevoked('telegram', String(from))) return null;
  return { keyId: keys.guestKeyId(), kind: 'telegram', guest: true };
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

/**
 * Превратить уже скачанный звук в текст, отредактировав сообщение-заглушку.
 * Общая дорога голосовых и записей по ссылке, первой попытки и кнопки
 * «Распознать ещё раз».
 */
async function transcribeMedia({ tg, queue }, device, chatId, messageId, media, lang) {
  try {
    const result = await queue.transcribe({
      audio: media.audio, filename: media.filename, language: null,
      // Длительность знает источник (Telegram или загрузчик) — своей
      // оценки для сжатого звука у нас нет, а без неё расход считается нулём.
      clientSeconds: media.seconds || 0,
    });
    const text = (result.text || '').trim();
    if (!text) {
      // «Тишина» бывает ложной — оставляем кнопку второй попытки.
      await tg.editMessage(chatId, messageId, t(lang, 'silence'), modeButtons(lang, { withModes: false }));
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

    await tg.editMessage(chatId, messageId, text, modeButtons(lang));
  } catch (error) {
    // Сбой бывает мимолётным (очередь, сеть, облако) — кнопка второй
    // попытки уместнее голой ошибки.
    await tg.editMessage(chatId, messageId, error.message, modeButtons(lang, { withModes: false }));
  }
}

/** Скачать голосовое из Telegram и распознать. */
async function runTranscribe({ tg, queue }, device, chatId, messageId, voice, lang) {
  let audio;
  try {
    audio = await tg.download(voice.file_id);
  } catch (error) {
    await tg.editMessage(chatId, messageId, t(lang, 'downloadFailed', { message: error.message }));
    return;
  }
  await transcribeMedia({ tg, queue }, device, chatId, messageId, {
    audio, filename: 'voice.oga', seconds: voice.duration || 0,
  }, lang);
}

/**
 * Скачать запись по ссылке (VK Видео, YouTube, Rutube) и распознать.
 * Загрузчик подменяется через deps.links — так бот проверяется без сети.
 */
async function runLink({ tg, queue, links: fetchLink }, device, chatId, messageId, url, lang) {
  let media;
  try {
    media = await (fetchLink || links.download)(url, { maxSeconds: links.MAX_SECONDS });
  } catch (error) {
    if (error.code === 'tooLong') {
      await tg.editMessage(chatId, messageId, t(lang, 'linkTooLong', {
        minutes: Math.round((error.seconds || 0) / 60), limit: links.MAX_SECONDS / 60,
      }));
      return;
    }
    // Сайт мог моргнуть — кнопка второй попытки скачает заново.
    await tg.editMessage(chatId, messageId, t(lang, 'linkFailed', { message: error.message }),
      modeButtons(lang, { withModes: false }));
    return;
  }
  await tg.editMessage(chatId, messageId, t(lang, 'transcribing'));
  await transcribeMedia({ tg, queue }, device, chatId, messageId, media, lang);
}

async function onLink(update, deps, device, url) {
  const message = update.message;
  const chatId = message.chat.id;
  const lang = langOf(message.from);
  // Заглушка — реплаем на сообщение со ссылкой: из реплая «Распознать
  // ещё раз» достанет адрес и скачает заново.
  const placeholder = await deps.tg.sendMessage(chatId, t(lang, 'linkFetching'), {
    reply_to_message_id: message.message_id,
  });
  await runLink(deps, device, chatId, placeholder.message_id, url, lang);
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
  // услышали, а не гадать, дошло ли сообщение. Заглушка — реплаем на
  // голосовое: из реплая кнопка «Распознать ещё раз» достаёт запись.
  const placeholder = await tg.sendMessage(chatId, t(lang, 'transcribing'), {
    reply_to_message_id: message.message_id,
  });

  await runTranscribe({ tg, queue }, device, chatId, placeholder.message_id, voice, lang);
}

async function onButton(update, deps, device) {
  const { tg, queue } = deps;
  const query = update.callback_query;
  const chatId = query.message.chat.id;
  const lang = langOf(query.from);
  const source = query.message.text || '';
  const mode = query.data;

  // Вторая попытка распознавания: голосовое или ссылка лежат в реплае
  // нашего же сообщения — скачиваем заново и прогоняем, ничего не храня.
  if (mode === 'retry') {
    const original = query.message.reply_to_message;
    const voice = original && (original.voice || original.audio);
    const link = !voice && original ? links.find(original) : null;
    if (!voice && !(link && !link.unsupported)) {
      await tg.answerCallback(query.id, t(lang, 'retryLost'));
      return;
    }
    await tg.answerCallback(query.id, t(lang, 'accepted'));
    await tg.editMarkup(chatId, query.message.message_id, undefined).catch(() => {});
    if (voice) {
      await tg.editMessage(chatId, query.message.message_id, t(lang, 'transcribing'));
      await runTranscribe({ tg, queue }, device, chatId, query.message.message_id, voice, lang);
    } else {
      await tg.editMessage(chatId, query.message.message_id, t(lang, 'linkFetching'));
      await runLink(deps, device, chatId, query.message.message_id, link.url, lang);
    }
    return;
  }

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
    const device = who(update.callback_query.from.id) || guest(update.callback_query.from.id);
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

  let device = who(message.from.id);

  // Код проверяется до гостевого входа: даже при открытом боте человек
  // с кодом должен получить свою личную привязку, а не гостевую.
  if (!device && looksLikeCode(text)) {
    await onCode(update, deps, text);
    return;
  }

  if (!device) device = guest(message.from.id);

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

  // Ссылка на запись: VK Видео, стена ВКонтакте, YouTube, Rutube. Чужой
  // сайт — честный отказ, а не молчание и не попытка скачать что попало.
  const link = links.find(message);
  if (link) {
    if (link.unsupported) {
      await tg.sendMessage(chatId, t(lang, 'linkUnsupported'));
      return;
    }
    await onLink(update, deps, device, link.url);
    return;
  }

  if (text === '/start') {
    await tg.sendMessage(chatId, t(lang, 'start'));
  }
}

module.exports = { handle, MAX_SECONDS, modeButtons };
