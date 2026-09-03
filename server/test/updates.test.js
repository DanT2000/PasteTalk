'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fastify = require('fastify');

const settings = require('../src/settings');
const db = require('../src/db');
const updates = require('../src/routes/updates');

/**
 * Зеркало обновлений без сети: GitHub подменяем, прокси включаем через
 * настройки. Проверяем то, на что опирается electron-updater: имена
 * файлов, каналы, Range и то, что второй запрос идёт из кэша.
 */

const YML = 'version: 2.16.10\nfiles:\n  - url: PasteTalk-2.16.10-Setup.exe\n';
const EXE = Buffer.from('EXE-CONTENT-0123456789');
let calls = [];

function fakeFetch(url) {
  calls.push(url);
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/releases/latest')) return json({ tag_name: 'v2.16.7' });
  if (url.includes('/releases?per_page')) return json([{ tag_name: 'v2.16.10', draft: false, prerelease: true }, { tag_name: 'v2.16.7', draft: false }]);
  if (url.includes('/releases/tags/')) return json({ assets: [{ name: 'latest.yml' }, { name: 'PasteTalk-2.16.10-Setup.exe' }] });
  if (url.endsWith('/latest.yml')) return new Response(YML, { status: 200 });
  if (url.endsWith('-Setup.exe')) return new Response(EXE, { status: 200, headers: { 'content-length': String(EXE.length) } });
  return new Response('nope', { status: 404 });
}

let app;
let tmp;

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updates-'));
  process.env.PASTETALK_DB = path.join(tmp, 'pastetalk.db');
  process.env.NODE_ENV = 'test';
  db.close(); db.open(':memory:');
  settings.set('proxy.url', 'http://127.0.0.1:1');
  settings.set('proxy.use.github', 'on');
  updates._setFetch(fakeFetch);
  app = fastify();
  updates.register(app);
  await app.ready();
});

test.after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('имена файлов: только свои, чужое — 404', async () => {
  assert.ok(updates.NAME.test('PasteTalk-2.16.10-Setup.exe'));
  assert.ok(updates.NAME.test('PasteTalk-2.16.10-Setup.exe.blockmap'));
  assert.ok(updates.NAME.test('PasteTalk-2.17.0-beta.1-Portable.exe'));
  assert.ok(!updates.NAME.test('../../etc/passwd'));
  assert.ok(!updates.NAME.test('PasteTalk-2.16.10-Setup.msi'));
  const bad = await app.inject({ method: 'GET', url: '/updates/evil.exe' });
  assert.strictEqual(bad.statusCode, 404);
});

test('latest.yml — стабильный канал, beta.yml — последний выпуск', async () => {
  calls = [];
  const stable = await app.inject({ method: 'GET', url: '/updates/latest.yml' });
  assert.strictEqual(stable.statusCode, 200);
  assert.match(stable.headers['content-type'], /yaml/);
  assert.ok(calls.some((u) => u.includes('/download/v2.16.7/latest.yml')), 'стабильный — из v2.16.7');
  calls = [];
  const beta = await app.inject({ method: 'GET', url: '/updates/beta.yml' });
  assert.strictEqual(beta.statusCode, 200);
  assert.strictEqual(beta.body, YML);
  assert.ok(calls.some((u) => u.includes('/download/v2.16.10/latest.yml')), 'бета — из v2.16.10');
});

test('установщик: целиком, кусками (Range) и из кэша без второго похода на GitHub', async () => {
  // Предыдущий тест запустил прогрев exe через prefetch — дожидаемся его
  // и начинаем с пустого кэша, иначе гонка: файл появится после удаления.
  const cached = path.join(updates.cacheDir(), 'v2.16.10', 'PasteTalk-2.16.10-Setup.exe');
  for (let i = 0; i < 100 && !fs.existsSync(cached); i++) await new Promise((r) => setTimeout(r, 20));
  fs.rmSync(cached, { force: true });
  calls = [];
  const full = await app.inject({ method: 'GET', url: '/updates/PasteTalk-2.16.10-Setup.exe' });
  assert.strictEqual(full.statusCode, 200);
  assert.strictEqual(full.headers['accept-ranges'], 'bytes');
  assert.strictEqual(Number(full.headers['content-length']), EXE.length);
  assert.ok(full.rawPayload.equals(EXE));
  assert.strictEqual(calls.filter((u) => u.endsWith('-Setup.exe')).length, 1);

  const part = await app.inject({ method: 'GET', url: '/updates/PasteTalk-2.16.10-Setup.exe', headers: { range: 'bytes=4-9' } });
  assert.strictEqual(part.statusCode, 206);
  assert.strictEqual(part.headers['content-range'], `bytes 4-9/${EXE.length}`);
  assert.strictEqual(part.body, EXE.subarray(4, 10).toString());

  const tail = await app.inject({ method: 'GET', url: '/updates/PasteTalk-2.16.10-Setup.exe', headers: { range: 'bytes=-5' } });
  assert.strictEqual(tail.statusCode, 206);
  assert.strictEqual(tail.body, EXE.subarray(-5).toString());

  const beyond = await app.inject({ method: 'GET', url: '/updates/PasteTalk-2.16.10-Setup.exe', headers: { range: 'bytes=999-' } });
  assert.strictEqual(beyond.statusCode, 416);

  const head = await app.inject({ method: 'HEAD', url: '/updates/PasteTalk-2.16.10-Setup.exe' });
  assert.strictEqual(head.statusCode, 200);
  assert.strictEqual(Number(head.headers['content-length']), EXE.length);
  // Всё это — из кэша: GitHub за exe больше не спрашивали.
  assert.strictEqual(calls.filter((u) => u.endsWith('-Setup.exe')).length, 1);
});

test('GitHub не отдал файл — честный 502, а не пустой exe', async () => {
  const missing = await app.inject({ method: 'GET', url: '/updates/PasteTalk-9.9.9-Portable.exe' });
  assert.strictEqual(missing.statusCode, 502);
  assert.match(missing.json().error, /не достало/);
  assert.ok(!fs.existsSync(path.join(updates.cacheDir(), 'v9.9.9', 'PasteTalk-9.9.9-Portable.exe')));
});
