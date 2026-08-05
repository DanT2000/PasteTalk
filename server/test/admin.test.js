'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const keys = require('../src/keys');
const usage = require('../src/usage');
const settings = require('../src/settings');
const { build } = require('../src/index');

test.beforeEach(() => { db.close(); db.open(':memory:'); keys.forgetMisses(); });

const PASS = 'korabl-veter-kamen';

async function login(app, password = PASS, address = '192.168.2.30') {
  return app.inject({
    method: 'POST', url: '/admin/login',
    headers: { 'x-forwarded-for': address },
    payload: { password },
  });
}

/** Занять панель и войти: заводского пароля больше нет. */
async function session(app) {
  const setup = await app.inject({
    method: 'POST', url: '/admin/setup', payload: { password: PASS },
  });
  return { 'x-admin-session': setup.json().session };
}

test('без входа списки не отдаются', async () => {
  const app = build();
  const reply = await app.inject({ method: 'GET', url: '/admin/api/people' });
  assert.strictEqual(reply.statusCode, 401);
  await app.close();
});

test('выдуманная сессия не пускает', async () => {
  const app = build();
  const reply = await app.inject({
    method: 'GET', url: '/admin/api/people',
    headers: { 'x-admin-session': 'я-тут-главный' },
  });
  assert.strictEqual(reply.statusCode, 401);
  await app.close();
});

test('свободная панель встречает формой «придумайте пароль»', async () => {
  const app = build();
  assert.strictEqual((await app.inject({ method: 'GET', url: '/admin/state' })).json().claimed, false);
  // Входить нечем, пока пароля нет.
  assert.strictEqual((await login(app)).statusCode, 403);

  const setup = await app.inject({
    method: 'POST', url: '/admin/setup', payload: { password: PASS },
  });
  assert.strictEqual(setup.statusCode, 200);
  assert.ok(setup.json().session);
  assert.strictEqual((await app.inject({ method: 'GET', url: '/admin/state' })).json().claimed, true);
  await app.close();
});

test('занятую панель чужой уже не займёт', async () => {
  const app = build();
  await session(app);
  const again = await app.inject({
    method: 'POST', url: '/admin/setup', payload: { password: 'chuzhoy-parol-tut' },
  });
  assert.strictEqual(again.statusCode, 400);
  assert.match(again.json().error, /уже занята/i);
  await app.close();
});

test('ключ заводится с именем, виден в списке и удаляется', async () => {
  const app = build();
  const headers = await session(app);

  const made = await app.inject({
    method: 'POST', url: '/admin/api/keys', headers, payload: { name: 'Мама' },
  });
  assert.strictEqual(made.statusCode, 200);
  assert.match(made.json().code, /^\d{6}$/);

  const people = await app.inject({ method: 'GET', url: '/admin/api/people', headers });
  assert.strictEqual(people.json().people[0].name, 'Мама');
  assert.strictEqual(people.json().people[0].revoked, false);

  const gone = await app.inject({
    method: 'DELETE', url: `/admin/api/keys/${made.json().id}`, headers,
  });
  assert.strictEqual(gone.statusCode, 200);

  const after = await app.inject({ method: 'GET', url: '/admin/api/people', headers });
  assert.strictEqual(after.json().people[0].revoked, true);
  await app.close();
});

test('новый код к профилю выдаётся отдельной кнопкой', async () => {
  const app = build();
  const headers = await session(app);
  const key = keys.issue('Мама');

  const again = await app.inject({
    method: 'POST', url: `/admin/api/keys/${key.id}/code`, headers, payload: { ttlMs: 3600000 },
  });
  assert.strictEqual(again.statusCode, 200);
  assert.match(again.json().code, /^\d{6}$/);
  assert.notStrictEqual(again.json().code, key.code);
  await app.close();
});

test('срок кода приходит вместе с ним', async () => {
  const app = build();
  const headers = await session(app);
  const made = await app.inject({
    method: 'POST', url: '/admin/api/keys', headers, payload: { name: 'Папа', ttlMs: 3600000 },
  });
  assert.ok(made.json().codeUntil > Date.now() + 55 * 60 * 1000);

  const people = (await app.inject({ method: 'GET', url: '/admin/api/people', headers })).json();
  assert.ok(people.people[0].codeUntil > Date.now());
  await app.close();
});

test('пинг без компьютера отвечает честно, а не молчит', async () => {
  const app = build();
  const headers = await session(app);
  const reply = await app.inject({ method: 'POST', url: '/admin/api/agent/ping', headers });
  assert.strictEqual(reply.statusCode, 200);
  assert.strictEqual(reply.json().ok, false);
  assert.match(reply.json().error, /не на связи/i);
  await app.close();
});

test('расход отдаёт разбивку по дням для графика', async () => {
  const app = build();
  const headers = await session(app);
  const spend = (await app.inject({ method: 'GET', url: '/admin/api/spend', headers })).json();
  assert.strictEqual(spend.daily.length, 30);
  await app.close();
});

test('в списке видно устройства и расход человека', async () => {
  const app = build();
  const headers = await session(app);
  const key = keys.issue('Мама');
  keys.activate(key.code, 'android', null, 'Redmi Note 12', '1.1.1.1');
  usage.record({ keyId: key.id, deviceKind: 'android', audioSeconds: 120, executedBy: 'agent' });

  const people = (await app.inject({ method: 'GET', url: '/admin/api/people', headers })).json();
  const person = people.people.find((row) => row.name === 'Мама');
  assert.strictEqual(person.minutes, 2);
  assert.strictEqual(person.devices.length, 1);
  assert.strictEqual(person.devices[0].title, 'Redmi Note 12');
  await app.close();
});

test('устройство отвязывается по отдельности', async () => {
  const app = build();
  const headers = await session(app);
  const key = keys.issue('Мама');
  keys.activate(key.code, 'android', null, 'Redmi', '1.1.1.1');
  // Код одноразовый: на второе устройство нужен новый.
  keys.activate(keys.reissue(key.id).code, 'telegram', '42', 'Мама', '1.1.1.1');

  const before = (await app.inject({ method: 'GET', url: '/admin/api/people', headers })).json();
  const deviceId = before.people[0].devices[0].id;

  await app.inject({ method: 'DELETE', url: `/admin/api/devices/${deviceId}`, headers });
  const after = (await app.inject({ method: 'GET', url: '/admin/api/people', headers })).json();
  assert.strictEqual(after.people[0].devices.length, 1);
  await app.close();
});

test('телеграм привязывается вручную по номеру', async () => {
  const app = build();
  const headers = await session(app);
  const key = keys.issue('Мама');

  const bound = await app.inject({
    method: 'POST', url: `/admin/api/keys/${key.id}/bind`, headers,
    payload: { externalId: '123456789', title: 'Мама' },
  });
  assert.strictEqual(bound.statusCode, 200);
  assert.strictEqual(keys.byExternal('telegram', '123456789').keyId, key.id);
  await app.close();
});

test('привязка без номера отвергается понятно', async () => {
  const app = build();
  const headers = await session(app);
  const key = keys.issue('Мама');
  const reply = await app.inject({
    method: 'POST', url: `/admin/api/keys/${key.id}/bind`, headers, payload: {},
  });
  assert.strictEqual(reply.statusCode, 400);
  assert.match(reply.json().error, /номер/i);
  await app.close();
});

test('расход подписан как оценка по своему прайсу', async () => {
  const app = build();
  const headers = await session(app);
  const spend = await app.inject({ method: 'GET', url: '/admin/api/spend', headers });
  assert.match(spend.json().note, /оценка/i);
  await app.close();
});

test('состояние ПК читается', async () => {
  const app = build();
  const headers = await session(app);
  const state = await app.inject({ method: 'GET', url: '/admin/api/agent', headers });
  assert.strictEqual(state.json().online, false);
  await app.close();
});

test('ключи провайдеров сохраняются, но обратно приходят звёздочками', async () => {
  const app = build();
  const headers = await session(app);

  await app.inject({
    method: 'POST', url: '/admin/api/settings', headers,
    payload: { settings: { 'key.aitunnel': 'sk-aitunnel-настоящий' } },
  });

  const shown = (await app.inject({ method: 'GET', url: '/admin/api/settings', headers })).json();
  assert.strictEqual(shown.settings['key.aitunnel'], '***');
  assert.strictEqual(settings.get('key.aitunnel'), 'sk-aitunnel-настоящий');
  await app.close();
});

test('сохранение формы со звёздочками не стирает ключ', async () => {
  const app = build();
  const headers = await session(app);
  settings.set('key.aitunnel', 'sk-aitunnel-настоящий');

  await app.inject({
    method: 'POST', url: '/admin/api/settings', headers,
    payload: { settings: { 'key.aitunnel': '***', 'chain.llm': ['deepseek'] } },
  });

  assert.strictEqual(settings.get('key.aitunnel'), 'sk-aitunnel-настоящий');
  assert.deepStrictEqual(settings.get('chain.llm'), ['deepseek']);
  await app.close();
});

test('смена пароля закрывает вход по admin', async () => {
  const app = build();
  const headers = await session(app);

  const changed = await app.inject({
    method: 'POST', url: '/admin/password', headers,
    payload: { password: 'novyy-dlinnyy-parol' },
  });
  assert.strictEqual(changed.statusCode, 200);

  assert.strictEqual((await login(app, PASS)).statusCode, 403);
  assert.strictEqual((await login(app, 'novyy-dlinnyy-parol', '188.18.55.140')).statusCode, 200);
  await app.close();
});

test('страница админки отдаётся', async () => {
  const app = build();
  const page = await app.inject({ method: 'GET', url: '/admin/' });
  assert.strictEqual(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /PasteTalk/);
  await app.close();
});

test('витрина открыта всем и ведёт на GitHub и в админку', async () => {
  const app = build();
  const page = await app.inject({ method: 'GET', url: '/' });
  assert.strictEqual(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /github\.com\/DanT2000\/PasteTalk/);
  assert.match(page.body, /href="\/admin\/"/);
  await app.close();
});

test('витрина не выдаёт посторонним, включён ли домашний компьютер', async () => {
  const app = build();
  const page = (await app.inject({ method: 'GET', url: '/' })).body;
  // Страница открыта всему интернету. Знать, включён ли компьютер прямо
  // сейчас, посторонним незачем — поэтому ни поля состояния, ни запроса
  // за ним на витрине быть не должно.
  assert.ok(!/agentOnline/.test(page), 'состояние агента не должно попадать на витрину');
  assert.ok(!/v1\/state|api\/agent/.test(page), 'витрина не должна спрашивать состояние');
  assert.ok(!/<script/i.test(page), 'витрине не нужен код: ей нечего показывать живого');
  await app.close();
});
