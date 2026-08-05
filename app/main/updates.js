'use strict';

const https = require('node:https');
const { app } = require('electron');

const log = require('./logger').scoped('updates');

/**
 * Проверка обновлений через GitHub.
 *
 * Ничего не скачивает и не ставит само: спрашивает у GitHub последний
 * выпуск и, если он новее, показывает кнопку со ссылкой. Установщик
 * человек запускает сам — тихое самообновление в программе, которая
 * висит в трее и слушает клавиатуру, доверия не прибавляет.
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

function scheduleStartupCheck(onFound) {
  const config = require('./config');

  setTimeout(async () => {
    const lastAsked = Number(config.get('updates.lastCheckedAt', 0)) || 0;
    if (Date.now() - lastAsked < ASK_EVERY_MS) return;

    const answer = await check();
    if (!answer.ok) return;
    config.set({ updates: { lastCheckedAt: Date.now() } });

    if (answer.newer && answer.latest !== config.get('updates.skipVersion', '')) {
      onFound(answer);
    }
  }, DELAY_AFTER_START_MS);
}

module.exports = { check, compare, scheduleStartupCheck };
