'use strict';

/**
 * Невидимое окно, которое пишет микрофон.
 *
 * Whisper ждёт 16 кГц моно, поэтому просим у Chromium сразу такую частоту:
 * его ресемплер лучше любого, что мы написали бы руками. Шумодав и
 * эхоподавление включены — на ноутбучных микрофонах без них заметно хуже.
 */

/**
 * Поколение записи: его двигает каждый запуск и каждая остановка.
 *
 * Запуск и остановка — обе асинхронные, и шли они по общим переменным.
 * Остановка ждёт закрытия звукового контекста, а когда дожидалась —
 * обнуляла переменные, в которых лежала уже СЛЕДУЮЩАЯ запись. 11 ноября
 * человек трижды подряд нажал запись и получил «Не удалось начать запись:
 * Cannot read properties of null». Теперь у каждой записи свой номер: чужая
 * остановка гасит только своё, а запуск, которого уже отменили, сворачивается
 * сам и не оставляет открытый микрофон.
 */
let era = 0;
/** Что пишет прямо сейчас: поток, контекст и узлы одной записи. */
let live = null;

/** Сколько ждать первого куска звука, прежде чем пересобрать цепочку. */
const FIRST_SOUND_MS = 900;
/** Сколько раз собирать цепочку, если звук так и не пошёл. */
const SOUND_ROUNDS = 2;

/**
 * Открыть микрофон — с повторами.
 *
 * Звуковая подсистема Chromium после загрузки Windows порой держит
 * устаревший список устройств: «по умолчанию» указывает на то, чего уже
 * нет, и getUserMedia раз за разом отвечает OverconstrainedError, пока
 * список не перечитают. Человеку приходилось выбирать в настройках другой
 * микрофон и возвращать «по умолчанию». Теперь перечитываем сами: список
 * устройств, затем устройство по умолчанию напрямую, затем без обработки.
 * Выбранного микрофона нет — пишем с микрофона по умолчанию, а не молчим.
 */
async function openStream(deviceId) {
  const processing = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const chosen = deviceId && deviceId !== 'default' ? deviceId : '';
  const failures = [];
  let first = null;

  const attempt = async (label, audio) => {
    try {
      const opened = await navigator.mediaDevices.getUserMedia({ audio });
      if (failures.length) {
        window.recorderBridge.note(`открыт не с первой попытки (${failures.join('; ')}) — записываю: ${label}`);
      }
      return opened;
    } catch (error) {
      if (!first) first = error;
      failures.push(`${label}: ${error.name}`);
      // Доступ запрещён — повторы не помогут, говорим сразу.
      if (error.name === 'NotAllowedError') throw error;
      return null;
    }
  };

  let opened = null;
  if (chosen) opened = await attempt('выбранный микрофон', { ...processing, deviceId: { exact: chosen } });
  if (!opened && !chosen) opened = await attempt('по умолчанию', { ...processing });
  if (!opened) {
    let inputs = [];
    try {
      inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    } catch { /* перечитать не вышло — пробуем как есть */ }
    if (chosen && inputs.some((d) => d.deviceId === chosen)) {
      opened = await attempt('выбранный, после обновления списка', { ...processing, deviceId: { exact: chosen } });
    }
    if (!opened) {
      // «По умолчанию» — псевдоним; настоящее устройство с тем же groupId.
      const alias = inputs.find((d) => d.deviceId === 'default');
      const real = alias && inputs.find((d) => d.groupId === alias.groupId
        && d.deviceId !== 'default' && d.deviceId !== 'communications');
      if (real) opened = await attempt('устройство по умолчанию напрямую', { ...processing, deviceId: { exact: real.deviceId } });
    }
    if (!opened) opened = await attempt('по умолчанию, после обновления списка', { ...processing });
    if (!opened) opened = await attempt('без обработки звука', true);
  }
  if (!opened) throw first;
  return opened;
}

// Ошибки «устройства нет». После пробуждения и загрузки Windows звуковой
// список приходит с опозданием, и первый запрос упирается в пустоту.
const MISSING = new Set(['NotFoundError', 'OverconstrainedError']);
// Паузы между попытками: около шести секунд всего. Секунды, как было до
// 11 ноября, не хватало — человек трижды за три дня получал «Микрофон не
// найден» на первой же записи после пробуждения компьютера.
const WAIT_STEPS = [300, 600, 900, 1200, 1500, 1500];

/**
 * Подождать микрофон, если список устройств ещё не подъехал.
 *
 * 31 октября в 6:36 диктовка умерла в тот же миг, когда началась: Windows
 * только проснулась, Chromium не видел ни одного входа, и вся цепочка
 * попыток отработала впустую за один тик. Ждать не страшно — рекордер
 * спокойно ждёт первого звука минутами, — но молчать нельзя: пока ищем,
 * панель обязана сказать об этом, иначе человек говорит в пустоту и
 * думает, что пишется.
 */
async function openWaiting(deviceId) {
  const started = Date.now();
  let told = false;
  for (let attempt = 1; ; attempt++) {
    try {
      const opened = await openStream(deviceId);
      if (told) {
        window.recorderBridge.waiting(false);
        window.recorderBridge.note(`микрофон появился не сразу — открыт с ${attempt}-й попытки`
          + ` за ${Date.now() - started} мс`);
      }
      return opened;
    } catch (error) {
      const pause = WAIT_STEPS[attempt - 1];
      if (!MISSING.has(error.name) || pause === undefined) {
        if (told) window.recorderBridge.waiting(false);
        throw error;
      }
      if (!told) { told = true; window.recorderBridge.waiting(true); }
      await new Promise((wait) => setTimeout(wait, pause));
    }
  }
}

/** Погасить ровно этот набор — свой у каждой записи. */
async function shut(what) {
  if (!what) return;
  try {
    if (what.node) { what.node.port.onmessage = null; what.node.disconnect(); }
    if (what.source) what.source.disconnect();
    // Сначала снимаем обработчики: штатная остановка — не авария, и
    // сигналить о ней главному процессу не нужно, даже если браузер решит
    // иначе.
    if (what.stream) {
      what.stream.getTracks().forEach((track) => {
        track.onended = null;
        track.onmute = null;
        track.onunmute = null;
        track.stop();
      });
    }
    if (what.context) await what.context.close();
  } catch { /* закрываемся молча */ }
}

/**
 * Собрать цепочку: поток с микрофона → рабочий поток → немой выход.
 *
 * После каждого ожидания сверяем поколение: пока мы открывали микрофон
 * или грузили worklet, человек мог нажать «отмена» или начать запись
 * заново. Тогда сворачиваемся и гасим за собой, чтобы микрофон не остался
 * открытым (лампочка в трее и «устройство занято» в других программах).
 */
async function build(deviceId, mine) {
  const stream = await openWaiting(deviceId);
  if (mine !== era) { await shut({ stream }); return null; }

  const context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
  await context.audioWorklet.addModule('worklet.js');
  if (mine !== era) { await shut({ stream, context }); return null; }

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'pastetalk-collector');
  const made = { stream, context, source, node, heard: false };
  node.port.onmessage = (event) => {
    const data = event.data;
    made.heard = true;
    if (data.type === 'chunk') window.recorderBridge.chunk(data.pcm, data.peak);
    else if (data.type === 'level') window.recorderBridge.level(data.level);
  };
  source.connect(node);
  // Подключаем к выходу через немой усилитель: без пути до destination
  // Chromium может усыпить граф, и звук перестанет идти.
  const mute = context.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(context.destination);

  // Устройство могут выдернуть или забрать посреди записи — игра, звонок,
  // смена наушников. Трек тогда кончается молча, поток отдаёт нули, и без
  // этого сигнала главный процесс три секунды ждал бы у мёртвого микрофона.
  stream.getTracks().forEach((track) => {
    track.onended = () => window.recorderBridge
      .failed('Микрофон отключился или его забрала другая программа');
    // Замолчавшее устройство — не авария: так ведут себя микрофоны,
    // которые ещё просыпаются. Запись не рвём, но в журнал пишем.
    track.onmute = () => window.recorderBridge.note('устройство замолчало посреди записи');
    track.onunmute = () => window.recorderBridge.note('устройство снова даёт звук');
  });

  await context.resume();
  if (mine !== era) { await shut(made); return null; }
  return made;
}

/** Дождаться первого куска звука. Пришёл — цепочка живая. */
async function sounded(what, ms) {
  const until = Date.now() + ms;
  while (!what.heard && Date.now() < until) {
    await new Promise((wait) => setTimeout(wait, 50));
  }
  return what.heard;
}

/** Почему звука нет — словами, в журнал. */
function why(what) {
  const track = what.stream.getAudioTracks()[0];
  const bits = [`контекст ${what.context.state}`];
  if (!track) bits.push('дорожки нет вовсе');
  else bits.push(`дорожка ${track.readyState}${track.muted ? ', молчит' : ''}`, track.label || 'без имени');
  return bits.join(', ');
}

/**
 * Начать запись.
 *
 * Цепочка бывает собрана без единой ошибки, а звук по ней не идёт: так
 * случилось 11 ноября в 9:56 — микрофон открылся, и четыре секунды тишины
 * спустя запись умерла с «звук перестал приходить». Поэтому ждём первый
 * кусок и, если его нет, пересобираем цепочку заново — это чинит ровно тот
 * случай, когда звуковая подсистема отдала мёртвый поток.
 */
async function start(options) {
  await stop();
  const mine = ++era;

  for (let round = 1; round <= SOUND_ROUNDS; round++) {
    let what = null;
    try {
      what = await build(options.deviceId, mine);
    } catch (error) {
      window.recorderBridge.failed(describe(error));
      return;
    }
    if (!what) return;               // запись успели отменить
    live = what;

    if (await sounded(what, FIRST_SOUND_MS)) return;
    if (mine !== era) return;        // отменили, пока ждали звук

    if (round >= SOUND_ROUNDS) {
      window.recorderBridge.note(`звук так и не пошёл (${why(what)}) — жду дальше, запись не трогаю`);
      return;
    }
    window.recorderBridge.note(`звук не пошёл за ${FIRST_SOUND_MS} мс (${why(what)}) — пересобираю цепочку`);
    live = null;
    await shut(what);
    if (mine !== era) return;
  }
}

async function stop() {
  era += 1;
  const what = live;
  live = null;
  await shut(what);
}

function describe(error) {
  if (error.name === 'NotAllowedError') return 'Windows не разрешила доступ к микрофону';
  if (error.name === 'NotFoundError') return 'Микрофон не найден';
  if (error.name === 'NotReadableError') return 'Микрофон занят другой программой';
  if (error.name === 'OverconstrainedError') return 'Выбранный микрофон недоступен — возьмите другой в настройках';
  return error.message || 'Микрофон недоступен';
}

window.recorderBridge.onStart(start);
window.recorderBridge.onStop(stop);
