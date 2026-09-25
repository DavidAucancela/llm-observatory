import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../auth/AuthProvider';

const fmtDay = (iso, lang) =>
  new Date(iso).toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * Tells the user when the date range they picked may show incomplete numbers
 * (before the first record, older than the retention window, or past the last
 * provider sync) and, for admins, links to the Sync page with that range
 * pre-filled. It never hides data and never triggers a sync itself — syncing
 * calls the provider's admin API and lives only on the Sync page.
 *
 * `rangeParams` is buildRangeParams(...) output; the assessment is computed
 * server-side (services/coverage.js) so the rules live in one place.
 */
export default function CoverageBanner({ rangeParams }) {
  const { apiFetch } = useApi();
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const [cov, setCov] = useState(null);
  const query = new URLSearchParams(rangeParams).toString();

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/metrics/coverage?${query}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setCov(d); })
      .catch(() => { if (!cancelled) setCov(null); });
    return () => { cancelled = true; };
  }, [query]);

  if (!cov || !cov.needs_attention) return null;

  const lang = i18n.language;
  const isAdmin = user?.role === 'admin';
  const lines = [];
  if (cov.before_first_data && cov.first_data_at) {
    lines.push(t('coverage.beforeFirst', { date: fmtDay(cov.first_data_at, lang) }));
  }
  if (cov.beyond_retention) {
    lines.push(t('coverage.beyondRetention', { days: cov.retention_days }));
  }
  for (const g of cov.sync_gaps || []) {
    lines.push(t('coverage.syncGap', {
      provider: g.provider,
      from: fmtDay(g.synced_from, lang),
      to: fmtDay(g.synced_to, lang),
    }));
  }

  const suggested = cov.suggested_sync;
  const syncHref = suggested ? `/sync?start=${suggested.start}&end=${suggested.end}` : null;

  return (
    <div className="obs-coverage" role="status">
      <div className="obs-coverage-text">
        <strong>{t('coverage.title')}</strong>
        {lines.map((l, i) => <span key={i}>{l}</span>)}
      </div>
      {cov.can_sync && (isAdmin
        ? <Link className="obs-btn obs-btn-sm" to={syncHref}>{t('coverage.syncRange')}</Link>
        : <span className="obs-coverage-note">{t('coverage.askAdmin')}</span>)}
    </div>
  );
}
