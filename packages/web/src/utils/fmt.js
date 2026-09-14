// Shared date formatting utilities used across all pages

const DATE_OPTS = { day: '2-digit', month: 'short', year: 'numeric' };
const TIME_OPTS = { hour: '2-digit', minute: '2-digit', hour12: false };

/** "23 May 2026, 14:30" — for timestamped events (requests, alerts, syncs) */
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', DATE_OPTS) + ', ' +
         d.toLocaleTimeString('en-GB', TIME_OPTS);
}

/** "23 May 2026" — for date-only fields (joined, expires, created) */
export function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', DATE_OPTS);
}

/**
 * "$0.92" for totals/KPIs, "$0.0043" for small per-request amounts that would
 * otherwise round to $0.00. Pass `small: true` for per-row/per-request costs.
 */
export function formatCost(usd, { small = false } = {}) {
  const n = parseFloat(usd) || 0;
  return `$${n.toFixed(small ? 4 : 2)}`;
}

/** "1.2M" / "12.4K" / "845" — compact counts (tokens, requests) */
export function fmtCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toString();
}

/**
 * "12 Aug" — short single date, locale-aware. `date` is a YYYY-MM-DD string
 * (native date-input value); the `T00:00:00` suffix forces local-time parsing
 * so the label can't drift a day off in negative-UTC-offset timezones (a bare
 * "2026-08-12" parses as UTC midnight).
 */
export function fmtDateShort(date, lang) {
  if (!date) return '';
  const locale = lang === 'es' ? 'es-ES' : 'en-US';
  return new Date(`${date}T00:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

/** "12 Aug – 20 Aug" — short label for a custom date-range picker. */
export function fmtRangeShort(start, end, lang) {
  if (!start || !end) return '—';
  return `${fmtDateShort(start, lang)} – ${fmtDateShort(end, lang)}`;
}

/** "845ms" under a second, "1.52s" from there up */
export function fmtLatency(ms) {
  const n = Math.round(ms ?? 0);
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n}ms`;
}

/**
 * "just now" / "8 min ago" / "2h ago" / "3d ago", falling back to fmtDate
 * past a week — for events with a real timestamp (notifications), not a
 * substitute for one. Takes `t` from the caller instead of importing
 * react-i18next here, so this file stays framework-agnostic.
 */
export function fmtRelative(iso, t) {
  if (!iso) return '—';
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1)  return t('common.justNow');
  if (diffMin < 60) return t('common.minutesAgo', { count: diffMin });
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)   return t('common.hoursAgo', { count: diffH });
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7)    return t('common.daysAgo', { count: diffD });
  return fmtDate(iso);
}
