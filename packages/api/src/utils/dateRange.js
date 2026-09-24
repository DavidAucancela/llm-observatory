// Shared range → SQL INTERVAL mapping used by both /api/metrics/summary and
// the insights service, so "current period" and "previous period" (double
// the interval, ending where the current one starts) never drift apart.
const RANGE_MAP  = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '60d': '60 days', '90d': '90 days' };
const DOUBLE_MAP = { '24h': '48 hours', '7d': '14 days', '30d': '60 days', '60d': '120 days', '90d': '180 days' };

const DAY_MS = 24 * 60 * 60 * 1000;
// Longest custom window a single request may ask for. Data retention is 90d by
// default, so this is generous; it only exists so /export can't be pointed at
// an unbounded span.
const MAX_CUSTOM_SPAN_DAYS = 366;

function getRangeIntervals(range) {
  return {
    interval:    RANGE_MAP[range]  || RANGE_MAP['7d'],
    dblInterval: DOUBLE_MAP[range] || DOUBLE_MAP['7d'],
  };
}

class RangeParamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RangeParamError';
    this.status = 400;
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_TZ    = /(Z|[+-]\d{2}:?\d{2})$/i;

// A bound is either a bare YYYY-MM-DD (interpreted as a UTC day: 00:00:00.000Z
// for `start`, 23:59:59.999Z for `end`, so the end day is inclusive) or a full
// ISO-8601 datetime that carries its own timezone. A datetime WITHOUT a zone is
// rejected: Postgres would otherwise cast it in the session timezone and the
// same request would mean different instants on different servers.
function parseBound(raw, name, isEnd) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new RangeParamError(`${name} must be an ISO-8601 date or datetime`);
  }
  const s = raw.trim();
  // V8 rolls an impossible calendar date (2026-02-31) into the next month
  // instead of rejecting it, so check the date part round-trips.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const probe = new Date(Date.UTC(y, mo - 1, da));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== da) {
      throw new RangeParamError(`${name} is not a valid date`);
    }
  }
  let d;
  if (DATE_ONLY.test(s)) {
    d = new Date(`${s}T${isEnd ? '23:59:59.999' : '00:00:00.000'}Z`);
  } else if (HAS_TZ.test(s)) {
    d = new Date(s);
  } else {
    throw new RangeParamError(`${name} must be YYYY-MM-DD (UTC) or an ISO-8601 datetime with a timezone (e.g. 2026-08-20T00:00:00Z)`);
  }
  if (Number.isNaN(d.getTime())) {
    throw new RangeParamError(`${name} is not a valid date`);
  }
  return d;
}

// Single place that turns `?range=&start=&end=` into a validated window.
//   - start/end (both required together) win over `range`, and imply
//     range='custom' when `range` is omitted (curl/SDK callers).
//   - `range=custom` without dates is a 400, not a silent 7d.
//   - unknown presets are a 400.
// Custom windows are inclusive on both ends; `spanMs` is end - start + 1ms, so a
// bare single UTC day is exactly 24h and the previous period is exactly [start
// - spanMs, start).
function parseRange(query = {}, { defaultRange = '7d', allowAll = false } = {}) {
  const { start, end } = query;
  const hasStart = start !== undefined && start !== '';
  const hasEnd   = end   !== undefined && end   !== '';

  if (hasStart || hasEnd) {
    if (!(hasStart && hasEnd)) {
      throw new RangeParamError('start and end must be provided together');
    }
    const startD = parseBound(start, 'start', false);
    const endD   = parseBound(end,   'end',   true);
    if (startD.getTime() > endD.getTime()) {
      throw new RangeParamError('start must not be after end');
    }
    const spanMs = endD.getTime() - startD.getTime() + 1;
    if (spanMs > MAX_CUSTOM_SPAN_DAYS * DAY_MS) {
      throw new RangeParamError(`Date range too long (max ${MAX_CUSTOM_SPAN_DAYS} days)`);
    }
    return {
      range: 'custom', custom: true,
      start: startD.toISOString(), end: endD.toISOString(), spanMs,
      interval: null, dblInterval: null,
    };
  }

  const range = query.range || defaultRange;
  if (range === 'custom') {
    throw new RangeParamError('range=custom requires start and end');
  }
  if (range === 'all' && allowAll) {
    return { range: 'all', custom: false, start: null, end: null, spanMs: null, interval: null, dblInterval: null };
  }
  if (!RANGE_MAP[range]) {
    throw new RangeParamError(`Invalid range "${range}" (use ${Object.keys(RANGE_MAP).join(', ')}, or start+end)`);
  }
  const { interval, dblInterval } = getRangeIntervals(range);
  return { range, custom: false, start: null, end: null, spanMs: null, interval, dblInterval };
}

// Express middleware: validates the window once for a whole router and exposes
// it as `req.dateRange`. GET only — POST/PUT bodies carry no range.
function rangeMiddleware(opts) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    try {
      req.dateRange = parseRange(req.query, opts);
      return next();
    } catch (err) {
      if (err instanceof RangeParamError) return res.status(400).json({ error: err.message });
      return next(err);
    }
  };
}

// Shared "give me the WHERE clause for this time window" used by the simpler
// range-only endpoints (tag-keys/tag-values/tag-breakdown/project-breakdown,
// balances) — appends 0 or 2 params to `params` in place and returns the SQL
// fragment referencing them. `dr` is `req.dateRange` from `rangeMiddleware`.
// Not used by /summary itself, which also needs the previous-period window and
// has its own inline version of this.
function appendTimeWindow(params, dr, column = 'timestamp') {
  if (dr.range === 'all') return 'TRUE';
  if (dr.custom) {
    params.push(dr.start, dr.end);
    const endIdx = params.length;
    return `${column} >= $${endIdx - 1} AND ${column} <= $${endIdx}`;
  }
  return `${column} > NOW() - INTERVAL '${dr.interval}'`;
}

module.exports = {
  getRangeIntervals, parseRange, rangeMiddleware, appendTimeWindow,
  RangeParamError, DAY_MS, MAX_CUSTOM_SPAN_DAYS,
};
