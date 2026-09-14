import { fmtRangeShort } from './fmt';

// Range-picker presets shown in TopBar. 'custom' isn't listed here — it's a
// distinct 4th button driven by customRange {start, end} instead of ranges.map.
export const RANGE_PRESETS = ['24h', '7d', '30d'];

// i18n keys for each preset's button label — shared by TopBar (the buttons
// themselves) and any page that also echoes the active range in a subtitle
// or chart title (Models, Finance), so the wording can't drift between them.
export const RANGE_LABEL_I18N_KEYS = { '24h': 'topbar.range24h', '7d': 'topbar.range7d', '30d': 'topbar.range30d' };

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
