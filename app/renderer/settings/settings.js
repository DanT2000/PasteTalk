'use strict';

/**
 * Окно настроек. Держит одну копию настроек в памяти, любое изменение
 * сразу уходит в основной процесс — кнопки «Сохранить» здесь нет
 * намеренно: она только даёт повод забыть её нажать.
 */

const api = window.pastetalk;
const root = document.documentElement;

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
    text.textContent = `Готов · ${settings?.model?.name || ''}`;
  } else if (info.state === 'starting') {
    dot.classList.add('is-busy');
    text.textContent = 'Движок запускается…';
  } else if (info.state === 'failed') {
    dot.classList.add('is-bad');
    text.textContent = info.error || 'Движок не запустился';
  } else {
    text.textContent = 'Движок остановлен';
  }
}
api.engine.onState((info) => {
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
  if (!label) return 'Микрофон без названия';
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
    select.innerHTML = '<option value="default">По умолчанию в Windows</option>';
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
    say(count > 0 ? `Микрофон доступен, устройств найдено: ${count}` : 'Микрофон доступен');
  } catch (error) {
    say(`Микрофон недоступен: ${error.message}`);
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
    const size = item.sizeMb >= 1024 ? `${(item.sizeMb / 1024).toFixed(1)} ГБ` : `${item.sizeMb} МБ`;

    row.innerHTML = `
      <svg class="row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        ${item.id === chosen ? '<path d="M20 6 9 17l-5-5"/>' : '<circle cx="12" cy="12" r="9"/>'}
      </svg>
      <div class="row-text">
        <div class="row-title">${item.title}${item.id === chosen ? ' <span class="pill">Выбрана</span>' : ''}</div>
        <div class="row-sub">${describeModel(item, size, status)}</div>
        ${busy ? `<div class="progress"><i style="width:${Math.round((status.progress || 0) * 100)}%"></i></div>` : ''}
      </div>
      <div class="row-control"></div>`;

    const controls = row.querySelector('.row-control');
    if (item.id !== chosen) {
      controls.appendChild(button(item.cached ? 'Выбрать' : 'Скачать', 'btn', async () => {
        await save('model.name', item.id);
        await api.engine.loadModel({ ...settings.model, name: item.id });
        say(item.cached ? `Переключаюсь на ${item.title}` : `Качаю ${item.title}, ${size}`);
        pollModel();
      }));
    } else {
      controls.appendChild(button('Скачать заново', 'btn', async () => {
        await api.engine.deleteModel(item.id);
        await api.engine.loadModel(settings.model);
        say(`Качаю ${item.title} заново`);
        pollModel();
      }));
    }
    if (item.cached && item.id !== chosen) {
      controls.appendChild(button('Удалить', 'btn btn-quiet', async () => {
        const answer = await api.engine.deleteModel(item.id);
        say(answer?.freedMb ? `Освободилось ${Math.round(answer.freedMb)} МБ` : 'Модель удалена');
        refreshHealth();
      }));
    }
    list.appendChild(row);
  }
}

function describeModel(item, size, status) {
  const notes = {
    'large-v3': 'Самая точная',
    medium: 'Быстрее, чуть проще',
    small: 'Для слабых компьютеров',
    base: 'Совсем быстрая, ошибается',
    tiny: 'Только чтобы попробовать',
  };
  const note = notes[item.id] || '';
  if (status.name === item.id && status.state === 'downloading') {
    return `${note} · качаю, ${Math.round((status.progress || 0) * 100)} % из ${size}`;
  }
  if (status.name === item.id && status.state === 'loading') return `${note} · загружаю в память`;
  if (status.name === item.id && status.state === 'error') return status.error;
  return `${note} · ${size}${item.cached ? ' на диске' : ', ещё не скачана'}`;
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
      if (status.state === 'error') say(status.error);
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
      option.textContent = device.title;
      select.appendChild(option);
    });
    select.value = settings.model?.device || devices[0]?.id || 'cpu';
  }
  const gpu = devices.find((device) => device.id === 'cuda');
  const line = gpu ? `Найдена видеокарта с CUDA${gpu.count > 1 ? ` (${gpu.count} шт.)` : ''}` : 'Видеокарта с CUDA не найдена — считаем на процессоре';
  $('device-sub').textContent = line;
  $('welcome-device-sub').textContent = line;
}

$('device').addEventListener('change', async () => {
  await save('model.device', $('device').value);
  await api.engine.loadModel(settings.model);
  say('Переключаю вычисления');
  pollModel();
});

$('bench').addEventListener('click', async () => {
  $('bench').disabled = true;
  $('bench-sub').textContent = 'Меряю на эталонном отрывке…';
  try {
    const result = await api.engine.benchmark();
    $('bench-sub').textContent = `Минута речи распознаётся за ${result.secondsPerMinute.toFixed(1)} с `
      + `(${result.device === 'cuda' ? 'видеокарта' : 'процессор'}, ${result.model})`;
  } catch (error) {
    $('bench-sub').textContent = `Померить не вышло: ${error.message}`;
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
  if (!accelerator) return '<span class="cap-none">не назначено</span>';
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
        <div class="row-title">${item.title}</div>
        <div class="row-sub">${item.sub}</div>
      </div>
      <div class="row-control">
        <div class="combo" data-combo>${showCombo(settings.hotkeys?.[item.key])}</div>
        <button class="btn" data-edit>Изменить</button>
        <button class="btn btn-quiet" data-clear>Убрать</button>
      </div>`;
    row.querySelector('[data-edit]').addEventListener('click', (event) => beginCapture(item.key, row, event.currentTarget));
    row.querySelector('[data-clear]').addEventListener('click', async () => {
      await save(`hotkeys.${item.key}`, '');
      renderHotkeys();
      say('Сочетание убрано');
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
  combo.innerHTML = '<span class="capture-hint">Нажмите клавиши…</span>';
  trigger.textContent = 'Отмена';
}

function endCapture(commit) {
  if (!capture) return;
  const { combo, trigger, previous } = capture;
  combo.classList.remove('is-capturing');
  trigger.textContent = 'Изменить';
  if (!commit) combo.innerHTML = previous;
  capture = null;
}

async function commitCapture() {
  const accelerator = capture.keys.join('+');
  const key = capture.key;
  const free = await api.hotkeys.isFree(accelerator);
  if (!free) {
    capture.combo.classList.add('is-clash');
    say(`${accelerator} не подошло: занято другой программой или Windows`);
    return;
  }
  endCapture(true);
  await save(`hotkeys.${key}`, accelerator);
  renderHotkeys();
  say('Сочетание сохранено');
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
    else say('Сначала нажмите сочетание');
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
      + `<span class="capture-hint">${ready ? 'Enter — сохранить' : 'и саму клавишу'}</span>`
    : '<span class="capture-hint">Нажмите клавиши…</span>';
});

api.hotkeys.onConflict((failed) => {
  if (!failed?.length) return;
  say(`Заняты другой программой: ${failed.map((item) => item.accelerator).join(', ')}`);
});

// ---------- улучшение текста ----------

let providers = {};

function renderProviders() {
  const select = $('provider');
  select.innerHTML = '';
  for (const [id, preset] of Object.entries(providers)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = preset.title;
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
  $('provider-sub').textContent = preset.hint
    || (isCli ? 'Работает через вашу подписку — ключ не нужен' : 'Сервер с OpenAI-совместимым API');

  if (isCli) {
    // У агента список моделей свой и заранее известен — спрашивать некого.
    fillModels((preset.models || []).map((item) => ({ value: item.id, label: item.title })));
    $('model-sub').textContent = 'Модель полегче отвечает быстрее и стоит дешевле. Что именно доступно — зависит от вашей подписки';
  } else {
    $('baseurl').placeholder = preset.baseUrl || 'http://localhost:1234/v1';
    $('apikey').value = settings.ai?.keys?.[id] || '';
    $('model-sub').textContent = id === 'lmstudio'
      ? 'Для чистки речи хватает модели уровня Gemma 3 4B и выше — задача простая. Крупные умнее, но заставляют ждать'
      : 'Нажмите «Обновить», чтобы получить список с сервера';
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
  $('ai-mode-sub').textContent = MODE_HINTS[$('ai-mode').value] || '';
  // Подпись должна говорить о текущем положении переключателя, а не
  // висеть одним и тем же текстом при любом.
  $('ai-enabled-sub').textContent = $('ai-enabled').checked
    ? 'Кнопка ИИ на панели записи работает, а Ctrl+Alt+Enter заканчивает запись сразу улучшением'
    : 'Пока выключено: кнопка ИИ на панели записи не работает';
}

$('ai-enabled').addEventListener('change', syncModeHint);

$('ai-mode').addEventListener('change', () => { syncProvider(); syncModeHint(); });

$('apikey').addEventListener('input', () => {
  clearTimeout($('apikey').timer);
  $('apikey').timer = setTimeout(() => save(`ai.keys.${$('provider').value}`, $('apikey').value), 400);
});

$('ai-refresh').addEventListener('click', async () => {
  $('ai-refresh').disabled = true;
  $('model-sub').textContent = 'Спрашиваю сервер…';
  const answer = await api.llm.models({
    provider: $('provider').value,
    baseUrl: $('baseurl').value,
    apiKey: $('apikey').value,
  });
  $('ai-refresh').disabled = false;

  if (!answer.ok) { $('model-sub').textContent = answer.error; return; }
  fillModels(answer.models.map((name) => ({ value: name, label: name })));
  if ($('ai-model').value !== settings.ai?.model) save('ai.model', $('ai-model').value);
  $('model-sub').textContent = `Сервер отдал моделей: ${answer.models.length}`;
});

$('ai-check').addEventListener('click', async () => {
  $('ai-check').disabled = true;
  $('ai-status').className = 'pill pill-muted';
  $('ai-status').textContent = 'проверяю';
  $('ai-check-sub').textContent = 'Прогоняю короткую фразу…';

  const answer = await api.llm.check({
    provider: $('provider').value,
    baseUrl: $('baseurl').value,
    apiKey: $('apikey').value,
    model: $('ai-model').value,
  });

  $('ai-check').disabled = false;
  if (answer.ok) {
    $('ai-status').className = 'pill pill-ok';
    $('ai-status').textContent = `${answer.ms} мс`;
    $('ai-check-sub').textContent = `${answer.provider} ответил: «${answer.sample}»`;
  } else {
    $('ai-status').className = 'pill pill-bad';
    $('ai-status').textContent = 'не вышло';
    $('ai-check-sub').textContent = answer.error;
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
  $('file-info').textContent = 'Достаю звук…';
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
      ? 'Модель ещё не готова — подождите, пока она загрузится'
      : error.message;
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
      $('file-info').textContent = `${formatDuration(status.durationS)} · готово`;
      $('file-save').disabled = false;
      $('file-copy').disabled = false;
    } else if (status.state === 'error') {
      clearInterval(jobTimer);
      $('file-progress').style.display = 'none';
      $('file-info').textContent = status.error === 'FFMPEG_MISSING'
        ? 'Нужен FFmpeg — без него звук из видео не достать'
        : status.error;
    } else if (status.state === 'working') {
      $('file-info').textContent = `${formatDuration(status.durationS)} · распознаю, ${Math.round(status.progress * 100)} %`;
    } else if (status.state === 'switching') {
      $('file-info').textContent = 'Готовлю выбранную модель…';
    } else if (status.state === 'decoding') {
      $('file-info').textContent = 'Достаю звук из файла…';
    }
  }, 600);
}

function formatDuration(seconds) {
  const total = Math.round(seconds || 0);
  return total >= 60 ? `${Math.floor(total / 60)} мин ${String(total % 60).padStart(2, '0')} с` : `${total} с`;
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
    option.textContent = item.cached ? item.title : `${item.title} — скачается при первом запуске`;
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
  else say('Не удалось получить путь к файлу — выберите его кнопкой');
});

$('file-copy').addEventListener('click', async () => {
  await api.clipboard.write($('file-text').textContent);
  say('Текст скопирован');
});
$('file-save').addEventListener('click', async () => {
  const saved = await api.files.save({
    text: $('file-text').textContent,
    name: `${$('file-name').textContent.replace(/\.[^.]+$/, '')}.txt`,
  });
  if (saved) say(`Сохранил: ${saved}`);
});

// ---------- история ----------

function whenSaid(stamp) {
  const minutes = Math.round((Date.now() - stamp) / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return new Date(stamp).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

async function refreshHistory() {
  renderHistory(await api.history.all());
}

function renderHistory(list) {
  const card = $('history-list');
  card.innerHTML = '';

  if (!list.length) {
    card.innerHTML = '<div class="row"><div class="row-text">'
      + '<div class="row-title">Пока пусто</div>'
      + '<div class="row-sub">Здесь будет всё, что вы надиктовали — по горячей клавише или через панель записи</div>'
      + '</div></div>';
    return;
  }

  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'row row-stack';
    const shown = item.improved || item.text;
    row.innerHTML = `
      <div class="row-sub">${whenSaid(item.at)}${item.seconds ? ` · ${item.seconds} с речи` : ''}`
      + `${item.improved ? ' · <span class="pill">причёсано</span>' : ''}</div>
      <div class="history-text">${escapeHtml(shown)}</div>
      <div class="under-card" style="margin-bottom:0;"></div>`;

    const buttons = row.querySelector('.under-card');
    buttons.appendChild(button('Копировать', 'btn', async () => {
      await api.history.copy(item.id, Boolean(item.improved));
      say('Скопировано');
    }));

    if (item.improved) {
      buttons.appendChild(button('Копировать оригинал', 'btn', async () => {
        await api.history.copy(item.id, false);
        say('Скопирован оригинал');
      }));
    } else {
      const improve = button('Причесать', 'btn btn-accent', async () => {
        improve.disabled = true;
        improve.textContent = 'Думает…';
        try {
          await api.history.improve(item.id);
          say('Готово, текст в буфере обмена');
        } catch (error) {
          say(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
          improve.disabled = false;
          improve.textContent = 'Причесать';
        }
      });
      buttons.appendChild(improve);
    }

    buttons.appendChild(button('Убрать', 'btn btn-quiet', async () => {
      renderHistory(await api.history.remove(item.id));
    }));

    card.appendChild(row);
  }
}

$('history-refresh').addEventListener('click', refreshHistory);
$('history-clear').addEventListener('click', async () => {
  renderHistory(await api.history.clear());
  say('История очищена');
});
api.history.onChanged(renderHistory);

// ---------- о программе ----------

async function refreshLogs() {
  const lines = await api.app.logs();
  const box = $('logs');
  box.textContent = lines.join('\n') || 'Пока пусто';
  box.scrollTop = box.scrollHeight;
  refreshErrors();
}

function whenText(stamp) {
  const minutes = Math.round((Date.now() - stamp) / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  return `${Math.round(minutes / 60)} ч назад`;
}

/** Ошибки показываем свёрнутыми: одна строка на беду, с числом повторов. */
async function refreshErrors() {
  const list = await api.app.errors(20);
  const card = $('errors');
  card.innerHTML = '';

  if (!list.length) {
    card.innerHTML = '<div class="row"><div class="row-text">'
      + '<div class="row-title">За сутки ошибок не было</div>'
      + '<div class="row-sub">Если что-то пойдёт не так, оно появится здесь</div></div></div>';
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
        <div class="row-title">${escapeHtml(item.message).slice(0, 300)}</div>
        <div class="row-sub">${item.scope} · ${whenText(item.last)}${item.count > 1 ? ` · повторилось ${item.count} раз` : ''}</div>
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
$('update-check').addEventListener('click', async () => {
  $('update-check').disabled = true;
  $('update-pill').classList.add('is-hidden');
  $('update-sub').textContent = 'Спрашиваю GitHub…';

  const answer = await api.app.checkUpdates();
  $('update-check').disabled = false;

  if (!answer.ok) {
    $('update-sub').textContent = `Проверить не вышло: ${answer.error}`;
    $('update-get').style.display = 'none';
    return;
  }

  const pill = $('update-pill');
  pill.classList.remove('is-hidden');
  if (answer.newer) {
    updateLink = answer.download;
    pill.className = 'pill';
    pill.textContent = `есть ${answer.latest}`;
    $('update-sub').textContent = `У вас ${answer.current}, на GitHub ${answer.latest}`
      + (answer.sizeMb ? ` — установщик ${answer.sizeMb} МБ` : '')
      + '. Скачайте и запустите поверх, настройки сохранятся';
    $('update-get').style.display = '';
  } else {
    pill.className = 'pill pill-ok';
    pill.textContent = 'последняя';
    $('update-sub').textContent = `У вас ${answer.current} — новее пока нет`;
    $('update-get').style.display = 'none';
  }
});
$('update-get').addEventListener('click', () => {
  if (updateLink) api.app.openExternal(updateLink);
});
$('engine-restart').addEventListener('click', async () => {
  say('Перезапускаю движок');
  await api.engine.restart();
  setTimeout(refreshHealth, 1500);
});

async function showClipboardHistory() {
  const { enabled, unknown } = await api.app.clipboardHistory();
  const pill = $('clip-pill');
  pill.className = `pill ${enabled ? 'pill-ok' : 'pill-muted'}`;
  pill.textContent = unknown ? 'не знаю' : (enabled ? 'включён' : 'выключен');
  $('clip-sub').textContent = enabled
    ? 'Включён. Обычный и улучшенный текст лежат рядом — вызывайте по Win+V и выбирайте любой'
    : 'Рекомендуем включить: хранит несколько последних текстов, вызывается по Win+V. Без него улучшенный текст затрёт обычный';
}

$('clip-how').addEventListener('click', async () => {
  api.app.openExternal('ms-settings:clipboard');
  say('Открыл параметры Windows — раздел «Журнал буфера обмена»');
  // Человек мог переключить его прямо сейчас — перепроверим через паузу.
  setTimeout(showClipboardHistory, 4000);
});
$('welcome-clip').addEventListener('click', () => api.app.openExternal('ms-settings:clipboard'));
$('ffmpeg-how').addEventListener('click', () =>
  api.app.openExternal('https://github.com/DanT2000/PasteTalk#ffmpeg'));

// Порт меняется только вместе с перезапуском движка — иначе настройка
// сохранится, а работать всё будет по-старому до следующего запуска.
$('engine-port-apply').addEventListener('click', async () => {
  say('Перезапускаю движок на новом порту');
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
    option.textContent = `${item.title} — ${item.sizeMb >= 1024 ? `${(item.sizeMb / 1024).toFixed(1)} ГБ` : `${item.sizeMb} МБ`}`;
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
  say('Качаю модель — это разово');
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
    $('ffmpeg-pill').textContent = health.ffmpeg ? 'на месте' : 'не найден';
    $('ffmpeg-sub').textContent = health.ffmpeg
      ? 'Достаёт звук из видео. Найден в системе'
      : 'Достаёт звук из видео. Без него читаются только аудиофайлы';
    $('engine-line').textContent = `Движок ${health.version} · модель ${health.model?.title || '—'} · ${health.model?.device === 'cuda' ? 'видеокарта' : 'процессор'}`;
    if (['downloading', 'loading'].includes(health.model?.state)) pollModel();
  }
}

async function start() {
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

// ---------- Интеграция ----------

const RELAY_WORDS = {
  off: 'Выключено',
  connecting: 'Подключаюсь…',
  online: 'На связи с сервером',
  error: 'Не подключилось',
};

function showRelay(state) {
  const where = $('relay-state');
  if (!where) return;
  const word = RELAY_WORDS[state.status] || state.status;
  where.textContent = state.hint ? `${word} — ${state.hint}` : word;

  const local = $('relay-local');
  if (local && state.enginePort !== undefined) {
    local.textContent = state.enginePort
      ? `localhost:${state.enginePort}`
      : 'движок ещё не запустился';
  }
}

// Обращения через ?. не для красоты: одна ошибка на уровне модуля убивает
// весь скрипт настроек, и окно остаётся с виду рабочим, но мёртвым.
$('relay-pair')?.addEventListener('click', async () => {
  const field = $('relay-code');
  const button = $('relay-pair');
  const code = field.value.trim();
  if (!/^\d{6}$/.test(code)) {
    $('relay-state').textContent = 'Код — это ровно шесть цифр';
    return;
  }
  button.disabled = true;
  $('relay-state').textContent = 'Проверяю код…';
  const result = await api.relay.pair(code);
  button.disabled = false;
  if (result.ok) {
    field.value = '';
    $('relay-enabled').checked = true;
    $('relay-state').textContent = 'Код принят, подключаюсь…';
  } else {
    $('relay-state').textContent = result.error;
  }
});

// Переключатель и адрес сохраняются сами через data-cfg, но связь надо
// поднять или уронить сразу — иначе человек щёлкает и ничего не меняется.
$('relay-enabled')?.addEventListener('change', () => setTimeout(() => api.relay.refresh(), 500));
$('relay-url')?.addEventListener('change', () => setTimeout(() => api.relay.refresh(), 500));

api.relay?.onState(showRelay);

start()
  .then(() => api.relay?.state().then(showRelay))
  .catch((error) => say(`Не удалось открыть настройки: ${error.message}`));

// Молчаливая смерть скрипта — худшее, что может случиться с окном: оно
// выглядит рабочим, но ничего не делает. Пусть ошибка будет видна.
window.addEventListener('error', (event) => {
  say(`Сбой в окне настроек: ${event.message}`);
  $('state-text').textContent = event.message;
});
