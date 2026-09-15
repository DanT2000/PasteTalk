'use strict';

/**
 * Невидимое окно, которое пишет микрофон.
 *
 * Whisper ждёт 16 кГц моно, поэтому просим у Chromium сразу такую частоту:
 * его ресемплер лучше любого, что мы написали бы руками. Шумодав и
 * эхоподавление включены — на ноутбучных микрофонах без них заметно хуже.
 */

let context = null;
let stream = null;
let node = null;
let source = null;

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

async function start(options) {
  await stop();
  try {
    stream = await openStream(options.deviceId);
  } catch (error) {
    window.recorderBridge.failed(describe(error));
    return;
  }

  // Устройство могут выдернуть или забрать посреди записи — игра, звонок,
  // смена наушников. Трек тогда кончается молча, поток отдаёт нули, и без
  // этого сигнала главный процесс три секунды ждал бы у мёртвого микрофона.
  stream.getTracks().forEach((track) => {
    track.onended = () => window.recorderBridge
      .failed('Микрофон отключился или его забрала другая программа');
  });

  try {
    context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    await context.audioWorklet.addModule('worklet.js');
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'pastetalk-collector');
    node.port.onmessage = (event) => {
      const data = event.data;
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
    await context.resume();
  } catch (error) {
    window.recorderBridge.failed(`Не удалось начать запись: ${error.message}`);
    await stop();
  }
}

async function stop() {
  try {
    if (node) { node.port.onmessage = null; node.disconnect(); }
    if (source) source.disconnect();
    // Сначала снимаем onended: штатная остановка — не авария, и сигналить
    // о ней главному процессу не нужно, даже если браузер решит иначе.
    if (stream) stream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    if (context) await context.close();
  } catch { /* закрываемся молча */ }
  node = null;
  source = null;
  stream = null;
  context = null;
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
