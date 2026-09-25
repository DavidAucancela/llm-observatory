const { resolveSyncWindow } = require('../services/syncWindow');
const { RangeParamError } = require('../utils/dateRange');
const { retentionDays, retentionCutoffMs, DAY_MS } = require('../utils/retention');

const NOW = Date.parse('2026-09-24T14:30:00Z');
const R = 90;
const opts = { now: NOW, retention: R };
const iso = (d) => d.toISOString();

const bad = (input, re) => {
  let err;
  try { resolveSyncWindow(input, opts); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(RangeParamError);
  expect(err.status).toBe(400);
  if (re) expect(err.message).toMatch(re);
};

describe('resolveSyncWindow — days look-back', () => {
  it('defaults to 30 days, aligned to UTC midnight, ending now', () => {
    const w = resolveSyncWindow({}, opts);
    expect(iso(w.startDate)).toBe('2026-08-25T00:00:00.000Z'); // midnight of (now - 30d), not 14:30
    expect(w.endDate.getTime()).toBe(NOW);
    expect(w.clamped).toBe(false);
  });
  it('accepts numeric strings (query params)', () => {
    expect(iso(resolveSyncWindow({ days: '7' }, opts).startDate)).toBe('2026-09-17T00:00:00.000Z');
  });
  it('rejects zero, negative, fractional and non-numeric days (was: -5 = a future window)', () => {
    for (const days of ['0', '-5', '1.5', 'abc']) bad({ days }, /positive integer/);
  });
  it('trims a look-back longer than retention and says so', () => {
    const w = resolveSyncWindow({ days: '400' }, opts);
    expect(w.clamped).toBe(true);
    expect(w.warning).toMatch(/retention/);
    expect(w.startDate.getTime()).toBe(retentionCutoffMs(NOW, R));
  });
});

describe('resolveSyncWindow — start/end range', () => {
  it('a bare date range is whole UTC days; end is kept', () => {
    const w = resolveSyncWindow({ start: '2026-08-10', end: '2026-08-12' }, opts);
    expect(iso(w.startDate)).toBe('2026-08-10T00:00:00.000Z');
    expect(iso(w.endDate)).toBe('2026-08-12T23:59:59.999Z');
    expect(w.clamped).toBe(false);
  });
  it('floors a mid-day start to midnight (fixes the same-day re-sync duplicate)', () => {
    const w = resolveSyncWindow({ start: '2026-08-10T15:00:00Z', end: '2026-08-12' }, opts);
    expect(iso(w.startDate)).toBe('2026-08-10T00:00:00.000Z');
  });
  it('caps a future end at now', () => {
    const w = resolveSyncWindow({ start: '2026-09-20', end: '2026-09-30' }, opts);
    expect(w.endDate.getTime()).toBe(NOW);
  });
  it('rejects a start in the future', () => {
    bad({ start: '2026-10-01', end: '2026-10-02' }, /future/);
  });
  it('reuses the date filter validation (one-sided, reversed, garbage)', () => {
    bad({ start: '2026-08-10' }, /together/);
    bad({ start: '2026-08-12', end: '2026-08-10' }, /after end/);
    bad({ start: 'nope', end: '2026-08-10' });
  });
  it('trims the part older than retention, keeps the rest', () => {
    const cutoff = retentionCutoffMs(NOW, R);
    const w = resolveSyncWindow({ start: '2026-01-01', end: '2026-09-01' }, opts);
    expect(w.clamped).toBe(true);
    expect(w.startDate.getTime()).toBe(cutoff);
    expect(iso(w.endDate)).toBe('2026-09-01T23:59:59.999Z');
  });
  it('a range entirely older than retention is a 400 (would be purged that night)', () => {
    bad({ start: '2026-01-01', end: '2026-02-01' }, /entirely older/);
  });
  it('the cutoff is itself importable: a row stamped at cutoff survives the purge', () => {
    const cutoff = retentionCutoffMs(NOW, R);
    expect(cutoff).toBeGreaterThanOrEqual(NOW - R * DAY_MS); // purge deletes timestamp < now - R days
    expect(cutoff - (NOW - R * DAY_MS)).toBeLessThan(DAY_MS);
  });
});

describe('retentionDays', () => {
  const saved = process.env.DATA_RETENTION_DAYS;
  afterEach(() => { if (saved === undefined) delete process.env.DATA_RETENTION_DAYS; else process.env.DATA_RETENTION_DAYS = saved; });
  it('defaults to 90 and survives a garbage value (was NaN → purge silently a no-op)', () => {
    delete process.env.DATA_RETENTION_DAYS;
    expect(retentionDays()).toBe(90);
    process.env.DATA_RETENTION_DAYS = 'lots';
    expect(retentionDays()).toBe(90);
    process.env.DATA_RETENTION_DAYS = '30';
    expect(retentionDays()).toBe(30);
    process.env.DATA_RETENTION_DAYS = '0';
    expect(retentionDays()).toBe(1);
  });
});
