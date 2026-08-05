'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const settings = require('../src/settings');
const prices = require('../src/prices');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

test('распознавание считается по минутам звука', () => {
  prices.setTable({ stt: { 'whisper-large-v3-turbo': 0.6 }, llm: {} });
  // Полторы минуты по 0.6 ₽ за минуту.
  assert.strictEqual(Math.round(prices.sttCost('whisper-large-v3-turbo', 90) * 100) / 100, 0.9);
});

test('улучшение считается по токенам в обе стороны', () => {
  prices.setTable({ stt: {}, llm: { 'deepseek-chat': { in: 20, out: 60 } } });
  // 500 000 входных по 20 ₽/млн + 250 000 выходных по 60 ₽/млн = 10 + 15.
  assert.strictEqual(prices.llmCost('deepseek-chat', 500_000, 250_000), 25);
});

test('незнакомая модель стоит ноль, а не ломает подсчёт', () => {
  prices.setTable({ stt: {}, llm: {} });
  assert.strictEqual(prices.sttCost('какая-то-новая', 60), 0);
  assert.strictEqual(prices.llmCost('какая-то-новая', 1000, 1000), 0);
});

test('без своего прайса берётся встроенный', () => {
  assert.deepStrictEqual(prices.table(), prices.DEFAULTS);
  assert.ok(prices.sttCost('whisper-large-v3-turbo', 60) > 0);
});

test('секреты не отдаются наружу в открытом виде', () => {
  settings.set('key.aitunnel', 'sk-aitunnel-секрет');
  const shown = settings.all();
  assert.strictEqual(shown['key.aitunnel'], '***');
  assert.strictEqual(settings.get('key.aitunnel'), 'sk-aitunnel-секрет');
});

test('пустой секрет звёздочками не прикрывается — иначе не видно, что его нет', () => {
  settings.set('key.openai', '');
  assert.strictEqual(settings.all()['key.openai'], '');
});

test('настройки переживают перезапись и хранят не только строки', () => {
  settings.set('chain.stt', ['aitunnel', 'openai']);
  settings.set('chain.stt', ['openai']);
  assert.deepStrictEqual(settings.get('chain.stt'), ['openai']);
  settings.set('spillToCloud', false);
  assert.strictEqual(settings.get('spillToCloud'), false);
});
