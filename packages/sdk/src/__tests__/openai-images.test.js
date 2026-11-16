const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const sinon  = require('sinon');

const { MonitoredOpenAI, calculateOpenAIImageCost } = require('../index.js');

let client, fetchStub;
const lastMetric = () => JSON.parse(fetchStub.lastCall.args[1].body);
const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  fetchStub = sinon.stub(globalThis, 'fetch').resolves({ ok: true, status: 200 });
  client = new MonitoredOpenAI({
    apiKey: 'sk-proj-TESTKEY0000000000000000',
    observatoryUrl: 'http://obs:3001',
    observatoryToken: 'obs_sk_test',
  });
});
afterEach(() => sinon.restore());

describe('calculateOpenAIImageCost', () => {
  it('prices text input, image input and output separately', () => {
    const cost = calculateOpenAIImageCost('gpt-image-1', {
      input_tokens: 150, output_tokens: 4000,
      input_tokens_details: { text_tokens: 50, image_tokens: 100 },
    });
    assert.ok(Math.abs(cost - (50 * 5 + 100 * 10 + 4000 * 40) / 1e6) < 1e-12);
  });
  it('returns null for an unpriced model or missing usage', () => {
    assert.strictEqual(calculateOpenAIImageCost('gpt-image-2', { input_tokens: 10, output_tokens: 10 }), null);
    assert.strictEqual(calculateOpenAIImageCost('gpt-image-1', undefined), null);
  });
});

describe('MonitoredOpenAI — images', () => {
  it('records images.generate with token cost', async () => {
    const resp = { data: [{ b64_json: 'x' }], usage: { input_tokens: 20, output_tokens: 1000, input_tokens_details: { text_tokens: 20, image_tokens: 0 } } };
    sinon.stub(client.client.images, 'generate').resolves(resp);
    const out = await client.images.generate({ model: 'gpt-image-1', prompt: 'a cat' });
    await flush();
    assert.strictEqual(out, resp);
    const m = lastMetric();
    assert.deepStrictEqual(m.tools_used, ['images.generate']);
    assert.strictEqual(m.model, 'gpt-image-1');
    assert.strictEqual(m.api_key_hint, 'sk-proj-…0000');
    assert.ok(m.cost_usd > 0);
    assert.strictEqual(m.cost_confidence, undefined);
    assert.match(m.prompt_preview, /a cat/);
  });

  it('flags an unpriced image model as cost unknown, not $0 known', async () => {
    sinon.stub(client.client.images, 'generate').resolves({ data: [{}, {}], usage: { input_tokens: 5, output_tokens: 50 } });
    await client.images.generate({ model: 'gpt-image-2', prompt: 'p', n: 2 });
    await flush();
    const m = lastMetric();
    assert.strictEqual(m.cost_usd, 0);
    assert.strictEqual(m.cost_confidence, 'unknown');
    assert.match(m.prompt_preview, /×2/);
  });

  it('flags dall-e (no usage) as cost unknown', async () => {
    sinon.stub(client.client.images, 'generate').resolves({ data: [{}] });
    await client.images.generate({ prompt: 'p' });
    await flush();
    assert.strictEqual(lastMetric().model, 'dall-e-2');
    assert.strictEqual(lastMetric().cost_confidence, 'unknown');
  });

  it('records images.edit and rethrows errors with the status', async () => {
    const err = Object.assign(new Error('bad'), { status: 400 });
    sinon.stub(client.client.images, 'edit').rejects(err);
    await assert.rejects(client.images.edit({ model: 'gpt-image-1', prompt: 'p' }), /bad/);
    await flush();
    const m = lastMetric();
    assert.strictEqual(m.status_code, 400);
    assert.deepStrictEqual(m.tools_used, ['images.edit']);
    assert.strictEqual(m.cost_usd, 0);
  });

  it('records a streamed generation once, with usage from the completed event', async () => {
    async function* events() {
      yield { type: 'image_generation.partial_image' };
      yield { type: 'image_generation.completed', usage: { input_tokens: 10, output_tokens: 100, input_tokens_details: { text_tokens: 10 } } };
    }
    sinon.stub(client.client.images, 'generate').resolves(events());
    const stream = await client.images.generate({ model: 'gpt-image-1', prompt: 'p', stream: true });
    const seen = [];
    for await (const e of stream) seen.push(e.type);
    await flush();
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(fetchStub.callCount, 1);
    assert.strictEqual(lastMetric().output_tokens, 100);
  });
});

describe('MonitoredOpenAI — responses tools', () => {
  it('records declared tools and marks image tool calls as cost unknown', async () => {
    sinon.stub(client.client.responses, 'create').resolves({
      usage: { input_tokens: 100, output_tokens: 20 },
      output: [{ type: 'image_generation_call' }, { type: 'message' }],
    });
    await client.responses.create({ model: 'gpt-5.5', input: 'draw', tools: [{ type: 'image_generation' }, { type: 'function', name: 'lookup' }] });
    await flush();
    const m = lastMetric();
    assert.deepStrictEqual(m.tools_used, ['image_generation', 'lookup']);
    assert.strictEqual(m.cost_confidence, 'unknown');
    assert.match(m.prompt_preview, /^\[1 image\(s\)\]/);
  });

  it('keeps cost known when no image was generated', async () => {
    sinon.stub(client.client.responses, 'create').resolves({ usage: { input_tokens: 100, output_tokens: 20 }, output: [{ type: 'message' }] });
    await client.responses.create({ model: 'gpt-5.5', input: 'hi', tools: [{ type: 'image_generation' }] });
    await flush();
    assert.strictEqual(lastMetric().cost_confidence, undefined);
    assert.ok(lastMetric().cost_usd > 0);
  });

  it('streamed responses read image calls from response.completed', async () => {
    async function* events() {
      yield { type: 'response.output_text.delta' };
      yield { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 }, output: [{ type: 'image_generation_call' }] } };
    }
    sinon.stub(client.client.responses, 'create').resolves(events());
    const stream = await client.responses.create({ model: 'gpt-5.5', input: 'x', stream: true, tools: [{ type: 'image_generation' }] });
    for await (const _ of stream) { /* drain */ }
    await flush();
    assert.strictEqual(lastMetric().input_tokens, 10);
    assert.strictEqual(lastMetric().cost_confidence, 'unknown');
  });
});
