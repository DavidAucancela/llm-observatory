const express = require('express');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');
const { SYNC_PROVIDERS, syncableProviders } = require('../services/providerRegistry');
const { importBuckets, extractBucketTokens } = require('../services/syncImport');
const { SyncError, startSync, refreshAll, markStaleRuns, syncOverview } = require('../services/syncRunner');

const router = express.Router();

// Every sync failure answers `{ error, code, params, detail? }` — `code` is what
// the Sync page translates (sync.codes.*), `error` the English fallback.
function sendSyncError(res, err) {
  return res.status(err.status || 400).json({
    error: err.message, code: err.code, params: err.params || {}, ...(err.detail ? { detail: err.detail } : {}),
  });
}

// GET /api/sync/overview — per-provider state for the Sync page: admin key,
// data range already stored, last/latest run, earliest importable day
// (retention + provider lookback), and the auto-sync schedule.
router.get('/overview', async (req, res, next) => {
  try {
    res.json(await syncOverview(req.user.orgId));
  } catch (err) { next(err); }
});

// POST /api/sync/refresh — "Update now": incremental sync (from each
// provider's last synced day to today) for every provider with an admin key.
// The same thing the auto-sync cron does every few hours. Declared before
// /:provider so 'refresh' isn't taken for a provider name.
router.post('/refresh', requireAdmin, async (req, res, next) => {
  try {
    const results = await refreshAll({ orgId: req.user.orgId, trigger: 'manual', wait: false });
    res.json({ success: true, results: results.map(({ org_id, ...r }) => r) });
  } catch (err) { next(err); }
});

// POST /api/sync/:provider — import a historical window using the org's admin
// key. Window: `start`+`end` (query or body; bare YYYY-MM-DD = UTC day) OR
// `days` (look-back, default 30). Aligned to UTC midnight, capped at now, and
// trimmed to retention + the provider's own lookback — services/syncWindow.js.
router.post('/:provider', requireAdmin, async (req, res, next) => {
  try {
    const { start, end, days } = { ...req.query, ...(req.body || {}) };
    const run = await startSync({ orgId: req.user.orgId, provider: req.params.provider, start, end, days, trigger: 'manual' });
    res.json({
      success: true, sync_id: run.syncId, message: 'Sync iniciado en background',
      window: { start: run.window.startDate.toISOString(), end: run.window.endDate.toISOString() },
      clamped: run.window.clamped, warning: run.window.warning, warnings: run.warnings,
    });
  } catch (err) {
    if (err instanceof SyncError) return sendSyncError(res, err);
    next(err);
  }
});

// DELETE /api/sync/:provider/data — delete all api_calls for provider in this org
router.delete('/:provider/data', requireAdmin, async (req, res, next) => {
  const { provider } = req.params;
  const { orgId }    = req.user;
  if (!SYNC_PROVIDERS[provider]) {
    return res.status(400).json({ error: `Proveedor no soportado. Usa: ${syncableProviders().join(', ')}` });
  }
  try {
    const result = await pool.query(
      `DELETE FROM api_calls WHERE org_id = $1 AND provider = $2`,
      [orgId, provider]
    );
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) { next(err); }
});

// GET /api/sync/logs — recent sync operations for this org
router.get('/logs', async (req, res, next) => {
  try {
    const { orgId } = req.user;
    await markStaleRuns({ orgId });
    const result = await pool.query(
      'SELECT * FROM sync_logs WHERE org_id = $1 ORDER BY started_at DESC LIMIT 20',
      [orgId]
    );
    res.json({ logs: result.rows });
  } catch (err) { next(err); }
});

// GET /api/sync/status — latest sync status per provider for this org
router.get('/status', async (req, res, next) => {
  try {
    const { orgId } = req.user;
    const result = await pool.query(
      `SELECT DISTINCT ON (provider) * FROM sync_logs WHERE org_id = $1 ORDER BY provider, started_at DESC`,
      [orgId]
    );
    res.json({ status: result.rows });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.importBuckets = importBuckets;      // re-exported for unit tests (lives in services/syncImport.js)
module.exports.extractBucketTokens = extractBucketTokens;
