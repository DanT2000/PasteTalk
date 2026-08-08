'use strict';

/**
 * Панель записи. Ничего не решает сама — только показывает то, что
 * присылает основной процесс, и передаёт обратно нажатия.
 */

// Язык — сразу: подписи статичного HTML переводятся здесь, а строки
// состояний оборачиваются в t() при каждом показе.
window.capsule.i18n().then((loc) => window.applyLocale(loc));

const root = document.documentElement;
const cap = document.getElementById('cap');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const timerEl = document.getElementById('timer');
const micIcon = document.getElementById('mic-icon');
const aiBtn = document.getElementById('ai');

const BARS = 13;

const ICONS = {
  mic: '<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/>',
  mute: '<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/><path d="m3 3 18 18"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  warn: '<path d="M12 8v5M12 17h.01"/><path d="M12 3 2 20h20z"/>',
  spin: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
};

const STATES = {
  listening:  { tone: 'live',   wave: 'live', mic: 'mic',   status: 'Говорите',        hint: 'Ещё раз — закончу', ai: true },
  thinking:   { tone: 'accent', wave: 'busy', mic: 'spin',  status: 'Распознаю',       hint: '',                  ai: false },
  limit:      { tone: 'accent', wave: 'busy', mic: 'spin',  status: '20 минут — предел', hint: 'Отправил в работу', ai: false },
  done:       { tone: 'ok',     wave: 'flat', mic: 'check', status: 'Текст в буфере',  hint: 'Вставить — Ctrl+V',  ai: true },
  ai:         { tone: 'accent', wave: 'busy', mic: 'spark', status: 'Улучшаю текст',   hint: 'Обычный уже в буфере', ai: false },
  aidone:     { tone: 'ok',     wave: 'flat', mic: 'check', status: 'Текст улучшен',   hint: 'Обычный — в Win+V',  ai: true },
  aierror:    { tone: 'warn',   wave: 'flat', mic: 'warn',  status: 'ИИ не ответил',   hint: 'Обычный текст на месте', ai: true },
  countdown:  { tone: 'accent', wave: 'flat', mic: 'mic',   status: 'Приготовьтесь',   hint: 'Ещё раз — отменю',   ai: false },
  cancelled:  { tone: 'mute',   wave: 'flat', mic: 'mute',  status: 'Отменено',        hint: '',                   ai: false },
  nospeech:   { tone: 'mute',   wave: 'flat', mic: 'mute',  status: 'Тишина',          hint: 'Запись отменил',     ai: false },
  micdead:    { tone: 'warn',   wave: 'flat', mic: 'warn',  status: 'Микрофон молчит', hint: 'Проверьте устройство', ai: false },
  engineDown: { tone: 'warn',   wave: 'flat', mic: 'warn',  status: 'Движок не готов', hint: '',                   ai: false },
};

// ---------- дорожка уровня ----------

const history = new Array(BARS).fill(0.02);
const waves = [...document.querySelectorAll('[data-bars]')];

waves.forEach((wave) => {
  wave.innerHTML = '';
  for (let i = 0; i < BARS; i++) wave.appendChild(document.createElement('i'));
});

function paint() {
  const left = document.querySelector('.wave.left');
  const right = document.querySelector('.wave.right');
  for (let i = 0; i < BARS; i++) {
    const height = `${(6 + history[i] * 94).toFixed(1)}%`;
    left.children[i].style.height = height;
    right.children[BARS - 1 - i].style.height = height;
  }
}

/** Приходит пик громкости за ~48 мс. Корень — чтобы тихая речь не выглядела тишиной. */
function pushLevel(peak) {
  history.push(Math.min(Math.sqrt(Math.max(peak, 0)) * 1.25, 1));
  history.shift();
  paint();
}

function flatten(value) {
  history.fill(value);
  paint();
}

// ---------- состояние ----------

function format(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

let config = null;
let previous = null;
let countdownTimer = null;

/**
 * Сигнал звучит на входе в запись, на выходе из неё и — если включено —
 * когда улучшение доделалось: модель иногда думает долго, и человек
 * успевает отвернуться от экрана.
 */
function chime(next) {
  const sound = config?.sound;
  if (!sound || sound.preset === 'none') return;
  if (next === 'listening' && previous !== 'listening') {
    window.pastetalkSounds.playSound(sound.preset, sound.volume, true);
  } else if (previous === 'listening' && next !== 'listening') {
    window.pastetalkSounds.playSound(sound.preset, sound.volume, false);
  } else if (next === 'aidone' && previous === 'ai' && sound.aiDone !== false) {
    window.pastetalkSounds.playSound(sound.preset, sound.volume, 'done');
  }
}

function apply(payload) {
  if (payload.state !== 'countdown') clearInterval(countdownTimer);
  clearTimeout(hintTimer);
  hintEl.classList.remove('is-warning');
  cap.dataset.state = payload.state;
  chime(payload.state);
  previous = payload.state;
  const state = STATES[payload.state] || STATES.done;
  cap.dataset.tone = state.tone;
  cap.dataset.wave = state.wave;
  statusEl.textContent = t(payload.status || state.status);
  hintEl.textContent = t(payload.hint || state.hint);
  timerEl.textContent = payload.elapsedMs ? format(payload.elapsedMs) : '';
  micIcon.innerHTML = ICONS[state.mic];
  micIcon.style.animation = state.mic === 'spin' ? 'spin 1s linear infinite' : '';
  // Прерываемые состояния: наведение на микрофон превращает его в отмену.
  // Отменять нажатием на микрофон имеет смысл только там, где иначе
  // прервать нечем: пока думает модель. Во время самой записи для этого
  // есть горячая клавиша — второе нажатие и заканчивает её, — а крестик
  // по центру там только мешает целиться.
  cap.dataset.busy = ['thinking', 'ai', 'limit'].includes(payload.state) ? '1' : '0';
  syncAiButton(state);
  if (state.wave !== 'live') flatten(state.wave === 'busy' ? 0.12 : 0.02);
}

/**
 * Кнопка ИИ в трёх видах: рабочая, погашенная по ходу дела (улучшать
 * пока нечего) и выключенная в настройках. Последнюю не отключаем
 * совсем: на нажатие она должна объяснить, почему не работает, — иначе
 * человек будет тыкать в мёртвую кнопку и гадать.
 */
function syncAiButton(state) {
  const off = !config || config.ai?.enabled === false;
  aiBtn.classList.toggle('is-off', off);
  aiBtn.disabled = !off && !state.ai;
  aiBtn.title = off ? t('Улучшение текста выключено в настройках') : t('Улучшить текст');
}

// ---------- связь с приложением ----------

window.capsule.onState(apply);

/** Отсчёт перед записью: показываем, сколько осталось. */
window.capsule.onCountdown(({ ms }) => {
  clearInterval(countdownTimer);
  let left = Math.ceil(ms / 1000);
  const tick = () => {
    apply({ state: 'countdown' });
    timerEl.textContent = `${left}`;
    if (--left < 0) clearInterval(countdownTimer);
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
});
window.capsule.onLevel((payload) => {
  if (cap.dataset.wave === 'live') pushLevel(payload.level);
});
/** Идёт ли сейчас работа, которую можно прервать. */
function isBusy() {
  return cap.dataset.busy === '1';
}

// Микрофон: пока думает модель — отменяет, иначе начинает или заканчивает
// запись. Во время записи это обычное «закончить», а не отмена.
document.getElementById('mic').addEventListener('click', () =>
  window.capsule.action(isBusy() ? 'cancel' : 'toggle'));

document.getElementById('close').addEventListener('click', () => window.capsule.action('cancel'));
document.getElementById('prefs').addEventListener('click', () => window.capsule.action('settings'));

// Короткое нажатие — причесать прошлую диктовку, долгое — открыть всю историю.
const lastBtn = document.getElementById('last');
let holdTimer = null;
lastBtn.addEventListener('mousedown', () => {
  holdTimer = setTimeout(() => { holdTimer = null; window.capsule.action('history'); }, 600);
});
lastBtn.addEventListener('mouseup', () => {
  if (!holdTimer) return;
  clearTimeout(holdTimer);
  holdTimer = null;
  window.capsule.action('improveLast');
});
lastBtn.addEventListener('mouseleave', () => { clearTimeout(holdTimer); holdTimer = null; });
let hintTimer = null;
aiBtn.addEventListener('click', () => {
  // Модель уже думает — второе нажатие её останавливает.
  if (cap.dataset.state === 'ai') { window.capsule.action('cancel'); return; }
  if (aiBtn.classList.contains('is-off')) {
    // Панель к этому моменту уже могла показывать «Текст в буфере» и
    // вот-вот погаснуть. Перехватываем и подписью, и цветом: короткая
    // серая строка внизу теряется, а её нужно заметить.
    hintEl.textContent = t('Улучшение текста выключено в настройках');
    hintEl.classList.add('is-warning');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      hintEl.classList.remove('is-warning');
      const state = STATES[cap.dataset.state] || {};
      hintEl.textContent = t(state.hint || '');
    }, 7000);
    return;
  }
  window.capsule.action('improve');
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.capsule.action('cancel');
});

function applyConfig(settings) {
  if (!settings) return;
  config = settings;
  root.dataset.scale = String(settings.appearance?.scale || 100);
  root.dataset.size = settings.appearance?.capsuleSize || 'full';
  const theme = settings.appearance?.theme || 'system';
  root.dataset.theme = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
}

window.capsule.onConfig(applyConfig);
window.capsule.onTheme(() => window.capsule.config().then(applyConfig));
window.capsule.config().then(applyConfig);

paint();
