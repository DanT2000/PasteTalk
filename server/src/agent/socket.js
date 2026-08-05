'use strict';

const crypto = require('node:crypto');

const db = require('../db');

/**
 * Соединение с домашним компьютером.
 *
 * Звонит всегда он: обратное направление требовало бы проброса порта на
 * каждом домашнем роутере, постоянного IP и открытого наружу порта с
 * распознаванием. Здесь наружу не торчит ничего, а признак «на связи»
 * получается сам собой — сокет жив или мёртв.
 *
 * Агент один: это домашний компьютер владельца, а не ферма. Второй
 * поздоровавшийся просто занимает место первого.
 */

const PING_MS = 20 * 1000;
const DEAD_MS = 60 * 1000;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

let live = null;              // { socket, name, lastSeen, agentId }
const waiting = new Map();    // id задачи → { resolve, reject, timer }

function online() {
  return Boolean(live) && Date.now() - live.lastSeen < DEAD_MS;
}

function state() {
  const row = db.open().prepare('SELECT * FROM agents ORDER BY last_seen DESC LIMIT 1').get();
  return {
    online: online(),
    name: live?.name || row?.name || null,
    lastSeen: live?.lastSeen || row?.last_seen || null,
    jobsDone: row?.jobs_done || 0,
  };
}

/**
 * Порвать связь и не оставить никого висеть.
 *
 * Ждущие задачи обязаны получить отказ: без этого запрос с телефона
 * молчал бы до самого таймаута, хотя ответить уже некому.
 */
function drop(reason) {
  for (const [, pending] of waiting) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  waiting.clear();
  live = null;
}

/** Полный сброс — нужен тестам, чтобы соседние проверки не мешали друг другу. */
function forget() {
  drop('сброс');
}

function send(job) {
  if (!online()) return Promise.reject(new Error('ПК не на связи'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('ПК не ответил вовремя'));
    }, JOB_TIMEOUT_MS);
    waiting.set(id, { resolve, reject, timer });
    live.socket.send(JSON.stringify({ type: 'job', id, ...job }));
  });
}

function greet(socket, data) {
  const now = Date.now();
  const database = db.open();
  const name = data.name || 'ПК';
  const existing = database.prepare('SELECT id FROM agents WHERE name = ?').get(name);
  const agentId = existing
    ? existing.id
    : Number(database.prepare('INSERT INTO agents (name, paired_at, last_seen) VALUES (?, ?, ?)')
      .run(name, now, now).lastInsertRowid);
  live = { socket, name, lastSeen: now, agentId };
  socket.send(JSON.stringify({ type: 'welcome' }));
}

/**
 * Разбор одного сообщения от агента.
 *
 * Вынесено из register отдельной функцией, потому что это чистая логика:
 * её можно прогнать тестами, не поднимая ни сети, ни настоящего сокета.
 */
function handle(socket, message) {
  let data;
  try { data = JSON.parse(message); } catch { return; }

  if (data.type === 'hello') {
    greet(socket, data);
    return;
  }

  if (!live) return;
  live.lastSeen = Date.now();

  if (data.type !== 'result' && data.type !== 'error') return;

  const pending = waiting.get(data.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  waiting.delete(data.id);

  if (data.type === 'error') {
    pending.reject(new Error(data.message || 'ПК не смог обработать'));
    return;
  }

  db.open().prepare('UPDATE agents SET jobs_done = jobs_done + 1, last_seen = ? WHERE id = ?')
    .run(Date.now(), live.agentId);
  pending.resolve(data.result);
}

/**
 * Спросить компьютер, жив ли он, и замерить ответ.
 *
 * Отдельно от «на связи»: сокет может числиться открытым, пока сеть уже
 * отвалилась, и узнать правду можно только дождавшись ответа.
 */
async function ping() {
  if (!online()) return { ok: false, error: 'ПК не на связи' };
  const started = Date.now();
  try {
    await send({ kind: 'ping', payload: {} });
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function register(app) {
  app.get('/agent', { websocket: true }, (socket) => {
    const heartbeat = setInterval(() => {
      if (live && Date.now() - live.lastSeen > DEAD_MS) {
        drop('ПК перестал отвечать');
        try { socket.close(); } catch { /* уже закрыт */ }
        return;
      }
      try { socket.send(JSON.stringify({ type: 'ping' })); } catch { /* закрывается */ }
    }, PING_MS);

    socket.on('message', (raw) => handle(socket, raw.toString()));
    socket.on('close', () => {
      clearInterval(heartbeat);
      if (live?.socket === socket) drop('ПК отключился');
    });
  });
}

module.exports = { register, handle, drop, forget, online, send, ping, state, PING_MS, DEAD_MS };
