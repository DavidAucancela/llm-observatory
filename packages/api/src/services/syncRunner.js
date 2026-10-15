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
const { sendSyncDiscordAlert } = require('./syncAlerts');

// A run still 'running' after this long lost its process (a deploy/restart
// kills the in-flight promise and nothing ever updates the row) — it's marked
// 'interrupted' instead of blocking new syncs and showing "in progress" forever.
const STALE_RUN_MS = 30 * 60 * 1000;

// Scheduled refresh: every 6 hours at :15 UTC (clear of the 02:00 purge and the
// 03:30 reconciliation). A provider that never synced gets everything it still
// holds imported (retention + its own lookback — OpenAI forgets usage after a
// year, so a shorter first import would lose that history for good); after
// that each run re-fetches from the last synced day (that day was partial when
// it was imported) up to now.
const AUTO_SYNC_CRON = '15 */6 * * *';
const AUTO_SYNC_HOURS = [0, 6, 12, 18];

// Only one API instance runs the cron's sweep (pg_try_advisory_lock), so a
// second replica doesn't fire every provider API twice. Arbitrary constant.
const AUTO_SYNC_LOCK_KEY = 74_110_601;

// A window is fetched in day-aligned chunks of this size: each chunk is
// retried on its own, imported as soon as it lands (a failure late in a 3-year
// import keeps what came before) and advances the progress shown on the page.
const CHUNK_DAYS = 31;

// Back-off before retrying a chunk that failed for a transient reason (rate
// limit, provider 5xx, network). Instant under Jest.
const RETRY_DELAYS_MS = process.env.NODE_ENV === 'test' ? [0, 0] : [2000, 8000];
const RETRYABLE = new Set(['provider_rate_limit', 'provider_unavailable', 'provider_unreachable']);

// Consecutive failed runs of one provider before the bell + Discord are told
// (one failure is often a blip the next run fixes).
const FAILURES_BEFORE_ALERT = 2;

// The overview warns about rows the retention purge deletes within this window.
const EXPIRING_WINDOW_DAYS = 30;

// Live progress for the Sync page. index.js wires this to socket.io and
// delivers it to the run's org room only (services/realtime.js) — never a
// broadcast. The payload carries no data — only enough for a page that
// already shows this run to update, or to know it should refetch its overview.
// Signature: emitSyncUpdate(orgId, payload).
let emitSyncUpdate = () => {};
function setSyncEmitter(fn) { emitSyncUpdate = typeof fn === 'function' ? fn : () => {}; }

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
  const { startDate, endDate } = window;
  const warnings = window.warnings.map(({ code, params }) => ({ code, params }));
  const chunks = dayChunks(startDate, endDate);
  // The requested window is recorded up front so the UI can show what a
  // still-running (or failed) sync was asked to cover; success overwrites it
  // with the window the provider fetcher actually used.
  let syncId;
  try {
    const logRow = await pool.query(
      `INSERT INTO sync_logs (org_id, provider, status, date_range_start, date_range_end, trigger, details)
       VALUES ($1, $2, 'running', $3, $4, $5, $6) RETURNING id`,
      [orgId, provider, startDate.toISOString(), endDate.toISOString(), trigger,
        JSON.stringify({ warnings, progress: { done: 0, total: chunks.length } })]
    );
    syncId = logRow.rows[0].id;
  } catch (err) {
    // idx_sync_logs_one_running: one running row per (org, provider), so two
    // clicks / two replicas can't both get past this point.
    if (err.code === '23505') {
      throw new SyncError('already_running', `A ${label} sync is already running`, { params: { provider: label }, status: 409 });
    }
    throw err;
  }
  emitSyncUpdate(orgId, { sync_id: syncId, provider, status: 'running', progress: { done: 0, total: chunks.length } });

  const done = (async () => {
    let imported = 0;
    let fetchedAny = false;
    const skippedSet = new Set();
    let firstISO = null, lastISO = null;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const [cs, ce] = chunks[i];
        const { buckets, startISO, endISO } = await fetchWithRetry(entry, cred, cs, ce);
        const stats = {};
        imported += await importBuckets(buckets, provider, orgId, startISO, endISO, { clampDayTotal: entry.clampDayTotal, stats });
        if (Array.isArray(buckets) && buckets.length) fetchedAny = true;
        for (const m of stats.skippedModels || []) skippedSet.add(m);
        firstISO ??= startISO;
        lastISO = endISO;
        const progress = { done: i + 1, total: chunks.length };
        if (i + 1 < chunks.length) {
          await pool.query(
            `UPDATE sync_logs SET records_synced = $1, details = details || $2::jsonb WHERE id = $3`,
            [imported, JSON.stringify({ progress }), syncId]
          );
          emitSyncUpdate(orgId, { sync_id: syncId, provider, status: 'running', progress });
        }
      }
      // An empty fetch is a degraded/empty response (importBuckets leaves
      // existing rows alone): still a completed run, but say so instead of a
      // bare success that looks the same as "nothing new to import".
      const empty = !fetchedAny;
      const skipped = [...skippedSet].sort();
      const newSkipped = await newlySkippedModels(orgId, provider, skipped);
      const details = { warnings, skipped_models: skipped, empty, progress: { done: chunks.length, total: chunks.length } };
      if (newSkipped.length) {
        details.new_skipped_models = newSkipped;
        details.discord = await sendSyncDiscordAlert(orgId, provider, {
          title: `💲 Modelos sin precio — ${label}`,
          description: `La sincronización de **${label}** encontró uso de modelos sin precio conocido; ese costo no se está contabilizando.`,
          fields: [{ name: 'Modelos', value: newSkipped.join(', ').slice(0, 1000) }],
        });
      }
      await pool.query(
        `UPDATE sync_logs
         SET status = 'success', completed_at = NOW(), records_synced = $1,
             date_range_start = $2, date_range_end = $3, error_message = NULL, error_code = NULL,
             details = $5
         WHERE id = $4`,
        [imported, firstISO, lastISO, syncId, JSON.stringify(details)]
      );
      emitSyncUpdate(orgId, { sync_id: syncId, provider, status: 'success', progress: details.progress });
      console.log(`[sync] ${provider} (${trigger}) org ${orgId}: ${imported} records imported`);
      return { status: 'success', imported };
    } catch (err) {
      const code = classifyProviderError(err);
      // Chunks imported before the failure stay imported (records_synced says
      // how many); the run is still an error, so the next refresh restarts
      // from the last *successful* run's end and re-covers them idempotently.
      const alert = await failureAlert(orgId, provider, label, code, err.message).catch((e) => {
        console.error(`[sync] failure alert ${provider} org ${orgId}:`, e.message);
        return {};
      });
      await pool.query(
        `UPDATE sync_logs SET status = 'error', completed_at = NOW(), records_synced = $1,
                error_message = $2, error_code = $3, details = details || $5::jsonb
         WHERE id = $4`,
        [imported, err.message, code, syncId, JSON.stringify(alert)]
      ).catch(() => {});
      emitSyncUpdate(orgId, { sync_id: syncId, provider, status: 'error' });
      console.error(`[sync] ${provider} (${trigger}) org ${orgId} error:`, err.message);
      return { status: 'error', error: err.message };
    }
  })();

  return { syncId, window, warnings, done };
}

// [start, end] split into consecutive day-aligned [chunkStart, chunkEnd]
// pairs of at most CHUNK_DAYS days (start is midnight UTC — resolveSyncWindow
// aligns it).
function dayChunks(startDate, endDate, chunkDays = CHUNK_DAYS) {
  const out = [];
  const endMs = endDate.getTime();
  for (let s = startDate.getTime(); s <= endMs; s += chunkDays * DAY_MS) {
    out.push([new Date(s), new Date(Math.min(s + chunkDays * DAY_MS - 1, endMs))]);
  }
  return out;
}

async function fetchWithRetry(entry, cred, start, end) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await entry.fetchBuckets(cred, start, end);
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !RETRYABLE.has(classifyProviderError(err))) throw err;
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

// Models skipped by this run that the provider's previous successful run did
// not already report — those are what's worth a notification (the same
// unpriced model would otherwise re-notify every 6 hours).
async function newlySkippedModels(orgId, provider, skipped) {
  if (!skipped.length) return [];
  const r = await pool.query(
    `SELECT details FROM sync_logs
     WHERE org_id = $1 AND provider = $2 AND status = 'success'
     ORDER BY completed_at DESC LIMIT 1`,
    [orgId, provider]
  );
  const before = new Set(r.rows[0]?.details?.skipped_models || []);
  return skipped.filter(m => !before.has(m));
}

// For a run that just failed (its row is still 'running'): once the provider
// has failed FAILURES_BEFORE_ALERT runs in a row counting this one
// (interruptions by a restart don't count), tell Discord and return the
// details that flag this run for the bell. Exactly at the threshold, so a key
// that stays broken notifies once, not every 6 hours.
async function failureAlert(orgId, provider, label, code, message) {
  const r = await pool.query(
    `SELECT status FROM sync_logs
     WHERE org_id = $1 AND provider = $2 AND status <> 'running'
       AND (error_code IS NULL OR error_code <> 'interrupted')
     ORDER BY started_at DESC, id DESC LIMIT $3`,
    [orgId, provider, FAILURES_BEFORE_ALERT]
  );
  let streak = 1;
  for (const row of r.rows) { if (row.status !== 'error') break; streak++; }
  if (streak !== FAILURES_BEFORE_ALERT) return {};
  const discord = await sendSyncDiscordAlert(orgId, provider, {
    severity: 'error',
    title: `⛔ La sincronización de ${label} está fallando`,
    description: code === 'provider_auth'
      ? `${label} rechazó la admin key ${streak} veces seguidas. Revísala en Claves; hasta entonces no se importa el uso del proveedor.`
      : `Las últimas ${streak} sincronizaciones de ${label} fallaron. Revisa el registro en la página Sincronización.`,
    fields: [{ name: 'Último error', value: String(message).slice(0, 500) }],
  });
  return { alert: 'repeated_failure', failures: streak, discord };
}

// The window an incremental refresh should cover: from the last synced day
// (re-fetched, it was partial when imported) to now, or — when the provider
// never synced — everything it still holds (retention + its own lookback).
async function incrementalRange(orgId, provider, now = Date.now()) {
  const r = await pool.query(
    `SELECT MAX(date_range_end) AS last_end FROM sync_logs
     WHERE org_id = $1 AND provider = $2 AND status = 'success'`,
    [orgId, provider]
  );
  const lastEnd = r.rows[0].last_end ? new Date(r.rows[0].last_end).getTime() : null;
  const startMs = lastEnd != null
    ? floorUtcDay(Math.min(lastEnd, now)) - DAY_MS
    : earliestSyncableMs({ now, retention: retentionDays(), lookbackDays: PROVIDER_CAPS[provider]?.syncLookbackDays ?? null });
  return { start: ymd(startMs), end: ymd(now), initial: lastEnd == null };
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
// so a big org doesn't fire every provider API at once. The all-orgs sweep
// holds a Postgres advisory lock for its duration: a second API replica finds
// it taken and returns `{ locked: true }` without doing anything.
async function refreshAll({ orgId = null, ...opts } = {}) {
  if (orgId != null) return runRefresh({ orgId, ...opts });
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [AUTO_SYNC_LOCK_KEY]);
    if (!rows[0].ok) return Object.assign([], { locked: true });
    try {
      return await runRefresh({ orgId: null, ...opts });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [AUTO_SYNC_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function runRefresh({ orgId, trigger = 'auto', wait = true, now = Date.now() }) {
  const results = [];
  for (const { org_id: oid, provider } of await eligiblePairs(orgId)) {
    try {
      const { start, end } = await incrementalRange(oid, provider, now);
      const run = await startSync({ orgId: oid, provider, start, end, trigger, now });
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
  const cutoffMs = retentionCutoffMs(now, retention);
  const expiringBeforeMs = cutoffMs + EXPIRING_WINDOW_DAYS * DAY_MS;

  const [creds, data, orgData, logs, expiring] = await Promise.all([
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
    // What the 02:00 retention purge will delete within EXPIRING_WINDOW_DAYS.
    pool.query(
      `SELECT COUNT(*) AS n FROM api_calls WHERE org_id = $1 AND timestamp < $2`,
      [orgId, new Date(expiringBeforeMs).toISOString()]
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
    retention_cutoff: ymd(cutoffMs),
    expiring: { within_days: EXPIRING_WINDOW_DAYS, before: ymd(expiringBeforeMs), rows: Number(expiring.rows[0].n) },
    first_data_at: iso(orgData.rows[0].first_at),
    last_data_at: iso(orgData.rows[0].last_at),
    auto_sync: { enabled: autoOn, every_hours: 24 / AUTO_SYNC_HOURS.length, next_run_at: autoOn ? nextAutoSyncAt(now) : null },
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

// First import right after an admin key is saved (POST /api/credentials), so
// the history shows up now instead of at the next cron tick. Fire-and-forget:
// every outcome lands in sync_logs like any other run.
async function startInitialImport(orgId, provider) {
  if (!SYNC_PROVIDERS[provider] || !autoSyncEnabled()) return null;
  try {
    const { start, end } = await incrementalRange(orgId, provider);
    const run = await startSync({ orgId, provider, start, end, trigger: 'auto' });
    return run.syncId;
  } catch (err) {
    if (!(err instanceof SyncError)) console.error(`[sync] initial import ${provider} org ${orgId}:`, err.message);
    return null;
  }
}

module.exports = {
  SyncError, startSync, refreshAll, incrementalRange, markStaleRuns, syncOverview,
  classifyProviderError, nextAutoSyncAt, autoSyncEnabled, setSyncEmitter, startInitialImport, dayChunks,
  AUTO_SYNC_CRON, STALE_RUN_MS, CHUNK_DAYS, FAILURES_BEFORE_ALERT,
};
