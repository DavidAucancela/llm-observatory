const { assessCoverage } = require('../services/coverage');
const { DAY_MS, retentionCutoffMs } = require('../utils/retention');

const NOW = Date.parse('2026-09-24T14:30:00Z');
const D = (s) => Date.parse(`${s}T00:00:00Z`);
const R = 90;

const base = {
  now: NOW, retention: R,
  firstDataMs: D('2026-08-01'), lastDataMs: NOW,
  windowStartMs: D('2026-09-01'), windowEndMs: NOW,
};
const prov = (over = {}) => ({ provider: 'anthropic', syncable: true, hasAdminKey: true, sync: null, ...over });
const run = (over) => assessCoverage({ ...base, providers: [prov()], ...over });

describe('assessCoverage', () => {
  it('a window inside the data needs no attention', () => {
    const c = run({});
    expect(c.needs_attention).toBe(false);
    expect(c.can_sync).toBe(false);
    expect(c.suggested_sync).toBeNull();
  });

  it('a custom window starting before the first record is flagged, and a sync is suggested for that span', () => {
    const c = run({ isCustom: true, windowStartMs: D('2026-07-01'), windowEndMs: D('2026-07-10') });
    expect(c.before_first_data).toBe(true);
    expect(c.needs_attention).toBe(true);
    expect(c.can_sync).toBe(true);
    expect(c.suggested_sync).toEqual({ start: '2026-07-01', end: '2026-07-10' });
    expect(c.syncable_providers).toEqual(['anthropic']);
  });

  it('no admin key: a custom window is still flagged, but no sync can be offered', () => {
    const c = run({ isCustom: true, windowStartMs: D('2026-07-01'), providers: [prov({ hasAdminKey: false })] });
    expect(c.before_first_data).toBe(true);
    expect(c.can_sync).toBe(false);
    expect(c.suggested_sync).toBeNull();
  });

  it('a PRESET before the first record stays quiet without an admin key (new orgs are not nagged)', () => {
    const c = run({ isCustom: false, windowStartMs: D('2026-07-01'), providers: [prov({ hasAdminKey: false })] });
    expect(c.before_first_data).toBe(true);   // still reported as a fact
    expect(c.needs_attention).toBe(false);    // but not worth a banner
  });

  it('a PRESET before the first record IS flagged when an admin key could backfill it', () => {
    const c = run({ isCustom: false, windowStartMs: D('2026-07-01') });
    expect(c.needs_attention).toBe(true);
    expect(c.can_sync).toBe(true);
  });

  it('a window older than retention is flagged and the suggestion is trimmed to what can survive the purge', () => {
    const cutoff = retentionCutoffMs(NOW, R);
    const c = run({ windowStartMs: D('2026-03-01'), firstDataMs: D('2026-09-10') });
    expect(c.beyond_retention).toBe(true);
    expect(c.can_sync).toBe(true);
    expect(c.suggested_sync.start).toBe(new Date(cutoff).toISOString().slice(0, 10));
  });

  it('a window entirely older than retention is flagged but not syncable', () => {
    const c = run({ windowStartMs: D('2026-01-01'), windowEndMs: D('2026-02-01'), firstDataMs: D('2026-09-10') });
    expect(c.beyond_retention).toBe(true);
    expect(c.can_sync).toBe(false);
  });

  it('flags days after the last sync (provider has synced before)', () => {
    const c = run({
      windowStartMs: D('2026-09-01'),
      providers: [prov({ sync: { fromMs: D('2026-08-01'), toMs: D('2026-09-10') + DAY_MS - 1 } })],
    });
    expect(c.sync_gaps).toHaveLength(1);
    expect(c.sync_gaps[0]).toMatchObject({ provider: 'anthropic', missing_after: true, missing_before: false });
    expect(c.needs_attention).toBe(true);
    expect(c.can_sync).toBe(true);
    expect(c.suggested_sync).toEqual({ start: '2026-09-01', end: '2026-09-24' });
  });

  it('does NOT nag an org whose provider never synced (SDK-only) when the window is inside its data', () => {
    const c = run({ providers: [prov({ sync: null })] });
    expect(c.sync_gaps).toEqual([]);
    expect(c.needs_attention).toBe(false);
  });

  it('a window covered by the last sync is clean', () => {
    const c = run({
      windowStartMs: D('2026-08-15'), windowEndMs: D('2026-09-05'),
      providers: [prov({ sync: { fromMs: D('2026-08-01'), toMs: D('2026-09-10') } })],
    });
    expect(c.sync_gaps).toEqual([]);
    expect(c.needs_attention).toBe(false);
  });

  it('flags days before the last sync window when the window is within retention', () => {
    const c = run({
      windowStartMs: D('2026-08-05'), firstDataMs: D('2026-07-01'),
      providers: [prov({ sync: { fromMs: D('2026-08-20'), toMs: NOW } })],
    });
    expect(c.sync_gaps[0].missing_before).toBe(true);
  });

  it('no data at all: nothing to compare against, no before_first_data', () => {
    const c = run({ firstDataMs: null, lastDataMs: null });
    expect(c.has_data).toBe(false);
    expect(c.before_first_data).toBe(false);
  });
});
