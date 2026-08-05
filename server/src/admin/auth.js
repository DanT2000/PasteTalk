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

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function changed() {
  return Boolean(settings.get('admin.password', null));
}

function change(next) {
  const password = String(next || '').trim();
  // Про admin говорим раньше, чем про длину: человек, вписавший его
  // второй раз, должен услышать настоящую причину отказа, а не то, что
  // слово короткое — иначе он допишет три знака и решит, что всё хорошо.
  if (password === DEFAULT) throw new Error('Этот пароль и так знают все');
  if (password.length < MIN_LENGTH) throw new Error(`Пароль короче ${MIN_LENGTH} знаков`);
  const salt = crypto.randomBytes(16).toString('hex');
  settings.set('admin.password', `${salt}:${hash(password, salt)}`);
}

function check(password) {
  const saved = settings.get('admin.password', null);
  if (!saved) return String(password) === DEFAULT;
  const [salt, digest] = String(saved).split(':');
  const given = Buffer.from(hash(String(password), salt), 'hex');
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

function allowed(password, address) {
  if (!check(password)) return { ok: false, mustChange: false, error: 'Пароль не подходит' };
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

module.exports = { check, changed, change, isLocal, allowed, DEFAULT, MIN_LENGTH };
