'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const queue = require('../src/agent/queue');

test.beforeEach(() => { db.close(); db.open(':memory:'); });

test('две задачи к агенту идут по одной, а не разом', async () => {
  let inFlight = 0;
  let maxSeen = 0;
  const fake = async () => {
    inFlight += 1;
    maxSeen = Math.max(maxSeen, inFlight);
    await new Promise((done) => setTimeout(done, 20));
    inFlight -= 1;
    return { text: 'ок' };
  };

  await Promise.all([queue.throughAgent(fake).done, queue.throughAgent(fake).done]);
  assert.strictEqual(maxSeen, 1);
});

test('упавшая задача не обрывает очередь следующим', async () => {
  const bad = queue.throughAgent(async () => { throw new Error('не вышло'); });
  await assert.rejects(() => bad.done);

  const good = await queue.throughAgent(async () => 'следующая доехала').done;
  assert.strictEqual(good, 'следующая доехала');
});

test('долгое ожидание очереди уводит в облако', async () => {
  // Занимаем агента надолго, чтобы вторая задача встала в очередь.
  const blocker = queue.throughAgent(() => new Promise((done) => setTimeout(done, 200)));

  const result = await queue.withSpill(
    () => queue.throughAgent(async () => 'агент'),
    async () => 'облако',
    20,
  );
  assert.strictEqual(result, 'облако');
  await blocker.done;
});

test('долгая работа агента в облако НЕ уводит — считаем ожидание, а не работу', async () => {
  let cloudCalled = false;
  // Агент взялся сразу, но пишет долго: две минуты речи на видеокарте
  // распознаются дольше тридцати секунд, и уходить за это в облако было
  // бы тратой денег на ровном месте.
  const result = await queue.withSpill(
    () => queue.throughAgent(() => new Promise((done) => setTimeout(() => done('агент'), 80))),
    async () => { cloudCalled = true; return 'облако'; },
    20,
  );
  assert.strictEqual(result, 'агент');
  assert.strictEqual(cloudCalled, false);
});

test('успел вовремя — облако не трогаем', async () => {
  let cloudCalled = false;
  const result = await queue.withSpill(
    () => queue.throughAgent(async () => 'агент'),
    async () => { cloudCalled = true; return 'облако'; },
    50,
  );
  assert.strictEqual(result, 'агент');
  assert.strictEqual(cloudCalled, false);
});

test('сорвавшийся агент отдаёт задачу облаку, а не человеку в лицо', async () => {
  const result = await queue.withSpill(
    () => queue.throughAgent(async () => { throw new Error('ПК отключился'); }),
    async () => 'облако',
    500,
  );
  assert.strictEqual(result, 'облако');
});

test('брошенная в облако задача агентом уже не выполняется', async () => {
  let agentRan = false;
  const blocker = queue.throughAgent(() => new Promise((done) => setTimeout(done, 150)));

  await queue.withSpill(
    () => queue.throughAgent(async () => { agentRan = true; return 'агент'; }),
    async () => 'облако',
    20,
  );

  await blocker.done;
  await new Promise((wait) => setTimeout(wait, 60));
  assert.strictEqual(agentRan, false, 'зря разбуженный агент занял бы видеокарту впустую');
});
