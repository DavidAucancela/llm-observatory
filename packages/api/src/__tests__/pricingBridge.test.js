const {
  costForProviderUsage, isKnownModel, canonicalModelId, CACHE_CREATION_INPUT_MULTIPLIER,
} = require('../services/pricingBridge');

const M = 1_000_000;

describe('pricingBridge.costForProviderUsage', () => {
  it('prices a DeepInfra org/Model id from the SDK table', () => {
    // Llama-3.3-70B-Instruct-Turbo is $0.10 in / $0.32 out per 1M
    expect(costForProviderUsage('deepinfra', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', { uncachedInput: M, output: M }))
      .toBeCloseTo(0.42, 6);
  });

  it('recognizes a priced DeepInfra model and flags an unpriced one', () => {
    expect(isKnownModel('deepinfra', 'deepseek-ai/DeepSeek-V4-Pro')).toBe(true);
    expect(isKnownModel('deepinfra', 'some-org/Brand-New-Model')).toBe(false);
  });

  it('prices a dated OpenAI snapshot model id (bug 2 — was $0)', () => {
    // gpt-4o-mini is $0.15 / 1M input
    expect(costForProviderUsage('openai', 'gpt-4o-mini-2024-07-18', { uncachedInput: M }))
      .toBeCloseTo(0.15, 6);
  });

  it('prices claude-fable-5 (bug 3a — was missing from the API table)', () => {
    // fable-5 is $10 in / $50 out per 1M
    expect(costForProviderUsage('anthropic', 'claude-fable-5', { uncachedInput: M, output: M }))
      .toBeCloseTo(60, 6);
  });

  it('applies the 1.25x surcharge to cache-creation input (bug 3b math)', () => {
    // sonnet-4-6 input rate $3.0/1M; 1M cache-write -> 1.25M effective input
    expect(costForProviderUsage('anthropic', 'claude-sonnet-4-6', { cacheCreationInput: M }))
      .toBeCloseTo(3.0 * CACHE_CREATION_INPUT_MULTIPLIER, 6);
  });

  it('bills cache reads at the plain input rate (no surcharge)', () => {
    expect(costForProviderUsage('anthropic', 'claude-sonnet-4-6', { uncachedInput: M, cacheReadInput: M }))
      .toBeCloseTo(6.0, 6);
  });

  it('returns 0 for an unknown provider', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(costForProviderUsage('nonsense', 'x', { uncachedInput: M })).toBe(0);
    warn.mockRestore();
  });

  it('returns 0 (with a warn) for an unknown model of a known provider', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(costForProviderUsage('openai', 'totally-made-up-model', { uncachedInput: M })).toBe(0);
    warn.mockRestore();
  });
});

describe('pricingBridge.isKnownModel', () => {
  it('recognizes a dated OpenAI snapshot id via normalization (bug 6)', () => {
    expect(isKnownModel('openai', 'gpt-4o-mini-2024-07-18')).toBe(true);
  });

  it('rejects a model that belongs to a different provider', () => {
    expect(isKnownModel('anthropic', 'gpt-4o')).toBe(false);
  });

  it('accepts a well-formed model for its provider', () => {
    expect(isKnownModel('anthropic', 'claude-sonnet-4-6')).toBe(true);
  });

  it('rejects an unknown provider outright', () => {
    expect(isKnownModel('nope', 'claude-sonnet-4-6')).toBe(false);
  });
});

describe('pricingBridge.canonicalModelId', () => {
  it('strips a snapshot suffix when the base id is priced', () => {
    expect(canonicalModelId('openai', 'gpt-4o-2024-08-06')).toBe('gpt-4o');
  });

  it('leaves an unrecognized id untouched', () => {
    expect(canonicalModelId('openai', 'some-future-model')).toBe('some-future-model');
  });
});
