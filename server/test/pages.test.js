'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

/**
 * Страницы админки и витрины несут код прямо внутри себя, и Node его не
 * проверяет — а браузер, споткнувшись, молча перестаёт слушать кнопки.
 * Трижды подряд страница ложилась от переноса строки внутри кавычек, и
 * узнавалось это только от человека, у которого «кнопка не работает».
 */
const PAGES = path.join(__dirname, '..', 'src', 'admin', 'pages');

for (const name of fs.readdirSync(PAGES).filter((f) => f.endsWith('.html'))) {
  test(`код внутри ${name} разбирается`, () => {
    const html = fs.readFileSync(path.join(PAGES, name), 'utf8');
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

    scripts.forEach((code, index) => {
      const temp = path.join(os.tmpdir(), `pastetalk-page-${Date.now()}-${index}.js`);
      fs.writeFileSync(temp, code, 'utf8');
      try {
        execFileSync(process.execPath, ['--check', temp], { stdio: 'pipe' });
      } catch (error) {
        assert.fail(`${name}, скрипт ${index + 1}: ${String(error.stderr).slice(0, 300)}`);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    });
  });
}
