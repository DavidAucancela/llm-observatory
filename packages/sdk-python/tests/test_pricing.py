import re

import pytest
from llm_observatory._pricing import (
    ANTHROPIC_PRICING,
    OPENAI_PRICING,
    GEMINI_PRICING,
    GROK_PRICING,
    KIMI_PRICING,
    DEEPINFRA_PRICING,
    calculate_cost,
    calculate_openai_cost,
    calculate_gemini_cost,
    calculate_grok_cost,
    calculate_kimi_cost,
    calculate_deepinfra_cost,
    normalize_model_id,
    finalize_metric_pricing,
)


class TestCalculateCost:
    def test_sonnet_cost(self):
        # (1M input * $3) + (1M output * $15) = $18
        assert calculate_cost("claude-sonnet-4-6", 1_000_000, 1_000_000) == pytest.approx(18.0)

    def test_opus_cost(self):
        # (1M input * $5) + (1M output * $25) = $30
        assert calculate_cost("claude-opus-4-6", 1_000_000, 1_000_000) == pytest.approx(30.0)

    def test_haiku_cost(self):
        # (1M input * $0.80) + (1M output * $4.00) = $4.80
        assert calculate_cost("claude-haiku-4-5-20251001", 1_000_000, 1_000_000) == pytest.approx(4.80)

    def test_zero_tokens(self):
        assert calculate_cost("claude-sonnet-4-6", 0, 0) == 0.0

    def test_unknown_model_returns_zero(self):
        assert calculate_cost("unknown-model-xyz", 1_000_000, 1_000_000) == 0.0

    def test_partial_million_tokens(self):
        # 500k input + 100k output for sonnet: (0.5*3) + (0.1*15) = 1.5 + 1.5 = 3.0
        assert calculate_cost("claude-sonnet-4-6", 500_000, 100_000) == pytest.approx(3.0)

    def test_all_anthropic_models_have_valid_pricing(self):
        for model, pricing in ANTHROPIC_PRICING.items():
            assert pricing["input"] >= 0, f"{model} input price must be >= 0"
            assert pricing["output"] >= 0, f"{model} output price must be >= 0"


class TestCalculateOpenAICost:
    def test_gpt4o_cost(self):
        # (1M input * $2.50) + (1M output * $10.00) = $12.50
        assert calculate_openai_cost("gpt-4o", 1_000_000, 1_000_000) == pytest.approx(12.50)

    def test_gpt4o_mini_cost(self):
        assert calculate_openai_cost("gpt-4o-mini", 1_000_000, 1_000_000) == pytest.approx(0.75)

    def test_zero_tokens(self):
        assert calculate_openai_cost("gpt-4o", 0, 0) == 0.0

    def test_unknown_model_returns_zero(self):
        assert calculate_openai_cost("unknown-model-xyz", 1_000_000, 1_000_000) == 0.0

    def test_all_openai_models_have_valid_pricing(self):
        for model, pricing in OPENAI_PRICING.items():
            assert pricing["input"] >= 0, f"{model} input price must be >= 0"
            assert pricing["output"] >= 0, f"{model} output price must be >= 0"


class TestCalculateGeminiCost:
    def test_gemini_2_5_flash_cost(self):
        # (1M input * $0.30) + (1M output * $2.50) = $2.80
        assert calculate_gemini_cost("gemini-2.5-flash", 1_000_000, 1_000_000) == pytest.approx(2.80)

    def test_zero_tokens(self):
        assert calculate_gemini_cost("gemini-2.5-flash", 0, 0) == 0.0

    def test_unknown_model_returns_zero(self):
        assert calculate_gemini_cost("unknown-model-xyz", 1_000_000, 1_000_000) == 0.0

    def test_all_gemini_models_have_valid_pricing(self):
        for model, pricing in GEMINI_PRICING.items():
            assert pricing["input"] >= 0, f"{model} input price must be >= 0"
            assert pricing["output"] >= 0, f"{model} output price must be >= 0"


class TestCalculateGrokCost:
    def test_grok_4_6_cost(self):
        # (1M input * $2.00) + (1M output * $6.00) = $8.00
        assert calculate_grok_cost("grok-4.6", 1_000_000, 1_000_000) == pytest.approx(8.0)

    def test_zero_tokens(self):
        assert calculate_grok_cost("grok-4.6", 0, 0) == 0.0

    def test_unknown_model_returns_zero(self):
        assert calculate_grok_cost("unknown-model-xyz", 1_000_000, 1_000_000) == 0.0

    def test_all_grok_models_have_valid_pricing(self):
        for model, pricing in GROK_PRICING.items():
            assert pricing["input"] >= 0, f"{model} input price must be >= 0"
            assert pricing["output"] >= 0, f"{model} output price must be >= 0"


class TestCalculateKimiCost:
    def test_kimi_k3_cost(self):
        # (1M input * $3.00) + (1M output * $15.00) = $18.00
        assert calculate_kimi_cost("kimi-k3", 1_000_000, 1_000_000) == pytest.approx(18.0)

    def test_zero_tokens(self):
        assert calculate_kimi_cost("kimi-k3", 0, 0) == 0.0

    def test_unknown_model_returns_zero(self):
        assert calculate_kimi_cost("unknown-model-xyz", 1_000_000, 1_000_000) == 0.0

    def test_all_kimi_models_have_valid_pricing(self):
        for model, pricing in KIMI_PRICING.items():
            assert pricing["input"] >= 0, f"{model} input price must be >= 0"
            assert pricing["output"] >= 0, f"{model} output price must be >= 0"


class TestCalculateDeepInfraCost:
    def test_llama_cost(self):
        # (1M input * $0.10) + (1M output * $0.32) = $0.42
        model = "meta-llama/Llama-3.3-70B-Instruct-Turbo"
        assert calculate_deepinfra_cost(model, 1_000_000, 1_000_000) == pytest.approx(0.42)

    def test_zero_tokens(self):
        assert calculate_deepinfra_cost("deepseek-ai/DeepSeek-V4-Pro", 0, 0) == 0.0

    def test_unknown_model_returns_zero(self):
        with pytest.warns(UserWarning, match="Unknown DeepInfra model pricing"):
            assert calculate_deepinfra_cost("some-org/unknown-model", 1_000_000, 1_000_000) == 0.0

    def test_all_deepinfra_models_have_valid_pricing_and_org_ids(self):
        for model, pricing in DEEPINFRA_PRICING.items():
            assert re.fullmatch(r"[^/\s]+/[^/\s]+", model), f"{model} should be an org/Model id"
            assert pricing["input"] >= 0, f"{model} input price must be >= 0"
            assert pricing["output"] >= 0, f"{model} output price must be >= 0"

    def test_finalize_flags_unpriced_deepinfra_model_unknown(self):
        data = {"provider": "deepinfra", "model": "some-org/unknown-model",
                "input_tokens": 10, "output_tokens": 5, "cost_usd": 0.0}
        finalize_metric_pricing(data)
        assert data["cost_confidence"] == "unknown"


class TestNormalizeModelId:
    def test_strips_models_prefix(self):
        assert normalize_model_id("models/gemini-2.5-flash", GEMINI_PRICING) == "gemini-2.5-flash"

    def test_strips_dated_snapshot_suffix(self):
        assert normalize_model_id("claude-sonnet-5-20250930", ANTHROPIC_PRICING) == "claude-sonnet-5"
        assert normalize_model_id("gpt-4o-2024-11-20", OPENAI_PRICING) == "gpt-4o"

    def test_unknown_id_passes_through(self):
        assert normalize_model_id("brand-new-model-20990101", OPENAI_PRICING) == "brand-new-model-20990101"

    def test_does_not_break_a_real_priced_id(self):
        assert normalize_model_id("grok-4.20-0309-reasoning", GROK_PRICING) == "grok-4.20-0309-reasoning"


class TestCalculateCostNonCanonical:
    def test_dated_anthropic_snapshot(self):
        assert calculate_cost("claude-sonnet-5-20250930", 1_000_000, 1_000_000) == pytest.approx(18.0)

    def test_models_prefixed_gemini(self):
        p = GEMINI_PRICING["gemini-2.5-flash"]
        assert calculate_gemini_cost("models/gemini-2.5-flash", 1_000_000, 1_000_000) == pytest.approx(
            p["input"] + p["output"]
        )


class TestFinalizeMetricPricing:
    def test_flags_unknown_when_token_call_priced_zero(self):
        data = {"provider": "openai", "model": "gpt-9-future", "input_tokens": 100, "output_tokens": 50, "cost_usd": 0}
        finalize_metric_pricing(data)
        assert data["cost_confidence"] == "unknown"

    def test_priced_model_left_unset(self):
        data = {"provider": "openai", "model": "gpt-4o", "input_tokens": 100, "cost_usd": 1.23}
        finalize_metric_pricing(data)
        assert "cost_confidence" not in data

    def test_canonicalizes_model_in_place(self):
        data = {"provider": "anthropic", "model": "claude-sonnet-5-20250930", "total_tokens": 10, "cost_usd": 1}
        finalize_metric_pricing(data)
        assert data["model"] == "claude-sonnet-5"

    def test_does_not_override_explicit_confidence(self):
        data = {"provider": "openai", "model": "gpt-9-future", "input_tokens": 100, "cost_usd": 0, "cost_confidence": "known"}
        finalize_metric_pricing(data)
        assert data["cost_confidence"] == "known"

    def test_ignores_genuine_zero_token_call(self):
        data = {"provider": "openai", "model": "gpt-9-future", "input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cost_usd": 0}
        finalize_metric_pricing(data)
        assert "cost_confidence" not in data


class TestNodePythonPricingParity:
    """The two SDK pricing tables must stay identical (see packages/sdk/CLAUDE.md)."""

    def _load_node_tables(self):
        import pathlib
        import re

        src = pathlib.Path(__file__).parents[2] / "sdk" / "src" / "index.js"
        text = src.read_text()
        tables = {}
        for name in ("ANTHROPIC_PRICING", "OPENAI_PRICING", "GEMINI_PRICING", "GROK_PRICING", "KIMI_PRICING", "DEEPINFRA_PRICING"):
            m = re.search(name + r"\s*=\s*\{(.*?)\n\};", text, re.S)
            assert m, f"could not find {name} in Node SDK"
            entries = re.findall(
                r"'([^']+)':\s*\{\s*input:\s*([\d.]+),\s*output:\s*([\d.]+)\s*\}", m.group(1)
            )
            tables[name] = {k: {"input": float(i), "output": float(o)} for k, i, o in entries}
        return tables

    def test_tables_match(self):
        node = self._load_node_tables()
        py = {
            "ANTHROPIC_PRICING": ANTHROPIC_PRICING,
            "OPENAI_PRICING": OPENAI_PRICING,
            "GEMINI_PRICING": GEMINI_PRICING,
            "GROK_PRICING": GROK_PRICING,
            "KIMI_PRICING": KIMI_PRICING,
            "DEEPINFRA_PRICING": DEEPINFRA_PRICING,
        }
        for name, py_table in py.items():
            assert node[name] == py_table, f"{name} diverged between Node and Python SDKs"
