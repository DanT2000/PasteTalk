'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const usage = require('../src/usage');
const prices = require('../src/prices');
const keys = require('../src/keys');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

test('диктовка через свой ПК ничего не стоит, но минуты считаются', () => {
  const key = keys.issue('Мама');
  usage.record({ keyId: key.id, deviceKind: 'android', audioSeconds: 120, executedBy: 'agent' });

  const month = usage.monthly();
  assert.strictEqual(month.agentMinutes, 2);
  assert.strictEqual(month.cloudMinutes, 0);
  assert.strictEqual(month.rub, 0);
});

test('облачная диктовка складывает распознавание и улучшение', () => {
  const key = keys.issue('Папа');
  prices.setTable({
    stt: { 'whisper-large-v3-turbo': 0.6 },
    llm: { 'deepseek-chat': { in: 20, out: 60 } },
  });

  usage.record({
    keyId: key.id, deviceKind: 'telegram', audioSeconds: 60, executedBy: 'cloud',
    sttProvider: 'aitunnel', sttModel: 'whisper-large-v3-turbo',
    llmProvider: 'deepseek', llmModel: 'deepseek-chat',
    tokensIn: 1_000_000, tokensOut: 1_000_000,
  });

  const month = usage.monthly();
  assert.strictEqual(month.cloudMinutes, 1);
  // 0.6 за минуту звука плюс 20 и 60 за миллион токенов в каждую сторону.
  assert.strictEqual(month.rub, 80.6);
});

test('улучшение своей моделью не стоит ничего, даже если модель известна прайсу', () => {
  const key = keys.issue('Мама');
  prices.setTable({ stt: {}, llm: { 'gemma3:12b': { in: 100, out: 100 } } });

  usage.record({
    keyId: key.id, deviceKind: 'android', audioSeconds: 30, executedBy: 'agent',
    llmModel: 'gemma3:12b', tokensIn: 1_000_000, tokensOut: 1_000_000,
  });

  assert.strictEqual(usage.monthly().rub, 0);
});

test('расход виден по каждому человеку отдельно', () => {
  const mother = keys.issue('Мама');
  const father = keys.issue('Папа');
  prices.setTable({ stt: { 'whisper-1': 6 }, llm: {} });

  usage.record({
    keyId: mother.id, deviceKind: 'android', audioSeconds: 60, executedBy: 'cloud',
    sttModel: 'whisper-1',
  });
  usage.record({ keyId: father.id, deviceKind: 'telegram', audioSeconds: 120, executedBy: 'agent' });

  const rows = usage.perKey();
  const byId = new Map(rows.map((row) => [row.key_id, row]));
  assert.strictEqual(byId.get(mother.id).rub, 6);
  assert.strictEqual(byId.get(father.id).rub, 0);
  assert.strictEqual(byId.get(father.id).minutes, 2);
});

test('разбивка по моделям складывает распознавание и улучшение по отдельности', () => {
  const key = keys.issue('Мама');
  prices.setTable({
    stt: { 'whisper-1': 6 },
    llm: { 'deepseek-chat': { in: 0, out: 100 } },
  });
  usage.record({
    keyId: key.id, deviceKind: 'android', audioSeconds: 60, executedBy: 'cloud',
    sttModel: 'whisper-1', llmModel: 'deepseek-chat', tokensIn: 0, tokensOut: 1_000_000,
  });

  const byModel = new Map(usage.monthly().byModel.map((row) => [row.model, row]));
  assert.strictEqual(byModel.get('whisper-1').rub, 6);
  assert.strictEqual(byModel.get('deepseek-chat').rub, 100);
});

test('прошлый месяц в сводку этого не попадает', () => {
  const key = keys.issue('Мама');
  const id = usage.record({
    keyId: key.id, deviceKind: 'android', audioSeconds: 600, executedBy: 'agent',
  });
  // Отодвигаем запись на два месяца назад.
  const long = Date.now() - 62 * 24 * 60 * 60 * 1000;
  db.open().prepare('UPDATE usage SET at = ? WHERE id = ?').run(long, id);

  assert.strictEqual(usage.monthly().agentMinutes, 0);
});

test('содержимое диктовки в базу не попадает', () => {
  const columns = db.open().prepare('PRAGMA table_info(usage)').all().map((c) => c.name);
  assert.ok(!columns.includes('text'));
  assert.ok(!columns.includes('audio'));
});

test('по дням возвращается ровно тридцать точек, включая пустые', () => {
  const usage = require('../src/usage');
  const keys = require('../src/keys');
  const key = keys.issue('Мама');
  usage.record({ keyId: key.id, deviceKind: 'android', audioSeconds: 60, executedBy: 'agent' });

  const days = usage.daily();
  assert.strictEqual(days.length, 30);
  // Сегодня — последняя точка, и в ней наша минута.
  assert.strictEqual(days[29].agentMinutes, 1);
  // Пустые дни не пропущены: иначе неделя молчания на графике исчезнет.
  assert.ok(days.slice(0, 29).every((d) => d.agentMinutes === 0));
});
