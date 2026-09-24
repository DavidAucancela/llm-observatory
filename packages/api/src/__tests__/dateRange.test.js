const { parseRange, appendTimeWindow, RangeParamError, DAY_MS } = require('../utils/dateRange');

const bad = (query, opts, re) => {
  let err;
  try { parseRange(query, opts); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(RangeParamError);
  expect(err.status).toBe(400);
  if (re) expect(err.message).toMatch(re);
};

describe('parseRange — presets', () => {
  it('defaults to 7d', () => {
    const r = parseRange({});
    expect(r).toMatchObject({ range: '7d', custom: false, interval: '7 days', dblInterval: '14 days', start: null, end: null });
  });
  it('honours defaultRange and known presets', () => {
    expect(parseRange({}, { defaultRange: '30d' }).interval).toBe('30 days');
    expect(parseRange({ range: '24h' }).interval).toBe('24 hours');
    expect(parseRange({ range: '90d' }).dblInterval).toBe('180 days');
  });
  it('rejects unknown presets (no silent 7d fallback)', () => {
    bad({ range: 'bogus' }, undefined, /Invalid range/);
  });
  it('only accepts range=all when allowed', () => {
    bad({ range: 'all' });
    expect(parseRange({ range: 'all' }, { allowAll: true })).toMatchObject({ range: 'all', custom: false });
  });
});

describe('parseRange — custom windows', () => {
  it('bare dates are a UTC day, inclusive at both ends', () => {
    const r = parseRange({ range: 'custom', start: '2026-07-15', end: '2026-07-15' });
    expect(r.custom).toBe(true);
    expect(r.start).toBe('2026-07-15T00:00:00.000Z');
    expect(r.end).toBe('2026-07-15T23:59:59.999Z');
    expect(r.spanMs).toBe(DAY_MS); // exactly one day, so hourly buckets + exact prev period
  });
  it('start+end alone imply custom (curl/SDK callers)', () => {
    expect(parseRange({ start: '2026-07-01', end: '2026-07-03' }).range).toBe('custom');
  });
  it('start/end win over a preset', () => {
    expect(parseRange({ range: '24h', start: '2026-07-01', end: '2026-07-03' }).custom).toBe(true);
  });
  it('accepts full ISO datetimes with a zone or offset', () => {
    const r = parseRange({ start: '2026-07-15T10:00:00Z', end: '2026-07-15T12:00:00+02:00' });
    expect(r.start).toBe('2026-07-15T10:00:00.000Z');
    expect(r.end).toBe('2026-07-15T10:00:00.000Z');
  });
  it('rejects a datetime without a timezone', () => {
    bad({ start: '2026-07-15T10:00:00', end: '2026-07-16' }, undefined, /timezone/);
  });
  it('rejects only one bound', () => {
    bad({ start: '2026-07-15' }, undefined, /together/);
    bad({ end: '2026-07-15' }, undefined, /together/);
    bad({ range: 'custom', start: '2026-07-15' }, undefined, /together/);
  });
  it('rejects range=custom without dates', () => {
    bad({ range: 'custom' }, undefined, /requires start and end/);
  });
  it('rejects garbage and impossible dates', () => {
    bad({ start: 'yesterday', end: '2026-07-15' });
    bad({ start: '2026-02-31', end: '2026-03-01' }, undefined, /not a valid date/);
  });
  it('rejects start after end', () => {
    bad({ start: '2026-07-16', end: '2026-07-15' }, undefined, /after end/);
  });
  it('caps the span', () => {
    expect(() => parseRange({ start: '2025-07-15', end: '2026-07-15' })).not.toThrow(); // 366 days
    bad({ start: '2024-01-01', end: '2026-07-15' }, undefined, /too long/);
  });
});

describe('appendTimeWindow', () => {
  it('custom pushes two params and is inclusive', () => {
    const params = ['org'];
    const sql = appendTimeWindow(params, parseRange({ start: '2026-07-15', end: '2026-07-15' }));
    expect(params).toEqual(['org', '2026-07-15T00:00:00.000Z', '2026-07-15T23:59:59.999Z']);
    expect(sql).toBe('timestamp >= $2 AND timestamp <= $3');
  });
  it('preset pushes nothing; all is TRUE; column is configurable', () => {
    const params = ['org'];
    expect(appendTimeWindow(params, parseRange({ range: '30d' }), 'ac.timestamp')).toBe("ac.timestamp > NOW() - INTERVAL '30 days'");
    expect(appendTimeWindow(params, parseRange({ range: 'all' }, { allowAll: true }))).toBe('TRUE');
    expect(params).toEqual(['org']);
  });
});
