/**
 * Прогон провайдеров улучшения текста через настоящий модуль приложения.
 * Запуск: node scripts/dev.mjs --run-llm-test  →  см. package.json
 *   или:  node_modules/electron/dist/electron.exe scripts/test-llm.js
 *
 * Ключи не хардкодим: берём из переменных окружения, чтобы этот файл
 * можно было спокойно положить в репозиторий.
 */

const { app } = require('electron');
const llm = require('../app/main/llm');

const SAMPLE = 'Ну слушай, короче, я вот что хотел сказать: встреча вроде как переносится '
  + 'на пятницу, ну то есть на послезавтра, потому что там как бы не все смогут в среду.';

async function run(title, overrides) {
  process.stdout.write(`\n── ${title}\n`);
  const started = Date.now();
  try {
    const text = await llm.improve(SAMPLE, overrides);
    console.log(`   ok за ${Date.now() - started} мс`);
    console.log(`   ${text}`);
    return true;
  } catch (error) {
    console.log(`   не вышло за ${Date.now() - started} мс: ${error.message}`);
    return false;
  }
}

app.whenReady().then(async () => {
  console.log('Что нашлось на этой машине:');
  for (const item of await llm.detect()) {
    console.log(`   ${item.available ? '✓' : '·'} ${item.title}`
      + (item.models?.length ? ` — моделей: ${item.models.length}` : ''));
  }

  const lm = await llm.models({ provider: 'lmstudio' });
  if (lm.ok) console.log(`\nМодели LM Studio: ${lm.models.join(', ')}`);

  await run('LM Studio · gemma-4-12b-qat', { provider: 'lmstudio', model: 'google/gemma-4-12b-qat' });
  await run('Claude Code (подписка)', { provider: 'claudeCli' });
  await run('Codex (подписка)', { provider: 'codexCli' });

  if (process.env.AITUNNEL_KEY) {
    const remote = await llm.models({ provider: 'aitunnel', apiKey: process.env.AITUNNEL_KEY });
    console.log(`\nМоделей у шлюза: ${remote.models.length}`);
    await run('AITunnel · gpt-5.6-luna', {
      provider: 'aitunnel', model: 'gpt-5.6-luna', apiKey: process.env.AITUNNEL_KEY,
    });
  } else {
    console.log('\n· AITunnel пропущен: не задан AITUNNEL_KEY');
  }

  console.log('\nПроверка связи, как её видит окно настроек:');
  console.log('  ', JSON.stringify(await llm.check({ provider: 'lmstudio', model: 'google/gemma-4-12b-qat' }), null, 1));

  app.exit(0);
});
