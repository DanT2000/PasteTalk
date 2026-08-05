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

async function start(options) {
  await stop();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: options.deviceId && options.deviceId !== 'default'
          ? { exact: options.deviceId }
          : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    window.recorderBridge.failed(describe(error));
    return;
  }

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
    if (stream) stream.getTracks().forEach((track) => track.stop());
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
