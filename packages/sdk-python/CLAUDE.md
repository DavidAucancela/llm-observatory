## `packages/sdk-python`

**Entry point:** `llm_observatory/__init__.py` — published to PyPI as `llm-observatory`

**Exports:**
- `MonitoredAnthropic`, `AsyncMonitoredAnthropic` — Wraps `anthropic.Anthropic` / `anthropic.AsyncAnthropic`
- `MonitoredOpenAI`, `AsyncMonitoredOpenAI` — Wraps `openai.OpenAI` / `openai.AsyncOpenAI`
- `MonitoredGemini`, `AsyncMonitoredGemini` — Wraps `google.genai.Client` (sync surface + its `.aio` namespace for async — there is no separate async client class), intercepts `models.generate_content()` / `models.generate_content_stream()`. Implemented from scratch (not OpenAI-compatible, unlike Grok/Kimi) — see the implementation note below.
- `MonitoredGrok`, `AsyncMonitoredGrok` — xAI's Grok. Also wraps `openai.OpenAI` / `openai.AsyncOpenAI` (Grok's API is OpenAI-compatible), pinned to `base_url="https://api.x.ai/v1"`
- `MonitoredKimi`, `AsyncMonitoredKimi` — Moonshot AI's Kimi. Same pattern, `base_url="https://api.moonshot.ai/v1"`
- `MonitoredDeepInfra`, `AsyncMonitoredDeepInfra` — DeepInfra. Same pattern, `base_url="https://api.deepinfra.com/v1/openai"`, key from `api_key` / `DEEPINFRA_API_KEY` / `DEEPINFRA_TOKEN`. Prefers a cost reported in `usage.estimated_cost` (or `estimated_cost_usd`; field name unverified) over the pricing table; a model missing from the table records $0 and is flagged `cost_confidence="unknown"`.
- `calculate_cost()`, `calculate_openai_cost()`, `calculate_gemini_cost()`, `calculate_grok_cost()`, `calculate_kimi_cost()`, `calculate_deepinfra_cost()` — Pricing helpers
- `ANTHROPIC_PRICING`, `OPENAI_PRICING`, `GEMINI_PRICING`, `GROK_PRICING`, `KIMI_PRICING`, `DEEPINFRA_PRICING` — Pricing tables (`DEEPINFRA_PRICING` must stay identical to the Node SDK's — `tests/test_pricing.py` parses `packages/sdk/src/index.js` to enforce it)

**Install:**
```bash
pip install -e packages/sdk-python              # Anthropic only
pip install -e "packages/sdk-python[openai]"    # With OpenAI support
pip install -e "packages/sdk-python[gemini]"    # With Gemini support (installs google-genai)
pip install -e "packages/sdk-python[grok]"      # With Grok support (installs openai — same underlying package)
pip install -e "packages/sdk-python[kimi]"      # With Kimi support (installs openai — same underlying package)
pip install -e "packages/sdk-python[deepinfra]" # With DeepInfra support (installs openai — same underlying package)
```

**Constructor options (all classes share the same signature):**
```python
MonitoredAnthropic(
    api_key="sk-ant-...",           # Optional — falls back to ANTHROPIC_API_KEY env var
    observatory_url="http://localhost:3001",
    observatory_token="obs_sk_...", # Required for multi-tenant mode
    tags={"env": "prod"},           # Optional key-value metadata
    # Any other kwargs forwarded to anthropic.Anthropic()
)
```

**Fire-and-forget mechanism:**
- Sync classes: spawn daemon thread (`threading.Thread(daemon=True)`)
- Async classes: `loop.run_in_executor(None, ...)` — never blocks the event loop
- Both: 1 retry after 1s on failure, 5s timeout per attempt

**Metric payload:** same shape as Node.js SDK, including:
- `cache_read_tokens` / `cache_write_tokens` — from `usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens` for Anthropic, or `usage_metadata.cached_content_token_count` for Gemini (`cache_write_tokens` always 0 — Gemini has no separate cache-write count). For the OpenAI-compatible wrappers (`openai.py`, `grok.py`, `kimi.py`, `deepinfra.py`) `cache_read_tokens` comes from `usage.prompt_tokens_details.cached_tokens` (Kimi: flat `usage.cached_tokens`) via `_cached_tokens_nested`/`_cached_tokens_flat` in `openai.py`, mirroring Node's `extractCachedTokens*`; `cache_write_tokens` is always 0 (no such field).
- `error_type` — classified by `classify_error()`: `auth_error`, `rate_limit`, `invalid_request`, `network_error`, `timeout`, `server_error`, `unknown_error`. Gemini's `google.genai.errors.APIError` exposes `.code` (int) instead of `.status_code` — `classify_error()` checks `.status_code`, then `.code`, then `.status` in that order to support all providers.
- `error_message` — raw exception message, truncated to 500 chars

**Key files:**
```
llm_observatory/
├── __init__.py      Exports
├── anthropic.py     MonitoredAnthropic + AsyncMonitoredAnthropic
├── openai.py        MonitoredOpenAI + AsyncMonitoredOpenAI. Also exports module-level
│                    _accumulate_stream_delta()/_finalize_stream_response() — generic
│                    OpenAI-chunk stream-accumulation helpers reused (imported directly)
│                    by grok.py and kimi.py rather than duplicated.
├── gemini.py        MonitoredGemini + AsyncMonitoredGemini — implemented from scratch
│                    against google.genai.Client (not OpenAI-shaped, so it doesn't reuse
│                    openai.py's helpers). Async variant reuses the same Client's .aio
│                    namespace rather than a separate async client class. Streaming
│                    accumulator overwrites (never sums) usage_metadata per chunk — it's
│                    cumulative, not delta, same as the Node SDK.
├── grok.py          MonitoredGrok + AsyncMonitoredGrok — same structure as openai.py,
│                    provider='grok', calculate_grok_cost, base_url=api.x.ai/v1,
│                    falls back to XAI_API_KEY env var
├── kimi.py          MonitoredKimi + AsyncMonitoredKimi — same structure as openai.py,
│                    provider='kimi', calculate_kimi_cost, base_url=api.moonshot.ai/v1,
│                    falls back to MOONSHOT_API_KEY env var
├── _utils.py        _post_metric(), send_metric_background(), classify_error(), mask_key(),
│                    extract_gemini_*() — Gemini-specific request/response extraction helpers
└── _pricing.py      Pricing tables (keep in sync with Node.js SDK)
```

**Grok/Kimi/DeepInfra implementation note:** all three providers expose an OpenAI-shaped `chat.completions` API, so `grok.py`/`kimi.py` construct a real `openai.OpenAI`/`openai.AsyncOpenAI` client pointed at the provider's `base_url` rather than talking to the provider directly — same approach as the Node SDK. Neither file duplicates the streaming/tool-call-accumulation logic; both import `_accumulate_stream_delta`/`_finalize_stream_response` straight from `openai.py`. No admin-key historical sync or Costs-API reconciliation for either provider (see `packages/sdk/CLAUDE.md` — neither xAI's nor Moonshot's API exposes an org-level usage/billing endpoint). Gemini has the same "no admin-key sync" limitation despite being implemented from scratch rather than OpenAI-compatible.

**Tests:**
```bash
cd packages/sdk-python
pytest tests/ -v
```
