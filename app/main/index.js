'use strict';

const path = require('node:path');
const { app, ipcMain, clipboard, shell, dialog, nativeTheme, systemPreferences } = require('electron');

const config = require('./config');
const engine = require('./engine');
const hotkeys = require('./hotkeys');
const llm = require('./llm');
const logger = require('./logger');
const ocr = require('./ocr');
const paste = require('./paste');
const recorder = require('./recorder');
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
  };
  await engine.start();

  registerHotkeys();
  watchdog.syncAutoLaunch();
  if (config.get('startup.restartOnCrash', true)) watchdog.start();

  if (config.get('firstRun', true)) windows.showSettings('welcome');

  // Снимки окон нужны только при разработке и только с этим флагом.
  if (process.argv.includes('--dev')) require('./devserver').start();
});

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
  windows.send('settings', 'history:add', { ...payload, at: Date.now() });
});

recorder.on('hide', () => {
  windows.hideCapsule();
  // Панель ушла — быстрые параметры ушли вместе с ней, и следующее
  // нажатие сочетания должно открывать их, а не закрывать.
  windows.send('capsule', 'capsule:quick', { visible: false });
  hotkeys.quickPanelClosed();
});

// ---------- горячие клавиши ----------

function registerHotkeys() {
  const failed = hotkeys.register({
    record: () => toggleRecording('plain'),
    recordAndImprove: () => {
      if (recorder.active) { windows.send('audio', 'audio:stop', {}); recorder.finish('done').then(() => recorder.improve()); }
      else startRecording('improve');
    },
    improveClipboard: () => improveClipboard(),
    recognizeImage: () => recognizeClipboardImage(),
    quickPanel: (visible) => windows.send('capsule', 'capsule:quick', { visible }),
  });
  if (failed.length) {
    windows.send('settings', 'hotkeys:conflict', failed);
  }
}

/**
 * Снимок экрана → текст в буфере, по одной клавише.
 *
 * Сделали снимок штатным Win+Shift+S — картинка уже в буфере обмена.
 * Нажали нашу клавишу — на её месте оказался текст. Если в настройках
 * включён перевод, он же и переведённый.
 */
async function recognizeClipboardImage() {
  if (tray.isPaused()) return;
  const settings = config.get('images', {});

  recorder.cancelHide();
  windows.showCapsule();
  windows.send('capsule', 'capsule:state', { state: 'ocr' });

  let text;
  try {
    text = await ocr.fromClipboard(settings.ocrLanguage);
  } catch (error) {
    const empty = error.message === 'EMPTY_CLIPBOARD';
    log.warn(`картинка не распозналась: ${error.message}`);
    windows.send('capsule', 'capsule:state', {
      state: 'ocrfail',
      hint: empty ? 'В буфере нет картинки' : error.message,
    });
    recorder.scheduleHide(3200);
    return;
  }

  if (!text) {
    windows.send('capsule', 'capsule:state', { state: 'ocrfail', hint: 'Текста на картинке нет' });
    recorder.scheduleHide(2600);
    return;
  }

  await paste.deliver(text, config.get('text.autoPaste', true));
  windows.send('settings', 'ocr:result', { text, translated: false });

  if (!settings.autoTranslate || !config.get('ai.enabled', false)) {
    windows.send('capsule', 'capsule:state', { state: 'ocrdone' });
    recorder.scheduleHide(2400);
    return;
  }

  windows.send('capsule', 'capsule:state', { state: 'translating' });
  try {
    const translated = await llm.translate(text, settings.translateTo);
    await paste.deliver(translated, config.get('text.autoPaste', true));
    windows.send('settings', 'ocr:result', { text: translated, translated: true });
    windows.send('capsule', 'capsule:state', { state: 'ocrdone', hint: 'Переведено' });
    recorder.scheduleHide(2400);
  } catch (error) {
    log.warn(`перевод не удался: ${error.message}`);
    windows.send('capsule', 'capsule:state', { state: 'aierror', hint: 'Текст без перевода в буфере' });
    recorder.scheduleHide(3200);
  }
}

async function improveClipboard() {
  const text = clipboard.readText().trim();
  if (!text) return;
  recorder.cancelHide();
  windows.showCapsule();
  await recorder.improve(text);
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
  else if (action === 'cancel') { windows.send('audio', 'audio:stop', {}); recorder.abort('nospeech'); }
});

/**
 * Правки из панели быстрых параметров — на лету, посреди записи.
 *
 * Микрофон меняем сразу: перезапускаем захват, не прерывая сессию, — уже
 * сказанное остаётся, дальше пишем с нового устройства. Модель на ходу
 * менять нельзя: она грузится секунды, и запись бы оборвалась, поэтому
 * новая берётся со следующей записи.
 */
ipcMain.on('capsule:set', (_event, patch) => {
  const before = config.all();
  const after = config.set(patch);
  windows.broadcast('config:changed', after);

  if (patch.microphoneId && patch.microphoneId !== before.microphoneId && recorder.active) {
    windows.send('audio', 'audio:start', { deviceId: after.microphoneId });
    log.info(`микрофон переключён на лету: ${after.microphoneId}`);
  }
  if (patch.model?.name && patch.model.name !== before.model.name) {
    engine.loadModel(after.model).catch((error) => log.error(error));
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
  recorder.abort('micdead', payload.message);
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

// ---------- картинки ----------

ipcMain.handle('updates:check', () => updates.check());

ipcMain.handle('ocr:languages', () => ocr.languages());
ipcMain.handle('ocr:hasImage', () => ocr.hasClipboardImage());
ipcMain.handle('ocr:fromClipboard', (_event, language) => ocr.fromClipboard(language));
ipcMain.handle('ocr:fromFile', (_event, payload) => ocr.fromFile(payload.path, payload.language));
ipcMain.handle('ocr:translate', (_event, payload) => llm.translate(payload.text, payload.target));

ipcMain.handle('images:pick', async (event) => {
  const win = event.sender.getOwnerBrowserWindow();
  const result = await dialog.showOpenDialog(win, {
    title: 'Выберите изображение',
    properties: ['openFile'],
    filters: [
      { name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'tif', 'tiff', 'webp'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ---------- тема ----------

nativeTheme.on('updated', () => {
  windows.broadcast('theme:changed', { dark: nativeTheme.shouldUseDarkColors });
});
