'use strict';

const keys = require('../keys');
const queue = require('../agent/queue');
const usage = require('../usage');
const socket = require('../agent/socket');

/**
 * Всё, что видят телефон и бот.
 *
 * Улучшение принимает текст от клиента, а не достаёт из базы, — потому что
 * в базе его нет и не будет. Распознанный текст доходит до человека до
 * улучшения: отвалится ИИ, а пользоваться уже есть чем.
 */

const { clientIp } = require('../net');
const db = require('../db');

function who(request) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return keys.authenticate(token);
}

// Отчёты принимаются без токена (сломаться может и непривязанная
// программа), поэтому защита — скоростью и размером: один отчёт с адреса
// в минуту, не больше 400 КБ.
const reportSeen = new Map();

function reportAllowed(ip) {
  const now = Date.now();
  const last = reportSeen.get(ip) || 0;
  if (now - last < 60000) return false;
  reportSeen.set(ip, now);
  if (reportSeen.size > 1000) {
    for (const [key, at] of reportSeen) if (now - at > 3600000) reportSeen.delete(key);
  }
  return true;
}

function register(app) {
  app.post('/v1/report', { bodyLimit: 512 * 1024 }, async (request, reply) => {
    const body = JSON.stringify(request.body || {});
    if (body.length > 400000) return reply.code(413).send({ error: 'Отчёт слишком большой' });
    // Минутный засов взводится после проверки размера: отвергнутый по
    // размеру отчёт не должен съедать попытку.
    if (!reportAllowed(clientIp(request))) {
      return reply.code(429).send({ error: 'Отчёт уже принят — не так часто' });
    }
    // Версия попадает в разметку админки — чужим символам в ней не место.
    const version = String(request.body?.version || '').replace(/[^\w.+-]/g, '').slice(0, 40);
    db.open().prepare('INSERT INTO reports (at, version, body) VALUES (?, ?, ?)')
      .run(Date.now(), version, body);
    return { ok: true };
  });

  app.post('/v1/activate', async (request, reply) => {
    const { code, kind, externalId = null, title = '' } = request.body || {};
    if (!['telegram', 'android', 'desktop'].includes(kind)) {
      return reply.code(400).send({ error: 'Неизвестный вид устройства' });
    }
    try {
      return { token: keys.activate(code, kind, externalId, title, clientIp(request)).token };
    } catch (error) {
      // Машинный код для закрытых привязок: приложения переводят его на
      // язык человека сами, а не показывают русскую строку всем подряд.
      const closed = error.message.includes('Новые подключения закрыты');
      return reply.code(403).send({ error: error.message, ...(closed ? { code: 'newCodesClosed' } : {}) });
    }
  });

  // Только для своих: включён ли домашний компьютер — это расписание
  // хозяина, и посторонним знать его незачем.
  app.get('/v1/state', async (request, reply) => {
    if (!who(request)) return reply.code(401).send({ error: 'Доступ отозван или токен неверный' });
    const agent = socket.state();
    return { ok: true, agentOnline: agent.online, agentName: agent.name };
  });

  app.post('/v1/transcribe', async (request, reply) => {
    const device = who(request);
    if (!device) return reply.code(401).send({ error: 'Доступ отозван или токен неверный' });

    const { audio, filename = 'voice.ogg', language = null, seconds = 0, prompt = '' } = request.body || {};
    if (!audio) return reply.code(400).send({ error: 'Не приложен звук' });

    try {
      const result = await queue.transcribe({
        audio: Buffer.from(audio, 'base64'), filename, language, clientSeconds: seconds,
        prompt: String(prompt || '').slice(0, 500),
      });
      // Расход пишем только за то, что вышло: неудачная попытка денег не
      // стоила, и показывать её в счётчике значило бы врать.
      usage.record({
        keyId: device.keyId,
        deviceKind: device.kind,
        audioSeconds: result.seconds || 0,
        executedBy: result.executedBy,
        sttProvider: result.provider || null,
        sttModel: result.model || null,
      });
      return { text: result.text, seconds: result.seconds || 0, where: result.executedBy };
    } catch (error) {
      return reply.code(502).send({ error: error.message });
    }
  });

  app.post('/v1/improve', async (request, reply) => {
    const device = who(request);
    if (!device) return reply.code(401).send({ error: 'Доступ отозван или токен неверный' });

    const { text, mode = 'clean' } = request.body || {};
    if (!text || !String(text).trim()) {
      return reply.code(400).send({ error: 'Не передан текст для улучшения' });
    }

    try {
      const result = await queue.improve({ text: String(text), mode });
      usage.record({
        keyId: device.keyId,
        deviceKind: device.kind,
        audioSeconds: 0,
        executedBy: result.executedBy,
        llmProvider: result.provider || null,
        llmModel: result.model || null,
        tokensIn: result.tokensIn || 0,
        tokensOut: result.tokensOut || 0,
      });
      return { text: result.text, where: result.executedBy };
    } catch (error) {
      return reply.code(502).send({ error: error.message });
    }
  });
}

module.exports = { register };
