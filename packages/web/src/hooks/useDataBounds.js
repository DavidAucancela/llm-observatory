import { useEffect, useState } from 'react';
import { useApi } from './useApi';
import { DEFAULT_RETENTION_DAYS } from '../utils/dateRange';

// What the date filter needs to know about the org's data, fetched once per
// session and shared by every consumer (same pattern as useProviders):
//   retentionDays — DATA_RETENTION_DAYS on the API (the nightly purge deletes
//                   older rows, so nothing before it can exist).
//   firstDataDay  — YYYY-MM-DD (UTC) of the org's oldest record, or null when
//                   there's none yet. Picking a range before it can only show
//                   zeros, so the picker stops there and says why.
// There's no dedicated endpoint: GET /api/metrics/coverage already computes
// both (services/coverage.js) for any range, so a cheap '7d' call is the source.
// The Sync page calls invalidateDataBounds() after an import, since a backfill
// moves firstDataDay earlier.
const FALLBACK = { retentionDays: DEFAULT_RETENTION_DAYS, firstDataDay: null, loaded: false };
let cache = null;
let inflight = null;
const listeners = new Set();

export function invalidateDataBounds() {
  cache = null;
  listeners.forEach(fn => fn());
}

export function useDataBounds() {
  const { apiFetch } = useApi();
  const [bounds, setBounds] = useState(cache ?? FALLBACK);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const onInvalidate = () => setVersion(v => v + 1);
    listeners.add(onInvalidate);
    return () => listeners.delete(onInvalidate);
  }, []);

  useEffect(() => {
    if (cache != null) { setBounds(cache); return undefined; }
    let cancelled = false;
    inflight = inflight || apiFetch('/api/metrics/coverage?range=7d')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d) return null;
        cache = {
          retentionDays: Number.isFinite(d.retention_days) ? d.retention_days : DEFAULT_RETENTION_DAYS,
          firstDataDay: d.first_data_at ? String(d.first_data_at).slice(0, 10) : null,
          loaded: true,
        };
        return cache;
      })
      .catch(() => null)
      .finally(() => { inflight = null; });
    inflight.then(value => { if (!cancelled && value) setBounds(value); });
    return () => { cancelled = true; };
  }, [version]);

  return bounds;
}
