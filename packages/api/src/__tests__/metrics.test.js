const request = require('supertest');
const { app }  = require('../index');
const { resetDb, createOrg, pool } = require('./helpers');

beforeEach(resetDb);

const VALID_METRIC = {
  provider:     'anthropic',
  model:        'claude-sonnet-4-6',
  input_tokens:  100,
  output_tokens: 50,
  total_tokens:  150,
  cost_usd:      0.00045,
  latency_ms:    320,
  status_code:   200,
};

describe('POST /api/metrics', () => {
  it('inserts metric and returns 201 with correct org_id', async () => {
    const { orgId, obsToken } = await createOrg('Metrics Org');
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send(VALID_METRIC);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.org_id).toBe(orgId);
    expect(res.body.data.model).toBe('claude-sonnet-4-6');
  });

  it('returns 401 without any token', async () => {
    const res = await request(app).post('/api/metrics').send(VALID_METRIC);
    expect(res.status).toBe(401);
  });

  it('returns 401 for a revoked observatory token', async () => {
    const { obsToken } = await createOrg('Revoked Org');
    // Revoke the token
    await pool.query(`UPDATE observatory_tokens SET revoked_at = NOW()`);
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send(VALID_METRIC);
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid body (missing model)', async () => {
    const { obsToken } = await createOrg('Validation Org');
    const { model: _unused, ...noModel } = VALID_METRIC;
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send(noModel);
    expect(res.status).toBe(400);
  });

  it('accepts provider: gemini', async () => {
    const { obsToken } = await createOrg('Gemini Org');
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, provider: 'gemini', model: 'gemini-2.5-flash' });
    expect(res.status).toBe(201);
    expect(res.body.data.provider).toBe('gemini');
  });

  it('accepts provider: grok', async () => {
    const { obsToken } = await createOrg('Grok Org');
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, provider: 'grok', model: 'grok-4.6' });
    expect(res.status).toBe(201);
    expect(res.body.data.provider).toBe('grok');
  });

  it('accepts provider: kimi', async () => {
    const { obsToken } = await createOrg('Kimi Org');
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, provider: 'kimi', model: 'kimi-k3' });
    expect(res.status).toBe(201);
    expect(res.body.data.provider).toBe('kimi');
  });

  it('accepts provider: deepinfra with an org/Model id', async () => {
    const { obsToken } = await createOrg('DeepInfra Org');
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V4-Pro' });
    expect(res.status).toBe(201);
    expect(res.body.data.provider).toBe('deepinfra');
    expect(res.body.data.model).toBe('deepseek-ai/DeepSeek-V4-Pro');
  });

  it('rejects an unsupported provider', async () => {
    const { obsToken } = await createOrg('BadProvider Org');
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, provider: 'mistral' });
    expect(res.status).toBe(400);
  });

  it('updates last_used_at on the observatory token', async () => {
    const { obsToken } = await createOrg('LastUsed Org');
    await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send(VALID_METRIC);

    // Give the async update a tick to run
    await new Promise(r => setTimeout(r, 50));
    const res = await pool.query(`SELECT last_used_at FROM observatory_tokens LIMIT 1`);
    expect(res.rows[0].last_used_at).not.toBeNull();
  });

  it('defaults cost_confidence to known on a successful call', async () => {
    const { obsToken } = await createOrg('CostConfidence Org 1');
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send(VALID_METRIC);
    expect(res.body.data.cost_confidence).toBe('known');
  });

  it('overrides cost_confidence to unknown for a $0 error when the client did not assert it', async () => {
    const { obsToken } = await createOrg('CostConfidence Org 2');
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, cost_usd: 0, status_code: 504, error_type: 'timeout' });
    expect(res.body.data.cost_confidence).toBe('unknown');
  });

  it('respects an explicit cost_confidence:known even for a $0 error', async () => {
    const { obsToken } = await createOrg('CostConfidence Org 3');
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, cost_usd: 0, status_code: 400, error_type: 'invalid_request', cost_confidence: 'known' });
    expect(res.body.data.cost_confidence).toBe('known');
  });

  it('zeroes a positive cost_usd on a 5xx error and marks it unverified', async () => {
    const { obsToken } = await createOrg('CostConfidence Org 4');
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, cost_usd: 0.002, status_code: 500, error_type: 'server_error' });
    expect(Number(res.body.data.cost_usd)).toBe(0);
    expect(res.body.data.cost_confidence).toBe('unknown');
  });

  it('zeroes a positive cost_usd on a 4xx rejection (e.g. Whisper 413)', async () => {
    const { obsToken } = await createOrg('CostConfidence Org 5');
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, provider: 'openai', model: 'whisper-1', cost_usd: 1.02, status_code: 413 });
    expect(Number(res.body.data.cost_usd)).toBe(0);
    expect(res.body.data.cost_confidence).toBe('unknown');
  });

  it('zeroes the cost but respects an explicit cost_confidence:known on a failed call', async () => {
    const { obsToken } = await createOrg('CostConfidence Org 5b');
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, cost_usd: 1.02, status_code: 400, cost_confidence: 'known' });
    expect(Number(res.body.data.cost_usd)).toBe(0);
    expect(res.body.data.cost_confidence).toBe('known');
  });

  it('zeroes a positive cost_usd on a 429 (no retryable exception)', async () => {
    const { obsToken } = await createOrg('CostConfidence Org 6');
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, cost_usd: 0.5, status_code: 429, error_type: 'rate_limit' });
    expect(Number(res.body.data.cost_usd)).toBe(0);
  });

  it('leaves a positive cost_usd untouched on a successful call', async () => {
    const { obsToken } = await createOrg('CostConfidence Org 7');
    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, cost_usd: 0.002, status_code: 200 });
    expect(Number(res.body.data.cost_usd)).toBeCloseTo(0.002, 6);
  });
});

describe('POST /api/metrics — likely-retry detection', () => {
  it('flags a second call with the same model+prompt_preview within the window', async () => {
    const { obsToken } = await createOrg('Retry Org 1');
    const first = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, prompt_preview: 'transcribe this audio' });
    expect(first.body.data.likely_retry_of).toBeNull();

    const second = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, prompt_preview: 'transcribe this audio' });
    expect(second.body.data.likely_retry_of).toBe(first.body.data.id);
  });

  it('does not flag calls with different prompt_preview', async () => {
    const { obsToken } = await createOrg('Retry Org 2');
    await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, prompt_preview: 'prompt A' });

    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, prompt_preview: 'prompt B' });
    expect(res.body.data.likely_retry_of).toBeNull();
  });

  it('does not treat sync-imported rows as retries of each other', async () => {
    const { obsToken } = await createOrg('Retry Org 3');
    await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, prompt_preview: 'sync:anthropic' });

    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, prompt_preview: 'sync:anthropic' });
    expect(res.body.data.likely_retry_of).toBeNull();
  });

  it('does not cross-match across different orgs', async () => {
    const orgA = await createOrg('Retry Org A');
    const orgB = await createOrg('Retry Org B');
    await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${orgA.obsToken}`)
      .send({ ...VALID_METRIC, prompt_preview: 'shared prompt text' });

    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${orgB.obsToken}`)
      .send({ ...VALID_METRIC, prompt_preview: 'shared prompt text' });
    expect(res.body.data.likely_retry_of).toBeNull();
  });
});

describe('GET /api/metrics — org scoping', () => {
  it('org A cannot see metrics inserted by org B', async () => {
    const orgA = await createOrg('Org A');
    const orgB = await createOrg('Org B');

    // Org B inserts a metric
    await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${orgB.obsToken}`)
      .send(VALID_METRIC);

    // Org A lists metrics — should see none
    const res = await request(app)
      .get('/api/metrics')
      .set('Authorization', `Bearer ${orgA.jwt}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('org can see its own metrics', async () => {
    const { obsToken, jwt: token } = await createOrg('Own Metrics Org');
    await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send(VALID_METRIC);

    const res = await request(app)
      .get('/api/metrics')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /api/metrics/summary — org scoping', () => {
  it('summary only aggregates data for the requesting org', async () => {
    const orgA = await createOrg('Summary A');
    const orgB = await createOrg('Summary B');

    // Org B inserts a metric with known cost
    await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${orgB.obsToken}`)
      .send({ ...VALID_METRIC, cost_usd: 9.99 });

    // Org A summary should show zero cost
    const res = await request(app)
      .get('/api/metrics/summary')
      .set('Authorization', `Bearer ${orgA.jwt}`);
    expect(res.status).toBe(200);
    expect(parseFloat(res.body.summary.total_cost_usd)).toBe(0);
  });

  it('time_series is zero-filled for gemini/grok/kimi/deepinfra too, not just anthropic/openai', async () => {
    const { obsToken, jwt } = await createOrg('Gemini TimeSeries Org');
    await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, provider: 'gemini', model: 'gemini-2.5-flash' });

    const res = await request(app)
      .get('/api/metrics/summary?range=24h')
      .set('Authorization', `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    const providers = new Set(res.body.time_series.map(r => r.provider));
    expect(providers.has('gemini')).toBe(true);
    expect(providers.has('anthropic')).toBe(true);
    expect(providers.has('openai')).toBe(true);
    expect(providers.has('grok')).toBe(true);
    expect(providers.has('kimi')).toBe(true);
    expect(providers.has('deepinfra')).toBe(true);
  });

  it('model_time_series is zero-filled across buckets and carries all 5 metrics', async () => {
    const { obsToken, jwt } = await createOrg('ModelTimeSeries Org');
    await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, model: 'claude-sonnet-4-6', cost_usd: 1.5, latency_ms: 400 });

    const res = await request(app)
      .get('/api/metrics/summary?range=24h')
      .set('Authorization', `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.model_time_series)).toBe(true);

    // At least 2 hourly buckets total (zero-filled), not collapsed to a single row.
    expect(res.body.model_time_series.length).toBeGreaterThan(1);

    const row = res.body.model_time_series.find(r => r.model === 'claude-sonnet-4-6' && parseInt(r.requests) > 0);
    expect(row).toBeDefined();
    expect(parseFloat(row.total_tokens)).toBe(150);
    expect(parseFloat(row.cost_usd)).toBeCloseTo(1.5);
    expect(parseInt(row.requests)).toBe(1);
    expect(parseFloat(row.avg_latency_ms)).toBe(400);
    expect(parseInt(row.error_count)).toBe(0);

    // A bucket with no activity for this model still yields a zero-filled row.
    const zeroRow = res.body.model_time_series.find(r => r.model === 'claude-sonnet-4-6' && parseInt(r.requests) === 0);
    expect(zeroRow).toBeDefined();
    expect(parseFloat(zeroRow.total_tokens)).toBe(0);
  });

  it('model_time_series collapses models beyond the top 5 into "Other"', async () => {
    const { obsToken, jwt } = await createOrg('ManyModels Org');
    const models = ['model-a', 'model-b', 'model-c', 'model-d', 'model-e', 'model-f', 'model-g'];
    // Give earlier models more requests so they rank in the top 5 deterministically.
    for (let i = 0; i < models.length; i++) {
      const requestCount = models.length - i; // model-a:7 ... model-g:1
      for (let j = 0; j < requestCount; j++) {
        await request(app)
          .post('/api/metrics')
          .set('Authorization', `Bearer ${obsToken}`)
          .send({ ...VALID_METRIC, model: models[i] });
      }
    }

    const res = await request(app)
      .get('/api/metrics/summary?range=24h')
      .set('Authorization', `Bearer ${jwt}`);
    expect(res.status).toBe(200);

    const distinctModels = new Set(res.body.model_time_series.map(r => r.model));
    // Top 5 (model-a..model-e) + 'Other' for model-f/model-g = 6 distinct series.
    expect(distinctModels.size).toBe(6);
    expect(distinctModels.has('model-a')).toBe(true);
    expect(distinctModels.has('model-e')).toBe(true);
    expect(distinctModels.has('model-f')).toBe(false);
    expect(distinctModels.has('Other')).toBe(true);

    const otherTotalRequests = res.body.model_time_series
      .filter(r => r.model === 'Other')
      .reduce((sum, r) => sum + parseInt(r.requests), 0);
    expect(otherTotalRequests).toBe(3); // model-f (2) + model-g (1)
  });
});

describe('GET /api/metrics/export — CSV is RFC-4180 safe', () => {
  it('quotes fields containing newlines so one record stays on one row', async () => {
    const { obsToken, jwt } = await createOrg('CSV Export Org');
    await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${obsToken}`)
      .send({ ...VALID_METRIC, prompt_preview: 'line one\nline two, with comma' });

    const res = await request(app)
      .get('/api/metrics/export?range=24h')
      .set('Authorization', `Bearer ${jwt}`);
    expect(res.status).toBe(200);

    // The multi-line preview must be wrapped in quotes.
    expect(res.text).toContain('"line one\nline two, with comma"');

    // Count records by splitting only on newlines that are OUTSIDE quotes.
    const rows = [];
    let field = '', inQuotes = false, row = 1;
    for (const ch of res.text) {
      if (ch === '"') inQuotes = !inQuotes;
      if (ch === '\n' && !inQuotes) { row++; field = ''; continue; }
      field += ch;
    }
    // header + exactly one data record + trailing newline => row === 3
    expect(row).toBe(3);
  });
});

describe('POST /api/metrics — mislabeled provider/model warning (bug 6)', () => {
  it('warns but still records a row when model does not belong to the provider', async () => {
    const { obsToken } = await createOrg('Mislabel Org');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await request(app)
        .post('/api/metrics')
        .set('Authorization', `Bearer ${obsToken}`)
        .send({ ...VALID_METRIC, provider: 'anthropic', model: 'gpt-4o' });
      expect(res.status).toBe(201);
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('Unrecognized model "gpt-4o"'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn for a recognized model', async () => {
    const { obsToken } = await createOrg('Wellabeled Org');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await request(app)
        .post('/api/metrics')
        .set('Authorization', `Bearer ${obsToken}`)
        .send({ ...VALID_METRIC, provider: 'anthropic', model: 'claude-sonnet-4-6' });
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('Unrecognized model'))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
