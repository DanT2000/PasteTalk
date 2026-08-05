/**
 * Готовит окружение движка: изолированный Python 3.12 и зависимости.
 *
 * Системный Python не трогаем вовсе. uv скачивает нужную версию себе,
 * а всё остальное живёт в engine/.venv — эту папку можно удалить и
 * собрать заново одной командой.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findUv, UV_HELP } from './find-uv.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(root, 'engine');

const uv = findUv();
if (!uv) {
  console.error(UV_HELP);
  process.exit(1);
}

function run(args) {
  console.log(`> uv ${args.join(' ')}`);
  const result = spawnSync(uv, args, { stdio: 'inherit', cwd: engineDir });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['python', 'install', '3.12']);
if (!existsSync(path.join(engineDir, '.venv'))) run(['venv', '--python', '3.12', '.venv']);
run(['pip', 'install', '--python', '.venv/Scripts/python.exe',
  'faster-whisper>=1.1.0', 'numpy>=2.0', 'huggingface-hub>=0.26']);

console.log('\nОкружение движка готово. Запуск приложения:  npm start');
