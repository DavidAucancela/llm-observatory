const { parseRange, RangeParamError } = require('../utils/dateRange');
const { DAY_MS, retentionDays, floorUtcDay, retentionCutoffMs } = require('../utils/retention');

const DEFAULT_SYNC_DAYS = 30;

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// Earliest UTC day a sync for this provider can usefully import: the later of
// the retention edge (older days are purged nightly) and the provider's own
// history limit (OpenAI's usage API answers only the last year). Shared by
// resolveSyncWindow and GET /api/sync/overview so the page's date picker and
// the server agree on the same bound.
function earliestSyncableMs({ now = Date.now(), retention = retentionDays(), lookbackDays = null } = {}) {
  const cutoff = retentionCutoffMs(now, retention);
  if (lookbackDays == null) return cutoff;
  // Day-aligned: OpenAI reports its limit as a UTC date ("Earliest supported
  // start date: 2025-10-09"), i.e. today's UTC midnight minus the lookback.
  // A calendar year is never shorter than 365 days, so this never undershoots.
  return Math.max(cutoff, floorUtcDay(now) - lookbackDays * DAY_MS);
}

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
//  - `lookbackDays` (the provider's own history limit, PROVIDER_CAPS
//    .syncLookbackDays) trims the same way: OpenAI rejects the WHOLE request
//    when the start is more than a year back, so asking for 13 months used to
//    import nothing at all.
//
// Every error/warning carries a `code` + `params` so the UI can explain the
// limit in the user's language (see the Sync page's sync.codes.* strings).
function resolveSyncWindow(
  { start, end, days } = {},
  { now = Date.now(), retention = retentionDays(), lookbackDays = null, providerLabel = 'This provider' } = {},
) {
  let startMs, endMs;

  const hasStart = start !== undefined && start !== '';
  const hasEnd   = end   !== undefined && end   !== '';
  if (hasStart || hasEnd) {
    const dr = parseRange({ start, end });           // 400s on bad/one-sided/reversed/too long
    startMs = floorUtcDay(Date.parse(dr.start));
    endMs   = Math.min(Date.parse(dr.end), now);
    if (startMs > now) throw new RangeParamError('start is in the future', 'range_future');
  } else {
    let n = DEFAULT_SYNC_DAYS;
    if (days !== undefined && days !== '') {
      n = Number(days);
      if (!Number.isInteger(n) || n < 1) throw new RangeParamError('days must be a positive integer', 'invalid_days');
    }
    startMs = floorUtcDay(now - n * DAY_MS);
    endMs   = now;
  }

  const warnings = [];

  const cutoff = retentionCutoffMs(now, retention);
  if (endMs < cutoff) {
    throw new RangeParamError(
      `That range is entirely older than the ${retention}-day retention window; data older than that is deleted nightly, so it can't be synced`,
      'range_beyond_retention', { days: retention, date: ymd(cutoff) },
    );
  }
  if (startMs < cutoff) {
    startMs = cutoff;
    warnings.push({
      code: 'start_clamped_retention', params: { date: ymd(cutoff), days: retention },
      message: `Start moved to ${ymd(cutoff)}: data older than the ${retention}-day retention window is deleted nightly`,
    });
  }

  if (lookbackDays != null) {
    const providerCutoff = earliestSyncableMs({ now, retention, lookbackDays });
    if (endMs < providerCutoff) {
      throw new RangeParamError(
        `${providerLabel} only reports usage for the last ${lookbackDays} days, so that range can't be synced`,
        'range_beyond_provider_lookback', { provider: providerLabel, days: lookbackDays, date: ymd(providerCutoff) },
      );
    }
    if (startMs < providerCutoff) {
      startMs = providerCutoff;
      warnings.push({
        code: 'start_clamped_provider', params: { provider: providerLabel, days: lookbackDays, date: ymd(providerCutoff) },
        message: `Start moved to ${ymd(providerCutoff)}: ${providerLabel} only reports usage for the last ${lookbackDays} days`,
      });
    }
  }

  return {
    startDate: new Date(startMs), endDate: new Date(endMs),
    clamped: warnings.length > 0, warnings,
  };
}

module.exports = { resolveSyncWindow, earliestSyncableMs, DEFAULT_SYNC_DAYS };
