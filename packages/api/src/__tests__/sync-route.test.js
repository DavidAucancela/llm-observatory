const request = require('supertest');
const { app }  = require('../index');
const { resetDb, createOrg, createMember, pool } = require('./helpers');
const { encrypt } = require('../db/crypto');
const { SYNC_PROVIDERS } = require('../services/providerRegistry');

beforeEach(resetDb);

const realFetch = SYNC_PROVIDERS.anthropic.fetchBuckets;
afterEach(() => { SYNC_PROVIDERS.anthropic.fetchBuckets = realFetch; });

async function addAdminKey(orgId, provider = 'anthropic') {
  await pool.query(
    `INSERT INTO provider_credentials (org_id, provider, key_type, api_key_encrypted, key_hint, label)
     VALUES ($1, $2, 'admin', $3, 'sk-ad…test', 'admin')`,
    [orgId, provider, encrypt('sk-ant-admin-test')]
  );
}

async function waitForSync(syncId) {
  for (let i = 0; i < 50; i++) {
    const r = await pool.query('SELECT * FROM sync_logs WHERE id = $1', [syncId]);
    if (r.rows[0].status !== 'running') return r.rows[0];
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('sync did not finish');
}

const post = (jwt, qs, body) => {
  const r = request(app).post(`/api/sync/anthropic${qs}`).set('Authorization', `Bearer ${jwt}`);
  return body ? r.send(body) : r;
};

describe('POST /api/sync/:provider — window', () => {
  it('runs a date range: aligned window to the fetcher, recorded on the log, echoed in the response', async () => {
    const { orgId, jwt } = await createOrg('Range Sync Org');
    await addAdminKey(orgId);
    const calls = [];
    SYNC_PROVIDERS.anthropic.fetchBuckets = async (cred, s, e) => {
      calls.push([s.toISOString(), e.toISOString()]);
      return { buckets: [], startISO: s.toISOString(), endISO: e.toISOString() };
    };

    const start = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const end   = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
    const res = await post(jwt, `?start=${start}&end=${end}`);
    expect(res.status).toBe(200);
    expect(res.body.window.start).toBe(`${start}T00:00:00.000Z`);
    expect(res.body.window.end).toBe(`${end}T23:59:59.999Z`);
    expect(res.body.clamped).toBe(false);

    const log = await waitForSync(res.body.sync_id);
    expect(log.status).toBe('success');
    expect(calls).toEqual([[`${start}T00:00:00.000Z`, `${end}T23:59:59.999Z`]]);
    expect(new Date(log.date_range_start).toISOString()).toBe(`${start}T00:00:00.000Z`);
    // Empty fetch is a completed run but says so instead of a bare success
    expect(log.details.empty).toBe(true);
    expect(log.trigger).toBe('manual');
  });

  it('accepts the range in the JSON body too', async () => {
    const { orgId, jwt } = await createOrg('Body Sync Org');
    await addAdminKey(orgId);
    SYNC_PROVIDERS.anthropic.fetchBuckets = async (c, s, e) => ({ buckets: [], startISO: s.toISOString(), endISO: e.toISOString() });
    const start = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const res = await post(jwt, '', { start, end: start });
    expect(res.status).toBe(200);
    expect(res.body.window.start).toBe(`${start}T00:00:00.000Z`);
    await waitForSync(res.body.sync_id);
  });

  it('trims data older than retention and reports it', async () => {
    const { orgId, jwt } = await createOrg('Clamp Org');
    await addAdminKey(orgId);
    SYNC_PROVIDERS.anthropic.fetchBuckets = async (c, s, e) => ({ buckets: [], startISO: s.toISOString(), endISO: e.toISOString() });
    const res = await post(jwt, '?days=1200');
    expect(res.status).toBe(200);
    expect(res.body.clamped).toBe(true);
    expect(res.body.warnings[0].code).toBe('start_clamped_retention');
    await waitForSync(res.body.sync_id);
  });

  it('400s on bad input instead of running (or hanging)', async () => {
    const { orgId, jwt } = await createOrg('Bad Sync Org');
    await addAdminKey(orgId);
    for (const qs of ['?days=-5', '?days=abc', '?start=2026-01-01', '?start=2026-01-02&end=2026-01-01', '?start=2020-01-01&end=2020-01-05']) {
      const res = await post(jwt, qs);
      expect([qs, res.status]).toEqual([qs, 400]);
    }
    const logs = await pool.query('SELECT COUNT(*) FROM sync_logs');
    expect(parseInt(logs.rows[0].count)).toBe(0); // nothing was started
  });

  it('400 without an admin key, and members cannot sync', async () => {
    const { orgId, jwt } = await createOrg('NoKey Org');
    expect((await post(jwt, '?days=7')).status).toBe(400);
    const member = await createMember(orgId);
    expect((await post(member.jwt, '?days=7')).status).toBe(403);
  });
});

describe('sync errors carry a translatable code', () => {
  it('no admin key → no_admin_key; range entirely older than retention → range_beyond_retention', async () => {
    const { orgId, jwt } = await createOrg('Codes Org');
    let res = await post(jwt, '?days=7');
    expect(res.body.code).toBe('no_admin_key');
    await addAdminKey(orgId);
    res = await post(jwt, '?start=2019-01-01&end=2019-02-01');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('range_beyond_retention');
    expect(res.body.params.days).toBeGreaterThan(0);
  });

  it('a second sync of the same provider while one runs is a 409 already_running', async () => {
    const { orgId, jwt } = await createOrg('Busy Org');
    await addAdminKey(orgId);
    let release;
    SYNC_PROVIDERS.anthropic.fetchBuckets = (c, s, e) => new Promise(r => { release = () => r({ buckets: [], startISO: s.toISOString(), endISO: e.toISOString() }); });
    const first = await post(jwt, '?days=3');
    expect(first.status).toBe(200);
    const second = await post(jwt, '?days=3');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('already_running');
    release();
    await waitForSync(first.body.sync_id);
  });

  it('a run abandoned by a restart is marked interrupted instead of "running" forever', async () => {
    const { orgId, jwt } = await createOrg('Stale Org');
    await pool.query(
      `INSERT INTO sync_logs (org_id, provider, status, started_at) VALUES ($1, 'anthropic', 'running', NOW() - INTERVAL '2 hours')`,
      [orgId]
    );
    const res = await request(app).get('/api/sync/logs').set('Authorization', `Bearer ${jwt}`);
    expect(res.body.logs[0]).toMatchObject({ status: 'error', error_code: 'interrupted' });
  });

  it('provider failures are classified (401 → provider_auth, OpenAI lookback → provider_lookback)', async () => {
    const { classifyProviderError } = require('../services/syncRunner');
    expect(classifyProviderError(new Error('Anthropic API 401: {"error":"invalid x-api-key"}'))).toBe('provider_auth');
    expect(classifyProviderError(new Error('OpenAI API 400: {"code":"reporting_lookback_exceeded"}'))).toBe('provider_lookback');
    expect(classifyProviderError(new Error('xAI usage API 503: down'))).toBe('provider_unavailable');
    expect(classifyProviderError(new Error('boom'))).toBe('sync_failed');
  });

  it('usage of a model with no price is reported as skipped, not silently dropped', async () => {
    const { orgId, jwt } = await createOrg('Skip Org');
    await addAdminKey(orgId);
    SYNC_PROVIDERS.anthropic.fetchBuckets = async (c, s, e) => ({
      buckets: [{ starting_at: s.toISOString(), results: [{ model: 'claude-mystery-9', uncached_input_tokens: 1000, output_tokens: 500 }] }],
      startISO: s.toISOString(), endISO: e.toISOString(),
    });
    const res = await post(jwt, '?days=2');
    const log = await waitForSync(res.body.sync_id);
    expect(log.status).toBe('success');
    expect(log.details.skipped_models).toEqual(['claude-mystery-9']);
  });
});

describe('GET /api/sync/overview and POST /api/sync/refresh', () => {
  it('overview reports key state, provider lookback and the earliest importable day', async () => {
    const { orgId, jwt } = await createOrg('Overview Org');
    await addAdminKey(orgId);
    const res = await request(app).get('/api/sync/overview').set('Authorization', `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.providers.map(p => [p.provider, p]));
    expect(byId.anthropic.has_admin_key).toBe(true);
    expect(byId.openai.has_admin_key).toBe(false);
    expect(byId.openai.lookback_days).toBe(365);
    expect(byId.openai.earliest_syncable > byId.anthropic.earliest_syncable).toBe(true);
    expect(res.body.auto_sync.enabled).toBe(true);
  });

  it('refresh starts every provider with an admin key and skips nothing else', async () => {
    const { orgId, jwt } = await createOrg('Refresh Org');
    await addAdminKey(orgId);
    const calls = [];
    SYNC_PROVIDERS.anthropic.fetchBuckets = async (c, s, e) => { calls.push(s.toISOString()); return { buckets: [], startISO: s.toISOString(), endISO: e.toISOString() }; };
    const res = await request(app).post('/api/sync/refresh').set('Authorization', `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({ provider: 'anthropic', status: 'started' });
    await waitForSync(res.body.results[0].sync_id);
    // Never synced → the whole available history, from the retention edge
    const { earliestSyncableMs } = require('../services/syncWindow');
    const { retentionDays } = require('../utils/retention');
    expect(calls[0]).toBe(new Date(earliestSyncableMs({ now: Date.now(), retention: retentionDays(), lookbackDays: null })).toISOString());
  });

  it('the incremental window restarts at the last synced day; a first run takes all the provider still holds', async () => {
    const { orgId } = await createOrg('Incr Org');
    const { incrementalRange } = require('../services/syncRunner');
    const { earliestSyncableMs } = require('../services/syncWindow');
    const { retentionDays } = require('../utils/retention');
    const NOW = Date.parse('2026-10-12T10:00:00Z');
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    expect(await incrementalRange(orgId, 'anthropic', NOW)).toEqual({
      start: day(earliestSyncableMs({ now: NOW, retention: retentionDays(), lookbackDays: null })), end: '2026-10-12', initial: true,
    });
    // OpenAI forgets usage after 365 days — the first import starts right there
    expect((await incrementalRange(orgId, 'openai', NOW)).start).toBe('2025-10-12');
    await pool.query(
      `INSERT INTO sync_logs (org_id, provider, status, date_range_start, date_range_end, completed_at)
       VALUES ($1, 'anthropic', 'success', '2026-10-01T00:00:00Z', '2026-10-05T14:00:00Z', NOW())`,
      [orgId]
    );
    expect(await incrementalRange(orgId, 'anthropic', NOW)).toEqual({ start: '2026-10-04', end: '2026-10-12', initial: false });
  });

  it('the all-orgs sweep is skipped while another instance holds its lock', async () => {
    const { refreshAll } = require('../services/syncRunner');
    const other = await pool.connect();
    try {
      await other.query('SELECT pg_advisory_lock(74110601)');
      const res = await refreshAll({ trigger: 'auto' });
      expect(res.locked).toBe(true);
      expect(res).toHaveLength(0);
    } finally {
      await other.query('SELECT pg_advisory_unlock(74110601)');
      other.release();
    }
  });

  it('overview reports what the retention purge deletes within 30 days', async () => {
    const { orgId, jwt } = await createOrg('Expiring Org');
    const { retentionDays } = require('../utils/retention');
    const old = new Date(Date.now() - (retentionDays() - 10) * 86400000).toISOString();
    await pool.query(
      `INSERT INTO api_calls (org_id, provider, model, input_tokens, output_tokens, total_tokens, cost_usd, latency_ms, status_code, timestamp)
       VALUES ($1, 'anthropic', 'claude-x', 1, 1, 2, 0, 1, 200, $2), ($1, 'anthropic', 'claude-x', 1, 1, 2, 0, 1, 200, NOW())`,
      [orgId, old]
    );
    const res = await request(app).get('/api/sync/overview').set('Authorization', `Bearer ${jwt}`);
    expect(res.body.expiring).toMatchObject({ within_days: 30, rows: 1 });
  });
});

describe('chunked runs: progress, retries, notifications', () => {
  const ok = (s, e, results = []) => ({
    buckets: results.length ? [{ starting_at: s.toISOString(), results }] : [], startISO: s.toISOString(), endISO: e.toISOString(),
  });
  const dayStr = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

  it('a long window is fetched in contiguous 31-day chunks and records its progress', async () => {
    const { orgId, jwt } = await createOrg('Chunk Org');
    await addAdminKey(orgId);
    const calls = [];
    SYNC_PROVIDERS.anthropic.fetchBuckets = async (c, s, e) => { calls.push([s.getTime(), e.getTime()]); return ok(s, e); };
    const res = await post(jwt, `?start=${dayStr(80)}&end=${dayStr(10)}`);
    const log = await waitForSync(res.body.sync_id);
    expect(log.status).toBe('success');
    expect(calls).toHaveLength(3); // 71 days → 31 + 31 + 9
    for (let i = 1; i < calls.length; i++) expect(calls[i][0]).toBe(calls[i - 1][1] + 1);
    expect(log.details.progress).toEqual({ done: 3, total: 3 });
    expect(new Date(log.date_range_start).toISOString()).toBe(`${dayStr(80)}T00:00:00.000Z`);
  });

  it('a transient provider error is retried; an auth error is not', async () => {
    const { orgId, jwt } = await createOrg('Retry Org');
    await addAdminKey(orgId);
    let n = 0;
    SYNC_PROVIDERS.anthropic.fetchBuckets = async (c, s, e) => {
      if (n++ === 0) throw new Error('Anthropic API 529: overloaded');
      return ok(s, e);
    };
    let log = await waitForSync((await post(jwt, '?days=2')).body.sync_id);
    expect(log.status).toBe('success');
    expect(n).toBe(2);

    n = 0;
    SYNC_PROVIDERS.anthropic.fetchBuckets = async () => { n++; throw new Error('Anthropic API 401: invalid x-api-key'); };
    log = await waitForSync((await post(jwt, '?days=2')).body.sync_id);
    expect(log).toMatchObject({ status: 'error', error_code: 'provider_auth' });
    expect(n).toBe(1);
  });

  it('a provider failing twice in a row is flagged once for the bell', async () => {
    const { orgId, jwt } = await createOrg('Failing Org');
    await addAdminKey(orgId);
    SYNC_PROVIDERS.anthropic.fetchBuckets = async () => { throw new Error('Anthropic API 401: invalid x-api-key'); };
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await waitForSync((await post(jwt, '?days=2')).body.sync_id));
    expect(runs[0].details.alert).toBeUndefined();
    expect(runs[1].details).toMatchObject({ alert: 'repeated_failure', failures: 2, discord: null });
    expect(runs[2].details.alert).toBeUndefined(); // still broken, but not re-notified

    const bell = await request(app).get('/api/notifications').set('Authorization', `Bearer ${jwt}`);
    const items = bell.body.notifications.filter(n => n.type === 'sync_failing');
    expect(items).toHaveLength(1);
    expect(items[0].data).toMatchObject({ provider: 'anthropic', providerLabel: 'Anthropic', failures: 2, errorCode: 'provider_auth' });
  });

  it('a newly seen unpriced model notifies once, not on every run', async () => {
    const { orgId, jwt } = await createOrg('Unpriced Org');
    await addAdminKey(orgId);
    SYNC_PROVIDERS.anthropic.fetchBuckets = async (c, s, e) =>
      ok(s, e, [{ model: 'claude-mystery-9', uncached_input_tokens: 1000, output_tokens: 500 }]);
    const first = await waitForSync((await post(jwt, '?days=2')).body.sync_id);
    const second = await waitForSync((await post(jwt, '?days=2')).body.sync_id);
    expect(first.details.new_skipped_models).toEqual(['claude-mystery-9']);
    expect(second.details.new_skipped_models).toBeUndefined();
    const bell = await request(app).get('/api/notifications').set('Authorization', `Bearer ${jwt}`);
    const items = bell.body.notifications.filter(n => n.type === 'sync_unpriced');
    expect(items).toHaveLength(1);
    expect(items[0].data.models).toEqual(['claude-mystery-9']);
  });

  it('saving an admin key starts the first import right away', async () => {
    const { jwt } = await createOrg('NewKey Org');
    const calls = [];
    SYNC_PROVIDERS.anthropic.fetchBuckets = async (c, s, e) => { calls.push(s); return ok(s, e); };
    const res = await request(app).post('/api/credentials').set('Authorization', `Bearer ${jwt}`)
      .send({ provider: 'anthropic', key_type: 'admin', label: 'admin', value: 'sk-ant-admin01-FAKEFAKEFAKEFAKE' });
    expect(res.status).toBe(201);
    expect(res.body.sync_id).toEqual(expect.any(Number));
    const log = await waitForSync(res.body.sync_id);
    expect(log).toMatchObject({ status: 'success', trigger: 'auto' });
    expect(log.details.progress.total).toBeGreaterThan(30); // ~3 years in 31-day chunks
  });
});
