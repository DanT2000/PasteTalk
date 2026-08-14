'use strict';

const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const config = require('./config');
const log = require('./logger').scoped('llm');

/**
 * Улучшение текста языковой моделью.
 *
 * Провайдеры бывают двух видов:
 *   openai — любой сервер с /v1/chat/completions: LM Studio, Ollama,
 *            сам OpenAI, DeepSeek, платные шлюзы;
 *   cli    — уже установленный на компьютере агент (Claude Code, Codex).
 *            Ему не нужен ни адрес, ни ключ: человек уже вошёл в свою
 *            подписку, и держать ради одной кнопки отдельную LLM незачем.
 *
 * Наружу оба вида выглядят одинаково: дай текст — получи текст.
 */

const PROVIDERS = {
  lmstudio: {
    title: 'LM Studio',
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    local: true,
    needsKey: false,
    hint: 'Запустите LM Studio и включите в нём локальный сервер',
  },
  ollama: {
    title: 'Ollama',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    local: true,
    needsKey: false,
    defaultModel: 'gemma3:12b',
    hint: 'Модель должна быть скачана: ollama pull',
  },
  claudeCli: {
    title: 'Claude Code',
    kind: 'cli',
    command: 'claude',
    args: ['-p', '--output-format', 'text'],
    modelFlag: '--model',
    local: true,
    needsKey: false,
    hint: 'Работает через вашу подписку Claude — ключ не нужен',
    models: [
      { id: '', title: 'Как в Claude Code — $$' },
      { id: 'haiku', title: 'Haiku — быстрая, $' },
      { id: 'sonnet', title: 'Sonnet — рабочая лошадка, $$' },
      { id: 'opus', title: 'Opus — самая сильная, $$$' },
    ],
  },
  codexCli: {
    title: 'Codex',
    kind: 'cli',
    command: 'codex',
    // --ephemeral: не оставлять файлы сессий после каждой правки текста.
    // -s read-only: агенту тут нечего писать на диск, пусть и не может.
    // «-» — читать запрос из stdin.
    args: ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-'],
    modelFlag: '--model',
    local: true,
    needsKey: false,
    hint: 'Работает через вашу подписку OpenAI — ключ не нужен',
    models: [
      { id: '', title: 'Как в Codex' },
      { id: 'gpt-5.6-luna', title: 'gpt-5.6-luna — полегче' },
      { id: 'gpt-5.6-terra', title: 'gpt-5.6-terra — средняя' },
      { id: 'gpt-5.6-sol', title: 'gpt-5.6-sol — по умолчанию у Codex' },
    ],
  },
  openai: {
    title: 'ChatGPT (OpenAI)',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    defaultModel: 'gpt-4o-mini',
  },
  deepseek: {
    title: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    defaultModel: 'deepseek-chat',
  },
  aitunnel: {
    title: 'AITunnel',
    kind: 'openai',
    baseUrl: 'https://api.aitunnel.ru/v1',
    needsKey: true,
    // Без этого в запрос уходила пустая модель, и шлюз отвечал 400 —
    // человеку показывалось «AITunnel ответил 400» без единой подсказки.
    defaultModel: 'deepseek-chat',
  },
  custom: {
    title: 'Своё, OpenAI-совместимое',
    kind: 'openai',
    baseUrl: '',
    // Ключ показываем, но не требуем: свой сервер бывает и с ключом,
    // и без. Пустое поле — просто не отправляем заголовок.
    needsKey: true,
    hint: 'Свой сервер: ключ впишите, если он его требует, иначе оставьте пустым',
  },
};

// Промпты общие с сервером: кнопка «Почистить» на компьютере и в телефоне
// обязана давать один результат. Раньше здесь жил свой дубль — и починки
// промптов доходили до сервера, но не до компьютера.
const modes = require('../../shared/modes');
const MODES = modes.MODES;

/**
 * Идущие запросы к моделям — по именам задач, чтобы прерывать прицельно.
 *
 * Модель думает секунды, а иногда и минуту. За это время человек успевает
 * передумать, и оставлять его смотреть на крутящийся кружок без выхода
 * нельзя. Слоты раздельные: 'dictation' — улучшение диктовки, 'digest' —
 * многоминутный конспект файла. Пока крутится конспект, Esc на панели
 * обязан находить именно запрос диктовки, а не промахиваться из-за того,
 * что общий слот занял очередной кусок конспекта.
 */
const stops = new Map();
const CANCELLED = 'PT_CANCELLED';

function jobOf(settings) {
  return settings.job === 'digest' ? 'digest' : 'dictation';
}

function cancel(job = 'dictation') {
  const stop = stops.get(job);
  if (!stop) return false;
  stops.delete(job);
  try {
    stop();
  } catch { /* уже завершился сам */ }
  log.info('запрос к модели прерван');
  return true;
}

function isCancelled(error) {
  return Boolean(error) && String(error.message).includes(CANCELLED);
}

function busy() {
  return stops.size > 0;
}

// ---------- настройки провайдера ----------

function resolve(overrides = {}) {
  const saved = config.get('ai', {});
  const merged = { ...saved, ...overrides };
  const id = merged.provider && PROVIDERS[merged.provider] ? merged.provider : 'lmstudio';
  const preset = PROVIDERS[id];
  return {
    ...merged,
    id,
    preset,
    baseUrl: merged.baseUrl || preset.baseUrl || '',
    model: merged.model || preset.defaultModel || '',
    apiKey: overrides.apiKey ?? (saved.keys || {})[id] ?? '',
  };
}

function instruction(settings) {
  // Словарь специфики живёт на этом компьютере, поэтому добавляется и к
  // готовой инструкции с сервера: задачу-то выполняет местная модель.
  const vocabulary = config.get('speech.vocabulary', '');
  // Готовая инструкция приходит с задачами от сервера: промпт мог быть
  // правлен в его админке, и собирать свой поверх было бы враньём.
  if (settings.instruction) return settings.instruction + modes.vocabularyClause(vocabulary);
  return modes.instruction(settings.mode, settings.prompt, vocabulary);
}

/**
 * Сколько ждать. Короткая фраза приходит за секунду, расшифровка на
 * двадцать минут — совсем не за секунду, и общий потолок в 30 секунд
 * обрубал бы именно те случаи, ради которых улучшение и нужно.
 */
function timeoutFor(text, settings) {
  if (settings.timeoutMs && settings.timeoutMs > 0) return settings.timeoutMs;
  // Запас щедрый намеренно: обычный текст уже лежит в буфере, так что
  // ожидание ничего не стоит, кроме кружка на панели. А первый запрос к
  // локальному серверу может уйти на минуту — он ещё поднимает модель
  // в память, и обрывать его на двадцатой секунде просто обидно.
  return Math.min(45000 + text.length * 60, 240000);
}

/** Модели вроде Gemma 4 иногда возвращают рассуждения прямо в тексте. */
function stripThinking(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:\w+)?\n([\s\S]*?)\n```$/m, '$1')
    .trim();
}

/**
 * Агенты любят начинать ответ с «Вот причёсанный текст:» — человеку нужен
 * только сам текст. Срезаем ТОЛЬКО такое вступление и только когда оно
 * безошибочно узнаётся: короткая первая строка, знакомое начало, слово о
 * результате и двоеточие в конце. Хвосты не трогаем вовсе: «Дайте знать,
 * если что» бывает настоящей концовкой надиктованного письма.
 */
function stripCourtesy(text) {
  const lines = text.split('\n');
  // Не \b: в JavaScript граница слова не работает с кириллицей.
  const opener = /^(вот|конечно|разумеется|хорошо|готово|пожалуйста|here|sure|of course|below)[\s,!.:'’—-]/i;
  // Слова, которыми модель называет свой ответ. Нарочно без голых «текст»
  // и «итог»: «Хорошо, итог такой:» — живая речь, её резать нельзя.
  const aboutResult = /(причёсанн|улучшенн|исправленн|переписанн|готовый|итоговый|конспект|результат|верси|вариант|cleaned|improved|final|result|summary|version)/i;
  while (lines.length > 1) {
    const first = lines[0].trim();
    // Пустые строки после срезанного вступления тоже уходят.
    if (first === '' || (first.length <= 90 && opener.test(first) && aboutResult.test(first) && /[:：]$/.test(first))) {
      lines.shift();
      continue;
    }
    break;
  }
  return lines.join('\n').trim();
}

// ---------- транспорт: HTTP ----------

function httpJson(method, url, { body, apiKey, timeoutMs, job }) {
  return new Promise((resolve_, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error('Адрес сервера записан неверно'));
      return;
    }
    const client = target.protocol === 'https:' ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;

    const request = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    }, (response) => {
      const parts = [];
      response.on('data', (part) => parts.push(part));
      response.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : {}; } catch { /* ниже */ }
        if (response.statusCode >= 400) {
          const error = new Error(reason(response.statusCode, parsed, text));
          error.status = response.statusCode;
          error.payload = parsed;
          reject(error);
          return;
        }
        if (!parsed) { reject(new Error('Сервер ответил не JSON')); return; }
        resolve_(parsed);
      });
    });

    // Прервать можно только то, что ещё идёт: как только ответ получен,
    // отменять нечего, и ссылку надо убрать, иначе следующая отмена
    // ударит по уже закрытому соединению. Регистрируются только запросы
    // с именем задачи: списки моделей и проверки связи отмене не подлежат.
    if (job) {
      const stop = () => request.destroy(new Error(CANCELLED));
      stops.set(job, stop);
      request.on('close', () => { if (stops.get(job) === stop) stops.delete(job); });
    }

    request.setTimeout(timeoutMs, () => request.destroy(new Error('Модель не ответила вовремя')));
    request.on('error', (error) => reject(
      error.message === CANCELLED ? error : new Error(friendly(error))));
    if (payload) request.write(payload);
    request.end();
  });
}

function friendly(error) {
  if (error.code === 'ECONNREFUSED') return 'Сервер модели не запущен по этому адресу';
  if (error.code === 'ENOTFOUND') return 'Адрес сервера не найден';
  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') return 'Модель не ответила вовремя';
  if (error.code === 'CERT_HAS_EXPIRED') return 'У сервера просрочен сертификат';
  return error.message;
}

function reason(status, parsed, raw) {
  const detail = parsed?.error?.message || parsed?.message || raw;
  if (status === 401 || status === 403) return 'Сервер не принял ключ доступа';
  if (status === 404) return 'Такой модели на сервере нет';
  if (status === 429) return 'Слишком много запросов — сервер попросил подождать';
  return `Сервер ответил ${status}: ${String(detail || '').replace(/\s+/g, ' ').slice(0, 160)}`;
}

function chatUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base.endsWith('/v1') ? base : `${base}/v1`}/chat/completions`;
}

function modelsUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base.endsWith('/v1') ? base : `${base}/v1`}/models`;
}

/**
 * Размышления моделей нам не нужны: на очистку одной фразы Gemma 4
 * тратила 26 секунд и семьсот токенов, а с выключенными — секунду и
 * семнадцать, ответ тот же. Эти поля понимают не все серверы, поэтому
 * при отказе повторяем запрос без них.
 */
const NO_THINKING = { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'none' };

async function chat(settings, text, timeoutMs) {
  const body = {
    model: settings.model,
    temperature: 0.2,
    stream: false,
    messages: [
      { role: 'system', content: instruction(settings) },
      { role: 'user', content: text },
    ],
  };

  let answer;
  try {
    answer = await httpJson('POST', chatUrl(settings.baseUrl), {
      body: { ...body, ...NO_THINKING },
      apiKey: settings.apiKey,
      timeoutMs,
      job: jobOf(settings),
    });
  } catch (error) {
    if (error.status !== 400 && error.status !== 422) throw error;
    log.info('сервер не понял отключение размышлений — повторяю без него');
    answer = await httpJson('POST', chatUrl(settings.baseUrl), {
      body,
      apiKey: settings.apiKey,
      timeoutMs,
      job: jobOf(settings),
    });
  }

  const content = answer?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('Модель вернула пустой ответ');
  // Пустоту проверяем ПОСЛЕ среза размышлений: ответ из одних <think>
  // не должен превращаться в пустую строку, затирающую буфер человека.
  const clean = stripThinking(content);
  if (!clean) throw new Error('Модель вернула пустой ответ');
  return clean;
}

// ---------- транспорт: установленный агент ----------

/**
 * Найти, чем на самом деле запускается агент.
 *
 * Установленные через npm инструменты кладут рядом codex.cmd, codex.ps1 и
 * codex без расширения. Запускать надо .cmd: .ps1 сам по себе не
 * исполняемый, а .exe вовсе может не существовать — на этом Codex у нас
 * и не заводился.
 */
const resolved = new Map();

function resolveCommand(command) {
  if (resolved.has(command)) return resolved.get(command);
  let found = command;
  if (process.platform === 'win32') {
    try {
      const list = execFileSync('where', [command], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const order = ['.cmd', '.bat', '.exe'];
      found = list.find((item) => order.includes(path.extname(item).toLowerCase())) || list[0] || command;
    } catch {
      found = command;
    }
  }
  resolved.set(command, found);
  return found;
}

function runCli(settings, text, timeoutMs) {
  return new Promise((resolve_, reject) => {
    const preset = settings.preset;
    const command = resolveCommand(preset.command);
    const args = [...preset.args];
    if (settings.model && preset.modelFlag) {
      // Имя модели уходит в командную строку, поэтому пропускаем только
      // безобидные символы: сам текст идёт через stdin и сюда не попадает.
      const model = String(settings.model).replace(/[^\w.:@/-]/g, '');
      if (model) args.unshift(preset.modelFlag, model);
    }

    // Node с некоторых пор отказывается запускать .cmd и .bat напрямую —
    // spawn отвечает EINVAL. Такие обёртки (а npm ставит именно их)
    // запускаем через оболочку, экранируя путь.
    const viaShell = /\.(cmd|bat)$/i.test(command);
    const options = { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };

    let child;
    try {
      child = viaShell
        ? spawn(`"${command}"`, args, { ...options, shell: true })
        : spawn(command, args, options);
    } catch (error) {
      reject(new Error(`${preset.title} не запускается: ${error.message}`));
      return;
    }

    let out = '';
    let err = '';
    let cancelled = false;

    // Агента прерываем убийством процесса: другого способа он не знает.
    const jobName = jobOf(settings);
    const stop = () => { cancelled = true; child.kill(); };
    stops.set(jobName, stop);

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${preset.title} не ответил вовремя`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { err += chunk; });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(error.code === 'ENOENT'
        ? `${preset.title} не установлен на этом компьютере`
        : `${preset.title}: ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (stops.get(jobName) === stop) stops.delete(jobName);
      if (cancelled) { reject(new Error(CANCELLED)); return; }
      // Пустоту проверяем ПОСЛЕ всех срезов: «Вот текст:» без тела не
      // должен превращаться в пустую строку, затирающую буфер человека.
      const answer = stripCourtesy(stripThinking(out));
      if (code !== 0 && !answer) {
        reject(new Error(`${preset.title} завершился с ошибкой: ${err.trim().slice(0, 200) || `код ${code}`}`));
        return;
      }
      if (!answer) { reject(new Error(`${preset.title} вернул пустой ответ`)); return; }
      resolve_(answer);
    });

    // Указания и текст уходят одним куском: агенты читают запрос из stdin.
    // Явное «ты — инструмент» впереди: без него агенты норовят поздороваться,
    // порассуждать или предложить помощь — а нужен только готовый текст.
    const preface = 'Ты — молчаливый инструмент обработки текста, а не собеседник. '
      + 'Ответь ТОЛЬКО итоговым текстом: без приветствий, вступлений, пояснений, '
      + 'рассуждений, вопросов и предложений помочь ещё.';
    child.stdin.end(`${preface}\n\n${instruction(settings)}\n\n${text}\n`, 'utf8');
  });
}

// ---------- конспект длинной записи ----------

// Кусок держим маленьким: у бесплатных провайдеров жёсткие пределы на
// размер запроса, и часовая расшифровка целиком валит их одного за
// другим. Порог целого прохода — когда запись короткая и резать незачем.
const MEETING_CHUNK_CHARS = 9000;
const MEETING_SINGLE_LIMIT = 20000;

function splitTranscript(text) {
  // Режем по строкам (у расшифровок с метками каждая фраза — строка),
  // а сплошной текст без переносов — по предложениям. Строку длиннее
  // куска (сплошной поток без пунктуации) дорезаем жёстко: лучше рез
  // посреди слова, чем запрос, который провайдер отвергнет целиком.
  const rough = text.includes('\n') ? text.split('\n') : text.split(/(?<=[.!?…])\s+/);
  const lines = [];
  for (const line of rough) {
    if (line.length <= MEETING_CHUNK_CHARS) { lines.push(line); continue; }
    for (const bit of line.split(/(?<=[.!?…])\s+/)) {
      if (bit.length <= MEETING_CHUNK_CHARS) { lines.push(bit); continue; }
      for (let at = 0; at < bit.length; at += MEETING_CHUNK_CHARS) {
        lines.push(bit.slice(at, at + MEETING_CHUNK_CHARS));
      }
    }
  }
  const parts = [];
  let current = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length > MEETING_CHUNK_CHARS && current.length) {
      parts.push(current.join('\n'));
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length) parts.push(current.join('\n'));
  return parts;
}

/**
 * Конспект записи любой длины. Короткую отдаём модели целиком, длинную —
 * в два прохода: заметки по кускам, затем общий конспект из заметок.
 * onProgress получает строку о текущем шаге — для окна настроек.
 */
async function meetingNotes(text, overrides = {}, onProgress = null) {
  const clean = String(text || '').trim();
  if (clean.length <= MEETING_SINGLE_LIMIT) {
    return improve(clean, { ...overrides, mode: 'meeting' });
  }

  const parts = splitTranscript(clean);
  const notes = [];
  for (let i = 0; i < parts.length; i++) {
    if (onProgress) onProgress({ step: i + 1, total: parts.length + 1 });
    notes.push(await improve(parts[i], { ...overrides, mode: 'meetingPart' }));
  }
  if (onProgress) onProgress({ step: parts.length + 1, total: parts.length + 1 });
  const combined = notes
    .map((note, i) => `Конспект части ${i + 1}:\n${note}`)
    .join('\n\n');
  // У трёхчасовой записи даже конспекты частей не влезают одним куском —
  // тогда прогоняем их через ту же лестницу ещё раз.
  if (combined.length > MEETING_SINGLE_LIMIT) {
    return meetingNotes(combined, overrides, onProgress);
  }
  return improve(combined, { ...overrides, mode: 'meeting' });
}

// ---------- наружу ----------

async function improve(text, overrides = {}) {
  const clean = String(text || '').trim();
  if (!clean) return clean;

  const settings = resolve(overrides);
  const timeoutMs = timeoutFor(clean, settings);
  const started = Date.now();

  if (settings.preset.kind !== 'cli' && !settings.model) {
    throw new Error(`Не выбрана модель для ${settings.preset.title}`);
  }

  const result = settings.preset.kind === 'cli'
    ? await runCli(settings, clean, timeoutMs)
    : await chat(settings, clean, timeoutMs);

  log.info(`${settings.preset.title}: текст улучшен за ${Date.now() - started} мс`);
  return applyQuotes(result, config.get('text.quotes', ''));
}

/**
 * Кавычки по вкусу человека: модели любят «ёлочки», а кому-то в работе
 * нужны прямые "..." — например, чтобы вставлять текст в код или чат,
 * где ёлочки смотрятся чужими.
 */
function applyQuotes(text, style) {
  if (style === 'straight') return text.replace(/[«»„“”]/g, '"');
  if (style === 'guillemets') {
    return text.replace(/[„“”"]/g, (mark, at, s) => {
      const prev = at > 0 ? s[at - 1] : '';
      // Прямая после цифры — дюймы или минуты (5"), а не кавычка.
      if (mark === '"' && /\d/.test(prev)) return mark;
      // Открывающая — после пробела, скобки, двоеточия или начала строки.
      return !prev || /[\s([{\n«:—-]/.test(prev) ? '«' : '»';
    });
  }
  return text;
}

/** Список моделей сервера — чтобы человек выбирал из готового, а не печатал. */
async function models(overrides = {}) {
  const settings = resolve(overrides);
  if (settings.preset.kind === 'cli') {
    // У агентов нет адреса, который можно опросить: список моделей задан
    // в самом инструменте и меняется вместе с подпиской. Показываем
    // проверенный набор, а «как в самом агенте» оставляем по умолчанию.
    const available = await hasCommand(settings.preset.command);
    return {
      ok: available,
      cli: true,
      models: settings.preset.models || [],
      error: available ? '' : `${settings.preset.title} не установлен на этом компьютере`,
    };
  }
  if (!settings.baseUrl) return { ok: false, models: [], error: 'Не указан адрес сервера' };
  try {
    const answer = await httpJson('GET', modelsUrl(settings.baseUrl), {
      apiKey: settings.apiKey,
      timeoutMs: 15000,
    });
    const list = (answer?.data || [])
      .map((item) => item.id)
      .filter((id) => typeof id === 'string')
      // Модели для эмбеддингов текст не правят — в списке они только мешают.
      .filter((id) => !/embed|rerank|whisper|tts|dall-e|moderation/i.test(id))
      .sort();
    return { ok: true, models: list };
  } catch (error) {
    return { ok: false, models: [], error: error.message };
  }
}

/** Проверка связи для окна настроек: гоняем короткую фразу целиком. */
async function check(overrides = {}) {
  const started = Date.now();
  const settings = resolve(overrides);
  try {
    const sample = await improve('Ну это самое, встреча вроде как переносится на пятницу.', {
      ...overrides,
      mode: 'clean',
      timeoutMs: 60000,
    });
    return { ok: true, ms: Date.now() - started, provider: settings.preset.title, sample: sample.slice(0, 120) };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, provider: settings.preset.title, error: error.message };
  }
}

/** Что из провайдеров реально доступно на этой машине. */
async function detect() {
  const found = [];
  for (const [id, preset] of Object.entries(PROVIDERS)) {
    if (!preset.local) continue;
    if (preset.kind === 'cli') {
      found.push({ id, title: preset.title, available: await hasCommand(preset.command) });
    } else {
      const answer = await models({ provider: id, baseUrl: preset.baseUrl, apiKey: '' });
      found.push({ id, title: preset.title, available: answer.ok, models: answer.models });
    }
  }
  return found;
}

function hasCommand(command) {
  return new Promise((resolve_) => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'which', [command], { windowsHide: true });
    child.on('error', () => resolve_(false));
    child.on('close', (code) => resolve_(code === 0));
  });
}

module.exports = { improve, meetingNotes, models, check, detect, cancel, isCancelled, busy, PROVIDERS, MODES };
