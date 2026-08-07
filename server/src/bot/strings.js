'use strict';

/**
 * Все реплики бота в одном месте, на двух языках.
 *
 * Русский — исходный, английский — для всех остальных. Язык выбирается
 * по language_code пользователя Telegram: начинается с «ru» — русский,
 * любой другой (или его отсутствие) — английский.
 */

const STRINGS = {
  needCode: {
    ru: 'Нужен код доступа. Попросите его у владельца и пришлите сюда шесть цифр.',
    en: 'You need an access code. Ask the owner for one and send the six digits here.',
  },
  linked: {
    ru: 'Готово, вы привязаны. Присылайте голосовое.',
    en: "Done — you're linked. Send a voice message.",
  },
  tooLong: {
    ru: 'Слишком длинная запись. Предел — {minutes} минут.',
    en: 'That recording is too long. The limit is {minutes} minutes.',
  },
  transcribing: {
    ru: 'Распознаю…',
    en: 'Transcribing…',
  },
  downloadFailed: {
    ru: 'Не удалось забрать запись: {message}',
    en: "Couldn't fetch the recording: {message}",
  },
  silence: {
    ru: 'Тишина — ничего не разобрал.',
    en: "Silence — couldn't make out a word.",
  },
  cleaning: {
    ru: 'Чищу…',
    en: 'Cleaning up…',
  },
  rewriting: {
    ru: 'Переписываю…',
    en: 'Rewriting…',
  },
  improveFailed: {
    ru: 'Причесать не вышло: {message}',
    en: "Couldn't polish it: {message}",
  },
  accepted: {
    ru: 'Взял в работу',
    en: 'On it',
  },
  revoked: {
    ru: 'Доступ отозван',
    en: 'Access revoked',
  },
  yourId: {
    ru: 'Ваш номер в Telegram: {id}',
    en: 'Your Telegram ID: {id}',
  },
  start: {
    ru: 'Присылайте голосовое — верну текстом. Под текстом будут кнопки, чтобы его причесать.',
    en: "Send a voice message and I'll reply with the text. The buttons under it will polish it.",
  },
  buttonClean: {
    ru: 'Почистить',
    en: 'Clean up',
  },
  buttonBoth: {
    ru: 'Почистить и переписать',
    en: 'Clean up and rewrite',
  },
};

/** Язык по пользователю Telegram: «ru*» — русский, всё прочее — английский. */
function langOf(from) {
  const code = String((from && from.language_code) || '').toLowerCase();
  return code.startsWith('ru') ? 'ru' : 'en';
}

/** Реплика на нужном языке; {имя} в шаблоне подменяется значением из params. */
function text(lang, key, params) {
  const entry = STRINGS[key];
  if (!entry) throw new Error(`Нет строки с ключом ${key}`);
  const template = entry[lang === 'ru' ? 'ru' : 'en'];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) => (
    name in params ? String(params[name]) : whole
  ));
}

function firstNumber(message) {
  const found = String(message).match(/\d+/);
  return found ? found[0] : '';
}

// keys.activate бросает ошибки русскими строками. Известные узнаём по
// включению подстроки и переводим; числа (минуты, предел устройств)
// переносим из исходного сообщения. Незнакомую ошибку отдаём как есть:
// лучше русская правда, чем английская догадка.
const ACTIVATE_ERRORS = [
  {
    part: 'Такого кода нет',
    en: () => "There's no such code",
  },
  {
    part: 'Код устарел',
    en: () => 'That code has expired. Ask for a new one',
  },
  {
    part: 'Слишком много попыток',
    en: (message) => `Too many attempts. Wait ${firstNumber(message) || 'a few'} min.`,
  },
  {
    part: 'устройств на этот код не привязать',
    en: (message) => `This code can't take more than ${firstNumber(message)} devices`,
  },
];

/** Перевод ошибки привязки: для русского — как пришла, для английского — по словарю. */
function activateError(lang, message) {
  if (lang === 'ru') return message;
  const known = ACTIVATE_ERRORS.find((entry) => String(message).includes(entry.part));
  return known ? known.en(message) : message;
}

module.exports = { STRINGS, langOf, text, activateError };
