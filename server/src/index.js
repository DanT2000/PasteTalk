'use strict';

const Fastify = require('fastify');

/**
 * Сборка сервера.
 *
 * build() отдаёт готовое приложение, ничего не слушая, — так его можно
 * прогонять тестами через inject, не занимая портов и не поднимая сети.
 */

function build(options = {}) {
  // Предел тела в 96 МБ. Считали по ogg из Telegram, где двадцать минут
  // весят около десяти, — но десктоп шлёт сырой WAV в base64, а это
  // 43 КБ в секунду: те же двадцать минут дают почти 50 МБ. Упереться в
  // предел на длинной диктовке нельзя: звук к тому времени уже стёрт.
  const app = Fastify({ logger: false, bodyLimit: 96 * 1024 * 1024, ...options });

  app.register(require('@fastify/websocket'));
  app.register(async (scope) => {
    require('./agent/socket').register(scope);
  });

  app.get('/health', async () => ({ ok: true }));
  require('./routes/client').register(app);
  require('./routes/admin').register(app);

  return app;
}

async function start() {
  const app = build();
  const port = Number(process.env.PORT || 3000);
  await app.listen({ port, host: '0.0.0.0' });
  process.stdout.write(`PasteTalk Server слушает порт ${port}\n`);

  // Бот поднимается, только если в админке задан токен. Пустой токен —
  // просто тишина, а не ошибка: боту тут быть необязательно.
  const bot = require('./bot/telegram');
  process.stdout.write(bot.sync() ? 'Telegram-бот опрашивает\n' : 'Telegram-бот выключен: токен не задан\n');
}

if (require.main === module) start();

module.exports = { build, start };
