'use strict';

const https = require('node:https');
const { app } = require('electron');

const config = require('./config');
const log = require('./logger').scoped('updates');

/**
 * Обновления через GitHub.
 *
 * Проверка сама по себе ничего не ставит: спрашивает последний выпуск
 * и показывает диалог. Скачивание и установка — downloadAndInstall() —
 * запускаются только после явного «Обновить сейчас»: программа висит в
 * трее и слушает клавиатуру, обновляться за спиной у человека ей нельзя.
 */

const OWNER = 'DanT2000';
const REPO = 'PasteTalk';

/** «2.0.10» новее «2.0.9»: сравниваем числами, а не строками. */
function compare(a, b) {
  const parse = (value) => String(value).replace(/^v/i, '').split(/[.\-+]/).map((part) => parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function request(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        // GitHub отказывает запросам без представления.
        'User-Agent': `PasteTalk/${app.getVersion()}`,
        Accept: 'application/vnd.github+json',
      },
    }, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        response.resume();
        request(response.headers.location).then(resolve, reject);
        return;
      }
      const parts = [];
      response.on('data', (part) => parts.push(part));
      response.on('end', () => {
        const body = Buffer.concat(parts).toString('utf8');
        if (response.statusCode === 404) { reject(new Error('Выпусков пока нет')); return; }
        if (response.statusCode >= 400) { reject(new Error(`GitHub ответил ${response.statusCode}`)); return; }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('GitHub ответил не JSON'));
        }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('GitHub не ответил вовремя')));
    req.on('error', (error) => reject(new Error(
      error.code === 'ENOTFOUND' ? 'Нет связи с интернетом' : error.message)));
  });
}

async function check() {
  const current = app.getVersion();
  try {
    const release = await request(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`);
    const latest = String(release.tag_name || '').replace(/^v/i, '');
    const installer = (release.assets || []).find((asset) => /Setup\.exe$/i.test(asset.name));
    const newer = latest && compare(latest, current) > 0;
    log.info(`проверка обновлений: у вас ${current}, на GitHub ${latest || '—'}`);
    return {
      ok: true,
      current,
      latest,
      newer,
      // Решение «показывать ли» принимается здесь, а не в каждом окне:
      // «больше не напоминать» должно работать одинаково везде.
      notify: Boolean(newer && latest !== config.get('updates.skipVersion', '')),
      name: release.name || '',
      notes: String(release.body || '').slice(0, 2000),
      url: release.html_url,
      download: installer ? installer.browser_download_url : release.html_url,
      sizeMb: installer ? Math.round(installer.size / 1048576) : 0,
      publishedAt: release.published_at || '',
    };
  } catch (error) {
    log.warn(`проверка обновлений не удалась: ${error.message}`);
    return { ok: false, current, error: error.message };
  }
}

/**
 * Тихая проверка при запуске.
 *
 * Ничего не скачивает и не ставит — только показывает уведомление, если
 * вышла версия новее. Программа висит в трее и слушает клавиатуру;
 * такому лучше не обновляться самому за спиной у человека.
 *
 * Спрашиваем не чаще раза в сутки и не на первой секунде после старта:
 * сразу после входа в Windows компьютеру есть чем заняться и без нас.
 */
const ASK_EVERY_MS = 24 * 60 * 60 * 1000;
const DELAY_AFTER_START_MS = 45000;

// Последний тихий ответ: окно настроек открывают часто, а спрашивать
// GitHub чаще раза в сутки незачем — и лимит запросов у него общий.
let quietAnswer = null;

async function quietCheck() {
  const lastAsked = Number(config.get('updates.lastCheckedAt', 0)) || 0;
  if (quietAnswer && Date.now() - lastAsked < ASK_EVERY_MS) return quietAnswer;
  const answer = await check();
  if (answer.ok) {
    config.set({ updates: { lastCheckedAt: Date.now() } });
    quietAnswer = answer;
  }
  return answer;
}

function scheduleStartupCheck(onFound) {
  setTimeout(async () => {
    const lastAsked = Number(config.get('updates.lastCheckedAt', 0)) || 0;
    if (Date.now() - lastAsked < ASK_EVERY_MS) return;

    const answer = await quietCheck();
    if (answer.ok && answer.notify) onFound(answer);
  }, DELAY_AFTER_START_MS);
}

/**
 * Скачать и поставить обновление, не гоняя человека по сайтам.
 *
 * electron-updater берёт установщик из того же выпуска GitHub (рядом с
 * ним лежит latest.yml), ставит его тихо и перезапускает программу.
 * Работает только в собранном приложении: в разработке файла
 * app-update.yml нет, и вызов честно упадёт — наверху для этого есть
 * запасной путь со ссылкой на страницу загрузки.
 */
let updaterWired = false;

async function downloadAndInstall(onProgress) {
  const { autoUpdater } = require('electron-updater');
  if (!updaterWired) {
    updaterWired = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = null;
    autoUpdater.on('download-progress', (progress) => {
      try { module.exports.onProgress?.(progress.percent); } catch { /* прогресс не главное */ }
    });
  }
  module.exports.onProgress = onProgress;

  const found = await autoUpdater.checkForUpdates();
  const version = found?.updateInfo?.version || '';
  if (!version || compare(version, app.getVersion()) <= 0) {
    throw new Error('Обновление не нашлось');
  }
  log.info(`скачиваю обновление ${version}`);
  await autoUpdater.downloadUpdate();
  log.info('обновление скачано — ставлю и перезапускаюсь');
  // Тихая установка и запуск свежей версии: человеку не нужно
  // прокликивать установщик, который он уже прокликивал при первой
  // установке. Настройки и модели переезжают сами.
  autoUpdater.quitAndInstall(true, true);
}

module.exports = { check, compare, quietCheck, scheduleStartupCheck, downloadAndInstall };
