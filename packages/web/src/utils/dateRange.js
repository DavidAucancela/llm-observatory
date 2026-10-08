import { fmtRangeShort } from './fmt';

// Range-picker presets shown in TopBar. 'custom' isn't listed here — it's a
// distinct 4th button driven by customRange {start, end} instead of ranges.map.
export const RANGE_PRESETS = ['24h', '7d', '30d'];

// i18n keys for each preset's button label — shared by TopBar (the buttons
// themselves) and any page that also echoes the active range in a subtitle
// or chart title (Models, Finance), so the wording can't drift between them.
export const RANGE_LABEL_I18N_KEYS = { '24h': 'topbar.range24h', '7d': 'topbar.range7d', '30d': 'topbar.range30d' };

// Longest custom window the API accepts (MAX_CUSTOM_SPAN_DAYS in
// packages/api/src/utils/dateRange.js) — keep in sync.
export const MAX_CUSTOM_SPAN_DAYS = 1830;

// Default DATA_RETENTION_DAYS on the API (DEFAULT_RETENTION_DAYS in
// packages/api/src/utils/retention.js) — used until useRetention() resolves.
export const DEFAULT_RETENTION_DAYS = 1095;

// One-click shortcuts in the custom-range popover, for looking far back
// without typing dates. `months: null` = everything still inside retention.
export const QUICK_RANGES = [
  { key: '3m',  months: 3,    i18n: 'topbar.quick3m' },
  { key: '6m',  months: 6,    i18n: 'topbar.quick6m' },
  { key: '1y',  months: 12,   i18n: 'topbar.quick1y' },
  { key: '2y',  months: 24,   i18n: 'topbar.quick2y' },
  { key: 'all', months: null, i18n: 'topbar.quickAll' },
];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** True for a real calendar YYYY-MM-DD (rejects 2026-02-31, which Date rolls over). */
export function isValidDateOnly(s) {
  if (typeof s !== 'string' || !DATE_ONLY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Today as YYYY-MM-DD in UTC. The whole date filter is UTC (the API buckets and
 * bounds days in UTC), so "today" for the picker's max must be UTC too. Call it
 * when the popover opens — a module-level constant goes stale in a tab left
 * open past midnight.
 */
export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Earliest day (YYYY-MM-DD, UTC) still inside the retention window — the day
 * after this one is the oldest the API hasn't purged yet. `retentionDays` is
 * the org-wide `DATA_RETENTION_DAYS` (default 1095, see useRetention()).
 */
export function earliestAvailableDay(today = todayUtc(), retentionDays = DEFAULT_RETENTION_DAYS) {
  const base = Date.parse(`${today}T00:00:00Z`);
  // Every real caller passes a `today` from todayUtc() itself, so this is
  // unreachable today — but `new Date(NaN).toISOString()` throws a
  // RangeError rather than returning a sentinel, and that would otherwise
  // propagate out of customRangeError() and crash the picker over a bad
  // "today" instead of just skipping the retention check.
  if (!Number.isFinite(base)) return today;
  const ms = base - (retentionDays - 1) * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * {start, end} (YYYY-MM-DD, UTC) for a QUICK_RANGES entry: `months` calendar
 * months back from `today` (same day of month, clamped for short months), or
 * from `minDay` for 'all'. Never starts before `minDay`, so a shortcut can't
 * produce a range the retention check would then reject.
 */
export function quickRangeDates(months, today = todayUtc(), minDay = earliestAvailableDay(today)) {
  let start = minDay;
  if (months != null) {
    const [y, m, d] = today.split('-').map(Number);
    const target = new Date(Date.UTC(y, m - 1 - months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d, lastDay));
    start = target.toISOString().slice(0, 10);
    if (start < minDay) start = minDay;
  }
  return { start, end: today };
}

/**
 * Why a custom start/end pair can't be applied, as a `topbar.*` i18n key, or
 * null when it's fine. `today` is injectable for tests. `retentionDays` is
 * optional — omit it (e.g. validating a value read back from localStorage,
 * before useRetention() has resolved) to skip the retention check rather than
 * reject a range that might turn out to be fine.
 */
export function customRangeError(start, end, today = todayUtc(), retentionDays) {
  if (!start || !end) return null; // incomplete: Apply stays disabled, nothing to explain yet
  if (!isValidDateOnly(start) || !isValidDateOnly(end)) return 'topbar.rangeErrInvalid';
  if (start > end) return 'topbar.rangeErrOrder';
  if (end > today || start > today) return 'topbar.rangeErrFuture';
  const spanDays = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS + 1;
  if (spanDays > MAX_CUSTOM_SPAN_DAYS) return 'topbar.rangeErrTooLong';
  if (retentionDays != null && start < earliestAvailableDay(today, retentionDays)) return 'topbar.rangeErrRetention';
  return null;
}

/**
 * Query params for a range-aware GET request. For 'custom', turns the
 * date-only YYYY-MM-DD picker values into UTC day-boundary instants so the
 * end date is fully included (the API compares start/end with `<=` against a
 * TIMESTAMPTZ column — sending a bare end date would mean "midnight at the
 * *start* of that day", silently dropping the whole last day).
 */
export function buildRangeParams(range, customRange) {
  if (range === 'custom' && customRange?.start && customRange?.end) {
    return {
      range: 'custom',
      start: `${customRange.start}T00:00:00.000Z`,
      end:   `${customRange.end}T23:59:59.999Z`,
    };
  }
  return { range };
}

/**
 * Human label for the active range: a translated preset name, or the actual
 * "12 Aug – 20 Aug" span for a custom pick. Takes `t`/`lang` from the
 * caller's own useTranslation() instead of importing react-i18next here,
 * same convention as utils/fmt.js's fmtRelative.
 */
export function rangeLabel(range, customRange, t, lang) {
  if (range === 'custom') return fmtRangeShort(customRange?.start, customRange?.end, lang);
  return t(RANGE_LABEL_I18N_KEYS[range] || RANGE_LABEL_I18N_KEYS['7d']);
}
