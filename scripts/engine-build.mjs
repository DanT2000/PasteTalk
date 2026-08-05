/**
 * Собирает движок распознавания в один exe.
 *
 * PyInstaller кладёт рядом Python, ctranslate2 и всё остальное, чтобы у
 * человека на компьютере не было ни Python, ни pip — поставил программу
 * и работает.
 *
 * Модели сюда не попадают намеренно: large-v3 весит три гигабайта и
 * качается один раз при первом запуске. Установщик на 3 ГБ никто
 * скачивать не станет.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findUv } from './find-uv.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(root, 'engine');
const venvPython = path.join(engineDir, '.venv', 'Scripts', 'python.exe');
const outDir = path.join(root, 'build', 'engine');

function run(command, args, options = {}) {
  console.log(`> ${path.basename(command)} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: engineDir, ...options });
  if (result.status !== 0) {
    throw new Error(`команда завершилась с кодом ${result.status}`);
  }
}

if (!existsSync(venvPython)) {
  console.error('Не найдено окружение движка. Сначала: npm run engine:setup');
  process.exit(1);
}

// В окружениях, созданных uv, pip не ставится вовсе — пакеты кладёт сам uv.
console.log('Ставлю PyInstaller…');
const uv = findUv();
if (uv) run(uv, ['pip', 'install', '--python', venvPython, 'pyinstaller>=6.11']);
else run(venvPython, ['-m', 'pip', 'install', '--quiet', 'pyinstaller>=6.11']);

console.log('Собираю pastetalk-engine.exe…');
rmSync(path.join(engineDir, 'build'), { recursive: true, force: true });
rmSync(path.join(engineDir, 'dist'), { recursive: true, force: true });

run(venvPython, [
  '-m', 'PyInstaller',
  '--noconfirm',
  '--clean',
  '--name', 'pastetalk-engine',
  // Папкой, а не одним файлом: onefile распаковывает себя во временный
  // каталог при каждом запуске, а это сотни мегабайт и лишние секунды.
  '--onedir',
  '--console',
  // ctranslate2 и tokenizers тянут за собой бинарники, которые
  // PyInstaller сам не находит.
  '--collect-all', 'ctranslate2',
  '--collect-all', 'tokenizers',
  '--collect-all', 'faster_whisper',
  '--hidden-import', 'huggingface_hub',
  path.join(engineDir, 'run_engine.py'),
]);

const built = path.join(engineDir, 'dist', 'pastetalk-engine');
if (!existsSync(built)) throw new Error('PyInstaller ничего не собрал');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(built, outDir, { recursive: true });

const files = readdirSync(outDir).length;
console.log(`Готово: ${outDir} (${files} элементов верхнего уровня)`);
