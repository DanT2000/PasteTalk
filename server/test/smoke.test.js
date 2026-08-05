'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { build } = require('../src/index');
const { MODES, instruction } = require('../../shared/modes');
const { CLOUD } = require('../../shared/providers');

test('сервер отвечает, что жив', async () => {
  const app = build();
  const reply = await app.inject({ method: 'GET', url: '/health' });
  assert.strictEqual(reply.statusCode, 200);
  assert.strictEqual(reply.json().ok, true);
  await app.close();
});

test('промпты улучшения общие с десктопом', () => {
  assert.ok(MODES.clean.includes('слова-паразиты'));
  assert.ok(MODES.both.includes('раздели на абзацы'));
  assert.ok(instruction('clean').startsWith(MODES.clean));
});

test('DeepSeek не предлагается для распознавания речи', () => {
  assert.strictEqual(CLOUD.deepseek.stt, false);
  assert.strictEqual(CLOUD.openai.stt, true);
  assert.strictEqual(CLOUD.aitunnel.stt, true);
});
