'use strict';

const socket = require('./socket');
const chains = require('../providers/chains');
const stt = require('../providers/stt');
const llm = require('../providers/llm');
const prompts = require('../prompts');
const settings = require('../settings');

/**
 * Кому отдать задачу.
 *
 * Компьютер держит одну модель в видеопамяти, поэтому берёт диктовки по
 * одной. Если очередь к нему растянулась, задача уходит в облако: копейки
 * дешевле, чем человек, сидящий перед пустым экраном.
 *
 * Важно, что отмеряется именно ОЖИДАНИЕ В ОЧЕРЕДИ, а не работа. Две
 * минуты речи распознаются на видеокарте дольше тридцати секунд, и если
 * считать общее время, в облако уходила бы каждая длинная диктовка —
 * при полностью свободном и исправном компьютере. Это молча стоило бы
 * денег каждый день.
 */

const SPILL_MS = 30 * 1000;

// Очередь у каждой машины своя: одна держит одну модель, но две машины —
// это два одновременных распознавания.
const tails = new Map();

/**
 * Поставить задачу в хвост очереди к агенту.
 *
 * Возвращает две вещи: `started` — обещание, что до задачи дошла очередь,
 * и `done` — обещание результата. Первое нужно, чтобы отличать ожидание
 * от работы. Есть и `abandon()`: если задачу уже отдали облаку, будить
 * ради неё видеокарту незачем.
 */
function throughAgent(job, agentId = 0) {
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let abandoned = false;

  const run = () => {
    markStarted();
    if (abandoned) return undefined;
    return job();
  };

  const tail = tails.get(agentId) || Promise.resolve();
  const done = tail.then(run, run);
  // Хвост не должен обрываться из-за одной упавшей задачи, иначе
  // следующий диктующий не дождётся своей очереди никогда.
  tails.set(agentId, done.then(() => {}, () => {}));

  return { started, done, abandon: () => { abandoned = true; } };
}

/**
 * Прогнать задачу по машинам в порядке опроса.
 *
 * Ожидание отмеряется отдельно для каждой: не взялась первая за
 * SPILL_MS — идём ко второй, и только когда кончились все, отдаём
 * задачу облаку. Это и есть «минимальное время ожидания».
 */
async function throughAgents(makeJob, cloudJob, spill) {
  const machines = socket.onlineAgents();
  let lastError = new Error('ПК не на связи');

  for (const machine of machines) {
    const attempt = throughAgent(() => makeJob(machine.id), machine.id);
    try {
      if (!spill) return await attempt.done;

      // Ждём, когда машина возьмётся за дело, но не дольше предела.
      // Не взялась — бросаем её и идём к следующей: у каждой машины своё
      // ожидание, в этом и смысл порядка.
      const took = await Promise.race([
        attempt.started.then(() => true),
        new Promise((resolve) => { setTimeout(() => resolve(false), SPILL_MS); }),
      ]);
      if (!took) {
        attempt.abandon();
        // Хвост её очереди не должен взорваться позже, когда до брошенной
        // задачи дойдёт дело, — гасим отказ заранее.
        attempt.done.catch(() => {});
        lastError = new Error('ПК не ответил вовремя');
        continue;
      }
      return await attempt.done;
    } catch (error) {
      lastError = error;
    }
  }

  if (cloudJob) return cloudJob();
  throw lastError;
}

/**
 * Дождаться, когда агент возьмётся за дело, но не дольше предела.
 * Не взялся — отдаём облаку. Взялся — ждём столько, сколько нужно.
 */
function withSpill(makeAgentJob, cloudJob, ms = SPILL_MS) {
  const attempt = makeAgentJob();

  return new Promise((resolve, reject) => {
    let settled = false;
    // Отдельно от settled: облако ещё считает, но агент уже брошен, и его
    // ответ принимать нельзя. Без этого дождавшаяся очереди брошенная
    // задача возвращала undefined и роняла того, кто её ждал.
    let spilled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      spilled = true;
      attempt.abandon();
      cloudJob().then((value) => finish(resolve, value), (error) => finish(reject, error));
    }, ms);

    attempt.started.then(() => {
      clearTimeout(timer);
      if (settled || spilled) return;
      attempt.done.then(
        (value) => finish(resolve, value),
        // Агент сорвался уже в работе — это не повод показывать человеку
        // ошибку, пока есть облако.
        () => cloudJob().then((value) => finish(resolve, value), (error) => finish(reject, error)),
      );
    });
  });
}

function spillAllowed() {
  return settings.get('spillToCloud', true) !== false;
}

async function transcribe({ audio, filename, language, clientSeconds, prompt = '' }) {
  const cloud = async () => ({
    ...await chains.run(
      chains.sttChain(),
      (id) => stt.transcribe(id, { audio, filename, language, clientSeconds, prompt }),
      'распознаванием',
    ),
    executedBy: 'cloud',
  });

  const job = async (agentId) => ({
    ...await socket.sendTo(agentId, {
      kind: 'stt',
      // prompt — словарь специфики того, кто диктует. Старые агенты поле
      // просто не заметят.
      payload: { audio: audio.toString('base64'), filename, language, prompt },
    }),
    executedBy: 'agent',
  });

  // «Никогда не тратить деньги» должно значить именно это.
  if (!spillAllowed()) return throughAgents(job, null, false);
  if (!socket.online()) return cloud();
  // Облака может не быть вовсе — тогда ждём машины, сколько нужно.
  if (!chains.sttChain().length) return throughAgents(job, null, false);
  return throughAgents(job, cloud, true);
}

async function improve({ text, mode }) {
  const cloud = async () => ({
    ...await chains.run(
      chains.llmChain(),
      (id) => llm.improve(id, { text, mode }),
      'улучшением текста',
    ),
    executedBy: 'cloud',
  });

  const job = async (agentId) => ({
    // Инструкцию собирает сервер: промпт мог быть правлен в админке, а
    // приложение на компьютере про это знать не обязано. Старые версии
    // приложения поле просто не заметят и соберут промпт сами.
    ...await socket.sendTo(agentId, {
      kind: 'llm',
      payload: { text, mode, instruction: prompts.instructionFor(mode) },
    }),
    executedBy: 'agent',
  });

  if (!spillAllowed()) return throughAgents(job, null, false);
  if (!socket.online()) return cloud();
  if (!chains.llmChain().length) return throughAgents(job, null, false);
  return throughAgents(job, cloud, true);
}

module.exports = { transcribe, improve, throughAgent, throughAgents, withSpill, SPILL_MS };
