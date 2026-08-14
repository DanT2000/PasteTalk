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
    // Закачка впрок могла пережить наш опрос (он сдаётся после серии
    // отказов) — движок ожил, проверяем заново. Если закачек нет, опрос
    // сам погаснет за один тик.
    pollDownloads();
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
  const preset = settings.sound?.preset || 'bell';
  const volume = settings.sound?.volume ?? 60;
  window.pastetalkSounds.playSound(preset, volume, true);
  setTimeout(() => window.pastetalkSounds.playSound(preset, volume, false), 550);
  // Третьим — «улучшение готово», если сигнал включён: пусть слышно всё.
  if (settings.sound?.aiDone !== false) {
    setTimeout(() => window.pastetalkSounds.playSound(preset, volume, 'done'), 1250);
  }
});

/** Спокойное «готово» — когда модель отработала из окна настроек. */
function chimeDone() {
  const sound = settings?.sound || {};
  if (!sound.preset || sound.preset === 'none' || sound.aiDone === false) return;
  window.pastetalkSounds.playSound(sound.preset, sound.volume ?? 60, 'done');
}

/** Переключателю «сигнал готовности» нечего включать при «Без звука». */
function syncSoundDependents() {
  const off = ($('sound').value || 'bell') === 'none';
  const toggle = document.querySelector('[data-cfg="sound.aiDone"]');
  if (!toggle) return;
  toggle.disabled = off;
  toggle.closest('.row')?.classList.toggle('is-muted', off);
}
$('sound').addEventListener('change', syncSoundDependents);

// ---------- папка моделей ----------

async function refreshModelsDir() {
  const info = await api.models.dir();
  $('models-dir-sub').textContent = `${info.dir} — ${t('модели весят гигабайты, папку можно вынести на просторный диск')}`;
  $('models-dir-reset').style.display = info.custom ? '' : 'none';
}

async function changeModelsDir(action) {
  let target = '';
  if (action === 'pick') {
    const picked = await api.models.pickDir();
    if (!picked || picked.cancelled) return;
    target = picked.dir;
  }
  $('models-dir-pick').disabled = true;
  $('models-dir-reset').disabled = true;
  $('models-dir-sub').textContent = t('Переношу модели — на большой модели это займёт минуту-другую…');
  try {
    const answer = await api.models.changeDir(target);
    if (!answer || answer.ok === false) {
      say(`${t('Перенести не вышло:')} ${t(answer?.error || 'что-то пошло не так')}`);
      return;
    }
    if (answer.warning) say(t(answer.warning));
    else if (!answer.same) say(t('Готово — модели теперь в новой папке'));
  } catch (error) {
    say(`${t('Перенести не вышло:')} ${t(ipcErrorText(error))}`);
  } finally {
    $('models-dir-pick').disabled = false;
    $('models-dir-reset').disabled = false;
    await refreshModelsDir();
  }
}
$('models-dir-pick').addEventListener('click', () => changeModelsDir('pick'));
$('models-dir-reset').addEventListener('click', () => changeModelsDir('reset'));

// ---------- модели распознавания ----------

// Закачки впрок: выбор и скачивание — независимые действия. Пока человек
// диктует на одной модели, вторая спокойно тянется в фоне.
let downloadsInfo = {};
let downloadsTimer = null;

function pollDownloads() {
  clearInterval(downloadsTimer);
  let failures = 0;
  downloadsTimer = setInterval(async () => {
    const previous = downloadsInfo;
    try {
      downloadsInfo = await api.models.downloads();
      failures = 0;
    } catch {
      // Движок лежит — не молотим отказами вечно. Тухлые сведения о
      // закачках стираем, иначе модель навсегда «качается впрок» с
      // спрятанными кнопками. Опрос вернётся, когда движок оживёт.
      failures += 1;
      if (failures >= 5) {
        clearInterval(downloadsTimer);
        downloadsInfo = {};
        renderModels();
      }
      return;
    }
    // Запись пропала, не дойдя до «done», — движок перезапускался и
    // закачка умерла вместе с ним. Молчать нельзя: человек ждёт гигабайты.
    for (const [name, info] of Object.entries(previous)) {
      if (info.state === 'downloading' && !downloadsInfo[name]) {
        say(t('Закачка модели прервалась — нажмите «Скачать» ещё раз, продолжится с того же места'));
      }
    }
    renderModels();
    if (!Object.values(downloadsInfo).some((d) => d.state === 'downloading')) {
      clearInterval(downloadsTimer);
      // cached-флаги каталога пересчитывает движок — перечитываем.
      refreshHealth();
    }
  }, 1200);
}

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
    const fetch = downloadsInfo[item.id];
    const fetching = !item.cached && fetch?.state === 'downloading';
    const size = item.sizeMb >= 1024 ? `${(item.sizeMb / 1024).toFixed(1)} ${t('ГБ')}` : `${item.sizeMb} ${t('МБ')}`;

    const progress = busy ? (status.progress || 0) : (fetching ? (fetch.progress || 0) : 0);
    row.innerHTML = `
      <svg class="row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        ${item.id === chosen ? '<path d="M20 6 9 17l-5-5"/>' : '<circle cx="12" cy="12" r="9"/>'}
      </svg>
      <div class="row-text">
        <div class="row-title">${t(item.title)}${item.id === chosen ? ` <span class="pill">${t('Выбрана')}</span>` : ''}</div>
        <div class="row-sub">${describeModel(item, size, status, fetch)}</div>
        ${busy || fetching ? `<div class="progress"><i style="width:${Math.round(progress * 100)}%"></i></div>` : ''}
      </div>
      <div class="row-control"></div>`;

    const controls = row.querySelector('.row-control');
    if (item.id !== chosen) {
      // Пока модель качается впрок, «Выбрать» спрятана: переключение
      // запустило бы вторую закачку того же и заморозило бы проценты.
      if (!fetching) {
        controls.appendChild(button(t('Выбрать'), 'btn', async () => {
          await save('model.name', item.id);
          await api.engine.loadModel({ ...settings.model, name: item.id });
          say(item.cached ? `${t('Переключаюсь на')} ${item.title}` : `${t('Качаю')} ${item.title}, ${size}`);
          pollModel();
        }));
      }
      if (!item.cached && !fetching) {
        controls.appendChild(button(t('Скачать'), 'btn btn-quiet', async () => {
          try {
            await api.models.download(item.id);
          } catch (error) {
            say(t(ipcErrorText(error)));
            return;
          }
          say(`${t('Качаю впрок:')} ${t(item.title)} — ${t('выбранная модель продолжает работать')}`);
          pollDownloads();
        }));
      }
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

function describeModel(item, size, status, fetch) {
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
  if (!item.cached && fetch?.state === 'downloading') {
    return `${note} · ${t('качается впрок')}, ${Math.round((fetch.progress || 0) * 100)} % ${t('из')} ${size}`;
  }
  if (!item.cached && fetch?.state === 'error') return `${note} · ${t('не скачалась:')} ${t(fetch.error || '')}`;
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
    $('bench-sub').textContent = `${t('Померить не вышло:')} ${t(ipcErrorText(error))}`;
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
    // Сохранённая модель видна сразу, а не после «Обновить»: пустой селект
    // выглядит так, будто выбор сбросился.
    fillModels([]);
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
  // Выбор человека не выбрасываем, даже если списка ещё нет или в нём не
  // нашлось такого имени: пустой селект выглядит как «модель сбросилась».
  if (chosen && !items.some((item) => item.value === chosen)) {
    items = [...items, { value: chosen, label: chosen }];
  }
  select.innerHTML = '';
  items.forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });
  select.value = chosen || (items[0]?.value ?? '');
}

$('provider').addEventListener('change', async () => {
  const chosen = $('provider').value;
  await save('ai.provider', chosen);
  await save('ai.baseUrl', '');
  await save('ai.model', '');
  $('ai-model').innerHTML = '';
  syncProvider();
  // Страница «Файлы» с выбором «Как в улучшении текста» смотрит на этого
  // же провайдера — её список моделей и кнопка «Обновить» следуют за ним.
  if (!$('file-ai-provider').value) {
    fillFileModels(undefined, chosen);
    syncFileRefresh(chosen);
  }
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
// Оценка «сколько осталось» считается от начала распознавания и держится
// спокойной: цифра не должна дрожать каждые полсекунды.
let workStartedAt = 0;
let workStartProgress = 0;
let etaShownMin = -1;

/** Стенограмма для показа: галочка снята — метки убираются, текст сплошной. */
function renderTranscript(stamped, withStamps) {
  if (withStamps) return stamped;
  return stamped
    .split('\n')
    .map((line) => line.replace(/^\[[\d:]+\]\s*/, '').trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * Сколько осталось. Вниз оценка идёт свободно, вверх — только если ошиблись
 * заметно: так она не скачет туда-сюда от случайных замедлений.
 */
function etaText(progress) {
  if (!workStartedAt) {
    workStartedAt = Date.now();
    workStartProgress = progress || 0;
    return '';
  }
  const elapsed = Date.now() - workStartedAt;
  const covered = progress - workStartProgress;
  if (elapsed >= 5000 && covered >= 0.02) {
    const leftMs = elapsed * (1 - progress) / covered;
    const minutes = Math.max(1, Math.ceil(leftMs / 60000));
    if (etaShownMin < 0 || minutes < etaShownMin || minutes > etaShownMin + 1) etaShownMin = minutes;
  }
  if (etaShownMin < 0) return '';
  const word = etaShownMin <= 1 ? t('около минуты') : `≈ ${etaShownMin} ${t('мин')}`;
  return ` · ${t('осталось')} ${word}`;
}

async function startFile(path) {
  // Прошлую задачу гасим первым делом: её опрос не должен дожить до
  // нового файла, а движку незачем дораспознавать то, что человеку уже
  // не нужно, — на процессоре это часы работы впустую. Конспект прошлого
  // файла тоже отменяем: пусть не жжёт токены за спиной.
  clearInterval(jobTimer);
  if (job?.id) api.files.cancel(job.id).catch(() => {});
  api.files.cancelImprove().catch(() => {});
  job = null;

  // Файл взят в работу — зона перетаскивания уходит, на её месте сразу
  // видно, что происходит. Иначе человек смотрит на «перетащите файл» и
  // не понимает, случилось ли что-нибудь вообще.
  $('drop').classList.add('is-hidden');
  $('file-result').classList.remove('is-hidden');
  $('file-name').textContent = path.split(/[\\/]/).pop();
  $('file-info').textContent = t('Достаю звук…');
  // Пустой блок не должен звать выбрать файл, когда файл уже в работе:
  // пока текста нет, здесь живёт понятный статус.
  $('file-text').classList.add('is-dim');
  $('file-text').textContent = t('Разбираю запись — текст появится по ходу распознавания');
  $('file-progress').style.display = 'block';
  $('file-progress').querySelector('i').style.width = '0';
  $('file-save').disabled = true;
  $('file-copy').disabled = true;
  $('file-improve').disabled = true;
  $('file-back').classList.add('is-hidden');
  fileGen += 1;
  const gen = fileGen;
  fileOriginal = '';
  fileImproved = '';
  fileStamped = '';
  fileShowingOriginal = true;
  workStartedAt = 0;
  workStartProgress = 0;
  etaShownMin = -1;

  let started;
  try {
    started = await api.files.start({
      path,
      model: $('file-model').value || undefined,
      language: $('file-lang').value || null,
      // Метки просим всегда: движок помнит время сегментов даром. Галочка
      // стала чисто про показ, а конспект совещания всегда получает время.
      timestamps: true,
    });
  } catch (error) {
    if (gen !== fileGen) return;
    const message = ipcErrorText(error);
    $('file-info').textContent = message === 'MODEL_NOT_READY'
      ? t('Модель ещё не готова — подождите, пока она загрузится')
      : t(message);
    $('file-progress').style.display = 'none';
    $('file-text').textContent = '';
    $('file-text').classList.remove('is-dim');
    return;
  }
  // Пока ждали старт, человек успел взять другой файл — этот больше не нужен.
  if (gen !== fileGen) {
    api.files.cancel(started.id).catch(() => {});
    return;
  }
  job = started;
  const jobId = started.id;

  jobTimer = setInterval(async () => {
    if (gen !== fileGen) return;
    let status;
    try {
      status = await api.files.status(jobId);
    } catch (error) {
      if (gen !== fileGen) return;
      clearInterval(jobTimer);
      $('file-progress').style.display = 'none';
      if ($('file-text').classList.contains('is-dim')) $('file-text').textContent = '';
      $('file-text').classList.remove('is-dim');
      $('file-info').textContent = `${t('Не удалось узнать состояние:')} ${t(ipcErrorText(error))}`;
      return;
    }
    if (gen !== fileGen) return;
    $('file-progress').querySelector('i').style.width = `${Math.round(status.progress * 100)}%`;
    if (status.text) {
      fileStamped = status.text;
      $('file-text').classList.remove('is-dim');
      $('file-text').textContent = renderTranscript(fileStamped, $('file-stamps').checked);
    }

    if (status.state === 'done') {
      clearInterval(jobTimer);
      $('file-progress').style.display = 'none';
      $('file-info').textContent = `${formatDuration(status.durationS)} · ${t('готово')}`;
      $('file-save').disabled = false;
      $('file-copy').disabled = false;
      fileStamped = status.text || '';
      fileOriginal = renderTranscript(fileStamped, $('file-stamps').checked);
      $('file-text').classList.remove('is-dim');
      $('file-text').textContent = fileOriginal;
      fileImproved = '';
      fileShowingOriginal = true;
      $('file-improve').disabled = false;
      $('file-back').classList.add('is-hidden');
    } else if (status.state === 'error') {
      clearInterval(jobTimer);
      $('file-progress').style.display = 'none';
      // Статус-заглушку из блока текста убираем: ошибка написана ниже.
      if ($('file-text').classList.contains('is-dim')) $('file-text').textContent = '';
      $('file-text').classList.remove('is-dim');
      $('file-info').textContent = status.error === 'FFMPEG_MISSING'
        ? t('Нужен FFmpeg — без него звук из видео не достать')
        : t(status.error);
    } else if (status.state === 'working') {
      $('file-info').textContent = `${formatDuration(status.durationS)} · ${t('распознаю')}, ${Math.round(status.progress * 100)} %${etaText(status.progress)}`;
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
  // Диалог отменили — но человек явно закончил с этим файлом: гасим
  // опрос, задачу в движке и конспект, иначе они работают впустую.
  clearInterval(jobTimer);
  if (job?.id) api.files.cancel(job.id).catch(() => {});
  api.files.cancelImprove().catch(() => {});
  job = null;
  fileGen += 1;
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

// ---------- причесать расшифровку ----------

/** Ошибка из main без служебной обёртки Electron. */
function ipcErrorText(error) {
  return String(error?.message || error || '')
    .replace(/^Error invoking remote method '[^']+': Error: /, '');
}

let fileOriginal = '';
let fileImproved = '';
// Стенограмма с метками времени — всегда, независимо от галочки показа:
// конспекту совещания метки нужны, чтобы по ним искать место в записи.
let fileStamped = '';
let fileShowingOriginal = true;
// Поколение файла: конспект, начатый для прошлого файла, не имеет права
// трогать экран нового.
let fileGen = 0;

/** Провайдеры для файлов: пусто — тот же, что причёсывает диктовку. */
function fillFileProviders() {
  const select = $('file-ai-provider');
  const chosen = settings.files?.aiProvider ?? '';
  select.innerHTML = '';
  const same = document.createElement('option');
  same.value = '';
  same.textContent = t('Как в улучшении текста');
  select.appendChild(same);
  Object.entries(providers).forEach(([id, preset]) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = t(preset.title);
    select.appendChild(option);
  });
  select.value = [...select.options].some((o) => o.value === chosen) ? chosen : '';
  fillFileModels();
  syncFileRefresh();
  syncFileProviderRows();
}

/**
 * Поля адреса и ключа под провайдером файлов. Адрес — только у «Своего»,
 * и он отдельный (files.aiBaseUrl): дорогой сервер для совещаний не должен
 * толкаться с дешёвым для диктовки. Ключ у именитых провайдеров общий с
 * «Улучшением текста» (ai.keys), у «Своего» — свой (files.aiKey).
 */
function syncFileProviderRows(providerOverride) {
  const id = providerOverride ?? $('file-ai-provider').value;
  const preset = providers[id];
  const isCustom = id === 'custom';
  $('file-ai-baseurl-row').classList.toggle('is-hidden', !isCustom);
  const needsKey = Boolean(preset?.needsKey);
  $('file-ai-key-row').classList.toggle('is-hidden', !id || !needsKey);
  if (!id || !needsKey) return;
  $('file-ai-key-sub').textContent = t(isCustom
    ? 'Хранится только на этом компьютере, в файле настроек'
    : 'Общий с «Улучшением текста»: ввели здесь — подхватится и там');
  $('file-ai-key').value = isCustom ? (settings.files?.aiKey || '') : (settings.ai?.keys?.[id] || '');
}

$('file-ai-key').addEventListener('input', () => {
  clearTimeout($('file-ai-key').timer);
  $('file-ai-key').timer = setTimeout(() => {
    const id = $('file-ai-provider').value;
    // Провайдер мог смениться, пока таймер ждал: беcключевому ничего
    // не пишем — иначе секрет ляжет в чужой, неиспользуемый слот.
    if (!id || !providers[id]?.needsKey) return;
    save(id === 'custom' ? 'files.aiKey' : `ai.keys.${id}`, $('file-ai-key').value);
  }, 400);
});

/**
 * Модели — списком, а не полем: угадывать и печатать точное имя модели
 * руками — не вариант. У агентов список известен заранее, у остальных
 * подгружается кнопкой «Обновить» с сервера провайдера.
 */
function fillFileModels(fetched, providerOverride) {
  const select = $('file-ai-model');
  const chosen = select.value || settings.files?.aiModel || '';
  select.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = t('Стандартная модель');
  select.appendChild(def);

  // Пустой выбор — «как в улучшении текста»: модели показываем того
  // провайдера, который там настроен. providerOverride — свежее значение
  // из обработчика: showValues мог откатить селект к старому.
  const provider = (providerOverride ?? $('file-ai-provider').value) || settings.ai?.provider || '';
  const preset = providers[provider];
  let items = [];
  if (fetched) {
    items = fetched.map((name) => ({ value: name, label: name }));
  } else if (preset?.kind === 'cli') {
    items = (preset.models || [])
      .filter((model) => model.id)
      .map((model) => ({ value: model.id, label: t(model.title) }));
  }
  // Выбор человека не выбрасываем, даже если его нет в списке: имя,
  // вписанное текстом в 2.15.0, обязано пережить обновление, а незнакомую
  // агенту модель тот всё равно примет через свой флаг.
  if (chosen && !items.some((item) => item.value === chosen)) {
    items.push({ value: chosen, label: chosen });
  }
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  }
  select.value = chosen;
}

/** «Обновить» нужна только там, где список моделей заранее неизвестен. */
function syncFileRefresh(providerOverride) {
  const id = (providerOverride ?? $('file-ai-provider').value) || settings.ai?.provider || '';
  const preset = providers[id];
  $('file-ai-refresh').classList.toggle('is-hidden', preset?.kind === 'cli');
}

$('file-ai-provider').addEventListener('change', async () => {
  // Значение берём сразу: пока ждём запись, showValues может откатить селект.
  const provider = $('file-ai-provider').value;
  // Недописанный ключ прошлого провайдера не должен сохраниться под новым.
  clearTimeout($('file-ai-key').timer);
  // Модель принадлежит провайдеру: имя от прошлого не переносим — у нового
  // провайдера такой модели скорее всего нет.
  await save('files.aiModel', '');
  $('file-ai-model').value = '';
  fillFileModels(undefined, provider);
  syncFileRefresh(provider);
  syncFileProviderRows(provider);
  // Список моделей подтягиваем сами: человек не обязан догадываться про
  // кнопку «Обновить». Не вышло — молчим, кнопка на месте.
  fetchFileModels(provider, { quiet: true });
});

/** Подсказка, когда провайдеру файлов не хватает ключа. У «Своего» ключ не обязателен. */
function fileKeyHint(provider) {
  const id = provider || settings.ai?.provider || '';
  if (id !== 'custom' && providers[id]?.needsKey && !settings.ai?.keys?.[id]) {
    return provider
      ? ` ${t('Ключ вводится в поле ниже')}`
      : ` ${t('Ключ вводится на странице «Улучшение текста»')}`;
  }
  return '';
}

/**
 * Спросить у провайдера список моделей для файлов. quiet — тихий
 * автозапрос при смене провайдера: не получилось — молчим, кнопка
 * «Обновить» остаётся для явной попытки с объяснением.
 */
// Поколение запроса списка моделей: пока медленный сервер отвечал,
// человек мог сменить провайдера — поздний ответ выбрасывается, а не
// подсовывает чужие модели под новым именем.
let fileModelsFetch = 0;

async function fetchFileModels(provider, { quiet = false } = {}) {
  const effective = provider || settings.ai?.provider || '';
  // У агентов список известен заранее — спрашивать некого.
  if (!providers[effective] || providers[effective].kind === 'cli') return;
  const generation = ++fileModelsFetch;
  const overrides = provider ? { provider } : {};
  if (provider === 'custom') {
    // У файлов свой адрес и свой ключ — с настройками улучшения не мешаем.
    overrides.baseUrl = $('file-ai-baseurl').value.trim();
    overrides.apiKey = $('file-ai-key').value;
  } else if (provider && provider !== settings.ai?.provider) {
    // Сохранённый адрес принадлежит основному провайдеру — чужой берёт свой.
    overrides.baseUrl = '';
  }
  const answer = await api.llm.models(overrides);
  if (generation !== fileModelsFetch) return;
  if (!answer.ok) {
    if (!quiet) say(`${t('Список моделей не пришёл:')} ${t(answer.error)}${fileKeyHint(provider)}`);
    return;
  }
  // У агентов модели приходят парами {id, title} — приводим к именам.
  const names = (answer.models || [])
    .map((item) => (typeof item === 'string' ? item : item.id))
    .filter(Boolean);
  fillFileModels(names.length ? names : undefined, provider);
}

$('file-ai-refresh').addEventListener('click', async () => {
  $('file-ai-refresh').disabled = true;
  try {
    await fetchFileModels($('file-ai-provider').value);
  } finally {
    $('file-ai-refresh').disabled = false;
  }
});

// Свои указания видны только в режиме «Свои указания».
function syncFileImproveMode() {
  $('file-prompt-row').classList.toggle('is-hidden', $('file-improve-mode').value !== 'custom');
}
$('file-improve-mode').addEventListener('change', syncFileImproveMode);

function showFileText(original) {
  fileShowingOriginal = original;
  $('file-text').textContent = original ? fileOriginal : fileImproved;
  $('file-back').textContent = t(original ? 'Показать конспект' : 'Показать оригинал');
}

$('file-back').addEventListener('click', () => showFileText(!fileShowingOriginal));

let fileImproveGen = -1;
// Живой счётчик времени: без него долгий агент неотличим от зависшего.
// Каждую секунду к статусу дописывается «уже N мин NN с» — раз цифра идёт,
// программа работает; упавший запрос закончится ошибкой, а не тишиной.
let improveTicker = null;
let improveStartedAt = 0;
let improveBase = '';

function renderImproveStatus() {
  if (fileImproveGen !== fileGen) return;
  const seconds = Math.round((Date.now() - improveStartedAt) / 1000);
  $('file-info').textContent = `${improveBase} · ${t('уже')} ${formatDuration(seconds)}`;
}

// Слово для хода по кускам: конспект «конспектируется», остальное «причёсывается».
let improveChunksWord = 'Конспектирую по кускам:';

api.files.onImproveProgress((progress) => {
  // Поздний прогресс конспекта прошлого файла не топчет статус нового.
  if (fileImproveGen !== fileGen) return;
  improveBase = `${t(improveChunksWord)} ${progress.step} ${t('из')} ${progress.total}…`;
  renderImproveStatus();
});

// Движок всегда помнит время, поэтому галочка меток действует сразу на
// готовый текст — новое распознавание не нужно.
$('file-stamps').addEventListener('change', () => {
  if (!fileStamped) return;
  fileOriginal = renderTranscript(fileStamped, $('file-stamps').checked);
  if (fileShowingOriginal) $('file-text').textContent = fileOriginal;
});

$('file-improve').addEventListener('click', async () => {
  const mode = $('file-improve-mode').value;
  // Конспекту совещания — текст с метками времени: по ним в записи ищут место.
  const source = mode === 'meeting' ? (fileStamped || fileOriginal) : fileOriginal;
  if (!source.trim()) return;
  const gen = fileGen;
  fileImproveGen = gen;
  $('file-improve').disabled = true;
  $('file-improve').textContent = t('Думает…');
  const providerId = $('file-ai-provider').value || settings.ai?.provider || '';
  improveStartedAt = Date.now();
  improveChunksWord = mode === 'meeting' ? 'Конспектирую по кускам:' : 'Причёсываю по кускам:';
  improveBase = t(providers[providerId]?.kind === 'cli'
    ? 'Агент думает — большая запись занимает несколько минут'
    : 'Причёсываю — у большой записи это занимает пару минут…');
  renderImproveStatus();
  clearInterval(improveTicker);
  // Свой хендл в замыкании: finally старого улучшения не должен гасить
  // счётчик нового, если они вдруг перекрылись.
  const myTicker = setInterval(renderImproveStatus, 1000);
  improveTicker = myTicker;
  try {
    const improved = await api.files.improve({
      text: source,
      mode,
      provider: $('file-ai-provider').value,
      model: $('file-ai-model').value.trim(),
    });
    // Пока думали, человек мог открыть другой файл — его экран не трогаем.
    if (gen !== fileGen) return;
    fileImproved = improved;
    showFileText(false);
    $('file-back').classList.remove('is-hidden');
    $('file-info').textContent = t('Готово — результат ниже, оригинал никуда не делся');
  } catch (error) {
    if (gen !== fileGen) return;
    const message = ipcErrorText(error);
    $('file-info').textContent = message.includes('PT_CANCELLED')
      ? t('Конспект прерван')
      : `${t('Причесать не вышло:')} ${t(message)}${fileKeyHint($('file-ai-provider').value)}`;
  } finally {
    clearInterval(myTicker);
    if (gen === fileGen) {
      $('file-improve').disabled = false;
      $('file-improve').textContent = t('Причесать');
    }
  }
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

    // Голос без текста: распознавание сорвалось, звук сохранён. Вместо
    // «Копировать» и «Причесать» — одна кнопка второй попытки.
    if (item.voice && !item.text) {
      row.innerHTML = `
        <div class="row-sub">${whenSaid(item.at)}${item.seconds ? ` · ${item.seconds} ${t('с речи')}` : ''}`
        + ` · <span class="pill">${t('не распозналось')}</span></div>
        <div class="history-text">${t('Голос сохранён, но текст не получился — можно попробовать ещё раз')}</div>
        <div class="under-card" style="margin-bottom:0;"></div>`;
      const acts = row.querySelector('.under-card');
      appendRecognize(acts, item, 'Распознать');
      acts.appendChild(button(t('Убрать'), 'btn btn-quiet', async () => {
        renderHistory(await api.history.remove(item.id));
      }));
      card.appendChild(row);
      continue;
    }

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
          chimeDone();
          say(t('Готово, текст в буфере обмена'));
        } catch (error) {
          say(t(ipcErrorText(error)));
          improve.disabled = false;
          improve.textContent = t('Причесать');
        }
      });
      buttons.appendChild(improve);
    }

    // Звук лежит рядом с текстом — запись можно прогнать другой моделью:
    // лёгкая наврала, автоязык промахнулся, что угодно.
    if (item.voice) appendRecognize(buttons, item, 'Распознать заново');

    buttons.appendChild(button(t('Убрать'), 'btn btn-quiet', async () => {
      renderHistory(await api.history.remove(item.id));
    }));

    card.appendChild(row);
  }
}

/**
 * Выбор модели и кнопка второй попытки распознавания. В списке — только
 * скачанные модели: нескачанная сначала тянулась бы гигабайтами, и кнопка
 * выглядела бы зависшей. При распознавании на сервере выбора нет: модель
 * там своя, наш список ей не указ.
 */
const recognizing = new Set();

function appendRecognize(where, item, label) {
  const local = (settings.recognition?.where || 'local') === 'local';
  let pick = null;
  if (local) {
    pick = document.createElement('select');
    const current = settings.model?.name || '';
    for (const model of (health?.catalog || [])) {
      if (!model.cached && model.id !== current) continue;
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = t(model.title);
      pick.appendChild(option);
    }
    if (!pick.options.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = t('Текущей моделью');
      pick.appendChild(option);
    }
    pick.value = [...pick.options].some((o) => o.value === current) ? current : pick.options[0].value;
    where.appendChild(pick);
  }
  const again = button(t(label), item.text ? 'btn' : 'btn btn-accent', async () => {
    if (recognizing.has(item.id)) return;
    recognizing.add(item.id);
    again.disabled = true;
    if (pick) pick.disabled = true;
    again.textContent = t('Распознаю…');
    try {
      const fresh = await api.history.recognize(item.id, pick ? pick.value : '');
      recognizing.delete(item.id);
      renderHistory(fresh);
      chimeDone();
      say(t('Готово, текст в буфере обмена'));
    } catch (error) {
      recognizing.delete(item.id);
      say(t(ipcErrorText(error)));
      again.disabled = false;
      if (pick) pick.disabled = false;
      again.textContent = t(label);
    }
  });
  // Список могли перерисовать посреди распознавания (пришла новая
  // диктовка) — кнопка обязана остаться выключенной, а не ожить.
  if (recognizing.has(item.id)) {
    again.disabled = true;
    if (pick) pick.disabled = true;
    again.textContent = t('Распознаю…');
  }
  where.appendChild(again);
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
$('open-guide').addEventListener('click', () => api.app.openExternal('https://github.com/DanT2000/PasteTalk#readme'));
$('tour-again').addEventListener('click', showTour);

// Отчёт разработчику: уходит только по нажатию, состав — по галочкам.
$('report-send').addEventListener('click', async () => {
  $('report-send').disabled = true;
  $('report-sub').textContent = t('Отправляю…');
  try {
    await api.app.sendReport({
      note: $('report-note').value.trim(),
      log: $('report-log').checked,
      config: $('report-config').checked,
      system: $('report-system').checked,
    });
    $('report-note').value = '';
    $('report-sub').textContent = t('Отчёт ушёл — спасибо! Так ошибки чинятся быстрее');
  } catch (error) {
    $('report-sub').textContent = `${t('Не отправилось:')} ${t(ipcErrorText(error))}`;
  } finally {
    $('report-send').disabled = false;
  }
});

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
    // Портатив сам не ставится: кнопка сразу ведёт на новый Portable.exe.
    updateFallback = Boolean(answer.portable);
    pill.className = 'pill';
    pill.textContent = `${t('есть')} ${answer.latest}`;
    $('update-get').textContent = t(answer.portable ? 'Скачать Portable.exe' : 'Обновить сейчас');
    $('update-sub').textContent = `${t('У вас')} ${answer.current}, ${t('вышла')} ${answer.latest}`
      + (answer.sizeMb ? ` — ${t('скачается')} ${answer.sizeMb} ${t('МБ')}` : '')
      + t(answer.portable
        ? '. Портативная версия обновляется заменой файла — папка «PasteTalk data» останется вашей'
        : '. Поставится само и перезапустится — настройки останутся на месте');
    $('update-get').style.display = '';
  } else {
    pill.className = 'pill pill-ok';
    pill.textContent = t('последняя');
    $('update-sub').textContent = `${t('У вас')} ${answer.current} — ${t('новее пока нет')}`;
    $('update-get').style.display = 'none';
  }
});
async function startInstallFlow() {
  // Установка одна: вторая кнопка («Что нового», «О программе») не должна
  // запускать параллельное скачивание того же файла.
  if (installing) return;
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
}
$('update-get').addEventListener('click', startInstallFlow);

// ---------- знакомство с программой ----------

/**
 * Несколько шагов о том, как всё устроено: где модель, что такое
 * улучшение, чем провайдеры отличаются друг от друга. Показывается один
 * раз, повторяется кнопкой в «О программе». Тексты собираются функцией,
 * а не константой: перевод должен браться после applyLocale.
 */
function tourSteps() {
  const p = (text) => `<p>${t(text)}</p>`;
  return [
    {
      title: 'Как это работает',
      body: p('Нажмите Ctrl+Alt+Space, скажите, нажмите ещё раз — текст уже в буфере обмена и, если включена автовставка, сам появился там, где стоял курсор.')
        + p('Ctrl+Alt+Enter заканчивает запись сразу с улучшением, а Ctrl+Alt+I причёсывает то, что уже лежит в буфере.')
        + p('Распознавание происходит на этом компьютере — звук никуда не уходит.'),
    },
    {
      title: 'Модель распознавания',
      page: 'model', target: '#model-list', wide: true,
      body: p('Выбирается в разделе «Распознавание». Large-v3 — самая точная, Large-v3 Turbo почти так же точна, но вдвое легче и быстрее — хороший выбор для начала.')
        + p('Модель скачивается один раз и живёт на диске. Если системный диск забит — «Папка моделей» переезжает куда скажете.')
        + p('Без видеокарты NVIDIA выбирайте «Считать на: Процессор» и модель полегче — или режим «На сервере PasteTalk», если у вас есть код доступа.'),
    },
    {
      title: 'Улучшение текста',
      page: 'ai', target: '#ai-enabled',
      body: p('Включается галочкой «Улучшать текст» в разделе «Улучшение текста». Языковая модель убирает «эээ» и повторы, расставляет знаки — а в режиме «Почистить и переписать» превращает устную речь в деловой текст.')
        + p('Обычный текст попадает в буфер сразу, улучшенный приходит следом и заменяет его. Модель молчит — у вас остаётся обычный.')
        + p('Указания модели можно переписать своими словами: режим «Свои указания».'),
    },
    {
      title: 'Откуда брать модель для улучшения',
      page: 'ai', target: '#provider',
      body: p('LM Studio и Ollama — бесплатно и локально: программа на вашем компьютере, ничего никуда не уходит.')
        + p('Claude Code и Codex — приложения-агенты, если они у вас установлены: работают через вашу подписку, ключ не нужен. Claude Code — от Anthropic, Codex — от OpenAI.')
        + p('ChatGPT (OpenAI), DeepSeek и AITunnel — облачные API по своему ключу: платно, по расходу. «Своё, OpenAI-совместимое» — любой сервер с таким API, хоть бесплатный шлюз.'),
    },
    {
      title: 'Словарь специфики',
      page: 'model', target: '#vocabulary',
      body: p('В работе каждого свои слова: названия программ, фамилии, термины. Впишите их в поле «Ваша специфика» в разделе «Распознавание» — через запятую.')
        + p('Распознавание перестанет их коверкать («кулифай» станет Coolify), а улучшение — «исправлять» на литературный русский.'),
    },
    {
      title: 'Файлы и конспекты',
      page: 'files', target: '#file-improve', wide: true,
      body: p('Раздел «Файлы»: перетащите видео или аудио — получите расшифровку, хоть с метками времени.')
        + p('Кнопка «Причесать» превращает её в конспект: «Конспект совещания» делает из часовой записи выжимку — темы, решения, задачи. Для больших записей можно выбрать модель посильнее обычной.'),
    },
    {
      title: 'Телефон и Telegram',
      page: 'relay', target: '[data-page="relay"] .card', wide: true,
      body: p('Раздел «Интеграция» подключает этот компьютер к серверу PasteTalk: тогда диктовать можно с телефона и через Telegram-бота, а распознавать будет этот компьютер.')
        + p('Это необязательно: без сервера всё остальное работает как есть.'),
    },
    {
      title: 'Готово',
      page: 'about', target: '#tour-again',
      body: p('Это знакомство можно пройти ещё раз: «О программе» → «Пройти знакомство».')
        + p('Подробная инструкция и ответы — на GitHub; если что-то не работает, напишите в issues, поможем.'),
    },
  ];
}

let tourAt = 0;
let tourPageBefore = '';
// Шаги собираются один раз на показ (после applyLocale переводы уже на
// месте), а resize двигает только подсветку — не пересобирает всё.
let tourStepsCache = null;
let tourCurrentStep = null;

/** Подсветить живой кусок окна: рамка вокруг, всё остальное в тени. */
function placeTourSpot(step) {
  const veil = $('tour-veil');
  const spot = $('tour-spot');
  const card = $('tour-card');

  let box = null;
  if (step.target) {
    const el = document.querySelector(step.target);
    if (el) {
      box = (step.wide ? el.closest('.card, .drop') : el.closest('.row')) || el;
      box.scrollIntoView({ block: 'center' });
    }
  }

  if (!box) {
    veil.classList.add('is-dim');
    spot.style.display = 'none';
    card.style.left = '';
    card.style.top = '';
    return;
  }

  veil.classList.remove('is-dim');
  spot.style.display = 'block';
  // Мерим после прокрутки: раскладка должна устояться.
  requestAnimationFrame(() => {
    const rect = box.getBoundingClientRect();
    spot.style.left = `${rect.left - 6}px`;
    spot.style.top = `${rect.top - 6}px`;
    spot.style.width = `${rect.width + 12}px`;
    spot.style.height = `${rect.height + 12}px`;

    // Карточку ставим СБОКУ от подсветки, чтобы подсвеченное оставалось
    // видно целиком, — особенно важно на крупном масштабе, где карточка
    // под блоком перекрывала бы половину экрана. Некуда сбоку — вниз,
    // вверх, и в крайнем случае к нижнему краю.
    const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
    const cardW = card.offsetWidth;
    const cardH = card.offsetHeight;
    const gap = 18;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left;
    let top;
    if (rect.right + gap + cardW <= vw - 12) {
      left = rect.right + gap;
      top = clamp(rect.top, 12, vh - cardH - 12);
    } else if (rect.left - gap - cardW >= 12) {
      left = rect.left - gap - cardW;
      top = clamp(rect.top, 12, vh - cardH - 12);
    } else if (rect.bottom + gap + cardH <= vh - 12) {
      left = clamp(rect.left, 12, vw - cardW - 12);
      top = rect.bottom + gap;
    } else if (rect.top - gap - cardH >= 12) {
      left = clamp(rect.left, 12, vw - cardW - 12);
      top = rect.top - gap - cardH;
    } else {
      left = (vw - cardW) / 2;
      top = Math.max(12, vh - cardH - 12);
    }
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  });
}

function renderTourStep() {
  const steps = tourStepsCache || (tourStepsCache = tourSteps());
  const step = steps[tourAt];
  tourCurrentStep = step;
  const active = document.querySelector('.nav-item.is-active')?.dataset.goto || '';
  if (step.page && step.page !== active) goto(step.page);
  $('tour-title').textContent = t(step.title);
  $('tour-body').innerHTML = step.body;
  $('tour-back').style.visibility = tourAt === 0 ? 'hidden' : 'visible';
  $('tour-next').textContent = t(tourAt === steps.length - 1 ? 'Начать работу' : 'Дальше');
  $('tour-dots').innerHTML = steps.map((_, i) => `<i${i === tourAt ? ' class="is-on"' : ''}></i>`).join('');
  placeTourSpot(step);
}

function showTour() {
  tourAt = 0;
  tourStepsCache = null;
  tourPageBefore = document.querySelector('.nav-item.is-active')?.dataset.goto || 'general';
  $('tour-veil').classList.remove('is-hidden');
  renderTourStep();
}

function finishTour() {
  $('tour-veil').classList.add('is-hidden');
  // Возвращаем человека туда, откуда он начал: тур не должен оставлять
  // его в случайном разделе.
  goto(tourPageBefore || 'general');
  save('ui.tourSeen', true);
}

$('tour-skip').addEventListener('click', finishTour);
$('tour-back').addEventListener('click', () => { if (tourAt > 0) { tourAt -= 1; renderTourStep(); } });
$('tour-next').addEventListener('click', () => {
  if (!tourStepsCache || tourAt >= tourStepsCache.length - 1) { finishTour(); return; }
  tourAt += 1;
  renderTourStep();
});
window.addEventListener('resize', () => {
  if (!$('tour-veil').classList.contains('is-hidden') && tourCurrentStep) {
    placeTourSpot(tourCurrentStep);
  }
});

// ---------- всплывашка «вышла версия» ----------

let toastRelease = null;
let updateToastTimer = null;

function hideUpdateToast() {
  clearTimeout(updateToastTimer);
  const toast = $('update-toast');
  toast.classList.remove('is-in');
  setTimeout(() => toast.classList.add('is-hidden'), 300);
}

/**
 * Заметки выпуска приходят Markdown-текстом с GitHub. Полноценный
 * разбор не нужен: заголовки, жирное и списки — этого хватает, чтобы
 * человек прочитал «что нового» без решёток и звёздочек.
 */
function renderNotes(md) {
  const inline = (s) => escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  let html = '';
  let inList = false;
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trim();
    // Контрольные суммы — для проверяющих руками, не для этого окна.
    if (/^#+\s*Контрольные суммы/i.test(line)) break;
    if (!line) { if (inList) { html += '</ul>'; inList = false; } continue; }
    if (line.startsWith('#')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h3>${inline(line.replace(/^#+\s*/, ''))}</h3>`;
      continue;
    }
    if (line.startsWith('- ')) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(line.slice(2))}</li>`;
      continue;
    }
    if (line.startsWith('```')) continue;
    html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

/** Тихая проверка при открытии окна: вышла версия — аккуратный уголок. */
async function maybeToastUpdate() {
  try {
    // Тихий путь ходит в сеть не чаще раза в сутки и сам уважает
    // «больше не напоминать» — окну остаётся только показать.
    const answer = await api.app.quietCheckUpdates();
    if (!answer.ok || !answer.notify) return;
    toastRelease = answer;
    updateLink = answer.download;
    // Портатив не ставится сам — кнопка сразу ведёт на Portable.exe.
    updateFallback = Boolean(answer.portable);
    $('update-toast-ver').textContent = answer.latest;
    const toast = $('update-toast');
    toast.classList.remove('is-hidden');
    requestAnimationFrame(() => toast.classList.add('is-in'));
    updateToastTimer = setTimeout(hideUpdateToast, 8000);
  } catch { /* тихая проверка молчит и об ошибках */ }
}

$('update-toast-close').addEventListener('click', hideUpdateToast);
$('update-toast-notes').addEventListener('click', () => {
  hideUpdateToast();
  if (!toastRelease) return;
  $('notes-ver').textContent = toastRelease.latest;
  $('notes-body').innerHTML = renderNotes(toastRelease.notes);
  $('notes-veil').classList.remove('is-hidden');
});
$('notes-close').addEventListener('click', () => $('notes-veil').classList.add('is-hidden'));
$('notes-veil').addEventListener('click', (event) => {
  if (event.target === $('notes-veil')) $('notes-veil').classList.add('is-hidden');
});
$('notes-update').addEventListener('click', () => {
  $('notes-veil').classList.add('is-hidden');
  // Ход установки показывает раздел «О программе» — ведём человека туда.
  goto('about');
  startInstallFlow();
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
  if (!settings.ui?.tourSeen) showTour();
});
$('welcome-skip').addEventListener('click', async () => {
  await api.config.set({ firstRun: false });
  settings = await api.config.all();
  goto('general');
  if (!settings.ui?.tourSeen) showTour();
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
  syncKeyDots();
  syncSoundDependents();
  refreshModelsDir();
  renderHotkeys();
  renderProviders();
  fillFileProviders();
  syncFileImproveMode();
  maybeToastUpdate();
  // Первое знакомство: один раз, можно пропустить. На самом первом
  // запуске сперва идёт страница приветствия с выбором модели — тур
  // начнётся после неё, когда человеку уже есть что подсвечивать.
  if (!settings.ui?.tourSeen && !settings.firstRun) showTour();
  syncModeHint();
  await loadMicrophones();

  $('version').textContent = `PasteTalk ${state.version}`;
  $('settings-path').textContent = state.settingsFile;
  $('paused').checked = state.paused;
  $('open-settings-file').addEventListener('click', () => api.app.openPath(state.settingsFile));

  if (settings.firstRun) goto('welcome');
  showClipboardHistory();
  await refreshHealth();
  // Закачка впрок могла идти, пока окно было закрыто, — подхватываем.
  pollDownloads();

  api.config.onChanged((fresh) => {
    settings = fresh;
    applyAppearance();
    showValues();
    syncKeyDots();
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

/**
 * Точечки в полях ключей, которые вводятся один раз и потом хранятся:
 * пустое поле выглядит как «ключ сбросился», хотя он на месте.
 */
function syncKeyDots() {
  const code = $('rec-code');
  if (code) code.placeholder = settings.recognition?.serverToken ? '••••••' : '000000';
  const relayCode = $('relay-code');
  if (relayCode) relayCode.placeholder = settings.relay?.token ? '••••••••' : 'pt_…';
}

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
