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
    expect(res.body.warning).toMatch(/retention/);
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
    expect(calls).toHaveLength(1);
  });

  it('the incremental window restarts at the last synced day', async () => {
    const { orgId } = await createOrg('Incr Org');
    const { incrementalRange, AUTO_INITIAL_DAYS } = require('../services/syncRunner');
    const NOW = Date.parse('2026-10-12T10:00:00Z');
    expect(await incrementalRange(orgId, 'anthropic', NOW)).toEqual({
      start: new Date(Date.parse('2026-10-12T00:00:00Z') - AUTO_INITIAL_DAYS * 86400000).toISOString().slice(0, 10), end: '2026-10-12',
    });
    await pool.query(
      `INSERT INTO sync_logs (org_id, provider, status, date_range_start, date_range_end, completed_at)
       VALUES ($1, 'anthropic', 'success', '2026-10-01T00:00:00Z', '2026-10-05T14:00:00Z', NOW())`,
      [orgId]
    );
    expect(await incrementalRange(orgId, 'anthropic', NOW)).toEqual({ start: '2026-10-04', end: '2026-10-12' });
  });
});
