/**
 * Запуск приложения в разработке.
 *
 * Отдельный запускатор нужен из-за одной переменной: терминалы VS Code
 * выставляют ELECTRON_RUN_AS_NODE=1, и тогда electron.exe ведёт себя как
 * обычный Node — require('electron') отдаёт строку с путём вместо модуля,
 * а приложение падает на первой же строке. Чистим окружение и запускаем.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
