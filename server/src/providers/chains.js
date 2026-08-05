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
    super(`Связи с ${what} нет`);
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
