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
//   providers: [{ provider, syncable, hasAdminKey }]
// "Coverage" answers one question for the date filter: for the window the user
// DELIBERATELY picked (a custom range), is part of it outside the data we have,
// and can a sync fill it? It never hides data — partial data is still shown.
//
// Presets never raise it. It used to also flag every window ending after a
// provider's last sync ("sync gaps") — with syncing manual-only that was true
// of every window ending today, so the banner asked for a sync on every visit.
// Keeping recent days current is now the auto-sync's job (syncRunner.js).
function assessCoverage({ windowStartMs, windowEndMs, now, retention, firstDataMs, lastDataMs, providers, isCustom = false }) {
  const cutoff = retentionCutoffMs(now, retention);
  const hasData = firstDataMs != null;

  const beforeFirstData = hasData && windowStartMs < floorUtcDay(firstDataMs);
  // Compare against the raw retention edge, not the day-aligned `cutoff`: a
  // rolling preset that spans exactly the retention starts at now-R, which is
  // always a few hours before the next UTC midnight, and would be flagged on
  // every load though nothing in it was purged.
  const beyondRetention = windowStartMs < now - retention * DAY_MS;

  const syncable = providers.filter(p => p.syncable && p.hasAdminKey);

  const suggestStartMs = Math.max(windowStartMs, cutoff);
  const suggestEndMs   = hasData ? Math.min(windowEndMs, now, floorUtcDay(firstDataMs) - 1) : Math.min(windowEndMs, now);
  const canSync = isCustom && beforeFirstData && syncable.length > 0 && suggestStartMs <= suggestEndMs;

  return {
    has_data: hasData,
    first_data_at: hasData ? iso(firstDataMs) : null,
    last_data_at: lastDataMs != null ? iso(lastDataMs) : null,
    retention_days: retention,
    retention_cutoff: iso(cutoff),
    window: { start: iso(windowStartMs), end: iso(windowEndMs) },
    before_first_data: beforeFirstData,
    beyond_retention: beyondRetention,
    syncable_providers: syncable.map(p => p.provider),
    can_sync: canSync,
    suggested_sync: canSync ? { start: ymd(suggestStartMs), end: ymd(suggestEndMs) } : null,
    needs_attention: isCustom && (beforeFirstData || beyondRetention),
  };
}

async function loadCoverageInputs(orgId) {
  const syncCapable = providersWith('sync');
  const [rows, keys] = await Promise.all([
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
      `SELECT DISTINCT provider FROM provider_credentials WHERE org_id = $1 AND key_type = 'admin'`,
      [orgId]
    ),
  ]);
  const adminKeys = new Set(keys.rows.map(r => r.provider));
  return {
    firstDataMs: rows.rows[0].first_at ? new Date(rows.rows[0].first_at).getTime() : null,
    lastDataMs:  rows.rows[0].last_at  ? new Date(rows.rows[0].last_at).getTime()  : null,
    providers: syncCapable.map(p => ({ provider: p, syncable: true, hasAdminKey: adminKeys.has(p) })),
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
