'use strict';

const { CLOUD } = require('../../../shared/providers');
const settings = require('../settings');

/**
 * Распознавание речи облаком: обычный OpenAI-совместимый
 * /audio/transcriptions. Whisper у всех шлюзов зовётся одинаково, поэтому
 * отдельного кода под каждого провайдера не нужно.
 */

// Пять минут: расшифровка получаса звука за секунду не делается, а обрыв
// на середине означал бы, что деньги списаны, а текста нет.
const TIMEOUT_MS = 5 * 60 * 1000;

async function transcribe(providerId, { audio, filename, language }) {
  const preset = CLOUD[providerId];
  if (!preset) throw new Error(`Провайдер ${providerId} неизвестен`);

  const baseUrl = settings.get(`url.${providerId}`, preset.baseUrl);
  if (!baseUrl) throw new Error(`Для ${preset.title} не задан адрес`);
  const key = settings.get(`key.${providerId}`, '');
  if (preset.needsKey && !key) throw new Error(`Для ${preset.title} не задан ключ`);
  const model = settings.get(`model.stt.${providerId}`, preset.defaultSttModel || 'whisper-1');

  const form = new FormData();
  form.set('file', new Blob([audio]), filename || 'voice.ogg');
  form.set('model', model);
  if (language) form.set('language', language);
  // verbose_json — ради длительности: по ней считается стоимость.
  form.set('response_format', 'verbose_json');

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${preset.title} ответил ${response.status}`);

  const data = await response.json();
  return {
    text: (data.text || '').trim(),
    seconds: Number(data.duration || 0),
    model,
  };
}

module.exports = { transcribe };
