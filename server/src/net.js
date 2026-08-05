'use strict';

/**
 * Настоящий адрес клиента.
 *
 * X-Forwarded-For — список, который дописывается по дороге. Первый в нём
 * пишет САМ КЛИЕНТ, и верить ему нельзя: подставив там 192.168.1.5, чужой
 * человек выдал бы себя за домашнюю сеть и вошёл бы в панель заводским
 * паролем. Доверять можно только тем записям, которые добавили наши
 * прокси, то есть последним.
 *
 * Сколько прокси перед сервером — знает только тот, кто разворачивает.
 * По умолчанию один (Traefik в Coolify); за openresty их два.
 */

function trustedDepth() {
  const value = Number(process.env.TRUSTED_PROXIES);
  return Number.isFinite(value) && value >= 0 ? value : 1;
}

function clientIp(request) {
  const depth = trustedDepth();
  if (depth === 0) return request.ip;

  const chain = String(request.headers['x-forwarded-for'] || '')
    .split(',').map((part) => part.trim()).filter(Boolean);
  if (!chain.length) return request.ip;

  // Отсчитываем от конца: последний элемент дописал ближайший прокси.
  const index = chain.length - depth;
  return index >= 0 ? chain[index] : chain[0];
}

module.exports = { clientIp, trustedDepth };
