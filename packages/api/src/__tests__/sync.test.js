const { importBuckets } = require('../services/syncImport');
const { costForProviderUsage } = require('../services/pricingBridge');
const { resetDb, createOrg, pool } = require('./helpers');

beforeEach(resetDb);

const WIN_START = '2026-07-01T00:00:00Z';
const WIN_END   = '2026-07-31T00:00:00Z';
const DAY       = '2026-07-15T00:00:00Z';
const MODEL     = 'claude-sonnet-4-6';

// One Anthropic daily bucket for MODEL on DAY with the given token counts.
function bucket(tokens) {
  return [{ starting_at: DAY, results: [{ model: MODEL, ...tokens }] }];
}

// Insert a live (SDK-style) api_calls row: real timestamp inside DAY, no sync tag.
async function insertLive(orgId, { cost, input = 0, output = 0, preview = null, status = 200 }) {
  await pool.query(
    `INSERT INTO api_calls
       (org_id, timestamp, provider, model, input_tokens, output_tokens, total_tokens,
        cost_usd, latency_ms, status_code, prompt_preview, api_key_hint)
     VALUES ($1, '2026-07-15T12:00:00Z', 'anthropic', $2, $3, $4, $5, $6, 100, $7, $8, 'sk-live…abcd')`,
    [orgId, MODEL, input, output, input + output, cost, status, preview]
  );
}

async function syncRows(orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM api_calls WHERE org_id = $1 AND prompt_preview = 'sync:anthropic' ORDER BY id`,
    [orgId]
  );
  return rows;
}

describe('importBuckets — gap-based reconciling import', () => {
  it('inserts only the shortfall over live rows for the same provider/model/day', async () => {
    const { orgId } = await createOrg('Gap Org');
    await insertLive(orgId, { cost: 5 });

    const tokens = { uncached_input_tokens: 2_000_000, cache_read_input_tokens: 0, output_tokens: 133_334 };
    const expectedBucket = costForProviderUsage('anthropic', MODEL, {
      uncachedInput: 2_000_000, cacheReadInput: 0, cacheCreationInput: 0, output: 133_334,
    });

    const imported = await importBuckets(bucket(tokens), 'anthropic', orgId, WIN_START, WIN_END);
    expect(imported).toBe(1);

    const rows = await syncRows(orgId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].cost_usd)).toBeCloseTo(expectedBucket - 5, 5);
  });

  it('inserts nothing when live rows already cover the bucket', async () => {
    const { orgId } = await createOrg('NoGap Org');
    await insertLive(orgId, { cost: 100 });

    const imported = await importBuckets(
      bucket({ uncached_input_tokens: 2_000_000, output_tokens: 0 }), 'anthropic', orgId, WIN_START, WIN_END);
    expect(imported).toBe(0);
    expect(await syncRows(orgId)).toHaveLength(0);
  });

  it('is idempotent — re-running does not stack gap rows', async () => {
    const { orgId } = await createOrg('Idem Org');
    await insertLive(orgId, { cost: 1 });
    const b = bucket({ uncached_input_tokens: 1_000_000, output_tokens: 0 });

    await importBuckets(b, 'anthropic', orgId, WIN_START, WIN_END);
    const first = await syncRows(orgId);
    await importBuckets(b, 'anthropic', orgId, WIN_START, WIN_END);
    const second = await syncRows(orgId);

    expect(second).toHaveLength(1);
    expect(Number(second[0].cost_usd)).toBeCloseTo(Number(first[0].cost_usd), 6);
  });

  it('ignores ping / judge rows when summing live cost', async () => {
    const { orgId } = await createOrg('Exclude Org');
    await insertLive(orgId, { cost: 99, preview: 'test:sdk_integration' });
    await insertLive(orgId, { cost: 99, preview: 'eval:judge' });

    const imported = await importBuckets(
      bucket({ uncached_input_tokens: 1_000_000, output_tokens: 0 }), 'anthropic', orgId, WIN_START, WIN_END);

    // $3 bucket, no *real* live rows -> a ~$3 gap row is still created.
    expect(imported).toBe(1);
    expect(Number((await syncRows(orgId))[0].cost_usd)).toBeCloseTo(3, 5);
  });

  it('populates cache_read / cache_write columns on the gap row', async () => {
    const { orgId } = await createOrg('Cache Org');
    const imported = await importBuckets(
      bucket({ uncached_input_tokens: 500_000, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 300_000, output_tokens: 0 }),
      'anthropic', orgId, WIN_START, WIN_END);
    expect(imported).toBe(1);

    const row = (await syncRows(orgId))[0];
    expect(Number(row.cache_read_tokens)).toBe(200_000);
    expect(Number(row.cache_write_tokens)).toBe(300_000);
    // cost includes the 1.25x surcharge on the 300k cache-write tokens
    const expected = costForProviderUsage('anthropic', MODEL, {
      uncachedInput: 500_000, cacheReadInput: 200_000, cacheCreationInput: 300_000, output: 0,
    });
    expect(Number(row.cost_usd)).toBeCloseTo(expected, 5);
  });

  it('leaves existing sync rows untouched when the usage fetch returns no buckets', async () => {
    const { orgId } = await createOrg('Empty Fetch Org');
    await importBuckets(
      bucket({ uncached_input_tokens: 1_000_000, output_tokens: 0 }), 'anthropic', orgId, WIN_START, WIN_END);
    expect(await syncRows(orgId)).toHaveLength(1);

    const imported = await importBuckets([], 'anthropic', orgId, WIN_START, WIN_END);
    expect(imported).toBe(0);
    expect(await syncRows(orgId)).toHaveLength(1); // not wiped
  });

  it('converges — a later live row that closes the gap removes the sync row', async () => {
    const { orgId } = await createOrg('Converge Org');
    const b = bucket({ uncached_input_tokens: 1_000_000, output_tokens: 0 }); // ~$3 bucket

    await importBuckets(b, 'anthropic', orgId, WIN_START, WIN_END);
    expect(await syncRows(orgId)).toHaveLength(1);

    await insertLive(orgId, { cost: 5 }); // now live > bucket
    await importBuckets(b, 'anthropic', orgId, WIN_START, WIN_END);
    expect(await syncRows(orgId)).toHaveLength(0);
  });
});
