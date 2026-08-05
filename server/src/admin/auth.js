'use strict';

const crypto = require('node:crypto');

const settings = require('../settings');

/**
 * Вход в админку.
 *
 * Пароль по умолчанию admin — так попросил владелец. Но панель висит на
 * публичном адресе и держит токен бота, ключи провайдеров и выдачу
 * доступов, а зайти владелец может и через неделю после запуска.
 * Поэтому до первой смены пароль admin принимается только из домашней
 * сети: окно, в котором пароль знают все, закрыто снаружи.
 */

const DEFAULT = 'admin';
const MIN_LENGTH = 8;

/**
 * scrypt намеренно медленный — в этом его смысл. Но синхронный вызов
 * занимает весь цикл событий: десяток запросов подряд, и сервер перестаёт
 * отвечать всем — висят диктовки, опрос бота, пинги агента. Поэтому здесь
 * только асинхронная форма.
 */
function hash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString('hex'));
    });
  });
}

function changed() {
  return Boolean(settings.get('admin.password', null));
}

async function change(next) {
  const password = String(next || '').trim();
  // Про admin говорим раньше, чем про длину: человек, вписавший его
  // второй раз, должен услышать настоящую причину отказа, а не то, что
  // слово короткое — иначе он допишет три знака и решит, что всё хорошо.
  if (password === DEFAULT) throw new Error('Этот пароль и так знают все');
  if (password.length < MIN_LENGTH) throw new Error(`Пароль короче ${MIN_LENGTH} знаков`);
  const salt = crypto.randomBytes(16).toString('hex');
  settings.set('admin.password', `${salt}:${await hash(password, salt)}`);
}

async function check(password) {
  const saved = settings.get('admin.password', null);
  if (!saved) return String(password) === DEFAULT;
  const [salt, digest] = String(saved).split(':');
  const given = Buffer.from(await hash(String(password), salt), 'hex');
  const known = Buffer.from(digest, 'hex');
  // timingSafeEqual: сравнение по времени не должно подсказывать, сколько
  // знаков угадано. Длины сверяем заранее — иначе он бросит исключение.
  return given.length === known.length && crypto.timingSafeEqual(given, known);
}

function isLocal(address) {
  const ip = String(address || '').replace(/^::ffff:/, '');
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  // 172.16.0.0 — 172.31.255.255. Соседние 172.15 и 172.32 уже чужие.
  const match = /^172\.(\d+)\./.exec(ip);
  if (match) {
    const second = Number(match[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

/**
 * Промахи по паролю панели считаем так же, как по кодам доступа: без
 * этого пароль перебирается без всяких ограничений.
 */
const misses = new Map();
const MAX_TRIES = 5;
const PAUSE_MS = 10 * 60 * 1000;

function forgetMisses() {
  misses.clear();
}

async function allowed(password, address) {
  const now = Date.now();
  // Попытку засчитываем ДО проверки: scrypt асинхронный, и полсотни
  // одновременных запросов иначе проскочили бы гейт все разом, до того
  // как хоть один промах успел записаться.
  const state = misses.get(address) || { count: 0, until: 0 };
  state.count += 1;
  if (state.count > MAX_TRIES) state.until = now + PAUSE_MS;
  misses.set(address, state);

  if (state.until > now) {
    return {
      ok: false,
      mustChange: false,
      error: `Слишком много попыток. Подождите ${Math.ceil((state.until - now) / 60000)} мин.`,
    };
  }

  if (!await check(password)) {
    return { ok: false, mustChange: false, error: 'Пароль не подходит' };
  }
  misses.delete(address);
  if (changed()) return { ok: true, mustChange: false };
  if (!isLocal(address)) {
    return {
      ok: false,
      mustChange: true,
      error: 'Пароль ещё не менялся — первый вход возможен только из локальной сети',
    };
  }
  return { ok: true, mustChange: true };
}

module.exports = {
  check, changed, change, isLocal, allowed, forgetMisses,
  DEFAULT, MIN_LENGTH, MAX_TRIES,
};
