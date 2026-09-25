const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const { deliverWebhooks } = require('../services/webhooks');
const { rangeMiddleware, appendTimeWindow, DAY_MS } = require('../utils/dateRange');
const { isKnownModel, splitRecordedCost } = require('../services/pricingBridge');
const { PROVIDERS } = require('../constants/providers');
const { computeCoverage } = require('../services/coverage');

// Zero-fill grid for the per-provider time series. Built from the shared list
// so the two queries below can never drift apart from each other (they were
// two hand-maintained copies of the same literal) or from the ingest enum.
const PROVIDER_VALUES_SQL = PROVIDERS.map(p => `('${p}')`).join(', ');

const router = express.Router();

// Validates ?range / ?start / ?end once for every GET in this router (400 on bad
// input) and exposes the parsed window as req.dateRange — see utils/dateRange.js.
router.use(rangeMiddleware());

// Adds the input/output cost split to every by_model row of GET /summary, so
// /models can draw a stacked bar per model ("where did this model's money go")
// instead of one opaque total. Costs come back as numbers (the pg driver hands
// DECIMAL back as a string, and these are derived values, not column reads);
// the token/request counts stay exactly as the driver returned them so existing
// consumers keep parsing them the way they already do.
function enrichByModel(rows) {
  return rows.map(row => {
    const split = splitRecordedCost(row.provider, row.model, {
      inputTokens:  Number(row.input_tokens)  || 0,
      outputTokens: Number(row.output_tokens) || 0,
      recordedCost: Number(row.total_cost)    || 0,
    });
    return {
      ...row,
      input_cost:        split.inputCost,
      output_cost:       split.outputCost,
      unattributed_cost: split.unattributedCost,
      cost_split_priced: split.priced,
      cost_split_approx: split.approx,
    };
  });
}

const MetricSchema = z.object({
  provider:           z.enum(PROVIDERS).default('anthropic'),
  model:              z.string().min(1),
  input_tokens:       z.number().int().min(0),
  output_tokens:      z.number().int().min(0),
  total_tokens:       z.number().int().min(0),
  cost_usd:           z.number().min(0),
  latency_ms:         z.number().int().min(0),
  status_code:        z.number().int().min(100).max(599),
  tools_used:         z.array(z.string()).default([]),
  prompt_preview:     z.string().max(200).optional(),
  tags:               z.record(z.unknown()).optional().default({}),
  api_key_hint:       z.string().max(30).optional(),
  cache_read_tokens:  z.number().int().min(0).default(0),
  cache_write_tokens: z.number().int().min(0).default(0),
  error_type:         z.string().max(100).optional(),
  error_message:      z.string().max(500).nullable().optional(),
  prompt_full:        z.string().max(20000).optional(),
  response_full:      z.string().max(20000).optional(),
  system_prompt:      z.string().max(4000).optional(),
  request_params:     z.object({
    temperature: z.number().nullable().optional(),
    max_tokens:  z.number().int().nullable().optional(),
    top_p:       z.number().nullable().optional(),
    stream:      z.boolean().nullable().optional(),
  }).optional().default({}),
  tool_calls:         z.array(z.object({
    name:      z.string(),
    arguments: z.unknown(),
  })).max(50).optional().default([]),
  stop_reason:        z.string().max(50).nullable().optional(),
  // Client's own assertion about cost_usd's reliability. Left optional so existing
  // SDKs that never send this field keep working — the server-side override below
  // (not this default) is what actually closes the "silent zero" gap.
  cost_confidence:    z.enum(['known', 'unknown']).optional().default('known'),
});

// Window to look back for a same-shape call when detecting likely SDK retries
// (e.g. an audio transcription that timed out and got retried by the client's
// own provider SDK, re-billing the same request — see the WhisperX incident
// that motivated this). Long-running calls (large audio, big context) can
// legitimately take minutes per attempt, so this is generous on purpose;
// exact prompt_preview match keeps false positives low despite the width.
const RETRY_WINDOW = '5 minutes';
// Batch-imported rows (sync.js) and SDK connectivity pings share fixed
// prompt_preview tags across many unrelated calls — never treat those as
// retries of each other.
const NON_RETRY_PREVIEW_PREFIX = /^(sync:|test:)/;

// ── POST / — SDK ingest (requires observatory token or JWT) ───────────────────
router.post('/', async (req, res) => {
  try {
    const { orgId } = req.user;
    const data = MetricSchema.parse(req.body);

    // Soft check: a model the pricing tables don't recognize is usually a brand
    // new model (add it to the SDK tables) — but a model that belongs to a
    // different provider (e.g. provider:'anthropic' + model:'gpt-4o') is a
    // mislabeled row. Warn, never reject, never rewrite data.model.
    if (!isKnownModel(data.provider, data.model)) {
      console.warn(`[metrics] Unrecognized model "${data.model}" for provider "${data.provider}" `
        + `(org ${orgId}) — recording as-is; possible mislabeled provider/model row.`);
    }

    // A failed call (4xx/5xx) is not billed. Never trust a cost on it: zero any
    // positive value the client sent, and — unless the client explicitly
    // asserted 'known' — mark the $0 as unverified (a client that didn't assert
    // 'known' almost certainly never computed a real cost, e.g. a timeout after
    // retries). An explicit 'known' from the client (a real $0, e.g. a 400
    // rejected before any provider call) is always respected. No 429/408
    // exception: keep it simple — a failed call books $0. Token fields are left
    // as received (tokens may genuinely have been sent).
    if (data.status_code >= 400) {
      if (data.cost_usd > 0) data.cost_usd = 0;
      if (req.body.cost_confidence === undefined) data.cost_confidence = 'unknown';
    }

    // Heuristic likely-retry detection: same (provider, model, prompt_preview,
    // api_key_hint) seen very recently almost always means the client's own
    // SDK retried the same request (possibly re-billing it), not a genuine
    // second use — surfaced in the UI, never used to auto-adjust cost figures.
    let likelyRetryOf = null;
    if (data.prompt_preview && !NON_RETRY_PREVIEW_PREFIX.test(data.prompt_preview)) {
      const dupRes = await pool.query(
        `SELECT id FROM api_calls
         WHERE org_id = $1 AND provider = $2 AND model = $3 AND prompt_preview = $4
           AND api_key_hint IS NOT DISTINCT FROM $5
           AND timestamp > NOW() - INTERVAL '${RETRY_WINDOW}'
         ORDER BY timestamp DESC LIMIT 1`,
        [orgId, data.provider, data.model, data.prompt_preview, data.api_key_hint || null]
      );
      if (dupRes.rows.length) likelyRetryOf = dupRes.rows[0].id;
    }

    const result = await pool.query(
      `INSERT INTO api_calls
         (org_id, provider, model, input_tokens, output_tokens, total_tokens,
          cost_usd, latency_ms, status_code, tools_used, prompt_preview, tags, api_key_hint,
          cache_read_tokens, cache_write_tokens, error_type, error_message,
          prompt_full, response_full, system_prompt, request_params, tool_calls, stop_reason,
          cost_confidence, likely_retry_of, token_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *`,
      [
        orgId,
        data.provider, data.model,
        data.input_tokens, data.output_tokens, data.total_tokens,
        data.cost_usd, data.latency_ms, data.status_code,
        JSON.stringify(data.tools_used),
        data.prompt_preview || null,
        JSON.stringify(data.tags || {}),
        data.api_key_hint || null,
        data.cache_read_tokens || 0,
        data.cache_write_tokens || 0,
        data.error_type || null,
        data.error_message || null,
        data.prompt_full || null,
        data.response_full || null,
        data.system_prompt || null,
        JSON.stringify(data.request_params || {}),
        JSON.stringify(data.tool_calls || []),
        data.stop_reason || null,
        data.cost_confidence,
        likelyRetryOf,
        req.user.tokenName || null,
      ]
    );
    if (req.app.get('io')) req.app.get('io').emit('new-metric', result.rows[0]);
    deliverWebhooks(req.user.orgId, 'metric.created', result.rows[0]).catch(() => {});
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.errors });
    console.error('POST /api/metrics error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET / — paginated list ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { orgId } = req.user;
    const page    = Math.max(1, parseInt(req.query.page)  || 1);
    const limit   = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset  = (page - 1) * limit;
    const model    = req.query.model;
    const provider = req.query.provider;
    const status   = req.query.status; // 'error' | 'success'
    const search   = req.query.search?.trim();
    const sortBy  = ['timestamp','cost_usd','latency_ms','total_tokens'].includes(req.query.sortBy) ? req.query.sortBy : 'timestamp';
    const sortDir = req.query.sortDir === 'asc' ? 'ASC' : 'DESC';
    const { start: startDate, end: endDate, interval } = req.dateRange;

    const tagKey   = req.query.tag_key?.trim();
    const tagValue = req.query.tag_value?.trim();

    const params = [orgId]; // $1 = org_id
    let where = 'WHERE org_id = $1';

    if (startDate && endDate) {
      params.push(startDate, endDate);
      where += ` AND timestamp >= $${params.length - 1} AND timestamp <= $${params.length}`;
    } else {
      where += ` AND timestamp > NOW() - INTERVAL '${interval}'`;
    }
    if (model)    { params.push(model);    where += ` AND model = $${params.length}`; }
    if (provider) { params.push(provider); where += ` AND provider = $${params.length}`; }
    if (status === 'error')   where += ` AND status_code >= 400`;
    if (status === 'success') where += ` AND status_code < 400`;
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (prompt_preview ILIKE $${params.length} OR model ILIKE $${params.length})`;
    }
    if (tagKey && tagValue) {
      params.push(tagKey, tagValue);
      where += ` AND tags->>$${params.length - 1} = $${params.length}`;
    } else if (tagKey) {
      params.push(tagKey);
      where += ` AND tags ? $${params.length}`;
    }

    // Excludes prompt_full/response_full/system_prompt/request_params/tool_calls —
    // those are only needed on the single-record detail view (GET /:id), not the
    // paginated list, to keep list payloads light.
    const listColumns = `id, timestamp, provider, model, input_tokens, output_tokens, total_tokens,
      cost_usd, cost_confidence, latency_ms, status_code, tools_used, prompt_preview, tags, api_key_hint,
      cache_read_tokens, cache_write_tokens, error_type, error_message, stop_reason, likely_retry_of`;

    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM api_calls ${where}`, params),
      pool.query(
        `SELECT ${listColumns} FROM api_calls ${where} ORDER BY ${sortBy} ${sortDir}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);

    res.json({
      data: dataResult.rows,
      pagination: {
        page, limit,
        total: parseInt(countResult.rows[0].count),
        pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
      },
    });
  } catch (err) {
    console.error('GET /api/metrics error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /summary — aggregated stats + time series + prev period ────────────────
router.get('/summary', async (req, res) => {
  try {
    const { orgId } = req.user;
    const dr = req.dateRange;
    const { interval, dblInterval, start: startDate, end: endDate } = dr;
    const isCustomRange = dr.custom;
    // Daily buckets for ranges ≥ 7d so the chart differentiates days (not just hours);
    // hourly buckets for 24h and for a custom window of one day or less.
    const useDays   = isCustomRange ? dr.spanMs > DAY_MS : dr.range !== '24h';
    // Previous period of a custom window: the same length, ending right where this
    // one starts — [prevStart, start), exclusive at the top so a row exactly at
    // `start` is never counted in both periods.
    const prevStartISO = isCustomRange ? new Date(Date.parse(startDate) - dr.spanMs).toISOString() : null;

    // Optional model filter — models to EXCLUDE (comma-separated). Empty → all models.
    const excludeModels = (req.query.exclude_models || '').split(',').map(s => s.trim()).filter(Boolean);

    // Base (org + time window) — shared, WITHOUT the model filter so the model
    // picker can always list every model present in the range.
    const baseParams = [orgId];
    let baseWhere;
    if (isCustomRange) {
      baseParams.push(startDate, endDate);
      baseWhere = `org_id = $1 AND timestamp >= $2 AND timestamp <= $3`;
    } else {
      baseWhere = `org_id = $1 AND timestamp > NOW() - INTERVAL '${interval}'`;
    }

    // Current filter = base (+ optional model exclusion)
    const currParams = [...baseParams];
    let dateFilter = baseWhere;
    if (excludeModels.length) {
      currParams.push(excludeModels);
      dateFilter += ` AND model <> ALL($${currParams.length})`;
    }

    const prevParams = [orgId];
    let prevFilter;
    if (isCustomRange) {
      prevParams.push(prevStartISO, startDate);
      prevFilter = `org_id = $1 AND timestamp >= $2 AND timestamp < $3`;
    } else {
      prevFilter = `org_id = $1 AND timestamp > NOW() - INTERVAL '${dblInterval}' AND timestamp <= NOW() - INTERVAL '${interval}'`;
    }
    if (excludeModels.length) {
      prevParams.push(excludeModels);
      prevFilter += ` AND model <> ALL($${prevParams.length})`;
    }

    // Time series buckets are zero-filled across the whole requested window (not just
    // hours/days that had activity) — otherwise a burst of requests landing inside a
    // single bucket collapses time_series to one row and the chart falsely reports
    // "not enough data" even though total_requests is well above zero.
    const bucketUnit = useDays ? 'day' : 'hour';
    const tsParams = [orgId];
    let tsSeriesStart, tsSeriesEnd;
    let tsJoinFilter = `ac.org_id = $1`;
    if (isCustomRange) {
      tsParams.push(startDate, endDate);
      tsSeriesStart = `date_trunc('${bucketUnit}', $2::timestamptz, 'UTC')`;
      tsSeriesEnd   = `date_trunc('${bucketUnit}', $3::timestamptz, 'UTC')`;
      tsJoinFilter += ` AND ac.timestamp >= $2 AND ac.timestamp <= $3`;
    } else {
      tsSeriesStart = `date_trunc('${bucketUnit}', NOW() - INTERVAL '${interval}', 'UTC')`;
      tsSeriesEnd   = `date_trunc('${bucketUnit}', NOW(), 'UTC')`;
      tsJoinFilter += ` AND ac.timestamp > NOW() - INTERVAL '${interval}'`;
    }
    if (excludeModels.length) {
      tsParams.push(excludeModels);
      tsJoinFilter += ` AND ac.model <> ALL($${tsParams.length})`;
    }

    // prev_time_series: same bucket grid as time_series (same tsSeriesStart/
    // tsSeriesEnd/bucketUnit), but each bucket is filled from the equivalent
    // bucket of the immediately preceding period — every previous-period
    // timestamp is shifted forward by `interval` so it lands in the same
    // relative bucket as its current-period counterpart. That lets the
    // dashboard overlay a "previous period" line aligned by bucket index,
    // not by calendar date. For a custom window the shift is its own length
    // (spanMs) and $2/$3 stay the CURRENT window so the bucket grid above
    // (tsSeriesStart/End) resolves against the right params.
    let prevTsParams, prevTsJoinFilter, prevTsShift;
    if (isCustomRange) {
      prevTsParams     = [orgId, startDate, endDate, prevStartISO, dr.spanMs / 1000];
      prevTsJoinFilter = `ac.org_id = $1 AND ac.timestamp >= $4 AND ac.timestamp < $2`;
      prevTsShift      = `make_interval(secs => $5::double precision)`;
    } else {
      prevTsParams     = [orgId];
      prevTsJoinFilter = `ac.org_id = $1 AND ac.timestamp > NOW() - INTERVAL '${dblInterval}' AND ac.timestamp <= NOW() - INTERVAL '${interval}'`;
      prevTsShift      = `INTERVAL '${interval}'`;
    }
    if (excludeModels.length) {
      prevTsParams.push(excludeModels);
      prevTsJoinFilter += ` AND ac.model <> ALL($${prevTsParams.length})`;
    }

    const [summary, byModel, byProvider, timeSeries, modelTimeSeries, prevSummary, errorBreakdown, allModels, prevTimeSeries] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) as total_requests,
                COALESCE(SUM(total_tokens),0)       as total_tokens,
                COALESCE(SUM(input_tokens),0)       as total_input_tokens,
                COALESCE(SUM(output_tokens),0)      as total_output_tokens,
                COALESCE(SUM(cost_usd),0)           as total_cost_usd,
                COALESCE(AVG(latency_ms),0)         as avg_latency_ms,
                COALESCE(AVG(cost_usd),0)           as avg_cost_usd,
                COUNT(*) FILTER (WHERE status_code >= 400) as error_count,
                COALESCE(SUM(cache_read_tokens),0)  as total_cache_read_tokens,
                COALESCE(SUM(cache_write_tokens),0) as total_cache_write_tokens
         FROM api_calls WHERE ${dateFilter}`,
        currParams
      ),
      pool.query(
        // Token columns come along so the /models cost breakdown can split each
        // model's spend into input vs output (see enrichByModel below) instead
        // of showing one opaque bar per model.
        `SELECT model, provider,
                COUNT(*) as requests,
                COALESCE(SUM(total_tokens),0)       as total_tokens,
                COALESCE(SUM(input_tokens),0)       as input_tokens,
                COALESCE(SUM(output_tokens),0)      as output_tokens,
                COALESCE(SUM(cache_read_tokens),0)  as cache_read_tokens,
                COALESCE(SUM(cache_write_tokens),0) as cache_write_tokens,
                COALESCE(SUM(cost_usd),0)     as total_cost,
                COALESCE(AVG(latency_ms),0)   as avg_latency,
                COUNT(*) FILTER (WHERE status_code >= 400) as error_count
         FROM api_calls WHERE ${dateFilter}
         GROUP BY model, provider ORDER BY total_cost DESC`,
        currParams
      ),
      pool.query(
        `SELECT provider,
                COUNT(*) as requests,
                COALESCE(SUM(total_tokens),0) as total_tokens,
                COALESCE(SUM(cost_usd),0)     as total_cost,
                COALESCE(AVG(latency_ms),0)   as avg_latency
         FROM api_calls WHERE ${dateFilter}
         GROUP BY provider ORDER BY total_cost DESC`,
        currParams
      ),
      pool.query(
        `SELECT bs.bucket as hour, p.provider,
                COALESCE(SUM(ac.input_tokens),0)  as input_tokens,
                COALESCE(SUM(ac.output_tokens),0) as output_tokens,
                COALESCE(SUM(ac.total_tokens),0)  as total_tokens,
                COALESCE(SUM(ac.cost_usd),0)      as cost_usd,
                COUNT(ac.id) as requests
         FROM generate_series(${tsSeriesStart}, ${tsSeriesEnd}, INTERVAL '1 ${bucketUnit}') AS bs(bucket)
         CROSS JOIN (VALUES ${PROVIDER_VALUES_SQL}) AS p(provider)
         LEFT JOIN api_calls ac
                ON date_trunc('${bucketUnit}', ac.timestamp, 'UTC') = bs.bucket
               AND ac.provider = p.provider
               AND ${tsJoinFilter}
         GROUP BY bs.bucket, p.provider ORDER BY hour ASC`,
        tsParams
      ),
      // Per-model time series (top 5 models by request count + "Other"), same
      // zero-fill pattern as time_series above but bucketed by model instead of
      // provider — models are an open set (unlike the 3-provider CROSS JOIN
      // above), so the candidate set is a dynamic top-5 subquery, not a literal
      // list. Feeds the 3D "token landscape" chart's Z axis.
      pool.query(
        `WITH top_models AS MATERIALIZED (
           SELECT model FROM api_calls ac WHERE ${tsJoinFilter}
           GROUP BY model ORDER BY COUNT(*) DESC, model ASC LIMIT 5
         )
         SELECT bs.bucket AS hour,
                series_model.model AS model,
                COALESCE(SUM(ac.total_tokens), 0)  AS total_tokens,
                COALESCE(SUM(ac.input_tokens), 0)  AS input_tokens,
                COALESCE(SUM(ac.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(ac.cache_read_tokens), 0)  AS cache_read_tokens,
                COALESCE(SUM(ac.cache_write_tokens), 0) AS cache_write_tokens,
                COALESCE(SUM(ac.cost_usd), 0)       AS cost_usd,
                COUNT(ac.id)                        AS requests,
                COALESCE(AVG(ac.latency_ms) FILTER (WHERE ac.id IS NOT NULL), 0) AS avg_latency_ms,
                COUNT(ac.id) FILTER (WHERE ac.status_code >= 400) AS error_count
         FROM generate_series(${tsSeriesStart}, ${tsSeriesEnd}, INTERVAL '1 ${bucketUnit}') AS bs(bucket)
         CROSS JOIN (SELECT model FROM top_models UNION ALL SELECT 'Other') AS series_model(model)
         LEFT JOIN api_calls ac
                ON date_trunc('${bucketUnit}', ac.timestamp, 'UTC') = bs.bucket
               AND (ac.model = series_model.model
                    OR (series_model.model = 'Other' AND ac.model NOT IN (SELECT model FROM top_models)))
               AND ${tsJoinFilter}
         GROUP BY bs.bucket, series_model.model ORDER BY hour ASC, series_model.model ASC`,
        tsParams
      ),
      pool.query(
        `SELECT COUNT(*) as total_requests,
                COALESCE(SUM(total_tokens),0) as total_tokens,
                COALESCE(SUM(cost_usd),0)     as total_cost_usd,
                COALESCE(AVG(latency_ms),0)   as avg_latency_ms,
                COUNT(*) FILTER (WHERE status_code >= 400) as error_count
         FROM api_calls WHERE ${prevFilter}`,
        prevParams
      ),
      pool.query(
        `SELECT error_type, COUNT(*) as count
         FROM api_calls WHERE ${dateFilter} AND error_type IS NOT NULL
         GROUP BY error_type ORDER BY count DESC`,
        currParams
      ),
      pool.query(
        `SELECT model, MIN(provider) as provider, COUNT(*) as requests
         FROM api_calls WHERE ${baseWhere}
         GROUP BY model ORDER BY requests DESC`,
        baseParams
      ),
      pool.query(
        `SELECT bs.bucket as hour, p.provider,
                COALESCE(SUM(ac.total_tokens),0) as total_tokens,
                COALESCE(SUM(ac.cost_usd),0)     as cost_usd,
                COUNT(ac.id) as requests
         FROM generate_series(${tsSeriesStart}, ${tsSeriesEnd}, INTERVAL '1 ${bucketUnit}') AS bs(bucket)
         CROSS JOIN (VALUES ${PROVIDER_VALUES_SQL}) AS p(provider)
         LEFT JOIN api_calls ac
                ON date_trunc('${bucketUnit}', ac.timestamp + ${prevTsShift}, 'UTC') = bs.bucket
               AND ac.provider = p.provider
               AND ${prevTsJoinFilter}
         GROUP BY bs.bucket, p.provider ORDER BY hour ASC`,
        prevTsParams
      ),
    ]);

    res.json({
      summary:            summary.rows[0],
      prev_summary:       prevSummary.rows[0],
      by_model:           enrichByModel(byModel.rows),
      by_provider:        byProvider.rows,
      time_series:        timeSeries.rows,
      model_time_series:  modelTimeSeries.rows,
      error_breakdown:    errorBreakdown.rows,
      all_models:         allModels.rows,
      prev_time_series:   prevTimeSeries.rows,
    });
  } catch (err) {
    console.error('GET /api/metrics/summary error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /projection ───────────────────────────────────────────────────────────
// Maps the dashboard's existing range picker onto a calendar-aligned projection
// period, so "projected total" always means "projected total for the period
// containing today" rather than a rolling trailing window (which has no fixed
// end date to project toward).
function projectionPeriodFor(range, now) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();

  if (range === '24h') {
    return { unit: 'day', start: new Date(year, month, date), daysInPeriod: 1 };
  }
  if (range === '7d') {
    const mondayOffset = (now.getDay() + 6) % 7; // 0=Monday
    return { unit: 'week', start: new Date(year, month, date - mondayOffset), daysInPeriod: 7 };
  }
  if (range === '90d') {
    const quarterStartMonth = Math.floor(month / 3) * 3;
    const start = new Date(year, quarterStartMonth, 1);
    const end   = new Date(year, quarterStartMonth + 3, 1);
    return { unit: 'quarter', start, daysInPeriod: Math.round((end - start) / 86400000) };
  }
  // '30d' and any other value default to the calendar month, matching prior behavior.
  const start = new Date(year, month, 1);
  const daysInPeriod = new Date(year, month + 1, 0).getDate();
  return { unit: 'month', start, daysInPeriod };
}

router.get('/projection', async (req, res) => {
  try {
    const { orgId } = req.user;
    const range = req.query.range || '30d';
    const now = new Date();
    const { unit, start: startOfPeriod, daysInPeriod } = projectionPeriodFor(range, now);
    const daysElapsed   = Math.min(daysInPeriod, (now - startOfPeriod) / 86400000);
    const daysRemaining = Math.max(0, daysInPeriod - daysElapsed);

    const [periodSpend, weekAvg, credProviders] = await Promise.all([
      pool.query(
        `SELECT provider, COALESCE(SUM(cost_usd), 0) as spent
         FROM api_calls WHERE org_id = $1 AND timestamp >= $2 GROUP BY provider`,
        [orgId, startOfPeriod.toISOString()]
      ),
      pool.query(
        `SELECT provider, COALESCE(SUM(cost_usd), 0) / 7.0 as avg_daily
         FROM api_calls WHERE org_id = $1 AND timestamp > NOW() - INTERVAL '7 days' GROUP BY provider`,
        [orgId]
      ),
      pool.query(
        `SELECT DISTINCT provider FROM provider_credentials WHERE org_id = $1`,
        [orgId]
      ),
    ]);

    const providers = credProviders.rows.map(r => r.provider);
    const projection = providers.map(p => {
      const spent    = parseFloat(periodSpend.rows.find(r => r.provider === p)?.spent || 0);
      const avgDaily = parseFloat(weekAvg.rows.find(r => r.provider === p)?.avg_daily || 0);
      return {
        provider: p, spent_this_period: spent, avg_daily: avgDaily,
        days_remaining: Math.ceil(daysRemaining), projected_period_total: spent + avgDaily * daysRemaining,
      };
    });

    res.json({
      projection, unit,
      days_in_period: daysInPeriod,
      day_of_period: Math.min(daysInPeriod, Math.floor(daysElapsed) + 1),
    });
  } catch (err) {
    console.error('GET /api/metrics/projection error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /export — CSV download ────────────────────────────────────────────────
router.get('/export', async (req, res) => {
  try {
    const { orgId } = req.user;
    const { range, start: startDate, end: endDate, interval } = req.dateRange;
    const provider = req.query.provider;
    const status   = req.query.status;
    const model    = req.query.model;
    const search   = req.query.search?.trim();
    const tagKey   = req.query.tag_key?.trim();
    const tagValue = req.query.tag_value?.trim();

    const params = [orgId];
    let where = 'WHERE org_id = $1';
    if (startDate && endDate) {
      params.push(startDate, endDate);
      where += ` AND timestamp >= $${params.length - 1} AND timestamp <= $${params.length}`;
    } else {
      where += ` AND timestamp > NOW() - INTERVAL '${interval}'`;
    }
    if (provider) { params.push(provider); where += ` AND provider = $${params.length}`; }
    if (model)    { params.push(model);    where += ` AND model = $${params.length}`; }
    if (status === 'error')   where += ` AND status_code >= 400`;
    if (status === 'success') where += ` AND status_code < 400`;
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (prompt_preview ILIKE $${params.length} OR model ILIKE $${params.length})`;
    }
    if (tagKey && tagValue) {
      params.push(tagKey, tagValue);
      where += ` AND tags->>$${params.length - 1} = $${params.length}`;
    } else if (tagKey) {
      params.push(tagKey);
      where += ` AND tags ? $${params.length}`;
    }

    const result = await pool.query(
      `SELECT id, timestamp, provider, model, input_tokens, output_tokens,
              total_tokens, cost_usd, cost_confidence, latency_ms, status_code,
              cache_read_tokens, cache_write_tokens, error_message,
              prompt_preview, tags, likely_retry_of
       FROM api_calls ${where} ORDER BY timestamp DESC`,
      params
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="llm-metrics-${range === 'custom' ? `${startDate.slice(0, 10)}_${endDate.slice(0, 10)}` : range}.csv"`);
    const headers = ['id','timestamp','provider','model','input_tokens','output_tokens','total_tokens','cost_usd','cost_confidence','latency_ms','status_code','cache_read_tokens','cache_write_tokens','error_message','prompt_preview','tags','likely_retry_of'];
    res.write(headers.join(',') + '\n');
    for (const row of result.rows) {
      const line = headers.map(h => {
        const val = row[h] ?? '';
        const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
        // Quote per RFC-4180: any field with a comma, a quote, OR a newline —
        // prompt_preview routinely contains newlines and would otherwise split
        // one record across multiple physical lines.
        return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
      }).join(',');
      res.write(line + '\n');
    }
    res.end();
  } catch (err) {
    console.error('GET /api/metrics/export error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /tag-keys — distinct tag keys used by org ─────────────────────────────
router.get('/tag-keys', async (req, res) => {
  try {
    const { orgId } = req.user;
    const params = [orgId];
    const timeWindow = appendTimeWindow(params, req.dateRange);
    const result = await pool.query(
      `SELECT DISTINCT jsonb_object_keys(tags) as key
       FROM api_calls
       WHERE org_id = $1 AND tags != '{}'::jsonb
         AND ${timeWindow}
       ORDER BY key LIMIT 50`,
      params
    );
    res.json({ keys: result.rows.map(r => r.key) });
  } catch (err) {
    console.error('GET /api/metrics/tag-keys error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /tag-values — distinct values for a tag key ───────────────────────────
router.get('/tag-values', async (req, res) => {
  try {
    const { orgId } = req.user;
    const key = req.query.key?.trim();
    if (!key) return res.status(400).json({ error: 'key is required' });
    const params = [orgId, key];
    const timeWindow = appendTimeWindow(params, req.dateRange);
    const result = await pool.query(
      `SELECT DISTINCT tags->>$2 as value
       FROM api_calls
       WHERE org_id = $1 AND tags ? $2
         AND ${timeWindow}
       ORDER BY value LIMIT 100`,
      params
    );
    res.json({ values: result.rows.map(r => r.value).filter(v => v !== null) });
  } catch (err) {
    console.error('GET /api/metrics/tag-values error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /tag-breakdown — cost/requests grouped by tag value ───────────────────
router.get('/tag-breakdown', async (req, res) => {
  try {
    const { orgId } = req.user;
    const key = req.query.key?.trim();
    if (!key) return res.status(400).json({ error: 'key is required' });
    const params = [orgId, key];
    const timeWindow = appendTimeWindow(params, req.dateRange);
    const result = await pool.query(
      `SELECT tags->>$2 as value,
              COUNT(*) as requests,
              COALESCE(SUM(cost_usd), 0) as total_cost,
              COALESCE(SUM(total_tokens), 0) as total_tokens
       FROM api_calls
       WHERE org_id = $1 AND tags ? $2
         AND ${timeWindow}
       GROUP BY value ORDER BY total_cost DESC LIMIT 20`,
      params
    );
    res.json({ key, data: result.rows });
  } catch (err) {
    console.error('GET /api/metrics/tag-breakdown error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /project-breakdown — cost/requests grouped by observatory token name ──
router.get('/project-breakdown', async (req, res) => {
  try {
    const { orgId } = req.user;
    const params = [orgId];
    const timeWindow = appendTimeWindow(params, req.dateRange);
    const result = await pool.query(
      `SELECT token_name as value,
              COUNT(*) as requests,
              COALESCE(SUM(cost_usd), 0) as total_cost,
              COALESCE(SUM(total_tokens), 0) as total_tokens
       FROM api_calls
       WHERE org_id = $1 AND token_name IS NOT NULL
         AND ${timeWindow}
       GROUP BY value ORDER BY total_cost DESC LIMIT 20`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/metrics/project-breakdown error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /:id — single record ──────────────────────────────────────────────────
// ── GET /coverage — is the selected window fully covered by data? ────────────
// Accepts the same ?range / ?start / ?end as every other range endpoint (already
// validated by the router-level rangeMiddleware) and reports, for that window,
// whether the numbers may be incomplete and whether a provider sync could fill
// it. Read-only: it never triggers a sync. Must be registered before /:id.
router.get('/coverage', async (req, res) => {
  try {
    res.json(await computeCoverage(req.user.orgId, req.dateRange));
  } catch (err) {
    console.error('GET /api/metrics/coverage error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { orgId } = req.user;
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const result = await pool.query(
      'SELECT * FROM api_calls WHERE id = $1 AND org_id = $2',
      [id, orgId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
