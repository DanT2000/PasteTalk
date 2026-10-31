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

// роль ('main' | 'spare') → { url, agent }
const pools = new Map();

function url() {
  return String(settings.get('proxy.url', '') || '').trim();
}

/**
 * Запасной прокси. Основной — чужой канал, и он падает: 31 октября он не
 * пускал бота к Telegram четыре с половиной часа. Прямой дороги оттуда
 * нет (Telegram в России закрыт), поэтому единственная настоящая замена —
 * второй прокси. Пусто — запасного нет, всё работает как раньше.
 */
function spare() {
  return String(settings.get('proxy.spare', '') || '').trim();
}

/**
 * Собрать переходник. Один и тот же держим, пока адрес не поменялся:
 * ProxyAgent — это пул соединений, и новый на каждый запрос течёт
 * памятью. Сменился адрес — прежний пул закрываем, иначе он так и будет
 * держать соединения с уже ненужным прокси.
 */
function agentFor(role, address) {
  const have = pools.get(role);
  if (have && have.url === address) return have.agent;
  if (have) {
    pools.delete(role);
    have.agent.close().catch(() => {});
  }
  if (!address) return undefined;
  const made = new ProxyAgent(address);
  pools.set(role, { url: address, agent: made });
  return made;
}

function agent() {
  return agentFor('main', url());
}

/** То же, но через запасной прокси. */
function throughSpare(options = {}) {
  const dispatcher = agentFor('spare', spare());
  return dispatcher ? { ...options, dispatcher } : options;
}

/**
 * Что именно пускать через прокси.
 *
 * 'telegram' — только бот, по умолчанию: ради него прокси обычно и заводят.
 * 'all'      — ещё и облачные провайдеры.
 */
function usedFor(what) {
  if (!url()) return false;
  // Точечная настройка на каждое назначение: proxy.use.telegram и
  // proxy.use.<провайдер>. Кому-то прокси жизненно нужен, кому-то только
  // мешает — общий рубильник «всё или Telegram» этого не умел.
  const explicit = String(settings.get(`proxy.use.${what}`, '') || '');
  if (explicit === 'on') return true;
  if (explicit === 'off') return false;
  // Старые настройки, где был общий scope: telegram | all.
  const scope = settings.get('proxy.scope', 'telegram');
  if (scope === 'all') return true;
  return what === 'telegram' && scope === 'telegram';
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
  // Пароль из адреса прокси не должен светиться в тексте ошибки.
  return ([...new Set(parts)].join(' ← ') || String(error && error.message) || 'неизвестный сбой')
    .replace(/\/\/[^@/\s]+@/g, '//***@');
}

/**
 * Проверить прокси, не трогая ничего важного. Две ступени — две причины.
 * candidate — адрес из ПОЛЯ формы: человек вписал новый адрес и жмёт
 * «Проверить» до сохранения; проверять в этот момент старый — ловушка.
 */
async function check(candidate, which = 'main') {
  const saved = which === 'spare' ? spare() : url();
  const current = candidate && candidate !== '***' ? String(candidate).trim() : saved;
  if (!current) return { ok: false, error: 'Прокси не задан' };

  let parsed;
  try {
    parsed = new URL(current);
  } catch {
    return { ok: false, error: 'Адрес прокси записан неверно — нужен вид http://host:8080' };
  }
  // socks5:// и прочее: у таких URL нет origin, и дальше упало бы с 500.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Поддерживается только HTTP(S)-прокси — SOCKS этот сервер не умеет' };
  }

  // Ступень 1: жив ли сам прокси. Обычный запрос на его адрес — любой
  // ответ, хоть 400, означает «достижим»; недостижим — дальше идти некуда.
  // Логин и пароль вырезаем: fetch запрещает URL с кредами, а для «жив
  // ли» они и не нужны.
  const bare = new URL(parsed.origin);
  try {
    const probe = await fetch(bare, { signal: AbortSignal.timeout(8000) });
    await probe.body?.cancel().catch(() => {});
  } catch (error) {
    return {
      ok: false,
      error: `Сам прокси недоступен из контейнера сервера (${reason(error)}). `
        + 'Проверьте, что он слушает на этом адресе для всей сети, а не только localhost, и что файрвол пускает',
    };
  }

  // Ступень 2: пропускает ли прокси туннель к Telegram. Для адреса из
  // поля собираем разовый переходник, кэш не трогаем.
  // Для адреса из поля — разовый переходник, который после проверки
  // закрываем: иначе каждая «Проверить» оставляла бы пул соединений.
  const throwaway = current === saved ? null : new ProxyAgent(current);
  try {
    const started = Date.now();
    const response = await fetch('https://api.telegram.org/', {
      // Проверяем именно ту дорогу, о которой спросили: у запасного свой
      // переходник, и подсунуть вместо него основной — значит сказать
      // «запасной работает», ни разу его не тронув.
      dispatcher: throwaway || agentFor(which === 'spare' ? 'spare' : 'main', saved),
      signal: AbortSignal.timeout(20000),
    });
    await response.body?.cancel().catch(() => {});
    // Telegram на голый корень отвечает 404 — и это ровно то, что нужно:
    // значит канал до него есть.
    return { ok: true, ms: Date.now() - started, status: response.status };
  } catch (error) {
    return {
      ok: false,
      error: `Прокси отвечает, но туннель к Telegram через него не прошёл (${reason(error)}). `
        + 'Нужен HTTP-прокси с логином-паролем в адресе и разрешённым CONNECT на порт 443; SOCKS этот сервер не поддерживает',
    };
  } finally {
    if (throwaway) throwaway.close().catch(() => {});
  }
}

module.exports = { through, throughSpare, usedFor, check, url, spare, reason };
