'use strict';

const { EventEmitter } = require('node:events');

const config = require('./config');
const engine = require('./engine');
const llm = require('./llm');
const paste = require('./paste');
const log = require('./logger').scoped('record');

/**
 * Порядок одной записи, от нажатия клавиши до текста в буфере.
 *
 * Ключевое решение: обычный текст уходит в буфер сразу, как только его
 * вернул Whisper. Улучшение языковой моделью — отдельный, необязательный
 * шаг сверху. Если модель молчит или её нет, человек уже с текстом.
 */

const MIC_DEAD_MS = 3000;      // столько цифровой тишины — и микрофон считаем немым
const HIDE_AFTER_MS = 2200;    // сколько панель висит с готовым результатом

/**
 * Убрать знаки препинания, если человек их не хочет.
 *
 * Whisper расставляет их сам и отключить это в модели нельзя — значит
 * снимаем уже с готового текста. Дефисы внутри слов и апострофы трогать
 * нельзя: «кто-то» и «O'Brien» должны остаться собой.
 */
function stripPunctuation(text) {
  return text
    .replace(/[.,!?;:…«»"„“”()\[\]{}]/g, '')
    .replace(/\s+—\s+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

class Recorder extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.state = 'idle';
    this.sessionId = null;
    this.mode = 'plain';
    this.startedAt = 0;
    this.everSpoke = false;
    this.silentSince = 0;
    this.lastText = '';
    this.busy = false;
  }

  get active() {
    return this.state === 'listening';
  }

  emitState(state, extra = {}) {
    this.state = state;
    this.emit('state', { state, ...extra });
  }

  // ---------- запуск ----------

  async start(mode = 'plain') {
    if (this.busy || this.state === 'listening') return;
    if (!engine.isReady) {
      this.emitState('engineDown', { hint: engine.lastError || 'Движок ещё запускается' });
      this.scheduleHide(3000);
      return;
    }
    this.busy = true;
    try {
      const session = await engine.openSession({
        language: config.get('language', 'ru') === 'auto' ? null : config.get('language', 'ru'),
      });
      this.sessionId = session.id;
      this.mode = mode;
      this.startedAt = Date.now();
      this.everSpoke = false;
      this.silentSince = Date.now();
      this.lastText = '';
      this.emitState('listening', { elapsedMs: 0 });
      log.info(`запись начата (${mode}), сессия ${this.sessionId}`);
    } catch (error) {
      log.error(error);
      this.emitState('engineDown', { hint: error.code === 'MODEL_NOT_READY' ? 'Модель ещё грузится' : error.message });
      this.scheduleHide(3000);
    } finally {
      this.busy = false;
    }
  }

  // ---------- поток звука из окна записи ----------

  async pushAudio(chunk, peak) {
    if (this.state !== 'listening' || !this.sessionId) return;

    // Микрофон, который отдаёт ровный ноль, — это не молчащий человек,
    // а выключенное или занятое устройство. Об этом лучше сказать прямо.
    if (peak > 0.0005) this.silentSince = Date.now();
    else if (Date.now() - this.silentSince > MIC_DEAD_MS) {
      await this.abort('micdead');
      return;
    }

    let reply;
    try {
      reply = await engine.pushAudio(this.sessionId, chunk);
    } catch (error) {
      log.error(`поток прервался: ${error.message}`);
      await this.abort('engineDown', error.message);
      return;
    }
    if (this.state !== 'listening') return;

    if (reply.everSpoke) this.everSpoke = true;
    const elapsedMs = Date.now() - this.startedAt;
    this.emit('partial', { segments: reply.segments || [], elapsedMs });
    this.emitState('listening', { elapsedMs });

    const limits = config.get('limits', {});

    if (elapsedMs >= limits.maxDurationMs) {
      log.info('достигнут предел по времени');
      await this.finish('limit');
      return;
    }
    if (!this.everSpoke && limits.noSpeechCancelMs > 0 && elapsedMs >= limits.noSpeechCancelMs) {
      log.info('за отведённое время не сказано ни слова — отменяю');
      await this.abort('nospeech');
      return;
    }
    if (this.everSpoke && limits.silenceStopMs > 0 && reply.silenceMs >= limits.silenceStopMs) {
      log.info('долгая тишина после речи — заканчиваю');
      await this.finish('done');
      return;
    }
  }

  // ---------- завершение ----------

  /** Закончить и отдать текст. reason определяет только подпись на панели. */
  async finish(reason = 'done') {
    if (this.state !== 'listening' || !this.sessionId) return;
    const id = this.sessionId;
    this.sessionId = null;
    this.emitState(reason === 'limit' ? 'limit' : 'thinking');

    let result;
    try {
      result = await engine.stopSession(id);
    } catch (error) {
      log.error(error);
      this.emitState('engineDown', { hint: error.message });
      this.scheduleHide(3000);
      return;
    }

    let text = (result.text || '').trim();
    if (text && !config.get('text.keepPunctuation', true)) text = stripPunctuation(text);
    if (!text) {
      this.emitState('nospeech');
      this.scheduleHide(1800);
      return;
    }

    this.lastText = text;
    const autoPaste = config.get('text.autoPaste', true);
    await paste.deliver(text, autoPaste);
    log.info(`распознано ${text.length} символов за ${Math.round(result.durationS)} с звука`);
    this.emit('text', { text, improved: false, seconds: result.durationS });

    const wantsAi = this.mode === 'improve' && config.get('ai.enabled', false);
    if (wantsAi) await this.improve(text, autoPaste);
    else {
      this.emitState('done');
      this.scheduleHide(HIDE_AFTER_MS);
    }
  }

  /** Прогнать последний текст через языковую модель. */
  async improve(source, autoPaste = config.get('text.autoPaste', true)) {
    const text = source || this.lastText;
    if (!text) {
      this.emitState('aierror', { hint: 'Улучшать пока нечего' });
      this.scheduleHide(2400);
      return;
    }
    if (!config.get('ai.enabled', false)) {
      this.emitState('aierror', { hint: 'Улучшение выключено в настройках' });
      this.scheduleHide(3000);
      return;
    }
    // Пока модель думает, панель обязана оставаться на экране: иначе
    // человек нажал кнопку и не увидел, чем всё кончилось.
    this.cancelHide();
    this.emitState('ai');
    try {
      const improved = await llm.improve(text);
      await paste.deliver(improved, autoPaste);
      this.lastText = improved;
      this.emit('text', { text: improved, improved: true });
      this.emitState('aidone');
      this.scheduleHide(HIDE_AFTER_MS);
    } catch (error) {
      log.warn(`ИИ не справился: ${error.message}`);
      this.emitState('aierror', { hint: error.message });
      this.scheduleHide(3600);
    }
  }

  /** Бросить запись, ничего не подкладывая в буфер. */
  async abort(reason = 'nospeech', hint = '') {
    const id = this.sessionId;
    this.sessionId = null;
    if (id) engine.cancelSession(id).catch(() => {});
    this.emitState(reason, { hint });
    this.scheduleHide(reason === 'nospeech' ? 1800 : 3600);
  }

  /** Переключатель по горячей клавише: не идёт — начать, идёт — закончить. */
  toggle(mode = 'plain') {
    if (this.state === 'listening') return this.finish('done');
    return this.start(mode);
  }

  scheduleHide(ms) {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.emit('hide');
      // Последний текст переживает закрытие панели: кнопку «улучшить»
      // и горячую клавишу можно нажать и после того, как окно погасло.
      const keep = this.lastText;
      this.reset();
      this.lastText = keep;
    }, ms);
  }

  cancelHide() {
    clearTimeout(this.hideTimer);
  }
}

module.exports = new Recorder();
