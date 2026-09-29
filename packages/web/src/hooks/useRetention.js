import { useEffect, useState } from 'react';
import { useApi } from './useApi';

// Data retention window (DATA_RETENTION_DAYS on the API, default 90) — the
// nightly purge deletes api_calls older than this, so it's also the earliest
// day the date-range picker can usefully show. There's no dedicated endpoint
// for it: GET /api/metrics/coverage already computes it (services/coverage.js)
// for any range, so a cheap '7d' call doubles as the source here. Fetched
// once per session and shared by every consumer (TopBar, Sync), same pattern
// as useProviders.
let cache = null;
let inflight = null;
const FALLBACK_DAYS = 90; // matches retentionDays()'s own default in the API

export function useRetention() {
  const { apiFetch } = useApi();
  const [days, setDays] = useState(cache ?? FALLBACK_DAYS);

  useEffect(() => {
    if (cache != null) return undefined;
    let cancelled = false;
    inflight = inflight || apiFetch('/api/metrics/coverage?range=7d')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (Number.isFinite(d?.retention_days)) cache = d.retention_days; return cache; })
      .catch(() => null)
      .finally(() => { inflight = null; });
    inflight.then(value => { if (!cancelled && value != null) setDays(value); });
    return () => { cancelled = true; };
  }, []);

  return days;
}
