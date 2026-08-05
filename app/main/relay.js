'use strict';

const os = require('node:os');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const config = require('./config');
const engine = require('./engine');
const llm = require('./llm');
const log = require('./logger').scoped('relay');

/**
 * Связь с сервером PasteTalk.
 *
 * Звоним всегда мы: сервер не знает, где стоит этот компьютер, и знать не
 * должен. Ни портов пробрасывать, ни IP держать постоянным не требуется —
 * достаточно исходящего соединения, которое умеет пережить обрыв.
 *
 * Обрыв тут обычное дело, а не поломка: ноутбук закрыли, вайфай моргнул,
 * сервер перезапустился. Поэтому переподключаемся сами, с нарастающей
 * паузой — чтобы не долбить сервер каждую секунду, когда его нет.
 */

const RETRY_MS = [2000, 5000, 15000, 30000, 60000];

class Relay extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.status = 'off';
    this.hint = '';
    this.attempt = 0;
    this.timer = null;
  }

  state() {
    return { status: this.status, hint: this.hint };
  }

  setState(status, hint = '') {
    this.status = status;
    this.hint = hint;
    this.emit('state', this.state());
  }

  connect() {
    if (!config.get('relay.enabled', false)) {
      this.setState('off');
      return;
    }
    const url = String(config.get('relay.url', '')).trim();
    const token = config.get('relay.token', '');
    if (!url || !token) {
      this.setState('error', !url ? 'Не указан адрес сервера' : 'Код доступа ещё не введён');
      return;
    }

    clearTimeout(this.timer);
    this.setState('connecting');

    let socket;
    try {
      socket = new WebSocket(`${url.replace(/\/+$/, '')}/agent`);
    } catch (error) {
      this.setState('error', `Адрес не годится: ${error.message}`);
      return;
    }
    this.socket = socket;

    socket.on('open', () => {
      this.attempt = 0;
      socket.send(JSON.stringify({
        type: 'hello',
        token,
        name: config.get('relay.name', '') || os.hostname(),
      }));
      this.setState('online');
      log.info('соединение с сервером установлено');
    });

    socket.on('message', (raw) => this.handle(raw.toString()));

    socket.on('error', (error) => {
      // Само по себе это ещё не конец: за ошибкой придёт close, и там мы
      // решим, переподключаться или нет.
      this.hint = error.message;
      log.warn(`связь с сервером: ${error.message}`);
    });

    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.status !== 'off') this.retry();
    });
  }

  retry() {
    const wait = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.attempt += 1;
    this.setState('connecting', `Переподключение через ${Math.round(wait / 1000)} с`);
    this.timer = setTimeout(() => this.connect(), wait);
  }

  disconnect() {
    clearTimeout(this.timer);
    this.attempt = 0;
    this.setState('off');
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(); } catch { /* уже закрыт */ }
    }
  }

  /** Перечитать настройки: включили, выключили или сменили адрес. */
  refresh() {
    this.disconnect();
    if (config.get('relay.enabled', false)) this.connect();
  }

  async handle(raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'ping') {
      this.reply({ type: 'pong' });
      return;
    }
    if (data.type !== 'job') return;

    try {
      const result = data.kind === 'stt'
        ? await this.doStt(data.payload)
        : await this.doLlm(data.payload);
      this.reply({ type: 'result', id: data.id, result });
    } catch (error) {
      log.warn(`задача с сервера не вышла: ${error.message}`);
      this.reply({ type: 'error', id: data.id, message: error.message });
    }
  }

  reply(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  async doStt(payload) {
    const audio = Buffer.from(payload.audio, 'base64');
    const result = await engine.transcribeBuffer(audio, {
      filename: payload.filename,
      language: payload.language,
    });
    return { text: result.text, seconds: result.durationS, model: result.model };
  }

  async doLlm(payload) {
    // llm.improve(text, overrides): второй аргумент подмешивается поверх
    // сохранённых настроек, см. resolve() в llm.js. Так режим приходит с
    // телефона, а провайдер и ключ берутся здешние.
    const text = await llm.improve(payload.text, { mode: payload.mode });
    // Токены считать неоткуда — improve возвращает только текст. Ноль тут
    // честнее выдуманного числа: своя модель денег и так не берёт.
    return { text, tokensIn: 0, tokensOut: 0, model: config.get('ai.model', '') };
  }
}

module.exports = new Relay();
