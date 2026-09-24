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
export const MAX_CUSTOM_SPAN_DAYS = 366;

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
 * Why a custom start/end pair can't be applied, as a `topbar.*` i18n key, or
 * null when it's fine. `today` is injectable for tests.
 */
export function customRangeError(start, end, today = todayUtc()) {
  if (!start || !end) return null; // incomplete: Apply stays disabled, nothing to explain yet
  if (!isValidDateOnly(start) || !isValidDateOnly(end)) return 'topbar.rangeErrInvalid';
  if (start > end) return 'topbar.rangeErrOrder';
  if (end > today || start > today) return 'topbar.rangeErrFuture';
  const spanDays = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS + 1;
  if (spanDays > MAX_CUSTOM_SPAN_DAYS) return 'topbar.rangeErrTooLong';
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
