'use strict';

const settings = require('../settings');
const queue = require('../agent/queue');
const handlers = require('./handlers');

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
  return fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    // Опрос висит до POLL_SECONDS, поэтому ждём с запасом.
    signal: AbortSignal.timeout((POLL_SECONDS + 15) * 1000),
  }).then(async (response) => {
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

    download: async (fileId) => {
      const file = await api(token, 'getFile', { file_id: fileId });
      const response = await fetch(`${API}/file/bot${token}/${file.file_path}`, {
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error(`не скачалось, ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

async function loop(state) {
  const tg = makeTelegram(state.token);
  while (!state.stop) {
    let updates;
    try {
      updates = await api(state.token, 'getUpdates', {
        offset: state.offset,
        timeout: POLL_SECONDS,
        allowed_updates: ['message', 'callback_query'],
      });
    } catch (error) {
      if (state.stop) return;
      process.stderr.write(`бот: опрос не удался — ${error.message}\n`);
      // Пауза, чтобы при недоступном Telegram не молотить запросами.
      await new Promise((wait) => setTimeout(wait, 5000));
      continue;
    }

    for (const update of updates) {
      state.offset = update.update_id + 1;
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

  if (!token) {
    stop();
    return false;
  }
  if (live && live.token === token) return true;

  stop();
  live = { token, offset: 0, stop: false };
  loop(live).catch((error) => {
    process.stderr.write(`бот остановился: ${error.message}\n`);
  });
  return true;
}

module.exports = { sync, stop, running, makeTelegram, POLL_SECONDS };
