'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const proxy = require('../proxy');

/**
 * Зеркало обновлений.
 *
 * Выпуски лежат на GitHub, но их файлы раздаёт CDN
 * (release-assets.githubusercontent.com), который у части провайдеров
 * заблокирован: проверка обновления проходит, а скачивание рвётся с
 * ERR_CONNECTION_CLOSED. Сервер забирает файлы через свой прокси (в
 * админке — «GitHub (зеркало обновлений)»), кладёт в кэш и раздаёт
 * приложению как обычный «generic»-фид electron-updater:
 *   /updates/latest.yml           — стабильный канал
 *   /updates/beta.yml             — бета-канал (последний выпуск, включая pre-release)
 *   /updates/PasteTalk-<v>-Setup.exe[.blockmap], PasteTalk-<v>-Portable.exe
 * Подпись sha512 в yml проверяет само приложение — подменить файл на
 * зеркале нельзя.
 */

const OWNER = 'DanT2000';
const REPO = 'PasteTalk';
const NAME = /^(latest\.yml|beta\.yml|PasteTalk-(\d+\.\d+\.\d+(?:-[\w.]+)?)-(Setup|Portable)\.exe(\.blockmap)?)$/;
const TAG_TTL_MS = 5 * 60 * 1000;
const PREFETCH_EVERY_MS = 30 * 60 * 1000;

const tagCache = new Map();          // channel → { tag, at }
const downloads = new Map();         // file path → Promise
let fetchImpl = (...args) => fetch(...args);

function cacheDir() {
  const db = process.env.PASTETALK_DB;
  return path.join(db ? path.dirname(db) : process.cwd(), 'updates');
}

function options(extra = {}) {
  return proxy.through('github', {
    headers: { 'User-Agent': 'PasteTalk-server', Accept: 'application/vnd.github+json', ...extra },
    redirect: 'follow',
  });
}

async function ghJson(url) {
  const response = await fetchImpl(url, options());
  if (!response.ok) throw new Error(`GitHub ответил ${response.status}`);
  return response.json();
}

/** Тег последнего выпуска канала; ответ помним пять минут. */
async function latestTag(channel) {
  const hit = tagCache.get(channel);
  if (hit && Date.now() - hit.at < TAG_TTL_MS) return hit.tag;
  let tag;
  if (channel === 'beta') {
    const list = await ghJson(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=10`);
    const found = (Array.isArray(list) ? list : []).find((item) => !item.draft);
    if (!found) throw new Error('Выпусков пока нет');
    tag = found.tag_name;
  } else {
    const release = await ghJson(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`);
    tag = release.tag_name;
  }
  if (!/^v?\d+\.\d+\.\d+/.test(String(tag || ''))) throw new Error('GitHub вернул непонятный тег');
  tagCache.set(channel, { tag, at: Date.now() });
  return tag;
}

/** Файл выпуска в кэше; нет — скачать через прокси. Один файл — одна закачка. */
function fetchAsset(tag, name) {
  const target = path.join(cacheDir(), tag, name);
  if (fs.existsSync(target)) return Promise.resolve(target);
  if (downloads.has(target)) return downloads.get(target);
  const job = (async () => {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const url = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${name}`;
    const response = await fetchImpl(url, options({ Accept: 'application/octet-stream' }));
    if (!response.ok || !response.body) throw new Error(`GitHub не отдал ${name}: ${response.status}`);
    const temp = `${target}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp));
      await fsp.rename(temp, target);
    } catch (error) {
      await fsp.rm(temp, { force: true });
      throw error;
    }
    return target;
  })().finally(() => downloads.delete(target));
  downloads.set(target, job);
  return job;
}

/** Все файлы выпуска — впрок, чтобы приложение не ждало нашу закачку. */
async function prefetch(tag) {
  const release = await ghJson(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${tag}`);
  const names = (release.assets || []).map((asset) => asset.name).filter((name) => NAME.test(name));
  for (const name of names) {
    try {
      await fetchAsset(tag, name);
    } catch (error) {
      process.stderr.write(`зеркало обновлений: ${tag}/${name} — ${error.message}\n`);
    }
  }
}

/** Держим только выпуски двух каналов; остальное — на диск не резиновый. */
async function sweep(keep) {
  const root = cacheDir();
  let entries = [];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!keep.includes(entry)) await fsp.rm(path.join(root, entry), { recursive: true, force: true }).catch(() => {});
  }
}

async function warm() {
  if (!proxy.usedFor('github')) return;   // без прокси зеркало бессмысленно
  const tags = [];
  for (const channel of ['stable', 'beta']) {
    try {
      tags.push(await latestTag(channel));
    } catch (error) {
      process.stderr.write(`зеркало обновлений: канал ${channel} — ${error.message}\n`);
    }
  }
  for (const tag of new Set(tags)) await prefetch(tag);
  if (tags.length) await sweep([...new Set(tags)]);
}

function contentType(name) {
  return name.endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream';
}

/** Отдать файл из кэша с поддержкой Range — electron-updater качает кусками. */
async function serve(request, reply, file, name) {
  const stat = await fsp.stat(file);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', contentType(name));
  reply.header('Cache-Control', name.endsWith('.yml') ? 'no-cache' : 'public, max-age=86400');
  const range = String(request.headers.range || '');
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (match && (match[1] || match[2])) {
    let start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
    let end = match[1] && match[2] ? Number(match[2]) : stat.size - 1;
    if (start > end || start >= stat.size) {
      reply.code(416).header('Content-Range', `bytes */${stat.size}`);
      return reply.send('');
    }
    end = Math.min(end, stat.size - 1);
    reply.code(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    reply.header('Content-Length', String(end - start + 1));
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  // HEAD Fastify обслуживает этим же обработчиком: тело отбрасывает,
  // заголовки (в том числе Content-Length) оставляет.
  reply.header('Content-Length', String(stat.size));
  return reply.send(fs.createReadStream(file));
}

function register(app) {
  const handler = async (request, reply) => {
    const name = String(request.params.file || '');
    const parsed = NAME.exec(name);
    if (!parsed) return reply.code(404).send({ error: 'Нет такого файла' });
    try {
      let tag;
      let asset = name;
      if (name.endsWith('.yml')) {
        tag = await latestTag(name === 'beta.yml' ? 'beta' : 'stable');
        asset = 'latest.yml';
        // Раз спросили фид — скоро попросят и установщик: греем впрок.
        prefetch(tag).catch(() => {});
      } else {
        tag = `v${parsed[2]}`;
      }
      const file = await fetchAsset(tag, asset);
      return await serve(request, reply, file, name);
    } catch (error) {
      request.log.warn(`зеркало обновлений: ${name} — ${error.message}`);
      return reply.code(502).send({ error: `Зеркало не достало файл: ${error.message}` });
    }
  };
  // HEAD Fastify добавляет к GET сам (exposeHeadRoutes).
  app.get('/updates/:file', handler);

  // Прогрев при старте и по расписанию: приложение не должно ждать нашу
  // закачку, а на диске лежат только два последних выпуска.
  if (process.env.NODE_ENV !== 'test') {
    setTimeout(() => warm().catch(() => {}), 15 * 1000);
    setInterval(() => warm().catch(() => {}), PREFETCH_EVERY_MS).unref();
  }
}

module.exports = {
  register, NAME, latestTag, fetchAsset, warm, cacheDir,
  // Для тестов: подменить сеть и сбросить кэш тегов.
  _setFetch(fn) { fetchImpl = fn; },
  _resetTags() { tagCache.clear(); },
};
