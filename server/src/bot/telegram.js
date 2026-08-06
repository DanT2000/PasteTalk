'use strict';

const settings = require('../settings');
const queue = require('../agent/queue');
const handlers = require('./handlers');
const proxy = require('../proxy');

/**
 * Разговор с Telegram: длинные опросы вместо вебхука.
 *
 * Вебхук потребовал бы, чтобы Telegram достучался до сервера снаружи —
 * публичный адрес, действующий сертификат, открытый порт. Опросы работают
 * из-под чего угодно и не ломаются при смене домена. Для десятка человек
 * разница в скорости незаметна.
 *
 * Библиотеки нет намеренно: у Bot API обычный HTTP с JSON, а боту нужно
 * пять методов. Ещё одна зависимость ради пяти запросов не окупается.
 */

const POLL_SECONDS = 25;
const API = 'https://api.telegram.org';

let live = null;   // { token, offset, stop }

function api(token, method, body) {
  return fetch(`${API}/bot${token}/${method}`, proxy.through('telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    // Опрос висит до POLL_SECONDS, поэтому ждём с запасом.
    signal: AbortSignal.timeout((POLL_SECONDS + 15) * 1000),
  })).then(async (response) => {
    const data = await response.json();
    if (!data.ok) throw new Error(data.description || `Telegram ответил ${response.status}`);
    return data.result;
  });
}

function makeTelegram(token) {
  return {
    sendMessage: (chatId, text, extra = {}) =>
      api(token, 'sendMessage', { chat_id: chatId, text, ...extra }),

    editMessage: (chatId, messageId, text, extra = {}) =>
      api(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra })
        // «Сообщение не изменилось» — не ошибка, а совпадение текста.
        .catch((error) => {
          if (!/not modified/i.test(error.message)) throw error;
        }),

    answerCallback: (id, text) =>
      api(token, 'answerCallbackQuery', { callback_query_id: id, text }),

    // Только кнопки под сообщением, не трогая его текст.
    editMarkup: (chatId, messageId, markup) =>
      api(token, 'editMessageReplyMarkup', {
        chat_id: chatId, message_id: messageId, reply_markup: markup,
      }).catch((error) => {
        if (!/not modified/i.test(error.message)) throw error;
      }),

    download: async (fileId) => {
      const file = await api(token, 'getFile', { file_id: fileId });
      const response = await fetch(`${API}/file/bot${token}/${file.file_path}`,
        proxy.through('telegram', { signal: AbortSignal.timeout(120000) }));
      if (!response.ok) throw new Error(`не скачалось, ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

/** Строка журнала с меткой времени: хвост без дат уже дважды выдавал
 *  вчерашние ошибки за сегодняшние. */
function say(text) {
  process.stderr.write(`${new Date().toISOString()} ${text}\n`);
}

async function loop(state) {
  const tg = makeTelegram(state.token);
  // Об успехе тоже говорим — один раз после каждой полосы неудач. Молчащий
  // при успехе бот неотличим в журнале от давно умершего.
  let failing = true;
  while (!state.stop) {
    let updates;
    try {
      updates = await api(state.token, 'getUpdates', {
        offset: state.offset,
        timeout: POLL_SECONDS,
        allowed_updates: ['message', 'callback_query'],
      });
      if (failing) {
        say('бот: опрос работает');
        failing = false;
      }
    } catch (error) {
      if (state.stop) return;
      failing = true;
      say(`бот: опрос не удался — ${error.message}`);
      // Пауза, чтобы при недоступном Telegram не молотить запросами.
      await new Promise((wait) => setTimeout(wait, 5000));
      continue;
    }

    for (const update of updates) {
      state.offset = update.update_id + 1;
      settings.set('bot.offset', state.offset);
      if (state.stop) return;
      try {
        await handlers.handle(update, { tg, queue });
      } catch (error) {
        // Одно неудачное сообщение не должно ронять опрос для остальных.
        process.stderr.write(`бот: сообщение не обработано — ${error.message}\n`);
      }
    }
  }
}

function running() {
  return Boolean(live);
}

function stop() {
  if (!live) return;
  live.stop = true;
  live = null;
}

/**
 * Привести опрос в соответствие с настройками.
 *
 * Вызывается при запуске и после сохранения настроек: вписали токен —
 * бот поднимается без перезапуска сервера, стёрли — замолкает.
 */
function sync() {
  const token = String(settings.get('bot.token', '') || '').trim();
  // Прокси тоже часть настройки: опрос уже висит на своём переходнике, и
  // смена адреса без перезапуска цикла ничего бы не изменила — бот так и
  // падал бы с «fetch failed», хотя в админке всё вписано верно.
  const route = `${proxy.url()}|${settings.get('proxy.scope', 'telegram')}`;

  if (!token) {
    stop();
    return false;
  }
  if (live && live.token === token && live.route === route) return true;

  stop();
  // Смещение переживает перезапуск: Telegram подтверждает пачку только
  // следующим запросом, и без памяти то же голосовое распозналось бы и
  // оплатилось второй раз — после смены настроек или пересборки.
  live = { token, route, offset: Number(settings.get('bot.offset', 0)) || 0, stop: false };
  loop(live).catch((error) => {
    process.stderr.write(`бот остановился: ${error.message}\n`);
  });
  return true;
}

module.exports = { sync, stop, running, makeTelegram, POLL_SECONDS };
