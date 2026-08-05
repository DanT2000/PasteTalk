'use strict';

const socket = require('./socket');
const chains = require('../providers/chains');
const stt = require('../providers/stt');
const llm = require('../providers/llm');
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

let tail = Promise.resolve();

/**
 * Поставить задачу в хвост очереди к агенту.
 *
 * Возвращает две вещи: `started` — обещание, что до задачи дошла очередь,
 * и `done` — обещание результата. Первое нужно, чтобы отличать ожидание
 * от работы. Есть и `abandon()`: если задачу уже отдали облаку, будить
 * ради неё видеокарту незачем.
 */
function throughAgent(job) {
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let abandoned = false;

  const run = () => {
    markStarted();
    if (abandoned) return undefined;
    return job();
  };

  const done = tail.then(run, run);
  // Хвост не должен обрываться из-за одной упавшей задачи, иначе
  // следующий диктующий не дождётся своей очереди никогда.
  tail = done.then(() => {}, () => {});

  return { started, done, abandon: () => { abandoned = true; } };
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

async function transcribe({ audio, filename, language, clientSeconds }) {
  const cloud = async () => ({
    ...await chains.run(
      chains.sttChain(),
      (id) => stt.transcribe(id, { audio, filename, language, clientSeconds }),
      'распознаванием',
    ),
    executedBy: 'cloud',
  });

  const agent = () => throughAgent(async () => ({
    ...await socket.send({
      kind: 'stt',
      payload: { audio: audio.toString('base64'), filename, language },
    }),
    executedBy: 'agent',
  }));

  // «Никогда не тратить деньги» должно значить именно это: ни когда ПК
  // выключен, ни когда задача на нём сорвалась.
  if (!spillAllowed()) return agent().done;
  if (!socket.online()) return cloud();
  return withSpill(agent, cloud);
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

  const agent = () => throughAgent(async () => ({
    ...await socket.send({ kind: 'llm', payload: { text, mode } }),
    executedBy: 'agent',
  }));

  if (!spillAllowed()) return agent().done;
  if (!socket.online()) return cloud();
  return withSpill(agent, cloud);
}

module.exports = { transcribe, improve, throughAgent, withSpill, SPILL_MS };
