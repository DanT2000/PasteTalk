'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const windows = require('./windows');
const log = require('./logger').scoped('dev');

/**
 * Снимки окон для разработки.
 *
 * Обычный захват экрана здесь бесполезен: окна Electron рисует
 * видеокарта, и PrintWindow отдаёт чёрный прямоугольник. Само приложение
 * умеет снять свою страницу точно — этим и пользуемся.
 *
 * Поднимается только при запуске с --dev и слушает исключительно
 * localhost. В собранном приложении этого файла не касаемся.
 */

const PORT = 8477;

async function capture(query) {
  const name = query.get('window') || 'settings';
  const win = name === 'settings' ? windows.createSettings() : windows.windows[name];
  if (!win || win.isDestroyed()) throw new Error(`окна «${name}» нет`);

  if (query.has('scale') || query.has('theme')) {
    config.set({
      appearance: {
        ...(query.has('scale') ? { scale: Number(query.get('scale')) } : {}),
        ...(query.has('theme') ? { theme: query.get('theme') } : {}),
      },
    });
    windows.applyTheme();
    windows.broadcast('config:changed', config.all());
  }
  if (query.has('page')) win.webContents.send('settings:goto', query.get('page'));

  if (name === 'settings' && !win.isVisible()) win.showInactive();
  await new Promise((resolve) => setTimeout(resolve, Number(query.get('wait') || 700)));

  const image = await win.webContents.capturePage();
  return image.toPNG();
}

/**
 * Прогон записи с готового WAV вместо микрофона.
 *
 * Иначе проверить сквозной путь нечем: в тишине комнаты сработает защита
 * от пустой записи, а говорить в микрофон на автомате никто не будет.
 * Звук идёт ровно тем же путём, что и живой, — через recorder.pushAudio.
 */
async function feed(query) {
  const recorder = require('./recorder');
  const file = query.get('file');
  if (!file || !fs.existsSync(file)) throw new Error('нет такого файла');

  const raw = fs.readFileSync(file);
  // Разбираем WAV руками: заголовок у него простой, а тянуть библиотеку
  // ради одного отладочного маршрута незачем.
  const dataAt = raw.indexOf('data', 12, 'ascii');
  if (dataAt < 0) throw new Error('это не WAV');
  const channels = raw.readUInt16LE(22);
  const rate = raw.readUInt32LE(24);
  const bits = raw.readUInt16LE(34);
  if (bits !== 16) throw new Error('нужен WAV 16 бит');

  const samples = [];
  for (let offset = dataAt + 8; offset + channels * 2 <= raw.length; offset += channels * 2) {
    samples.push(raw.readInt16LE(offset));   // берём первый канал
  }

  // Пересчёт в 16 кГц ближайшим соседом: для проверки пути этого хватает.
  const ratio = rate / 16000;
  const target = Math.floor(samples.length / ratio);
  const pcm = Buffer.alloc(target * 2);
  for (let i = 0; i < target; i++) pcm.writeInt16LE(samples[Math.floor(i * ratio)] || 0, i * 2);

  windows.showCapsule();
  await recorder.start(query.get('mode') || 'plain');
  const chunk = 3200 * 2;   // 200 мс, как отдаёт настоящее окно записи
  for (let at = 0; at < pcm.length; at += chunk) {
    if (!query.has('fast')) await new Promise((r) => setTimeout(r, 200));
    await recorder.pushAudio(pcm.subarray(at, at + chunk), 0.3);
  }
  await recorder.finish('done');
  return { seconds: +(target / 16000).toFixed(2), state: recorder.state, text: recorder.lastText };
}

function start() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');

    if (url.pathname === '/eval') {
      // Выполнить выражение внутри окна: иначе про ошибки в отрисовщике
      // остаётся только гадать — консоль его никуда не выводится.
      const name = url.searchParams.get('window') || 'settings';
      const win = name === 'settings' ? windows.createSettings() : windows.windows[name];
      try {
        const value = await win.webContents.executeJavaScript(url.searchParams.get('js'), true);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(value ?? null, null, 1));
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(error.message));
      }
      return;
    }

    if (url.pathname === '/bench') {
      try {
        const result = await require('./engine').benchmark();
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(error.message));
      }
      return;
    }

    if (url.pathname === '/config') {
      // Правка настроек без окна — чтобы прогонять сценарии из скриптов.
      const patch = url.searchParams.get('patch');
      if (patch) {
        config.set(JSON.parse(patch));
        windows.broadcast('config:changed', config.all());
      }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(config.all(), null, 1));
      return;
    }

    if (url.pathname === '/feed') {
      try {
        const result = await feed(url.searchParams);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(result, null, 1));
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(error.message));
      }
      return;
    }

    if (url.pathname !== '/shot') {
      response.writeHead(404).end('нет такого адреса');
      return;
    }
    try {
      const png = await capture(url.searchParams);
      const target = url.searchParams.get('out');
      if (target) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, png);
      }
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      response.end(png);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(String(error.message));
    }
  });

  server.on('error', (error) => log.warn(`снимочный сервер не поднялся: ${error.message}`));
  server.listen(PORT, '127.0.0.1', () => log.info(`снимки: http://127.0.0.1:${PORT}/shot?window=settings&page=general`));
  return server;
}

module.exports = { start, PORT };
