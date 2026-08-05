'use strict';

const settings = require('./settings');

/**
 * Во сколько обошлась диктовка.
 *
 * Считаем сами, а не спрашиваем провайдера: AITunnel объявляет заголовки
 * cost-rub и balance, но фактически их не присылает — ни в ответе, ни
 * отдельной ручкой. Поэтому в админке эта цифра подписана как оценка по
 * своему прайсу, а не как факт от провайдера.
 *
 * Цены: распознавание — рублей за минуту звука, улучшение — рублей за
 * миллион токенов отдельно на вход и на выход.
 *
 * Незнакомая модель стоит ноль. Так честнее, чем угадывать: ноль в
 * админке сразу виден как «прайс не заполнен», а выдуманная цифра
 * выглядела бы правдой.
 */

const DEFAULTS = {
  stt: {
    'whisper-1': 0.6,
    'whisper-large-v3-turbo': 0.4,
  },
  llm: {
    'deepseek-chat': { in: 20, out: 60 },
    'gpt-4o-mini': { in: 14, out: 55 },
  },
};

function table() {
  return settings.get('prices', DEFAULTS);
}

function setTable(next) {
  settings.set('prices', next);
}

function sttCost(model, seconds) {
  const perMinute = table().stt?.[model];
  if (!perMinute) return 0;
  return (seconds / 60) * perMinute;
}

function llmCost(model, tokensIn, tokensOut) {
  const row = table().llm?.[model];
  if (!row) return 0;
  return (tokensIn / 1_000_000) * row.in + (tokensOut / 1_000_000) * row.out;
}

module.exports = { table, setTable, sttCost, llmCost, DEFAULTS };
