'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const settings = require('../src/settings');
const chains = require('../src/providers/chains');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

test('упал первый — отвечает второй', async () => {
  const calls = [];
  const attempt = async (id) => {
    calls.push(id);
    if (id === 'openai') throw new Error('503');
    return { text: 'готово', model: 'whisper-large-v3-turbo' };
  };

  const result = await chains.run(['openai', 'aitunnel'], attempt);
  assert.deepStrictEqual(calls, ['openai', 'aitunnel']);
  assert.strictEqual(result.provider, 'aitunnel');
  assert.strictEqual(result.text, 'готово');
});

test('ответил первый — до второго не доходим', async () => {
  const calls = [];
  const result = await chains.run(['aitunnel', 'openai'], async (id) => {
    calls.push(id);
    return { text: 'готово' };
  });
  assert.deepStrictEqual(calls, ['aitunnel']);
  assert.strictEqual(result.provider, 'aitunnel');
});

test('молчат все — говорим об этом честно, с причинами', async () => {
  const attempt = async (id) => { throw new Error(`${id} упал`); };
  await assert.rejects(
    () => chains.run(['openai', 'aitunnel'], attempt, 'распознаванием'),
    (error) => {
      assert.ok(error instanceof chains.AllFailed);
      assert.match(error.message, /Связи с распознаванием нет/);
      assert.strictEqual(error.causes.length, 2);
      return true;
    },
  );
});

test('в цепочку распознавания DeepSeek не попадает', () => {
  settings.set('chain.stt', ['deepseek', 'aitunnel']);
  assert.deepStrictEqual(chains.sttChain(), ['aitunnel']);
});

test('в цепочку улучшения DeepSeek попадает', () => {
  settings.set('chain.llm', ['deepseek', 'openai']);
  assert.deepStrictEqual(chains.llmChain(), ['deepseek', 'openai']);
});

test('незнакомые имена из цепочек вычищаются', () => {
  settings.set('chain.llm', ['deepseek', 'какой-то-новый']);
  assert.deepStrictEqual(chains.llmChain(), ['deepseek']);
});

test('пустая цепочка — это тоже честная ошибка, а не тишина', async () => {
  await assert.rejects(
    () => chains.run([], async () => ({})),
    (error) => error instanceof chains.AllFailed,
  );
});

test('по умолчанию аварийка — AITunnel на звук и DeepSeek на текст', () => {
  assert.deepStrictEqual(chains.sttChain(), ['aitunnel']);
  assert.deepStrictEqual(chains.llmChain(), ['deepseek']);
});

test('расширение .oga приводится к .ogg: шлюзы его отвергают', async () => {
  const stt = require('../src/providers/stt');
  const settings = require('../src/settings');
  settings.set('key.aitunnel', 'проверочный');

  let sentName = '';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sentName = options.body.get('file').name;
    return { ok: true, json: async () => ({ text: 'ок', duration: 1 }) };
  };
  try {
    await stt.transcribe('aitunnel', { audio: Buffer.alloc(10), filename: 'voice.oga' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.strictEqual(sentName, 'voice.ogg', 'иначе голосовые из Telegram падают с 400');
});
