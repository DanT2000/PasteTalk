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
// Провайдеров трогаем реже: каждая проба — это запрос к платному шлюзу.
const PROVIDER_EVERY = 3;
// Перезагрузка компьютера или обрыв на минуту — не повод будить владельца.
const AGENT_GRACE_MS = 15 * 60 * 1000;
// Провайдер считается упавшим со второй неудачи подряд: у шлюзов бывают
// одиночные пятисотки, и сообщать о каждой — то же, что не сообщать ни о чём.
const PROVIDER_STRIKES = 2;
// «Слишком частые запросы» — не поломка: шлюз просит подождать, а работа
// при этом уходит следующему в цепочке. Будим владельца, только если это
// держится час: тогда это уже исчерпанный лимит, а не всплеск.
const SOFT_STRIKES = 4;
const SOFT = /\b429\b|rate.?limit|слишком часто/i;

// id проверки → { bad, since, told, strikes }
const state = new Map();
let timer = null;
let ticks = 0;

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
 * сколько неудач подряд считать поломкой.
 */
async function judge(id, { ok, what, error }, { grace = 0, strikes = 1, at = Date.now() } = {}) {
  const was = state.get(id) || { bad: false, since: 0, told: false, strikes: 0 };

  if (ok) {
    if (was.told) {
      await tell(`✅ ${what} — снова в строю. Не работало ${howLong(at - was.since)}.`);
    }
    state.set(id, { bad: false, since: 0, told: false, strikes: 0 });
    return;
  }

  const since = was.bad ? was.since : at;
  const count = was.strikes + 1;
  const ripe = count >= strikes && at - since >= grace;
  if (ripe && !was.told) {
    await tell(`⚠️ ${what} — ${error || 'не отвечает'}.`);
  }
  state.set(id, { bad: true, since, told: was.told || ripe, strikes: count });
}

/** Один обход. Вынесен наружу ради тестов: их не заставишь ждать пять минут. */
async function tick({ probeNow = false, at = Date.now() } = {}) {
  const online = socket.online();
  await judge('agent', {
    ok: online,
    what: 'Домашний компьютер',
    error: 'не на связи, всё считает облако',
  }, { grace: AGENT_GRACE_MS, at });

  if (!probeNow) return;

  // Проверяем только тех, кем сервер действительно пользуется.
  const stt = new Set(chains.sttChain());
  const llm = new Set(chains.llmChain());
  for (const id of new Set([...stt, ...llm])) {
    let result;
    try {
      result = await probe.check(id);
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
  }
}

function start() {
  if (timer) return;
  ticks = 0;
  timer = setInterval(() => {
    const probeNow = ticks % PROVIDER_EVERY === 0;
    ticks += 1;
    tick({ probeNow }).catch((error) => {
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
}

module.exports = {
  start, stop, tick, howLong, state,
  TICK_MS, AGENT_GRACE_MS, PROVIDER_STRIKES, SOFT_STRIKES,
};
