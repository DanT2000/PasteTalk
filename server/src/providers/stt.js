'use strict';

const { CLOUD } = require('../../../shared/providers');
const settings = require('../settings');
const proxy = require('../proxy');

/**
 * Распознавание речи облаком: обычный OpenAI-совместимый
 * /audio/transcriptions. Whisper у всех шлюзов зовётся одинаково, поэтому
 * отдельного кода под каждого провайдера не нужно.
 */

// Пять минут: расшифровка получаса звука за секунду не делается, а обрыв
// на середине означал бы, что деньги списаны, а текста нет.
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Сколько секунд звука в файле.
 *
 * Провайдер длительность возвращать не обязан — AITunnel её не шлёт, и
 * без своей оценки весь расход считался бы нулём. Для WAV читаем
 * заголовок, для прочего верим тому, что сказал клиент.
 */
function seconds(audio, fromProvider, fromClient) {
  if (fromProvider > 0) return fromProvider;
  if (audio.length > 44 && audio.toString('ascii', 0, 4) === 'RIFF') {
    const bytesPerSecond = audio.readUInt32LE(28);
    if (bytesPerSecond > 0) return (audio.length - 44) / bytesPerSecond;
  }
  return Number(fromClient) > 0 ? Number(fromClient) : 0;
}

async function transcribe(providerId, { audio, filename, language, clientSeconds, prompt = '' }) {
  const preset = CLOUD[providerId];
  if (!preset) throw new Error(`Провайдер ${providerId} неизвестен`);

  // «||», а не значение по умолчанию из get(): форма сохраняет пустую
  // строку как «стандартная модель», и get() вернул бы именно пустоту.
  const baseUrl = settings.get(`url.${providerId}`, '') || preset.baseUrl;
  if (!baseUrl) throw new Error(`Для ${preset.title} не задан адрес`);
  const key = settings.get(`key.${providerId}`, '');
  if (preset.needsKey && !key) throw new Error(`Для ${preset.title} не задан ключ`);
  const model = settings.get(`model.stt.${providerId}`, '') || preset.defaultSttModel || 'whisper-1';

  const form = new FormData();
  // .oga шлюзы отвергают, хотя это тот же ogg: у них список расширений, а
  // не разбор содержимого. Telegram отдаёт голосовые именно как .oga —
  // проверено, тот же звук под .ogg проходит, под .oga даёт 400.
  const safeName = String(filename || 'voice.ogg').replace(/\.oga$/i, '.ogg');
  form.set('file', new Blob([audio]), safeName);
  form.set('model', model);
  if (language) form.set('language', language);
  // Словарь специфики диктующего: /audio/transcriptions понимает prompt,
  // остальные молча игнорируют.
  if (prompt) form.set('prompt', prompt);
  // verbose_json — ради длительности: по ней считается стоимость.
  form.set('response_format', 'verbose_json');

  const response = await fetch(`${baseUrl}/audio/transcriptions`, proxy.through(providerId, {
    method: 'POST',
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  if (!response.ok) throw new Error(`${preset.title} ответил ${response.status}`);

  const data = await response.json();
  return {
    text: (data.text || '').trim(),
    seconds: seconds(audio, Number(data.duration || 0), clientSeconds),
    model,
  };
}

module.exports = { transcribe, seconds };
