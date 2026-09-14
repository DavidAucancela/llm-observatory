// Shared provider usage/cost fetching, used by both the historical sync route
// (routes/sync.js) and the reconciliation job (jobs/reconciliation.js).
//
// Two kinds of provider integration live here:
//  - fetch{Anthropic,OpenAI}Usage + summarizeBuckets: TOKEN usage, recomputed
//    to a dollar estimate via @llm-observatory/sdk pricing (through
//    services/pricingBridge). Used by sync.js (bulk historical import) and as
//    reconciliation's fallback when a real Costs API call fails.
//  - fetch{Anthropic,OpenAI}RealCost: the actual provider-billed dollar total
//    (OpenAI's /v1/organization/costs, Anthropic's
//    /v1/organizations/cost_report) — genuine ground truth, not a local
//    recomputation. This is reconciliation's primary source.

function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

const { costForProviderUsage } = require('./pricingBridge');

// The Anthropic org usage_report/messages result-row field for cache-write
// (cache_creation) tokens isn't pinned down in our fixtures, so accept both the
// flat `cache_creation_input_tokens` and a nested
// `cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`.
function anthropicCacheCreationTokens(result) {
  if (result.cache_creation_input_tokens != null) {
    return parseInt(result.cache_creation_input_tokens, 10) || 0;
  }
  const cc = result.cache_creation;
  if (cc && typeof cc === 'object') {
    return (parseInt(cc.ephemeral_5m_input_tokens, 10) || 0)
         + (parseInt(cc.ephemeral_1h_input_tokens, 10) || 0);
  }
  return 0;
}

async function fetchAnthropicUsage(adminKey, startDate, endDate) {
  const startStr = startDate.toISOString().split('.')[0] + 'Z';
  const endStr   = endDate.toISOString().split('.')[0] + 'Z';

  let allData = [], nextPage = null, hasMore = true;

  while (hasMore) {
    const url = new URL('https://api.anthropic.com/v1/organizations/usage_report/messages');
    url.searchParams.set('starting_at', startStr);
    url.searchParams.set('ending_at', endStr);
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.append('group_by[]', 'model');
    url.searchParams.set('limit', '31');
    if (nextPage) url.searchParams.set('page', nextPage);

    const res = await fetchWithTimeout(url.toString(), {
      headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' }
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);

    const data = await res.json();
    allData  = allData.concat(data.data || []);
    hasMore  = data.has_more || false;
    nextPage = data.next_page || null;
  }
  return allData;
}

async function fetchOpenAIUsage(apiKey, startDate, endDate) {
  const startTs = Math.floor(startDate.getTime() / 1000);
  const endTs   = Math.floor(endDate.getTime() / 1000);

  let allBuckets = [], page = null, hasMore = true;

  while (hasMore) {
    const url = new URL('https://api.openai.com/v1/organization/usage/completions');
    url.searchParams.set('start_time', startTs);
    url.searchParams.set('end_time', endTs);
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.append('group_by[]', 'model');
    url.searchParams.set('limit', 31);
    if (page) url.searchParams.set('page', page);

    const res = await fetchWithTimeout(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);

    const data  = await res.json();
    allBuckets  = allBuckets.concat(data.data || []);
    hasMore     = data.has_more || false;
    page        = data.next_page || null;
  }
  return allBuckets;
}

// Sums token-usage buckets into a single
// { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd },
// per-model, for the given provider. Pricing comes from services/pricingBridge
// (the SDK tables). `inputTokens` includes cache-read and cache-creation tokens;
// cache-creation carries the 1.25x Anthropic surcharge inside the bridge.
function summarizeBuckets(buckets, provider) {
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, costUsd = 0;

  for (const bucket of buckets) {
    for (const result of (bucket.results || [])) {
      const model = result.model || 'unknown';
      let uncachedInput, cacheReadInput, cacheCreationInput, output;

      if (provider === 'anthropic') {
        uncachedInput      = parseInt(result.uncached_input_tokens || 0, 10);
        cacheReadInput     = parseInt(result.cache_read_input_tokens || 0, 10);
        cacheCreationInput = anthropicCacheCreationTokens(result);
        output             = parseInt(result.output_tokens || 0, 10);
      } else {
        // OpenAI's usage API input_tokens already includes cached input; it has
        // no separate cache-write concept here.
        uncachedInput      = parseInt(result.input_tokens || 0, 10);
        cacheReadInput     = 0;
        cacheCreationInput = 0;
        output             = parseInt(result.output_tokens || 0, 10);
      }

      inputTokens      += uncachedInput + cacheReadInput + cacheCreationInput;
      outputTokens     += output;
      cacheReadTokens  += cacheReadInput;
      cacheWriteTokens += cacheCreationInput;
      costUsd += costForProviderUsage(provider, model, {
        uncachedInput, cacheReadInput, cacheCreationInput, output,
      });
    }
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd };
}

// Real provider-billed cost (USD) for the window — NOT a local recomputation.
// Anthropic's cost_report `amount` is a decimal string in the "lowest currency
// unit" (cents for USD) per their docs' own example ("123.45" -> $1.23), so it
// must be divided by 100. OpenAI's costs `amount.value` is already a plain
// USD float (confirmed via their cookbook example output) — no conversion.
async function fetchAnthropicRealCost(adminKey, startDate, endDate) {
  const startStr = startDate.toISOString().split('.')[0] + 'Z';
  const endStr   = endDate.toISOString().split('.')[0] + 'Z';

  let total = 0, nextPage = null, hasMore = true;

  while (hasMore) {
    const url = new URL('https://api.anthropic.com/v1/organizations/cost_report');
    url.searchParams.set('starting_at', startStr);
    url.searchParams.set('ending_at', endStr);
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('limit', '31');
    if (nextPage) url.searchParams.set('page', nextPage);

    const res = await fetchWithTimeout(url.toString(), {
      headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' }
    });
    if (!res.ok) throw new Error(`Anthropic cost_report API ${res.status}: ${await res.text()}`);

    const data = await res.json();
    for (const bucket of (data.data || [])) {
      for (const result of (bucket.results || [])) {
        total += parseFloat(result.amount || '0') / 100;
      }
    }
    hasMore  = data.has_more || false;
    nextPage = data.next_page || null;
  }
  return total;
}

async function fetchOpenAIRealCost(apiKey, startDate, endDate) {
  const startTs = Math.floor(startDate.getTime() / 1000);
  const endTs   = Math.floor(endDate.getTime() / 1000);

  let total = 0, page = null, hasMore = true;

  while (hasMore) {
    const url = new URL('https://api.openai.com/v1/organization/costs');
    url.searchParams.set('start_time', String(startTs));
    url.searchParams.set('end_time', String(endTs));
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('limit', '180');
    if (page) url.searchParams.set('page', page);

    const res = await fetchWithTimeout(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error(`OpenAI costs API ${res.status}: ${await res.text()}`);

    const data = await res.json();
    for (const bucket of (data.data || [])) {
      for (const result of (bucket.results || [])) {
        total += parseFloat(result.amount?.value || 0);
      }
    }
    hasMore = data.has_more || false;
    page    = data.next_page || null;
  }
  return total;
}

// ── xAI (Grok) ───────────────────────────────────────────────────────────────
// Verified 2026-09-06 against a live account (see the Fase 0 probe notes in
// the Grok integration plan) — the docs alone left three things ambiguous:
//
//  - Base URL is management-api.x.ai, NOT api.x.ai (that 404s on /v1/billing).
//    Auth is a "management key" (obtained xAI console → Settings →
//    Management Keys), a different credential from the `xai-…` inference key.
//  - `values[].name` accepts ONLY "usd" — "tokens" 400s with
//    "Failed to query_billing_items(), Invalid argument provided." So unlike
//    Anthropic/OpenAI, there is no independent token-level source here: usage
//    and billed cost come from the exact same call. That's why
//    services/providerRegistry.js registers Grok with no `usage` fallback —
//    if this call fails, reconciliation has nothing weaker to fall back to.
//  - `groupBy` accepts ONLY "description" — "model" 400s the same way. The
//    docs' own example value is "Chat grok-4-0709": free text with a category
//    prefix, not a clean model id. parseGrokUsageGroup() below extracts one.
//
// Money gotcha (same shape as Anthropic's cost_report, worse): xAI's amounts
// are in CENTS, and prepaid CREDIT is represented as a NEGATIVE number (a
// $5.00 top-up shows up as {"val": "-500"}, confirmed against a real account —
// don't "fix" the sign, it's how xAI's ledger works). Every dollar figure
// below divides by 100 and, for the balance only, takes the absolute value.
const XAI_MANAGEMENT_BASE = 'https://management-api.x.ai';

// xAI's timeRange wants "YYYY-MM-DD HH:MM:SS", not ISO-8601 — a trailing "T"
// or "Z" makes the request 400.
function toXaiTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// "Chat grok-4-0709" -> { category: "Chat", model: "grok-4-0709" }. The last
// space-separated token is the model candidate; everything before it is the
// service category (Chat, Image, Live Search, …).
//
// If the candidate doesn't look like a model id (no "grok"/"xai" — e.g. the
// candidate for "Live Search" is just "Search"), don't invent a model: label
// it `xai:<slug>` so that spend is still visible on the dashboard instead of
// silently vanishing. api_calls.model is VARCHAR(100), so the result is capped
// there too.
function parseGrokUsageGroup(group) {
  const raw = Array.isArray(group) ? group[0] : null;
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return { category: null, model: 'unknown' };
  }
  const parts = raw.trim().split(/\s+/);
  const candidate = parts[parts.length - 1];
  const category  = parts.length > 1 ? parts.slice(0, -1).join(' ') : null;

  if (/grok|xai/i.test(candidate)) {
    return { category, model: candidate.slice(0, 100) };
  }
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return { category, model: `xai:${slug}`.slice(0, 100) };
}

// Internal: the raw POST /usage call, split by day. `groupBy:['description']`
// is the only value verified to work; empty timeSeries is a legitimate
// "no usage in this window" response, not an error.
async function fetchGrokUsageSeries(managementKey, teamId, startDate, endDate) {
  const res = await fetchWithTimeout(`${XAI_MANAGEMENT_BASE}/v1/billing/teams/${teamId}/usage`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${managementKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      analyticsRequest: {
        timeRange: { startTime: toXaiTimestamp(startDate), endTime: toXaiTimestamp(endDate), timezone: 'Etc/GMT' },
        timeUnit:  'TIME_UNIT_DAY',
        values:    [{ name: 'usd', aggregation: 'AGGREGATION_SUM' }],
        groupBy:   ['description'],
        filters:   [],
      },
    }),
  });
  if (!res.ok) throw new Error(`xAI usage API ${res.status}: ${await res.text()}`);

  const data = await res.json();
  if (data.limitReached) {
    console.warn('[providerUsage] xAI usage query hit limitReached — results may be truncated for this window');
  }

  // { dayISO, model, category, costUsd }[], one row per (day, group) point.
  const rows = [];
  for (const series of (data.timeSeries || [])) {
    const { category, model } = parseGrokUsageGroup(series.group);
    for (const point of (series.dataPoints || [])) {
      const usd = Number(point.values?.[0]);
      if (!point.timestamp || !Number.isFinite(usd)) continue;
      rows.push({ dayISO: point.timestamp, model, category, costUsd: usd });
    }
  }
  return rows;
}

// Public: shaped for routes/sync.js's importBuckets, which already knows how
// to read `bucket.starting_at` + `bucket.results[]`. Each result carries
// `cost_usd` instead of token counts — importBuckets accepts that directly
// (see the "buckets solo-coste" handling added for Grok).
async function fetchGrokUsage(managementKey, teamId, startDate, endDate) {
  const rows = await fetchGrokUsageSeries(managementKey, teamId, startDate, endDate);
  const byDay = new Map();
  for (const row of rows) {
    if (!byDay.has(row.dayISO)) byDay.set(row.dayISO, []);
    byDay.get(row.dayISO).push({ model: row.model, cost_usd: row.costUsd });
  }
  return [...byDay.entries()].map(([starting_at, results]) => ({ starting_at, results }));
}

// Public: reconciliation's primary (and only) source for Grok — see the module
// comment above on why there's no token-based fallback for this provider.
async function fetchGrokRealCost(managementKey, teamId, startDate, endDate) {
  const rows = await fetchGrokUsageSeries(managementKey, teamId, startDate, endDate);
  return rows.reduce((sum, r) => sum + r.costUsd, 0);
}

// Prepaid credit balance. `total.val` is cents, negative-for-credit (see the
// module comment) — Math.abs() here turns "-500" into the $5.00 an operator
// actually wants to read as "money available to spend".
async function fetchGrokPrepaidBalance(managementKey, teamId) {
  const res = await fetchWithTimeout(`${XAI_MANAGEMENT_BASE}/v1/billing/teams/${teamId}/prepaid/balance`, {
    headers: { Authorization: `Bearer ${managementKey}` },
  });
  if (!res.ok) throw new Error(`xAI balance API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const rawCents = Number(data.total?.val ?? 0);

  const recentChanges = (data.changes || []).slice(0, 10).map(c => ({
    origin:      c.changeOrigin || null,
    amount_usd:  Math.abs(Number(c.amount?.val ?? 0)) / 100,
    invoice_id:  c.invoiceId || null,
    create_time: c.createTime || null,
  }));

  return {
    balance_usd:    Math.abs(rawCents) / 100,
    as_of:          new Date().toISOString(),
    recent_changes: recentChanges,
  };
}

// Validates a management key and, if a teamId is supplied, confirms the key
// actually belongs to that team and carries Billing read access — all in the
// one call the Fase 0 probe found (GET, not POST; the docs' example is wrong
// about the verb). This replaces what would otherwise be a second network call
// against /prepaid/balance just to check the team.
async function validateGrokManagementKey(managementKey, teamId) {
  const res = await fetchWithTimeout(`${XAI_MANAGEMENT_BASE}/auth/management-keys/validation`, {
    headers: { Authorization: `Bearer ${managementKey}` },
  });
  if (res.status === 401) return { valid: false, error: 'Management key inválida' };
  if (!res.ok) return { valid: false, error: `xAI Management API respondió ${res.status}` };

  const data = await res.json();
  const acls = Array.isArray(data.acls) ? data.acls : [];
  if (!acls.includes('team-token:endpoint:BillingRead')) {
    return { valid: false, error: 'Esta management key no tiene el permiso Billing → Read en xAI' };
  }
  if (!teamId) {
    return { valid: false, error: 'Falta el Team ID de xAI en esta credencial' };
  }
  if (data.teamId !== teamId) {
    return { valid: false, error: 'El Team ID no corresponde a esta management key' };
  }
  return { valid: true, error: null };
}

module.exports = {
  fetchWithTimeout, anthropicCacheCreationTokens,
  fetchAnthropicUsage, fetchOpenAIUsage, summarizeBuckets,
  fetchAnthropicRealCost, fetchOpenAIRealCost,
  parseGrokUsageGroup, toXaiTimestamp,
  fetchGrokUsage, fetchGrokRealCost, fetchGrokPrepaidBalance, validateGrokManagementKey,
};
