/**
 * Найти uv, чем бы его ни ставили.
 *
 * winget кладёт uv.exe вглубь своей папки Packages и добавляет путь в
 * PATH — но уже открытые терминалы об этом не знают. Поэтому не
 * полагаемся на PATH, а смотрим и в известные места установки.
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

function works(candidate) {
  try {
    execSync(`"${candidate}" --version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function findUv() {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    'uv',
    path.join(local, 'Microsoft', 'WinGet', 'Links', 'uv.exe'),
    path.join(process.env.USERPROFILE || '', '.local', 'bin', 'uv.exe'),
    path.join(process.env.USERPROFILE || '', '.cargo', 'bin', 'uv.exe'),
  ];

  const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  if (existsSync(packages)) {
    for (const entry of readdirSync(packages)) {
      if (entry.toLowerCase().startsWith('astral-sh.uv')) {
        candidates.push(path.join(packages, entry, 'uv.exe'));
      }
    }
  }

  return candidates.find(works) || null;
}

export const UV_HELP = [
  'Нужен uv — он поставит Python 3.12 в отдельную папку, не трогая системный.',
  'Установить:  winget install astral-sh.uv',
  'или:         powershell -c "irm https://astral.sh/uv/install.ps1 | iex"',
  'После установки откройте новое окно терминала.',
].join('\n');
