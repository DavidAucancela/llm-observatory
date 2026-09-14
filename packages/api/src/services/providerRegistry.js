// Maps each provider's capabilities (constants/providers.js) to the functions
// that actually implement them. Sits between the pure capability data and
// providerUsage.js so neither has to know about the other.
//
// This replaces two binary ternaries that had grown dangerous as providers were
// added: `provider === 'anthropic' ? fetchAnthropic… : fetchOpenAI…` in
// jobs/reconciliation.js and routes/sync.js. With five providers the `else`
// branch silently meant "OpenAI", so a Grok/Gemini/Kimi admin key was sent to
// api.openai.com — a cross-provider credential leak that produced a 401, an
// `error` row in reconciliation_runs and a false notification in the bell.
//
// Adding the sixth provider is one entry here plus its fetchers.

const {
  fetchAnthropicUsage, fetchOpenAIUsage,
  fetchAnthropicRealCost, fetchOpenAIRealCost,
  fetchGrokUsage, fetchGrokRealCost,
} = require('./providerUsage');

// realCost — the provider's own billed-dollar figure (ground truth).
// usage     — token-level buckets, used both by sync and as reconciliation's
//             fallback when realCost fails. NULL when the provider exposes no
//             independent token source: reconciliation then has nothing to fall
//             back to and the error propagates, which is the honest outcome.
// accountId — passed through from provider_credentials.provider_account_id.
const PROVIDER_BILLING = {
  anthropic: {
    realCost: (cred, start, end) => fetchAnthropicRealCost(cred.apiKey, start, end),
    usage:    (cred, start, end) => fetchAnthropicUsage(cred.apiKey, start, end),
  },
  openai: {
    realCost: (cred, start, end) => fetchOpenAIRealCost(cred.apiKey, start, end),
    usage:    (cred, start, end) => fetchOpenAIUsage(cred.apiKey, start, end),
  },
  grok: {
    // No `usage` entry: xAI's usage and billed-cost figures come from the
    // exact same call (services/providerUsage.js's module comment explains
    // why), so there is nothing weaker to fall back to if realCost fails.
    realCost: (cred, start, end) => fetchGrokRealCost(cred.apiKey, cred.accountId, start, end),
  },
  // gemini and kimi are absent on purpose: neither exposes an org-level billing
  // API, so they must be skipped entirely rather than fall through to someone
  // else's endpoint.
};

function billingFor(provider) {
  return PROVIDER_BILLING[provider] || null;
}

// Providers reconciliation should even look at. Used to filter in SQL so
// unsupported providers never reach the loop, instead of being filtered (or
// not) inside it.
function reconcilableProviders() {
  return Object.keys(PROVIDER_BILLING);
}

// ── routes/sync.js dispatch ──────────────────────────────────────────────────
// fetchBuckets(cred, startDate, endDate) always returns { buckets, startISO,
// endISO } — ISO strings regardless of what shape the underlying usage API
// used (Anthropic and OpenAI's usage endpoints take different timestamp
// formats internally; that's absorbed here instead of leaking into sync.js).
//
// clampDayTotal: true tells importBuckets to cap each day's inserted gap at
// what the provider actually billed that day, summed across every model —
// not just the (model, day) pair being inserted. Anthropic/OpenAI don't need
// this because their usage API reports the exact same model ids the SDK
// sends, so a per-(model,day) gap is already correct. Grok's Management API
// reports free-text descriptions ("Chat grok-4-0709") that can disagree with
// what the SDK recorded ("grok-4.6") for the same underlying model — without
// the clamp, a mismatch would double-count that day's spend instead of
// finding no gap.
const SYNC_PROVIDERS = {
  anthropic: {
    clampDayTotal: false,
    async fetchBuckets(cred, startDate, endDate) {
      const buckets = await fetchAnthropicUsage(cred.apiKey, startDate, endDate);
      return { buckets, startISO: startDate.toISOString().split('.')[0] + 'Z', endISO: endDate.toISOString().split('.')[0] + 'Z' };
    },
  },
  openai: {
    clampDayTotal: false,
    async fetchBuckets(cred, startDate, endDate) {
      const buckets = await fetchOpenAIUsage(cred.apiKey, startDate, endDate);
      return { buckets, startISO: startDate.toISOString(), endISO: endDate.toISOString() };
    },
  },
  grok: {
    clampDayTotal: true,
    async fetchBuckets(cred, startDate, endDate) {
      const buckets = await fetchGrokUsage(cred.apiKey, cred.accountId, startDate, endDate);
      return { buckets, startISO: startDate.toISOString(), endISO: endDate.toISOString() };
    },
  },
};

function syncableProviders() {
  return Object.keys(SYNC_PROVIDERS);
}

module.exports = {
  PROVIDER_BILLING, billingFor, reconcilableProviders,
  SYNC_PROVIDERS, syncableProviders,
};
