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
    expect(log.error_message).toMatch(/no devolvió datos/);
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
    const res = await post(jwt, '?days=400');
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
