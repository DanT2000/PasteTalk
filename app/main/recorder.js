'use strict';

const { EventEmitter } = require('node:events');

const config = require('./config');
const engine = require('./engine');
const { tr } = require('./i18n');
const llm = require('./llm');
const modes = require('../../shared/modes');
const paste = require('./paste');
const remote = require('./remote');
const log = require('./logger').scoped('record');

/**
 * Порядок одной записи, от нажатия клавиши до текста в буфере.
 *
 * Ключевое решение: обычный текст уходит в буфер сразу, как только его
 * вернул Whisper. Улучшение языковой моделью — отдельный, необязательный
 * шаг сверху. Если модель молчит или её нет, человек уже с текстом.
 */

// Столько цифровой тишины подряд — и на панели появляется подсказка про
// микрофон. Именно подсказка, не отмена: микрофон с аппаратным шумодавом
// отдаёт честный ноль в каждой паузе речи, и рвать запись по нулям значило
// бы выбрасывать диктовки у всех, у кого такой микрофон. Порог заметно
// больше обычной паузы в диктовке: подсказка — про умершее устройство,
// а не про то, что человек задумался.
const MIC_QUIET_MS = 6000;
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
    this.hadSignal = false;
    this.silentSince = 0;
    this.lastText = '';
    this.busy = false;
    // Обычный текст не вставился из-за окна «от администратора». Помним
    // до конца записи: если улучшение упадёт или его отменят, человеку
    // всё равно нужно сказать, что вставлять придётся руками.
    this.plainElevated = false;
    // Копилка звука для внешнего распознавания. null означает «копить не
    // надо» — иначе брошенная запись осталась бы висеть в памяти.
    this.chunks = null;
    // Номер попытки. Растёт при каждой отмене: ответ, пришедший от
    // прежней, узнаётся по устаревшему номеру и выбрасывается.
    this.attempt = (this.attempt || 0) + 1;
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

    // Хвост прежней записи не должен дотягиваться до новой. Таймер
    // «спрятать панель» от только что показанного результата иначе
    // стрелял бы посреди свежей диктовки и молча гасил её: человек
    // говорит, а запись уже сброшена — «иногда просто молчит».
    this.cancelHide();

    // Прежняя запись ещё считается, а человек жмёт клавишу снова —
    // «кажется, не сработало». Её ответ принимать уже нельзя: он доведёт
    // дело до reset() и погасит новую запись на полуслове.
    if (this.state === 'thinking' || this.state === 'ai') {
      this.attempt += 1;
    }

    // Когда считает не эта машина, движок не нужен вовсе: копим звук
    // и отправим целиком. Проверять его готовность тут нельзя — на
    // слабом компьютере модель может быть вообще не загружена.
    if (remote.isRemote()) return this.startRemote(mode);

    if (!engine.isReady) {
      this.emitState('engineDown', { hint: tr(engine.lastError || 'Движок ещё запускается') });
      this.scheduleHide(3000);
      return;
    }
    this.busy = true;
    try {
      // Словарь специфики уходит подсказкой Whisper: со списком терминов
      // перед глазами он пишет «Coolify», а не «кулифай».
      const session = await engine.openSession({
        language: config.get('language', 'ru') === 'auto' ? null : config.get('language', 'ru'),
        prompt: modes.whisperPrompt(config.get('speech.vocabulary', '')),
      });
      this.sessionId = session.id;
      this.mode = mode;
      this.startedAt = Date.now();
      this.everSpoke = false;
      this.hadSignal = false;
      this.silentSince = Date.now();
      this.lastText = '';
      this.emitState('listening', { elapsedMs: 0 });
      this.watchStream();
      log.info(`запись начата (${mode}), сессия ${this.sessionId}`);
    } catch (error) {
      log.error(error);
      this.emitState('engineDown', { hint: tr(error.code === 'MODEL_NOT_READY' ? 'Модель ещё грузится' : error.message) });
      this.scheduleHide(3000);
    } finally {
      this.busy = false;
    }
  }

  /** Начать запись, которую посчитают снаружи. Движок не задействован. */
  startRemote(mode) {
    this.sessionId = null;
    this.chunks = [];
    this.mode = mode;
    this.startedAt = Date.now();
    this.everSpoke = false;
    this.hadSignal = false;
    this.silentSince = Date.now();
    this.lastText = '';
    this.emitState('listening', { elapsedMs: 0 });
    this.watchStream();
    log.info(`запись начата (${mode}), считать будет ${remote.where()}`);
  }

  /**
   * Сторожок потока: чанки перестали приходить вовсе.
   *
   * Мёртвое устройство отдаёт нули — их ловит проверка на peak. Но если
   * звуковой граф встал целиком, pushAudio просто перестаёт вызываться,
   * и без сторожка запись висела бы «слушаю» вечно.
   */
  watchStream() {
    clearInterval(this.streamWatch);
    this.lastChunkAt = Date.now();
    this.streamWatch = setInterval(() => {
      if (this.state !== 'listening') {
        clearInterval(this.streamWatch);
        return;
      }
      if (Date.now() - this.lastChunkAt > 4000) {
        clearInterval(this.streamWatch);
        log.warn('звук перестал приходить из окна записи');
        this.micTrouble('поток звука остановился');
      }
    }, 1000);
  }

  // ---------- поток звука из окна записи ----------

  async pushAudio(chunk, peak) {
    if (this.state !== 'listening') return;
    this.lastChunkAt = Date.now();
    if (this.chunks) return this.collect(chunk, peak);
    if (!this.sessionId) return;

    if (peak > 0.0005) {
      this.silentSince = Date.now();
      this.hadSignal = true;
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
    this.emitState('listening', { elapsedMs, ...this.quietHint() });

    const limits = config.get('limits', {});

    if (elapsedMs >= limits.maxDurationMs) {
      log.info('достигнут предел по времени');
      await this.finish('limit');
      return;
    }
    if (!this.everSpoke && limits.noSpeechCancelMs > 0 && elapsedMs >= limits.noSpeechCancelMs) {
      await this.noSpeechTimeout();
      return;
    }
    if (this.everSpoke && limits.silenceStopMs > 0 && reply.silenceMs >= limits.silenceStopMs) {
      log.info('долгая тишина после речи — заканчиваю');
      await this.finish('done');
      return;
    }
  }

  /**
   * Подсказка на панель, когда микрофон долго отдаёт ровный ноль.
   *
   * Запись при этом идёт: ноль — это и мёртвое устройство, и обычная
   * пауза у микрофона с аппаратным шумодавом. Человек видит подсказку
   * прямо во время записи и сам решает, что делать, — а не узнаёт о
   * проблеме после того, как наговорил десять минут в пустоту.
   */
  quietHint() {
    if (Date.now() - this.silentSince <= MIC_QUIET_MS) return {};
    return { status: tr('Микрофон отдаёт тишину'), hint: tr('Запись идёт — проверьте устройство') };
  }

  /**
   * За отведённое время не распознано ни слова.
   *
   * Аварийное правило: если хоть какой-то звук был — пробуем распознать,
   * а не выбрасываем. Тихий голос, который не разбудил детектор речи, —
   * не повод терять диктовку. Отмена остаётся только для микрофона,
   * не давшего ни звука вовсе.
   */
  async noSpeechTimeout() {
    if (this.hadSignal) {
      log.info('слов не услышал, но сигнал был — распознаю, что есть');
      await this.finish('done');
      return;
    }
    log.info('за отведённое время — ни звука с микрофона');
    await this.abort('micdead', 'Не пришло ни звука — проверьте устройство');
  }

  /**
   * Копить звук, пока человек говорит.
   *
   * Пределы по времени и тишине здесь те же, что и при местном
   * распознавании: они считаются по громкости, а не по тексту, и от того,
   * кто будет распознавать, не зависят.
   */
  collect(chunk, peak) {
    if (peak > 0.0005) {
      this.silentSince = Date.now();
      this.everSpoke = true;
      this.hadSignal = true;
    }

    this.chunks.push(Buffer.from(chunk));
    const elapsedMs = Date.now() - this.startedAt;
    this.emitState('listening', { elapsedMs, ...this.quietHint() });

    const limits = config.get('limits', {});
    if (elapsedMs >= limits.maxDurationMs) {
      log.info('достигнут предел по времени');
      this.finish('limit');
      return;
    }
    if (!this.everSpoke && limits.noSpeechCancelMs > 0 && elapsedMs >= limits.noSpeechCancelMs) {
      log.info('за отведённое время — ни звука с микрофона');
      this.abort('micdead', 'Не пришло ни звука — проверьте устройство');
      return;
    }
    if (this.everSpoke && limits.silenceStopMs > 0
        && Date.now() - this.silentSince >= limits.silenceStopMs) {
      log.info('долгая тишина после речи — заканчиваю');
      this.finish('done');
    }
  }

  /** Отправить накопленное туда, где считают. */
  async finishRemote(reason) {
    const attempt = this.attempt;
    const pcm = Buffer.concat(this.chunks || []);
    this.chunks = null;
    this.emitState(reason === 'limit' ? 'limit' : 'thinking');

    if (!this.everSpoke || pcm.length === 0) {
      this.emitState('nospeech');
      this.scheduleHide(1800);
      return;
    }

    try {
      const result = await remote.transcribe(pcm);
      await this.deliver(result.text, result.durationS, attempt);
    } catch (error) {
      if (attempt !== this.attempt) return;
      log.warn(`распознать снаружи не вышло: ${error.message}`);
      this.emitState('engineDown', { hint: tr(error.message) });
      this.scheduleHide(3600);
    }
  }

  // ---------- завершение ----------

  /** Закончить и отдать текст. reason определяет только подпись на панели. */
  async finish(reason = 'done') {
    if (this.state !== 'listening') return;
    if (this.chunks) return this.finishRemote(reason);
    if (!this.sessionId) return;
    const id = this.sessionId;
    this.sessionId = null;
    this.emitState(reason === 'limit' ? 'limit' : 'thinking');

    const attempt = this.attempt;
    let result;
    try {
      result = await engine.stopSession(id);
    } catch (error) {
      log.error(error);
      this.emitState('engineDown', { hint: tr(error.message) });
      this.scheduleHide(3000);
      return;
    }

    // Что движок счёл выдумкой — в журнал. Фильтр не должен работать
    // молча: если он однажды съест настоящую фразу, узнать об этом
    // можно будет только отсюда.
    for (const item of result.dropped || []) {
      log.info(`выброшено как выдумка модели: «${item.text}» — ${item.reason}`);
    }

    await this.deliver(result.text, result.durationS, attempt);
  }

  /**
   * Довести готовый текст до человека.
   *
   * Общее для обоих путей — местного и внешнего. Разными они остаются
   * только до этого места: дальше человеку всё равно, кто считал.
   */
  async deliver(raw, durationS = 0, attempt = this.attempt) {
    // Пришёл ответ от отменённой попытки — молча выбрасываем. Вставлять
    // его человеку в чужое окно нельзя.
    if (attempt !== this.attempt) {
      log.info('ответ отменённой записи выброшен');
      return;
    }
    let text = (raw || '').trim();
    if (text && !config.get('text.keepPunctuation', true)) text = stripPunctuation(text);
    if (!text) {
      this.emitState('nospeech');
      this.scheduleHide(1800);
      return;
    }

    this.lastText = text;
    const autoPaste = config.get('text.autoPaste', true);
    const delivered = await paste.deliver(text, autoPaste);
    this.plainElevated = Boolean(delivered.elevated);
    log.info(`распознано ${text.length} символов за ${Math.round(durationS)} с звука`);
    this.emit('text', { text, improved: false, seconds: durationS });

    const wantsAi = this.mode === 'improve' && config.get('ai.enabled', false);
    if (wantsAi) await this.improve(text, autoPaste);
    else {
      // Окно «от администратора» не принимает наш Ctrl+V — Windows молча
      // выбрасывает симулированное нажатие. Текст цел, но вставлять руками.
      // Статус, а не подсказка: в компактном виде подсказка скрыта, а
      // строка статуса видна всегда — предупреждение обязано дойти.
      this.emitState('done', delivered.elevated
        ? { status: tr('Вставьте сами: Ctrl+V'), hint: tr('Окно запущено от администратора') }
        : {});
      this.scheduleHide(delivered.elevated ? 5200 : HIDE_AFTER_MS);
    }
  }

  /** Прогнать последний текст через языковую модель. */
  async improve(source, autoPaste = config.get('text.autoPaste', true)) {
    const text = source || this.lastText;
    if (!text) {
      this.emitState('aierror', { hint: tr('Улучшать пока нечего') });
      this.scheduleHide(2400);
      return;
    }
    if (!config.get('ai.enabled', false)) {
      this.emitState('aierror', { hint: tr('Улучшение выключено в настройках') });
      this.scheduleHide(3000);
      return;
    }
    // Пока модель думает, панель обязана оставаться на экране: иначе
    // человек нажал кнопку и не увидел, чем всё кончилось.
    this.cancelHide();
    this.emitState('ai');
    const attempt = this.attempt;
    try {
      const improved = await llm.improve(text);
      // llm.cancel() бьёт по общему запросу и на чужой задаче с телефона
      // может не сработать вовсе. Номер попытки надёжнее: он говорит, что
      // человек уже передумал, и вставлять текст в чужое окно нельзя.
      if (attempt !== this.attempt) {
        log.info('улучшение отменённой записи выброшено');
        return;
      }
      const delivered = await paste.deliver(improved, autoPaste);
      this.lastText = improved;
      this.emit('text', { text: improved, improved: true });
      this.emitState('aidone', delivered.elevated
        ? { status: tr('Вставьте сами: Ctrl+V'), hint: tr('Окно запущено от администратора') }
        : {});
      this.scheduleHide(delivered.elevated ? 5200 : HIDE_AFTER_MS);
    } catch (error) {
      if (attempt !== this.attempt) return;
      if (llm.isCancelled(error)) {
        log.info('улучшение отменено человеком');
        this.emitState('cancelled', this.plainElevated
          ? { status: tr('Вставьте сами: Ctrl+V'), hint: tr('Окно запущено от администратора') }
          : { hint: tr('Обычный текст остался в буфере') });
        this.scheduleHide(this.plainElevated ? 5200 : 2400);
        return;
      }
      log.warn(`ИИ не справился: ${error.message}`);
      this.emitState('aierror', this.plainElevated
        ? { status: tr('Вставьте сами: Ctrl+V'), hint: tr('Окно запущено от администратора') }
        : { hint: tr(error.message) });
      this.scheduleHide(this.plainElevated ? 5200 : 3600);
    }
  }

  /**
   * Отменить то, что идёт прямо сейчас.
   *
   * Одна кнопка на все случаи: идёт запись — бросаем её, думает модель —
   * обрываем запрос, ничего не происходит — просто прячем панель.
   * Человеку не надо помнить, в каком она состоянии.
   */
  cancelCurrent() {
    if (this.state === 'listening') {
      // Крестик во время записи — это «передумал». Показывать после него
      // ещё три секунды надпись «Запись отменена» незачем: человек и так
      // знает, что нажал, а панель мешает тому, к чему он вернулся.
      this.abort('cancelled', 'Запись отменена');
      this.cancelHide();
      this.emit('hide');
      const keep = this.lastText;
      this.reset();
      this.lastText = keep;
      return 'recording';
    }
    if (this.state === 'ai') {
      this.attempt += 1;
      llm.cancel();
      this.emitState('cancelled', this.plainElevated
        ? { status: tr('Вставьте сами: Ctrl+V'), hint: tr('Окно запущено от администратора') }
        : { hint: tr('Обычный текст остался в буфере') });
      this.scheduleHide(this.plainElevated ? 5200 : 2400);
      return 'ai';
    }
    if (this.state === 'thinking') {
      // Распознавание уже идёт, остановить его нельзя — но ответ, когда
      // придёт, принимать нельзя тем более: человек мог уйти в другое
      // окно, и вставка Ctrl+V ушла бы туда.
      this.attempt += 1;
      this.chunks = null;
      this.sessionId = null;
      this.emitState('cancelled', { hint: tr('Распознавание брошено') });
      this.scheduleHide(2000);
      return 'thinking';
    }
    this.emit('hide');
    const keep = this.lastText;
    this.reset();
    this.lastText = keep;
    return 'hidden';
  }

  /**
   * Звук пропал: устройство умерло, его забрала игра или поток встал.
   *
   * Если человек уже что-то наговорил — наговорённое дороже диагностики:
   * заканчиваем запись и распознаём, что есть. Раньше здесь была отмена,
   * и три секунды мёртвого микрофона выбрасывали всю диктовку — панель
   * говорила «Микрофон молчит», а текст пропадал.
   */
  async micTrouble(message = '') {
    if (this.state === 'listening' && this.everSpoke) {
      log.warn(`звук пропал после речи (${message || 'ровный ноль'}) — распознаю что есть`);
      await this.finish('done');
      return;
    }
    // Ошибка могла прийти и до того, как запись успела начаться, — панель
    // всё равно должна объяснить, что с микрофоном. Но в чужие состояния
    // (распознавание, улучшение) поздний сигнал лезть не должен.
    if (this.state === 'listening' || this.state === 'idle') {
      await this.abort('micdead', message);
    }
  }

  /** Бросить запись, ничего не подкладывая в буфер. */
  async abort(reason = 'nospeech', hint = '') {
    const id = this.sessionId;
    this.sessionId = null;
    this.chunks = null;
    if (id) engine.cancelSession(id).catch(() => {});
    this.emitState(reason, { hint: tr(hint) });
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
