import re
import warnings
from typing import Any

_MODEL_SNAPSHOT_SUFFIX_RE = re.compile(r"-(\d{8}|\d{4}-\d{2}-\d{2})$")


def normalize_model_id(model: str | None, pricing_table: dict | None) -> str | None:
    """Canonicalize a raw model id before a pricing lookup: strip a ``models/``
    prefix (Gemini accepts both forms) and a trailing ``-YYYYMMDD`` /
    ``-YYYY-MM-DD`` snapshot suffix, but only when the stripped id is actually
    in ``pricing_table`` so unknown/future ids pass through untouched. Mirrors
    packages/web/src/utils/modelAlias.js and the Node SDK."""
    if not model or not isinstance(model, str):
        return model
    m = model[len("models/"):] if model.startswith("models/") else model
    if pricing_table and m in pricing_table:
        return m
    stripped = _MODEL_SNAPSHOT_SUFFIX_RE.sub("", m)
    if pricing_table and stripped in pricing_table:
        return stripped
    return m


def finalize_metric_pricing(data: dict[str, Any]) -> None:
    """Mutate the outgoing metric payload: canonicalize ``data['model']`` and
    stamp ``cost_confidence='unknown'`` when the model has no entry in its
    provider's pricing table AND the call clearly used tokens but still priced
    at $0 (the SDK failed to price it, not a genuine free call). Never
    overrides a cost_confidence the caller set explicitly."""
    if not isinstance(data, dict):
        return
    table = _PROVIDER_PRICING.get(data.get("provider"))
    model = data.get("model")
    if not table or not model:
        return
    data["model"] = normalize_model_id(model, table)
    if data.get("cost_confidence"):
        return
    used_tokens = (
        (data.get("input_tokens") or 0)
        + (data.get("output_tokens") or 0)
        + (data.get("total_tokens") or 0)
    ) > 0
    if data["model"] not in table and float(data.get("cost_usd") or 0) == 0 and used_tokens:
        data["cost_confidence"] = "unknown"


# Cost per million tokens (USD) — July 2026
ANTHROPIC_PRICING: dict[str, dict[str, float]] = {
    "claude-fable-5":               {"input": 10.00, "output": 50.00},
    "claude-mythos-5":              {"input": 10.00, "output": 50.00},
    "claude-opus-4-8":              {"input":  5.00, "output": 25.00},
    "claude-opus-4-7":              {"input":  5.00, "output": 25.00},
    "claude-opus-4-6":              {"input":  5.00, "output": 25.00},
    # Claude Sonnet 5 launched at an introductory $2/$10 rate through 2026-08-31;
    # this table uses the post-intro standard rate so it doesn't silently go stale.
    "claude-sonnet-5":              {"input":  3.00, "output": 15.00},
    "claude-sonnet-4-6":            {"input":  3.00, "output": 15.00},
    "claude-haiku-4-5":             {"input":  0.80, "output":  4.00},
    "claude-haiku-4-5-20251001":    {"input":  0.80, "output":  4.00},
    "claude-3-5-sonnet-20241022":   {"input":  3.00, "output": 15.00},
    "claude-3-5-haiku-20241022":    {"input":  0.80, "output":  4.00},
    "claude-3-opus-20240229":       {"input": 15.00, "output": 75.00},
    "claude-3-haiku-20240307":      {"input":  0.25, "output":  1.25},
}

OPENAI_PRICING: dict[str, dict[str, float]] = {
    # Current generation — July 2026
    "gpt-5.6-sol":    {"input":  5.00, "output": 30.00},
    "gpt-5.6":        {"input":  5.00, "output": 30.00},  # alias of gpt-5.6-sol
    "gpt-5.6-terra":  {"input":  2.50, "output": 15.00},
    "gpt-5.6-luna":   {"input":  1.00, "output":  6.00},
    "gpt-5.5":        {"input":  5.00, "output": 30.00},
    "gpt-5.5-pro":    {"input": 30.00, "output": 180.00},
    "gpt-5.4":        {"input":  2.50, "output": 15.00},
    "gpt-5.4-mini":   {"input":  0.75, "output":  4.50},
    "gpt-5.4-nano":   {"input":  0.20, "output":  1.25},
    "gpt-5.4-pro":    {"input": 30.00, "output": 180.00},
    "chat-latest":    {"input":  5.00, "output": 30.00},
    "gpt-5.3-codex":  {"input":  1.75, "output": 14.00},
    # Legacy — still billable
    "gpt-4o":        {"input":  2.50, "output": 10.00},
    "gpt-4o-mini":   {"input":  0.15, "output":  0.60},
    "gpt-4-turbo":   {"input": 10.00, "output": 30.00},
    "gpt-4":         {"input": 30.00, "output": 60.00},
    "gpt-3.5-turbo": {"input":  0.50, "output":  1.50},
    "o1":            {"input": 15.00, "output": 60.00},
    "o1-mini":       {"input":  3.00, "output": 12.00},
    "o3-mini":       {"input":  1.10, "output":  4.40},
    "o3":            {"input": 10.00, "output": 40.00},
    "gpt-4.1":       {"input":  2.00, "output":  8.00},
    "gpt-4.1-mini":  {"input":  0.40, "output":  1.60},
    "gpt-4.1-nano":  {"input":  0.10, "output":  0.40},
}


def calculate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    pricing = ANTHROPIC_PRICING.get(normalize_model_id(model, ANTHROPIC_PRICING))
    if not pricing:
        warnings.warn(
            f'[LLM Observatory] Unknown Anthropic model pricing: "{model}" — cost recorded as $0',
            stacklevel=3,
        )
        return 0.0
    return (input_tokens / 1_000_000) * pricing["input"] + \
           (output_tokens / 1_000_000) * pricing["output"]


def calculate_openai_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    pricing = OPENAI_PRICING.get(normalize_model_id(model, OPENAI_PRICING))
    if not pricing:
        warnings.warn(
            f'[LLM Observatory] Unknown OpenAI model pricing: "{model}" — cost recorded as $0',
            stacklevel=3,
        )
        return 0.0
    return (input_tokens / 1_000_000) * pricing["input"] + \
           (output_tokens / 1_000_000) * pricing["output"]


# Cost per million tokens (USD) — July 2026. Standard (<=200k context) tier only;
# gemini-*-pro models roughly double past 200k context, not modeled here (keep in
# sync with GEMINI_PRICING in packages/sdk/src/index.js).
GEMINI_PRICING: dict[str, dict[str, float]] = {
    "gemini-3.1-pro-preview": {"input": 2.00, "output": 12.00},
    "gemini-3.5-flash":       {"input": 1.50, "output":  9.00},
    "gemini-3-flash-preview": {"input": 0.50, "output":  3.00},
    "gemini-3.1-flash-lite":  {"input": 0.25, "output":  1.50},
    "gemini-2.5-pro":         {"input": 1.25, "output": 10.00},
    "gemini-2.5-flash":       {"input": 0.30, "output":  2.50},
}


def calculate_gemini_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    pricing = GEMINI_PRICING.get(normalize_model_id(model, GEMINI_PRICING))
    if not pricing:
        warnings.warn(
            f'[LLM Observatory] Unknown Gemini model pricing: "{model}" — cost recorded as $0',
            stacklevel=3,
        )
        return 0.0
    return (input_tokens / 1_000_000) * pricing["input"] + \
           (output_tokens / 1_000_000) * pricing["output"]


# Cost per million tokens (USD) — August 2026, per docs.x.ai/docs/models. Standard
# (<200k context) tier only; xAI doubles input/output rates at >=200k context, not
# modeled here (keep in sync with GROK_PRICING in packages/sdk/src/index.js).
GROK_PRICING: dict[str, dict[str, float]] = {
    "grok-4.6":                     {"input": 2.00, "output":  6.00},
    "grok-4.5":                     {"input": 2.00, "output":  6.00},
    "grok-4.3":                     {"input": 1.25, "output":  2.50},
    "grok-4.20-0309-reasoning":     {"input": 1.25, "output":  2.50},
    "grok-4.20-0309-non-reasoning": {"input": 1.25, "output":  2.50},
    "grok-4.20-multi-agent-0309":   {"input": 1.25, "output":  2.50},
    "grok-build-0.1":               {"input": 1.00, "output":  2.00},
}

# Cost per million tokens (USD) — August 2026, per platform.kimi.ai/docs/pricing.
# Cache-miss (standard) rate only (keep in sync with KIMI_PRICING in
# packages/sdk/src/index.js).
KIMI_PRICING: dict[str, dict[str, float]] = {
    "kimi-k3":                  {"input": 3.00, "output": 15.00},
    "kimi-k2.6":                {"input": 0.95, "output":  4.00},
    "kimi-k2.7-code":           {"input": 0.95, "output":  4.00},
    "kimi-k2.7-code-highspeed": {"input": 1.90, "output":  8.00},
}

# Cost per million tokens (USD) — per deepinfra.com/pricing, read 2026-09-21.
# DeepInfra hosts hundreds of models and reprices them often, so this covers
# only the popular ones: a model missing here prices at $0 and is flagged
# cost_confidence='unknown' instead of guessing. When the API response reports
# its own cost, that figure wins over this table. Cache-miss (standard) rate
# only. Keep in sync with DEEPINFRA_PRICING in packages/sdk/src/index.js. Ids
# are DeepInfra's own ``org/Model`` form and are case-sensitive.
DEEPINFRA_PRICING: dict[str, dict[str, float]] = {
    "deepseek-ai/DeepSeek-V4-Flash-0731":          {"input": 0.06,  "output":  0.18},
    "deepseek-ai/DeepSeek-V4-Flash":               {"input": 0.09,  "output":  0.18},
    "deepseek-ai/DeepSeek-V4-Pro":                 {"input": 1.30,  "output":  2.60},
    "deepseek-ai/DeepSeek-V3.2":                   {"input": 0.26,  "output":  0.38},
    "deepseek-ai/DeepSeek-V3.1":                   {"input": 0.25,  "output":  0.95},
    "deepseek-ai/DeepSeek-V3":                     {"input": 0.32,  "output":  0.89},
    "moonshotai/Kimi-K3":                          {"input": 2.85,  "output": 14.25},
    "moonshotai/Kimi-K2.7-Code":                   {"input": 0.68,  "output":  3.40},
    "Qwen/Qwen3-Max":                              {"input": 1.20,  "output":  6.00},
    "google/gemma-4-31B-it":                       {"input": 0.13,  "output":  0.38},
    "google/gemini-2.5-flash":                     {"input": 0.30,  "output":  2.50},
    "anthropic/claude-sonnet-5":                   {"input": 3.00,  "output": 15.00},
    "meta-llama/Llama-3.3-70B-Instruct-Turbo":     {"input": 0.10,  "output":  0.32},
    "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo": {"input": 0.02,  "output":  0.04},
    "mistralai/Mistral-Nemo-Instruct-2407":        {"input": 0.019, "output":  0.03},
}


def calculate_grok_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    pricing = GROK_PRICING.get(normalize_model_id(model, GROK_PRICING))
    if not pricing:
        warnings.warn(
            f'[LLM Observatory] Unknown Grok model pricing: "{model}" — cost recorded as $0',
            stacklevel=3,
        )
        return 0.0
    return (input_tokens / 1_000_000) * pricing["input"] + \
           (output_tokens / 1_000_000) * pricing["output"]


# Chat/text pricing tables keyed by provider — used by normalize_model_id and
# finalize_metric_pricing (defined at the top of this module; referenced here
# once every table exists). Embeddings/Whisper/TTS have their own tables and
# are covered by finalize_metric_pricing's cost_usd == 0 guard.
_PROVIDER_PRICING: dict[str, dict] = {
    "anthropic": ANTHROPIC_PRICING,
    "openai":    OPENAI_PRICING,
    "gemini":    GEMINI_PRICING,
    "grok":      GROK_PRICING,
    "kimi":      KIMI_PRICING,
    "deepinfra": DEEPINFRA_PRICING,
}


def calculate_kimi_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    pricing = KIMI_PRICING.get(normalize_model_id(model, KIMI_PRICING))
    if not pricing:
        warnings.warn(
            f'[LLM Observatory] Unknown Kimi model pricing: "{model}" — cost recorded as $0',
            stacklevel=3,
        )
        return 0.0
    return (input_tokens / 1_000_000) * pricing["input"] + \
           (output_tokens / 1_000_000) * pricing["output"]


def calculate_deepinfra_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    pricing = DEEPINFRA_PRICING.get(normalize_model_id(model, DEEPINFRA_PRICING))
    if not pricing:
        warnings.warn(
            f'[LLM Observatory] Unknown DeepInfra model pricing: "{model}" — cost recorded as $0',
            stacklevel=3,
        )
        return 0.0
    return (input_tokens / 1_000_000) * pricing["input"] + \
           (output_tokens / 1_000_000) * pricing["output"]
