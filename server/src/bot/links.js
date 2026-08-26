'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const proxy = require('../proxy');

/**
 * Ссылки в боте: VK Видео и стена ВКонтакте, YouTube, Rutube.
 *
 * Запись скачивается на сервере (yt-dlp + ffmpeg), ужимается в mp3 под
 * речь и уходит в распознавание как обычное аудио. Так обходится и
 * предел Telegram в 20 МБ на файл: с сервера забирается и часовой ролик.
 *
 * Список сайтов закрытый нарочно: yt-dlp умеет тысячи, но давать боту
 * качать что угодно по любому адресу — значит подставлять сервер.
 */

const HOSTS = [
  /(^|\.)vk\.com$/, /(^|\.)vk\.ru$/, /(^|\.)vkvideo\.ru$/, /(^|\.)vkontakte\.ru$/,
  /(^|\.)youtube\.com$/, /^youtu\.be$/,
  /(^|\.)rutube\.ru$/,
];

// Два часа: при 24 кбит/с моно это ~21 МБ — влезает в предел облачных
// распознавателей (25 МБ), а длиннее лекций людям и не присылают.
const MAX_SECONDS = 2 * 60 * 60;
const YTDLP = process.env.PASTETALK_YTDLP || 'yt-dlp';
const PROBE_TIMEOUT_MS = 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;

function supported(raw) {
  try {
    const parsed = new URL(raw);
    return /^https?:$/.test(parsed.protocol) && HOSTS.some((host) => host.test(parsed.hostname.toLowerCase()));
  } catch {
    return false;
  }
}

/** Все ссылки сообщения: из разметки Telegram и просто из текста. */
function urlsOf(message) {
  const text = String((message && (message.text || message.caption)) || '');
  const found = [];
  const entities = [...((message && message.entities) || []), ...((message && message.caption_entities) || [])];
  for (const entity of entities) {
    if (entity.type === 'text_link' && entity.url) found.push(entity.url);
    // Смещения Telegram считает в UTF-16, как и slice в JS.
    if (entity.type === 'url') found.push(text.slice(entity.offset, entity.offset + entity.length));
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>()]+/g)) found.push(match[0]);
  // Точка или скобка в конце — от предложения, а не от адреса.
  return found.map((url) => url.replace(/[.,;:!?»)\]]+$/, '')).filter(Boolean);
}

/**
 * Первая ссылка сообщения.
 *   { url }                    — наша, можно качать;
 *   { url, unsupported: true } — есть ссылка, но сайт не из списка;
 *   null                       — ссылок нет.
 */
function find(message) {
  const all = urlsOf(message);
  if (!all.length) return null;
  const ours = all.find(supported);
  if (ours) return { url: ours };
  return { url: all[0], unsupported: true };
}

/** Прокси — только если владелец включил его для ссылок в админке. */
function proxyArgs() {
  return proxy.usedFor('links') ? ['--proxy', proxy.url()] : [];
}

/** Из простыни stderr — одна понятная человеку причина. */
function friendly(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = [...lines].reverse().find((line) => /^ERROR/i.test(line)) || lines[lines.length - 1] || '';
  if (/Unsupported URL/i.test(last)) return 'по этой ссылке нет видео или записи';
  if (/private|login|registered users|sign in|cookies|authorization/i.test(last)) return 'запись закрытая — видна только после входа';
  if (/404|not found|does not exist|removed|deleted|unavailable/i.test(last)) return 'запись не найдена или удалена';
  if (/geo|country|blocked in/i.test(last)) return 'запись недоступна из страны сервера';
  return last.replace(/^ERROR:\s*(\[[^\]]*\]\s*\S*:\s*)?/i, '').slice(0, 200) || 'загрузчик не справился';
}

function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(YTDLP, args, { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('скачивание не уложилось в отведённое время'));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' ? new Error('на сервере не установлен yt-dlp') : error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(friendly(err)));
    });
  });
}

/** Что по ссылке: название, длительность, не эфир ли. Ничего не качает. */
async function probe(url) {
  const out = await run(['-j', '--no-playlist', '--no-warnings', '--skip-download', ...proxyArgs(), url], PROBE_TIMEOUT_MS);
  const line = out.trim().split(/\r?\n/).find(Boolean);
  if (!line) throw new Error('по этой ссылке нет видео или записи');
  let info;
  try {
    info = JSON.parse(line);
  } catch {
    throw new Error('загрузчик ответил непонятно');
  }
  return {
    title: String(info.title || ''),
    seconds: Math.round(Number(info.duration) || 0),
    live: Boolean(info.is_live),
  };
}

/**
 * Скачать звук по ссылке. Возвращает { audio, filename, seconds, title }.
 * Слишком длинная запись — ошибка с code = 'tooLong' и seconds: бот
 * скажет человеку и цифру, и предел.
 */
async function download(url, { maxSeconds = MAX_SECONDS } = {}) {
  const info = await probe(url);
  if (info.live) throw new Error('это прямой эфир — дождитесь записи');
  if (info.seconds > maxSeconds) {
    const error = new Error('слишком длинная запись');
    error.code = 'tooLong';
    error.seconds = info.seconds;
    throw error;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pastetalk-link-'));
  try {
    await run([
      '--no-playlist', '--no-warnings', '--no-progress',
      '-f', 'bestaudio/best',
      '-x', '--audio-format', 'mp3',
      // Моно, 16 кГц, 24 кбит/с: распознавателю больше не нужно, а файл
      // выходит вчетверо легче, чем «как было». Битрейт — через
      // --audio-quality: свой -b:a yt-dlp перебивает переменным качеством.
      '--audio-quality', '24K',
      '--postprocessor-args', 'ExtractAudio:-ac 1 -ar 16000',
      '-o', path.join(dir, 'audio.%(ext)s'),
      ...proxyArgs(),
      url,
    ], DOWNLOAD_TIMEOUT_MS);
    const audio = await fs.readFile(path.join(dir, 'audio.mp3'));
    return { audio, filename: 'link.mp3', seconds: info.seconds, title: info.title };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { find, supported, probe, download, MAX_SECONDS };
