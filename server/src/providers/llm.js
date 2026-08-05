'use strict';

const { CLOUD } = require('../../../shared/providers');
const { instruction } = require('../../../shared/modes');
const settings = require('../settings');
const proxy = require('../proxy');

/**
 * Улучшение текста облаком.
 *
 * Думать модели запрещаем явно: рассуждающие модели на простой вычитке
 * уходят в размышления на десятки секунд. При работе над десктопной
 * версией это уже измерялось — 26 секунд против одной на том же тексте.
 */

const TIMEOUT_MS = 3 * 60 * 1000;
const NO_THINKING = { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'none' };

function ask(url, key, body) {
  return fetch(url, proxy.through('cloud', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
}

async function improve(providerId, { text, mode }) {
  const preset = CLOUD[providerId];
  if (!preset) throw new Error(`Провайдер ${providerId} неизвестен`);

  const baseUrl = settings.get(`url.${providerId}`, preset.baseUrl);
  if (!baseUrl) throw new Error(`Для ${preset.title} не задан адрес`);
  const key = settings.get(`key.${providerId}`, '');
  if (preset.needsKey && !key) throw new Error(`Для ${preset.title} не задан ключ`);
  const model = settings.get(`model.llm.${providerId}`, preset.defaultModel || '');

  const base = {
    model,
    messages: [
      { role: 'system', content: instruction(mode) },
      { role: 'user', content: text },
    ],
    temperature: 0.3,
  };

  let response = await ask(`${baseUrl}/chat/completions`, key, { ...base, ...NO_THINKING });
  // Не все шлюзы знают эти поля и отвечают на них 400. Тогда повторяем без
  // них: пусть модель думает, но ответит, — это лучше, чем не ответить.
  if (response.status === 400) {
    response = await ask(`${baseUrl}/chat/completions`, key, base);
  }
  if (!response.ok) throw new Error(`${preset.title} ответил ${response.status}`);

  const data = await response.json();
  const out = (data.choices?.[0]?.message?.content || '').trim();
  if (!out) throw new Error(`${preset.title} вернул пустой ответ`);
  return {
    text: out,
    tokensIn: data.usage?.prompt_tokens || 0,
    tokensOut: data.usage?.completion_tokens || 0,
    model,
  };
}

module.exports = { improve };
