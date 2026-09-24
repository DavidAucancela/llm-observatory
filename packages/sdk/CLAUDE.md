## `packages/sdk`

**Entry point:** `src/index.js` — published to npm as `@llm-observatory/sdk`

> **`packages/api` consumes this from npm** (`"@llm-observatory/sdk": "^1.3.0"`, installed by `packages/api/Dockerfile`). Keep the **published** version current: npm `1.1.0` was once left stale after `normalizeModelId` + Grok/Kimi tables landed, so prod ran without them. When you change an export the API relies on: bump `version` here, `npm publish` (needs npm auth), **and** bump the range in `packages/api/package.json` (Docker layer-caches `npm install` on that file), then redeploy the API.

**Exports:**
- `MonitoredAnthropic` — Wraps `@anthropic-ai/sdk`, intercepts `messages.create()`
- `MonitoredOpenAI` — Wraps `openai` SDK (optional peer dep), intercepts `chat.completions.create()`, plus embeddings/Whisper/TTS/Responses
- `MonitoredGemini` — Wraps `@google/genai` (optional peer dep), intercepts `models.generateContent()` / `models.generateContentStream()`. Streaming: `usageMetadata` is cumulative per chunk, not a delta — the wrapper just keeps overwriting with the latest non-null value rather than summing.
- `MonitoredGrok` — xAI's Grok. OpenAI-compatible API (`openai` peer dep, `baseURL: 'https://api.x.ai/v1'`), intercepts `chat.completions.create()` only.
- `MonitoredKimi` — Moonshot AI's Kimi. Also OpenAI-compatible (`openai` peer dep, `baseURL: 'https://api.moonshot.ai/v1'`), intercepts `chat.completions.create()` only.
- `MonitoredDeepInfra` — DeepInfra. OpenAI-compatible (`openai` peer dep, `baseURL: 'https://api.deepinfra.com/v1/openai'`, key from `apiKey` / `DEEPINFRA_API_KEY` / `DEEPINFRA_TOKEN`), intercepts `chat.completions.create()` only.
- `calculateCost()`, `calculateOpenAICost()`, `calculateGeminiCost()`, `calculateGrokCost()`, `calculateKimiCost()`, `calculateDeepInfraCost()` — Pricing helpers

**Grok/Kimi/DeepInfra share their proxy logic:** `buildOpenAICompatibleChatProxy()` / `wrapOpenAICompatibleStream()` in `src/index.js` implement the streaming + tool-call-fragment-accumulation logic once, parameterized by `provider`/`calculateCostFn`/`extractCacheReadTokens` (and an optional `extractCostFn(usage)` that, when it returns a number, overrides the table-based cost — only DeepInfra passes one); `MonitoredGrok`, `MonitoredKimi` and `MonitoredDeepInfra` are all thin classes built on top of it. `MonitoredOpenAI` is **not** built on this shared proxy — it's left untouched since it also covers embeddings/Whisper/TTS/Responses, which don't apply to Grok or Kimi. The one real divergence between the two: cached-token count lives at `usage.prompt_tokens_details.cached_tokens` for Grok (same nested shape as OpenAI) but flat at `usage.cached_tokens` for Kimi — see `extractCachedTokensNested` vs `extractCachedTokensFlat`.

**Pattern:** Proxy pattern. Intercepts API calls, records timing, calculates cost, returns response immediately, then fires async POST to `/api/metrics` with `Authorization: Bearer obs_sk_xxx`.

**Constructor options:**
```js
new MonitoredAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  observatoryUrl: 'http://localhost:3001',
  observatoryToken: 'obs_sk_...'   // Required for multi-tenant mode
})
```

**Pricing tables** in `src/index.js` (update when providers change prices; keep in sync with `packages/sdk-python/llm_observatory/_pricing.py`):
- Anthropic: claude-fable-5, claude-mythos-5, claude-opus-4-8, claude-opus-4-7, claude-opus-4-6, claude-sonnet-5, claude-sonnet-4-6, claude-haiku-4-5-20251001 (+ alias claude-haiku-4-5), claude-3-opus, claude-3-5-sonnet, claude-3-haiku. Unknown models silently record cost as $0 (with a console warning) — when Anthropic ships a new model, add it here or spend for that model vanishes from the dashboard.
- OpenAI: current gen — gpt-5.6-sol (+ alias gpt-5.6), gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.5-pro, gpt-5.4(-mini/-nano/-pro), chat-latest, gpt-5.3-codex; legacy — gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-4, gpt-3.5-turbo, o1, o1-mini, o3-mini, o3, gpt-4.1(-mini/-nano)
- Gemini (`GEMINI_PRICING`): gemini-3.1-pro-preview, gemini-3.5-flash, gemini-3-flash-preview, gemini-3.1-flash-lite, gemini-2.5-pro, gemini-2.5-flash. `packages/sdk-python` has its own `gemini.py` wrapper (`MonitoredGemini`/`AsyncMonitoredGemini`), implemented from scratch against `google-genai` rather than reusing the OpenAI-compatible proxy Grok/Kimi share.
- Grok (`GROK_PRICING`, per docs.x.ai/docs/models): grok-4.6, grok-4.5, grok-4.3, grok-4.20-0309-reasoning, grok-4.20-0309-non-reasoning, grok-4.20-multi-agent-0309, grok-build-0.1. Standard (<200k context) tier only — xAI doubles both rates at ≥200k context, not modeled, same simplification as Gemini's >200k note.
- Kimi (`KIMI_PRICING`, per platform.kimi.ai/docs/pricing): kimi-k3, kimi-k2.6, kimi-k2.7-code, kimi-k2.7-code-highspeed. Cache-miss (standard) rate only — Moonshot's cheaper cache-hit rate isn't modeled, same simplification already applied to Anthropic prompt caching elsewhere in this file (cache reads are tracked/displayed via `cache_read_tokens` but never discount `cost_usd`).
- DeepInfra (`DEEPINFRA_PRICING`, per deepinfra.com/pricing, read 2026-09-21): ~15 popular models only, keyed by DeepInfra's case-sensitive `org/Model` ids. DeepInfra hosts hundreds of models and reprices often, so a model missing from the table prices at $0 and is stamped `cost_confidence: 'unknown'` by `finalizeMetricPricing` rather than guessed. `extractDeepInfraCost(usage)` takes the billed cost from `usage.estimated_cost` (or `estimated_cost_usd`) when the response carries one — **that field name is NOT in DeepInfra's public docs; it is unverified until confirmed with a real call.** Their only billing endpoint is per-request (`POST /v1/request-costs` → `costNanoUsd`), so there is no org-level sync/reconciliation. The table was extracted from the pricing page by a summarizer — spot-check it before trusting it. Cached input is cheaper on some models but only the standard rate is modeled. Cached tokens use the nested `usage.prompt_tokens_details.cached_tokens` shape (assumed OpenAI-style, unverified).
- **Grok and Kimi, like Gemini, have no admin-key historical sync and no Costs-API reconciliation** — neither xAI's Management API nor Moonshot's API expose an organization-level historical usage/billing endpoint (verified against their docs), so `packages/api/src/routes/sync.js` and `jobs/reconciliation.js` stay Anthropic/OpenAI-only. Real-time SDK metrics (the primary use case) work fully. `packages/api/src/routes/metrics.js`'s `MetricSchema.provider` enum and the time-series zero-fill accept `'gemini'`, `'grok'`, and `'kimi'`; `packages/api/src/routes/credentials.js` accepts all three for `key_type: 'sdk'` credential rows (test-connection hits each provider's `GET /v1/models`).

**`api_key_hint` in metrics:** Both wrappers compute `maskKey(apiKey)` in the constructor and include it as `api_key_hint` in every metric POST. This links each `api_calls` record to the credential that generated it.
