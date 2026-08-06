'use strict';

const crypto = require('node:crypto');

const agents = require('../agents');

/**
 * Соединения с компьютерами.
 *
 * Звонят всегда они: обратное направление требовало бы проброса порта на
 * каждом домашнем роутере. Наружу не торчит ничего, а «на связи» — это
 * просто живой сокет.
 *
 * Машин может быть несколько: у каждой свой ключ из раздела «Компьютеры»
 * и свой порядок. Задача уходит первой по порядку, не взялась — следующей.
 * Ключ человека сюда не подходит: код на телефон не должен давать право
 * принимать чужие диктовки звуком.
 */

const PING_MS = 20 * 1000;
const DEAD_MS = 60 * 1000;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

// id компьютера → { socket, name, lastSeen }
const live = new Map();
// id задачи → { resolve, reject, timer, agentId }
const waiting = new Map();

function alive(entry) {
  return Boolean(entry) && Date.now() - entry.lastSeen < DEAD_MS;
}

/** Компьютеры на связи, в порядке опроса. */
function onlineAgents() {
  const out = [];
  for (const agent of agents.list()) {
    const entry = live.get(agent.id);
    if (!alive(entry)) continue;
    // Машину могли удалить, пока сокет жив, — тогда она больше не своя.
    if (!agents.exists(agent.id)) {
      dropAgent(agent.id, 'компьютер удалён');
      continue;
    }
    out.push({ ...agent, entry });
  }
  return out;
}

function online() {
  return onlineAgents().length > 0;
}

function state() {
  const rows = agents.list().map((agent) => ({
    id: agent.id,
    name: agent.name,
    priority: agent.priority,
    online: alive(live.get(agent.id)),
    lastSeen: live.get(agent.id)?.lastSeen || agent.last_seen || null,
    jobsDone: agent.jobs_done,
  }));
  const first = rows.find((row) => row.online);
  return {
    // Прежняя форма остаётся: её читают админка и клиенты.
    online: Boolean(first),
    name: first?.name || rows[0]?.name || null,
    lastSeen: first?.lastSeen || rows[0]?.lastSeen || null,
    jobsDone: rows.reduce((sum, row) => sum + row.jobsDone, 0),
    agents: rows,
  };
}

/** Снять одну машину с линии, отпустив её задачи. */
function dropAgent(agentId, reason) {
  const entry = live.get(agentId);
  live.delete(agentId);
  for (const [id, pending] of waiting) {
    if (pending.agentId !== agentId) continue;
    clearTimeout(pending.timer);
    waiting.delete(id);
    pending.reject(new Error(reason));
  }
  if (entry) {
    try { entry.socket.close(); } catch { /* уже закрыт */ }
  }
}

/** Полный сброс — нужен тестам. */
function forget() {
  for (const id of [...live.keys()]) dropAgent(id, 'сброс');
  live.clear();
}

/** Отправить задачу конкретной машине. */
function sendTo(agentId, job) {
  const entry = live.get(agentId);
  if (!alive(entry)) return Promise.reject(new Error('ПК не на связи'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('ПК не ответил вовремя'));
    }, JOB_TIMEOUT_MS);
    waiting.set(id, { resolve, reject, timer, agentId });
    entry.socket.send(JSON.stringify({ type: 'job', id, ...job }));
  });
}

/** Совместимость: задача первой машине на связи. */
function send(job) {
  const first = onlineAgents()[0];
  if (!first) return Promise.reject(new Error('ПК не на связи'));
  return sendTo(first.id, job);
}

function greet(socket, data) {
  // Сначала новый ключ компьютера, затем — на время перехода — старый
  // токен человека с правом may_serve. Из него заводится НАСТОЯЩАЯ машина:
  // полупризнанная, которой очередь не даёт задач, была бы хуже отказа —
  // связь выглядела бы живой, а диктовки молча уходили бы в облако.
  let agent = agents.byKey(data.key || data.token || '');
  if (!agent && (data.token || data.key)) {
    const keys = require('../keys');
    const device = keys.authenticate(data.token || data.key || '');
    if (device && device.mayServe) {
      agent = agents.adopt(data.token || data.key, data.name || 'ПК');
    }
  }
  if (!agent) {
    socket.send(JSON.stringify({
      type: 'denied',
      message: 'Нужен ключ компьютера — раздел «Компьютеры» в админке',
    }));
    try { socket.close(); } catch { /* уже закрывается */ }
    return;
  }

  // Тот же компьютер переподключился: прежний сокет мог не успеть
  // закрыться. Его задачи отпускаем, а ему самому говорим прямо — иначе
  // два ПК с одним ключом молча выбивали бы друг друга каждые две
  // секунды, и оба показывали бы «на связи».
  const prev = live.get(agent.id);
  if (prev && prev.socket === socket) {
    prev.lastSeen = Date.now();
    socket.send(JSON.stringify({ type: 'welcome' }));
    return;
  }
  if (prev) {
    try {
      prev.socket.send(JSON.stringify({
        type: 'denied',
        message: 'Этим ключом подключился другой компьютер. Каждой машине — свой ключ',
      }));
    } catch { /* уже закрыт */ }
    dropAgent(agent.id, 'ПК переподключился');
  }

  live.set(agent.id, { socket, name: agent.name, lastSeen: Date.now() });
  if (agent.id > 0) agents.noteSeen(agent.id);
  socket.send(JSON.stringify({ type: 'welcome' }));
}

/**
 * Разбор одного сообщения. Вынесено из register: чистую логику можно
 * гонять тестами без сети и настоящего сокета.
 */
function handle(socket, message) {
  let data;
  try { data = JSON.parse(message); } catch { return; }

  if (data.type === 'hello') {
    greet(socket, data);
    return;
  }

  // Сообщения принимаем только от поздоровавшегося сокета.
  let agentId = null;
  for (const [id, entry] of live) {
    if (entry.socket === socket) { agentId = id; break; }
  }
  if (agentId === null) return;
  live.get(agentId).lastSeen = Date.now();

  if (data.type !== 'result' && data.type !== 'error') return;

  const pending = waiting.get(data.id);
  if (!pending || pending.agentId !== agentId) return;
  clearTimeout(pending.timer);
  waiting.delete(data.id);

  if (data.type === 'error') {
    pending.reject(new Error(data.message || 'ПК не смог обработать'));
    return;
  }
  if (agentId > 0) agents.noteJob(agentId);
  pending.resolve(data.result);
}

/** Спросить машину по-настоящему и замерить ответ. */
async function ping(agentId) {
  const target = agentId
    ? (alive(live.get(Number(agentId))) ? Number(agentId) : null)
    : (onlineAgents()[0]?.id ?? null);
  if (target === null) return { ok: false, error: 'ПК не на связи' };
  const started = Date.now();
  try {
    await sendTo(target, { kind: 'ping', payload: {} });
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function register(app) {
  app.get('/agent', { websocket: true }, (socket) => {
    const heartbeat = setInterval(() => {
      // Судим только о своём сокете: их теперь много.
      let mine = null;
      for (const [id, entry] of live) {
        if (entry.socket === socket) { mine = id; break; }
      }
      if (mine === null) {
        clearInterval(heartbeat);
        try { socket.close(); } catch { /* уже закрыт */ }
        return;
      }
      if (Date.now() - live.get(mine).lastSeen > DEAD_MS) {
        dropAgent(mine, 'ПК перестал отвечать');
        clearInterval(heartbeat);
        return;
      }
      try { socket.send(JSON.stringify({ type: 'ping' })); } catch { /* закрывается */ }
    }, PING_MS);

    socket.on('message', (raw) => handle(socket, raw.toString()));
    socket.on('close', () => {
      clearInterval(heartbeat);
      for (const [id, entry] of live) {
        if (entry.socket === socket) { dropAgent(id, 'ПК отключился'); break; }
      }
    });
  });
}

module.exports = {
  register, handle, forget, online, onlineAgents, send, sendTo, ping, state,
  dropAgent, PING_MS, DEAD_MS,
};
