'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const auth = require('../admin/auth');
const keys = require('../keys');
const usage = require('../usage');
const settings = require('../settings');
const prices = require('../prices');
const socket = require('../agent/socket');

/**
 * Админка: четыре экрана и ничего лишнего.
 *
 * Сессии держим в памяти. Перезапуск сервера выкидывает владельца из
 * панели — это не беда, зато красть с диска нечего.
 */

const sessions = new Map();
const SESSION_MS = 12 * 60 * 60 * 1000;

const { clientIp } = require('../net');

function guard(request, reply) {
  const session = sessions.get(request.headers['x-admin-session']);
  if (!session || session.until < Date.now()) {
    reply.code(401).send({ error: 'Нужно войти заново' });
    return null;
  }
  return session;
}

function register(app) {
  app.post('/admin/login', async (request, reply) => {
    const verdict = await auth.allowed((request.body || {}).password, clientIp(request));
    if (!verdict.ok) return reply.code(403).send({ error: verdict.error });

    const id = crypto.randomBytes(24).toString('base64url');
    sessions.set(id, { until: Date.now() + SESSION_MS });
    return { session: id, mustChange: verdict.mustChange };
  });

  app.post('/admin/password', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    try {
      await auth.change((request.body || {}).password);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.get('/admin/api/people', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    const spend = new Map(usage.perKey().map((row) => [row.key_id, row]));
    return {
      people: keys.list().map((key) => ({
        id: key.id,
        name: key.name,
        code: key.code,
        codeUntil: key.code_until,
        mayServe: Boolean(key.may_serve),
        revoked: Boolean(key.revoked_at),
        minutes: spend.get(key.id)?.minutes || 0,
        rub: spend.get(key.id)?.rub || 0,
        devices: key.devices.map((device) => ({
          id: device.id, kind: device.kind, title: device.title, lastSeen: device.last_seen,
        })),
      })),
    };
  });

  app.post('/admin/api/keys', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    const { name, ttlMs } = request.body || {};
    return keys.issue(name, Number(ttlMs) || keys.DEFAULT_CODE_TTL_MS);
  });

  // Новый код к тому же профилю: человек не успел ввести прежний или
  // потерял его. Уже привязанные устройства этого не замечают.
  app.post('/admin/api/keys/:id/code', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    try {
      return keys.reissue(Number(request.params.id), Number((request.body || {}).ttlMs) || undefined);
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.delete('/admin/api/keys/:id', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    return { ok: keys.revoke(Number(request.params.id)) };
  });

  // Разрешение работать агентом даёт только владелец: вид устройства
  // выбирает сам клиент, и по нему судить нельзя.
  app.post('/admin/api/keys/:id/serve', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    const allowed = Boolean((request.body || {}).allowed);
    if (!keys.setMayServe(Number(request.params.id), allowed)) {
      return reply.code(400).send({ error: 'Такого профиля нет' });
    }
    if (!allowed) socket.dropIfDenied();
    return { ok: true, mayServe: allowed };
  });

  app.delete('/admin/api/devices/:id', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    return { ok: keys.unbind(Number(request.params.id)) };
  });

  // Запасной путь, когда человек потерял код: владелец вписывает его номер
  // в телеграме руками. Номер человек берёт командой /id в самом боте.
  app.post('/admin/api/keys/:id/bind', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    const { externalId, title = '' } = request.body || {};
    if (!externalId) return reply.code(400).send({ error: 'Не указан номер в телеграме' });
    try {
      keys.bind(Number(request.params.id), 'telegram', externalId, title);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.get('/admin/api/spend', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    return {
      ...usage.monthly(),
      daily: usage.daily(),
      note: 'Оценка по своему прайсу: провайдеры фактическую стоимость не присылают',
    };
  });

  app.get('/admin/api/agent', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    return socket.state();
  });

  app.post('/admin/api/agent/ping', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    return socket.ping();
  });

  app.get('/admin/api/settings', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    return {
      settings: settings.all(),
      prices: prices.table(),
      botRunning: require('../bot/telegram').running(),
    };
  });

  app.post('/admin/api/settings', async (request, reply) => {
    if (!guard(request, reply)) return undefined;
    const body = request.body || {};
    for (const [key, value] of Object.entries(body.settings || {})) {
      // Звёздочки означают «не трогали»: без этой проверки сохранение
      // формы стирало бы ключ, который в ней и не показывался.
      if (value === '***') continue;
      settings.set(key, value);
    }
    if (body.prices) prices.setTable(body.prices);
    // Токен бота мог измениться — поднимаем или гасим опрос сразу, чтобы
    // не заставлять владельца перезапускать сервер ради одного поля.
    const botRunning = require('../bot/telegram').sync();
    return { ok: true, botRunning };
  });

  const page = (name) => fs.readFileSync(
    path.join(__dirname, '..', 'admin', 'pages', name), 'utf8',
  );

  app.get('/admin/', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return page('index.html');
  });

  // Витрина. Про домашний компьютер здесь намеренно ни слова: страница
  // открыта всему интернету, и знать, включён ли он сейчас, посторонним
  // незачем.
  app.get('/', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return page('home.html');
  });
}

module.exports = { register };
