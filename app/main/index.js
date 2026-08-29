'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, clipboard, shell, dialog, nativeTheme, systemPreferences, Notification } = require('electron');

const config = require('./config');
const engine = require('./engine');
const history = require('./history');
const hotkeys = require('./hotkeys');
const i18n = require('./i18n');
const llm = require('./llm');
const logger = require('./logger');
const modes = require('../../shared/modes');
const paste = require('./paste');
const recorder = require('./recorder');
const relay = require('./relay');
const remote = require('./remote');
const tray = require('./tray');
const updates = require('./updates');
const watchdog = require('./watchdog');
const windows = require('./windows');

const log = logger.scoped('app');
const { tr } = i18n;

// Портативный режим: все данные (настройки, модели, журналы) живут в
// папке «PasteTalk data» рядом с программой — она целиком переезжает на
// флешке. Включается двумя способами: портативной сборкой (electron-builder
// подставляет PORTABLE_EXECUTABLE_DIR — папку, где лежит сам exe) или
// пустым файлом «portable» рядом с обычной установкой.
// Проверка — до замка одной копии: замок привязан к папке данных.
try {
  const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const marker = Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
    || fs.existsSync(path.join(portableRoot, 'portable'))
    || fs.existsSync(path.join(portableRoot, 'portable.txt'));
  if (marker) {
    const dataDir = path.join(portableRoot, 'PasteTalk data');
    // Пробная запись обязательна: рядом с установкой в Program Files
    // писать нельзя, и без проверки программа молча теряла бы настройки.
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, '.write-check');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    app.setPath('userData', dataDir);
  }
} catch { /* писать рядом нельзя — работаем как обычная установка */ }
// Стенд: отдельная папка данных для собранного, но не портативного exe —
// чтобы проверять обновления, не трогая настоящий профиль.
if (process.env.PASTETALK_DATA_DIR) app.setPath('userData', process.env.PASTETALK_DATA_DIR);

/** Приоритет процесса «выше обычного»; не вышло — не беда, просто медленнее. */
function raisePriority(pid, what) {
  try {
    const os = require('node:os');
    os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
  } catch (error) {
    log.warn(`приоритет (${what}) не поднялся: ${error.message}`);
  }
}

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
  // Диктовка — задача на живом голосе: захват звука и ответ модели не
  // должны стоять в очереди за компилятором или виртуалкой. При загруженном
  // на 100 % процессоре именно это растягивало загрузку модели в разы и
  // роняло качество: захват звука спотыкался. «Выше обычного» — как у
  // звуковых программ; дочерние процессы (окна, движок) наследуют.
  raisePriority(process.pid, 'приложение');
  windows.applyTheme();

  // Записывать звук без спроса нельзя — и Windows это проверяет.
  try {
    const granted = await systemPreferences.askForMediaAccess?.('microphone');
    if (granted === false) log.warn('доступ к микрофону не выдан');
  } catch { /* на Windows метода может не быть */ }

  windows.createAudio();
  windows.createCapsule();
  for (const name of ['audio', 'capsule']) {
    const win = windows.windows[name];
    if (win && !win.isDestroyed()) raisePriority(win.webContents.getOSProcessId(), `окно ${name}`);
  }

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
  // Уборка осиротевших голосовых файлов — до первой записи, чтобы не
  // зацепить свежую.
  history.sweepVoices();
  watchdog.syncAutoLaunch();
  if (config.get('startup.restartOnCrash', true)) watchdog.start();

  if (config.get('firstRun', true)) windows.showSettings('welcome');

  updates.scheduleStartupCheck(announceUpdate);

  // Сон движка: простой дольше срока выгрузки — гасим процесс целиком.
  // Открытое окно настроек считается работой: оно спрашивает движок о
  // моделях и железе, и будить его каждые полминуты было бы глупо.
  setInterval(() => {
    const win = windows.windows.settings;
    const settingsOpen = Boolean(win && !win.isDestroyed() && win.isVisible());
    engine.maybeSleep({ busy: recorder.active || recorder.busy || settingsOpen });
  }, 30 * 1000);

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
    message: `${tr('Вышла версия')} ${release.latest}`,
    detail: `${tr('У вас')} ${release.current}. ${tr(release.portable
      ? 'У вас портативная версия: скачайте новый Portable.exe и замените старый — папка «PasteTalk data» с настройками останется вашей.'
      : 'Обновление скачается и поставится само — настройки, модели и горячие клавиши останутся на месте.')}`
      + (release.sizeMb ? `\n\n${tr('Размер:')} ${release.sizeMb} ${tr('МБ.')}` : ''),
    buttons: [tr('Обновить сейчас'), tr('Что нового'), tr('Потом'), tr('Больше не напоминать')],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });

  if (response === 0) {
    // Портатив не умеет ставиться сам — открываем Portable.exe с зеркала
    // (прямая ссылка на CDN GitHub у части провайдеров не открывается).
    if (release.portable) shell.openExternal(release.mirror || release.download || release.url);
    else await selfUpdate(release);
  } else if (response === 1) shell.openExternal(release.url);
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
    body: `${tr('Скачиваю')} ${release.latest} — ${tr('поставлю и перезапущусь сам.')}`,
  }).show();
  try {
    await updates.downloadAndInstall();
  } catch (error) {
    log.error(`самообновление не удалось: ${error.message}`);
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'PasteTalk',
      message: tr('Само обновиться не вышло'),
      detail: `${tr(error.message)}\n\n${tr('Можно скачать установщик со страницы выпуска и запустить его поверх.')}`,
      buttons: [tr('Открыть страницу'), tr('Позже')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    // Само не скачалось — скорее всего, заблокирован CDN GitHub; ссылка на
    // зеркало у человека откроется там, где не открылась прямая.
    if (response === 0) shell.openExternal(release.mirror || release.download);
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
  // Спящий движок: панель сразу говорит «просыпаюсь», а не мигает
  // «говорите → просыпаюсь → говорите».
  windows.send('capsule', 'capsule:state', {
    state: engine.state === 'sleeping' ? 'waking' : 'listening', elapsedMs: 0,
  });
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
  // Пока движок просыпается, звук уже пишется — глушить его нельзя.
  if (payload.state !== 'listening' && payload.state !== 'waking') windows.send('audio', 'audio:stop', {});
});

recorder.on('partial', (payload) => windows.send('capsule', 'capsule:partial', payload));

recorder.on('text', (payload) => {
  const entry = history.add(payload);
  windows.send('settings', 'history:changed', history.all());
  if (entry) windows.send('capsule', 'capsule:history', { has: true });
});

// Распознавание сорвалось — голос уехал в историю. Кнопку «причесать
// последнюю» капсуле не включаем: текста у этой записи ещё нет.
recorder.on('voice', (payload) => {
  history.addVoice(payload);
  windows.send('settings', 'history:changed', history.all());
});

recorder.on('hide', () => windows.hideCapsule());

// ---------- горячие клавиши ----------

function registerHotkeys() {
  const failed = hotkeys.register({
    record: () => toggleRecording('plain'),
    recordAndImprove: () => {
      // finish() при режиме improve улучшает сам — второй вызов прогнал бы
      // через модель уже улучшенный текст: вдвое дольше и вдвое дороже.
      if (recorder.active) {
        // Решает клавиша завершения: начали запись обычной, закончили
        // «с улучшением» — значит, человек хочет улучшение.
        recorder.mode = 'improve';
        windows.send('audio', 'audio:stop', {});
        recorder.finish('done');
      } else startRecording('improve');
    },
    improveClipboard: () => improveClipboard(),
  });
  if (failed.length) {
    windows.send('settings', 'hotkeys:conflict', failed);
    // Окно настроек на старте ещё не открыто — сообщение туда пропадает.
    // Человек обязан узнать, что клавиши держит кто-то другой (например,
    // вторая копия программы), иначе диктовка «просто не работает».
    try {
      new Notification({
        title: 'PasteTalk',
        body: tr('Горячие клавиши заняты другой программой — возможно, запущена вторая копия PasteTalk'),
      }).show();
    } catch { /* система без уведомлений — переживём */ }
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
  // Голосовая запись без текста улучшению не поддаётся — не подсовываем
  // вместо неё более старую диктовку, это обмануло бы человека.
  const text = fromClipboard || (last && last.text ? (last.improved || last.text) : '');

  if (!text) {
    recorder.cancelHide();
    windows.showCapsule();
    windows.send('capsule', 'capsule:state', { state: 'aierror', hint: tr('Улучшать пока нечего') });
    recorder.scheduleHide(2600);
    return;
  }

  recorder.cancelHide();
  windows.showCapsule();
  await recorder.improve(text);
}

/** Прогнать через модель последнюю надиктованную запись, минуя буфер. */
async function improveLast(mode = '') {
  const last = history.latest();
  recorder.cancelHide();
  windows.showCapsule();
  if (!last) {
    windows.send('capsule', 'capsule:state', { state: 'aierror', hint: tr('История пока пуста') });
    recorder.scheduleHide(2600);
    return;
  }
  // Звук с 2.16.0 хранится у КАЖДОЙ записи — «не распозналось» это
  // отсутствие текста, а не наличие голоса. Старая проверка по voice
  // отвергала любую свежую диктовку.
  if (!last.text) {
    windows.send('capsule', 'capsule:state', { state: 'aierror', hint: tr('Последняя запись не распознана — нажмите «Распознать» в истории') });
    recorder.scheduleHide(2600);
    return;
  }
  recorder.improveMode = mode;
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
  // Именно watchdog.applyAutoLaunch: раньше здесь звалась несуществующая
  // setAutoLaunch — переключатель падал молча, реестр менялся только
  // после перезапуска программы.
  if (patch.startup && 'autoLaunch' in patch.startup) watchdog.applyAutoLaunch(after.startup.autoLaunch);
  if (patch.model && (patch.model.name !== before.model.name || patch.model.device !== before.model.device)) {
    engine.loadModel(after.model).catch((error) => log.error(error));
  }
  // Язык интерфейса меняется живьём: окна перечитывают свой HTML заново,
  // трей перестраивает меню. Без перезагрузки страницы пришлось бы уметь
  // переводить уже переведённое обратно.
  if (patch.ui && 'locale' in patch.ui) {
    windows.reloadAll();
    tray.refresh();
  }
  windows.broadcast('config:changed', after);
  return after;
});

ipcMain.handle('i18n:get', () => i18n.forRenderer());

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

// ---------- папка моделей ----------

ipcMain.handle('models:dir', () => ({
  dir: engine.modelsDir(),
  custom: Boolean(config.get('engine.modelsDir', '')),
}));

// Скачивание впрок: тянем вторую модель, пока выбранная работает.
ipcMain.handle('models:download', (_event, name) => engine.downloadModel(String(name || '')));
ipcMain.handle('models:downloads', () => engine.downloadsStatus());

// Только выбор папки: «Переношу…» окно покажет после того, как папка
// действительно выбрана, а не пока человек ходит по дискам в диалоге.
ipcMain.handle('models:pickDir', async (event) => {
  const win = event.sender.getOwnerBrowserWindow();
  const result = await dialog.showOpenDialog(win, {
    title: tr('Папка для моделей'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { cancelled: true };
  // Не сама выбранная папка, а своя подпапка в ней. При следующем
  // переезде старая папка удаляется ЦЕЛИКОМ — и это «целиком» обязано
  // принадлежать нам, а не документам человека, выбравшего D:\ корнем.
  return { cancelled: false, dir: path.join(result.filePaths[0], 'PasteTalk models') };
});

/**
 * Перенести модели. Модели весят гигабайты, и системный диск не
 * резиновый. Движок на время переезда останавливается и не может быть
 * поднят ничем (трей, сторожок): модель держит свой файл открытым, и
 * копировать-удалять её из-под живого процесса нельзя.
 */
let movingModels = false;

ipcMain.handle('models:changeDir', async (_event, target) => {
  const fsn = require('node:fs');
  const fsp = require('node:fs/promises');

  if (movingModels) return { ok: false, error: 'Перенос уже идёт' };
  // 'limit' — тоже распознавание: запись упёрлась в потолок и досчитывает.
  if (['listening', 'thinking', 'limit'].includes(recorder.state) || recorder.busy) {
    return { ok: false, error: 'Идёт запись — закончите её и повторите' };
  }

  const defaultDir = path.resolve(path.join(app.getPath('userData'), 'models'));
  const to = path.resolve(String(target || '') || defaultDir);
  const from = path.resolve(engine.modelsDir());
  // На Windows пути сравниваются без учёта регистра.
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const wantCustom = norm(to) !== norm(defaultDir);

  if (norm(from) === norm(to)) {
    // Выбрана та же папка — переносить нечего, но конфиг выравниваем:
    // вдруг в нём дефолтный путь был прописан явно.
    config.set({ engine: { modelsDir: wantCustom ? to : '' } });
    return { ok: true, same: true, dir: engine.modelsDir(), custom: wantCustom };
  }
  const rel = path.relative(norm(from), norm(to));
  if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return { ok: false, error: 'Нельзя переносить модели внутрь их же папки' };
  }

  movingModels = true;
  engine.moving = true;
  try {
    engine.stopping = false;
    await engine.stop();
    if (fsn.existsSync(from)) {
      await fsp.mkdir(to, { recursive: true });
      // force: файлы в цели перезаписываются. Обрезанный прошлым сбоем
      // файл выглядит как «уже есть», и доверять ему нельзя.
      await fsp.cp(from, to, { recursive: true, force: true });
    }
    // Конфиг — сразу после успешной копии и на диск без задержки: если
    // уборка старой папки споткнётся или свет мигнёт, модели уже в новой,
    // и движок обязан смотреть туда.
    config.set({ engine: { modelsDir: wantCustom ? to : '' } });
    config.flush();
    let warning = '';
    // Удаляем только свои папки: стандартную и «PasteTalk models». Если в
    // конфиг руками вписали чужую (D:\ или общую) — не трогаем её вовсе.
    const ownFolder = norm(from) === norm(defaultDir)
      || norm(path.basename(from)) === norm('PasteTalk models');
    if (ownFolder) {
      try {
        if (fsn.existsSync(from)) await fsp.rm(from, { recursive: true, force: true });
      } catch (error) {
        log.warn(`старая папка моделей удалена не целиком: ${error.message}`);
        warning = 'Модели переехали, но старую папку не удалось удалить целиком — доудалите вручную';
      }
    } else {
      log.warn(`старая папка моделей не наша (${from}) — не удаляю`);
      warning = 'Модели переехали; старую папку не трогали — удалите её вручную, если она не нужна';
    }
    log.info(`модели переехали: ${from} → ${to}`);
    return { ok: true, dir: engine.modelsDir(), custom: wantCustom, warning };
  } catch (error) {
    log.error(`перенос моделей не удался: ${error.message}`);
    return { ok: false, error: error.message };
  } finally {
    movingModels = false;
    engine.moving = false;
    engine.stopping = false;
    engine.restarts = 0;
    engine.start().catch(() => {});
  }
});

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
  // Сначала лечим сохранённую привязку: номер экрана мог смениться после
  // перезагрузки, и селект должен показать живой экран, а не «не найден».
  windows.healCapsuleDisplay();
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: d.label || '',
    width: d.size.width,
    height: d.size.height,
    x: d.bounds.x,
    y: d.bounds.y,
    title: `${tr('Экран')} ${i + 1} — ${d.size.width}×${d.size.height}`
      + (d.id === primary.id ? ` (${tr('основной')})` : ''),
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
  if (!url) return { ok: false, error: tr('Сначала укажите адрес сервера') };

  // Ключ компьютера кладётся как есть: обменивать его не на что, он и
  // есть постоянный доступ. Шесть цифр — прежний путь через код человека.
  const clean = String(code || '').trim();
  if (!/^\d{6}$/.test(clean)) {
    // Обрезанный или захвативший лишнее ключ лучше отвергнуть сейчас,
    // чем сказать «принят» и молча не подключиться.
    if (!/^pt_[A-Za-z0-9_-]{20,}$/.test(clean)) {
      return { ok: false, error: tr('Ключ выглядит неполным — скопируйте его из админки целиком') };
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
      return { ok: false, error: data.error || `${tr('Сервер ответил')} ${response.status}` };
    }
    // config.set сливает вглубь, поэтому адрес и имя останутся как были.
    config.set({ relay: { token: data.token, enabled: true } });
    relay.refresh();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `${tr('Не достучались до сервера:')} ${error.message}` };
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

ipcMain.on('capsule:action', (_event, action, extra) => {
  // Правая кнопка на панели присылает другой режим: настроено «почистить
  // и переписать» — будет только почистить, и наоборот. Разово, на одно
  // улучшение; пусто — как в настройках.
  const mode = extra && extra.mode ? String(extra.mode) : '';
  if (action === 'toggle') toggleRecording('plain');
  else if (action === 'improve') {
    recorder.cancelHide();
    recorder.improveMode = mode;
    if (recorder.active) {
      // Нажали ИИ во время записи: переводим ЭТУ запись в режим
      // улучшения и заканчиваем — finish улучшит сам и вставит только
      // готовый текст. Отдельный вызов improve() после finish вставлял
      // бы и сырой, и улучшенный — два текста подряд в окне.
      recorder.mode = 'improve';
      windows.send('audio', 'audio:stop', {});
      recorder.finish('done');
    } else {
      recorder.improve();
    }
  }
  else if (action === 'settings') windows.showSettings();
  else if (action === 'history') windows.showSettings('history');
  else if (action === 'improveLast') improveLast(mode);
  else if (action === 'cancel') {
    // Отсчёт перед записью тоже отменяем — иначе она начнётся уже после
    // того, как человек передумал.
    if (startTimer) { clearTimeout(startTimer); startTimer = null; windows.hideCapsule(); return; }
    windows.send('audio', 'audio:stop', {});
    recorder.cancelCurrent();
  }
});

// Куски звука — строго по очереди. pushAudio асинхронный, и без цепочки
// параллельные HTTP-запросы под нагрузкой обгоняли друг друга: движок
// дописывал их в буфер в порядке прихода, и звук перемешивался.
let audioChain = Promise.resolve();
ipcMain.on('audio:chunk', (_event, payload) => {
  audioChain = audioChain
    .then(() => recorder.pushAudio(Buffer.from(payload.pcm), payload.peak || 0))
    .catch(() => {});
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
    title: tr('Выберите запись'),
    properties: ['openFile'],
    filters: [
      { name: tr('Видео и аудио'), extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'] },
      { name: tr('Все файлы'), extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

/**
 * Причесать расшифровку файла. Провайдера и модель можно взять другие,
 * чем для обычной диктовки: часовое совещание заслуживает модели
 * посильнее, чем быстрая фраза.
 */
let digestBusy = false;

ipcMain.handle('files:improve', async (_event, payload) => {
  // Один конспект за раз: перезагруженное окно или повторный клик не
  // должны запускать второй многоминутный цикл поверх первого.
  if (digestBusy) throw new Error('Конспект уже готовится — дождитесь его');

  const mode = String(payload.mode || 'meeting');
  // job: 'digest' — чтобы отмена с панели записи не убивала конспект.
  const overrides = { mode, job: 'digest' };
  // «Свои указания» для файлов — отдельные от указаний для диктовки.
  if (mode === 'custom') overrides.prompt = config.get('files.prompt', '');
  if (payload.provider) {
    overrides.provider = String(payload.provider);
    if (overrides.provider === 'custom') {
      // «Своё» у файлов живёт на собственных адресе и ключе: дорогой
      // сервер для совещаний не путается с дешёвым для диктовки.
      overrides.baseUrl = config.get('files.aiBaseUrl', '');
      overrides.apiKey = config.get('files.aiKey', '');
      if (!payload.model) overrides.model = '';
    } else if (overrides.provider !== config.get('ai.provider', '')) {
      // Сохранённые адрес и модель относятся к провайдеру из настроек
      // улучшения; чужому провайдеру они не подходят — пусть берёт свои.
      overrides.baseUrl = '';
      if (!payload.model) overrides.model = '';
    }
  }
  if (payload.model) overrides.model = String(payload.model);

  const text = String(payload.text || '');
  digestBusy = true;
  try {
    const onProgress = (progress) => windows.send('settings', 'files:improveProgress', progress);
    // Любой режим умеет длинные записи: по кускам, с ходом дела в окне.
    if (mode !== 'meeting') return await llm.improveLong(text, overrides, onProgress);
    return await llm.meetingNotes(text, overrides, onProgress);
  } finally {
    digestBusy = false;
  }
});

// Отмена конспекта: новый файл или «Другой файл» не должны оставлять
// многоминутный запрос жечь токены за спиной у человека.
ipcMain.handle('files:cancelImprove', () => llm.cancel('digest'));

ipcMain.handle('files:start', (_event, options) => {
  // Словарь специфики помогает и расшифровке файлов — термины те же.
  return engine.startFile({ ...options, prompt: modes.whisperPrompt(config.get('speech.vocabulary', '')) });
});
ipcMain.handle('files:status', (_event, id) => engine.fileStatus(id));
ipcMain.handle('files:cancel', (_event, id) => engine.cancelFile(id));
ipcMain.handle('files:save', async (event, payload) => {
  const win = event.sender.getOwnerBrowserWindow();
  const result = await dialog.showSaveDialog(win, {
    title: tr('Сохранить текст'),
    defaultPath: payload.name || 'расшифровка.txt',
    filters: [{ name: tr('Текст'), extensions: ['txt'] }],
  });
  if (result.canceled) return null;
  require('node:fs').writeFileSync(result.filePath, payload.text, 'utf8');
  return result.filePath;
});

ipcMain.handle('clipboard:write', (_event, text) => { paste.copy(String(text || '')); return true; });

ipcMain.handle('updates:check', () => updates.check());
ipcMain.handle('updates:quiet', () => updates.quietCheck());

// ---------- отчёт разработчику ----------

const REPORT_URL = 'https://pastetalk.dev.appswire.ru/v1/report';
// Имена настроек, чьи значения — секреты или личное. Значение заменяется
// длиной: разработчику важно знать, ЗАДАНО ли поле, но не его содержимое.
// Здесь же словарь специфики и свой промпт (имена, проекты, термины) и
// адреса серверов (в них бывают ключи прямо в URL).
const SECRET_KEYS = new Set([
  'keys', 'aiKey', 'apiKey', 'cloudKey', 'serverToken', 'token', 'password',
  'vocabulary', 'prompt', 'baseUrl', 'aiBaseUrl', 'serverUrl', 'cloudUrl', 'url',
]);

function sanitizeSettings(node, hot = false) {
  if (Array.isArray(node)) return node.map((item) => sanitizeSettings(item, hot));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = sanitizeSettings(value, hot || SECRET_KEYS.has(key));
    }
    return out;
  }
  return hot && node ? `скрыто (${String(node).length} симв.)` : node;
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const request = require('node:https').request({
      hostname: target.hostname,
      path: target.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (response) => {
      const parts = [];
      response.on('data', (part) => parts.push(part));
      response.on('end', () => {
        if (response.statusCode >= 400) {
          // Сервер объясняет отказ словами («не так часто») — передаём их.
          let reason = '';
          try { reason = JSON.parse(Buffer.concat(parts).toString('utf8')).error || ''; } catch { /* без слов */ }
          reject(new Error(reason || `Сервер ответил ${response.statusCode}`));
        } else resolve();
      });
    });
    request.setTimeout(20000, () => request.destroy(new Error('Сервер не ответил вовремя')));
    request.on('error', (error) => reject(new Error(
      error.code === 'ENOTFOUND' ? 'Нет связи с интернетом' : error.message)));
    request.write(payload);
    request.end();
  });
}

/** Название видеокарты: «RTX 3060» в отчёте важнее модели процессора. */
function videoCardName() {
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    // Полный путь: у некоторых людей PATH вычищен, и powershell в нём нет.
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(shell, [
      '-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name',
    ], { timeout: 4000, windowsHide: true }, (error, out) => {
      resolve(error ? '' : String(out).trim().replace(/\r?\n+/g, '; '));
    });
  });
}

/**
 * Отчёт об ошибке — только по явному нажатию человека. Что именно уйдёт,
 * он выбирает галочками; ключи и токены вычищаются всегда, без опций.
 */
ipcMain.handle('report:send', async (_event, choices = {}) => {
  const body = {
    version: app.getVersion(),
    at: new Date().toISOString(),
    // Описание словами — самое ценное в отчёте: что нажали, чего ждали.
    // Режем по символам, а не по UTF-16-единицам: эмодзи не должны
    // превращаться в обрубки.
    note: [...String(choices.note || '')].slice(0, 2000).join(''),
  };
  if (choices.system !== false) {
    const os = require('node:os');
    body.system = {
      windows: process.getSystemVersion(),
      arch: process.arch,
      electron: process.versions.electron,
      locale: app.getLocale(),
      cpu: os.cpus()[0]?.model || '',
      gpu: await videoCardName(),
      ramGb: Math.round(os.totalmem() / (1024 ** 3)),
    };
    try { body.system.engine = await engine.health(); } catch { body.system.engine = 'не отвечает'; }
  }
  if (choices.config !== false) body.settings = sanitizeSettings(config.all());
  if (choices.log !== false) {
    body.errors = logger.errors(50);
    body.log = logger.tail().slice(-200);
  }
  await postJson(REPORT_URL, body);
  log.info('отчёт об ошибке отправлен разработчику');
  return { ok: true };
});

// Обновление по кнопке из настроек: скачивает, тихо ставит и перезапускает
// программу — на сайт никого не гоняем. Ошибка возвращается окну настроек:
// оно покажет её на месте и предложит страницу загрузки как запасной путь.
ipcMain.handle('updates:install', async () => {
  try {
    await updates.downloadAndInstall((percent) => {
      windows.send('settings', 'update:progress', Math.round(percent));
    });
    return { ok: true };
  } catch (error) {
    log.error(`обновление из настроек не удалось: ${error.message}`);
    return { ok: false, error: error.message };
  }
});

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

/**
 * Распознать сохранённый голос ещё раз — по умолчанию тем, что выбрано в
 * настройках, или моделью, которую человек указал в истории: лёгкая
 * модель наврала — та же запись прогоняется тяжёлой без новой диктовки.
 */
ipcMain.handle('history:recognize', async (_event, payload) => {
  const id = payload && typeof payload === 'object' ? payload.id : payload;
  const model = payload && typeof payload === 'object' ? String(payload.model || '') : '';
  const entry = history.find(id);
  if (!entry || !entry.voice) throw new Error('Запись не найдена');
  // Пока идёт живая диктовка, файл в очередь не ставим: модель занята
  // сессией, а смена модели на лету подставила бы и саму диктовку.
  if (recorder.active) throw new Error('Идёт запись — закончите её и попробуйте снова');
  let wav;
  try {
    wav = require('node:fs').readFileSync(history.voiceFile(entry));
  } catch {
    throw new Error('Файл голоса не найден — запись можно только убрать');
  }

  let text = '';
  if (remote.isRemote()) {
    // WAV писали мы сами: 44 байта заголовка, дальше PCM 16 кГц.
    text = (await remote.transcribe(wav.subarray(44))).text;
  } else {
    if (!engine.isReady) throw new Error(engine.lastError || 'Движок ещё запускается');
    const answer = await engine.transcribeBuffer(wav, {
      filename: 'history.wav',
      model: model || undefined,
      language: config.get('language', 'ru') === 'auto' ? null : config.get('language', 'ru'),
      prompt: modes.whisperPrompt(config.get('speech.vocabulary', '')),
    });
    text = answer.text;
  }

  text = String(text || '').trim();
  if (!text) throw new Error('Распознать не вышло — в записи не нашлось речи');
  history.setText(id, text);
  paste.copy(text);
  windows.send('settings', 'history:changed', history.all());
  return history.all();
});

/** Улучшить запись из истории и запомнить результат рядом с оригиналом. */
ipcMain.handle('history:improve', async (_event, payload) => {
  const id = payload && typeof payload === 'object' ? payload.id : payload;
  const mode = payload && typeof payload === 'object' ? String(payload.mode || '') : '';
  const entry = history.find(id);
  if (!entry) throw new Error('Запись не найдена');
  if (!config.get('ai.enabled', false)) throw new Error('Улучшение выключено в настройках');

  // Режим — от нажатой кнопки: иногда нужно только почистить, без
  // переписывания. Пусто — как настроено для диктовки. Сбой — в журнал:
  // раньше ошибка уходила только тостом в окно и следа не оставляла.
  let improved;
  try {
    improved = await llm.improve(entry.text, mode ? { mode } : {});
  } catch (error) {
    log.warn(`улучшение из истории не вышло: ${error.message}`);
    throw error;
  }
  history.setImproved(id, improved);
  paste.copy(improved);
  windows.send('settings', 'history:changed', history.all());
  return improved;
});

// ---------- тема ----------

nativeTheme.on('updated', () => {
  windows.broadcast('theme:changed', { dark: nativeTheme.shouldUseDarkColors });
});
