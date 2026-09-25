const request = require('supertest');
const { app }  = require('../index');
const { resetDb, createOrg, pool } = require('./helpers');

beforeEach(resetDb);

// Fixed instants far from NOW() so these never depend on the current time.
async function insertCall(orgId, ts, { cost = 1, provider = 'anthropic', model = 'claude-sonnet-4-6' } = {}) {
  await pool.query(
    `INSERT INTO api_calls
       (org_id, timestamp, provider, model, input_tokens, output_tokens, total_tokens,
        cost_usd, latency_ms, status_code, api_key_hint)
     VALUES ($1, $2, $3, $4, 10, 5, 15, $5, 100, 200, 'sk-test…abcd')`,
    [orgId, ts, provider, model, cost]
  );
}

const get = (jwt, url) => request(app).get(url).set('Authorization', `Bearer ${jwt}`);

describe('custom range — bounds', () => {
  it('a bare single date is that whole UTC day, inclusive at both ends', async () => {
    const { orgId, jwt } = await createOrg('Bounds Org');
    await insertCall(orgId, '2026-07-14T23:59:59.999Z');
    await insertCall(orgId, '2026-07-15T00:00:00.000Z');
    await insertCall(orgId, '2026-07-15T23:59:59.999Z');
    await insertCall(orgId, '2026-07-16T00:00:00.000Z');

    const res = await get(jwt, '/api/metrics?start=2026-07-15&end=2026-07-15&limit=100');
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(2);
  });

  it('start+end without range=custom still work', async () => {
    const { orgId, jwt } = await createOrg('Implied Custom Org');
    await insertCall(orgId, '2026-07-15T12:00:00Z');
    const res = await get(jwt, '/api/metrics/summary?start=2026-07-15&end=2026-07-15');
    expect(res.status).toBe(200);
    expect(parseInt(res.body.summary.total_requests)).toBe(1);
  });

  it('never leaks another org’s rows', async () => {
    const a = await createOrg('Range Org A');
    const b = await createOrg('Range Org B');
    await insertCall(a.orgId, '2026-07-15T12:00:00Z');
    await insertCall(b.orgId, '2026-07-15T12:00:00Z');
    const res = await get(a.jwt, '/api/metrics/summary?start=2026-07-15&end=2026-07-15');
    expect(parseInt(res.body.summary.total_requests)).toBe(1);
  });
});

describe('custom range — validation returns 400, not 500', () => {
  const cases = [
    ['only start',               'start=2026-07-15'],
    ['only end',                 'end=2026-07-15'],
    ['start after end',          'start=2026-07-16&end=2026-07-15'],
    ['garbage',                  'start=nope&end=2026-07-15'],
    ['datetime without zone',    'start=2026-07-15T00:00:00&end=2026-07-16'],
    ['custom without dates',     'range=custom'],
    ['unknown preset',           'range=bogus'],
    ['span too long',            'start=2024-01-01&end=2026-07-15'],
  ];
  const endpoints = [
    '/api/metrics', '/api/metrics/summary', '/api/metrics/export',
    '/api/metrics/tag-keys', '/api/balances',
  ];

  for (const [label, qs] of cases) {
    it(`${label}`, async () => {
      const { jwt } = await createOrg('Validation Org');
      for (const ep of endpoints) {
        const res = await get(jwt, `${ep}?${qs}`);
        expect([ep, res.status]).toEqual([ep, 400]);
        expect(typeof res.body.error).toBe('string');
      }
    });
  }
});

describe('GET /api/metrics/summary — custom range buckets and previous period', () => {
  it('a one-day custom range is bucketed hourly (24 buckets)', async () => {
    const { orgId, jwt } = await createOrg('Hourly Org');
    await insertCall(orgId, '2026-07-15T13:30:00Z');
    const res = await get(jwt, '/api/metrics/summary?start=2026-07-15&end=2026-07-15');
    const buckets = new Set(res.body.time_series.map(r => r.hour));
    expect(buckets.size).toBe(24);
  });

  it('a multi-day custom range is bucketed daily', async () => {
    const { orgId, jwt } = await createOrg('Daily Org');
    await insertCall(orgId, '2026-07-15T13:30:00Z');
    const res = await get(jwt, '/api/metrics/summary?start=2026-07-13&end=2026-07-15');
    const buckets = [...new Set(res.body.time_series.map(r => r.hour))].sort();
    expect(buckets).toEqual([
      '2026-07-13T00:00:00.000Z', '2026-07-14T00:00:00.000Z', '2026-07-15T00:00:00.000Z',
    ]);
  });

  it('a row exactly at start counts in the current period only, never in both', async () => {
    const { orgId, jwt } = await createOrg('Boundary Org');
    await insertCall(orgId, '2026-07-15T00:00:00.000Z', { cost: 1 }); // start of current window
    await insertCall(orgId, '2026-07-14T12:00:00.000Z', { cost: 10 }); // inside previous window
    const res = await get(jwt, '/api/metrics/summary?start=2026-07-15&end=2026-07-15');
    expect(parseInt(res.body.summary.total_requests)).toBe(1);
    expect(parseInt(res.body.prev_summary.total_requests)).toBe(1);
    expect(parseFloat(res.body.prev_summary.total_cost_usd)).toBeCloseTo(10);
  });

  it('prev_time_series is populated for a custom range, aligned to the current bucket grid', async () => {
    const { orgId, jwt } = await createOrg('PrevSeries Org');
    await insertCall(orgId, '2026-07-14T09:15:00Z', { cost: 4 }); // 09:00 bucket of the previous day
    const res = await get(jwt, '/api/metrics/summary?start=2026-07-15&end=2026-07-15');
    const rows = res.body.prev_time_series.filter(r => parseInt(r.requests) > 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].hour).toBe('2026-07-15T09:00:00.000Z'); // shifted forward by one day
    expect(parseFloat(rows[0].cost_usd)).toBeCloseTo(4);
  });
});

describe('default range when `range` is omitted (unchanged from before the shared parser)', () => {
  it('/export defaults to 30d, everything else to 7d', async () => {
    const { orgId, jwt } = await createOrg('Defaults Org');
    await insertCall(orgId, new Date(Date.now() - 2 * 86400000).toISOString());
    await insertCall(orgId, new Date(Date.now() - 20 * 86400000).toISOString());
    const exp = await get(jwt, '/api/metrics/export');
    expect(exp.text.trim().split('\n')).toHaveLength(3);            // header + both rows
    const list = await get(jwt, '/api/metrics');
    expect(list.body.pagination.total).toBe(1);                       // only the 2-day-old row
  });

  it('/api/balances defaults to 30d spend', async () => {
    const { orgId, jwt } = await createOrg('Balance Default Org');
    await pool.query(`INSERT INTO provider_balances (org_id, provider, amount_usd) VALUES ($1, 'anthropic', 100)`, [orgId]);
    await insertCall(orgId, new Date(Date.now() - 20 * 86400000).toISOString(), { cost: 7 });
    const res = await get(jwt, '/api/balances');
    expect(res.body.providers.find(p => p.provider === 'anthropic').total_spent).toBeCloseTo(7);
  });
});

describe('GET /api/metrics/export — custom range', () => {
  it('names the file after the dates and honours the bounds', async () => {
    const { orgId, jwt } = await createOrg('Export Org');
    await insertCall(orgId, '2026-07-15T12:00:00Z');
    await insertCall(orgId, '2026-07-20T12:00:00Z');
    const res = await get(jwt, '/api/metrics/export?start=2026-07-15&end=2026-07-16');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('llm-metrics-2026-07-15_2026-07-16.csv');
    expect(res.text.trim().split('\n')).toHaveLength(2); // header + 1 row
  });
});

describe('GET /api/balances — range scoping', () => {
  it('total_spent follows the range but remaining/pct_used use lifetime spend', async () => {
    const { orgId, jwt } = await createOrg('Balances Org');
    await pool.query(`INSERT INTO provider_balances (org_id, provider, amount_usd) VALUES ($1, 'anthropic', 10)`, [orgId]);
    await insertCall(orgId, '2026-07-15T12:00:00Z', { cost: 2 });
    await insertCall(orgId, '2026-06-01T12:00:00Z', { cost: 3 });

    const res = await get(jwt, '/api/balances?start=2026-07-15&end=2026-07-15');
    expect(res.status).toBe(200);
    const a = res.body.providers.find(p => p.provider === 'anthropic');
    expect(a.total_loaded).toBe(10);
    expect(a.total_spent).toBeCloseTo(2);   // range only
    expect(a.remaining).toBeCloseTo(5);     // 10 - (2 + 3) lifetime
    expect(a.pct_used).toBeCloseTo(50);
  });
});

describe('GET /api/metrics/coverage', () => {
  it('flags a window before the first record and suggests a sync when an admin key exists', async () => {
    const { orgId, jwt } = await createOrg('Coverage Org');
    const { encrypt } = require('../db/crypto');
    await pool.query(
      `INSERT INTO provider_credentials (org_id, provider, key_type, api_key_encrypted, key_hint, label)
       VALUES ($1, 'anthropic', 'admin', $2, 'sk-ad…test', 'admin')`,
      [orgId, encrypt('sk-ant-admin-test')]
    );
    await insertCall(orgId, new Date(Date.now() - 2 * 86400000).toISOString());
    const older = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
    const olderEnd = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);

    const res = await get(jwt, `/api/metrics/coverage?start=${older}&end=${olderEnd}`);
    expect(res.status).toBe(200);
    expect(res.body.has_data).toBe(true);
    expect(res.body.before_first_data).toBe(true);
    expect(res.body.needs_attention).toBe(true);
    expect(res.body.can_sync).toBe(true);
    expect(res.body.syncable_providers).toContain('anthropic');
    expect(res.body.suggested_sync).toEqual({ start: older, end: olderEnd });
  });

  it('a preset covering the data needs no attention, and ping rows do not count as data', async () => {
    const { orgId, jwt } = await createOrg('Clean Coverage Org');
    await insertCall(orgId, new Date(Date.now() - 86400000).toISOString());
    await pool.query(
      `INSERT INTO api_calls (org_id, timestamp, provider, model, input_tokens, output_tokens, total_tokens, cost_usd, latency_ms, status_code, prompt_preview, api_key_hint)
       VALUES ($1, NOW() - INTERVAL '40 days', 'anthropic', 'm', 1, 1, 2, 0, 1, 200, 'test:sdk_integration', 'k')`,
      [orgId]
    );
    const res = await get(jwt, '/api/metrics/coverage?range=7d');
    expect(res.status).toBe(200);
    expect(res.body.needs_attention).toBe(false);
    // the 40-day-old ping row must not make "first data" 40 days ago
    expect(new Date(res.body.first_data_at).getTime()).toBeGreaterThan(Date.now() - 3 * 86400000);
  });

  it('validates the window like every range endpoint, and is org-scoped', async () => {
    const a = await createOrg('Cov Org A');
    const b = await createOrg('Cov Org B');
    await insertCall(a.orgId, new Date(Date.now() - 86400000).toISOString());
    expect((await get(a.jwt, '/api/metrics/coverage?start=2026-07-01')).status).toBe(400);
    const res = await get(b.jwt, '/api/metrics/coverage?range=7d');
    expect(res.body.has_data).toBe(false); // org B sees none of org A's rows
  });
});
