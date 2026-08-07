'use strict';

const path = require('node:path');
const { app, ipcMain, clipboard, shell, dialog, nativeTheme, systemPreferences, Notification } = require('electron');

const config = require('./config');
const engine = require('./engine');
const history = require('./history');
const hotkeys = require('./hotkeys');
const llm = require('./llm');
const logger = require('./logger');
const paste = require('./paste');
const recorder = require('./recorder');
const relay = require('./relay');
const remote = require('./remote');
const tray = require('./tray');
const updates = require('./updates');
const watchdog = require('./watchdog');
const windows = require('./windows');

const log = logger.scoped('app');

// Одна копия на систему: вторая перехватила бы горячие клавиши у первой.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('ru.appswire.pastetalk');
global.pastetalkQuitting = false;

// ---------- порядок запуска ----------

app.on('second-instance', () => windows.showSettings());

app.whenReady().then(async () => {
  log.info(`PasteTalk ${app.getVersion()} запускается`);
  windows.applyTheme();

  // Записывать звук без спроса нельзя — и Windows это проверяет.
  try {
    const granted = await systemPreferences.askForMediaAccess?.('microphone');
    if (granted === false) log.warn('доступ к микрофону не выдан');
  } catch { /* на Windows метода может не быть */ }

  windows.createAudio();
  windows.createCapsule();

  tray.create({
    record: () => startRecording('plain'),
    setPaused: (value) => setPaused(value),
    settings: () => windows.showSettings(),
    restartEngine: () => restartEngine(),
    quit: () => quit(),
  });

  engine.onState = (info) => {
    tray.refresh();
    windows.send('settings', 'engine:state', { ...info, ready: engine.isReady });
    // Движок про наши настройки не знает — говорим ему, как только ожил.
    if (info.state === 'ready') {
      engine.setIdleUnload(Number(config.get('engine.idleUnloadMs', -1)))
        .catch((error) => log.warn(`не передал срок выгрузки: ${error.message}`));
    }
  };
  await engine.start();

  relay.on('state', (state) => windows.send('settings', 'relay:state', state));
  // Соединение поднимаем после движка: пока модель не загружена, отвечать
  // на задачи с телефона всё равно нечем.
  relay.refresh();

  registerHotkeys();
  watchdog.syncAutoLaunch();
  if (config.get('startup.restartOnCrash', true)) watchdog.start();

  if (config.get('firstRun', true)) windows.showSettings('welcome');

  updates.scheduleStartupCheck(announceUpdate);

  // Мониторы подключают и отключают на ходу — окно настроек должно узнать
  // об этом сразу, иначе новый экран не выбрать до перезапуска программы.
  const { screen } = require('electron');
  screen.on('display-added', () => windows.broadcast('displays:changed', null));
  screen.on('display-removed', () => windows.broadcast('displays:changed', null));

  // Снимки окон нужны только при разработке и только с этим флагом.
  if (process.argv.includes('--dev')) require('./devserver').start();
});

/** Вышла версия новее — сказать об этом, но ничего не делать без спроса. */
async function announceUpdate(release) {
  log.info(`доступна версия ${release.latest}`);
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'PasteTalk',
    message: `Вышла версия ${release.latest}`,
    detail: `У вас ${release.current}. Обновление скачается и поставится само — настройки, модели и горячие клавиши останутся на месте.`
      + (release.sizeMb ? `\n\nРазмер: ${release.sizeMb} МБ.` : ''),
    buttons: ['Обновить сейчас', 'Что нового', 'Потом', 'Больше не напоминать'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });

  if (response === 0) await selfUpdate(release);
  else if (response === 1) shell.openExternal(release.url);
  else if (response === 3) config.set({ updates: { skipVersion: release.latest } });
}

/**
 * Обновиться, не гоняя человека по сайтам: скачать, тихо поставить,
 * перезапуститься. Ход загрузки виден в подсказке значка в трее.
 * Не вышло само — открываем страницу загрузки, как раньше.
 */
async function selfUpdate(release) {
  new Notification({
    title: 'PasteTalk',
    body: `Скачиваю ${release.latest} — поставлю и перезапущусь сам.`,
  }).show();
  try {
    await updates.downloadAndInstall();
  } catch (error) {
    log.error(`самообновление не удалось: ${error.message}`);
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'PasteTalk',
      message: 'Само обновиться не вышло',
      detail: `${error.message}\n\nМожно скачать установщик со страницы выпуска и запустить его поверх.`,
      buttons: ['Открыть страницу', 'Позже'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) shell.openExternal(release.download);
  }
}

app.on('window-all-closed', (event) => {
  // Программа живёт в трее и после закрытия всех окон.
  event?.preventDefault?.();
});

app.on('before-quit', () => { global.pastetalkQuitting = true; });

app.on('will-quit', async () => {
  hotkeys.unregister();
  config.flush();
  await engine.stop();
});

process.on('uncaughtException', (error) => log.error(error));
process.on('unhandledRejection', (error) => log.error(error));

// ---------- запись ----------

function startRecording(mode) {
  if (tray.isPaused()) return;
  recorder.cancelHide();
  windows.showCapsule();

  const delay = Number(config.get('limits.startDelayMs', 0)) || 0;
  if (delay > 0) {
    // Отсчёт показываем на самой панели: она уже на экране, и человек
    // видит, что нажатие сработало, а запись вот-вот начнётся.
    windows.send('capsule', 'capsule:countdown', { ms: delay });
    clearTimeout(startTimer);
    startTimer = setTimeout(() => begin(mode), delay);
    return;
  }
  begin(mode);
}

let startTimer = null;

function begin(mode) {
  startTimer = null;
  windows.send('capsule', 'capsule:state', { state: 'listening', elapsedMs: 0 });
  windows.send('audio', 'audio:start', {
    deviceId: config.get('microphoneId', 'default'),
  });
  recorder.start(mode);
}

function stopRecording() {
  windows.send('audio', 'audio:stop', {});
  recorder.finish('done');
}

function toggleRecording(mode) {
  // Второе нажатие во время отсчёта — передумали. Отменяем, не начиная.
  if (startTimer) {
    clearTimeout(startTimer);
    startTimer = null;
    windows.hideCapsule();
    return;
  }
  if (recorder.active) stopRecording();
  else startRecording(mode);
}

recorder.on('state', (payload) => {
  windows.send('capsule', 'capsule:state', payload);
  if (payload.state !== 'listening') windows.send('audio', 'audio:stop', {});
});

recorder.on('partial', (payload) => windows.send('capsule', 'capsule:partial', payload));

recorder.on('text', (payload) => {
  const entry = history.add(payload);
  windows.send('settings', 'history:changed', history.all());
  if (entry) windows.send('capsule', 'capsule:history', { has: true });
});

recorder.on('hide', () => windows.hideCapsule());

// ---------- горячие клавиши ----------

function registerHotkeys() {
  const failed = hotkeys.register({
    record: () => toggleRecording('plain'),
    recordAndImprove: () => {
      // finish() при режиме improve улучшает сам — второй вызов прогнал бы
      // через модель уже улучшенный текст: вдвое дольше и вдвое дороже.
      if (recorder.active) { windows.send('audio', 'audio:stop', {}); recorder.finish('done'); }
      else startRecording('improve');
    },
    improveClipboard: () => improveClipboard(),
  });
  if (failed.length) {
    windows.send('settings', 'hotkeys:conflict', failed);
  }
}

/**
 * Улучшить то, что уже сказано.
 *
 * Сначала смотрим в буфер обмена — если человек только что вставил свой
 * текст, поправить надо именно его. Пусто или буфер уже занят чем-то
 * посторонним — берём последнюю запись из истории: диктовка могла быть
 * пять минут назад, и возвращаться к ней должно быть можно.
 */
async function improveClipboard() {
  const fromClipboard = clipboard.readText().trim();
  const last = history.latest();
  const text = fromClipboard || (last ? (last.improved || last.text) : '');

  if (!text) {
    recorder.cancelHide();
    windows.showCapsule();
    windows.send('capsule', 'capsule:state', { state: 'aierror', hint: 'Улучшать пока нечего' });
    recorder.scheduleHide(2600);
    return;
  }

  recorder.cancelHide();
  windows.showCapsule();
  await recorder.improve(text);
}

/** Прогнать через модель последнюю надиктованную запись, минуя буфер. */
async function improveLast() {
  const last = history.latest();
  recorder.cancelHide();
  windows.showCapsule();
  if (!last) {
    windows.send('capsule', 'capsule:state', { state: 'aierror', hint: 'История пока пуста' });
    recorder.scheduleHide(2600);
    return;
  }
  await recorder.improve(last.text);
}

// ---------- управление ----------

function setPaused(value) {
  tray.setPaused(value);
  if (value) {
    hotkeys.unregister();
    recorder.abort('nospeech');
    windows.hideCapsule();
  } else {
    registerHotkeys();
  }
  windows.send('settings', 'app:paused', { paused: value });
  log.info(value ? 'поставлен на паузу' : 'снят с паузы');
}

async function restartEngine() {
  log.info('перезапуск движка по просьбе пользователя');
  engine.stopping = false;
  await engine.stop();
  engine.stopping = false;
  engine.restarts = 0;
  await engine.start();
}

function quit() {
  global.pastetalkQuitting = true;
  app.quit();
}

// ---------- мост в интерфейс ----------

ipcMain.handle('config:all', () => config.all());
ipcMain.handle('config:set', (_event, patch) => {
  // Срок выгрузки движок держит у себя — говорим ему сразу, иначе выбор
  // «никогда не выгружать» вступал бы в силу только после перезапуска.
  if (patch?.engine?.idleUnloadMs !== undefined && engine.isReady) {
    engine.setIdleUnload(Number(patch.engine.idleUnloadMs))
      .catch((error) => log.warn(`не передал срок выгрузки: ${error.message}`));
  }
  const before = config.all();
  const after = config.set(patch);

  if (patch.appearance?.theme) windows.applyTheme();
  if (patch.hotkeys) registerHotkeys();
  if (patch.startup && 'autoLaunch' in patch.startup) setAutoLaunch(after.startup.autoLaunch);
  if (patch.model && (patch.model.name !== before.model.name || patch.model.device !== before.model.device)) {
    engine.loadModel(after.model).catch((error) => log.error(error));
  }
  windows.broadcast('config:changed', after);
  return after;
});

ipcMain.handle('engine:health', async () => {
  if (!engine.isReady) return { ok: false, state: engine.state, error: engine.lastError };
  try {
    return { ok: true, state: engine.state, ...(await engine.health()) };
  } catch (error) {
    return { ok: false, state: engine.state, error: error.message };
  }
});
ipcMain.handle('engine:model', () => engine.modelStatus().catch((error) => ({ state: 'error', error: error.message })));
ipcMain.handle('engine:loadModel', (_event, model) => engine.loadModel(model));
ipcMain.handle('engine:deleteModel', (_event, name) => engine.deleteModel(name));
ipcMain.handle('engine:benchmark', () => engine.benchmark());
ipcMain.handle('engine:restart', () => restartEngine());

ipcMain.handle('llm:check', (_event, overrides) => llm.check(overrides));
ipcMain.handle('llm:models', (_event, overrides) => llm.models(overrides));
ipcMain.handle('llm:providers', () => llm.PROVIDERS);

ipcMain.handle('hotkeys:isFree', (_event, accelerator) => hotkeys.isFree(accelerator));

ipcMain.handle('app:state', () => ({
  version: app.getVersion(),
  paused: tray.isPaused(),
  engine: { state: engine.state, error: engine.lastError, ready: engine.isReady },
  logFile: logger.logFile(),
  errorFile: logger.errorFile(),
  settingsFile: config.file(),
}));
ipcMain.handle('app:displays', () => {
  const { screen } = require('electron');
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    title: `Экран ${i + 1} — ${d.size.width}×${d.size.height}`
      + (d.id === primary.id ? ' (основной)' : ''),
  }));
});

ipcMain.handle('recognition:providers', () => remote.CLOUD);
ipcMain.handle('recognition:pair', (_event, code) => remote.pair(code));
ipcMain.handle('recognition:check', () => remote.check());

ipcMain.handle('relay:state', () => ({
  ...relay.state(),
  // Порт движка человек настраивает в «Основных»; здесь его только
  // показываем, чтобы было что вписать в свою программу.
  enginePort: engine.port || 0,
}));

ipcMain.handle('relay:refresh', () => {
  relay.refresh();
  return relay.state();
});

ipcMain.handle('relay:pair', async (_event, code) => {
  const url = String(config.get('relay.url', '')).trim().replace(/\/+$/, '');
  if (!url) return { ok: false, error: 'Сначала укажите адрес сервера' };

  // Ключ компьютера кладётся как есть: обменивать его не на что, он и
  // есть постоянный доступ. Шесть цифр — прежний путь через код человека.
  const clean = String(code || '').trim();
  if (!/^\d{6}$/.test(clean)) {
    // Обрезанный или захвативший лишнее ключ лучше отвергнуть сейчас,
    // чем сказать «принят» и молча не подключиться.
    if (!/^pt_[A-Za-z0-9_-]{20,}$/.test(clean)) {
      return { ok: false, error: 'Ключ выглядит неполным — скопируйте его из админки целиком' };
    }
    config.set({ relay: { token: clean, enabled: true } });
    relay.refresh();
    return { ok: true };
  }
  // Привязка идёт обычным HTTP, а работа — по WebSocket. Адрес человек
  // вводит один, поэтому схему подменяем сами.
  const httpUrl = url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  try {
    const response = await fetch(`${httpUrl}/v1/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: String(code || '').trim(),
        kind: 'desktop',
        title: require('node:os').hostname(),
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: data.error || `Сервер ответил ${response.status}` };
    }
    // config.set сливает вглубь, поэтому адрес и имя останутся как были.
    config.set({ relay: { token: data.token, enabled: true } });
    relay.refresh();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Не достучались до сервера: ${error.message}` };
  }
});

ipcMain.handle('app:setPaused', (_event, value) => setPaused(Boolean(value)));
ipcMain.handle('app:logs', () => logger.tail());
ipcMain.handle('app:errors', (_event, limit) => logger.errors(limit || 20));

/**
 * Включён ли журнал буфера обмена Windows (тот, что по Win+V).
 *
 * Читаем ровно тот ключ, который переключает сама Windows. Пока значения
 * нет, журнал выключен — так его и заводят с завода.
 */
ipcMain.handle('app:clipboardHistory', async () => {
  try {
    const { spawn } = require('node:child_process');
    const value = await new Promise((resolve) => {
      const child = spawn('reg', ['query', 'HKCU\\Software\\Microsoft\\Clipboard', '/v', 'EnableClipboardHistory'],
        { windowsHide: true });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('close', () => resolve(out));
      child.on('error', () => resolve(''));
    });
    const found = /EnableClipboardHistory\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(value);
    return { enabled: Boolean(found && parseInt(found[1], 16)) };
  } catch {
    return { enabled: false, unknown: true };
  }
});
ipcMain.handle('app:openPath', (_event, target) => shell.openPath(target));
ipcMain.handle('app:openExternal', (_event, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.handle('window:minimize', (event) => event.sender.getOwnerBrowserWindow()?.minimize());
ipcMain.handle('window:maximize', (event) => {
  const win = event.sender.getOwnerBrowserWindow();
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.handle('window:hide', (event) => event.sender.getOwnerBrowserWindow()?.hide());

// ---------- панель записи ----------

ipcMain.on('capsule:action', (_event, action) => {
  if (action === 'toggle') toggleRecording('plain');
  else if (action === 'improve') {
    // Нажали ИИ во время записи — сначала заканчиваем, потом улучшаем.
    recorder.cancelHide();
    if (recorder.active) {
      windows.send('audio', 'audio:stop', {});
      // Если запись и так шла «с улучшением», finish сделает это сам —
      // второй раз гонять текст через модель незачем.
      const alreadyImproving = recorder.mode === 'improve';
      recorder.finish('done').then(() => { if (!alreadyImproving) recorder.improve(); });
    } else {
      recorder.improve();
    }
  }
  else if (action === 'settings') windows.showSettings();
  else if (action === 'history') windows.showSettings('history');
  else if (action === 'improveLast') improveLast();
  else if (action === 'cancel') {
    // Отсчёт перед записью тоже отменяем — иначе она начнётся уже после
    // того, как человек передумал.
    if (startTimer) { clearTimeout(startTimer); startTimer = null; windows.hideCapsule(); return; }
    windows.send('audio', 'audio:stop', {});
    recorder.cancelCurrent();
  }
});

ipcMain.on('audio:chunk', (_event, payload) => {
  recorder.pushAudio(Buffer.from(payload.pcm), payload.peak || 0);
});

ipcMain.on('audio:level', (_event, payload) => {
  windows.send('capsule', 'capsule:level', payload);
});

ipcMain.on('audio:error', (_event, payload) => {
  log.error(`микрофон: ${payload.message}`);
  // Наговорённое дороже диагностики: если речь уже была, запись
  // завершается и распознаётся, а не выбрасывается.
  recorder.micTrouble(payload.message);
});

// ---------- расшифровка файлов ----------

ipcMain.handle('files:pick', async (event) => {
  const win = event.sender.getOwnerBrowserWindow();
  const result = await dialog.showOpenDialog(win, {
    title: 'Выберите запись',
    properties: ['openFile'],
    filters: [
      { name: 'Видео и аудио', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('files:start', (_event, options) => engine.startFile(options));
ipcMain.handle('files:status', (_event, id) => engine.fileStatus(id));
ipcMain.handle('files:cancel', (_event, id) => engine.cancelFile(id));
ipcMain.handle('files:save', async (event, payload) => {
  const win = event.sender.getOwnerBrowserWindow();
  const result = await dialog.showSaveDialog(win, {
    title: 'Сохранить текст',
    defaultPath: payload.name || 'расшифровка.txt',
    filters: [{ name: 'Текст', extensions: ['txt'] }],
  });
  if (result.canceled) return null;
  require('node:fs').writeFileSync(result.filePath, payload.text, 'utf8');
  return result.filePath;
});

ipcMain.handle('clipboard:write', (_event, text) => { paste.copy(String(text || '')); return true; });

ipcMain.handle('updates:check', () => updates.check());

// ---------- история надиктованного ----------

ipcMain.handle('history:all', () => history.all());
ipcMain.handle('history:remove', (_event, id) => { history.remove(id); return history.all(); });
ipcMain.handle('history:clear', () => { history.clear(); return history.all(); });

ipcMain.handle('history:copy', (_event, payload) => {
  const entry = history.find(payload.id);
  if (!entry) return false;
  paste.copy(payload.improved && entry.improved ? entry.improved : entry.text);
  return true;
});

/** Улучшить запись из истории и запомнить результат рядом с оригиналом. */
ipcMain.handle('history:improve', async (_event, id) => {
  const entry = history.find(id);
  if (!entry) throw new Error('Запись не найдена');
  if (!config.get('ai.enabled', false)) throw new Error('Улучшение выключено в настройках');

  const improved = await llm.improve(entry.text);
  history.setImproved(id, improved);
  paste.copy(improved);
  windows.send('settings', 'history:changed', history.all());
  return improved;
});

// ---------- тема ----------

nativeTheme.on('updated', () => {
  windows.broadcast('theme:changed', { dark: nativeTheme.shouldUseDarkColors });
});
