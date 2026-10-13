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
const prov = (over = {}) => ({ provider: 'anthropic', syncable: true, hasAdminKey: true, ...over });
const run = (over) => assessCoverage({ ...base, providers: [prov()], ...over });

describe('assessCoverage', () => {
  it('a window inside the data needs no attention', () => {
    const c = run({ isCustom: true });
    expect(c.needs_attention).toBe(false);
    expect(c.can_sync).toBe(false);
    expect(c.suggested_sync).toBeNull();
  });

  it('a custom window starting before the first record is flagged; the suggested sync stops where data begins', () => {
    const c = run({ isCustom: true, windowStartMs: D('2026-07-01'), windowEndMs: NOW });
    expect(c.before_first_data).toBe(true);
    expect(c.needs_attention).toBe(true);
    expect(c.can_sync).toBe(true);
    expect(c.suggested_sync).toEqual({ start: '2026-07-01', end: '2026-07-31' });
    expect(c.syncable_providers).toEqual(['anthropic']);
  });

  it('no admin key: a custom window is still flagged, but no sync can be offered', () => {
    const c = run({ isCustom: true, windowStartMs: D('2026-07-01'), providers: [prov({ hasAdminKey: false })] });
    expect(c.before_first_data).toBe(true);
    expect(c.can_sync).toBe(false);
    expect(c.suggested_sync).toBeNull();
  });

  it('PRESETS never ask for anything, even before the first record with an admin key (no nag on every visit)', () => {
    const c = run({ isCustom: false, windowStartMs: D('2026-07-01') });
    expect(c.before_first_data).toBe(true);   // still reported as a fact
    expect(c.needs_attention).toBe(false);
    expect(c.can_sync).toBe(false);
  });

  it('a custom window older than retention is flagged and the suggestion is trimmed to what can survive the purge', () => {
    const cutoff = retentionCutoffMs(NOW, R);
    const c = run({ isCustom: true, windowStartMs: D('2026-03-01'), firstDataMs: D('2026-09-10') });
    expect(c.beyond_retention).toBe(true);
    expect(c.needs_attention).toBe(true);
    expect(c.can_sync).toBe(true);
    expect(c.suggested_sync.start).toBe(new Date(cutoff).toISOString().slice(0, 10));
  });

  it('a rolling window spanning exactly the retention is NOT flagged (only the day-aligned sync cutoff is later)', () => {
    const c = run({ isCustom: true, retention: 30, windowStartMs: NOW - 30 * DAY_MS, firstDataMs: NOW - 40 * DAY_MS });
    expect(c.beyond_retention).toBe(false);
    expect(c.needs_attention).toBe(false);
  });

  it('a window starting even a little before now - retention IS flagged', () => {
    const c = run({ isCustom: true, retention: 30, windowStartMs: NOW - 30 * DAY_MS - 60 * 1000, firstDataMs: NOW - 40 * DAY_MS });
    expect(c.beyond_retention).toBe(true);
  });

  it('a window entirely older than retention is flagged but not syncable', () => {
    const c = run({ isCustom: true, windowStartMs: D('2026-01-01'), windowEndMs: D('2026-02-01'), firstDataMs: D('2026-09-10') });
    expect(c.beyond_retention).toBe(true);
    expect(c.can_sync).toBe(false);
  });

  it('no data at all: nothing to compare against, no before_first_data', () => {
    const c = run({ isCustom: true, firstDataMs: null, lastDataMs: null });
    expect(c.has_data).toBe(false);
    expect(c.before_first_data).toBe(false);
  });
});
