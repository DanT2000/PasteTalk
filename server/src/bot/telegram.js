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

/**
 * Сетевая икота, а не отказ.
 *
 * Дорога до Telegram идёт через прокси и моргает по нескольку раз в час:
 * «fetch failed», оборванный сокет, пятьсот второй от шлюза. Это не повод
 * бросать работу человека — повод повторить через секунду. Отказ самого
 * Telegram («chat not found», «message is not modified») повторять нельзя:
 * он будет таким же и на третий раз.
 */
function wobble(error) {
  const text = String((error && error.message) || '');
  // «Conflict: terminated by other getUpdates request» — это не сеть, а
  // вторая копия бота. Повторять бессмысленно, и слово «terminated» здесь
  // чужое: у сетевого обрыва undici оно стоит одно.
  if (/^Conflict\b/i.test(text)) return false;
  return /fetch failed|aborted|terminated|socket|network|ECONN|ETIMEDOUT|EAI_AGAIN|EPIPE|Bad Gateway|Service Unavailable|Gateway Time-?out|502|503|504/i
    .test(text);
}

const NET_TRIES = 3;
// Столько раз ждём одно и то же сообщение, прежде чем шагнуть дальше.
const UPDATE_TRIES = 3;

/**
 * Дорога до Telegram: через прокси, а если он не пускает — напрямую.
 *
 * Прокси — чужой канал, и он падает. 31 октября он не пускал к Telegram
 * четыре с половиной часа, и бот всё это время молчал, хотя сам Telegram
 * работал: люди отправляли голосовые в пустоту. Поэтому на сетевом сбое
 * пробуем прямую дорогу. Видит сервер Telegram сам — бот работает дальше
 * как ни в чём не бывало; не видит (ради этого прокси и заводят) — прямая
 * попытка не удастся, и мы вернёмся к той же ошибке, что и раньше.
 *
 * Прямую дорогу держим десять минут, потом снова пробуем прокси: он
 * быстрее и это его работа.
 *
 * make() собирает параметры заново на каждую попытку: AbortSignal
 * одноразовый, и повтор с уже сработавшим упал бы сразу.
 */
const DIRECT_MS = 10 * 60 * 1000;
let directUntil = 0;
let directSaid = 0;

async function reach(where, make) {
  const bypass = Date.now() < directUntil;
  try {
    return await fetch(where, bypass ? make() : proxy.through('telegram', make()));
  } catch (error) {
    if (bypass || !wobble(error) || !proxy.usedFor('telegram')) throw error;
    let response;
    try {
      response = await fetch(where, make());
    } catch {
      // Напрямую тоже нельзя — значит дело не в прокси. Рассказываем о
      // первой ошибке: она про настоящий канал бота.
      throw error;
    }
    directUntil = Date.now() + DIRECT_MS;
    if (Date.now() - directSaid > DIRECT_MS) {
      directSaid = Date.now();
      say(`бот: прокси не пускает (${proxy.reason(error)}) — иду к Telegram напрямую`);
    }
    return response;
  }
}

async function api(token, method, body, { tries = NET_TRIES } = {}) {
  const make = () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    // Опрос висит до POLL_SECONDS, поэтому ждём с запасом.
    signal: AbortSignal.timeout((POLL_SECONDS + 15) * 1000),
  });
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const response = await reach(`${API}/bot${token}/${method}`, make);
      const data = await response.json();
      if (!data.ok) throw new Error(data.description || `Telegram ответил ${response.status}`);
      return data.result;
    } catch (error) {
      last = error;
      if (attempt >= tries || !wobble(error)) throw error;
      await new Promise((wait) => setTimeout(wait, 700 * attempt));
    }
  }
  throw last;
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
      let last;
      for (let attempt = 1; attempt <= NET_TRIES; attempt++) {
        try {
          const response = await reach(`${API}/file/bot${token}/${file.file_path}`,
            () => ({ signal: AbortSignal.timeout(120000) }));
          if (!response.ok) throw new Error(`не скачалось, ${response.status}`);
          return Buffer.from(await response.arrayBuffer());
        } catch (error) {
          last = error;
          if (attempt >= NET_TRIES || !wobble(error)) throw error;
          await new Promise((wait) => setTimeout(wait, 700 * attempt));
        }
      }
      throw last;
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
  while (!state.stop) {
    let updates;
    try {
      // Опрос не повторяем внутри: он и так в цикле, а лишние попытки
      // только задержали бы строку о сбое в журнале.
      updates = await api(state.token, 'getUpdates', {
        offset: state.offset,
        timeout: POLL_SECONDS,
        allowed_updates: ['message', 'callback_query'],
      }, { tries: 1 });
      // Об успехе тоже говорим — один раз после каждой полосы неудач, и со
      // сроком: молчащий при успехе бот неотличим в журнале от давно
      // умершего, а без срока не видно, сколько люди ждали ответа.
      if (state.failingSince) {
        const down = Date.now() - state.failingSince;
        state.failingSince = 0;
        say(down > 60000
          ? `бот: опрос работает — не работал ${Math.round(down / 60000)} мин`
          : 'бот: опрос работает');
      }
    } catch (error) {
      if (state.stop) return;
      if (!state.failingSince) state.failingSince = Date.now();
      // «fetch failed» само по себе не говорит ничего: настоящую причину
      // (ECONNREFUSED, ETIMEDOUT, 407 от прокси) undici прячет в цепочке
      // cause. Раскручиваем — иначе четыре часа журнала ни о чём.
      say(`бот: опрос не удался — ${proxy.reason(error)}`);
      // Пауза, чтобы при недоступном Telegram не молотить запросами.
      await new Promise((wait) => setTimeout(wait, 5000));
      continue;
    }

    if (await runUpdates(state, updates, tg)) return;
  }
}

/**
 * Обработать пачку обновлений, не теряя ни одного.
 *
 * Смещение сдвигается ТОЛЬКО после того, как сообщение обработано. Раньше
 * оно сдвигалось до обработки, и голосовое, попавшее в моргнувшую сеть,
 * пропадало навсегда: Telegram считал его доставленным, а человек не
 * получал даже ответа об ошибке. Теперь при сетевом сбое смещение остаётся
 * на месте, и Telegram принесёт это же сообщение снова. Вечно пробовать
 * нельзя — после трёх попыток шагаем дальше, чтобы одно битое сообщение не
 * заперло очередь всем остальным.
 *
 * Возвращает true, если пора остановиться.
 */
async function runUpdates(state, updates, tg) {
  for (const update of updates) {
    if (state.stop) return true;
    try {
      await handlers.handle(update, { tg, queue });
    } catch (error) {
      const again = state.retry && state.retry.id === update.update_id ? state.retry.n + 1 : 1;
      state.retry = { id: update.update_id, n: again };
      if (wobble(error) && again < UPDATE_TRIES) {
        say(`бот: сообщение не обработано (попытка ${again}) — ${error.message}; жду его снова`);
        await new Promise((wait) => setTimeout(wait, 2000));
        return false;
      }
      say(`бот: сообщение пропущено после ${again} попыток — ${error.message}`);
    }
    state.offset = update.update_id + 1;
    settings.set('bot.offset', state.offset);
    state.retry = null;
  }
  return false;
}

function running() {
  return Boolean(live);
}

/**
 * Разовая разведка на запуске: виден ли Telegram без прокси.
 *
 * От этого зависит, спасёт ли обход упавшего прокси. По живому опросу
 * этого не узнать — он идёт так, как настроено, — а знать надо: если
 * Telegram виден напрямую, падение прокси бот переживёт сам; если не
 * виден, прокси незаменим, и его падение — это молчащий бот. Один запрос
 * на запуск, без токена и без данных.
 */
async function scout() {
  if (!proxy.usedFor('telegram')) return;
  try {
    const response = await fetch(`${API}/`, { signal: AbortSignal.timeout(10000) });
    await response.body?.cancel().catch(() => {});
    say(`бот: Telegram виден и без прокси (${response.status}) — упадёт прокси, пойду напрямую`);
  } catch (error) {
    say(`бот: без прокси Telegram не виден (${proxy.reason(error)}) — прокси незаменим`);
  }
}

/**
 * Как дела у опроса — для сторожа.
 *
 * Пока бот не достаёт до Telegram, сообщения людей до сервера не доходят
 * вовсе, и человек узнаёт об этом только от самих людей. Сказать во время
 * обрыва некому — сторож пишет тем же каналом; значит, надо хотя бы
 * помнить, с какого момента всё плохо, и рассказать, когда связь вернётся.
 */
function health() {
  return { running: Boolean(live), failingSince: (live && live.failingSince) || 0 };
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
  live = {
    token, route, offset: Number(settings.get('bot.offset', 0)) || 0, stop: false,
    // С этого мгновения опрос ещё не удавался ни разу: до первого успеха
    // считаем, что связи нет.
    failingSince: Date.now(),
  };
  loop(live).catch((error) => {
    process.stderr.write(`бот остановился: ${error.message}\n`);
  });
  // Разведку не ждём: опрос должен начаться сразу, а её ответ нужен не ему.
  scout().catch(() => {});
  return true;
}

module.exports = {
  sync, stop, running, health, makeTelegram, runUpdates, wobble, reach,
  POLL_SECONDS, UPDATE_TRIES, DIRECT_MS,
};
