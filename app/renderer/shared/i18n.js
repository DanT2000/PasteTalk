'use strict';

/**
 * Перевод окна на английский.
 *
 * Русский HTML — источник. При английской локали проходим по готовому
 * DOM и заменяем тексты по словарю «русская строка → английская».
 * Строки, собираемые в JS на лету, оборачиваются в t().
 *
 * Окно должно позвать window.applyLocale(payload) до показа содержимого;
 * payload приходит из главного процесса через мост (i18n.get()).
 */

(function initI18n() {
  let dict = {};
  let active = 'ru';

  function translate(text) {
    if (active !== 'en') return text;
    // Ключ — текст с нормализованными пробелами: в HTML внутри абзаца
    // живут переносы строк и отступы, и без нормализации ни один
    // многострочный текст не совпал бы со словарём.
    const key = text.replace(/\s+/g, ' ').trim();
    if (!key) return text;
    const found = dict[key];
    if (!found) return text;
    // Пробелы по краям сохраняем: в текстовых узлах они значимы.
    const lead = text.match(/^\s*/)[0];
    const tail = text.match(/\s*$/)[0];
    return lead + found + tail;
  }

  function walk(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      // Внутри script/style текст не трогаем.
      const parent = node.parentElement;
      if (!parent || parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') continue;
      const fresh = translate(node.nodeValue);
      if (fresh !== node.nodeValue) node.nodeValue = fresh;
    }
    for (const el of root.querySelectorAll('[placeholder], [title], [aria-label]')) {
      for (const attr of ['placeholder', 'title', 'aria-label']) {
        const value = el.getAttribute(attr);
        if (value) {
          const fresh = translate(value);
          if (fresh !== value) el.setAttribute(attr, fresh);
        }
      }
    }
  }

  /** Включить язык и перевести текущий DOM. */
  window.applyLocale = (payload) => {
    active = payload?.locale === 'en' ? 'en' : 'ru';
    dict = payload?.dict || {};
    if (active === 'en') walk(document.body);
  };

  /** Перевод для строк, собираемых в JS. */
  window.t = (text) => translate(String(text ?? ''));
})();
