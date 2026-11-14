// Key audit end to end against a real Postgres: run → key_events → bell,
// Discord, org isolation, admin-only actions and the Desactivar button.
// Provider calls are faked by swapping KEY_WATCH_PROVIDERS' functions (the
// same approach sync-route.test.js uses for SYNC_PROVIDERS).
const request = require('supertest');
const { app } = require('../index');
const { resetDb, createOrg, createMember, pool } = require('./helpers');
const { encrypt } = require('../db/crypto');
const { KEY_WATCH_PROVIDERS } = require('../services/providerRegistry');
const { runKeyWatch, KeyWatchError } = require('../services/keyWatch');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const NOW_HOUR = Math.floor(NOW / HOUR) * HOUR;
const DAY0 = Math.floor(NOW / DAY) * DAY;

const real = {};
for (const p of Object.keys(KEY_WATCH_PROVIDERS)) real[p] = { ...KEY_WATCH_PROVIDERS[p] };
beforeEach(resetDb);
afterEach(() => {
  for (const p of Object.keys(real)) Object.assign(KEY_WATCH_PROVIDERS[p], real[p]);
  jest.restoreAllMocks();
});

const INVENTORY = [
  { key_id: 'key_a', name: 'code-review-2', redacted_hint: 'sk-...AAAA', project_id: 'proj_default', project_name: 'Default project', status: 'active' },
  { key_id: 'key_b', name: 'n8n-kommo-salesbot', redacted_hint: 'sk-...BBBB', project_id: 'proj_default', project_name: 'Default project', status: 'active' },
];

const comp = (key_id, t, requests = 20, cost = 0.02) => ({
  key_id, hour: new Date(t), kind: 'completions', model: 'gpt-5.5-2026-04-23', requests,
  input_tokens: requests * 300, cached_tokens: 0, output_tokens: requests * 50, images: 0, est_cost_usd: cost,
});
const img = (key_id, t, n = 6) => ({
  key_id, hour: new Date(t), kind: 'images', model: 'gpt-image-2-2026-04-21', requests: n,
  input_tokens: 0, cached_tokens: 0, output_tokens: 0, images: n, est_cost_usd: null,
});

// The incident, replayed: a code-review key with 12 days of plain completions
// (all seen by the SDK) starts generating images 2 hours ago; an n8n key the
// Observatory doesn't know was used 5 days ago and again an hour ago.
function incidentUsage() {
  const rows = [];
  for (let d = 12; d >= 1; d--) rows.push(comp('key_a', DAY0 - d * DAY + 10 * HOUR));
  rows.push(comp('key_a', NOW_HOUR - 2 * HOUR), img('key_a', NOW_HOUR - 2 * HOUR));
  rows.push(comp('key_b', DAY0 - 5 * DAY + 10 * HOUR, 3), comp('key_b', NOW_HOUR - HOUR, 3));
  return rows;
}

function fakeOpenAI({ inventory = INVENTORY, usage = incidentUsage(), disable } = {}) {
  const calls = { usage: [], disable: [] };
  KEY_WATCH_PROVIDERS.openai.listKeys = async () => inventory;
  KEY_WATCH_PROVIDERS.openai.fetchKeyUsage = async (cred, start, end) => {
    calls.usage.push([start, end]);
    return usage.filter(r => r.hour >= start && r.hour < end);
  };
  KEY_WATCH_PROVIDERS.openai.disableKey = disable || (async (cred, key) => { calls.disable.push(key); return { status: 'deleted' }; });
  return calls;
}

async function addCreds(orgId, provider = 'openai') {
  await pool.query(
    `INSERT INTO provider_credentials (org_id, provider, key_type, api_key_encrypted, key_hint, label)
     VALUES ($1, $2, 'admin', $3, 'sk-admin…test', 'admin')`,
    [orgId, provider, encrypt('sk-admin-test')]
  );
  // The code-review key is registered as an SDK credential → linked by tail.
  await pool.query(
    `INSERT INTO provider_credentials (org_id, provider, key_type, api_key_encrypted, key_hint, label)
     VALUES ($1, $2, 'sdk', $3, 'sk-proj-…AAAA', 'code-review')`,
    [orgId, provider, encrypt('sk-proj-xxxxxxxxAAAA')]
  );
}

// What the SDK recorded: every completion of key_a (none of the images).
async function addSdkRows(orgId) {
  for (let d = 12; d >= 1; d--) await sdkRows(orgId, DAY0 - d * DAY + 10 * HOUR + 5 * 60 * 1000, 20);
  await sdkRows(orgId, NOW_HOUR - 2 * HOUR + 5 * 60 * 1000, 20);
}
async function sdkRows(orgId, t, n) {
  await pool.query(
    `INSERT INTO api_calls (org_id, provider, model, input_tokens, output_tokens, total_tokens, cost_usd, latency_ms, status_code, api_key_hint, timestamp)
     SELECT $1, 'openai', 'gpt-5.5', 300, 50, 350, 0.001, 100, 200, 'sk-proj-…AAAA', $2 FROM generate_series(1, $3)`,
    [orgId, new Date(t), n]
  );
}

async function setup(name = 'Watch Org') {
  const org = await createOrg(name);
  await addCreds(org.orgId);
  await addSdkRows(org.orgId);
  return org;
}

const get = (jwt, path) => request(app).get(path).set('Authorization', `Bearer ${jwt}`);
const post = (jwt, path, body) => request(app).post(path).set('Authorization', `Bearer ${jwt}`).send(body || {});
const patch = (jwt, path, body) => request(app).patch(path).set('Authorization', `Bearer ${jwt}`).send(body || {});

describe('runKeyWatch — first run (backfill)', () => {
  it('finds the incident, keeps past findings quiet and pushes only recent ones to the bell', async () => {
    const { orgId, jwt } = await setup();
    const calls = fakeOpenAI();

    const res = await runKeyWatch({ orgId, provider: 'openai', trigger: 'manual', now: NOW });
    expect(res.status).toBe('ok');
    expect(res.initial).toBe(true);
    expect(calls.usage[0][0].getTime()).toBe(DAY0 - 14 * DAY); // 14-day backfill

    const ev = (await pool.query(`SELECT key_id, type, severity, historical, details FROM key_events WHERE org_id = $1 ORDER BY day, type`, [orgId])).rows;
    const fresh = ev.filter(e => !e.historical).map(e => `${e.key_id}:${e.type}:${e.severity}`).sort();
    const past = ev.filter(e => e.historical).map(e => `${e.key_id}:${e.type}`);
    expect(fresh).toEqual(['key_a:key_new_capability:high', 'key_b:key_unknown:medium']);
    expect(past).toEqual(['key_b:key_unknown']);
    expect(ev.find(e => e.type === 'key_new_capability').details).toMatchObject({ new_kinds: ['images'], images: 6, key_name: 'code-review-2' });

    // Bell: only the fresh ones
    const bell = await get(jwt, '/api/notifications');
    const keyAlerts = bell.body.notifications.filter(n => n.type === 'key_alert');
    expect(keyAlerts.map(n => n.data.eventType).sort()).toEqual(['key_new_capability', 'key_unknown']);
    const cap = keyAlerts.find(n => n.data.eventType === 'key_new_capability');
    expect(cap.data).toMatchObject({ keyName: 'code-review-2', provider: 'openai', severity: 'high', images: 6, newKinds: ['images'], projectName: 'Default project' });
    expect(bell.body.unread_count).toBeGreaterThanOrEqual(2);
  });

  it('a second run re-reads recent hours without re-notifying the same findings', async () => {
    const { orgId } = await setup();
    fakeOpenAI();
    await runKeyWatch({ orgId, provider: 'openai', now: NOW });
    const again = await runKeyWatch({ orgId, provider: 'openai', now: NOW + 10 * 60 * 1000 });
    expect(again).toMatchObject({ status: 'ok', initial: false, new_events: 0 });
    const n = await pool.query(`SELECT COUNT(*)::int AS n FROM key_events WHERE org_id = $1`, [orgId]);
    expect(n.rows[0].n).toBe(3);
    const usage = await pool.query(`SELECT COUNT(*)::int AS n FROM key_usage_hourly WHERE org_id = $1`, [orgId]);
    expect(usage.rows[0].n).toBe(incidentUsage().length); // upserted, not duplicated
  });

  it('sends a Discord alert for each fresh finding through the org\'s alert-rule webhook', async () => {
    const { orgId } = await setup();
    await pool.query(
      `INSERT INTO alert_rules (org_id, provider, metric, threshold_usd, discord_webhook_url) VALUES ($1, 'all', 'daily_spend', 10, 'https://discord.test/hook')`,
      [orgId]
    );
    fakeOpenAI();
    const posts = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 204 };
    });
    await runKeyWatch({ orgId, provider: 'openai', now: NOW });
    expect(posts).toHaveLength(2);
    const cap = posts.map(p => p.body.embeds[0]).find(e => e.title.includes('code-review-2'));
    expect(cap.title).toMatch(/nunca había hecho/);
    expect(cap.description).toMatch(/images/);
    expect(cap.footer.text).toBe('LLM Observatory — Auditoría de claves');
    const stored = await pool.query(`SELECT discord FROM key_events WHERE org_id = $1 AND historical = false`, [orgId]);
    expect(stored.rows.every(r => r.discord === true)).toBe(true);
  });

  it('marks keys the provider no longer lists as missing', async () => {
    const { orgId } = await setup();
    fakeOpenAI();
    await runKeyWatch({ orgId, provider: 'openai', now: NOW });
    fakeOpenAI({ inventory: [INVENTORY[0]] });
    await runKeyWatch({ orgId, provider: 'openai', now: NOW });
    const r = await pool.query(`SELECT key_id, status FROM provider_keys WHERE org_id = $1 ORDER BY key_id`, [orgId]);
    expect(r.rows).toEqual([{ key_id: 'key_a', status: 'active' }, { key_id: 'key_b', status: 'missing' }]);
  });
});

describe('runKeyWatch — failures', () => {
  it('records the error code, and the 2nd failure in a row reaches the bell', async () => {
    const { orgId, jwt } = await setup();
    KEY_WATCH_PROVIDERS.openai.listKeys = async () => { throw new Error('OpenAI API 401: invalid admin key'); };
    const first = await runKeyWatch({ orgId, provider: 'openai', now: NOW });
    expect(first).toMatchObject({ status: 'error', code: 'provider_auth' });
    await runKeyWatch({ orgId, provider: 'openai', now: NOW });
    const runs = (await pool.query(`SELECT status, error_code, details FROM key_watch_runs WHERE org_id = $1 ORDER BY id`, [orgId])).rows;
    expect(runs.map(r => r.status)).toEqual(['error', 'error']);
    expect(runs[1].details.alert).toBe('repeated_failure');
    const bell = await get(jwt, '/api/notifications');
    expect(bell.body.notifications.some(n => n.type === 'key_watch_failing' && n.data.errorCode === 'provider_auth')).toBe(true);
  });

  it('one run at a time per (org, provider)', async () => {
    const { orgId, jwt } = await setup();
    fakeOpenAI();
    await pool.query(`INSERT INTO key_watch_runs (org_id, provider, status) VALUES ($1, 'openai', 'running')`, [orgId]);
    await expect(runKeyWatch({ orgId, provider: 'openai', now: NOW })).rejects.toMatchObject({ code: 'already_running' });
    const res = await post(jwt, '/api/key-watch/run');
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([expect.objectContaining({ provider: 'openai', status: 'skipped', code: 'already_running' })]);
  });

  it('refuses providers without per-key usage and orgs without an admin key', async () => {
    const { orgId } = await createOrg('No Key Org');
    await expect(runKeyWatch({ orgId, provider: 'grok' })).rejects.toBeInstanceOf(KeyWatchError);
    await expect(runKeyWatch({ orgId, provider: 'openai' })).rejects.toMatchObject({ code: 'missing_admin_key' });
  });
});

describe('/api/key-watch routes', () => {
  async function ranOrg(name) {
    const org = await setup(name);
    fakeOpenAI();
    await runKeyWatch({ orgId: org.orgId, provider: 'openai', now: NOW });
    const keys = (await pool.query(`SELECT id, key_id FROM provider_keys WHERE org_id = $1`, [org.orgId])).rows;
    org.keyRow = Object.fromEntries(keys.map(k => [k.key_id, k.id]));
    return org;
  }

  it('GET /overview: keys with usage, SDK coverage, link state and open findings', async () => {
    const { jwt } = await ranOrg('Overview Org');
    const res = await get(jwt, '/api/key-watch/overview');
    expect(res.status).toBe(200);
    const openai = res.body.providers.find(p => p.provider === 'openai');
    expect(openai).toMatchObject({ has_admin_key: true, disable_mode: 'delete', running: null });
    expect(openai.last_run.status).toBe('ok');
    expect(res.body.providers.find(p => p.provider === 'anthropic').has_admin_key).toBe(false);

    const a = res.body.keys.find(k => k.key_id === 'key_a');
    expect(a).toMatchObject({ name: 'code-review-2', link: 'credential', project_name: 'Default project' });
    expect(a.usage_24h).toMatchObject({ images: 6, unpriced: true });
    expect(a.usage_24h.kinds).toEqual(['completions', 'images']);
    expect(a.coverage.volume).toBe('requests');
    expect(a.coverage.pct).toBeGreaterThan(50);
    expect(a.coverage.pct).toBeLessThan(100); // the images never reached the SDK
    expect(a.open_events.types).toEqual(['key_new_capability']);
    const b = res.body.keys.find(k => k.key_id === 'key_b');
    expect(b.link).toBe(null);
    expect(b.coverage.pct).toBe(0);
  });

  it('GET /events hides historical findings unless asked', async () => {
    const { jwt } = await ranOrg('Events Org');
    const live = await get(jwt, '/api/key-watch/events');
    expect(live.body.events).toHaveLength(2);
    const all = await get(jwt, '/api/key-watch/events?include_historical=true&key_id=key_b');
    expect(all.body.events.map(e => e.historical).sort()).toEqual([false, true]);
    expect(all.body.events[0].key_name).toBe('n8n-kommo-salesbot');
    expect((await get(jwt, '/api/key-watch/events?limit=0')).status).toBe(400);
  });

  it('PATCH /keys/:id: mark as expected without SDK, link to a credential of the same provider only', async () => {
    const { orgId, jwt, keyRow } = await ranOrg('Patch Org');
    const ok = await patch(jwt, `/api/key-watch/keys/${keyRow.key_b}`, { expected_unmonitored: true });
    expect(ok.status).toBe(200);
    expect(ok.body.data.expected_unmonitored).toBe(true);

    const sdkCred = (await pool.query(`SELECT id FROM provider_credentials WHERE org_id = $1 AND key_type = 'sdk'`, [orgId])).rows[0].id;
    const adminCred = (await pool.query(`SELECT id FROM provider_credentials WHERE org_id = $1 AND key_type = 'admin'`, [orgId])).rows[0].id;
    expect((await patch(jwt, `/api/key-watch/keys/${keyRow.key_b}`, { linked_credential_id: sdkCred })).status).toBe(200);
    expect((await patch(jwt, `/api/key-watch/keys/${keyRow.key_b}`, { linked_credential_id: adminCred })).body.code).toBe('invalid_credential');
    expect((await patch(jwt, `/api/key-watch/keys/${keyRow.key_b}`, {})).status).toBe(400);
    expect((await patch(jwt, `/api/key-watch/keys/${keyRow.key_b}`, { linked_credential_id: null })).status).toBe(200);
  });

  it('POST /events/:id/ack takes a finding out of the bell', async () => {
    const { jwt } = await ranOrg('Ack Org');
    const before = (await get(jwt, '/api/notifications')).body.notifications.filter(n => n.type === 'key_alert');
    const res = await post(jwt, `/api/key-watch/events/${before[0].data.eventId}/ack`);
    expect(res.status).toBe(200);
    const after = (await get(jwt, '/api/notifications')).body.notifications.filter(n => n.type === 'key_alert');
    expect(after).toHaveLength(before.length - 1);
    expect((await post(jwt, `/api/key-watch/events/${before[0].data.eventId}/ack`)).status).toBe(404);
  });

  it('POST /keys/:id/disable: typed name required, OpenAI deletes, audited, not twice', async () => {
    const { orgId, jwt, keyRow } = await ranOrg('Disable Org');
    const calls = fakeOpenAI();
    const wrong = await post(jwt, `/api/key-watch/keys/${keyRow.key_a}/disable`, { confirm_name: 'code-review' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('confirm_mismatch');
    expect(calls.disable).toHaveLength(0);

    const ok = await post(jwt, `/api/key-watch/keys/${keyRow.key_a}/disable`, { confirm_name: 'code-review-2' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'deleted', mode: 'delete' });
    expect(calls.disable[0]).toMatchObject({ key_id: 'key_a', project_id: 'proj_default' });

    const key = await pool.query(`SELECT status FROM provider_keys WHERE id = $1`, [keyRow.key_a]);
    expect(key.rows[0].status).toBe('deleted');
    const audit = await pool.query(`SELECT details, acknowledged_by FROM key_events WHERE org_id = $1 AND type = 'key_disabled'`, [orgId]);
    expect(audit.rows[0].details).toMatchObject({ mode: 'delete', key_name: 'code-review-2' });
    expect(audit.rows[0].details.by).toMatch(/@test\.com$/);

    const twice = await post(jwt, `/api/key-watch/keys/${keyRow.key_a}/disable`, { confirm_name: 'code-review-2' });
    expect(twice.status).toBe(409);

    // A later inventory that still lists it doesn't resurrect it
    fakeOpenAI();
    await runKeyWatch({ orgId, provider: 'openai', now: NOW });
    expect((await pool.query(`SELECT status FROM provider_keys WHERE id = $1`, [keyRow.key_a])).rows[0].status).toBe('deleted');
  });

  it('POST /keys/:id/disable: a read-only admin key gives a clear 403', async () => {
    const { jwt, keyRow } = await ranOrg('Forbidden Org');
    fakeOpenAI({ disable: async () => { throw new Error('OpenAI API 403: insufficient permissions'); } });
    const res = await post(jwt, `/api/key-watch/keys/${keyRow.key_b}/disable`, { confirm_name: 'n8n-kommo-salesbot' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('provider_forbidden');
  });

  it('Anthropic keys are deactivated (reversible), not deleted', async () => {
    const { orgId, jwt } = await createOrg('Anthropic Org');
    await addCreds(orgId, 'anthropic');
    const disabled = [];
    KEY_WATCH_PROVIDERS.anthropic.listKeys = async () => [
      { key_id: 'apikey_1', name: 'bot', redacted_hint: 'sk-ant-api03-R2D...igAA', project_id: null, project_name: 'Default', status: 'active' },
    ];
    KEY_WATCH_PROVIDERS.anthropic.fetchKeyUsage = async () => [];
    KEY_WATCH_PROVIDERS.anthropic.disableKey = async (cred, key) => { disabled.push(key.key_id); return { status: 'inactive' }; };
    await runKeyWatch({ orgId, provider: 'anthropic', now: NOW });
    const id = (await pool.query(`SELECT id FROM provider_keys WHERE org_id = $1`, [orgId])).rows[0].id;
    const res = await post(jwt, `/api/key-watch/keys/${id}/disable`, { confirm_name: 'bot' });
    expect(res.body).toMatchObject({ status: 'inactive', mode: 'deactivate' });
    expect(disabled).toEqual(['apikey_1']);
  });

  it('members can read but not act', async () => {
    const { orgId, keyRow } = await ranOrg('Member Org');
    const member = await createMember(orgId);
    expect((await get(member.jwt, '/api/key-watch/overview')).status).toBe(200);
    expect((await get(member.jwt, '/api/key-watch/events')).status).toBe(200);
    expect((await post(member.jwt, '/api/key-watch/run')).status).toBe(403);
    expect((await patch(member.jwt, `/api/key-watch/keys/${keyRow.key_b}`, { expected_unmonitored: true })).status).toBe(403);
    expect((await post(member.jwt, `/api/key-watch/keys/${keyRow.key_b}/disable`, { confirm_name: 'n8n-kommo-salesbot' })).status).toBe(403);
  });

  it('never leaks across orgs', async () => {
    const victim = await ranOrg('Victim Org');
    const other = await createOrg('Other Org');
    const overview = await get(other.jwt, '/api/key-watch/overview');
    expect(overview.body.keys).toEqual([]);
    expect((await get(other.jwt, '/api/key-watch/events?include_historical=true')).body.events).toEqual([]);
    expect((await patch(other.jwt, `/api/key-watch/keys/${victim.keyRow.key_a}`, { expected_unmonitored: true })).status).toBe(404);
    expect((await post(other.jwt, `/api/key-watch/keys/${victim.keyRow.key_a}/disable`, { confirm_name: 'code-review-2' })).status).toBe(404);
    const ev = (await pool.query(`SELECT id FROM key_events WHERE org_id = $1 LIMIT 1`, [victim.orgId])).rows[0].id;
    expect((await post(other.jwt, `/api/key-watch/events/${ev}/ack`)).status).toBe(404);
    const bell = await get(other.jwt, '/api/notifications');
    expect(bell.body.notifications.filter(n => n.type === 'key_alert')).toEqual([]);
  });
});
