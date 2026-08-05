'use strict';

const config = require('./config');
const log = require('./logger').scoped('remote');

/**
 * Распознавание не здесь, а снаружи.
 *
 * Нужно тем, у кого нет видеокарты: на процессоре Whisper жуёт минуту речи
 * около минуты, и диктовка перестаёт быть быстрее печати — то есть теряет
 * весь смысл.
 *
 * Три адресата, и разница между ними только в том, кто платит:
 *   server — сервер PasteTalk по коду доступа. Платит владелец сервера.
 *   cloud  — облако по своему ключу. Платит сам человек.
 *   local  — сюда не попадает, это работа движка на своей машине.
 */

const SAMPLE_RATE = 16000;

const CLOUD = {
  aitunnel: {
    title: 'AITunnel',
    baseUrl: 'https://api.aitunnel.ru/v1',
    defaultModel: 'whisper-large-v3-turbo',
    needsKey: true,
    hint: 'Ключ берётся на aitunnel.ru',
  },
  openai: {
    title: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'whisper-1',
    needsKey: true,
    hint: 'Ключ берётся в личном кабинете OpenAI',
  },
  custom: {
    title: 'Своё, OpenAI-совместимое',
    baseUrl: '',
    defaultModel: 'whisper-1',
    needsKey: false,
    hint: 'Любой сервер с /v1/audio/transcriptions',
  },
};

/** Где считать. Всё остальное в этом модуле имеет смысл, только если не local. */
function where() {
  return config.get('recognition.where', 'local');
}

function isRemote() {
  return where() !== 'local';
}

/**
 * Обернуть сырой звук в WAV.
 *
 * Движок принимает поток и режет его сам, а любому чужому распознавателю
 * нужен файл целиком и с заголовком — иначе он не поймёт ни частоту, ни
 * разрядность.
 */
function toWav(pcm) {
  const header = Buffer.alloc(44);
  const bytesPerSecond = SAMPLE_RATE * 2;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // длина блока формата
  header.writeUInt16LE(1, 20);           // PCM без сжатия
  header.writeUInt16LE(1, 22);           // моно
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(bytesPerSecond, 28);
  header.writeUInt16LE(2, 32);           // выравнивание кадра
  header.writeUInt16LE(16, 34);          // бит на отсчёт
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function timeoutFor(bytes) {
  const seconds = bytes / (SAMPLE_RATE * 2);
  // Минута звука редко считается дольше десяти секунд, но сеть бывает
  // всякая. Полминуты сверху на дорогу, и минимум минута на всё про всё.
  return Math.max(60000, Math.round(seconds * 3000) + 30000);
}

// ---------- через сервер PasteTalk ----------

function serverBase() {
  return String(config.get('recognition.serverUrl', '')).trim()
    .replace(/\/+$/, '')
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:');
}

/** Обменять шесть цифр на постоянный токен. Делается один раз. */
async function pair(code) {
  const base = serverBase();
  if (!base) return { ok: false, error: 'Сначала укажите адрес сервера' };
  try {
    const response = await fetch(`${base}/v1/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: String(code || '').trim(),
        kind: 'desktop',
        title: require('node:os').hostname(),
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: data.error || `Сервер ответил ${response.status}` };
    config.set({ recognition: { serverToken: data.token } });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Не достучались до сервера: ${error.message}` };
  }
}

async function viaServer(pcm) {
  const base = serverBase();
  const token = config.get('recognition.serverToken', '');
  if (!base) throw new Error('Не указан адрес сервера');
  if (!token) throw new Error('Код доступа не введён');

  const response = await fetch(`${base}/v1/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      audio: toWav(pcm).toString('base64'),
      filename: 'voice.wav',
      language: config.get('language', 'ru') === 'auto' ? null : config.get('language', 'ru'),
    }),
    signal: AbortSignal.timeout(timeoutFor(pcm.length)),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error('Доступ отозван — введите код заново');
  if (!response.ok) throw new Error(data.error || `Сервер ответил ${response.status}`);
  return { text: (data.text || '').trim(), durationS: data.seconds || 0 };
}

// ---------- через облако по своему ключу ----------

async function viaCloud(pcm) {
  const id = config.get('recognition.cloudProvider', 'aitunnel');
  const preset = CLOUD[id] || CLOUD.aitunnel;
  const base = (config.get('recognition.cloudUrl', '') || preset.baseUrl).replace(/\/+$/, '');
  const key = config.get('recognition.cloudKey', '');
  const model = config.get('recognition.cloudModel', '') || preset.defaultModel;

  if (!base) throw new Error(`Для ${preset.title} не задан адрес`);
  if (preset.needsKey && !key) throw new Error(`Для ${preset.title} не задан ключ`);

  const form = new FormData();
  form.set('file', new Blob([toWav(pcm)], { type: 'audio/wav' }), 'voice.wav');
  form.set('model', model);
  form.set('response_format', 'verbose_json');
  const language = config.get('language', 'ru');
  if (language && language !== 'auto') form.set('language', language);

  const response = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: form,
    signal: AbortSignal.timeout(timeoutFor(pcm.length)),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${preset.title} ответил ${response.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`);
  }
  const data = await response.json();
  return { text: (data.text || '').trim(), durationS: Number(data.duration || 0) };
}

/** Распознать накопленный звук там, куда указано в настройках. */
async function transcribe(pcm) {
  if (!pcm || pcm.length === 0) return { text: '', durationS: 0 };
  const started = Date.now();
  const result = where() === 'server' ? await viaServer(pcm) : await viaCloud(pcm);
  log.info(`распознано снаружи (${where()}) за ${Date.now() - started} мс, символов ${result.text.length}`);
  return result;
}

/** Проверить связь, не диктуя: полсекунды тишины — дёшево и наглядно. */
async function check() {
  const silence = Buffer.alloc(SAMPLE_RATE);
  try {
    await transcribe(silence);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { isRemote, where, transcribe, pair, check, toWav, CLOUD, SAMPLE_RATE };
