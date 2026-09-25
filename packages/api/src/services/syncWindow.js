const { parseRange, RangeParamError } = require('../utils/dateRange');
const { DAY_MS, retentionDays, floorUtcDay, retentionCutoffMs } = require('../utils/retention');

const DEFAULT_SYNC_DAYS = 30;

// Turns a sync request into the [startDate, endDate] window handed to the
// provider fetchers. Accepts EITHER `start`+`end` (a date range, same syntax as
// the date filter: bare YYYY-MM-DD = UTC day, or ISO with a timezone) OR the
// legacy `days` look-back.
//
//  - The window is aligned to UTC midnight at the start. Providers bucket usage
//    by UTC day and importBuckets stamps each row at its day's midnight, then
//    deletes the previous import by timestamp range: a start at some mid-day
//    instant left the first day's old row outside the delete window, so a
//    same-day re-sync inserted it a second time.
//  - The end is capped at `now` (a future end has no usage to fetch).
//  - Days older than the retention window are dropped (with a warning) rather
//    than imported and purged at 02:00; a window entirely older is a 400.
function resolveSyncWindow({ start, end, days } = {}, { now = Date.now(), retention = retentionDays() } = {}) {
  let startMs, endMs;

  const hasStart = start !== undefined && start !== '';
  const hasEnd   = end   !== undefined && end   !== '';
  if (hasStart || hasEnd) {
    const dr = parseRange({ start, end });           // 400s on bad/one-sided/reversed/too long
    startMs = floorUtcDay(Date.parse(dr.start));
    endMs   = Math.min(Date.parse(dr.end), now);
    if (startMs > now) throw new RangeParamError('start is in the future');
  } else {
    let n = DEFAULT_SYNC_DAYS;
    if (days !== undefined && days !== '') {
      n = Number(days);
      if (!Number.isInteger(n) || n < 1) throw new RangeParamError('days must be a positive integer');
    }
    startMs = floorUtcDay(now - n * DAY_MS);
    endMs   = now;
  }

  const cutoff = retentionCutoffMs(now, retention);
  if (endMs < cutoff) {
    throw new RangeParamError(`That range is entirely older than the ${retention}-day retention window; data older than that is deleted nightly, so it can't be synced`);
  }
  let clamped = false;
  let warning = null;
  if (startMs < cutoff) {
    startMs = cutoff;
    clamped = true;
    warning = `Start moved to ${new Date(cutoff).toISOString().slice(0, 10)}: data older than the ${retention}-day retention window is deleted nightly`;
  }

  return { startDate: new Date(startMs), endDate: new Date(endMs), clamped, warning };
}

module.exports = { resolveSyncWindow, DEFAULT_SYNC_DAYS };
