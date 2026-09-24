#!/usr/bin/env node
// Repara datos históricos de api_calls afectados por los bugs de tracking de
// costo corregidos en fix/cost-tracking-*:
//
//   Pass 1 — Re-tarifa filas en $0 que sí tenían tokens y modelo conocido
//            (IDs de OpenAI con fecha, claude-fable-5, etc.). Superset del
//            viejo scripts/reprice-zero-cost-calls.js.
//   Pass 2 — Pone cost_usd = 0 en filas 4xx/5xx (un request rechazado no se
//            factura).
//
// El doble-conteo de las filas `sync:<provider>` NO se toca acá: se corrige
// re-lanzando el sync (Ajustes → Sync). El nuevo importBuckets es idempotente
// y calcula el gap contra las filas en vivo; recomputarlo desde este script
// contaría doble los tokens de cache de las filas gap ya correctas.
//
// Dry-run por defecto. --apply escribe. --org=<id> acota a un org.
// Lee la DB de process.env.DATABASE_URL (igual que el resto de la API).
//
// En el contenedor de Railway (DATABASE_URL ya seteada), desde /app:
//   node scripts/repair-cost-history.js
//   node scripts/repair-cost-history.js --apply --org=3
// En local contra otra DB:
//   DATABASE_URL='postgresql://…' node packages/api/scripts/repair-cost-history.js

const pool = require('../src/db/pool');
const { costForProviderUsage, isKnownModel } = require('../src/services/pricingBridge');

const args   = process.argv.slice(2);
const APPLY  = args.includes('--apply');
const orgArg = args.find(a => a.startsWith('--org='));
const ORG_ID = orgArg ? parseInt(orgArg.split('=')[1], 10) : null;

const SYNC_PROVIDERS = ['anthropic', 'openai'];
const fmt = (n) => `$${Number(n).toFixed(6)}`;
const orgFilter = (startIdx) => (ORG_ID ? ` AND org_id = $${startIdx}` : '');

// Rebuild the { uncachedInput, cacheReadInput, cacheCreationInput, output } the
// pricing bridge expects from a stored row's columns.
function rowTokens(row) {
  const cacheRead  = parseInt(row.cache_read_tokens, 10) || 0;
  const cacheWrite = parseInt(row.cache_write_tokens, 10) || 0;
  const input      = parseInt(row.input_tokens, 10) || 0;
  const output     = parseInt(row.output_tokens, 10) || 0;
  // input_tokens historically already includes cache-read for Anthropic sync
  // rows; subtract it back out so we don't double-count in the bridge.
  const uncached = Math.max(0, input - cacheRead);
  return { uncachedInput: uncached, cacheReadInput: cacheRead, cacheCreationInput: cacheWrite, output };
}

async function pass1Reprice() {
  const params = ORG_ID ? [SYNC_PROVIDERS.concat(['gemini', 'grok', 'kimi', 'deepinfra']), ORG_ID]
                        : [SYNC_PROVIDERS.concat(['gemini', 'grok', 'kimi', 'deepinfra'])];
  const { rows } = await pool.query(
    `SELECT id, provider, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens
     FROM api_calls
     WHERE cost_usd = 0
       AND status_code < 400
       AND cost_confidence = 'known'
       AND total_tokens > 0
       AND provider = ANY($1)${orgFilter(2)}`,
    params
  );

  const updates = [];
  let recovered = 0, skipped = 0;
  for (const row of rows) {
    // Only chat models are in the bridge's tables — embeddings/whisper/tts price
    // $0 there. Skip cleanly instead of logging a warn per row.
    if (!isKnownModel(row.provider, row.model)) { skipped++; continue; }
    const cost = costForProviderUsage(row.provider, row.model, rowTokens(row));
    if (cost > 0) { updates.push({ id: row.id, cost }); recovered += cost; }
  }
  console.log(`Pass 1 (reprice $0): ${rows.length} candidatas, ${updates.length} re-tarifadas, `
    + `${skipped} sin tarifa en tabla, recupera ${fmt(recovered)}`);
  return updates.map((u) => ['UPDATE api_calls SET cost_usd = $1 WHERE id = $2', [u.cost, u.id]]);
}

async function pass2ZeroFailed() {
  const params = ORG_ID ? [ORG_ID] : [];
  const { rows } = await pool.query(
    `SELECT id, cost_usd FROM api_calls
     WHERE status_code >= 400 AND cost_usd > 0${orgFilter(1)}`,
    params
  );
  const removed = rows.reduce((s, r) => s + Number(r.cost_usd), 0);
  console.log(`Pass 2 (zero 4xx/5xx): ${rows.length} filas, quita ${fmt(removed)}`);
  // Match the live ingest guard in routes/metrics.js: a failed call's forced $0
  // is 'unknown', not a verified real cost.
  return rows.map((r) => [
    `UPDATE api_calls SET cost_usd = 0, cost_confidence = 'unknown' WHERE id = $1`, [r.id],
  ]);
}

async function main() {
  const ops = [
    ...(await pass1Reprice()),
    ...(await pass2ZeroFailed()),
  ];

  console.log(`\nTotal: ${ops.length} operaciones de escritura.`);
  if (!APPLY) {
    console.log('Dry-run — no se escribió nada. Corre con --apply para aplicar.');
    await pool.end();
    return;
  }
  if (ops.length === 0) { await pool.end(); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [sql, p] of ops) await client.query(sql, p);
    await client.query('COMMIT');
    console.log(`Aplicado: ${ops.length} operaciones.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error, rollback:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exitCode = 1;
});
