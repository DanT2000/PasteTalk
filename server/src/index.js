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

  const auth = require('./admin/auth');
  auth.resetIfAsked();
  if (!auth.changed()) {
    process.stdout.write(
      '\n  ПАНЕЛЬ ЕЩЁ НЕ ЗАНЯТА. Откройте /admin/ и придумайте пароль —\n'
      + '  пока этого не сделано, это может сделать любой, кто знает адрес.\n\n',
    );
  }

  // Бот поднимается, только если в админке задан токен. Пустой токен —
  // просто тишина, а не ошибка: боту тут быть необязательно.
  const bot = require('./bot/telegram');
  process.stdout.write(bot.sync() ? 'Telegram-бот опрашивает\n' : 'Telegram-бот выключен: токен не задан\n');
}

// Необработанная ошибка в обработчике сокета не должна класть сервер:
// агент переподключается каждые две секунды и уронил бы его насмерть.
process.on('uncaughtException', (error) => {
  process.stderr.write(`Сбой, но продолжаем: ${error.stack || error.message}
`);
});
process.on('unhandledRejection', (error) => {
  process.stderr.write(`Обещание отвергнуто: ${error?.stack || error}
`);
});

if (require.main === module) start();

module.exports = { build, start };
