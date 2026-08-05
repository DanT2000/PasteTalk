'use strict';

const db = require('./db');
const prices = require('./prices');

/**
 * Строка на каждую диктовку: когда, чей ключ, сколько секунд, где считали
 * и во сколько обошлось. Ни звука, ни текста — владелец видит, сколько
 * человек надиктовал, но не видит, что именно.
 *
 * Сделанное своим компьютером стоит ноль, даже если модель есть в прайсе:
 * прайс о ценах провайдеров, а домашняя видеокарта денег не берёт.
 */

function record(entry) {
  const cloud = entry.executedBy === 'cloud';
  const sttCost = cloud && entry.sttModel
    ? prices.sttCost(entry.sttModel, entry.audioSeconds || 0)
    : 0;
  const llmCost = cloud && entry.llmModel
    ? prices.llmCost(entry.llmModel, entry.tokensIn || 0, entry.tokensOut || 0)
    : 0;

  const info = db.open().prepare(`
    INSERT INTO usage (
      key_id, device_kind, at, audio_seconds, executed_by,
      stt_provider, stt_model, stt_cost_rub,
      llm_provider, llm_model, llm_tokens_in, llm_tokens_out, llm_cost_rub
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.keyId ?? null, entry.deviceKind, Date.now(), entry.audioSeconds || 0, entry.executedBy,
    entry.sttProvider ?? null, entry.sttModel ?? null, sttCost,
    entry.llmProvider ?? null, entry.llmModel ?? null,
    entry.tokensIn || 0, entry.tokensOut || 0, llmCost,
  );
  return Number(info.lastInsertRowid);
}

function monthStart(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function monthly(now = Date.now()) {
  const database = db.open();
  const since = monthStart(now);

  const totals = database.prepare(`
    SELECT
      SUM(CASE WHEN executed_by = 'agent' THEN audio_seconds ELSE 0 END) AS agent_seconds,
      SUM(CASE WHEN executed_by = 'cloud' THEN audio_seconds ELSE 0 END) AS cloud_seconds,
      SUM(stt_cost_rub + llm_cost_rub) AS rub
    FROM usage WHERE at >= ?
  `).get(since);

  const byModel = database.prepare(`
    SELECT model, SUM(rub) AS rub, COUNT(*) AS count FROM (
      SELECT stt_model AS model, stt_cost_rub AS rub FROM usage
        WHERE at >= ? AND stt_model IS NOT NULL
      UNION ALL
      SELECT llm_model AS model, llm_cost_rub AS rub FROM usage
        WHERE at >= ? AND llm_model IS NOT NULL
    ) GROUP BY model ORDER BY rub DESC
  `).all(since, since);

  return {
    agentMinutes: round((totals.agent_seconds || 0) / 60),
    cloudMinutes: round((totals.cloud_seconds || 0) / 60),
    rub: round(totals.rub || 0),
    byModel: byModel.map((row) => ({ ...row, rub: round(row.rub) })),
  };
}

/**
 * По дням за последний месяц — для столбиков в админке.
 *
 * Дни без диктовок тоже возвращаются, нулями: иначе на графике пропуски
 * схлопнутся, и неделя молчания будет выглядеть как обычная неделя.
 */
function daily(now = Date.now(), days = 30) {
  const database = db.open();
  const dayMs = 24 * 60 * 60 * 1000;
  const since = now - (days - 1) * dayMs;

  const rows = database.prepare(`
    SELECT
      CAST(at / ? AS INTEGER) AS bucket,
      SUM(CASE WHEN executed_by = 'agent' THEN audio_seconds ELSE 0 END) AS agent_seconds,
      SUM(CASE WHEN executed_by = 'cloud' THEN audio_seconds ELSE 0 END) AS cloud_seconds,
      SUM(stt_cost_rub + llm_cost_rub) AS rub
    FROM usage WHERE at >= ? GROUP BY bucket
  `).all(dayMs, since);

  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const at = since + i * dayMs;
    const row = byBucket.get(Math.floor(at / dayMs));
    out.push({
      at,
      agentMinutes: round((row?.agent_seconds || 0) / 60),
      cloudMinutes: round((row?.cloud_seconds || 0) / 60),
      rub: round(row?.rub || 0),
    });
  }
  return out;
}

function perKey(now = Date.now()) {
  return db.open().prepare(`
    SELECT key_id, SUM(audio_seconds) / 60.0 AS minutes, SUM(stt_cost_rub + llm_cost_rub) AS rub
    FROM usage WHERE at >= ? GROUP BY key_id
  `).all(monthStart(now)).map((row) => ({
    key_id: row.key_id, minutes: round(row.minutes), rub: round(row.rub),
  }));
}

module.exports = { record, monthly, daily, perKey };
