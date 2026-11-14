// Provider fetchers for the key audit (services/keyUsage.js), against a mocked
// fetch. Shapes follow OpenAI's openapi spec and Anthropic's Admin API docs.
const {
  hintTail, listOpenAIKeys, fetchOpenAIKeyUsage, disableOpenAIKey,
  listAnthropicKeys, fetchAnthropicKeyUsage, disableAnthropicKey,
} = require('../services/keyUsage');
const { classifyProviderError } = require('../services/syncRunner');

afterEach(() => jest.restoreAllMocks());

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
});

// Routes each request (by pathname + page cursor) to a canned response.
function mockFetch(routes) {
  const calls = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body, headers: init.headers });
    const cursor = u.searchParams.get('page') || u.searchParams.get('after') || u.searchParams.get('after_id') || '';
    const handler = routes[`${u.pathname}${cursor ? `#${cursor}` : ''}`] ?? routes[u.pathname];
    if (handler === undefined) return json({ data: [] });
    return typeof handler === 'function' ? handler(u, init) : handler;
  });
  return calls;
}

const T = 1762174800; // 2025-11-03T13:00:00Z
const cred = { apiKey: 'sk-admin-test' };

describe('hintTail', () => {
  it('takes the last 4 key characters of any redacted form', () => {
    expect(hintTail('sk-...0aIA')).toBe('0aIA');
    expect(hintTail('sk-ant-api03-R2D...igAA')).toBe('igAA');
    expect(hintTail('sk-proj-…Xy_9')).toBe('Xy_9');
    expect(hintTail('sk-abc...def')).toBe(null);
    expect(hintTail(null)).toBe(null);
  });
});

describe('OpenAI', () => {
  it('lists keys across every project, following pagination', async () => {
    const calls = mockFetch({
      '/v1/organization/projects': json({ data: [{ id: 'proj_1', name: 'Default project' }], has_more: true, last_id: 'proj_1' }),
      '/v1/organization/projects#proj_1': json({ data: [{ id: 'proj_2', name: 'Bots' }], has_more: false }),
      '/v1/organization/projects/proj_1/api_keys': json({
        data: [{ id: 'key_a', name: 'code-review-2', redacted_value: 'sk-...0aIA', created_at: T, last_used_at: T + 60 }],
      }),
      '/v1/organization/projects/proj_2/api_keys': json({ data: [{ id: 'key_b', name: 'n8n', redacted_value: 'sk-...kJAA', created_at: T }] }),
    });
    const keys = await listOpenAIKeys(cred);
    expect(keys).toEqual([
      expect.objectContaining({ key_id: 'key_a', name: 'code-review-2', redacted_hint: 'sk-...0aIA', project_id: 'proj_1', project_name: 'Default project' }),
      expect.objectContaining({ key_id: 'key_b', project_name: 'Bots', provider_last_used_at: null }),
    ]);
    expect(keys[0].provider_last_used_at.toISOString()).toBe('2025-11-03T13:01:00.000Z');
    expect(calls[0].headers.Authorization).toBe('Bearer sk-admin-test');
  });

  it('reads all five usage endpoints hourly, grouped by key and model, and normalizes them', async () => {
    const calls = mockFetch({
      '/v1/organization/usage/completions': json({
        data: [{ start_time: T, results: [
          { api_key_id: 'key_a', model: 'gpt-5.5-2026-04-23', num_model_requests: 3, input_tokens: 1000, input_cached_tokens: 200, output_tokens: 100 },
          { api_key_id: null, model: 'gpt-5.5', num_model_requests: 1, input_tokens: 10, output_tokens: 1 },
        ] }],
        has_more: true, next_page: 'p2',
      }),
      '/v1/organization/usage/completions#p2': json({ data: [{ start_time: T + 3600, results: [] }], has_more: false }),
      '/v1/organization/usage/images': json({
        data: [{ start_time: T, results: [{ api_key_id: 'key_a', model: 'gpt-image-2', num_model_requests: 6, images: 6 }] }],
      }),
      '/v1/organization/usage/embeddings': json({
        data: [{ start_time: T, results: [{ api_key_id: 'key_b', model: 'text-embedding-3-small', num_model_requests: 2, input_tokens: 500 }] }],
      }),
    });
    const rows = await fetchOpenAIKeyUsage(cred, new Date(T * 1000), new Date((T + 7200) * 1000));

    const kinds = [...new Set(calls.map(c => c.url.pathname.split('/').pop()))];
    expect(kinds).toEqual(['completions', 'images', 'embeddings', 'audio_speeches', 'audio_transcriptions']);
    for (const c of calls) {
      expect(c.url.searchParams.get('bucket_width')).toBe('1h');
      expect(c.url.searchParams.getAll('group_by[]')).toEqual(['api_key_id', 'model']);
    }

    expect(rows).toHaveLength(3); // the row without an api_key_id is skipped
    const comp = rows.find(r => r.kind === 'completions');
    expect(comp).toMatchObject({ key_id: 'key_a', requests: 3, input_tokens: 1000, cached_tokens: 200, output_tokens: 100, images: 0 });
    expect(comp.hour.toISOString()).toBe('2025-11-03T13:00:00.000Z');
    expect(comp.est_cost_usd).toBeGreaterThan(0); // dated gpt-5.5 resolves through pricingBridge
    expect(rows.find(r => r.kind === 'images')).toMatchObject({ key_id: 'key_a', requests: 6, images: 6, est_cost_usd: null });
    expect(rows.find(r => r.kind === 'embeddings')).toMatchObject({ key_id: 'key_b', requests: 2, est_cost_usd: null });
  });

  it('errors keep the "<Provider> API <status>:" shape the classifier understands', async () => {
    mockFetch({ '/v1/organization/projects': json({ error: 'nope' }, 401) });
    const err = await listOpenAIKeys(cred).catch(e => e);
    expect(err.message).toMatch(/^OpenAI API 401:/);
    expect(classifyProviderError(err)).toBe('provider_auth');

    mockFetch({ '/v1/organization/usage/completions': json({ error: 'slow down' }, 429) });
    const err2 = await fetchOpenAIKeyUsage(cred, new Date(), new Date()).catch(e => e);
    expect(classifyProviderError(err2)).toBe('provider_rate_limit');
  });

  it('disabling a key DELETEs it from its project (no disable in OpenAI\'s API)', async () => {
    const calls = mockFetch({ '/v1/organization/projects/proj_1/api_keys/key_a': json({ deleted: true }) });
    await expect(disableOpenAIKey(cred, { key_id: 'key_a', project_id: 'proj_1' })).resolves.toEqual({ status: 'deleted' });
    expect(calls[0].method).toBe('DELETE');
  });
});

describe('Anthropic', () => {
  it('lists keys with their workspace name, and survives a failing workspace lookup', async () => {
    mockFetch({
      '/v1/organizations/api_keys': json({
        data: [
          { id: 'apikey_1', name: 'bot', partial_key_hint: 'sk-ant-api03-R2D...igAA', status: 'active', scope: { type: 'workspace', workspace_id: 'wrkspc_1' }, created_at: '2026-10-01T00:00:00Z' },
          { id: 'apikey_2', name: 'old', partial_key_hint: null, status: 'inactive', workspace_id: null },
        ],
        has_more: false,
      }),
      '/v1/organizations/workspaces': json({ data: [{ id: 'wrkspc_1', name: 'Bots' }] }),
    });
    const keys = await listAnthropicKeys(cred);
    expect(keys[0]).toMatchObject({ key_id: 'apikey_1', project_name: 'Bots', status: 'active', redacted_hint: 'sk-ant-api03-R2D...igAA' });
    expect(keys[1]).toMatchObject({ project_name: 'Default', status: 'inactive' });

    mockFetch({
      '/v1/organizations/api_keys': json({ data: [{ id: 'apikey_1', name: 'bot', scope: { type: 'workspace', workspace_id: 'wrkspc_1' } }] }),
      '/v1/organizations/workspaces': json({ error: 'forbidden' }, 403),
    });
    expect((await listAnthropicKeys(cred))[0].project_name).toBe('wrkspc_1');
  });

  it('reads hourly message usage per key with cache tokens, no request counts', async () => {
    const calls = mockFetch({
      '/v1/organizations/usage_report/messages': json({
        data: [{ starting_at: '2026-11-03T13:00:00Z', results: [
          { api_key_id: 'apikey_1', model: 'claude-haiku-4-5-20251001', uncached_input_tokens: 1000, cache_read_input_tokens: 500,
            cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 }, output_tokens: 200 },
          { api_key_id: null, model: 'claude-haiku-4-5-20251001', uncached_input_tokens: 5, output_tokens: 5 },
        ] }],
        has_more: false,
      }),
    });
    const rows = await fetchAnthropicKeyUsage(cred, new Date('2026-11-03T12:00:00Z'), new Date('2026-11-03T15:00:00Z'));
    expect(calls[0].url.searchParams.getAll('group_by[]')).toEqual(['api_key_id', 'model']);
    expect(calls[0].headers['x-api-key']).toBe('sk-admin-test');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key_id: 'apikey_1', kind: 'messages', requests: null, input_tokens: 1600, cached_tokens: 500, output_tokens: 200 });
    expect(rows[0].est_cost_usd).toBeGreaterThan(0);
  });

  it('disabling a key sets it inactive (reversible)', async () => {
    const calls = mockFetch({ '/v1/organizations/api_keys/apikey_1': json({ id: 'apikey_1', status: 'inactive' }) });
    await expect(disableAnthropicKey(cred, { key_id: 'apikey_1' })).resolves.toEqual({ status: 'inactive' });
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body)).toEqual({ status: 'inactive' });
  });
});
