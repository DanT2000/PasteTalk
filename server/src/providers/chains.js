'use strict';

const { CLOUD } = require('../../../shared/providers');
const settings = require('../settings');

/**
 * Перебор по цепочке: не ответил первый — идём ко второму.
 *
 * Отдельный модуль, потому что цепочек две — распознавание и улучшение, —
 * и правило перебора у них одно, а списки провайдеров разные.
 */

class AllFailed extends Error {
  constructor(what, causes) {
    // Одну причину показываем человеку: чаще всего провайдер один, и
    // «не задан ключ AITunnel» куда полезнее, чем «связи нет».
    super(causes.length === 1 ? causes[0].replace(/^[^:]+: /, '') : `Связи с ${what} нет`);
    this.name = 'AllFailed';
    this.causes = causes;
  }
}

async function run(providerIds, attempt, what = 'облаком') {
  const causes = [];
  for (const id of providerIds) {
    try {
      return { ...(await attempt(id)), provider: id };
    } catch (error) {
      causes.push(`${id}: ${error.message}`);
    }
  }
  // Причины обязаны быть видны: без них владелец, забывший вписать ключ,
  // читает «связи нет» и лезет чинить сеть и прокси.
  process.stderr.write(causes.length
    ? `Не вышло с ${what}: ${causes.join('; ')}\n`
    : `Не вышло с ${what}: список провайдеров пуст\n`);
  throw new AllFailed(what, causes);
}

function sttChain() {
  const saved = settings.get('chain.stt', ['aitunnel']);
  // Провайдеры без распознавания попадают сюда только по недосмотру:
  // молча оставить их в списке значит подарить владельцу аварийку,
  // которая не работает, и узнает он об этом в самый неподходящий момент.
  return saved.filter((id) => CLOUD[id]?.stt === true);
}

function llmChain() {
  const saved = settings.get('chain.llm', ['deepseek']);
  return saved.filter((id) => Boolean(CLOUD[id]));
}

module.exports = { run, sttChain, llmChain, AllFailed };
