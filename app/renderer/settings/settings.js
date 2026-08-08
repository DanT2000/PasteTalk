'use strict';

/**
 * Окно настроек. Держит одну копию настроек в памяти, любое изменение
 * сразу уходит в основной процесс — кнопки «Сохранить» здесь нет
 * намеренно: она только даёт повод забыть её нажать.
 */

const api = window.pastetalk;
const root = document.documentElement;
const t = window.t;

let settings = null;
let health = null;

const $ = (id) => document.getElementById(id);
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

// ---------- мелочи ----------

let toastTimer;
function say(message) {
  $('toast-text').textContent = message;
  $('toast').classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('is-on'), 2600);
}

function pick(path, source = settings) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), source);
}

function patchFor(path, value) {
  const parts = path.split('.');
  const patch = {};
  let node = patch;
  parts.forEach((key, index) => {
    if (index === parts.length - 1) node[key] = value;
    else { node[key] = {}; node = node[key]; }
  });
  return patch;
}

async function save(path, value) {
  settings = await api.config.set(patchFor(path, value));
  applyAppearance();
}

// ---------- вид ----------

function applyAppearance() {
  const look = settings.appearance || {};
  root.dataset.scale = String(look.scale || 100);
  root.dataset.theme = look.theme === 'system'
    ? (systemDark.matches ? 'dark' : 'light')
    : (look.theme || 'dark');
  document.querySelectorAll('.scale-opt').forEach((option) =>
    option.setAttribute('aria-checked', String(Number(option.dataset.v) === Number(look.scale || 100))));
}
systemDark.addEventListener('change', applyAppearance);
api.app.onTheme(applyAppearance);

// ---------- разделы ----------

function goto(name) {
  document.querySelectorAll('.nav-item').forEach((item) =>
    item.classList.toggle('is-active', item.dataset.goto === name));
  document.querySelectorAll('.page').forEach((page) =>
    page.classList.toggle('is-active', page.dataset.page === name));
  document.querySelector('.content').scrollTop = 0;
  if (name === 'about') refreshLogs();
  if (name === 'history') refreshHistory();
}
document.querySelectorAll('[data-goto]').forEach((button) =>
  button.addEventListener('click', () => goto(button.dataset.goto)));
api.app.onGoto((page) => goto(page));

// ---------- общее связывание ----------

/** Разложить текущие настройки по контролам. Зовётся и при открытии окна,
 *  и когда настройки поменялись снаружи — иначе на экране остаётся старое. */
function showValues() {
  document.querySelectorAll('[data-cfg]').forEach((element) => {
    const current = pick(element.dataset.cfg);
    if (current === undefined || current === null) return;
    if (element.type === 'checkbox') element.checked = Boolean(current);
    else if (document.activeElement !== element) element.value = String(current);
  });
  $('vol-val').textContent = `${settings.sound?.volume ?? 60} %`;
}

function bindAll() {
  document.querySelectorAll('[data-cfg]').forEach((element) => {
    const path = element.dataset.cfg;
    const current = pick(path);

    if (element.type === 'checkbox') {
      element.checked = Boolean(current);
      element.addEventListener('change', () => save(path, element.checked));
    } else if (element.type === 'range') {
      element.value = Number(current) || 0;
      element.addEventListener('input', () => {
        if (element.id === 'vol') $('vol-val').textContent = `${element.value} %`;
      });
      element.addEventListener('change', () => save(path, Number(element.value)));
    } else {
      if (current !== undefined && current !== null) element.value = String(current);
      const event = element.tagName === 'SELECT' ? 'change' : 'input';
      let timer;
      element.addEventListener(event, () => {
        const value = element.dataset.number !== undefined ? Number(element.value) : element.value;
        clearTimeout(timer);
        // Поля печатают посимвольно — не дёргаем диск на каждую букву.
        timer = setTimeout(() => save(path, value), event === 'input' ? 400 : 0);
      });
    }
  });
  $('vol-val').textContent = `${settings.sound?.volume ?? 60} %`;
}

// ---------- заголовок окна ----------

// Кнопка одна: крестик прячет окно в трей. Выйти из программы можно
// оттуда же, из меню значка — держать для этого вторую кнопку незачем.
$('win-close').addEventListener('click', () => api.window.hide());

function showEngine(info) {
  const dot = $('dot');
  const text = $('state-text');
  dot.className = 'dot';
  if (info.ready || info.state === 'ready') {
    dot.classList.add('is-ok');
    text.textContent = `${t('Готов')} · ${settings?.model?.name || ''}`;
  } else if (info.state === 'starting') {
    dot.classList.add('is-busy');
    text.textContent = t('Движок запускается…');
  } else if (info.state === 'failed') {
    dot.classList.add('is-bad');
    text.textContent = t(info.error || 'Движок не запустился');
  } else {
    text.textContent = t('Движок остановлен');
  }
}
let lastEngineInfo = null;
api.engine.onState((info) => {
  lastEngineInfo = info;
  showEngine(info);
  // Движок поднимается дольше, чем открывается окно: когда он наконец
  // готов, список моделей и устройств надо построить заново — при первом
  // заходе строить было не из чего.
  if (info.ready || info.state === 'ready') {
    refreshHealth();
    // Порт движка известен только после его запуска, а окно к этому
    // моменту давно открыто. Без этой строки в «Интеграции» навсегда
    // оставалось бы «движок ещё не запустился».
    api.relay?.state().then(showRelay);
  }
});

// ---------- микрофоны ----------

/**
 * Windows не отдаёт ни названий, ни идентификаторов устройств, пока
 * программа хоть раз не получила доступ к микрофону. Поэтому сначала
 * коротко открываем поток — и сразу закрываем: он нужен только ради
 * разрешения, записывать мы здесь ничего не собираемся.
 */
async function unlockDeviceNames() {
  try {
    const devices = await api.media.devices();
    const named = devices.some((device) => device.kind === 'audioinput' && device.label);
    if (named) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch { /* не дали — покажем только «по умолчанию» */ }
}

/**
 * Windows называет устройства так: «Микрофон (DM30 USB Microphone) (352f:0101)».
 * Приставка одинаковая у всех, а код в конце — для драйвера, не для
 * человека. Убираем и то и другое, оставляя само название.
 */
function prettyDevice(label) {
  if (!label) return t('Микрофон без названия');
  const withoutVendorId = label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim();
  const inner = /^(?:Микрофон|Microphone|Линейный вход|Line In)\s*\((.+)\)$/i.exec(withoutVendorId);
  return (inner ? inner[1] : withoutVendorId).trim() || label;
}

async function loadMicrophones() {
  await unlockDeviceNames();
  let devices = [];
  try {
    devices = (await api.media.devices()).filter((device) => device.kind === 'audioinput');
  } catch { /* доступ ещё не выдан */ }

  // Windows показывает каждое устройство трижды: «Default — …»,
  // «Communications — …» и само устройство. Первые два — псевдонимы,
  // и в списке из шести строк три оказываются одним микрофоном.
  const real = devices.filter((device) =>
    device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications');

  for (const select of [$('mic'), $('welcome-mic')]) {
    const chosen = settings.microphoneId || 'default';
    select.innerHTML = `<option value="default">${t('По умолчанию в Windows')}</option>`;
    real.forEach((device) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = prettyDevice(device.label);
      select.appendChild(option);
    });
    select.value = [...select.options].some((o) => o.value === chosen) ? chosen : 'default';
  }
}

$('mic-test').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: settings.microphoneId && settings.microphoneId !== 'default'
        ? { deviceId: { exact: settings.microphoneId } }
        : true,
    });
    stream.getTracks().forEach((track) => track.stop());
    await loadMicrophones();
    const count = $('mic').options.length - 1;
    say(count > 0 ? `${t('Микрофон доступен, устройств найдено:')} ${count}` : t('Микрофон доступен'));
  } catch (error) {
    say(`${t('Микрофон недоступен:')} ${t(error.message)}`);
  }
});

$('sound-test').addEventListener('click', () => {
  window.pastetalkSounds.playSound(settings.sound?.preset || 'bell', settings.sound?.volume ?? 60, true);
  setTimeout(() => window.pastetalkSounds.playSound(settings.sound?.preset || 'bell', settings.sound?.volume ?? 60, false), 550);
});

// ---------- модели распознавания ----------

function renderModels() {
  const list = $('model-list');
  const catalog = health?.catalog || [];
  const chosen = settings.model?.name;
  const status = health?.model || {};

  list.innerHTML = '';
  for (const item of catalog) {
    const row = document.createElement('div');
    row.className = `row is-model${item.id === chosen ? ' is-chosen' : ''}`;
    const busy = status.name === item.id && ['downloading', 'loading'].includes(status.state);
    const size = item.sizeMb >= 1024 ? `${(item.sizeMb / 1024).toFixed(1)} ${t('ГБ')}` : `${item.sizeMb} ${t('МБ')}`;

    row.innerHTML = `
      <svg class="row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        ${item.id === chosen ? '<path d="M20 6 9 17l-5-5"/>' : '<circle cx="12" cy="12" r="9"/>'}
      </svg>
      <div class="row-text">
        <div class="row-title">${t(item.title)}${item.id === chosen ? ` <span class="pill">${t('Выбрана')}</span>` : ''}</div>
        <div class="row-sub">${describeModel(item, size, status)}</div>
        ${busy ? `<div class="progress"><i style="width:${Math.round((status.progress || 0) * 100)}%"></i></div>` : ''}
      </div>
      <div class="row-control"></div>`;

    const controls = row.querySelector('.row-control');
    if (item.id !== chosen) {
      controls.appendChild(button(item.cached ? t('Выбрать') : t('Скачать'), 'btn', async () => {
        await save('model.name', item.id);
        await api.engine.loadModel({ ...settings.model, name: item.id });
        say(item.cached ? `${t('Переключаюсь на')} ${item.title}` : `${t('Качаю')} ${item.title}, ${size}`);
        pollModel();
      }));
    } else {
      controls.appendChild(button(t('Скачать заново'), 'btn', async () => {
        await api.engine.deleteModel(item.id);
        await api.engine.loadModel(settings.model);
        say(`${t('Качаю заново')} ${item.title}`);
        pollModel();
      }));
    }
    if (item.cached && item.id !== chosen) {
      controls.appendChild(button(t('Удалить'), 'btn btn-quiet', async () => {
        const answer = await api.engine.deleteModel(item.id);
        say(answer?.freedMb ? `${t('Освободилось')} ${Math.round(answer.freedMb)} ${t('МБ')}` : t('Модель удалена'));
        refreshHealth();
      }));
    }
    list.appendChild(row);
  }
}

function describeModel(item, size, status) {
  const notes = {
    'large-v3': 'Самая точная',
    'large-v3-turbo': 'Почти так же точна, но заметно легче и быстрее',
    medium: 'Быстрее, чуть проще',
    small: 'Для слабых компьютеров',
    base: 'Совсем быстрая, ошибается',
    tiny: 'Только чтобы попробовать',
  };
  const note = t(notes[item.id] || '');
  if (status.name === item.id && status.state === 'downloading') {
    return `${note} · ${t('качаю')}, ${Math.round((status.progress || 0) * 100)} % ${t('из')} ${size}`;
  }
  if (status.name === item.id && status.state === 'loading') return `${note} · ${t('загружаю в память')}`;
  if (status.name === item.id && status.state === 'error') return t(status.error);
  return `${note} · ${size}${item.cached ? ` ${t('на диске')}` : `, ${t('ещё не скачана')}`}`;
}

function button(label, className, onClick) {
  const element = document.createElement('button');
  element.className = className;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

let modelTimer = null;
function pollModel() {
  clearInterval(modelTimer);
  modelTimer = setInterval(async () => {
    const status = await api.engine.model();
    if (health) health.model = status;
    renderModels();
    if (['ready', 'error', 'idle'].includes(status.state)) {
      clearInterval(modelTimer);
      if (status.state === 'error') say(t(status.error));
      refreshHealth();
    }
  }, 700);
}

function renderDevices() {
  const devices = health?.devices || [];
  for (const select of [$('device'), $('welcome-device')]) {
    select.innerHTML = '';
    devices.forEach((device) => {
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = t(device.title);
      select.appendChild(option);
    });
    select.value = settings.model?.device || devices[0]?.id || 'cpu';
  }
  const gpu = devices.find((device) => device.id === 'cuda');
  const line = gpu ? `${t('Найдена видеокарта с CUDA')}${gpu.count > 1 ? ` (${gpu.count} ${t('шт.')})` : ''}` : t('Видеокарта с CUDA не найдена — считаем на процессоре');
  $('device-sub').textContent = line;
  $('welcome-device-sub').textContent = line;
}

$('device').addEventListener('change', async () => {
  await save('model.device', $('device').value);
  await api.engine.loadModel(settings.model);
  say(t('Переключаю вычисления'));
  pollModel();
});

$('bench').addEventListener('click', async () => {
  $('bench').disabled = true;
  $('bench-sub').textContent = t('Меряю на эталонном отрывке…');
  try {
    const result = await api.engine.benchmark();
    $('bench-sub').textContent = `${t('Минута речи распознаётся за')} ${result.secondsPerMinute.toFixed(1)} ${t('с')} `
      + `(${result.device === 'cuda' ? t('видеокарта') : t('процессор')}, ${result.model})`;
  } catch (error) {
    $('bench-sub').textContent = `${t('Померить не вышло:')} ${t(error.message)}`;
  }
  $('bench').disabled = false;
});

// ---------- горячие клавиши ----------

const HOTKEYS = [
  { key: 'record', title: 'Начать и закончить запись', sub: 'Первое нажатие — говорите, второе — текст в буфере' },
  { key: 'recordAndImprove', title: 'Закончить запись и улучшить текст', sub: 'Вместо обычного завершения сразу отправляет сказанное в модель' },
  { key: 'improveClipboard', title: 'Улучшить то, что уже в буфере', sub: 'Пригодится, если вставили как есть, а потом передумали' },
];

const SHOWN = {
  Control: 'Ctrl', Return: 'Enter', Super: 'Win',
  // Electron пишет их в одно слово, старые сохранённые — по-разному.
  Scrolllock: 'Scroll Lock', ScrollLock: 'Scroll Lock',
  Capslock: 'Caps Lock', CapsLock: 'Caps Lock', Numlock: 'Num Lock', NumLock: 'Num Lock',
  PageUp: 'Page Up', PageDown: 'Page Down', PrintScreen: 'Print Screen',
  Up: '↑', Down: '↓', Left: '←', Right: '→',
};

/**
 * Физическая клавиша по event.code, а не по event.key.
 *
 * Две причины. Первая — раскладка: на русском Ctrl+Ч даёт key «ч», а
 * Windows всё равно ждёт Ctrl+X, потому что сочетания привязаны к
 * клавише, а не к букве на ней. Вторая — модификаторы меняют key до
 * неузнаваемости: Ctrl+ScrollLock приезжает как «Cancel», а Ctrl+Enter
 * на части клавиатур — как перевод строки. code от этого не зависит.
 */
const CODE_NAMES = {
  Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Tab: 'Tab', Backspace: 'Backspace',
  Escape: 'Escape', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', ScrollLock: 'Scrolllock', Pause: 'Pause',
  CapsLock: 'Capslock', NumLock: 'Numlock', PrintScreen: 'PrintScreen',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
};

function keyFromCode(code) {
  if (CODE_NAMES[code]) return CODE_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return '';
}

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

function showCombo(accelerator) {
  if (!accelerator) return `<span class="cap-none">${t('не назначено')}</span>`;
  return accelerator.split('+')
    .map((part) => `<kbd>${SHOWN[part] || part}</kbd>`)
    .join('<span class="plus">+</span>');
}

function renderHotkeys() {
  const card = $('hotkeys');
  card.innerHTML = '';
  for (const item of HOTKEYS) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="row-text">
        <div class="row-title">${t(item.title)}</div>
        <div class="row-sub">${t(item.sub)}</div>
      </div>
      <div class="row-control">
        <div class="combo" data-combo>${showCombo(settings.hotkeys?.[item.key])}</div>
        <button class="btn" data-edit>${t('Изменить')}</button>
        <button class="btn btn-quiet" data-clear>${t('Убрать')}</button>
      </div>`;
    row.querySelector('[data-edit]').addEventListener('click', (event) => beginCapture(item.key, row, event.currentTarget));
    row.querySelector('[data-clear]').addEventListener('click', async () => {
      await save(`hotkeys.${item.key}`, '');
      renderHotkeys();
      say(t('Сочетание убрано'));
    });
    card.appendChild(row);
  }
}

let capture = null;

function beginCapture(key, row, trigger) {
  if (capture) endCapture(false);
  const combo = row.querySelector('[data-combo]');
  capture = { key, combo, trigger, previous: combo.innerHTML, keys: [] };
  combo.classList.add('is-capturing');
  combo.innerHTML = `<span class="capture-hint">${t('Нажмите клавиши…')}</span>`;
  trigger.textContent = t('Отмена');
}

function endCapture(commit) {
  if (!capture) return;
  const { combo, trigger, previous } = capture;
  combo.classList.remove('is-capturing');
  trigger.textContent = t('Изменить');
  if (!commit) combo.innerHTML = previous;
  capture = null;
}

async function commitCapture() {
  const accelerator = capture.keys.join('+');
  const key = capture.key;
  const free = await api.hotkeys.isFree(accelerator);
  if (!free) {
    capture.combo.classList.add('is-clash');
    say(`${accelerator} ${t('не подошло: занято другой программой или Windows')}`);
    return;
  }
  endCapture(true);
  await save(`hotkeys.${key}`, accelerator);
  renderHotkeys();
  say(t('Сочетание сохранено'));
}

window.addEventListener('keydown', async (event) => {
  if (!capture) return;
  event.preventDefault();

  if (event.code === 'Escape') { endCapture(false); return; }

  // Enter сохраняет — но только когда он сам не часть сочетания.
  const wantsSave = (event.code === 'Enter' || event.code === 'NumpadEnter')
    && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
  if (wantsSave) {
    if (capture.keys.length) await commitCapture();
    else say(t('Сначала нажмите сочетание'));
    return;
  }

  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');

  const main = MODIFIER_CODES.test(event.code) ? '' : keyFromCode(event.code);
  capture.keys = main ? [...modifiers, main] : modifiers;
  capture.combo.classList.remove('is-clash');

  const ready = Boolean(main);
  capture.combo.innerHTML = capture.keys.length
    ? showCombo(capture.keys.join('+'))
      + `<span class="capture-hint">${ready ? t('Enter — сохранить') : t('и саму клавишу')}</span>`
    : `<span class="capture-hint">${t('Нажмите клавиши…')}</span>`;
});

api.hotkeys.onConflict((failed) => {
  if (!failed?.length) return;
  say(`${t('Заняты другой программой:')} ${failed.map((item) => item.accelerator).join(', ')}`);
});

// ---------- улучшение текста ----------

let providers = {};

function renderProviders() {
  const select = $('provider');
  select.innerHTML = '';
  for (const [id, preset] of Object.entries(providers)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = t(preset.title);
    select.appendChild(option);
  }
  select.value = settings.ai?.provider || 'lmstudio';
  syncProvider();
}

function syncProvider() {
  const id = $('provider').value;
  const preset = providers[id] || {};
  const isCli = preset.kind === 'cli';

  $('row-baseurl').classList.toggle('is-hidden', isCli);
  $('row-key').classList.toggle('is-hidden', isCli || !preset.needsKey);
  $('row-model').classList.remove('is-hidden');
  $('ai-refresh').classList.toggle('is-hidden', isCli);
  $('provider-sub').textContent = t(preset.hint
    || (isCli ? 'Работает через вашу подписку — ключ не нужен' : 'Сервер с OpenAI-совместимым API'));

  if (isCli) {
    // У агента список моделей свой и заранее известен — спрашивать некого.
    fillModels((preset.models || []).map((item) => ({ value: item.id, label: t(item.title) })));
    $('model-sub').textContent = t('Модель полегче отвечает быстрее и стоит дешевле. Что именно доступно — зависит от вашей подписки');
  } else {
    $('baseurl').placeholder = preset.baseUrl || 'http://localhost:1234/v1';
    $('apikey').value = settings.ai?.keys?.[id] || '';
    $('model-sub').textContent = t(id === 'lmstudio'
      ? 'Для чистки речи хватает модели уровня Gemma 3 4B и выше — задача простая. Крупные умнее, но заставляют ждать'
      : 'Нажмите «Обновить», чтобы получить список с сервера');
  }
  $('row-prompt').classList.toggle('is-hidden', $('ai-mode').value !== 'custom');
}

/** Заполнить выпадающий список моделей, сохранив выбранное, если оно есть. */
function fillModels(items) {
  const select = $('ai-model');
  const chosen = settings.ai?.model ?? '';
  select.innerHTML = '';
  items.forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });
  select.value = items.some((item) => item.value === chosen) ? chosen : (items[0]?.value ?? '');
}

$('provider').addEventListener('change', async () => {
  await save('ai.provider', $('provider').value);
  await save('ai.baseUrl', '');
  await save('ai.model', '');
  $('ai-model').innerHTML = '';
  syncProvider();
});

/** Каждый режим объясняем словами: из двух слов в списке непонятно. */
const MODE_HINTS = {
  clean: 'Убирает слова-паразиты, повторы и оговорки, исправляет грамматику и знаки препинания. '
    + 'Ваши формулировки и порядок мыслей остаются нетронутыми',
  both: 'То же, что «Почистить», плюс переписывает: меняет формулировки на более ясные, '
    + 'собирает разбросанные куски одной мысли вместе, выстраивает порядок от главного к подробностям, '
    + 'делит на абзацы и оформляет перечисления списком. Факты не теряются и не выдумываются',
  custom: 'Модель получит ваши указания и текст следующим сообщением',
};

function syncModeHint() {
  $('ai-mode-sub').textContent = t(MODE_HINTS[$('ai-mode').value] || '');
  // Подпись должна говорить о текущем положении переключателя, а не
  // висеть одним и тем же текстом при любом.
  $('ai-enabled-sub').textContent = t($('ai-enabled').checked
    ? 'Кнопка ИИ на панели записи работает, а Ctrl+Alt+Enter заканчивает запись сразу улучшением'
    : 'Пока выключено: кнопка ИИ на панели записи не работает');
}

$('ai-enabled').addEventListener('change', syncModeHint);

$('ai-mode').addEventListener('change', () => { syncProvider(); syncModeHint(); });

$('apikey').addEventListener('input', () => {
  clearTimeout($('apikey').timer);
  $('apikey').timer = setTimeout(() => save(`ai.keys.${$('provider').value}`, $('apikey').value), 400);
});

$('ai-refresh').addEventListener('click', async () => {
  $('ai-refresh').disabled = true;
  $('model-sub').textContent = t('Спрашиваю сервер…');
  const answer = await api.llm.models({
    provider: $('provider').value,
    baseUrl: $('baseurl').value,
    apiKey: $('apikey').value,
  });
  $('ai-refresh').disabled = false;

  if (!answer.ok) { $('model-sub').textContent = t(answer.error); return; }
  fillModels(answer.models.map((name) => ({ value: name, label: name })));
  if ($('ai-model').value !== settings.ai?.model) save('ai.model', $('ai-model').value);
  $('model-sub').textContent = `${t('Сервер отдал моделей:')} ${answer.models.length}`;
});

$('ai-check').addEventListener('click', async () => {
  $('ai-check').disabled = true;
  $('ai-status').className = 'pill pill-muted';
  $('ai-status').textContent = t('проверяю');
  $('ai-check-sub').textContent = t('Прогоняю короткую фразу…');

  const answer = await api.llm.check({
    provider: $('provider').value,
    baseUrl: $('baseurl').value,
    apiKey: $('apikey').value,
    model: $('ai-model').value,
  });

  $('ai-check').disabled = false;
  if (answer.ok) {
    $('ai-status').className = 'pill pill-ok';
    $('ai-status').textContent = `${answer.ms} ${t('мс')}`;
    $('ai-check-sub').textContent = `${answer.provider} ${t('ответил:')} ${t('«')}${answer.sample}${t('»')}`;
  } else {
    $('ai-status').className = 'pill pill-bad';
    $('ai-status').textContent = t('не вышло');
    $('ai-check-sub').textContent = t(answer.error);
  }
});

// ---------- масштаб ----------

document.querySelectorAll('.scale-opt').forEach((option) =>
  option.addEventListener('click', () => save('appearance.scale', Number(option.dataset.v))));

// ---------- файлы ----------

let job = null;
let jobTimer = null;

async function startFile(path) {
  // Файл взят в работу — зона перетаскивания уходит, на её месте сразу
  // видно, что происходит. Иначе человек смотрит на «перетащите файл» и
  // не понимает, случилось ли что-нибудь вообще.
  $('drop').classList.add('is-hidden');
  $('file-result').classList.remove('is-hidden');
  $('file-name').textContent = path.split(/[\\/]/).pop();
  $('file-info').textContent = t('Достаю звук…');
  $('file-text').textContent = '';
  $('file-progress').style.display = 'block';
  $('file-progress').querySelector('i').style.width = '0';
  $('file-save').disabled = true;
  $('file-copy').disabled = true;

  try {
    job = await api.files.start({
      path,
      model: $('file-model').value || undefined,
      language: $('file-lang').value || null,
      timestamps: $('file-stamps').checked,
    });
  } catch (error) {
    $('file-info').textContent = error.message === 'MODEL_NOT_READY'
      ? t('Модель ещё не готова — подождите, пока она загрузится')
      : t(error.message);
    $('file-progress').style.display = 'none';
    return;
  }

  clearInterval(jobTimer);
  jobTimer = setInterval(async () => {
    const status = await api.files.status(job.id);
    $('file-progress').querySelector('i').style.width = `${Math.round(status.progress * 100)}%`;
    if (status.text) $('file-text').textContent = status.text;

    if (status.state === 'done') {
      clearInterval(jobTimer);
      $('file-progress').style.display = 'none';
      $('file-info').textContent = `${formatDuration(status.durationS)} · ${t('готово')}`;
      $('file-save').disabled = false;
      $('file-copy').disabled = false;
    } else if (status.state === 'error') {
      clearInterval(jobTimer);
      $('file-progress').style.display = 'none';
      $('file-info').textContent = status.error === 'FFMPEG_MISSING'
        ? t('Нужен FFmpeg — без него звук из видео не достать')
        : t(status.error);
    } else if (status.state === 'working') {
      $('file-info').textContent = `${formatDuration(status.durationS)} · ${t('распознаю')}, ${Math.round(status.progress * 100)} %`;
    } else if (status.state === 'switching') {
      $('file-info').textContent = t('Готовлю выбранную модель…');
    } else if (status.state === 'decoding') {
      $('file-info').textContent = t('Достаю звук из файла…');
    }
  }, 600);
}

function formatDuration(seconds) {
  const total = Math.round(seconds || 0);
  return total >= 60 ? `${Math.floor(total / 60)} ${t('мин')} ${String(total % 60).padStart(2, '0')} ${t('с')}` : `${total} ${t('с')}`;
}

$('file-pick').addEventListener('click', async () => {
  const path = await api.files.pick();
  if (path) startFile(path);
});

$('file-another').addEventListener('click', async () => {
  const path = await api.files.pick();
  if (path) { startFile(path); return; }
  clearInterval(jobTimer);
  $('file-result').classList.add('is-hidden');
  $('drop').classList.remove('is-hidden');
});

/** Модель для файлов: та же, что для диктовки, но её можно поменять. */
function renderFileModels() {
  const select = $('file-model');
  const chosen = select.value || settings.model?.name;
  select.innerHTML = '';
  (health?.catalog || []).forEach((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.cached ? t(item.title) : `${t(item.title)} — ${t('скачается при первом запуске')}`;
    select.appendChild(option);
  });
  select.value = [...select.options].some((o) => o.value === chosen) ? chosen : (settings.model?.name || 'large-v3');
}

const drop = $('drop');
['dragenter', 'dragover'].forEach((name) => drop.addEventListener(name, (event) => {
  event.preventDefault();
  drop.classList.add('is-over');
}));
['dragleave', 'drop'].forEach((name) => drop.addEventListener(name, () => drop.classList.remove('is-over')));
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const path = api.files.pathOf(file);
  if (path) startFile(path);
  else say(t('Не удалось получить путь к файлу — выберите его кнопкой'));
});

$('file-copy').addEventListener('click', async () => {
  await api.clipboard.write($('file-text').textContent);
  say(t('Текст скопирован'));
});
$('file-save').addEventListener('click', async () => {
  const saved = await api.files.save({
    text: $('file-text').textContent,
    name: `${$('file-name').textContent.replace(/\.[^.]+$/, '')}.txt`,
  });
  if (saved) say(`${t('Сохранил:')} ${saved}`);
});

// ---------- история ----------

function whenSaid(stamp) {
  const minutes = Math.round((Date.now() - stamp) / 60000);
  if (minutes < 1) return t('только что');
  if (minutes < 60) return `${minutes} ${t('мин назад')}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${t('ч назад')}`;
  return new Date(stamp).toLocaleString(t('ru-RU'), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

async function refreshHistory() {
  renderHistory(await api.history.all());
}

function renderHistory(list) {
  const card = $('history-list');
  card.innerHTML = '';

  if (!list.length) {
    card.innerHTML = '<div class="row"><div class="row-text">'
      + `<div class="row-title">${t('Пока пусто')}</div>`
      + `<div class="row-sub">${t('Здесь будет всё, что вы надиктовали — по горячей клавише или через панель записи')}</div>`
      + '</div></div>';
    return;
  }

  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'row row-stack';
    const shown = item.improved || item.text;
    row.innerHTML = `
      <div class="row-sub">${whenSaid(item.at)}${item.seconds ? ` · ${item.seconds} ${t('с речи')}` : ''}`
      + `${item.improved ? ` · <span class="pill">${t('причёсано')}</span>` : ''}</div>
      <div class="history-text">${escapeHtml(shown)}</div>
      <div class="under-card" style="margin-bottom:0;"></div>`;

    const buttons = row.querySelector('.under-card');
    buttons.appendChild(button(t('Копировать'), 'btn', async () => {
      await api.history.copy(item.id, Boolean(item.improved));
      say(t('Скопировано'));
    }));

    if (item.improved) {
      buttons.appendChild(button(t('Копировать оригинал'), 'btn', async () => {
        await api.history.copy(item.id, false);
        say(t('Скопирован оригинал'));
      }));
    } else {
      const improve = button(t('Причесать'), 'btn btn-accent', async () => {
        improve.disabled = true;
        improve.textContent = t('Думает…');
        try {
          await api.history.improve(item.id);
          say(t('Готово, текст в буфере обмена'));
        } catch (error) {
          say(t(error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')));
          improve.disabled = false;
          improve.textContent = t('Причесать');
        }
      });
      buttons.appendChild(improve);
    }

    buttons.appendChild(button(t('Убрать'), 'btn btn-quiet', async () => {
      renderHistory(await api.history.remove(item.id));
    }));

    card.appendChild(row);
  }
}

$('history-refresh').addEventListener('click', refreshHistory);
$('history-clear').addEventListener('click', async () => {
  renderHistory(await api.history.clear());
  say(t('История очищена'));
});
api.history.onChanged(renderHistory);

// ---------- о программе ----------

async function refreshLogs() {
  const lines = await api.app.logs();
  const box = $('logs');
  box.textContent = lines.join('\n') || t('Пока пусто');
  box.scrollTop = box.scrollHeight;
  refreshErrors();
}

function whenText(stamp) {
  const minutes = Math.round((Date.now() - stamp) / 60000);
  if (minutes < 1) return t('только что');
  if (minutes < 60) return `${minutes} ${t('мин назад')}`;
  return `${Math.round(minutes / 60)} ${t('ч назад')}`;
}

/** Ошибки показываем свёрнутыми: одна строка на беду, с числом повторов. */
async function refreshErrors() {
  const list = await api.app.errors(20);
  const card = $('errors');
  card.innerHTML = '';

  if (!list.length) {
    card.innerHTML = '<div class="row"><div class="row-text">'
      + `<div class="row-title">${t('За сутки ошибок не было')}</div>`
      + `<div class="row-sub">${t('Если что-то пойдёт не так, оно появится здесь')}</div></div></div>`;
    return;
  }

  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <svg class="row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M12 8v5M12 17h.01"/><path d="M12 3 2 20h20z"/>
      </svg>
      <div class="row-text">
        <div class="row-title">${escapeHtml(t(item.message)).slice(0, 300)}</div>
        <div class="row-sub">${item.scope} · ${whenText(item.last)}${item.count > 1 ? ` · ${t('повторилось')} ${item.count} ${t('раз')}` : ''}</div>
      </div>`;
    row.querySelector('.row-icon').style.color = 'var(--live)';
    card.appendChild(row);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

$('logs-refresh').addEventListener('click', refreshLogs);
$('errors-refresh').addEventListener('click', refreshErrors);
$('logs-open').addEventListener('click', async () => api.app.openPath((await api.app.state()).logFile));
$('errors-open').addEventListener('click', async () => api.app.openPath((await api.app.state()).errorFile));
$('open-github').addEventListener('click', () => api.app.openExternal('https://github.com/DanT2000/PasteTalk'));

let updateLink = '';
// Кнопка «Обновить» ставит обновление сама, изнутри программы. Ссылка на
// сайт остаётся запасным путём — если самообновление не вышло.
let updateFallback = false;
// Пока идёт установка, ничьи чужие ответы не смеют трогать этот блок:
// запоздавшая «Проверить» иначе перерисует прогресс и спрячет кнопку.
let installing = false;
$('update-check').addEventListener('click', async () => {
  $('update-check').disabled = true;
  $('update-pill').classList.add('is-hidden');
  $('update-sub').textContent = t('Спрашиваю GitHub…');

  const answer = await api.app.checkUpdates();
  if (installing) return;
  $('update-check').disabled = false;

  if (!answer.ok) {
    $('update-sub').textContent = `${t('Проверить не вышло:')} ${t(answer.error)}`;
    $('update-get').style.display = 'none';
    return;
  }

  const pill = $('update-pill');
  pill.classList.remove('is-hidden');
  if (answer.newer) {
    updateLink = answer.download;
    updateFallback = false;
    pill.className = 'pill';
    pill.textContent = `${t('есть')} ${answer.latest}`;
    $('update-get').textContent = t('Обновить сейчас');
    $('update-sub').textContent = `${t('У вас')} ${answer.current}, ${t('вышла')} ${answer.latest}`
      + (answer.sizeMb ? ` — ${t('скачается')} ${answer.sizeMb} ${t('МБ')}` : '')
      + t('. Поставится само и перезапустится — настройки останутся на месте');
    $('update-get').style.display = '';
  } else {
    pill.className = 'pill pill-ok';
    pill.textContent = t('последняя');
    $('update-sub').textContent = `${t('У вас')} ${answer.current} — ${t('новее пока нет')}`;
    $('update-get').style.display = 'none';
  }
});
$('update-get').addEventListener('click', async () => {
  if (updateFallback) {
    if (updateLink) api.app.openExternal(updateLink);
    return;
  }
  installing = true;
  $('update-get').disabled = true;
  $('update-check').disabled = true;
  $('update-sub').textContent = t('Скачиваю обновление…');

  const answer = await api.app.installUpdate();
  // Успех сюда не приходит: программа уже перезапускается новой версией.
  if (answer && !answer.ok) {
    installing = false;
    $('update-get').disabled = false;
    $('update-check').disabled = false;
    updateFallback = true;
    $('update-get').textContent = t('Скачать с сайта');
    $('update-get').style.display = '';
    $('update-sub').textContent = `${t('Само обновиться не вышло:')} ${t(answer.error)}. `
      + t('Можно скачать установщик и запустить его поверх — настройки сохранятся');
  }
});
api.app.onUpdateProgress((percent) => {
  $('update-sub').textContent = percent >= 100
    ? t('Ставлю и перезапускаюсь…')
    : `${t('Скачиваю обновление…')} ${percent}%`;
});
$('engine-restart').addEventListener('click', async () => {
  say(t('Перезапускаю движок'));
  await api.engine.restart();
  setTimeout(refreshHealth, 1500);
});

async function showClipboardHistory() {
  const { enabled, unknown } = await api.app.clipboardHistory();
  const pill = $('clip-pill');
  pill.className = `pill ${enabled ? 'pill-ok' : 'pill-muted'}`;
  pill.textContent = unknown ? t('не знаю') : (enabled ? t('включён') : t('выключен'));
  $('clip-sub').textContent = t(enabled
    ? 'Включён. Обычный и улучшенный текст лежат рядом — вызывайте по Win+V и выбирайте любой'
    : 'Рекомендуем включить: хранит несколько последних текстов, вызывается по Win+V. Без него улучшенный текст затрёт обычный');
}

$('clip-how').addEventListener('click', async () => {
  api.app.openExternal('ms-settings:clipboard');
  say(t('Открыл параметры Windows — раздел «Журнал буфера обмена»'));
  // Человек мог переключить его прямо сейчас — перепроверим через паузу.
  setTimeout(showClipboardHistory, 4000);
});
$('welcome-clip').addEventListener('click', () => api.app.openExternal('ms-settings:clipboard'));
$('ffmpeg-how').addEventListener('click', () =>
  api.app.openExternal('https://github.com/DanT2000/PasteTalk#ffmpeg'));

// Порт меняется только вместе с перезапуском движка — иначе настройка
// сохранится, а работать всё будет по-старому до следующего запуска.
$('engine-port-apply').addEventListener('click', async () => {
  say(t('Перезапускаю движок на новом порту'));
  await api.engine.restart();
  setTimeout(refreshHealth, 2000);
});

$('paused').addEventListener('change', () => api.app.setPaused($('paused').checked));
api.app.onPaused(({ paused }) => { $('paused').checked = paused; });

// ---------- первый запуск ----------

function setupWelcome() {
  const select = $('welcome-model');
  select.innerHTML = '';
  (health?.catalog || []).forEach((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${t(item.title)} — ${item.sizeMb >= 1024 ? `${(item.sizeMb / 1024).toFixed(1)} ${t('ГБ')}` : `${item.sizeMb} ${t('МБ')}`}`;
    select.appendChild(option);
  });
  select.value = settings.model?.name || 'large-v3';
}

$('welcome-done').addEventListener('click', async () => {
  await api.config.set({
    firstRun: false,
    model: { name: $('welcome-model').value, device: $('welcome-device').value },
    microphoneId: $('welcome-mic').value,
  });
  settings = await api.config.all();
  await api.engine.loadModel(settings.model);
  goto('model');
  pollModel();
  say(t('Качаю модель — это разово'));
});
$('welcome-skip').addEventListener('click', async () => {
  await api.config.set({ firstRun: false });
  settings = await api.config.all();
  goto('general');
});

// ---------- запуск окна ----------

async function refreshHealth() {
  health = await api.engine.health();
  showEngine(health.ok ? { ready: true, state: 'ready' } : { state: health.state, error: health.error });
  if (health.ok) {
    renderModels();
    renderDevices();
    renderFileModels();
    setupWelcome();
    $('ffmpeg-pill').className = health.ffmpeg ? 'pill pill-ok' : 'pill pill-bad';
    $('ffmpeg-pill').textContent = health.ffmpeg ? t('на месте') : t('не найден');
    $('ffmpeg-sub').textContent = t(health.ffmpeg
      ? 'Достаёт звук из видео. Найден в системе'
      : 'Достаёт звук из видео. Без него читаются только аудиофайлы');
    $('engine-line').textContent = `${t('Движок')} ${health.version} · ${t('модель')} ${health.model?.title || '—'} · ${health.model?.device === 'cuda' ? t('видеокарта') : t('процессор')}`;
    if (['downloading', 'loading'].includes(health.model?.state)) pollModel();
  }
}

async function start() {
  // Язык — раньше всего остального: applyLocale переводит готовый DOM,
  // а всё, что строится дальше, переводит себя через t().
  window.applyLocale(await api.i18n.get());
  // Состояние движка могло прилететь до применения языка — перерисуем.
  if (lastEngineInfo) showEngine(lastEngineInfo);

  settings = await api.config.all();
  providers = await api.llm.providers();
  const state = await api.app.state();

  applyAppearance();
  bindAll();
  renderHotkeys();
  renderProviders();
  syncModeHint();
  await loadMicrophones();

  $('version').textContent = `PasteTalk ${state.version}`;
  $('settings-path').textContent = state.settingsFile;
  $('paused').checked = state.paused;
  $('open-settings-file').addEventListener('click', () => api.app.openPath(state.settingsFile));

  if (settings.firstRun) goto('welcome');
  showClipboardHistory();
  await refreshHealth();

  api.config.onChanged((fresh) => {
    settings = fresh;
    applyAppearance();
    showValues();
    syncModeHint();
  });
}

// ---------- Где считать речь ----------

const WHERE_WORDS = {
  local: 'На этом компьютере — ничего не уходит в интернет',
  server: 'На сервере PasteTalk — вашему компьютеру считать не придётся',
  cloud: 'В облаке по вашему ключу — платите за минуты вы',
};

function showWhere() {
  const select = $('rec-where');
  if (!select) return;
  const where = select.value || 'local';

  const sub = $('where-sub');
  if (sub) sub.textContent = t(WHERE_WORDS[where] || '');

  // Местные модели и выбор видеокарты незачем показывать тому, кто
  // считает не у себя: это лишние вопросы без единого ответа.
  const show = (id, on) => { const node = $(id); if (node) node.hidden = !on; };
  show('block-local', where === 'local');
  show('block-server', where === 'server');
  show('block-cloud', where === 'cloud');
  show('weak-note', where !== 'local');
  show('rec-check-card', where !== 'local');

  const provider = $('rec-cloud');
  show('row-cloud-url', where === 'cloud' && provider?.value === 'custom');
}

// Таблица провайдеров живёт в главном процессе — держим её копию здесь,
// чтобы подписи не требовали запроса на каждое переключение.
let cloudPresets = {};

async function fillCloudProviders() {
  const select = $('rec-cloud');
  if (!select) return;
  cloudPresets = (await api.recognition.providers()) || {};
  if (select.options.length) return;
  for (const [id, preset] of Object.entries(cloudPresets)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = t(preset.title);
    select.appendChild(option);
  }
  // Значение из настроек ставим после того, как список построен.
  select.value = settings.recognition?.cloudProvider || 'aitunnel';
}

function showCloudHints() {
  const preset = cloudPresets[$('rec-cloud')?.value];
  if (!preset) return;
  const hint = $('cloud-hint');
  if (hint) hint.textContent = t(preset.hint || '');
  const model = $('cloud-model-sub');
  if (model) model.textContent = `${t('Пусто — возьмём')} ${preset.defaultModel}`;
}

$('rec-where')?.addEventListener('change', showWhere);
$('rec-cloud')?.addEventListener('change', () => {
  showCloudHints();
  showWhere();
});

$('rec-pair')?.addEventListener('click', async () => {
  const field = $('rec-code');
  const button = $('rec-pair');
  const code = field.value.trim();
  const sub = $('rec-check-sub');
  if (!/^\d{6}$/.test(code)) {
    if (sub) sub.textContent = t('Код — это ровно шесть цифр');
    return;
  }
  button.disabled = true;
  const result = await api.recognition.pair(code);
  button.disabled = false;
  if (sub) sub.textContent = result.ok ? t('Код принят, сервер подключён') : t(result.error);
  if (result.ok) field.value = '';
});

$('rec-check')?.addEventListener('click', async () => {
  const button = $('rec-check');
  const sub = $('rec-check-sub');
  button.disabled = true;
  if (sub) sub.textContent = t('Проверяю…');
  const result = await api.recognition.check();
  button.disabled = false;
  if (sub) {
    sub.textContent = result.ok
      ? t('Связь есть — можно диктовать')
      : `${t('Не вышло:')} ${t(result.error)}`;
  }
});

// ---------- Интеграция ----------

const RELAY_WORDS = {
  off: 'Выключено',
  connecting: 'Подключаюсь…',
  online: 'На связи с сервером',
  error: 'Не подключилось',
  denied: 'Сервер не принял',
};

function showRelay(state) {
  const where = $('relay-state');
  if (!where) return;
  const word = t(RELAY_WORDS[state.status] || state.status);
  where.textContent = state.hint ? `${word} — ${t(state.hint)}` : word;

  const local = $('relay-local');
  if (local && state.enginePort !== undefined) {
    local.textContent = state.enginePort
      ? `localhost:${state.enginePort}`
      : t('движок ещё не запустился');
  }
}

// Обращения через ?. не для красоты: одна ошибка на уровне модуля убивает
// весь скрипт настроек, и окно остаётся с виду рабочим, но мёртвым.
$('relay-pair')?.addEventListener('click', async () => {
  const field = $('relay-code');
  const button = $('relay-pair');
  const key = field.value.trim();
  if (!key) {
    $('relay-state').textContent = t('Вставьте ключ из раздела «Компьютеры»');
    return;
  }
  button.disabled = true;
  $('relay-state').textContent = t('Подключаюсь…');
  const result = await api.relay.pair(key);
  button.disabled = false;
  if (result.ok) {
    field.value = '';
    $('relay-enabled').checked = true;
    $('relay-state').textContent = t('Ключ принят, подключаюсь…');
  } else {
    $('relay-state').textContent = t(result.error);
  }
});

// Переключатель и адрес сохраняются сами через data-cfg, но связь надо
// поднять или уронить сразу — иначе человек щёлкает и ничего не меняется.
$('relay-enabled')?.addEventListener('change', () => setTimeout(() => api.relay.refresh(), 500));
$('relay-url')?.addEventListener('change', () => setTimeout(() => api.relay.refresh(), 500));

api.relay?.onState(showRelay);

/** Наполнить список экранов: их состав знает только главный процесс. */
async function fillDisplays() {
  const select = $('capsule-display');
  if (!select) return;
  try {
    const displays = await api.app.displays();
    // Список строится заново при каждом вызове: мониторы подключают и
    // отключают на ходу, а однажды замороженный список делал новый экран
    // недоступным до перезапуска программы.
    [...select.options].filter((o) => o.value !== 'cursor').forEach((o) => o.remove());
    for (const display of displays) {
      const option = document.createElement('option');
      option.value = display.id;
      option.textContent = t(display.title);
      select.appendChild(option);
    }
    const saved = String(settings.appearance?.capsuleDisplay || 'cursor');
    if (saved !== 'cursor' && ![...select.options].some((o) => o.value === saved)) {
      // Сохранённый экран отключён. Говорим это словами, а не пустой
      // строкой: showValues() на каждое изменение настроек выставляет
      // сохранённое значение, и без такого пункта селект просто пустел.
      const gone = document.createElement('option');
      gone.value = saved;
      gone.textContent = t('Экран отключён — панель там, где курсор');
      select.appendChild(gone);
    }
    select.value = saved;
  } catch { /* без списка остаётся «где курсор» */ }
}

// Окно настроек прячется, а не умирает, поэтому страница живёт весь сеанс.
// Открыли окно снова или сменился состав мониторов — список перечитывается.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) fillDisplays();
});
api.app.onDisplays?.(() => fillDisplays());

start()
  .then(async () => {
    await fillCloudProviders();
    await fillDisplays();
    showCloudHints();
    showWhere();
  })
  .then(() => api.relay?.state().then(showRelay))
  .catch((error) => say(`${t('Не удалось открыть настройки:')} ${t(error.message)}`));

// Молчаливая смерть скрипта — худшее, что может случиться с окном: оно
// выглядит рабочим, но ничего не делает. Пусть ошибка будет видна.
window.addEventListener('error', (event) => {
  say(`${t('Сбой в окне настроек:')} ${event.message}`);
  $('state-text').textContent = event.message;
});
