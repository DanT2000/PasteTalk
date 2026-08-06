'use strict';

const { MODES, TAIL } = require('../../shared/modes');
const settings = require('./settings');

/**
 * Готовое указание модели для режима улучшения.
 *
 * Стандартные промпты живут в shared/modes.js, но владельцу нужно уметь
 * подправить их без пересборки — формулировка промпта и есть настройка.
 * Правленный текст хранится в настройках сервера (prompt.clean,
 * prompt.both); пустое значение означает «стандартный».
 *
 * Хвост про «верни только готовый текст» дописывается всегда: это не
 * часть смысла промпта, а защита от пояснений и кавычек в ответе, и
 * терять её при правке промпта было бы себе дороже.
 */
function instructionFor(mode) {
  const custom = String(settings.get(`prompt.${mode}`, '') || '').trim();
  const body = custom || MODES[mode] || MODES.clean;
  return `${body} ${TAIL}`;
}

module.exports = { instructionFor };
