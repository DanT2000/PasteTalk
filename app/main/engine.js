'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app } = require('electron');

const config = require('./config');
const log = require('./logger').scoped('engine');

/**
 * Движок распознавания — отдельный процесс. Так проще всего:
 * упавшая модель не роняет интерфейс, а тяжёлая CUDA живёт своей жизнью.
 *
 * Здесь только присмотр за процессом и тонкий HTTP-клиент к нему.
 */

const READY_PREFIX = 'PASTETALK_ENGINE ';
const READY_TIMEOUT_MS = 60000;

// Десять попыток — но в пределах получаса. Движок, который упал один раз
// за день, не должен доедать лимит, накопленный неделю назад; а тот, что
// падает по кругу прямо сейчас, должен упереться в потолок и сказать об
// этом человеку, а не молотить вечно.
const MAX_RESTARTS = 10;
const RESTART_WINDOW_MS = 30 * 60 * 1000;
const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

class Engine {
  constructor() {
    this.child = null;
    this.port = 0;
    this.token = '';
    this.state = 'stopped';   // stopped | starting | ready | failed
    this.lastError = '';
    this.restarts = 0;
    this.firstRestartAt = 0;
    this.stopping = false;
    this.onState = () => {};
  }

  // ---------- где искать движок ----------

  /** Собранный exe рядом с приложением, а в разработке — venv из репозитория. */
  locate() {
    const packed = path.join(process.resourcesPath || '', 'engine', 'pastetalk-engine.exe');
    if (fs.existsSync(packed)) return { command: packed, args: [] };

    const root = path.join(__dirname, '..', '..');
    const venv = path.join(root, 'engine', '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(venv)) {
      return { command: venv, args: ['-m', 'pastetalk_engine.server'], cwd: path.join(root, 'engine') };
    }
    return null;
  }

  modelsDir() {
    return path.join(app.getPath('userData'), 'models');
  }

  // ---------- жизненный цикл ----------

  async start() {
    if (this.child) return;
    const found = this.locate();
    if (!found) {
      this.fail('Движок распознавания не найден. Переустановите PasteTalk.');
      return;
    }

    this.setState('starting');
    const model = config.get('model', {});
    const wanted = Number(config.get('engine.port', 0)) || 0;
    const args = [
      ...found.args,
      '--host', '127.0.0.1',
      '--port', String(wanted),
      '--cache-dir', this.modelsDir(),
      '--parent-pid', String(process.pid),
      '--model', model.name || 'large-v3',
      '--device', model.device || 'cuda',
    ];

    // В разработке храним записи целиком: на живом голосе проверять
    // куда честнее, чем на синтезированном.
    if (process.argv.includes('--dev')) {
      args.push('--recordings', path.join(app.getPath('userData'), 'recordings'));
    }

    log.info(`запускаю: ${found.command}`);
    // stdin держим открытым специально: движок следит за ним и завершается
    // сам, когда труба рвётся — то есть когда приложение закрылось.
    this.child = spawn(found.command, args, {
      cwd: found.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.readStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.trim();
      if (text) log.warn(text.split('\n').slice(-3).join(' | '));
    });
    this.child.on('exit', (code) => this.handleExit(code));
    this.child.on('error', (error) => this.fail(`Движок не запустился: ${error.message}`));

    this.readyTimer = setTimeout(() => {
      if (this.state === 'starting') this.fail('Движок не ответил за минуту.');
    }, READY_TIMEOUT_MS);
  }

  readStdout(chunk) {
    this.buffer = (this.buffer || '') + chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      if (line.startsWith(READY_PREFIX)) {
        try {
          const info = JSON.parse(line.slice(READY_PREFIX.length));
          this.port = info.port;
          this.token = info.token;
          clearTimeout(this.readyTimer);
          this.restarts = 0;
          this.lastError = '';
          this.setState('ready');
          log.info(`готов на порту ${this.port}`);
        } catch (error) {
          this.fail(`Движок сказал непонятное: ${error.message}`);
        }
      } else {
        log.info(line);
      }
    }
  }

  handleExit(code) {
    clearTimeout(this.readyTimer);
    this.child = null;
    this.port = 0;
    if (this.stopping) {
      this.setState('stopped');
      return;
    }

    log.warn(`движок завершился с кодом ${code}`);
    if (!config.get('startup.restartOnCrash', true)) {
      this.fail('Движок остановился, а перезапуск после сбоя выключен в настройках.');
      return;
    }

    // Счётчик стареет: если полчаса всё было тихо, начинаем с нуля.
    const now = Date.now();
    if (now - this.firstRestartAt > RESTART_WINDOW_MS) {
      this.restarts = 0;
      this.firstRestartAt = now;
    }
    if (this.restarts >= MAX_RESTARTS) {
      this.fail(`Движок упал ${MAX_RESTARTS} раз за полчаса. Откройте журнал — там причина.`);
      return;
    }

    const delay = RESTART_DELAYS_MS[Math.min(this.restarts, RESTART_DELAYS_MS.length - 1)];
    this.restarts += 1;
    log.info(`перезапуск через ${delay} мс (попытка ${this.restarts} из ${MAX_RESTARTS})`);
    this.setState('starting');
    setTimeout(() => this.start(), delay);
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.readyTimer);
    if (!this.child) return;
    try {
      await this.request('POST', '/shutdown', {}, 1500);
    } catch {
      /* не ответил — добьём */
    }
    if (this.child) this.child.kill();
    this.child = null;
    this.setState('stopped');
  }

  fail(message) {
    clearTimeout(this.readyTimer);
    this.lastError = message;
    this.setState('failed');
    log.error(message);
  }

  setState(state) {
    this.state = state;
    this.onState({ state, error: this.lastError });
  }

  get isReady() {
    return this.state === 'ready' && this.port > 0;
  }

  // ---------- HTTP-клиент ----------

  request(method, route, body, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.port) {
        reject(new Error('Движок ещё не запустился'));
        return;
      }
      const binary = Buffer.isBuffer(body);
      const payload = body === undefined || body === null
        ? null
        : (binary ? body : Buffer.from(JSON.stringify(body), 'utf8'));

      const request = http.request({
        host: '127.0.0.1',
        port: this.port,
        path: route,
        method,
        headers: {
          'X-PasteTalk-Token': this.token,
          ...(payload ? {
            'Content-Type': binary ? 'application/octet-stream' : 'application/json',
            'Content-Length': payload.length,
          } : {}),
        },
      }, (response) => {
        const parts = [];
        response.on('data', (part) => parts.push(part));
        response.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let parsed;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            reject(new Error(`Движок ответил не JSON: ${text.slice(0, 200)}`));
            return;
          }
          if (response.statusCode >= 400) {
            const error = new Error(parsed.error || `Ошибка ${response.statusCode}`);
            error.code = parsed.error;
            reject(error);
            return;
          }
          resolve(parsed);
        });
      });

      request.setTimeout(timeoutMs, () => request.destroy(new Error('Движок не ответил вовремя')));
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  health() { return this.request('GET', '/health', null, 5000); }
  modelStatus() { return this.request('GET', '/model', null, 5000); }
  loadModel(model) { return this.request('POST', '/model', model, 10000); }
  deleteModel(name) { return this.request('DELETE', `/model/${name}`, null, 30000); }
  benchmark() { return this.request('POST', '/benchmark', {}, 300000); }

  openSession(options) { return this.request('POST', '/session', options, 10000); }
  pushAudio(id, chunk) { return this.request('POST', `/session/${id}/audio`, chunk, 30000); }
  stopSession(id) { return this.request('POST', `/session/${id}/stop`, {}, 300000); }
  cancelSession(id) { return this.request('DELETE', `/session/${id}`, null, 5000); }

  startFile(options) { return this.request('POST', '/file', options, 10000); }
  fileStatus(id) { return this.request('GET', `/file/${id}`, null, 10000); }
  cancelFile(id) { return this.request('DELETE', `/file/${id}`, null, 5000); }

  /**
   * Распознать звук, пришедший в памяти.
   *
   * Движок принимает только путь к файлу, поэтому буфер кладём во временный
   * и сразу убираем: чужой звук на диске не залёживается — обещали не
   * хранить, значит не храним, даже если распознавание сорвалось.
   */
  async transcribeBuffer(buffer, { filename = 'voice.ogg', language = null } = {}) {
    const os = require('node:os');
    const fsp = require('node:fs/promises');
    const safe = String(filename).replace(/[^\w.-]/g, '_');
    const temp = path.join(os.tmpdir(), `pastetalk-${Date.now()}-${safe}`);
    await fsp.writeFile(temp, buffer);
    try {
      const job = await this.startFile({ path: temp, language, timestamps: false });
      for (;;) {
        const state = await this.fileStatus(job.id);
        if (state.state === 'done') {
          return {
            text: state.text || '',
            durationS: state.durationS || 0,
            model: state.model || '',
          };
        }
        if (state.state === 'error') throw new Error(state.error || 'Движок не справился');
        await new Promise((wait) => setTimeout(wait, 500));
      }
    } finally {
      await fsp.rm(temp, { force: true });
    }
  }
}

module.exports = new Engine();
