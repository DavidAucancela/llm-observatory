// Text for key-audit findings (API: services/keyWatch.js), shared by the
// /security page and the notification bell so both say the same thing.
import { formatCost, fmtCompact } from './fmt';

// Two decimals unless the amount would round to $0.00.
export const money = (usd) => formatCost(usd, { small: Math.abs(Number(usd) || 0) < 0.01 });

export const KEY_EVENT_TYPES = [
  'key_unmonitored_usage', 'key_new_capability', 'key_spend_spike', 'key_unknown', 'key_dormant_active', 'key_disabled',
];

export const eventTitle = (t, type) => t(`security.events.${type}`, { defaultValue: type });

export const severityColor = (severity) => (severity === 'high' ? 'var(--error)' : 'var(--warning)');

// "26 req · 6 img · ~$0.42 + unpriced" — whatever the usage block has.
// Accepts both the API's snake_case details and the bell's camelCase data.
export function usageSummary(t, u) {
  if (!u) return '';
  const requests = u.requests ?? null;
  const images = u.images || 0;
  const tokens = u.tokens || 0;
  const cost = u.est_cost_usd ?? u.estCostUsd ?? 0;
  const parts = [];
  if (requests != null) parts.push(t('security.usage.requests', { count: requests }));
  else if (tokens) parts.push(t('security.usage.tokens', { count: fmtCompact(tokens) }));
  if (images) parts.push(t('security.usage.images', { count: images }));
  if (cost > 0) parts.push(`~${money(cost)}`);
  if (u.unpriced) parts.push(t('security.usage.unpriced'));
  return parts.join(' · ');
}

// The specific "why" of a finding, one line.
export function eventReason(t, type, d = {}) {
  switch (type) {
    case 'key_new_capability': {
      const kinds = d.new_kinds ?? d.newKinds ?? [];
      const models = d.new_models ?? [];
      if (kinds.length) return t('security.eventDetail.newKinds', { kinds: kinds.map(k => t(`security.kinds.${k}`, { defaultValue: k })).join(', ') });
      if (models.length) return t('security.eventDetail.newModels', { models: models.join(', ') });
      return '';
    }
    case 'key_unmonitored_usage': {
      const pct = d.coverage_pct ?? d.coveragePct;
      if (pct == null) return '';
      return t('security.eventDetail.coverage', { pct, sdk: d.sdk_volume ?? '?', total: d.provider_volume ?? '?' });
    }
    case 'key_spend_spike':
      return d.peak_hour_usd != null
        ? t('security.eventDetail.spike', { peak: money(d.peak_hour_usd), base: money(d.baseline_hour_max_usd || 0) })
        : '';
    case 'key_dormant_active':
      return d.last_used_before ? t('security.eventDetail.dormant', { date: String(d.last_used_before).slice(0, 10) }) : '';
    case 'key_disabled':
      return d.by ? t('security.eventDetail.disabledBy', { by: d.by }) : '';
    default:
      return '';
  }
}
