const pool = require('../db/pool');
const { providersWith } = require('../constants/providers');
const { DAY_MS, retentionDays, floorUtcDay, retentionCutoffMs } = require('../utils/retention');

const RANGE_MS = { '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, '60d': 60 * DAY_MS, '90d': 90 * DAY_MS };

const iso  = (ms) => new Date(ms).toISOString();
const ymd  = (ms) => iso(ms).slice(0, 10);

// Resolves a parsed req.dateRange into concrete UTC instants. `range=all` has no
// start of its own: it begins at the earliest row (or `now` if there is none).
function resolveWindow(dr, now, firstDataMs) {
  if (dr.custom) return { startMs: Date.parse(dr.start), endMs: Date.parse(dr.end) };
  if (dr.range === 'all') return { startMs: firstDataMs ?? now, endMs: now };
  return { startMs: now - RANGE_MS[dr.range], endMs: now };
}

// Pure decision logic (no DB) so it can be tested with plain numbers.
//   providers: [{ provider, syncable, hasAdminKey, sync: { fromMs, toMs } | null }]
// "Coverage" here answers one question for the date filter: for the window the
// user picked, is there a reason the numbers might be incomplete, and can a
// provider sync fill it? It never hides data — partial data is still shown.
function assessCoverage({ windowStartMs, windowEndMs, now, retention, firstDataMs, lastDataMs, providers, isCustom = false }) {
  const cutoff = retentionCutoffMs(now, retention);
  const hasData = firstDataMs != null;

  const beforeFirstData = hasData && windowStartMs < floorUtcDay(firstDataMs);
  // Compare against the raw retention edge, not the day-aligned `cutoff`: a
  // rolling preset that spans exactly the retention (e.g. 90d with 90-day
  // retention) starts at now-R, which is always a few hours before the next UTC
  // midnight, and would be flagged on every load though nothing in it was purged.
  // (`cutoff` still bounds what a sync can usefully import, below.)
  const beyondRetention = windowStartMs < now - retention * DAY_MS;

  const syncable = providers.filter(p => p.syncable && p.hasAdminKey);

  // A provider that HAS synced before but whose last sync doesn't reach the
  // window. Providers that never synced are not flagged here: an org that only
  // uses the SDK has no gap to fill, and nagging it would be noise (the
  // before_first_data flag still covers "older than anything we have").
  const syncGaps = syncable
    .filter(p => p.sync)
    .map(p => ({
      provider: p.provider,
      synced_from: iso(p.sync.fromMs),
      synced_to: iso(p.sync.toMs),
      missing_before: windowStartMs >= cutoff && windowStartMs < floorUtcDay(p.sync.fromMs),
      missing_after: windowEndMs > p.sync.toMs + DAY_MS,
    }))
    .filter(g => g.missing_before || g.missing_after);

  const suggestStartMs = Math.max(windowStartMs, cutoff);
  const suggestEndMs   = Math.min(windowEndMs, now);
  const worthFilling   = (beforeFirstData && suggestStartMs < floorUtcDay(firstDataMs)) || syncGaps.length > 0;
  const canSync        = syncable.length > 0 && suggestStartMs <= suggestEndMs && worthFilling;

  return {
    has_data: hasData,
    first_data_at: hasData ? iso(firstDataMs) : null,
    last_data_at: lastDataMs != null ? iso(lastDataMs) : null,
    retention_days: retention,
    retention_cutoff: iso(cutoff),
    window: { start: iso(windowStartMs), end: iso(windowEndMs) },
    before_first_data: beforeFirstData,
    beyond_retention: beyondRetention,
    sync_gaps: syncGaps,
    syncable_providers: syncable.map(p => p.provider),
    can_sync: canSync,
    suggested_sync: canSync ? { start: ymd(suggestStartMs), end: ymd(suggestEndMs) } : null,
    // "Before the first record" alone is only worth a banner when it's a window
    // the user deliberately picked, or when an admin key exists that could fill
    // it. Otherwise every 7d/30d preset would nag an org that simply started
    // sending data yesterday and has nothing older to sync.
    needs_attention: (beforeFirstData && (isCustom || canSync)) || beyondRetention || syncGaps.length > 0,
  };
}

async function loadCoverageInputs(orgId) {
  const syncCapable = providersWith('sync');
  const [rows, syncs, keys] = await Promise.all([
    // Ping/judge rows are bookkeeping, not usage: they'd fake "data starts here".
    pool.query(
      `SELECT MIN(timestamp) AS first_at, MAX(timestamp) AS last_at
       FROM api_calls
       WHERE org_id = $1
         AND (prompt_preview IS NULL
              OR (prompt_preview NOT LIKE 'test:%' AND prompt_preview <> 'eval:judge'))`,
      [orgId]
    ),
    pool.query(
      `SELECT DISTINCT ON (provider) provider, date_range_start, date_range_end
       FROM sync_logs
       WHERE org_id = $1 AND status = 'success' AND date_range_start IS NOT NULL AND date_range_end IS NOT NULL
       ORDER BY provider, completed_at DESC`,
      [orgId]
    ),
    pool.query(
      `SELECT DISTINCT provider FROM provider_credentials WHERE org_id = $1 AND key_type = 'admin'`,
      [orgId]
    ),
  ]);

  const syncByProvider = Object.fromEntries(syncs.rows.map(r => [r.provider, {
    fromMs: new Date(r.date_range_start).getTime(),
    toMs:   new Date(r.date_range_end).getTime(),
  }]));
  const adminKeys = new Set(keys.rows.map(r => r.provider));

  return {
    firstDataMs: rows.rows[0].first_at ? new Date(rows.rows[0].first_at).getTime() : null,
    lastDataMs:  rows.rows[0].last_at  ? new Date(rows.rows[0].last_at).getTime()  : null,
    providers: syncCapable.map(p => ({
      provider: p, syncable: true, hasAdminKey: adminKeys.has(p), sync: syncByProvider[p] || null,
    })),
  };
}

async function computeCoverage(orgId, dr, now = Date.now()) {
  const inputs = await loadCoverageInputs(orgId);
  const { startMs, endMs } = resolveWindow(dr, now, inputs.firstDataMs);
  return assessCoverage({
    windowStartMs: startMs, windowEndMs: endMs, now, retention: retentionDays(),
    isCustom: Boolean(dr.custom), ...inputs,
  });
}

module.exports = { assessCoverage, computeCoverage, resolveWindow };
