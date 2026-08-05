'use strict';

const { app, dialog } = require('electron');

const config = require('./config');
const engine = require('./engine');
const log = require('./logger').scoped('watchdog');

/**
 * Присмотр за собственной работоспособностью.
 *
 * Движок умеет перезапускаться сам, но бывает и так, что процесс жив, а
 * отвечать перестал: видеокарта ушла в перезагрузку драйвера, модель
 * выгрузилась, порт занял кто-то другой. Снаружи это выглядит как
 * «нажимаю клавишу, ничего не происходит» — худший вид поломки, потому
 * что о ней никто не узнаёт.
 *
 * Поэтому раз в полминуты спрашиваем движок, жив ли он, и если он молчит
 * несколько раз подряд — поднимаем заново. Если и это не помогло,
 * говорим человеку прямо, а не молчим дальше.
 */

const CHECK_EVERY_MS = 30000;
const FAILURES_BEFORE_RESTART = 2;
// Столько же, сколько выдерживает сам движок при падениях: разные числа
// в двух местах приводили бы к тому, что одна защита сдаётся раньше другой.
const RESTARTS_BEFORE_GIVING_UP = 10;

let timer = null;
let failures = 0;
let restarts = 0;
let restarting = false;
let warned = false;

async function check() {
  if (restarting) return;

  // Движок и сам знает, что он не запустился, — тогда его лечит engine.js.
  if (engine.state === 'starting' || engine.state === 'stopped') return;

  try {
    await engine.health();
    if (failures) log.info('движок снова отвечает');
    failures = 0;
    restarts = 0;
    warned = false;
    return;
  } catch (error) {
    failures += 1;
    log.warn(`движок не ответил (${failures}): ${error.message}`);
  }

  if (failures < FAILURES_BEFORE_RESTART) return;

  if (restarts >= RESTARTS_BEFORE_GIVING_UP) {
    giveUp();
    return;
  }

  restarts += 1;
  failures = 0;
  restarting = true;
  log.warn(`поднимаю движок заново, попытка ${restarts}`);
  try {
    engine.stopping = false;
    await engine.stop();
    engine.stopping = false;
    engine.restarts = 0;
    await engine.start();
  } catch (error) {
    log.error(error);
  } finally {
    restarting = false;
  }
}

function giveUp() {
  if (warned) return;
  warned = true;
  log.error(`движок не отвечает после ${RESTARTS_BEFORE_GIVING_UP} перезапусков`);
  dialog.showMessageBox({
    type: 'error',
    title: 'PasteTalk',
    message: 'Движок распознавания не отвечает',
    detail: `${RESTARTS_BEFORE_GIVING_UP} попыток поднять его подряд не помогли. Диктовка сейчас не работает.\n\n`
      + 'Что обычно помогает: переключить вычисления на процессор в настройках, '
      + 'взять модель поменьше или перезапустить компьютер. Подробности — в журнале работы.',
    buttons: ['Открыть журнал', 'Закрыть'],
    defaultId: 0,
    noLink: true,
  }).then(({ response }) => {
    if (response === 0) require('electron').shell.openPath(require('./logger').logFile());
  }).catch(() => {});
}

function start() {
  stop();
  timer = setInterval(check, CHECK_EVERY_MS);
  log.info('присмотр за движком включён');
}

function stop() {
  clearInterval(timer);
  timer = null;
}

/**
 * Автозапуск вместе с Windows.
 *
 * Ключ реестра ставит сам Electron; наше дело — прописать флаг --tray,
 * чтобы при входе в систему не разворачивалось окно настроек, и не
 * трогать реестр в режиме разработки, где exe временный.
 */
// Под этим именем программа видна в списке автозагрузки Windows.
// Без него Electron подписывает запись идентификатором приложения —
// в диспетчере задач это выглядело как «ru.appswire.pastetalk».
const LOGIN_ITEM_NAME = 'PasteTalk';
const LEGACY_LOGIN_ITEM = 'ru.appswire.pastetalk';

function applyAutoLaunch(enabled) {
  if (!app.isPackaged) {
    log.info(`автозапуск: в разработке не трогаем (просили ${enabled ? 'включить' : 'выключить'})`);
    return;
  }

  // Убираем запись, оставшуюся от прежних версий, иначе в автозагрузке
  // окажутся две строки, ведущие в одно место.
  try {
    app.setLoginItemSettings({ openAtLogin: false, name: LEGACY_LOGIN_ITEM });
  } catch { /* её могло и не быть */ }

  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    name: LOGIN_ITEM_NAME,
    path: process.execPath,
    args: ['--tray'],
  });
  log.info(`автозапуск ${enabled ? 'включён' : 'выключен'}`);
}

/** Совпадает ли реальное состояние автозапуска с настройкой. */
function syncAutoLaunch() {
  const wanted = config.get('startup.autoLaunch', true);
  if (!app.isPackaged) return;
  const actual = app.getLoginItemSettings({
    name: LOGIN_ITEM_NAME,
    path: process.execPath,
    args: ['--tray'],
  }).openAtLogin;
  if (actual !== wanted) applyAutoLaunch(wanted);
}

module.exports = { start, stop, check, applyAutoLaunch, syncAutoLaunch };
