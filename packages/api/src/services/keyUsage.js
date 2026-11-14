// Per-API-key inventory and usage, read from each provider's admin API. This is
// what lets the Observatory see a key being used OUTSIDE the project that owns
// it — the SDK only ever sees calls that go through its wrapper, so a leaked or
// re-used key was invisible (the 2026-11-03 incident: ~$3.30 of gpt-image usage
// on a code-review key, never recorded). services/keyWatch.js consumes this.
//
// Both providers group usage by key in hourly buckets (verified against
// OpenAI's openapi spec and Anthropic's Admin API docs, 2026-11-12):
//   OpenAI    GET /v1/organization/usage/{completions,images,embeddings,
//             audio_speeches,audio_transcriptions}  group_by api_key_id,model
//   Anthropic GET /v1/organizations/usage_report/messages  group_by api_key_id,model
// Neither Costs API breaks spend down per key, so dollars here are an
// ESTIMATE from token counts via services/pricingBridge (null when the model
// has no price — images and audio today). Detection never depends on dollars.
//
// Anthropic's usage report carries no request count, only tokens, so
// `requests` is null on its rows and keyWatch compares SDK coverage by tokens.
//
// Every row is normalized to:
//   { key_id, hour: Date, kind, model, requests, input_tokens, cached_tokens,
//     output_tokens, images, est_cost_usd }

const { fetchWithTimeout, anthropicCacheCreationTokens } = require('./providerUsage');
const { costForProviderUsage, isKnownModel } = require('./pricingBridge');

const OPENAI_BASE    = 'https://api.openai.com/v1';
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const HOURLY_PAGE    = 168; // max 1h buckets per page on both providers

// Error text keeps the "<Provider> API <status>:" shape so syncRunner's
// classifyProviderError maps it to provider_auth / provider_rate_limit / …
async function getJson(url, headers, label, init = {}) {
  const res = await fetchWithTimeout(String(url), { ...init, headers });
  if (!res.ok) throw new Error(`${label} API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? {} : res.json();
}

const openaiHeaders    = (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });
const anthropicHeaders = (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' });

// Last 4 characters of a redacted key ("sk-...0aIA", "sk-ant-api03-R2D...igAA").
// The SDK's api_key_hint and provider_credentials.key_hint end the same way
// (first 8 + '…' + last 4), which is how a provider key is matched to the
// Observatory. null when the hint doesn't end in 4 key characters.
function hintTail(hint) {
  if (!hint || typeof hint !== 'string') return null;
  const m = /([A-Za-z0-9_-]{4})\s*$/.exec(hint);
  return m ? m[1] : null;
}

const toDate = (unixSecs) => (unixSecs ? new Date(unixSecs * 1000) : null);
const int = (v) => parseInt(v || 0, 10) || 0;

function tokenCost(provider, model, tokens) {
  if (!model || !isKnownModel(provider, model)) return null;
  return costForProviderUsage(provider, model, tokens);
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

async function openaiList(url, key) {
  const out = [];
  let after = null;
  do {
    const u = new URL(url);
    u.searchParams.set('limit', '100');
    if (after) u.searchParams.set('after', after);
    const d = await getJson(u, openaiHeaders(key), 'OpenAI');
    out.push(...(d.data || []));
    after = d.has_more && d.last_id ? d.last_id : null;
  } while (after);
  return out;
}

async function listOpenAIKeys(cred) {
  const projects = await openaiList(`${OPENAI_BASE}/organization/projects`, cred.apiKey);
  const keys = [];
  for (const p of projects) {
    const list = await openaiList(`${OPENAI_BASE}/organization/projects/${encodeURIComponent(p.id)}/api_keys`, cred.apiKey);
    for (const k of list) {
      keys.push({
        key_id:                k.id,
        name:                  k.name || null,
        redacted_hint:         k.redacted_value || null,
        project_id:            p.id,
        project_name:          p.name || null,
        status:                'active',
        provider_created_at:   toDate(k.created_at),
        provider_last_used_at: toDate(k.last_used_at),
      });
    }
  }
  return keys;
}

// Each OpenAI usage endpoint and how its result maps onto a normalized row.
const OPENAI_USAGE_KINDS = {
  completions: (r) => ({
    requests: int(r.num_model_requests), input_tokens: int(r.input_tokens),
    cached_tokens: int(r.input_cached_tokens), output_tokens: int(r.output_tokens), images: 0,
  }),
  images: (r) => ({
    requests: int(r.num_model_requests), input_tokens: 0, cached_tokens: 0, output_tokens: 0, images: int(r.images),
  }),
  embeddings: (r) => ({
    requests: int(r.num_model_requests), input_tokens: int(r.input_tokens), cached_tokens: 0, output_tokens: 0, images: 0,
  }),
  audio_speeches: (r) => ({
    requests: int(r.num_model_requests), input_tokens: int(r.characters), cached_tokens: 0, output_tokens: 0, images: 0,
  }),
  audio_transcriptions: (r) => ({
    requests: int(r.num_model_requests), input_tokens: int(r.seconds), cached_tokens: 0, output_tokens: 0, images: 0,
  }),
};
// Only token kinds are priced; images/audio bill per image / second / character.
const OPENAI_PRICED_KINDS = new Set(['completions', 'embeddings']);

async function fetchOpenAIKeyUsage(cred, startDate, endDate) {
  const rows = [];
  for (const [kind, map] of Object.entries(OPENAI_USAGE_KINDS)) {
    let page = null;
    do {
      const u = new URL(`${OPENAI_BASE}/organization/usage/${kind}`);
      u.searchParams.set('start_time', String(Math.floor(startDate.getTime() / 1000)));
      u.searchParams.set('end_time',   String(Math.floor(endDate.getTime() / 1000)));
      u.searchParams.set('bucket_width', '1h');
      u.searchParams.append('group_by[]', 'api_key_id');
      u.searchParams.append('group_by[]', 'model');
      u.searchParams.set('limit', String(HOURLY_PAGE));
      if (page) u.searchParams.set('page', page);
      const d = await getJson(u, openaiHeaders(cred.apiKey), 'OpenAI');
      for (const bucket of d.data || []) {
        for (const r of bucket.results || []) {
          if (!r.api_key_id) continue; // usage not made with an API key
          const v = map(r);
          const model = r.model || 'unknown';
          rows.push({
            key_id: r.api_key_id, hour: toDate(bucket.start_time), kind, model, ...v,
            est_cost_usd: OPENAI_PRICED_KINDS.has(kind)
              ? tokenCost('openai', model, {
                  uncachedInput: Math.max(0, v.input_tokens - v.cached_tokens),
                  cacheReadInput: v.cached_tokens, output: v.output_tokens,
                })
              : null,
          });
        }
      }
      page = d.has_more ? d.next_page : null;
    } while (page);
  }
  return rows;
}

async function disableOpenAIKey(cred, key) {
  if (!key.project_id) throw new Error('OpenAI API 400: key has no project_id');
  await getJson(
    `${OPENAI_BASE}/organization/projects/${encodeURIComponent(key.project_id)}/api_keys/${encodeURIComponent(key.key_id)}`,
    openaiHeaders(cred.apiKey), 'OpenAI', { method: 'DELETE' }
  );
  return { status: 'deleted' };
}

// ── Anthropic ────────────────────────────────────────────────────────────────

async function anthropicList(path, key) {
  const out = [];
  let after = null;
  do {
    const u = new URL(`${ANTHROPIC_BASE}${path}`);
    u.searchParams.set('limit', '1000');
    if (after) u.searchParams.set('after_id', after);
    const d = await getJson(u, anthropicHeaders(key), 'Anthropic');
    out.push(...(d.data || []));
    after = d.has_more && d.last_id ? d.last_id : null;
  } while (after);
  return out;
}

async function listAnthropicKeys(cred) {
  const keys = await anthropicList('/organizations/api_keys', cred.apiKey);
  // Workspace names are cosmetic — a failure here must not stop the watch.
  let names = new Map();
  try {
    const ws = await anthropicList('/organizations/workspaces', cred.apiKey);
    names = new Map(ws.map(w => [w.id, w.name]));
  } catch { /* keep ids */ }
  return keys.map(k => {
    const ws = k.scope?.workspace_id || k.workspace_id || null;
    return {
      key_id:                k.id,
      name:                  k.name || null,
      redacted_hint:         k.partial_key_hint || null,
      project_id:            ws,
      project_name:          ws ? (names.get(ws) || ws) : 'Default',
      status:                k.status || 'active',
      provider_created_at:   k.created_at ? new Date(k.created_at) : null,
      provider_last_used_at: null, // not exposed by Anthropic
    };
  });
}

async function fetchAnthropicKeyUsage(cred, startDate, endDate) {
  const rows = [];
  let page = null;
  do {
    const u = new URL(`${ANTHROPIC_BASE}/organizations/usage_report/messages`);
    u.searchParams.set('starting_at', startDate.toISOString().split('.')[0] + 'Z');
    u.searchParams.set('ending_at',   endDate.toISOString().split('.')[0] + 'Z');
    u.searchParams.set('bucket_width', '1h');
    u.searchParams.append('group_by[]', 'api_key_id');
    u.searchParams.append('group_by[]', 'model');
    u.searchParams.set('limit', String(HOURLY_PAGE));
    if (page) u.searchParams.set('page', page);
    const d = await getJson(u, anthropicHeaders(cred.apiKey), 'Anthropic');
    for (const bucket of d.data || []) {
      for (const r of bucket.results || []) {
        if (!r.api_key_id) continue; // Console / managed-agent usage, no key
        const uncached = int(r.uncached_input_tokens);
        const cacheRead = int(r.cache_read_input_tokens);
        const cacheWrite = anthropicCacheCreationTokens(r);
        const output = int(r.output_tokens);
        const model = r.model || 'unknown';
        rows.push({
          key_id: r.api_key_id, hour: new Date(bucket.starting_at), kind: 'messages', model,
          requests: null, input_tokens: uncached + cacheRead + cacheWrite, cached_tokens: cacheRead,
          output_tokens: output, images: 0,
          est_cost_usd: tokenCost('anthropic', model, {
            uncachedInput: uncached, cacheReadInput: cacheRead, cacheCreationInput: cacheWrite, output,
          }),
        });
      }
    }
    page = d.has_more ? d.next_page : null;
  } while (page);
  return rows;
}

async function disableAnthropicKey(cred, key) {
  await getJson(
    `${ANTHROPIC_BASE}/organizations/api_keys/${encodeURIComponent(key.key_id)}`,
    anthropicHeaders(cred.apiKey), 'Anthropic',
    { method: 'POST', body: JSON.stringify({ status: 'inactive' }) }
  );
  return { status: 'inactive' };
}

module.exports = {
  hintTail,
  listOpenAIKeys, fetchOpenAIKeyUsage, disableOpenAIKey,
  listAnthropicKeys, fetchAnthropicKeyUsage, disableAnthropicKey,
  OPENAI_USAGE_KINDS,
};
