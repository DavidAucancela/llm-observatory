const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const sinon  = require('sinon');

const { MonitoredDeepInfra } = require('../index.js');

// DeepInfra is OpenAI-shaped: cached prompt tokens are nested under
// `prompt_tokens_details`, and the billed cost may ride along in `usage`.
function makeResponse({ prompt = 100, completion = 50, cached = 0, cost } = {}) {
  const usage = {
    prompt_tokens: prompt, completion_tokens: completion,
    prompt_tokens_details: { cached_tokens: cached },
  };
  if (cost !== undefined) usage.estimated_cost = cost;
  return { usage };
}

const close = (actual, expected) => Math.abs(actual - expected) < 1e-9;

let client;
let completionsStub;
let fetchStub;

beforeEach(() => {
  sinon.stub(console, 'warn'); // silence "Unknown model pricing" warnings
  fetchStub = sinon.stub(globalThis, 'fetch').resolves({ ok: true, status: 200 });
  client = new MonitoredDeepInfra({
    apiKey: 'di-TESTKEY0000000000000000',
    observatoryUrl: 'http://obs:3001',
    observatoryToken: 'obs_sk_test',
  });
  completionsStub = sinon.stub(client.client.chat.completions, 'create');
});

afterEach(() => sinon.restore());

async function sentMetric() {
  await new Promise(r => setImmediate(r));
  assert.strictEqual(fetchStub.callCount, 1);
  return JSON.parse(fetchStub.firstCall.args[1].body);
}

describe('MonitoredDeepInfra — client setup', () => {
  it('points the underlying OpenAI client at api.deepinfra.com', () => {
    assert.strictEqual(client.client.baseURL, 'https://api.deepinfra.com/v1/openai');
  });

  it('falls back to DEEPINFRA_API_KEY then DEEPINFRA_TOKEN from the environment', () => {
    const prevKey = process.env.DEEPINFRA_API_KEY;
    const prevTok = process.env.DEEPINFRA_TOKEN;
    try {
      delete process.env.DEEPINFRA_API_KEY;
      process.env.DEEPINFRA_TOKEN = 'di-FROMTOKENENV00000000';
      assert.strictEqual(new MonitoredDeepInfra({}).client.apiKey, 'di-FROMTOKENENV00000000');
      process.env.DEEPINFRA_API_KEY = 'di-FROMKEYENV0000000000';
      assert.strictEqual(new MonitoredDeepInfra({}).client.apiKey, 'di-FROMKEYENV0000000000');
    } finally {
      if (prevKey === undefined) delete process.env.DEEPINFRA_API_KEY; else process.env.DEEPINFRA_API_KEY = prevKey;
      if (prevTok === undefined) delete process.env.DEEPINFRA_TOKEN;   else process.env.DEEPINFRA_TOKEN   = prevTok;
    }
  });
});

// ── Non-streaming ─────────────────────────────────────────────────────────────
describe('MonitoredDeepInfra — non-streaming', () => {
  it('returns response from underlying client unchanged', async () => {
    const resp = makeResponse();
    completionsStub.resolves(resp);
    const result = await client.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    assert.strictEqual(result, resp);
  });

  it('sends metric with correct tokens, provider deepinfra, and status 200', async () => {
    completionsStub.resolves(makeResponse({ prompt: 100, completion: 50 }));
    await client.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const metric = await sentMetric();
    assert.strictEqual(metric.input_tokens,  100);
    assert.strictEqual(metric.output_tokens, 50);
    assert.strictEqual(metric.total_tokens,  150);
    assert.strictEqual(metric.status_code,   200);
    assert.strictEqual(metric.provider,      'deepinfra');
    assert.strictEqual(metric.model,         'deepseek-ai/DeepSeek-V4-Pro');
  });

  it('prices from the table when the response reports no cost: 1M+1M V4-Pro → $3.90', async () => {
    completionsStub.resolves(makeResponse({ prompt: 1_000_000, completion: 1_000_000 }));
    await client.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const metric = await sentMetric();
    assert.ok(close(metric.cost_usd, 3.9), `expected ~3.90, got ${metric.cost_usd}`);
    assert.notStrictEqual(metric.cost_confidence, 'unknown');
  });

  it('prefers the cost reported in usage over the pricing table', async () => {
    completionsStub.resolves(makeResponse({ prompt: 1_000_000, completion: 1_000_000, cost: 0.1234 }));
    await client.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const metric = await sentMetric();
    assert.strictEqual(metric.cost_usd, 0.1234);
  });

  it('ignores a malformed reported cost and falls back to the table', async () => {
    const resp = makeResponse({ prompt: 1_000_000, completion: 0 });
    resp.usage.estimated_cost = 'free';
    completionsStub.resolves(resp);
    await client.chat.completions.create({
      model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const metric = await sentMetric();
    assert.ok(close(metric.cost_usd, 0.02), `expected ~0.02, got ${metric.cost_usd}`);
  });

  it('flags an unpriced model as cost_confidence unknown instead of a silent $0', async () => {
    completionsStub.resolves(makeResponse({ prompt: 100, completion: 50 }));
    await client.chat.completions.create({
      model: 'some-org/Brand-New-Model',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const metric = await sentMetric();
    assert.strictEqual(metric.cost_usd, 0);
    assert.strictEqual(metric.cost_confidence, 'unknown');
  });

  it('still uses a reported cost for a model missing from the table', async () => {
    completionsStub.resolves(makeResponse({ prompt: 100, completion: 50, cost: 0.002 }));
    await client.chat.completions.create({
      model: 'some-org/Brand-New-Model',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const metric = await sentMetric();
    assert.strictEqual(metric.cost_usd, 0.002);
    assert.notStrictEqual(metric.cost_confidence, 'unknown');
  });

  it('captures cache_read_tokens from usage.prompt_tokens_details.cached_tokens', async () => {
    completionsStub.resolves(makeResponse({ prompt: 100, completion: 50, cached: 30 }));
    await client.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const metric = await sentMetric();
    assert.strictEqual(metric.cache_read_tokens, 30);
  });

  it('sends metric on error with status and zero cost', async () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    completionsStub.rejects(err);

    await assert.rejects(
      () => client.chat.completions.create({
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
      { message: 'rate limited' }
    );

    const metric = await sentMetric();
    assert.strictEqual(metric.status_code, 429);
    assert.strictEqual(metric.cost_usd,    0);
  });

  it('forwards tags to metric payload', async () => {
    const taggedClient = new MonitoredDeepInfra({
      apiKey: 'di-TESTKEY0000000000000000',
      observatoryUrl: 'http://obs:3001',
      tags: { env: 'staging', team: 'ml' },
    });
    sinon.stub(taggedClient.client.chat.completions, 'create').resolves(makeResponse());

    await taggedClient.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const metric = await sentMetric();
    assert.deepStrictEqual(metric.tags, { env: 'staging', team: 'ml' });
  });
});

// ── Streaming ─────────────────────────────────────────────────────────────────
describe('MonitoredDeepInfra — streaming', () => {
  it('yields all chunks from the underlying stream', async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'Hello' } }], usage: null };
      yield { choices: [{ delta: { content: ' world' } }], usage: null };
    }
    completionsStub.resolves(fakeStream());

    const stream = await client.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    const chunks = [];
    for await (const chunk of stream) { chunks.push(chunk); }
    assert.strictEqual(chunks.length, 2);
  });

  it('captures usage and table cost from the final chunk', async () => {
    async function* fakeStream() {
      yield { usage: null, choices: [] };
      yield {
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 15 } },
        choices: [],
      };
    }
    completionsStub.resolves(fakeStream());

    const stream = await client.chat.completions.create({
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    for await (const _ of stream) { /* consume */ }

    const metric = await sentMetric();
    assert.strictEqual(metric.input_tokens,      1_000_000);
    assert.strictEqual(metric.cache_read_tokens, 15);
    assert.strictEqual(metric.provider,          'deepinfra');
    assert.ok(close(metric.cost_usd, 0.10), `expected ~0.10, got ${metric.cost_usd}`);
  });

  it('uses the cost reported in the final stream chunk over the table', async () => {
    async function* fakeStream() {
      yield { usage: { prompt_tokens: 120, completion_tokens: 60, estimated_cost: 0.0042 }, choices: [] };
    }
    completionsStub.resolves(fakeStream());

    const stream = await client.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    for await (const _ of stream) { /* consume */ }

    const metric = await sentMetric();
    assert.strictEqual(metric.cost_usd, 0.0042);
  });
});
