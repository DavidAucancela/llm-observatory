const pool = require('../db/pool');
const { anthropicCacheCreationTokens } = require('./providerUsage');
const { costForProviderUsage } = require('./pricingBridge');

// Splits one provider usage result-row into the token categories the pricing
// bridge understands. OpenAI's usage API has no separate cache-write concept and
// folds cached input into input_tokens.
function extractBucketTokens(provider, result) {
  if (provider === 'anthropic') {
    return {
      uncachedInput:      parseInt(result.uncached_input_tokens || 0, 10),
      cacheReadInput:     parseInt(result.cache_read_input_tokens || 0, 10),
      cacheCreationInput: anthropicCacheCreationTokens(result),
      output:             parseInt(result.output_tokens || 0, 10),
    };
  }
  return {
    uncachedInput:      parseInt(result.input_tokens || 0, 10),
    cacheReadInput:     0,
    cacheCreationInput: 0,
    output:             parseInt(result.output_tokens || 0, 10),
  };
}

// What the org's own LIVE rows (not sync, not ping, not judge) already booked
// for a given slice — either one model on one day, or (when `model` is
// omitted) the whole day across every model, used by the clamp below.
async function liveTotalsQuery(client, orgId, provider, model, dayStartISO, dayEndISO) {
  const modelFilter = model != null ? 'AND model = $5' : '';
  const params = model != null
    ? [orgId, provider, dayStartISO, dayEndISO, model]
    : [orgId, provider, dayStartISO, dayEndISO];
  const res = await client.query(
    `SELECT COALESCE(SUM(cost_usd), 0)           AS cost,
            COALESCE(SUM(input_tokens), 0)       AS input_tokens,
            COALESCE(SUM(output_tokens), 0)      AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0)  AS cache_read_tokens,
            COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
     FROM api_calls
     WHERE org_id = $1 AND provider = $2
       AND timestamp >= $3 AND timestamp < $4
       ${modelFilter}
       AND (prompt_preview IS NULL OR (
             prompt_preview NOT LIKE 'sync:%'
         AND prompt_preview NOT LIKE 'test:%'
         AND prompt_preview <> 'eval:judge'))`,
    params
  );
  const row = res.rows[0];
  return {
    cost:        parseFloat(row.cost) || 0,
    input:       parseInt(row.input_tokens, 10) || 0,
    output:      parseInt(row.output_tokens, 10) || 0,
    cacheRead:   parseInt(row.cache_read_tokens, 10) || 0,
    cacheWrite:  parseInt(row.cache_write_tokens, 10) || 0,
  };
}

// Imports provider daily-aggregate usage as reconciling `sync:<provider>` rows,
// but only for the SHORTFALL not already covered by the org's own live SDK rows
// for that provider+model+day. Without this, an org that runs the SDK *and*
// syncs double-counts every overlapping day.
//
// Idempotent: the whole window's prior `sync:<provider>` rows are dropped and
// recomputed inside one transaction, so re-running never stacks rows and the
// recorded total converges toward (never exceeds) the provider's own figure as
// live rows accumulate.
//
// `clampDayTotal` (see providerRegistry.js) exists for providers whose usage
// API can report a different model id than the SDK sent for the same
// underlying model (Grok: "grok-4-0709" from xAI vs "grok-4.6" from the SDK).
// Without it, a per-(model,day) gap can't find the live row it should offset
// against and double-counts the day. With it, gaps are capped so the day's
// total inserted spend never exceeds `dayBucketTotal - dayLiveTotal`.
//
// `stats` (optional, filled in place): `skippedModels` collects models that had
// token usage but no price in the pricing tables — their usage can't be turned
// into dollars, so it's left out; the caller reports it instead of dropping it
// silently.
async function importBuckets(buckets, provider, orgId, windowStartISO, windowEndISO, { clampDayTotal = false, stats = null } = {}) {
  const tag    = `sync:${provider}`;

  // A healthy usage-API response always has one bucket per day in the range
  // (even zero-usage days). An empty array means the fetch degraded — do
  // nothing rather than wipe the window's existing reconciling rows.
  if (!Array.isArray(buckets) || buckets.length === 0) return 0;

  const client = await pool.connect();
  let imported = 0;

  try {
    await client.query('BEGIN');

    await client.query(
      `DELETE FROM api_calls
       WHERE org_id = $1 AND provider = $2 AND prompt_preview = $3
         AND timestamp >= $4 AND timestamp <= $5`,
      [orgId, provider, tag, windowStartISO, windowEndISO]
    );

    for (const bucket of buckets) {
      const dayStartISO = bucket.starting_at
        || new Date(bucket.start_time * 1000).toISOString();
      const dayEndISO = new Date(Date.parse(dayStartISO) + 86400_000).toISOString();

      // Gaps computed per (model, day) below; collected here so the clamp can
      // rescale them after seeing every model's gap for the day.
      const dayGaps = []; // { model, gap, resInput, resOutput, resCacheRead, resCacheWrite }
      let dayBucketCostSum = 0;

      for (const result of (bucket.results || [])) {
        const model = result.model || 'unknown';
        const tok   = extractBucketTokens(provider, result);
        const bucketInput = tok.uncachedInput + tok.cacheReadInput + tok.cacheCreationInput;

        // `cost_usd` on the result means the provider gave us a billed dollar
        // figure directly (Grok) rather than token counts to price ourselves
        // (Anthropic/OpenAI). Only skip a token-priced row with nothing in it;
        // a cost-priced row can be legitimately zero-token and still owe money.
        const bucketCost = result.cost_usd != null
          ? Number(result.cost_usd)
          : costForProviderUsage(provider, model, tok);
        if (bucketInput + tok.output === 0 && !(bucketCost > 0)) continue;
        if (bucketCost <= 0) {
          if (stats && result.cost_usd == null) (stats.skippedModels ||= new Set()).add(model);
          continue;
        }
        dayBucketCostSum += bucketCost;

        const live = await liveTotalsQuery(client, orgId, provider, model, dayStartISO, dayEndISO);

        const gap = bucketCost - live.cost;
        if (gap <= 0) continue; // live rows already cover this bucket

        // Residual token counts on the reconciling row are an approximation
        // (bucket minus what live rows reported, floored at 0). The `gap` dollar
        // figure is the authoritative number.
        dayGaps.push({
          model,
          gap,
          resInput:      Math.max(0, bucketInput - live.input),
          resOutput:     Math.max(0, tok.output - live.output),
          resCacheRead:  Math.max(0, tok.cacheReadInput - live.cacheRead),
          resCacheWrite: Math.max(0, tok.cacheCreationInput - live.cacheWrite),
        });
      }

      if (!dayGaps.length) continue;

      // Without the clamp, each model's gap stands as computed above — the
      // Anthropic/OpenAI path, unchanged.
      let scale = 1;
      if (clampDayTotal) {
        const dayLive = await liveTotalsQuery(client, orgId, provider, null, dayStartISO, dayEndISO);
        const dayGapSum = dayGaps.reduce((s, g) => s + g.gap, 0);
        const allowedDayGap = Math.max(0, dayBucketCostSum - dayLive.cost);
        // Scale every model's gap down proportionally so the day's total
        // never exceeds what the provider actually billed that day — the
        // invariant a model-id mismatch would otherwise break.
        scale = dayGapSum > 0 ? Math.min(1, allowedDayGap / dayGapSum) : 0;
      }

      for (const g of dayGaps) {
        const gap = g.gap * scale;
        if (gap <= 0) continue;
        const resInput  = Math.round(g.resInput  * scale);
        const resOutput = Math.round(g.resOutput * scale);

        await client.query(
          `INSERT INTO api_calls
             (org_id, timestamp, provider, model,
              input_tokens, output_tokens, total_tokens, cost_usd,
              cache_read_tokens, cache_write_tokens,
              latency_ms, status_code, prompt_preview, api_key_hint, cost_confidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,200,$11,$11,'known')`,
          [orgId, dayStartISO, provider, g.model,
           resInput, resOutput, resInput + resOutput, gap,
           Math.round(g.resCacheRead * scale), Math.round(g.resCacheWrite * scale), tag]
        );
        imported++;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {}); // don't mask the original error
    throw err;
  } finally {
    client.release();
  }
  return imported;
}

module.exports = { importBuckets, extractBucketTokens };
