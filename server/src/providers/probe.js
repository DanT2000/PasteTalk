'use strict';

const { CLOUD } = require('../../../shared/providers');
const settings = require('../settings');
const proxy = require('../proxy');

/**
 * Пробы провайдера для админки: список моделей и проверка связи.
 *
 * Значения берутся из формы, если их туда вписали, иначе — сохранённые:
 * человек вводит ключ и сразу жмёт «Проверить», не сохраняя, — проверять
 * в этот момент старое было бы враньём. Ошибки возвращаются словами в
 * ответе, а не бросаются: речь и текст проверяются по отдельности, и
 * одна неудача не должна прятать другой результат.
 */

const LIST_TIMEOUT_MS = 15000;
const CHECK_TIMEOUT_MS = 30000;

function resolve(providerId, overrides = {}) {
  const preset = CLOUD[providerId];
  if (!preset) throw new Error(`Провайдер ${providerId} неизвестен`);
  const typedUrl = String(overrides.url || '').trim();
  const typedKey = String(overrides.key || '').trim();
  return {
    preset,
    baseUrl: (typedUrl || settings.get(`url.${providerId}`, '') || preset.baseUrl || '').replace(/\/+$/, ''),
    key: typedKey && typedKey !== '-' ? typedKey : settings.get(`key.${providerId}`, ''),
    sttModel: String(overrides.sttModel || '').trim() || settings.get(`model.stt.${providerId}`, '') || preset.defaultSttModel || 'whisper-1',
    llmModel: String(overrides.llmModel || '').trim() || settings.get(`model.llm.${providerId}`, '') || preset.defaultModel || '',
  };
}

function headers(key, extra = {}) {
  return { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra };
}

/** Причина словами — undici прячет код сбоя в цепочке cause. */
function reason(error) {
  const parts = [];
  let current = error;
  while (current && parts.length < 4) {
    if (current.code) parts.push(current.code);
    else if (current.message && current.message !== 'fetch failed') parts.push(current.message);
    current = current.cause;
  }
  return [...new Set(parts)].join(' ← ') || 'неизвестный сбой';
}

/** Полсекунды тишины в WAV 16 кГц: дёшево и достаточно для проверки. */
function silenceWav() {
  const sampleRate = 16000;
  const samples = sampleRate / 2;
  const data = Buffer.alloc(samples * 2);
  const wav = Buffer.alloc(44 + data.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + data.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(data.length, 40);
  data.copy(wav, 44);
  return wav;
}

/** Список моделей провайдера, разложенный на речь и текст. */
async function models(providerId, overrides = {}) {
  const { preset, baseUrl, key } = resolve(providerId, overrides);
  if (!baseUrl) throw new Error(`Для ${preset.title} не задан адрес`);
  let response;
  try {
    response = await fetch(`${baseUrl}/models`, proxy.through(providerId, {
      headers: headers(key),
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    }));
  } catch (error) {
    throw new Error(`${preset.title} недоступен: ${reason(error)}`);
  }
  if (response.status === 401 || response.status === 403) throw new Error(`${preset.title} не принял ключ`);
  if (!response.ok) throw new Error(`${preset.title} ответил ${response.status}`);
  const data = await response.json().catch(() => ({}));
  const ids = (Array.isArray(data.data) ? data.data : [])
    .map((item) => item && item.id)
    .filter((id) => typeof id === 'string')
    .sort();
  // Речевые узнаём по имени: шлюзы не помечают назначение модели.
  const speech = /whisper|transcri|speech|stt|voxtral|gigaam/i;
  const useless = /embed|rerank|tts|dall-e|image|moderation/i;
  return {
    all: ids.length,
    stt: ids.filter((id) => speech.test(id)),
    llm: ids.filter((id) => !speech.test(id) && !useless.test(id)),
  };
}

/** Проверка связи: короткая фраза для текста и полсекунды тишины для речи. */
async function check(providerId, overrides = {}) {
  const { preset, baseUrl, key, sttModel, llmModel } = resolve(providerId, overrides);
  if (!baseUrl) return { llm: { ok: false, error: 'не задан адрес' }, stt: preset.stt ? { ok: false, error: 'не задан адрес' } : null };

  const llm = await (async () => {
    if (!llmModel) return { ok: false, error: 'не выбрана модель текста' };
    const started = Date.now();
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, proxy.through(providerId, {
        method: 'POST',
        headers: headers(key, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          model: llmModel,
          messages: [{ role: 'user', content: 'Ответь одним словом: готов' }],
          max_tokens: 8,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      }));
      if (response.status === 401 || response.status === 403) return { ok: false, error: 'ключ не принят' };
      if (response.status === 404) return { ok: false, error: `модели «${llmModel}» на сервере нет` };
      if (!response.ok) return { ok: false, error: `ответил ${response.status}` };
      const data = await response.json().catch(() => ({}));
      const sample = String(data.choices?.[0]?.message?.content || '').trim();
      return { ok: true, ms: Date.now() - started, model: llmModel, sample: sample.slice(0, 40) };
    } catch (error) {
      return { ok: false, error: reason(error) };
    }
  })();

  const stt = preset.stt ? await (async () => {
    const started = Date.now();
    try {
      const form = new FormData();
      form.set('file', new Blob([silenceWav()], { type: 'audio/wav' }), 'check.wav');
      form.set('model', sttModel);
      const response = await fetch(`${baseUrl}/audio/transcriptions`, proxy.through(providerId, {
        method: 'POST',
        headers: headers(key),
        body: form,
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      }));
      if (response.status === 401 || response.status === 403) return { ok: false, error: 'ключ не принят' };
      if (response.status === 404) return { ok: false, error: `модели «${sttModel}» на сервере нет` };
      if (!response.ok) return { ok: false, error: `ответил ${response.status}` };
      return { ok: true, ms: Date.now() - started, model: sttModel };
    } catch (error) {
      return { ok: false, error: reason(error) };
    }
  })() : null;

  return { llm, stt };
}

module.exports = { models, check, silenceWav };
