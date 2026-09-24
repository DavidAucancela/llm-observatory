// Single source of truth for "given provider token counts, what did this cost?"
// inside packages/api. Pricing tables + cost fns come from @llm-observatory/sdk
// (the same tables the client SDKs use) so the API never carries its own
// drifting copy again. This module only adds:
//   1. a provider -> cost-fn dispatch map, and
//   2. the Anthropic prompt-cache-creation (cache write) surcharge.
//
// Used by services/providerUsage.js (historical sync + reconciliation fallback)
// and routes/metrics.js (model-recognition warning on ingest).

const sdk = require('@llm-observatory/sdk');

// provider -> SDK cost fn. All are (model, inputTokens, outputTokens) => number
// (USD); each normalizes the model id (snapshot-suffix stripping) internally and
// returns 0 + console.warn on an unknown model.
const PROVIDER_COST_FNS = {
  anthropic: sdk.calculateCost, // there is no calculateAnthropicCost alias — calculateCost IS Anthropic
  openai:    sdk.calculateOpenAICost,
  gemini:    sdk.calculateGeminiCost,
  grok:      sdk.calculateGrokCost,
  kimi:      sdk.calculateKimiCost,
  deepinfra: sdk.calculateDeepInfraCost, // undefined on an SDK build older than 1.3.0 — costForProviderUsage guards it
};

// provider -> SDK pricing table, used for model-recognition and normalization.
const PROVIDER_PRICING_TABLES = {
  anthropic: sdk.ANTHROPIC_PRICING,
  openai:    sdk.OPENAI_PRICING,
  gemini:    sdk.GEMINI_PRICING,
  grok:      sdk.GROK_PRICING,
  kimi:      sdk.KIMI_PRICING,
  deepinfra: sdk.DEEPINFRA_PRICING, // undefined on an SDK build older than 1.3.0 — isKnownModel guards it
};

// Anthropic bills cache-WRITE (cache_creation) input at ~1.25x the base input
// rate. The SDK cost fns take a single flat input number, so we fold the
// surcharge into an "effective input" before calling them. Approximation:
// applies the model's base input rate x1.25 uniformly and ignores the 5m vs 1h
// TTL tiers. Cache READS stay at the plain input rate — the same simplification
// the SDK already documents for Grok/Kimi/Anthropic.
const CACHE_CREATION_INPUT_MULTIPLIER = 1.25;

const KNOWN_PROVIDERS = new Set(['anthropic', 'openai', 'gemini', 'grok', 'kimi', 'deepinfra']);

function canonicalModelId(provider, model) {
  return sdk.normalizeModelId(model, PROVIDER_PRICING_TABLES[provider]);
}

function isKnownModel(provider, model) {
  const table = PROVIDER_PRICING_TABLES[provider];
  // Guard against a deployed SDK build that hasn't shipped a provider's table
  // yet: don't flag those as "unrecognized", only genuinely unknown providers.
  if (!table) return KNOWN_PROVIDERS.has(provider);
  return Boolean(table[sdk.normalizeModelId(model, table)]);
}

// tokens: { uncachedInput, cacheReadInput, cacheCreationInput, output } — all
// optional, default 0. Returns the USD estimate for this slice of usage.
function costForProviderUsage(provider, model, tokens = {}) {
  const fn = PROVIDER_COST_FNS[provider];
  if (!fn) {
    console.warn(`[pricingBridge] No cost fn for provider "${provider}" — cost set to $0`);
    return 0;
  }
  const uncached   = Number(tokens.uncachedInput)      || 0;
  const cacheRead   = Number(tokens.cacheReadInput)     || 0;
  const cacheWrite  = Number(tokens.cacheCreationInput) || 0;
  const output      = Number(tokens.output)             || 0;

  const effectiveInput =
    uncached + cacheRead + Math.round(cacheWrite * CACHE_CREATION_INPUT_MULTIPLIER);

  return fn(model, effectiveInput, output); // fn normalizes the model id itself
}

// Splits an already-RECORDED cost into what the input tokens and the output
// tokens are worth, for the "where did this model's money go" breakdown on
// /models. The split is modelled from the same pricing tables that produced the
// stored number, so it must be reconciled against it rather than trusted:
//
//   * `unattributed` (residual > 0) covers dollars the token counts can't
//     explain — sync-imported rows (bucket gap fills carry a cost but no token
//     split), models missing from the pricing tables, and the Anthropic
//     cache-write surcharge, which sync prices in but the SDK never does.
//   * a NEGATIVE residual (modelled > recorded, e.g. rows repriced or zeroed as
//     failed calls) can't be shown as a segment, so input/output are scaled
//     down to the recorded total and the row is flagged `approx`.
//
// Segments always sum to `recordedCost`, so a bar drawn from them measures real
// spend and its share of the range is honest.
const RESIDUAL_TOLERANCE = 0.005; // 0.5% — rounding noise, not a real gap

function splitRecordedCost(provider, model, { inputTokens = 0, outputTokens = 0, recordedCost = 0 } = {}) {
  const total = Number(recordedCost) || 0;
  const empty = { inputCost: 0, outputCost: 0, unattributedCost: total > 0 ? total : 0, priced: false, approx: false };

  if (total <= 0) return { inputCost: 0, outputCost: 0, unattributedCost: 0, priced: false, approx: false };
  // Skip the cost fns for models they'd only console.warn about, once per row.
  if (!isKnownModel(provider, model)) return empty;

  const input  = Number(inputTokens)  || 0;
  const output = Number(outputTokens) || 0;
  let inputCost  = costForProviderUsage(provider, model, { uncachedInput: input });
  let outputCost = costForProviderUsage(provider, model, { output });
  const modelled = inputCost + outputCost;

  if (modelled <= 0) return empty;

  const residual = total - modelled;
  if (Math.abs(residual) <= total * RESIDUAL_TOLERANCE) {
    // Within noise: absorb it so the segments add up to the cent.
    const scale = total / modelled;
    return { inputCost: inputCost * scale, outputCost: outputCost * scale, unattributedCost: 0, priced: true, approx: false };
  }
  if (residual < 0) {
    const scale = total / modelled;
    return { inputCost: inputCost * scale, outputCost: outputCost * scale, unattributedCost: 0, priced: true, approx: true };
  }
  return { inputCost, outputCost, unattributedCost: residual, priced: true, approx: false };
}

module.exports = {
  costForProviderUsage,
  splitRecordedCost,
  isKnownModel,
  canonicalModelId,
  normalizeModelId: sdk.normalizeModelId,
  CACHE_CREATION_INPUT_MULTIPLIER,
  PROVIDER_COST_FNS,
  PROVIDER_PRICING_TABLES,
};
