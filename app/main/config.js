'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * Настройки лежат простым JSON рядом с профилем пользователя.
 * Читаются один раз при старте, пишутся с задержкой — чтобы ползунок
 * громкости не устраивал шторм записей на диск.
 */

const DEFAULTS = {
  version: 2,
  firstRun: true,

  model: { name: 'large-v3', device: 'cuda', computeType: '' },
  language: 'ru',
  microphoneId: 'default',

  sound: { preset: 'bell', volume: 60 },

  text: {
    autoPaste: true,
    keepPunctuation: true,
  },

  limits: {
    // Замолчал после того, как говорил — дораспознаём и заканчиваем.
    silenceStopMs: 60000,
    // Так и не сказал ни слова — считаем, что клавишу нажали случайно,
    // и выходим молча, ничего не подкладывая в буфер. Запас щедрый:
    // человек нередко думает над формулировкой, и обрывать его на
    // десятой секунде — значит мешать, а не помогать.
    noSpeechCancelMs: 300000,
    maxDurationMs: 20 * 60 * 1000,
    // Отсчёт перед записью. Ноль — говорить можно сразу: расшифровка идёт
    // по ходу речи, поэтому терять начало фразы неоткуда.
    startDelayMs: 0,
  },

  hotkeys: {
    record: 'Control+Alt+Space',
    recordAndImprove: 'Control+Alt+Return',
    improveClipboard: 'Control+Alt+I',
  },

  appearance: {
    theme: 'system',        // system | dark | light
    scale: 100,             // 100 | 125 | 150
    capsulePosition: 'bottom',
    // За каким экраном закреплена панель. 'cursor' — где курсор; при
    // нескольких мониторах это заставляет её прыгать за мышью, и слышно,
    // но не видно. Число — id конкретного экрана.
    capsuleDisplay: 'cursor',
    capsuleSize: 'full',    // full | compact
  },

  ai: {
    enabled: false,
    provider: 'lmstudio',
    baseUrl: '',            // пусто — берём адрес по умолчанию у провайдера
    model: '',
    // Ключи храним по провайдерам: переключился на другой и обратно —
    // вводить заново не придётся.
    keys: { openai: '', deepseek: '', aitunnel: '', custom: '' },
    mode: 'clean',
    prompt: 'Убери слова-паразиты и повторы, сохрани смысл и мою манеру речи. Не добавляй ничего от себя. Верни только готовый текст.',
    timeoutMs: 0,           // 0 — считать по длине текста
  },

  // Сколько надиктовок хранить. Лежат на этом компьютере, никуда
  // не уходят — но и держать их без счёта незачем.
  history: { keep: 50 },

  files: { timestamps: false },

  startup: { autoLaunch: true, restartOnCrash: true },

  updates: {
    lastCheckedAt: 0,
    // Версия, о которой человек попросил больше не напоминать.
    skipVersion: '',
  },

  engine: {
    // Через сколько простоя отпускать видеопамять. Модель грузится за
    // три-четыре секунды — меньше, чем человек говорит, — поэтому держать
    // три гигабайта круглосуточно ради программы, которой пользуются
    // дважды в час, незачем. -1 держит всегда, 0 отпускает сразу.
    idleUnloadMs: 30 * 60 * 1000,
    // Движок слушает только localhost и требует одноразовый токен.
    // Ноль — занять любой свободный порт: так не бывает конфликтов ни с
    // чем. Число ставят те, кому нужен предсказуемый порт (правила
    // брандмауэра, свои проверки) — и делают это осознанно.
    port: 0,
  },

  recognition: {
    // Где считать речь. Слабой машине без видеокарты локальный Whisper
    // не подходит: минута речи жуётся около минуты, и диктовка перестаёт
    // быть быстрее печати — то есть теряет весь смысл.
    where: 'local',        // local | server | cloud
    serverUrl: '',
    serverToken: '',
    cloudProvider: 'aitunnel',
    cloudUrl: '',
    cloudKey: '',
    cloudModel: '',
  },

  relay: {
    // Выключено по умолчанию: связь с чужим сервером человек включает сам
    // и осознанно, а не обнаруживает включённой после обновления.
    enabled: false,
    url: '',
    token: '',
    name: '',
  },
};

let cache = null;
let writeTimer = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Слияние с умолчаниями: новые настройки появляются у старых пользователей сами. */
function merge(defaults, saved) {
  const result = Array.isArray(defaults) ? [...defaults] : { ...defaults };
  for (const [key, value] of Object.entries(saved || {})) {
    if (!(key in defaults)) continue;
    result[key] = isPlainObject(defaults[key]) && isPlainObject(value)
      ? merge(defaults[key], value)
      : value;
  }
  return result;
}

// Набор звуков переделывали — старый выбор человека не должен молча
// превращаться в чужой. Сопоставляем снятые пресеты ближайшим по звучанию.
const RENAMED_SOUNDS = { click: 'wood', double: 'chime', blip: 'soft', beep: 'soft' };

function migrate(settings) {
  const preset = settings.sound?.preset;
  if (preset && RENAMED_SOUNDS[preset]) settings.sound.preset = RENAMED_SOUNDS[preset];

  // Режим «только переписать, не чистя» оказался никому не нужен и
  // сбивал с толку: у выбравших его подставляем полный вариант.
  if (settings.ai?.mode === 'structure') settings.ai.mode = 'both';
  return settings;
}

function load() {
  if (cache) return cache;
  try {
    cache = migrate(merge(DEFAULTS, JSON.parse(fs.readFileSync(file(), 'utf8'))));
  } catch {
    cache = merge(DEFAULTS, {});
  }
  return cache;
}

function all() {
  return load();
}

function get(dotted, fallback) {
  const parts = dotted.split('.');
  let node = load();
  for (const part of parts) {
    if (!isPlainObject(node) || !(part in node)) return fallback;
    node = node[part];
  }
  return node;
}

function set(patch) {
  cache = merge(load(), patch);
  scheduleWrite();
  return cache;
}

function scheduleWrite() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 400);
}

function flush() {
  clearTimeout(writeTimer);
  if (!cache) return;
  const target = file();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Пишем через временный файл: выдернутое во время записи питание
    // не должно оставлять человека с обрезанным settings.json.
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(temp, target);
  } catch (error) {
    console.error('Не удалось сохранить настройки:', error.message);
  }
}

module.exports = { DEFAULTS, all, get, set, flush, file };
