const DAY_MS = 24 * 60 * 60 * 1000;

// Default history kept when DATA_RETENTION_DAYS is unset: 3 years, so the date
// filter can show usage from "2+ years ago" straight from the DB instead of
// needing a re-sync. Was 90 days, which silently purged months-old usage.
const DEFAULT_RETENTION_DAYS = 1095;

// How long api_calls rows are kept — one definition shared by the nightly purge
// (index.js) and everything that must not import/promise data the purge will
// delete (range sync, coverage). Was inlined in the cron with no NaN guard: a
// bad DATA_RETENTION_DAYS made `Math.max(1, NaN)` NaN and the purge a no-op.
function retentionDays() {
  const n = parseInt(process.env.DATA_RETENTION_DAYS || String(DEFAULT_RETENTION_DAYS), 10);
  return Number.isFinite(n) ? Math.max(1, n) : DEFAULT_RETENTION_DAYS;
}

const floorUtcDay = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
const ceilUtcDay  = (ms) => Math.ceil(ms / DAY_MS) * DAY_MS;

// The earliest UTC midnight a row can be stamped at and still survive the purge
// (`timestamp < NOW() - N days` is deleted). Synced usage is stored at each
// day's UTC midnight, so a day earlier than this would be imported and then
// deleted that same night.
function retentionCutoffMs(now = Date.now(), days = retentionDays()) {
  return ceilUtcDay(now - days * DAY_MS);
}

module.exports = { DAY_MS, DEFAULT_RETENTION_DAYS, retentionDays, floorUtcDay, ceilUtcDay, retentionCutoffMs };
