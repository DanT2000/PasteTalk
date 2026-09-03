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
// Сон целиком — не раньше пяти минут простоя, даже если модель просят
// отпускать «сразу»: холодный старт процесса дороже перезагрузки модели,
// и гасить движок между двумя фразами одной мысли было бы вредительством.
const MIN_SLEEP_MS = Number(process.env.PASTETALK_MIN_SLEEP_MS) || 5 * 60 * 1000;
const SLEEP_GRACE_MS = process.env.PASTETALK_MIN_SLEEP_MS ? 0 : 30 * 1000;

class Engine {
  constructor() {
    this.child = null;
    this.port = 0;
    this.token = '';
    this.state = 'stopped';   // stopped | starting | ready | failed | sleeping
    this.lastError = '';
    this.restarts = 0;
    this.firstRestartAt = 0;
    this.stopping = false;
    this.onState = () => {};
    // Когда движку в последний раз давали работу. Опросы состояния не в
    // счёт: окно настроек спрашивает «как дела» каждые секунды.
    this.lastUsedAt = Date.now();
    this.waking = null;
    // Запросы в полёте и идущее засыпание — чтобы не уснуть под работой и
    // не начать запись в процесс, который уже гасится.
    this.inflight = 0;
    this.sleepJob = null;
  }

  // ---------- сон ----------

  /**
   * Уснуть: остановить процесс целиком и отдать всю память.
   *
   * Выгрузка модели по простою отдаёт видеопамять, но процесс с живым
   * контекстом CUDA держит ещё ~2 ГБ commit и до гигабайта резидентной —
   * ровно то, на что жалуются игры и браузеры. Сон отдаёт и это.
   */
  async sleep() {
    if (this.state !== 'ready' || !this.child || this.sleepJob) return;
    log.info('засыпаю: работы давно не было — отдаю память целиком');
    // Пока гасим процесс (до ~4 с), снаружи движок уже «не готов»: запись,
    // начатая в этот момент, идёт путём пробуждения, а не в мёртвый порт.
    this.sleepJob = (async () => {
      await this.stop();
      this.stopping = false;
      this.setState('sleeping');
    })();
    try {
      await this.sleepJob;
    } finally {
      this.sleepJob = null;
    }
  }

  /** Пора ли спать: простой дольше срока выгрузки, и никто не работает. */
  maybeSleep({ busy = false } = {}) {
    if (!config.get('engine.deepSleep', true)) return;
    // Только на видеокарте: там после выгрузки модели процесс держит ~2 ГБ
    // контекста CUDA. На процессоре выгрузка отдаёт почти всё сама, а
    // холодная загрузка большой модели длится минуту — сон не окупается.
    const testMode = Boolean(process.env.PASTETALK_MIN_SLEEP_MS);
    if (!testMode && config.get('model.device', 'cuda') !== 'cuda') return;
    const idle = Number(config.get('engine.idleUnloadMs', -1));
    if (idle < 0 || busy || this.state !== 'ready' || this.inflight > 0) return;
    if (Date.now() - this.lastUsedAt < Math.max(idle, MIN_SLEEP_MS) + SLEEP_GRACE_MS) return;
    this.sleep().catch((error) => log.warn(`не уснул: ${error.message}`));
  }

  /** Разбудить (если спит) и дождаться готовности. Ошибка — словами. */
  wake() {
    if (this.waking) return this.waking;
    this.waking = (async () => {
      if (this.sleepJob) await this.sleepJob;
      if (this.state === 'sleeping') {
        log.info('просыпаюсь: понадобилась работа');
        this.lastUsedAt = Date.now();
        await this.start();
      }
      await this.waitReady();
    })().finally(() => { this.waking = null; });
    return this.waking;
  }

  waitReady(timeoutMs = READY_TIMEOUT_MS + 5000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (this.isReady) { resolve(); return; }
        if (this.state === 'failed') { reject(new Error(this.lastError || 'Движок не запустился')); return; }
        if (this.state === 'stopped' || this.state === 'sleeping') { reject(new Error('Движок остановлен')); return; }
        if (Date.now() - started > timeoutMs) { reject(new Error('Движок не ответил за минуту')); return; }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  /** Может ли движок взять работу — сразу или после пробуждения. */
  get canWork() {
    return this.isReady || this.dormant;
  }

  /** Спит, засыпает или поднимается — запись должна ждать его, а не отказывать. */
  get dormant() {
    return this.state === 'sleeping' || this.state === 'starting' || Boolean(this.sleepJob);
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
    // Папку можно вынести на просторный диск: модели занимают гигабайты,
    // а системный раздел у людей часто забит под завязку. В папку
    // установки её класть нельзя — обновление стирает установку целиком,
    // и модели пришлось бы качать заново после каждого выпуска.
    const custom = String(config.get('engine.modelsDir', '') || '');
    return custom || path.join(app.getPath('userData'), 'models');
  }

  // ---------- жизненный цикл ----------

  async start() {
    if (this.child) return;
    // Идёт перенос папки моделей: подниматься нельзя, движок открыл бы
    // файлы, которые прямо сейчас копируются и удаляются.
    if (this.moving) return;
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
    const child = spawn(found.command, args, {
      cwd: found.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    // Движок считает голос человека, который ждёт результата прямо сейчас —
    // ему приоритет выше обычного, как и приложению.
    try {
      const os = require('node:os');
      os.setPriority(child.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
    } catch (error) {
      log.warn(`приоритет движка не поднялся: ${error.message}`);
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.readStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = chunk.trim();
      if (text) log.warn(text.split('\n').slice(-3).join(' | '));
    });
    child.on('exit', (code) => {
      // Поздний exit процесса, который уже заменили новым (застрял на
      // kill дольше таймаута stop): трогать свежий child ему нельзя.
      if (this.child !== child) return;
      this.handleExit(code);
    });
    child.on('error', (error) => this.fail(`Движок не запустился: ${error.message}`));

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
    const child = this.child;
    this.child = null;
    if (child) {
      // Дожидаемся настоящей смерти процесса: /shutdown отвечает до
      // выхода, а модель держит свой файл открытым — двигать её из-под
      // живого процесса нельзя.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        try { child.kill(); } catch { resolve(); }
      });
    }
    // Порт и токен принадлежали убитому процессу: следующий получит свои.
    this.port = 0;
    this.token = '';
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
    return this.state === 'ready' && this.port > 0 && !this.sleepJob;
  }

  // ---------- HTTP-клиент ----------

  request(method, route, body, timeoutMs = 30000) {
    // Опросы состояния — не работа: от них движок не просыпается, и срок
    // сна по ним не сдвигается. Всё остальное будит спящий движок само,
    // так что вызывающим не нужно знать, спит он или нет.
    // Опрос закачек — не пассивный: пока модель качается впрок, движок
    // занят, и усыплять его значит оборвать закачку.
    const passive = (method === 'GET' && (route === '/health' || route === '/model'))
      || route === '/idle';
    if (this.state === 'sleeping') {
      if (passive) return Promise.reject(new Error('Движок спит'));
      return this.wake().then(() => this.request(method, route, body, timeoutMs));
    }
    // Запросы в полёте считаем: остановка сессии на слабом процессоре
    // длится минуту, и по одной лишь отметке «когда начали» движок
    // засыпал прямо под расшифровкой. Отметка времени — и в начале, и
    // в конце: простой отсчитывается от конца работы.
    if (!passive) {
      this.inflight += 1;
      this.lastUsedAt = Date.now();
    }
    const settle = () => {
      if (passive) return;
      this.inflight = Math.max(0, this.inflight - 1);
      this.lastUsedAt = Date.now();
    };
    const pending = new Promise((resolve, reject) => {
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
        // Оборванный посреди тела ответ (движок упал или перезапущен) обязан
        // завершить обещание: иначе счётчик запросов в полёте зависает и
        // движок больше никогда не засыпает.
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('Движок оборвал ответ')));
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
    pending.then(settle, settle);
    return pending;
  }

  health() { return this.request('GET', '/health', null, 5000); }
  modelStatus() { return this.request('GET', '/model', null, 5000); }
  loadModel(model) { return this.request('POST', '/model', model, 10000); }
  deleteModel(name) { return this.request('DELETE', `/model/${name}`, null, 30000); }
  // Запас на честный замер: до двух минут ожидания нужной модели,
  // прогрев и сам прогон минуты звука на слабом процессоре.
  benchmark() { return this.request('POST', '/benchmark', {}, 480000); }

  openSession(options) { return this.request('POST', '/session', options, 10000); }
  pushAudio(id, chunk) { return this.request('POST', `/session/${id}/audio`, chunk, 30000); }
  stopSession(id) { return this.request('POST', `/session/${id}/stop`, {}, 300000); }
  cancelSession(id) { return this.request('DELETE', `/session/${id}`, null, 5000); }

  setIdleUnload(ms) { return this.request('POST', '/idle', { ms }, 5000); }

  downloadModel(name) { return this.request('POST', '/model/download', { name }, 10000); }
  downloadsStatus() { return this.request('GET', '/model/downloads', null, 5000); }
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
  async transcribeBuffer(buffer, { filename = 'voice.ogg', language = null, prompt = '', model = undefined } = {}) {
    const os = require('node:os');
    const fsp = require('node:fs/promises');
    const safe = String(filename).replace(/[^\w.-]/g, '_');
    const temp = path.join(os.tmpdir(), `pastetalk-${Date.now()}-${safe}`);
    await fsp.writeFile(temp, buffer);
    try {
      const job = await this.startFile({ path: temp, language, timestamps: false, prompt, model });
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
