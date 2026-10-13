// One place that runs a provider sync, used by both the Sync page
// (POST /api/sync/:provider, /refresh) and the scheduled auto-sync cron.
//
// Before this, a sync only ever ran when an admin pressed "Run" on the Sync
// page, so every window ending today was "past the last sync" and the coverage
// banner asked for a sync on every visit. The cron (index.js, AUTO_SYNC_CRON)
// now keeps each provider with an admin key current on its own; the Sync page
// is for looking at the state and importing older history.
//
// Every failure carries a `code` (+ `params`) the UI translates, so a limit
// (retention, provider lookback, missing key, sync already running…) reads as
// an explanation instead of a raw provider error dump.

const pool = require('../db/pool');
const { decrypt } = require('../db/crypto');
const { SYNC_PROVIDERS } = require('./providerRegistry');
const { importBuckets } = require('./syncImport');
const { resolveSyncWindow, earliestSyncableMs } = require('./syncWindow');
const { PROVIDERS, PROVIDER_CAPS, PROVIDER_LABELS, ADMIN_KEY_HELP, requiresAccountId } = require('../constants/providers');
const { RangeParamError } = require('../utils/dateRange');
const { DAY_MS, retentionDays, floorUtcDay, retentionCutoffMs } = require('../utils/retention');

// A run still 'running' after this long lost its process (a deploy/restart
// kills the in-flight promise and nothing ever updates the row) — it's marked
// 'interrupted' instead of blocking new syncs and showing "in progress" forever.
const STALE_RUN_MS = 30 * 60 * 1000;

// Scheduled refresh: every 6 hours at :15 UTC (clear of the 02:00 purge and the
// 03:30 reconciliation). A provider that never synced gets its first
// AUTO_INITIAL_DAYS imported; after that each run re-fetches from the last
// synced day (that day was partial when it was imported) up to now.
const AUTO_SYNC_CRON = '15 */6 * * *';
const AUTO_SYNC_HOURS = [0, 6, 12, 18];
const AUTO_INITIAL_DAYS = 90;

const autoSyncEnabled = () => process.env.AUTO_SYNC_ENABLED !== 'false';
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

class SyncError extends Error {
  constructor(code, message, { params = {}, status = 400, detail = null } = {}) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.params = params;
    this.status = status;
    this.detail = detail;
  }
}

// Maps a provider fetch failure to a code the UI can explain. The raw message
// is still stored (error_message) for debugging.
function classifyProviderError(err) {
  const msg = String(err?.message || '');
  if (/reporting_lookback_exceeded/i.test(msg)) return 'provider_lookback';
  if (/ API (401|403):/.test(msg)) return 'provider_auth';
  if (/ API 429:/.test(msg)) return 'provider_rate_limit';
  if (/ API 5\d\d:/.test(msg)) return 'provider_unavailable';
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'].includes(err?.code) || /fetch failed/i.test(msg)) {
    return 'provider_unreachable';
  }
  return 'sync_failed';
}

// Marks abandoned runs. `all: true` is for startup: this single API process
// just (re)started, so nothing can still be running.
async function markStaleRuns({ orgId = null, all = false } = {}) {
  const params = [];
  let where = `status = 'running'`;
  if (!all) {
    params.push(STALE_RUN_MS / 1000);
    where += ` AND started_at < NOW() - make_interval(secs => $${params.length})`;
  }
  if (orgId != null) {
    params.push(orgId);
    where += ` AND org_id = $${params.length}`;
  }
  const r = await pool.query(
    `UPDATE sync_logs
     SET status = 'error', error_code = 'interrupted', completed_at = NOW(),
         error_message = 'Interrupted (server restarted or timed out) before finishing'
     WHERE ${where}`,
    params
  );
  return r.rowCount;
}

async function loadAdminCred(orgId, provider) {
  const r = await pool.query(
    `SELECT api_key_encrypted, provider_account_id FROM provider_credentials
     WHERE org_id = $1 AND provider = $2 AND key_type = 'admin'
     ORDER BY created_at DESC LIMIT 1`,
    [orgId, provider]
  );
  const label = PROVIDER_LABELS[provider] || provider;
  if (!r.rows.length) {
    throw new SyncError('no_admin_key', 'Admin key not configured for this provider. Add it in Settings.', {
      params: { provider: label }, detail: ADMIN_KEY_HELP[provider] || null,
    });
  }
  const { api_key_encrypted, provider_account_id } = r.rows[0];
  if (requiresAccountId(provider) && !provider_account_id) {
    throw new SyncError('missing_account_id', 'Falta el Team ID en la credencial admin.', {
      params: { provider: label }, detail: ADMIN_KEY_HELP[provider] || null,
    });
  }
  return { apiKey: decrypt(api_key_encrypted), accountId: provider_account_id };
}

// Validates and starts one sync. Resolves once the run is recorded (so the
// caller can answer the HTTP request); `done` settles when the import finishes.
async function startSync({ orgId, provider, start, end, days, trigger = 'manual', now = Date.now() }) {
  const entry = SYNC_PROVIDERS[provider];
  if (!entry) {
    throw new SyncError('unsupported_provider', `Proveedor no soportado. Usa: ${Object.keys(SYNC_PROVIDERS).join(', ')}`, {
      params: { provider },
    });
  }
  const label = PROVIDER_LABELS[provider] || provider;

  let window;
  try {
    window = resolveSyncWindow({ start, end, days }, {
      now, lookbackDays: PROVIDER_CAPS[provider]?.syncLookbackDays ?? null, providerLabel: label,
    });
  } catch (err) {
    if (err instanceof RangeParamError) throw new SyncError(err.code, err.message, { params: err.params });
    throw err;
  }

  const cred = await loadAdminCred(orgId, provider);

  await markStaleRuns({ orgId });
  const running = await pool.query(
    `SELECT id FROM sync_logs WHERE org_id = $1 AND provider = $2 AND status = 'running' LIMIT 1`,
    [orgId, provider]
  );
  if (running.rows.length) {
    throw new SyncError('already_running', `A ${label} sync is already running`, { params: { provider: label }, status: 409 });
  }

  const { startDate, endDate } = window;
  const warnings = window.warnings.map(({ code, params }) => ({ code, params }));
  // The requested window is recorded up front so the UI can show what a
  // still-running (or failed) sync was asked to cover; success overwrites it
  // with the window the provider fetcher actually used.
  const logRow = await pool.query(
    `INSERT INTO sync_logs (org_id, provider, status, date_range_start, date_range_end, trigger, details)
     VALUES ($1, $2, 'running', $3, $4, $5, $6) RETURNING id`,
    [orgId, provider, startDate.toISOString(), endDate.toISOString(), trigger, JSON.stringify({ warnings })]
  );
  const syncId = logRow.rows[0].id;

  const done = (async () => {
    try {
      const { buckets, startISO, endISO } = await entry.fetchBuckets(cred, startDate, endDate);
      const stats = {};
      const imported = await importBuckets(buckets, provider, orgId, startISO, endISO, { clampDayTotal: entry.clampDayTotal, stats });
      // An empty bucket list is a degraded/empty fetch (importBuckets leaves
      // existing rows alone): still a completed run, but say so instead of a
      // bare success that looks the same as "nothing new to import".
      const empty = !Array.isArray(buckets) || buckets.length === 0;
      const skipped = [...(stats.skippedModels || [])].sort();
      await pool.query(
        `UPDATE sync_logs
         SET status = 'success', completed_at = NOW(), records_synced = $1,
             date_range_start = $2, date_range_end = $3, error_message = NULL, error_code = NULL,
             details = $5
         WHERE id = $4`,
        [imported, startISO, endISO, syncId, JSON.stringify({ warnings, skipped_models: skipped, empty })]
      );
      console.log(`[sync] ${provider} (${trigger}) org ${orgId}: ${imported} records imported`);
      return { status: 'success', imported };
    } catch (err) {
      await pool.query(
        `UPDATE sync_logs SET status = 'error', completed_at = NOW(), error_message = $1, error_code = $2 WHERE id = $3`,
        [err.message, classifyProviderError(err), syncId]
      ).catch(() => {});
      console.error(`[sync] ${provider} (${trigger}) org ${orgId} error:`, err.message);
      return { status: 'error', error: err.message };
    }
  })();

  return { syncId, window, warnings, done };
}

// The window an incremental refresh should cover: from the last synced day
// (re-fetched, it was partial when imported) to now, or the first
// AUTO_INITIAL_DAYS when the provider never synced.
async function incrementalRange(orgId, provider, now = Date.now()) {
  const r = await pool.query(
    `SELECT MAX(date_range_end) AS last_end FROM sync_logs
     WHERE org_id = $1 AND provider = $2 AND status = 'success'`,
    [orgId, provider]
  );
  const lastEnd = r.rows[0].last_end ? new Date(r.rows[0].last_end).getTime() : null;
  const startMs = lastEnd != null
    ? floorUtcDay(Math.min(lastEnd, now)) - DAY_MS
    : floorUtcDay(now) - AUTO_INITIAL_DAYS * DAY_MS;
  return { start: ymd(startMs), end: ymd(now) };
}

// Admin-key credentials for every sync-capable provider, across all orgs.
// The cron (orgId null) skips the public demo org: its admin keys are fake
// (seed-demo.js) and would log a failed run every few hours.
async function eligiblePairs(orgId = null) {
  const params = [Object.keys(SYNC_PROVIDERS)];
  let where = `pc.key_type = 'admin' AND pc.provider = ANY($1)`;
  if (orgId != null) { params.push(orgId); where += ` AND pc.org_id = $2`; }
  else where += ` AND o.slug IS DISTINCT FROM 'demo'`;
  const r = await pool.query(
    `SELECT DISTINCT pc.org_id, pc.provider FROM provider_credentials pc
     JOIN organizations o ON o.id = pc.org_id
     WHERE ${where} ORDER BY pc.org_id, pc.provider`,
    params
  );
  return r.rows;
}

// Incremental refresh of every eligible provider for one org (the Sync page's
// "Update now"), or for all orgs (the cron, `orgId` null). Runs one at a time
// so a big org doesn't fire every provider API at once.
async function refreshAll({ orgId = null, trigger = 'auto', wait = true, now = Date.now() } = {}) {
  const results = [];
  for (const { org_id: oid, provider } of await eligiblePairs(orgId)) {
    try {
      const range = await incrementalRange(oid, provider, now);
      const run = await startSync({ orgId: oid, provider, ...range, trigger, now });
      results.push({ org_id: oid, provider, status: 'started', sync_id: run.syncId, warnings: run.warnings,
        window: { start: run.window.startDate.toISOString(), end: run.window.endDate.toISOString() } });
      if (wait) await run.done;
    } catch (err) {
      if (!(err instanceof SyncError)) console.error(`[sync] refresh ${provider} org ${oid}:`, err.message);
      results.push({ org_id: oid, provider, status: 'skipped', code: err.code || 'sync_failed', params: err.params || {}, error: err.message });
    }
  }
  return results;
}

function nextAutoSyncAt(now = Date.now()) {
  const d = new Date(now);
  for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
    for (const h of AUTO_SYNC_HOURS) {
      const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dayOffset, h, 15);
      if (t > now) return new Date(t).toISOString();
    }
  }
  return null;
}

// Everything the Sync page needs to explain what data exists and what can be
// imported, per provider, in one call.
async function syncOverview(orgId, now = Date.now()) {
  await markStaleRuns({ orgId });
  const retention = retentionDays();

  const [creds, data, orgData, logs] = await Promise.all([
    pool.query(
      `SELECT DISTINCT ON (provider) provider, provider_account_id FROM provider_credentials
       WHERE org_id = $1 AND key_type = 'admin' ORDER BY provider, created_at DESC`,
      [orgId]
    ),
    // Ping/judge rows are bookkeeping, not usage.
    pool.query(
      `SELECT provider,
              MIN(timestamp) AS first_at, MAX(timestamp) AS last_at,
              COUNT(*) FILTER (WHERE prompt_preview LIKE 'sync:%')        AS sync_rows,
              COUNT(*) FILTER (WHERE prompt_preview IS NULL
                                  OR prompt_preview NOT LIKE 'sync:%')    AS live_rows
       FROM api_calls
       WHERE org_id = $1
         AND (prompt_preview IS NULL OR (prompt_preview NOT LIKE 'test:%' AND prompt_preview <> 'eval:judge'))
       GROUP BY provider`,
      [orgId]
    ),
    pool.query(
      `SELECT MIN(timestamp) AS first_at, MAX(timestamp) AS last_at FROM api_calls
       WHERE org_id = $1
         AND (prompt_preview IS NULL OR (prompt_preview NOT LIKE 'test:%' AND prompt_preview <> 'eval:judge'))`,
      [orgId]
    ),
    pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (provider) 'latest' AS kind, provider, id, status, trigger, error_code, error_message, details,
                started_at, completed_at, date_range_start, date_range_end, records_synced
         FROM sync_logs WHERE org_id = $1 ORDER BY provider, started_at DESC
       ) latest
       UNION ALL
       SELECT * FROM (
         SELECT DISTINCT ON (provider) 'last_ok' AS kind, provider, id, status, trigger, error_code, error_message, details,
                started_at, completed_at, date_range_start, date_range_end, records_synced
         FROM sync_logs WHERE org_id = $1 AND status = 'success' ORDER BY provider, completed_at DESC
       ) last_ok`,
      [orgId]
    ),
  ]);

  const credBy = Object.fromEntries(creds.rows.map(r => [r.provider, r]));
  const dataBy = Object.fromEntries(data.rows.map(r => [r.provider, r]));
  // Every sync-capable provider, plus SDK-only ones (Gemini, Kimi…) that have
  // data — so this page shows all the stored history, not just what can sync.
  const providers = PROVIDERS.filter(p => SYNC_PROVIDERS[p] || dataBy[p]);
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  const shapeLog = (l) => l && ({
    id: l.id, status: l.status, trigger: l.trigger || 'manual', error_code: l.error_code, error_message: l.error_message,
    details: l.details || {}, started_at: iso(l.started_at), completed_at: iso(l.completed_at),
    start: iso(l.date_range_start), end: iso(l.date_range_end), records: l.records_synced || 0,
  });

  const autoOn = autoSyncEnabled();
  return {
    today: ymd(now),
    retention_days: retention,
    retention_cutoff: ymd(retentionCutoffMs(now, retention)),
    first_data_at: iso(orgData.rows[0].first_at),
    last_data_at: iso(orgData.rows[0].last_at),
    auto_sync: { enabled: autoOn, every_hours: 24 / AUTO_SYNC_HOURS.length, next_run_at: autoOn ? nextAutoSyncAt(now) : null, initial_days: AUTO_INITIAL_DAYS },
    providers: providers.map(p => {
      const lookbackDays = PROVIDER_CAPS[p]?.syncLookbackDays ?? null;
      const cred = credBy[p];
      const d = dataBy[p];
      const latest = logs.rows.find(l => l.provider === p && l.kind === 'latest') || null;
      const lastOk = logs.rows.find(l => l.provider === p && l.kind === 'last_ok') || null;
      return {
        provider: p,
        label: PROVIDER_LABELS[p] || p,
        syncable: Boolean(SYNC_PROVIDERS[p]),
        has_admin_key: Boolean(cred),
        missing_account_id: Boolean(cred) && requiresAccountId(p) && !cred.provider_account_id,
        admin_key_help: ADMIN_KEY_HELP[p] || null,
        lookback_days: lookbackDays,
        earliest_syncable: ymd(earliestSyncableMs({ now, retention, lookbackDays })),
        data: d ? { first_at: iso(d.first_at), last_at: iso(d.last_at), live_rows: Number(d.live_rows), sync_rows: Number(d.sync_rows) } : null,
        latest: shapeLog(latest),
        last_success: shapeLog(lastOk),
        running: latest?.status === 'running',
      };
    }),
  };
}

module.exports = {
  SyncError, startSync, refreshAll, incrementalRange, markStaleRuns, syncOverview,
  classifyProviderError, nextAutoSyncAt, autoSyncEnabled,
  AUTO_SYNC_CRON, AUTO_INITIAL_DAYS, STALE_RUN_MS,
};
