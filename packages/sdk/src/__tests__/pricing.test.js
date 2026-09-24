const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  calculateCost, calculateOpenAICost, calculateGeminiCost, calculateGrokCost, calculateKimiCost, calculateDeepInfraCost,
  normalizeModelId, finalizeMetricPricing,
  ANTHROPIC_PRICING, OPENAI_PRICING, GEMINI_PRICING, GROK_PRICING, KIMI_PRICING, DEEPINFRA_PRICING,
} = require('../index.js');

describe('calculateCost (Anthropic)', () => {
  it('calculates cost for claude-sonnet correctly', () => {
    const cost = calculateCost('claude-sonnet-4-6', 1_000_000, 1_000_000);
    assert.strictEqual(cost, 18.0); // 3.0 + 15.0
  });

  it('calculates cost for claude-opus correctly', () => {
    const cost = calculateCost('claude-opus-4-6', 1_000_000, 1_000_000);
    assert.strictEqual(cost, 30.0); // 5.0 + 25.0
  });

  it('returns zero for unknown models', () => {
    const cost = calculateCost('unknown-model', 1_000_000, 0);
    assert.strictEqual(cost, 0);
  });

  it('calculates zero cost for zero tokens', () => {
    const cost = calculateCost('claude-sonnet-4-6', 0, 0);
    assert.strictEqual(cost, 0);
  });

  it('all known Anthropic models have valid pricing', () => {
    for (const [model, pricing] of Object.entries(ANTHROPIC_PRICING)) {
      assert.ok(pricing.input >= 0, `${model} input price should be >= 0`);
      assert.ok(pricing.output >= 0, `${model} output price should be >= 0`);
    }
  });
});

describe('calculateOpenAICost', () => {
  it('calculates cost for gpt-4o correctly', () => {
    const cost = calculateOpenAICost('gpt-4o', 1_000_000, 1_000_000);
    assert.strictEqual(cost, 12.5); // 2.50 + 10.00
  });

  it('returns zero for unknown models', () => {
    const cost = calculateOpenAICost('unknown-model', 1_000_000, 0);
    assert.strictEqual(cost, 0);
  });

  it('all known OpenAI models have valid pricing', () => {
    for (const [model, pricing] of Object.entries(OPENAI_PRICING)) {
      assert.ok(pricing.input >= 0, `${model} input price should be >= 0`);
      assert.ok(pricing.output >= 0, `${model} output price should be >= 0`);
    }
  });
});

describe('calculateGrokCost', () => {
  it('calculates cost for grok-4.6 correctly', () => {
    const cost = calculateGrokCost('grok-4.6', 1_000_000, 1_000_000);
    assert.strictEqual(cost, 8.0); // 2.00 + 6.00
  });

  it('returns zero for unknown models', () => {
    const cost = calculateGrokCost('unknown-model', 1_000_000, 0);
    assert.strictEqual(cost, 0);
  });

  it('all known Grok models have valid pricing', () => {
    for (const [model, pricing] of Object.entries(GROK_PRICING)) {
      assert.ok(pricing.input >= 0, `${model} input price should be >= 0`);
      assert.ok(pricing.output >= 0, `${model} output price should be >= 0`);
    }
  });
});

describe('calculateKimiCost', () => {
  it('calculates cost for kimi-k3 correctly', () => {
    const cost = calculateKimiCost('kimi-k3', 1_000_000, 1_000_000);
    assert.strictEqual(cost, 18.0); // 3.00 + 15.00
  });

  it('returns zero for unknown models', () => {
    const cost = calculateKimiCost('unknown-model', 1_000_000, 0);
    assert.strictEqual(cost, 0);
  });

  it('all known Kimi models have valid pricing', () => {
    for (const [model, pricing] of Object.entries(KIMI_PRICING)) {
      assert.ok(pricing.input >= 0, `${model} input price should be >= 0`);
      assert.ok(pricing.output >= 0, `${model} output price should be >= 0`);
    }
  });
});

describe('calculateDeepInfraCost', () => {
  it('calculates cost for a priced model correctly', () => {
    const cost = calculateDeepInfraCost('meta-llama/Llama-3.3-70B-Instruct-Turbo', 1_000_000, 1_000_000);
    assert.ok(Math.abs(cost - 0.42) < 1e-9); // 0.10 + 0.32
  });

  it('returns zero for unknown models', () => {
    const cost = calculateDeepInfraCost('some-org/unknown-model', 1_000_000, 0);
    assert.strictEqual(cost, 0);
  });

  it('all known DeepInfra models have valid pricing and an org/Model id', () => {
    for (const [model, pricing] of Object.entries(DEEPINFRA_PRICING)) {
      assert.match(model, /^[^/\s]+\/[^/\s]+$/, `${model} should be an org/Model id`);
      assert.ok(pricing.input >= 0, `${model} input price should be >= 0`);
      assert.ok(pricing.output >= 0, `${model} output price should be >= 0`);
    }
  });

  it('finalizeMetricPricing flags an unpriced deepinfra model as unknown', () => {
    const data = { provider: 'deepinfra', model: 'some-org/unknown-model', input_tokens: 10, output_tokens: 5, cost_usd: 0 };
    finalizeMetricPricing(data);
    assert.strictEqual(data.cost_confidence, 'unknown');
  });
});

describe('normalizeModelId', () => {
  it('strips a models/ prefix when the bare id is priced', () => {
    assert.strictEqual(normalizeModelId('models/gemini-2.5-flash', GEMINI_PRICING), 'gemini-2.5-flash');
  });

  it('strips a -YYYYMMDD snapshot suffix when the base id is priced', () => {
    assert.strictEqual(normalizeModelId('claude-sonnet-5-20250930', ANTHROPIC_PRICING), 'claude-sonnet-5');
    assert.strictEqual(normalizeModelId('gpt-4o-2024-11-20', OPENAI_PRICING), 'gpt-4o');
  });

  it('leaves an unknown id untouched (degrade safely)', () => {
    assert.strictEqual(normalizeModelId('brand-new-model-20990101', OPENAI_PRICING), 'brand-new-model-20990101');
  });

  it('does not strip a suffix that is part of a real priced id', () => {
    assert.strictEqual(normalizeModelId('grok-4.20-0309-reasoning', GROK_PRICING), 'grok-4.20-0309-reasoning');
  });
});

describe('calculate*Cost with non-canonical model ids', () => {
  it('prices a dated Anthropic snapshot via the base rate', () => {
    assert.strictEqual(calculateCost('claude-sonnet-5-20250930', 1_000_000, 1_000_000), 18.0);
  });

  it('prices a models/-prefixed Gemini id', () => {
    assert.strictEqual(
      calculateGeminiCost('models/gemini-2.5-flash', 1_000_000, 1_000_000),
      GEMINI_PRICING['gemini-2.5-flash'].input + GEMINI_PRICING['gemini-2.5-flash'].output
    );
  });
});

describe('finalizeMetricPricing', () => {
  it('flags cost_confidence unknown when a token-using call priced at $0', () => {
    const data = { provider: 'openai', model: 'gpt-9-future', input_tokens: 100, output_tokens: 50, cost_usd: 0 };
    finalizeMetricPricing(data);
    assert.strictEqual(data.cost_confidence, 'unknown');
  });

  it('leaves cost_confidence unset for a priced model', () => {
    const data = { provider: 'openai', model: 'gpt-4o', input_tokens: 100, output_tokens: 50, cost_usd: 1.23 };
    finalizeMetricPricing(data);
    assert.strictEqual(data.cost_confidence, undefined);
  });

  it('canonicalizes data.model in place', () => {
    const data = { provider: 'anthropic', model: 'claude-sonnet-5-20250930', total_tokens: 10, cost_usd: 1 };
    finalizeMetricPricing(data);
    assert.strictEqual(data.model, 'claude-sonnet-5');
  });

  it('does not override an explicit cost_confidence', () => {
    const data = { provider: 'openai', model: 'gpt-9-future', input_tokens: 100, cost_usd: 0, cost_confidence: 'known' };
    finalizeMetricPricing(data);
    assert.strictEqual(data.cost_confidence, 'known');
  });

  it('does not flag a genuine zero-token call', () => {
    const data = { provider: 'openai', model: 'gpt-9-future', input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 };
    finalizeMetricPricing(data);
    assert.strictEqual(data.cost_confidence, undefined);
  });
});
