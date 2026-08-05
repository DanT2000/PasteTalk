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

function who(request) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return keys.authenticate(token);
}

function register(app) {
  app.post('/v1/activate', async (request, reply) => {
    const { code, kind, externalId = null, title = '' } = request.body || {};
    if (!['telegram', 'android', 'desktop'].includes(kind)) {
      return reply.code(400).send({ error: 'Неизвестный вид устройства' });
    }
    try {
      return { token: keys.activate(code, kind, externalId, title, clientIp(request)).token };
    } catch (error) {
      return reply.code(403).send({ error: error.message });
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

    const { audio, filename = 'voice.ogg', language = null } = request.body || {};
    if (!audio) return reply.code(400).send({ error: 'Не приложен звук' });

    try {
      const result = await queue.transcribe({
        audio: Buffer.from(audio, 'base64'), filename, language,
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
