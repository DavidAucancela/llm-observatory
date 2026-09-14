// Shared range → SQL INTERVAL mapping used by both /api/metrics/summary and
// the insights service, so "current period" and "previous period" (double
// the interval, ending where the current one starts) never drift apart.
const RANGE_MAP  = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '60d': '60 days', '90d': '90 days' };
const DOUBLE_MAP = { '24h': '48 hours', '7d': '14 days', '30d': '60 days', '60d': '120 days', '90d': '180 days' };

function getRangeIntervals(range) {
  return {
    interval:    RANGE_MAP[range]  || RANGE_MAP['7d'],
    dblInterval: DOUBLE_MAP[range] || DOUBLE_MAP['7d'],
  };
}

// Shared "give me the WHERE clause for this time window" used by the simpler
// range-only endpoints (tag-keys/tag-values/tag-breakdown/project-breakdown,
// balances) — appends 1 or 2 params to `params` in place and returns the SQL
// fragment referencing them. Custom start/end (the dashboard's date-range
// picker) takes priority over the range preset, same convention as
// GET /api/metrics and /summary. Not used by /summary itself, which also
// needs the previous-period window and has its own inline version of this.
function appendTimeWindow(params, { range, start, end }, column = 'timestamp') {
  if (start && end) {
    params.push(start, end);
    const endIdx = params.length;
    return `${column} >= $${endIdx - 1} AND ${column} <= $${endIdx}`;
  }
  const { interval } = getRangeIntervals(range);
  return `${column} > NOW() - INTERVAL '${interval}'`;
}

module.exports = { getRangeIntervals, appendTimeWindow };
