'use strict';

const settings = require('./settings');
const socket = require('./agent/socket');
const chains = require('./providers/chains');
const probe = require('./providers/probe');
const telegram = require('./bot/telegram');

/**
 * Сторож цепочки.
 *
 * Однажды из трёх дорог разом пропали две: домашний компьютер ушёл с линии
 * немо (сокет жив, сервер его не видит), а ключ запасного провайдера
 * перестал приниматься — и оба молчали неделями, пока человеку не ответили
 * «Тишина». Руками такое не проверяют каждый день, а сервер проверяет.
 *
 * Пишем владельцу только о переменах: сломалось — одно сообщение,
 * починилось — одно. Ровная работа сообщений не порождает, иначе их
 * перестанут читать.
 */

const TICK_MS = 5 * 60 * 1000;
// Облачных провайдеров трогаем редко: у бесплатных шлюзов считаются не
// только токены, но и сами запросы за сутки. Час — это 24 обращения в
// сутки на провайдера вместо двух сотен.
const PROBE_OK_MS = 60 * 60 * 1000;
const PROBE_BAD_MS = 15 * 60 * 1000;
// Перезагрузка компьютера или обрыв на минуту — не повод будить владельца.
const AGENT_GRACE_MS = 15 * 60 * 1000;
// Сколько терпеть молчащий опрос Telegram. Моргания на полминуты бывают
// каждый день и ничего не стоят: Telegram держит непрочитанное сутки и
// отдаёт его позже. А вот десять минут — это уже люди, которые отправили
// голосовое и не получили даже «принял».
const BOT_GRACE_MS = 10 * 60 * 1000;
// Провайдер считается упавшим со второй неудачи подряд: у шлюзов бывают
// одиночные пятисотки, и сообщать о каждой — то же, что не сообщать ни о чём.
const PROVIDER_STRIKES = 2;
// «Слишком частые запросы» — не поломка: шлюз просит подождать, а работа
// при этом уходит следующему в цепочке. Будим владельца, только если это
// держится час: тогда это уже исчерпанный лимит, а не всплеск.
const SOFT_STRIKES = 4;
// Полная проба (запрос к модели и полсекунды звука) — раз в сутки на
// провайдера: она единственная, что стоит денег, и то доли копейки.
const DEEP_EVERY_MS = 24 * 60 * 60 * 1000;
const SOFT = /\b429\b|rate.?limit|слишком часто/i;

// id проверки → { bad, since, ripe, told, strikes, downMs }
const state = new Map();
const fresh = () => ({ bad: false, since: 0, ripe: false, told: false, strikes: 0, downMs: 0 });
// id провайдера → когда его проверяли полной пробой
const deepAt = new Map();
// id провайдера → когда его можно трогать снова
const nextAt = new Map();
let timer = null;

/** Человеческая длительность: «3 мин», «2 ч 10 мин», «больше суток». */
function howLong(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} мин`;
  return `${Math.floor(hours / 24)} сут ${hours % 24} ч`;
}

async function tell(text) {
  const chat = String(settings.get('alerts.chat', '') || '').trim();
  const token = String(settings.get('bot.token', '') || '').trim();
  if (!chat || !token) return false;
  try {
    await telegram.makeTelegram(token).sendMessage(chat, text);
    // Отправленное — в журнал: иначе потом не узнать, о чём сторож писал
    // и писал ли вообще.
    process.stdout.write(`сторож: ${text}\n`);
    return true;
  } catch (error) {
    process.stderr.write(`сторож: не доставил «${text}» — ${error.message}\n`);
    return false;
  }
}

/**
 * Свести одну проверку к «цело/сломано» и сказать, если состояние
 * переменилось. grace — сколько терпеть поломку до сообщения; strikes —
 * сколько неудач подряд считать поломкой; since — когда поломка началась
 * на самом деле, если это известно точнее, чем «увидели на этом обходе».
 *
 * Про недоставленное. Сообщения сторожа идут через того же бота, и когда
 * рвётся связь с Telegram, рассказать об этом некому. Поэтому «сломалось»
 * и «сломано» мы различаем: ripe — поломка состоялась, told — о ней
 * удалось сказать. Не сказали — повторим на следующем обходе, а на
 * возврате расскажем и о поломке, и о том, что она прошла. Иначе самый
 * важный случай — упавший канал — остался бы единственным, о котором
 * сторож молчит.
 */
async function judge(id, { ok, what, error }, { grace = 0, strikes = 1, at = Date.now(), since = 0 } = {}) {
  const was = state.get(id) || fresh();

  if (ok) {
    // Либо всё время было хорошо, либо поломка не дотянула до порога —
    // рассказывать не о чем.
    if (!was.ripe) {
      state.set(id, fresh());
      return;
    }
    // Срок простоя замораживаем на первом же возврате: если доставить не
    // выйдет и сейчас, в следующем сообщении он не должен подрасти.
    const downMs = was.downMs || at - was.since;
    const sent = await tell(`✅ ${what} — снова в строю. Не работало ${howLong(downMs)}.`
      + (was.told ? '' : ' Сказать сразу не вышло: сообщения идут этим же каналом.'));
    state.set(id, sent ? fresh() : { ...was, bad: false, downMs });
    return;
  }

  const began = was.bad ? was.since : since || at;
  const count = was.strikes + 1;
  const ripe = was.ripe || (count >= strikes && at - began >= grace);
  const told = was.told || (ripe ? await tell(`⚠️ ${what} — ${error || 'не отвечает'}.`) : false);
  state.set(id, { bad: true, since: began, ripe, told, strikes: count, downMs: 0 });
}

/** Один обход. Вынесен наружу ради тестов: их не заставишь ждать пять минут. */
async function tick({ at = Date.now() } = {}) {
  const online = socket.online();
  await judge('agent', {
    ok: online,
    what: 'Домашний компьютер',
    error: 'не на связи, всё считает облако',
  }, { grace: AGENT_GRACE_MS, at });

  // Опрос Telegram. Это не провайдер и не компьютер: пока он молчит,
  // голосовые людей не доходят до сервера вовсе — ни распознавания, ни
  // ответа, ни следа в журнале работ. Проверять нечего, кроме памяти
  // самого бота: сходить и посмотреть — значит сходить через тот же
  // канал. Включённого бота не трогаем вопросом «а ты включён».
  const bot = telegram.health();
  if (bot.running) {
    await judge('bot', {
      ok: !bot.failingSince,
      what: 'Опрос Telegram',
      error: 'бот не достаёт до Telegram — голосовые людей не доходят',
    }, { grace: BOT_GRACE_MS, since: bot.failingSince, at });
  }

  // Проверяем только тех, кем сервер действительно пользуется.
  const stt = new Set(chains.sttChain());
  const llm = new Set(chains.llmChain());
  for (const id of new Set([...stt, ...llm])) {
    // Пока у провайдера всё хорошо, дёргать его чаще раза в час незачем:
    // это запасная дорога, а не рабочая, и у бесплатных шлюзов счёт идёт
    // не только токенам, но и самим запросам за сутки. Как только что-то
    // не так — смотрим вчетверо чаще: и поломку подтвердить, и возврат
    // заметить.
    if (at < (nextAt.get(id) || 0)) continue;
    // Обычная проверка — список моделей: ни токенов, ни секунд звука, ни
    // счёта. Она ловит то, ради чего сторож и заведён: отозванный ключ,
    // упавший шлюз, обрыв сети. Полная проба (фраза модели и полсекунды
    // звука) стоит копейки, но её хватает раз в сутки — заодно она не
    // долбит ключ парой одновременных запросов каждые четверть часа.
    const deep = at - (deepAt.get(id) || 0) >= DEEP_EVERY_MS;
    let result;
    try {
      if (deep) {
        deepAt.set(id, at);
        result = await probe.check(id);
      } else {
        const list = await probe.models(id);
        result = {
          stt: { ok: list.stt.length > 0, error: 'у провайдера нет речевых моделей' },
          llm: { ok: list.llm.length > 0, error: 'у провайдера нет текстовых моделей' },
        };
      }
    } catch (error) {
      result = { stt: { ok: false, error: error.message }, llm: { ok: false, error: error.message } };
    }
    const broken = [];
    if (stt.has(id) && result.stt && !result.stt.ok) broken.push(`распознавание: ${result.stt.error}`);
    if (llm.has(id) && result.llm && !result.llm.ok) broken.push(`текст: ${result.llm.error}`);
    // Отказ «подождите» и отказ «сломано» — разные вещи, и терпение к ним
    // разное.
    const soft = broken.length > 0 && broken.every((part) => SOFT.test(part));
    await judge(`provider:${id}`, {
      ok: broken.length === 0,
      what: `Облако «${id}»`,
      error: broken.join('; ')
        + (soft ? ' — это ограничение частоты, а не поломка, но держится уже час: похоже, кончился лимит' : ''),
    }, { strikes: soft ? SOFT_STRIKES : PROVIDER_STRIKES, at });
    nextAt.set(id, at + (broken.length ? PROBE_BAD_MS : PROBE_OK_MS));
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((error) => {
      process.stderr.write(`сторож споткнулся: ${error.message}\n`);
    });
  }, TICK_MS);
  // Таймер не должен держать процесс живым сам по себе.
  if (timer.unref) timer.unref();
  process.stdout.write('Сторож цепочки включён\n');
}

function stop() {
  clearInterval(timer);
  timer = null;
  state.clear();
  deepAt.clear();
  nextAt.clear();
}

module.exports = {
  start, stop, tick, judge, howLong, state,
  TICK_MS, AGENT_GRACE_MS, BOT_GRACE_MS, PROVIDER_STRIKES, SOFT_STRIKES, DEEP_EVERY_MS,
  PROBE_OK_MS, PROBE_BAD_MS,
};
