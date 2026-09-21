const request = require('supertest');
const { app } = require('../index');
const { resetDb, createOrg } = require('./helpers');

beforeEach(resetDb);
afterEach(() => jest.restoreAllMocks());

const VALID_METRIC = {
  provider: 'anthropic', model: 'claude-sonnet-4-6',
  input_tokens: 100, output_tokens: 50, total_tokens: 150,
  cost_usd: 0.00045, latency_ms: 320, status_code: 200,
};

async function createApiCall(obsToken, overrides = {}) {
  const res = await request(app)
    .post('/api/metrics')
    .set('Authorization', `Bearer ${obsToken}`)
    .send({ ...VALID_METRIC, ...overrides });
  return res.body.data.id;
}

async function createBudgetAlert(jwt, provider = 'anthropic') {
  // Create a rule and trigger it by posting a metric over the threshold
  const ruleRes = await request(app)
    .post('/api/alerts/rules')
    .set('Authorization', `Bearer ${jwt}`)
    .send({ provider, threshold_usd: 0.0001 });
  expect(ruleRes.status).toBe(201);
}

async function createReconciliationAlert(orgId) {
  // Directly insert into reconciliation_runs with alert status
  const pool = require('../db/pool');
  await pool.query(
    `INSERT INTO reconciliation_runs (org_id, provider, period_start, period_end, provider_computed_usd, client_reported_usd, deviation_pct, status)
     VALUES ($1, $2, NOW() - INTERVAL '1 day', NOW(), 100, 105.5, 5.5, 'alert')`,
    [orgId, 'openai']
  );
}

describe('GET /api/notifications', () => {
  it('returns budget_alert, reconciliation, and team_joined types', async () => {
    const { obsToken, jwt, orgId } = await createOrg('Test Org');

    // Seed: create an invitation and accept it to generate team_joined
    const pool = require('../db/pool');
    const invRes = await request(app)
      .post('/api/team/invite')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ email: 'newmember@test.com' });
    expect(invRes.status).toBe(201);

    // Manually accept it (in real flow, user would click link)
    const invRow = await pool.query('SELECT token FROM invitations ORDER BY created_at DESC LIMIT 1');
    const acceptRes = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token: invRow.rows[0].token, password: 'TestPass123!' });
    expect(acceptRes.status).toBe(200);

    // Create a budget alert rule (will trigger on next metric over threshold)
    await createBudgetAlert(jwt);

    // Post a metric that exceeds budget
    await createApiCall(obsToken, { cost_usd: 0.00050 });

    // Post a metric to create reconciliation deviation
    await createReconciliationAlert(orgId);

    // Fetch notifications
    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${jwt}`);

    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeDefined();
    expect(Array.isArray(res.body.notifications)).toBe(true);

    const types = res.body.notifications.map(n => n.type);
    expect(types).toContain('budget_alert');
    expect(types).toContain('reconciliation');
    expect(types).toContain('team_joined');
  });

  it('includes insight-type notifications when cost spike is detected', async () => {
    const { obsToken, jwt, orgId } = await createOrg('Insight Test Org');

    // Seed enough data to trigger a cost_spike insight
    // Previous period: 1 request at $0.0001. computeInsights uses a 24h window
    // for the bell, so "previous" is the 24h–48h band — seed at 36h to sit
    // safely inside it (exactly 48h falls off the edge by the time NOW() runs).
    // Current period must clear COST_SPIKE_MIN_ABS_USD ($0.50): 10 × $0.10 = $1.00.
    const twoDaysAgo = new Date(Date.now() - 36 * 60 * 60 * 1000);

    const pool = require('../db/pool');
    // Old call (previous period)
    await pool.query(
      `INSERT INTO api_calls (org_id, provider, model, input_tokens, output_tokens, total_tokens, cost_usd, latency_ms, status_code, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [orgId, 'anthropic', 'claude-sonnet-4-6', 50, 25, 75, 0.0001, 100, 200, twoDaysAgo]
    );

    // Current period: 10 requests at $0.10 each = $1.00 total (10000x spike)
    for (let i = 0; i < 10; i++) {
      await createApiCall(obsToken, { cost_usd: 0.1 });
    }

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${jwt}`);

    expect(res.status).toBe(200);
    const insightNotifs = res.body.notifications.filter(n => n.type === 'insight');
    expect(insightNotifs.length).toBeGreaterThan(0);
    const costSpike = insightNotifs.find(n => n.insight_type === 'cost_spike');
    expect(costSpike).toBeDefined();
    expect(costSpike.data.severity).toMatch(/critical|warning/);
  });

  it('excludes muted insights from the list', async () => {
    const { obsToken, jwt, orgId } = await createOrg('Mute Test Org');

    // Create cost spike condition
    const pool = require('../db/pool');
    const twoDaysAgo = new Date(Date.now() - 36 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO api_calls (org_id, provider, model, input_tokens, output_tokens, total_tokens, cost_usd, latency_ms, status_code, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [orgId, 'anthropic', 'claude-sonnet-4-6', 50, 25, 75, 0.0001, 100, 200, twoDaysAgo]
    );
    for (let i = 0; i < 10; i++) {
      await createApiCall(obsToken, { cost_usd: 0.1 });
    }

    // Fetch to see insights
    const res1 = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${jwt}`);
    const insight = res1.body.notifications.find(n => n.type === 'insight');
    expect(insight).toBeDefined();

    // Mute this insight
    await request(app)
      .post('/api/insights/dismiss')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ insight_key: insight.data.insight_key, hours: 24 });

    // Fetch again — insight should be gone
    const res2 = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${jwt}`);
    const insightAfterMute = res2.body.notifications.find(n => n.id === insight.id);
    expect(insightAfterMute).toBeUndefined();
  });

  it('unread_count includes only DB-backed types, not insights', async () => {
    const { obsToken, jwt, orgId } = await createOrg('Unread Test Org');

    // Create cost spike and budget alert
    const pool = require('../db/pool');
    const twoDaysAgo = new Date(Date.now() - 36 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO api_calls (org_id, provider, model, input_tokens, output_tokens, total_tokens, cost_usd, latency_ms, status_code, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [orgId, 'anthropic', 'claude-sonnet-4-6', 50, 25, 75, 0.0001, 100, 200, twoDaysAgo]
    );
    for (let i = 0; i < 10; i++) {
      await createApiCall(obsToken, { cost_usd: 0.1 });
    }

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${jwt}`);

    // unread_count should only count DB-backed types (budget, reconciliation, team_joined)
    // not insights (client owns insight read state via sessionStorage)
    expect(res.body.unread_count).toBeDefined();
    const dbBackedUnread = res.body.notifications
      .filter(n => n.type !== 'insight' && !n.read)
      .length;
    expect(res.body.unread_count).toBe(dbBackedUnread);
  });

  it('read flag is false for all insight-type items regardless of watermark', async () => {
    const { obsToken, jwt, orgId } = await createOrg('Insight Read Test Org');

    // Create cost spike
    const pool = require('../db/pool');
    const twoDaysAgo = new Date(Date.now() - 36 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO api_calls (org_id, provider, model, input_tokens, output_tokens, total_tokens, cost_usd, latency_ms, status_code, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [orgId, 'anthropic', 'claude-sonnet-4-6', 50, 25, 75, 0.0001, 100, 200, twoDaysAgo]
    );
    for (let i = 0; i < 10; i++) {
      await createApiCall(obsToken, { cost_usd: 0.1 });
    }

    // Mark all read (sets watermark)
    await request(app)
      .post('/api/notifications/read-all')
      .set('Authorization', `Bearer ${jwt}`);

    // Fetch again
    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${jwt}`);

    const insightNotifs = res.body.notifications.filter(n => n.type === 'insight');
    expect(insightNotifs.length).toBeGreaterThan(0);
    insightNotifs.forEach(n => {
      expect(n.read).toBe(false);
    });
  });
});

describe('POST /api/notifications/read-all', () => {
  it('marks DB-backed notifications as read but does NOT touch insight_dismissals', async () => {
    const { obsToken, jwt, orgId } = await createOrg('Read All Test Org');

    // Create a budget alert and cost spike insight
    const pool = require('../db/pool');
    await pool.query(
      `INSERT INTO alert_history (org_id, provider, current_value, threshold_usd, sent_at, success)
       VALUES ($1, $2, $3, $4, NOW(), true)`,
      [orgId, 'anthropic', 0.5, 0.1]
    );

    const twoDaysAgo = new Date(Date.now() - 36 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO api_calls (org_id, provider, model, input_tokens, output_tokens, total_tokens, cost_usd, latency_ms, status_code, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [orgId, 'anthropic', 'claude-sonnet-4-6', 50, 25, 75, 0.0001, 100, 200, twoDaysAgo]
    );
    for (let i = 0; i < 10; i++) {
      await createApiCall(obsToken, { cost_usd: 0.1 });
    }

    // Fetch before read-all
    const resBefore = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${jwt}`);
    expect(resBefore.body.unread_count).toBeGreaterThan(0);

    // Mark all read
    await request(app)
      .post('/api/notifications/read-all')
      .set('Authorization', `Bearer ${jwt}`);

    // Fetch after — DB-backed should be read
    const resAfter = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${jwt}`);

    expect(resAfter.body.unread_count).toBe(0); // All DB-backed read

    // Verify insights were NOT added to insight_dismissals
    const dismissedCount = (await pool.query(
      'SELECT COUNT(*) FROM insight_dismissals WHERE org_id = $1',
      [orgId]
    )).rows[0].count;
    expect(parseInt(dismissedCount)).toBe(0); // No dismissals created
  });
});
