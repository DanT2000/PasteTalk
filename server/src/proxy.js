'use strict';

const { ProxyAgent } = require('undici');

const settings = require('./settings');

/**
 * Выход наружу через прокси.
 *
 * Нужен, когда сервер стоит там, откуда часть интернета недоступна:
 * Telegram из России без прокси не отвечает вовсе — опрос падает с
 * «fetch failed», и бот молчит, ничего никому не объясняя.
 *
 * Прокси задаётся в админке и может понадобиться не всем: провайдеры вроде
 * AITunnel доступны и напрямую, а гонять через чужой канал звук людей —
 * лишнее. Поэтому у каждого назначения свой выключатель.
 */

let cached = null;      // { url, agent }

function url() {
  return String(settings.get('proxy.url', '') || '').trim();
}

/** Собрать переходник. Один и тот же держим, пока адрес не поменялся. */
function agent() {
  const current = url();
  if (!current) {
    cached = null;
    return undefined;
  }
  if (cached && cached.url === current) return cached.agent;
  cached = { url: current, agent: new ProxyAgent(current) };
  return cached.agent;
}

/**
 * Что именно пускать через прокси.
 *
 * 'telegram' — только бот, по умолчанию: ради него прокси обычно и заводят.
 * 'all'      — ещё и облачные провайдеры.
 */
function usedFor(what) {
  if (!url()) return false;
  const scope = settings.get('proxy.scope', 'telegram');
  return scope === 'all' || scope === what;
}

/** Добавить прокси в параметры fetch, если он нужен для этого назначения. */
function through(what, options = {}) {
  const dispatcher = usedFor(what) ? agent() : undefined;
  return dispatcher ? { ...options, dispatcher } : options;
}

/**
 * Причина сбоя словами. undici на любой сетевой сбой говорит «fetch
 * failed», а настоящий код (ECONNREFUSED, ETIMEDOUT…) прячет в цепочке
 * cause — без раскрутки владелец видел ошибку ни о чём.
 */
function reason(error) {
  const parts = [];
  let current = error;
  while (current && parts.length < 5) {
    if (current.code) parts.push(current.code);
    else if (current.message && current.message !== 'fetch failed') parts.push(current.message);
    current = current.cause;
  }
  return [...new Set(parts)].join(' ← ') || String(error && error.message) || 'неизвестный сбой';
}

/** Проверить прокси, не трогая ничего важного. Две ступени — две причины. */
async function check() {
  const current = url();
  if (!current) return { ok: false, error: 'Прокси не задан' };

  // Ступень 1: жив ли сам прокси. Обычный запрос на его адрес — любой
  // ответ, хоть 400, означает «достижим»; недостижим — дальше идти некуда.
  try {
    await fetch(current, { signal: AbortSignal.timeout(8000) });
  } catch (error) {
    return {
      ok: false,
      error: `Сам прокси недоступен из контейнера сервера (${reason(error)}). `
        + 'Проверьте, что он слушает на этом адресе для всей сети, а не только localhost, и что файрвол пускает',
    };
  }

  // Ступень 2: пропускает ли прокси туннель к Telegram.
  try {
    const started = Date.now();
    const response = await fetch('https://api.telegram.org/', {
      dispatcher: agent(),
      signal: AbortSignal.timeout(20000),
    });
    // Telegram на голый корень отвечает 404 — и это ровно то, что нужно:
    // значит канал до него есть.
    return { ok: true, ms: Date.now() - started, status: response.status };
  } catch (error) {
    return {
      ok: false,
      error: `Прокси отвечает, но туннель к Telegram через него не прошёл (${reason(error)}). `
        + 'Нужен HTTP-прокси с разрешённым CONNECT на порт 443; SOCKS этот сервер не поддерживает',
    };
  }
}

module.exports = { through, usedFor, check, url };
