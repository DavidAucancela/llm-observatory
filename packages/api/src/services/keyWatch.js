// Key audit — detects an API key being used outside the project that owns it.
//
// Why this exists: the Observatory only sees calls that go through its SDK. On
// 2026-11-03 an OpenAI key registered for a code-review bot spent ~$3.30 on
// gpt-image models that the bot never makes; nothing in the Observatory
// noticed, because the sync only imported daily `usage/completions` and
// reconciliation compares one org-wide daily total. This service asks the
// PROVIDER, per key and per hour, what each key did (services/keyUsage.js)
// and compares that with what the SDK recorded for the same key.
//
// Flow of one run (runKeyWatch): key inventory → hourly usage of the window →
// upsert → detectKeyEvents (pure) → key_events → bell + Discord + socket.
// Window: the last LIVE_WINDOW_HOURS (usage lands late, so recent hours are
// re-read; upserts make that idempotent); the first run for a provider
// backfills BACKFILL_DAYS to build each key's baseline, and the events it finds
// about the past are stored as `historical` (shown on /security, never pushed).
//
// Thresholds live here, like services/insights.js. Detection never needs
// dollars: image/audio usage has no price in pricingBridge, but a code-review
// key suddenly generating images is suspicious at any price.

const pool = require('../db/pool');
const { decrypt } = require('../db/crypto');
const { keyWatchFor, KEY_WATCH_PROVIDERS } = require('./providerRegistry');
const { PROVIDER_CAPS, PROVIDER_LABELS, keyDisableMode, providersWith } = require('../constants/providers');
const { hintTail } = require('./keyUsage');
const { classifyProviderError } = require('./syncRunner');
const { sendSyncDiscordAlert } = require('./syncAlerts');
const { DAY_MS, floorUtcDay } = require('../utils/retention');

const HOUR_MS = 60 * 60 * 1000;

// ── Thresholds ───────────────────────────────────────────────────────────────
const LIVE_WINDOW_HOURS = 6;     // hours re-read on every run
const BACKFILL_DAYS = 14;        // first run per provider
const HISTORY_DAYS = 30;         // baseline for "never used this before"
const MIN_HISTORY_DAYS = 3;      // a key younger than this has no baseline yet
const DORMANT_DAYS = 30;         // unused this long, then used again → event
const LOOKBACK_DAYS = DORMANT_DAYS + 15; // usage loaded before each evaluated day
const COVERAGE_ALERT_BELOW = 0.5;  // SDK saw < 50% of what the provider billed
const SHADOW_MIN_REQUESTS = 5;     // …and at least this many unseen requests
const SHADOW_MIN_TOKENS = 5000;    // (Anthropic: tokens, it reports no requests)
const SHADOW_MIN_USD = 0.5;        // …or this many unseen (estimated) dollars
const SPIKE_FLOOR_USD = 2;         // an hour costing more than max(this,
const SPIKE_MULTIPLIER = 5;        //   5 × the key's busiest hour of the week)
const HISTORICAL_AFTER_MS = 24 * HOUR_MS; // backfill events older than this stay quiet
const LINK_LOOKBACK_DAYS = 90;     // SDK hints older than this don't link a key
const STALE_RUN_MS = 30 * 60 * 1000;
const FAILURES_BEFORE_ALERT = 2;

// Hourly at :45 — clear of alerts (:00), auto-sync (:15) and reconciliation (03:30).
const KEY_WATCH_CRON = '45 * * * *';
const KEY_WATCH_LOCK_KEY = 74_110_602;

const autoKeyWatchEnabled = () => process.env.KEY_WATCH_ENABLED !== 'false';

let emitKeyAlert = () => {};
function setKeyWatchEmitter(fn) { emitKeyAlert = typeof fn === 'function' ? fn : () => {}; }

class KeyWatchError extends Error {
  constructor(code, message, { status = 400, params = {} } = {}) {
    super(message);
    this.name = 'KeyWatchError';
    this.code = code;
    this.status = status;
    this.params = params;
  }
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const ms = (d) => (d instanceof Date ? d.getTime() : Date.parse(d));
const num = (v) => (v == null ? 0 : Number(v) || 0);
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// Model id without its snapshot date: a key moving from gpt-5.5-2026-04-23 to
// a newer snapshot of the same model is not a new capability.
function modelFamily(model) {
  return String(model || 'unknown').replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
}

function utcDays(startMs, endMs) {
  const days = [];
  for (let d = floorUtcDay(startMs); d <= endMs; d += DAY_MS) days.push(ymd(d));
  return days;
}

// ── Linking provider keys to the Observatory ─────────────────────────────────
// A key is "linked" when the Observatory knows it: an admin linked it by hand,
// or its last 4 chars match a registered SDK credential or recent SDK metrics.
// Two keys of one provider sharing a tail are ambiguous: neither auto-links,
// and SDK rows with that tail aren't attributed to either (manual link only).
//
// keys:  [{ key_id, hint_tail, linked_credential_id }]
// creds: [{ id, key_hint }]  (key_type 'sdk', same provider)
// sdkHints: api_key_hint values seen recently in api_calls
// → { linkOf: Map key_id → 'manual'|'credential'|'sdk'|null, keyForHint(hint) }
function linkKeys(keys, creds, sdkHints) {
  const tailCount = new Map();
  for (const k of keys) if (k.hint_tail) tailCount.set(k.hint_tail, (tailCount.get(k.hint_tail) || 0) + 1);
  const credTails = new Set(creds.map(c => hintTail(c.key_hint)).filter(Boolean));
  const sdkTails = new Set([...sdkHints].map(hintTail).filter(Boolean));
  const credHintById = new Map(creds.map(c => [c.id, c.key_hint]));

  const linkOf = new Map();
  const byExactHint = new Map(); // manual links: the credential's exact hint
  const byTail = new Map();
  for (const k of keys) {
    const unique = k.hint_tail && tailCount.get(k.hint_tail) === 1;
    let link = null;
    if (k.linked_credential_id) {
      link = 'manual';
      const h = credHintById.get(k.linked_credential_id);
      if (h) byExactHint.set(h, k.key_id);
    } else if (unique && credTails.has(k.hint_tail)) link = 'credential';
    else if (unique && sdkTails.has(k.hint_tail)) link = 'sdk';
    linkOf.set(k.key_id, link);
    if (unique) byTail.set(k.hint_tail, k.key_id);
  }
  const keyForHint = (hint) => byExactHint.get(hint) || byTail.get(hintTail(hint)) || null;
  return { linkOf, keyForHint };
}

// ── Pure detection ───────────────────────────────────────────────────────────

function summarize(rows) {
  const s = {
    requests: 0, has_requests: false, tokens: 0, images: 0,
    est_cost_usd: 0, unpriced: false, kinds: new Set(), models: new Map(),
    first_hour: null, last_hour: null,
  };
  for (const r of rows) {
    const t = ms(r.hour);
    if (r.requests != null) { s.requests += num(r.requests); s.has_requests = true; }
    const tokens = num(r.input_tokens) + num(r.output_tokens);
    s.tokens += tokens;
    s.images += num(r.images);
    const active = num(r.requests) > 0 || tokens > 0 || num(r.images) > 0;
    if (r.est_cost_usd == null) { if (active) s.unpriced = true; }
    else s.est_cost_usd += num(r.est_cost_usd);
    s.kinds.add(r.kind);
    const key = `${r.kind}|${r.model}`;
    const m = s.models.get(key) || { kind: r.kind, model: r.model, requests: 0, tokens: 0, images: 0, est_cost_usd: 0, unpriced: false };
    m.requests += num(r.requests); m.tokens += tokens; m.images += num(r.images);
    if (r.est_cost_usd == null) { if (active) m.unpriced = true; } else m.est_cost_usd += num(r.est_cost_usd);
    s.models.set(key, m);
    if (s.first_hour == null || t < s.first_hour) s.first_hour = t;
    if (s.last_hour == null || t > s.last_hour) s.last_hour = t;
  }
  return s;
}

function usageDetails(s) {
  const models = [...s.models.values()]
    .sort((a, b) => (b.est_cost_usd - a.est_cost_usd) || (b.images - a.images) || (b.requests - a.requests))
    .slice(0, 10)
    .map(m => ({ ...m, est_cost_usd: round6(m.est_cost_usd) }));
  return {
    requests: s.has_requests ? s.requests : null,
    tokens: s.tokens,
    images: s.images,
    est_cost_usd: round6(s.est_cost_usd),
    unpriced: s.unpriced,
    kinds: [...s.kinds].sort(),
    models,
  };
}

function hourlyCost(rows) {
  const byHour = new Map();
  for (const r of rows) {
    if (r.est_cost_usd == null) continue;
    const t = ms(r.hour);
    byHour.set(t, (byHour.get(t) || 0) + num(r.est_cost_usd));
  }
  return byHour;
}

// keys:  [{ key_id, name, linked, expected_unmonitored, prev_last_used_at }]
// usage: key_usage_hourly rows covering [first day − LOOKBACK_DAYS, last day end]
// sdk:   [{ key_id, hour, requests, tokens, cost }] attributed SDK rows
// days:  UTC 'YYYY-MM-DD' strings to evaluate
// volume: 'requests' | 'tokens' — what SDK coverage is measured in
// → [{ key_id, type, severity, day, first_hour, last_hour, details }]
function detectKeyEvents({ keys, usage, sdk = [], days, volume = 'requests' }) {
  const keyMap = new Map(keys.map(k => [k.key_id, k]));
  const usageByKey = new Map();
  for (const r of usage) {
    if (!usageByKey.has(r.key_id)) usageByKey.set(r.key_id, []);
    usageByKey.get(r.key_id).push(r);
  }
  const sdkByKeyDay = new Map();
  for (const r of sdk) {
    if (!r.key_id) continue;
    const k = `${r.key_id}|${ymd(ms(r.hour))}`;
    const acc = sdkByKeyDay.get(k) || { requests: 0, tokens: 0, cost: 0 };
    acc.requests += num(r.requests); acc.tokens += num(r.tokens); acc.cost += num(r.cost);
    sdkByKeyDay.set(k, acc);
  }

  const events = [];
  for (const [keyId, rows] of usageByKey) {
    const key = keyMap.get(keyId) || { key_id: keyId, name: null, linked: false, expected_unmonitored: false };
    for (const day of days) {
      const dayStart = Date.parse(`${day}T00:00:00Z`);
      const dayEnd = dayStart + DAY_MS;
      const today = rows.filter(r => { const t = ms(r.hour); return t >= dayStart && t < dayEnd; });
      const s = summarize(today);
      if (!today.length || (s.requests === 0 && s.tokens === 0 && s.images === 0)) continue;

      const before = rows.filter(r => ms(r.hour) < dayStart);
      const prior = before.filter(r => ms(r.hour) >= dayStart - HISTORY_DAYS * DAY_MS);
      const base = {
        key_id: keyId, day,
        first_hour: new Date(s.first_hour).toISOString(),
        last_hour: new Date(s.last_hour).toISOString(),
      };
      const details = { key_name: key.name || null, ...usageDetails(s) };
      const push = (type, severity, extra = {}) => events.push({ ...base, type, severity, details: { ...details, ...extra } });

      // 1. Usage the Observatory can't attribute, or the SDK didn't see.
      if (!key.expected_unmonitored) {
        if (!key.linked) {
          push('key_unknown', 'medium');
        } else {
          const seen = sdkByKeyDay.get(`${keyId}|${day}`) || { requests: 0, tokens: 0, cost: 0 };
          const providerVol = volume === 'requests' ? s.requests : s.tokens;
          const sdkVol = volume === 'requests' ? seen.requests : seen.tokens;
          const coverage = providerVol > 0 ? Math.min(1, sdkVol / providerVol) : 1;
          const shadowVol = Math.max(0, providerVol - sdkVol);
          const shadowUsd = Math.max(0, s.est_cost_usd - seen.cost);
          const bigEnough = (volume === 'requests' ? shadowVol >= SHADOW_MIN_REQUESTS : shadowVol >= SHADOW_MIN_TOKENS)
            || shadowUsd >= SHADOW_MIN_USD;
          if (coverage < COVERAGE_ALERT_BELOW && bigEnough) {
            push('key_unmonitored_usage', 'high', {
              volume, provider_volume: providerVol, sdk_volume: sdkVol,
              coverage_pct: Math.round(coverage * 1000) / 10, shadow_est_usd: round6(shadowUsd),
            });
          }
        }
      }

      // 2. Something this key never did before (needs a baseline).
      if (prior.length) {
        const oldest = Math.min(...prior.map(r => ms(r.hour)));
        if (oldest <= dayStart - MIN_HISTORY_DAYS * DAY_MS) {
          const priorKinds = new Set(prior.map(r => r.kind));
          const priorFamilies = new Set(prior.map(r => modelFamily(r.model)));
          const newKinds = [...s.kinds].filter(k => !priorKinds.has(k)).sort();
          const newModels = [...new Set(today.map(r => modelFamily(r.model)))]
            .filter(f => f !== 'unknown' && !priorFamilies.has(f)).sort();
          if (newKinds.length || newModels.length) {
            push('key_new_capability', newKinds.length ? 'high' : 'medium', {
              new_kinds: newKinds, new_models: newModels, baseline_kinds: [...priorKinds].sort(),
            });
          }
        }
      }

      // 3. An hour far above the key's busiest hour of the previous week.
      const weekBefore = prior.filter(r => ms(r.hour) >= dayStart - 7 * DAY_MS);
      const baselineMax = Math.max(0, ...hourlyCost(weekBefore).values());
      const todayHours = [...hourlyCost(today).entries()];
      if (todayHours.length) {
        const [peakHour, peakCost] = todayHours.reduce((a, b) => (b[1] > a[1] ? b : a));
        const threshold = Math.max(SPIKE_FLOOR_USD, SPIKE_MULTIPLIER * baselineMax);
        if (peakCost > threshold) {
          push('key_spend_spike', 'medium', {
            peak_hour: new Date(peakHour).toISOString(), peak_hour_usd: round6(peakCost),
            baseline_hour_max_usd: round6(baselineMax), threshold_usd: round6(threshold),
          });
        }
      }

      // 4. A key that had gone quiet is used again.
      const dormantCut = dayStart - DORMANT_DAYS * DAY_MS;
      const usedBeforeCut = before.some(r => ms(r.hour) < dormantCut);
      const usedSinceCut = before.some(r => ms(r.hour) >= dormantCut);
      const prevLast = key.prev_last_used_at ? ms(key.prev_last_used_at) : null;
      if ((usedBeforeCut && !usedSinceCut) || (prevLast != null && prevLast < dormantCut)) {
        const lastBefore = before.length ? Math.max(...before.map(r => ms(r.hour))) : prevLast;
        push('key_dormant_active', 'medium', {
          last_used_before: lastBefore ? new Date(lastBefore).toISOString() : null,
        });
      }
    }
  }
  return events;
}

// ── Database layer ───────────────────────────────────────────────────────────

async function loadAdminCred(orgId, provider) {
  const r = await pool.query(
    `SELECT api_key_encrypted, provider_account_id FROM provider_credentials
     WHERE org_id = $1 AND provider = $2 AND key_type = 'admin'
     ORDER BY created_at DESC LIMIT 1`,
    [orgId, provider]
  );
  if (!r.rows.length) {
    throw new KeyWatchError('missing_admin_key', `No admin key for ${provider}`, { params: { provider: PROVIDER_LABELS[provider] || provider } });
  }
  return { apiKey: decrypt(r.rows[0].api_key_encrypted), accountId: r.rows[0].provider_account_id };
}

async function markStaleKeyWatchRuns({ all = false } = {}) {
  const r = await pool.query(
    `UPDATE key_watch_runs SET status = 'interrupted', error_code = 'interrupted', completed_at = NOW()
     WHERE status = 'running' ${all ? '' : `AND started_at < NOW() - ($1 || ' milliseconds')::interval`}`,
    all ? [] : [String(STALE_RUN_MS)]
  );
  return r.rowCount;
}

async function startRun(orgId, provider, trigger) {
  await pool.query(
    `UPDATE key_watch_runs SET status = 'interrupted', error_code = 'interrupted', completed_at = NOW()
     WHERE org_id = $1 AND provider = $2 AND status = 'running'
       AND started_at < NOW() - ($3 || ' milliseconds')::interval`,
    [orgId, provider, String(STALE_RUN_MS)]
  );
  try {
    const r = await pool.query(
      `INSERT INTO key_watch_runs (org_id, provider, trigger) VALUES ($1, $2, $3) RETURNING id`,
      [orgId, provider, trigger]
    );
    return r.rows[0].id;
  } catch (err) {
    if (err.code === '23505') throw new KeyWatchError('already_running', 'A key watch run is already in progress', { status: 409 });
    throw err;
  }
}

async function finishRun(runId, { status, errorCode = null, errorMessage = null, details = {} }) {
  await pool.query(
    `UPDATE key_watch_runs SET status = $2, error_code = $3, error_message = $4, details = $5, completed_at = NOW()
     WHERE id = $1`,
    [runId, status, errorCode, errorMessage, JSON.stringify(details)]
  );
}

// Upserts the provider's key list; returns the previous provider_last_used_at
// per key (dormancy detection needs the value from BEFORE this run). Keys the
// provider stopped listing are marked 'missing' (unless we deleted them).
async function upsertInventory(orgId, provider, keys) {
  const prev = await pool.query(
    `SELECT key_id, provider_last_used_at FROM provider_keys WHERE org_id = $1 AND provider = $2`,
    [orgId, provider]
  );
  const prevLast = new Map(prev.rows.map(r => [r.key_id, r.provider_last_used_at]));
  if (keys.length) {
    await pool.query(
      `INSERT INTO provider_keys (org_id, provider, key_id, name, redacted_hint, hint_tail, project_id, project_name,
                                  status, provider_created_at, provider_last_used_at, last_seen_at)
       SELECT $1, $2, k.key_id, k.name, k.redacted_hint, k.hint_tail, k.project_id, k.project_name,
              k.status, k.created_at, k.last_used_at, NOW()
       FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::timestamptz[], $11::timestamptz[])
         AS k(key_id, name, redacted_hint, hint_tail, project_id, project_name, status, created_at, last_used_at)
       ON CONFLICT (org_id, provider, key_id) DO UPDATE SET
         name = EXCLUDED.name, redacted_hint = EXCLUDED.redacted_hint, hint_tail = EXCLUDED.hint_tail,
         project_id = EXCLUDED.project_id, project_name = EXCLUDED.project_name,
         status = CASE WHEN provider_keys.status = 'deleted' THEN 'deleted' ELSE EXCLUDED.status END,
         provider_created_at = COALESCE(EXCLUDED.provider_created_at, provider_keys.provider_created_at),
         provider_last_used_at = COALESCE(EXCLUDED.provider_last_used_at, provider_keys.provider_last_used_at),
         last_seen_at = NOW()`,
      [
        orgId, provider,
        keys.map(k => k.key_id), keys.map(k => k.name), keys.map(k => k.redacted_hint),
        keys.map(k => hintTail(k.redacted_hint)), keys.map(k => k.project_id), keys.map(k => k.project_name),
        keys.map(k => k.status || 'active'),
        keys.map(k => k.provider_created_at), keys.map(k => k.provider_last_used_at),
      ]
    );
  }
  await pool.query(
    `UPDATE provider_keys SET status = 'missing'
     WHERE org_id = $1 AND provider = $2 AND NOT (key_id = ANY($3::text[])) AND status NOT IN ('deleted', 'missing')`,
    [orgId, provider, keys.map(k => k.key_id)]
  );
  return prevLast;
}

const USAGE_CHUNK = 500;
async function upsertUsage(orgId, provider, rows) {
  // A deleted key's past usage still appears in the report: make sure every
  // key with usage has an inventory row so the UI can show it.
  const unknownIds = [...new Set(rows.map(r => r.key_id))];
  if (unknownIds.length) {
    await pool.query(
      `INSERT INTO provider_keys (org_id, provider, key_id, status)
       SELECT $1, $2, id, 'missing' FROM unnest($3::text[]) AS id
       ON CONFLICT (org_id, provider, key_id) DO NOTHING`,
      [orgId, provider, unknownIds]
    );
  }
  for (let i = 0; i < rows.length; i += USAGE_CHUNK) {
    const c = rows.slice(i, i + USAGE_CHUNK);
    await pool.query(
      `INSERT INTO key_usage_hourly (org_id, provider, key_id, hour, kind, model, requests, input_tokens,
                                     cached_tokens, output_tokens, images, est_cost_usd)
       SELECT $1, $2, u.key_id, u.hour, u.kind, u.model, u.requests, u.input_tokens, u.cached_tokens,
              u.output_tokens, u.images, u.est_cost_usd
       FROM unnest($3::text[], $4::timestamptz[], $5::text[], $6::text[], $7::int[], $8::bigint[], $9::bigint[],
                   $10::bigint[], $11::int[], $12::numeric[])
         AS u(key_id, hour, kind, model, requests, input_tokens, cached_tokens, output_tokens, images, est_cost_usd)
       ON CONFLICT (org_id, provider, key_id, hour, kind, model) DO UPDATE SET
         requests = EXCLUDED.requests, input_tokens = EXCLUDED.input_tokens, cached_tokens = EXCLUDED.cached_tokens,
         output_tokens = EXCLUDED.output_tokens, images = EXCLUDED.images, est_cost_usd = EXCLUDED.est_cost_usd`,
      [
        orgId, provider,
        c.map(r => r.key_id), c.map(r => r.hour), c.map(r => r.kind), c.map(r => r.model),
        c.map(r => r.requests), c.map(r => r.input_tokens || 0), c.map(r => r.cached_tokens || 0),
        c.map(r => r.output_tokens || 0), c.map(r => r.images || 0), c.map(r => r.est_cost_usd),
      ]
    );
  }
}

const LIVE_SDK_FILTER = `(prompt_preview IS NULL OR (prompt_preview NOT LIKE 'sync:%' AND prompt_preview NOT LIKE 'test:%' AND prompt_preview <> 'eval:judge'))`;

// Keys + link state for one (org, provider). Shared by detection and overview.
async function loadKeyLinks(orgId, provider) {
  const [keys, creds, hints] = await Promise.all([
    pool.query(`SELECT * FROM provider_keys WHERE org_id = $1 AND provider = $2 ORDER BY id`, [orgId, provider]),
    pool.query(
      `SELECT id, key_hint, label FROM provider_credentials WHERE org_id = $1 AND provider = $2 AND key_type = 'sdk'`,
      [orgId, provider]
    ),
    pool.query(
      `SELECT DISTINCT api_key_hint FROM api_calls
       WHERE org_id = $1 AND provider = $2 AND api_key_hint IS NOT NULL
         AND timestamp >= NOW() - ($3 || ' days')::interval AND ${LIVE_SDK_FILTER}`,
      [orgId, provider, String(LINK_LOOKBACK_DAYS)]
    ),
  ]);
  const links = linkKeys(keys.rows, creds.rows, new Set(hints.rows.map(r => r.api_key_hint)));
  return { keys: keys.rows, creds: creds.rows, ...links };
}

// SDK rows per (key, hour) in [startMs, endMs), attributed through keyForHint.
async function loadSdkHourly(orgId, provider, startMs, endMs, keyForHint) {
  const r = await pool.query(
    `SELECT api_key_hint, date_trunc('hour', timestamp, 'UTC') AS hour, COUNT(*)::int AS requests,
            SUM(input_tokens + output_tokens + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0))::bigint AS tokens,
            SUM(cost_usd) AS cost
     FROM api_calls
     WHERE org_id = $1 AND provider = $2 AND api_key_hint IS NOT NULL
       AND timestamp >= $3 AND timestamp < $4 AND ${LIVE_SDK_FILTER}
     GROUP BY 1, 2`,
    [orgId, provider, new Date(startMs), new Date(endMs)]
  );
  return r.rows
    .map(row => ({ key_id: keyForHint(row.api_key_hint), hour: row.hour, requests: row.requests, tokens: num(row.tokens), cost: num(row.cost) }))
    .filter(row => row.key_id);
}

async function loadUsage(orgId, provider, startMs, endMs) {
  const r = await pool.query(
    `SELECT key_id, hour, kind, model, requests, input_tokens, cached_tokens, output_tokens, images, est_cost_usd
     FROM key_usage_hourly WHERE org_id = $1 AND provider = $2 AND hour >= $3 AND hour < $4`,
    [orgId, provider, new Date(startMs), new Date(endMs)]
  );
  return r.rows.map(row => ({
    ...row,
    input_tokens: num(row.input_tokens), cached_tokens: num(row.cached_tokens), output_tokens: num(row.output_tokens),
    est_cost_usd: row.est_cost_usd == null ? null : Number(row.est_cost_usd),
  }));
}

// Upserts events; returns the stored rows with `inserted` (new this run).
async function saveEvents(orgId, provider, events, { isHistorical }) {
  const saved = [];
  for (const e of events) {
    const historical = isHistorical(e);
    const r = await pool.query(
      `INSERT INTO key_events (org_id, provider, key_id, type, severity, day, first_hour, last_hour, details, historical)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (org_id, provider, key_id, type, day) DO UPDATE SET
         severity   = CASE WHEN key_events.severity = 'high' THEN 'high' ELSE EXCLUDED.severity END,
         first_hour = LEAST(key_events.first_hour, EXCLUDED.first_hour),
         last_hour  = GREATEST(key_events.last_hour, EXCLUDED.last_hour),
         details    = EXCLUDED.details,
         historical = key_events.historical AND EXCLUDED.historical,
         updated_at = NOW()
       RETURNING id, key_id, type, severity, day, details, historical, (xmax = 0) AS inserted`,
      [orgId, provider, e.key_id, e.type, e.severity, e.day, e.first_hour, e.last_hour, JSON.stringify(e.details), historical]
    );
    saved.push(r.rows[0]);
  }
  return saved;
}

// ── Notifications ────────────────────────────────────────────────────────────

const EVENT_TITLES = {
  key_unmonitored_usage: 'Uso de una clave que el SDK no registró',
  key_new_capability:    'Una clave hizo algo que nunca había hecho',
  key_spend_spike:       'Pico de gasto en una clave',
  key_unknown:           'Uso de una clave que el Observatory no conoce',
  key_dormant_active:    'Una clave inactiva volvió a usarse',
};

const CONSOLE_URL = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
};

function describeEvent(e) {
  const d = e.details || {};
  const parts = [];
  if (d.requests != null) parts.push(`${d.requests} peticiones`);
  if (d.images) parts.push(`${d.images} imágenes`);
  if (d.tokens) parts.push(`${d.tokens.toLocaleString('es')} tokens`);
  const usd = d.est_cost_usd ? `~$${d.est_cost_usd.toFixed(2)}${d.unpriced ? ' + uso sin precio' : ''}` : (d.unpriced ? 'costo sin precio (imágenes/audio)' : null);
  if (usd) parts.push(usd);
  const lines = [parts.join(' · ')];
  if (e.type === 'key_new_capability') {
    if (d.new_kinds?.length) lines.push(`Nuevo: **${d.new_kinds.join(', ')}** (antes solo ${d.baseline_kinds?.join(', ') || '—'})`);
    if (d.new_models?.length) lines.push(`Modelos nuevos: ${d.new_models.join(', ')}`);
  }
  if (e.type === 'key_unmonitored_usage') lines.push(`El SDK vio el ${d.coverage_pct}% (${d.sdk_volume} de ${d.provider_volume} ${d.volume === 'requests' ? 'peticiones' : 'tokens'})`);
  if (e.type === 'key_spend_spike') lines.push(`Hora pico ~$${d.peak_hour_usd} (máximo de la semana anterior ~$${d.baseline_hour_max_usd})`);
  if (e.type === 'key_dormant_active' && d.last_used_before) lines.push(`Último uso anterior: ${d.last_used_before.slice(0, 10)}`);
  return lines.filter(Boolean).join('\n');
}

async function notifyEvent(orgId, provider, e, keyRow) {
  const appUrl = process.env.APP_URL || 'http://localhost:5173';
  const label = PROVIDER_LABELS[provider] || provider;
  const name = keyRow?.name || e.details?.key_name || e.key_id;
  return sendSyncDiscordAlert(orgId, provider, {
    severity: e.severity === 'high' ? 'error' : 'warning',
    title: `🔑 ${EVENT_TITLES[e.type] || e.type}: ${label} · ${name}`,
    description: describeEvent(e),
    fields: [
      { name: 'Clave', value: `${name}${keyRow?.redacted_hint ? ` (${keyRow.redacted_hint})` : ''}`, inline: true },
      { name: 'Proyecto', value: keyRow?.project_name || '—', inline: true },
      { name: 'Día (UTC)', value: String(e.day).slice(0, 10), inline: true },
      { name: 'Revisar', value: `${appUrl}/security?key=${encodeURIComponent(e.key_id)} · ${CONSOLE_URL[provider] || ''}` },
    ],
    footer: 'LLM Observatory — Auditoría de claves',
  });
}

async function failureAlert(orgId, provider, code, message) {
  const r = await pool.query(
    `SELECT status FROM key_watch_runs
     WHERE org_id = $1 AND provider = $2 AND status <> 'running' AND (error_code IS NULL OR error_code <> 'interrupted')
     ORDER BY started_at DESC, id DESC LIMIT $3`,
    [orgId, provider, FAILURES_BEFORE_ALERT]
  );
  let streak = 1;
  for (const row of r.rows) { if (row.status !== 'error') break; streak++; }
  if (streak !== FAILURES_BEFORE_ALERT) return {};
  const label = PROVIDER_LABELS[provider] || provider;
  const discord = await sendSyncDiscordAlert(orgId, provider, {
    severity: 'error',
    title: `⛔ La auditoría de claves de ${label} está fallando`,
    description: code === 'provider_auth'
      ? `${label} rechazó la admin key ${streak} veces seguidas: no se están vigilando las claves.`
      : `Las últimas ${streak} revisiones de claves de ${label} fallaron: no se están vigilando las claves.`,
    fields: [{ name: 'Último error', value: String(message).slice(0, 500) }],
    footer: 'LLM Observatory — Auditoría de claves',
  });
  return { alert: 'repeated_failure', failures: streak, discord };
}

// ── Run ──────────────────────────────────────────────────────────────────────

// trigger: 'auto' (cron) | 'manual' ("Revisar ahora") | 'backfill' (new admin key)
async function runKeyWatch({ orgId, provider, trigger = 'auto', now = Date.now() }) {
  const impl = keyWatchFor(provider);
  if (!impl || !PROVIDER_CAPS[provider]?.keyWatch) {
    throw new KeyWatchError('not_supported', `Key watch is not available for ${provider}`, { params: { provider } });
  }
  const cred = await loadAdminCred(orgId, provider);
  const runId = await startRun(orgId, provider, trigger);
  try {
    const prior = await pool.query(
      `SELECT 1 FROM key_watch_runs WHERE org_id = $1 AND provider = $2 AND status = 'ok' LIMIT 1`,
      [orgId, provider]
    );
    const initial = trigger === 'backfill' || prior.rows.length === 0;
    const startMs = initial
      ? floorUtcDay(now - BACKFILL_DAYS * DAY_MS)
      : Math.floor(now / HOUR_MS) * HOUR_MS - LIVE_WINDOW_HOURS * HOUR_MS;

    const inventory = await impl.listKeys(cred);
    const prevLast = await upsertInventory(orgId, provider, inventory);
    const usage = await impl.fetchKeyUsage(cred, new Date(startMs), new Date(now));
    await upsertUsage(orgId, provider, usage);

    const days = utcDays(startMs, now);
    const firstDay = Date.parse(`${days[0]}T00:00:00Z`);
    const endDay = Date.parse(`${days[days.length - 1]}T00:00:00Z`) + DAY_MS;
    const { keys, keyForHint, linkOf } = await loadKeyLinks(orgId, provider);
    const [history, sdk] = await Promise.all([
      loadUsage(orgId, provider, firstDay - LOOKBACK_DAYS * DAY_MS, endDay),
      loadSdkHourly(orgId, provider, firstDay, endDay, keyForHint),
    ]);
    const events = detectKeyEvents({
      keys: keys.map(k => ({
        key_id: k.key_id, name: k.name, linked: Boolean(linkOf.get(k.key_id)),
        expected_unmonitored: k.expected_unmonitored, prev_last_used_at: prevLast.get(k.key_id) || null,
      })),
      usage: history, sdk, days, volume: impl.volume,
    });

    const saved = await saveEvents(orgId, provider, events, {
      isHistorical: (e) => initial && Date.parse(e.last_hour) < now - HISTORICAL_AFTER_MS,
    });
    const fresh = saved.filter(e => e.inserted && !e.historical);
    const keyById = new Map(keys.map(k => [k.key_id, k]));
    for (const e of fresh) {
      const discord = await notifyEvent(orgId, provider, e, keyById.get(e.key_id));
      await pool.query(`UPDATE key_events SET discord = $2 WHERE id = $1`, [e.id, discord]);
    }
    if (fresh.length) emitKeyAlert(orgId, { provider, count: fresh.length });

    const details = {
      initial, window: { start: new Date(startMs).toISOString(), end: new Date(now).toISOString() },
      keys: inventory.length, usage_rows: usage.length, events: saved.length, new_events: fresh.length,
    };
    await finishRun(runId, { status: 'ok', details });
    return { run_id: runId, status: 'ok', ...details };
  } catch (err) {
    const code = err instanceof KeyWatchError ? err.code : classifyProviderError(err).replace(/^sync_failed$/, 'watch_failed');
    const alert = await failureAlert(orgId, provider, code, err.message).catch(() => ({}));
    await finishRun(runId, { status: 'error', errorCode: code, errorMessage: String(err.message).slice(0, 2000), details: alert });
    if (!(err instanceof KeyWatchError)) console.error(`[keyWatch] ${provider} org ${orgId}:`, err.message);
    return { run_id: runId, status: 'error', code };
  }
}

// Every (org, provider) with an admin key on a keyWatch provider. The cron
// (orgId null) skips the public demo org, whose admin keys are fake.
async function eligiblePairs(orgId = null) {
  const params = [providersWith('keyWatch').filter(p => KEY_WATCH_PROVIDERS[p])];
  let where = `pc.key_type = 'admin' AND pc.provider = ANY($1)`;
  if (orgId != null) { params.push(orgId); where += ` AND pc.org_id = $2`; }
  else where += ` AND o.slug IS DISTINCT FROM 'demo'`;
  const r = await pool.query(
    `SELECT DISTINCT pc.org_id, pc.provider FROM provider_credentials pc
     JOIN organizations o ON o.id = pc.org_id WHERE ${where} ORDER BY pc.org_id, pc.provider`,
    params
  );
  return r.rows;
}

async function runPairs(pairs, trigger, now) {
  const results = [];
  for (const { org_id: orgId, provider } of pairs) {
    try {
      results.push({ org_id: orgId, provider, ...(await runKeyWatch({ orgId, provider, trigger, now })) });
    } catch (err) {
      results.push({ org_id: orgId, provider, status: 'skipped', code: err.code || 'watch_failed' });
    }
  }
  return results;
}

// "Revisar ahora" for one org, or the hourly sweep over all orgs (orgId null)
// under an advisory lock so a second API replica skips it.
async function keyWatchAll({ orgId = null, trigger = 'auto', now = Date.now() } = {}) {
  if (orgId != null) return runPairs(await eligiblePairs(orgId), trigger, now);
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [KEY_WATCH_LOCK_KEY]);
    if (!rows[0].ok) return Object.assign([], { locked: true });
    try {
      return await runPairs(await eligiblePairs(null), trigger, now);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [KEY_WATCH_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

// A new admin key on a keyWatch provider: backfill right away (fire and
// forget) instead of waiting up to an hour. Skipped under Jest so route tests
// that save an admin key never reach a real provider; tests call runKeyWatch.
function startInitialKeyWatch(orgId, provider) {
  if (!autoKeyWatchEnabled() || process.env.NODE_ENV === 'test') return false;
  if (!PROVIDER_CAPS[provider]?.keyWatch || !KEY_WATCH_PROVIDERS[provider]) return false;
  runKeyWatch({ orgId, provider, trigger: 'backfill' })
    .catch(err => console.error(`[keyWatch] initial ${provider} org ${orgId}:`, err.message));
  return true;
}

// ── Disable ──────────────────────────────────────────────────────────────────

async function disableProviderKey({ orgId, id, confirmName, userId }) {
  const r = await pool.query(`SELECT * FROM provider_keys WHERE id = $1 AND org_id = $2`, [id, orgId]);
  const key = r.rows[0];
  if (!key) throw new KeyWatchError('not_found', 'Key not found', { status: 404 });
  const mode = keyDisableMode(key.provider);
  const impl = keyWatchFor(key.provider);
  if (!mode || !impl?.disableKey) throw new KeyWatchError('not_supported', 'This provider cannot disable keys', { params: { provider: key.provider } });
  if (['deleted', 'inactive', 'archived'].includes(key.status)) {
    throw new KeyWatchError('already_disabled', 'Key is already disabled', { status: 409 });
  }
  const expected = key.name || key.key_id;
  if (String(confirmName || '').trim() !== expected) {
    throw new KeyWatchError('confirm_mismatch', 'Type the key name to confirm', { params: { expected } });
  }
  const cred = await loadAdminCred(orgId, key.provider);
  try {
    await impl.disableKey(cred, key);
  } catch (err) {
    const code = classifyProviderError(err);
    if (code === 'provider_auth') {
      throw new KeyWatchError('provider_forbidden', err.message, { status: 403, params: { provider: PROVIDER_LABELS[key.provider] } });
    }
    throw new KeyWatchError(code === 'sync_failed' ? 'disable_failed' : code, err.message, { status: 502 });
  }
  const status = mode === 'delete' ? 'deleted' : 'inactive';
  await pool.query(`UPDATE provider_keys SET status = $3 WHERE id = $1 AND org_id = $2`, [id, orgId, status]);
  const user = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
  await pool.query(
    `INSERT INTO key_events (org_id, provider, key_id, type, severity, day, details, acknowledged_at, acknowledged_by)
     VALUES ($1, $2, $3, 'key_disabled', 'medium', CURRENT_DATE, $4, NOW(), $5)
     ON CONFLICT (org_id, provider, key_id, type, day) DO UPDATE SET details = EXCLUDED.details, updated_at = NOW()`,
    [orgId, key.provider, key.key_id, JSON.stringify({ key_name: key.name, mode, by: user.rows[0]?.email || null }), userId]
  );
  return { status, mode };
}

// ── Overview (GET /api/key-watch/overview) ───────────────────────────────────

async function keyWatchOverview(orgId, now = Date.now()) {
  const providers = providersWith('keyWatch').filter(p => KEY_WATCH_PROVIDERS[p]);
  const admin = await pool.query(
    `SELECT DISTINCT provider FROM provider_credentials WHERE org_id = $1 AND key_type = 'admin' AND provider = ANY($2)`,
    [orgId, providers]
  );
  const withAdmin = new Set(admin.rows.map(r => r.provider));
  const out = { providers: [], keys: [], auto: { enabled: autoKeyWatchEnabled(), cron: KEY_WATCH_CRON } };
  const dayAgo = now - DAY_MS;
  const weekAgo = now - 7 * DAY_MS;

  for (const provider of providers) {
    const [last, running] = await Promise.all([
      pool.query(
        `SELECT id, trigger, status, error_code, details, started_at, completed_at FROM key_watch_runs
         WHERE org_id = $1 AND provider = $2 AND status <> 'running' ORDER BY started_at DESC LIMIT 1`,
        [orgId, provider]
      ),
      pool.query(`SELECT id, started_at FROM key_watch_runs WHERE org_id = $1 AND provider = $2 AND status = 'running'`, [orgId, provider]),
    ]);
    out.providers.push({
      provider, label: PROVIDER_LABELS[provider] || provider, has_admin_key: withAdmin.has(provider),
      disable_mode: keyDisableMode(provider), last_run: last.rows[0] || null, running: running.rows[0] || null,
    });
    if (!withAdmin.has(provider)) continue;

    const { keys, creds, keyForHint, linkOf } = await loadKeyLinks(orgId, provider);
    if (!keys.length) continue;
    const [usage, sdk, events] = await Promise.all([
      loadUsage(orgId, provider, weekAgo, now + HOUR_MS),
      loadSdkHourly(orgId, provider, weekAgo, now + HOUR_MS, keyForHint),
      pool.query(
        `SELECT key_id, COUNT(*)::int AS open, array_agg(DISTINCT type) AS types, MAX(created_at) AS latest
         FROM key_events WHERE org_id = $1 AND provider = $2 AND acknowledged_at IS NULL AND type <> 'key_disabled'
         GROUP BY key_id`,
        [orgId, provider]
      ),
    ]);
    const eventsByKey = new Map(events.rows.map(r => [r.key_id, r]));
    const credById = new Map(creds.map(c => [c.id, c]));
    const volume = KEY_WATCH_PROVIDERS[provider].volume;

    for (const k of keys) {
      const rows = usage.filter(u => u.key_id === k.key_id);
      const s24 = usageDetails(summarize(rows.filter(u => ms(u.hour) >= dayAgo)));
      const s7 = usageDetails(summarize(rows));
      const seen = sdk.filter(x => x.key_id === k.key_id);
      const sdkVol = seen.reduce((a, x) => a + (volume === 'requests' ? x.requests : x.tokens), 0);
      const provVol = volume === 'requests' ? (s7.requests || 0) : s7.tokens;
      const lastHour = rows.length ? Math.max(...rows.map(u => ms(u.hour))) : null;
      const ev = eventsByKey.get(k.key_id);
      const cred = k.linked_credential_id ? credById.get(k.linked_credential_id) : null;
      out.keys.push({
        id: k.id, provider, key_id: k.key_id, name: k.name, redacted_hint: k.redacted_hint,
        project_name: k.project_name, status: k.status,
        provider_created_at: k.provider_created_at, provider_last_used_at: k.provider_last_used_at,
        last_usage_hour: lastHour ? new Date(lastHour).toISOString() : null,
        link: linkOf.get(k.key_id) || null,
        linked_credential: cred ? { id: cred.id, label: cred.label, key_hint: cred.key_hint } : null,
        expected_unmonitored: k.expected_unmonitored,
        usage_24h: s24, usage_7d: s7,
        coverage: { volume, provider: provVol, sdk: sdkVol, pct: provVol > 0 ? Math.round(Math.min(1, sdkVol / provVol) * 1000) / 10 : null },
        open_events: ev ? { count: ev.open, types: ev.types, latest: ev.latest } : null,
      });
    }
  }
  out.keys.sort((a, b) => (b.open_events?.count || 0) - (a.open_events?.count || 0)
    || (b.usage_7d.est_cost_usd - a.usage_7d.est_cost_usd) || (b.usage_7d.requests || 0) - (a.usage_7d.requests || 0));
  return out;
}

module.exports = {
  KeyWatchError, runKeyWatch, keyWatchAll, startInitialKeyWatch, disableProviderKey, keyWatchOverview,
  detectKeyEvents, linkKeys, modelFamily, markStaleKeyWatchRuns, setKeyWatchEmitter, autoKeyWatchEnabled,
  KEY_WATCH_CRON, BACKFILL_DAYS, LIVE_WINDOW_HOURS,
  THRESHOLDS: {
    COVERAGE_ALERT_BELOW, SHADOW_MIN_REQUESTS, SHADOW_MIN_TOKENS, SHADOW_MIN_USD,
    SPIKE_FLOOR_USD, SPIKE_MULTIPLIER, MIN_HISTORY_DAYS, HISTORY_DAYS, DORMANT_DAYS,
  },
};
