'use strict';

const Fastify = require('fastify');

/**
 * Сборка сервера.
 *
 * build() отдаёт готовое приложение, ничего не слушая, — так его можно
 * прогонять тестами через inject, не занимая портов и не поднимая сети.
 */

function build(options = {}) {
  // Предел тела в 32 МБ: голосовое на двадцать минут в ogg весит около
  // десяти, и упереться в предел на длинной диктовке было бы обидно.
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024, ...options });

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
}

if (require.main === module) start();

module.exports = { build, start };
