'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const settings = require('../src/settings');
const prompts = require('../src/prompts');
const { MODES, TAIL } = require('../../shared/modes');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

test('без правок — стандартный промпт с хвостом', () => {
  assert.strictEqual(prompts.instructionFor('clean'), `${MODES.clean} ${TAIL}`);
  assert.strictEqual(prompts.instructionFor('both'), `${MODES.both} ${TAIL}`);
});

test('правленный в админке промпт подменяет тело, но хвост остаётся', () => {
  settings.set('prompt.clean', 'Убери только мат, остальное не трогай.');
  assert.strictEqual(
    prompts.instructionFor('clean'),
    `Убери только мат, остальное не трогай. ${TAIL}`,
  );
  // Второй режим правка первого не задевает.
  assert.strictEqual(prompts.instructionFor('both'), `${MODES.both} ${TAIL}`);
});

test('стёртый промпт возвращает стандартный', () => {
  settings.set('prompt.both', 'Свой вариант.');
  settings.set('prompt.both', '');
  assert.strictEqual(prompts.instructionFor('both'), `${MODES.both} ${TAIL}`);
  // Пробелы — та же пустота: случайный Enter в поле не должен ломать промпт.
  settings.set('prompt.both', '   \n  ');
  assert.strictEqual(prompts.instructionFor('both'), `${MODES.both} ${TAIL}`);
});

test('неизвестный режим не роняет улучшение, а падает в осторожный', () => {
  assert.strictEqual(prompts.instructionFor('nonsense'), `${MODES.clean} ${TAIL}`);
});
