import { useEffect, useState } from 'react';
import { useApi } from './useApi';
import { PROVIDER_LABELS } from '../utils/providerColors';

// Provider list + capabilities from GET /api/providers (the API's single source
// of truth, constants/providers.js). Fetched once per session and shared by
// every consumer. Until it arrives (or if it fails) callers get the full static
// label list — never a hardcoded two-provider fallback, which is what hid the
// providers added after Anthropic/OpenAI from several dropdowns.
let cache = null;
let inflight = null;
const FALLBACK = Object.keys(PROVIDER_LABELS).map(id => ({ id, label: PROVIDER_LABELS[id] }));

export function useProviders() {
  const { apiFetch } = useApi();
  const [providers, setProviders] = useState(cache || FALLBACK);

  useEffect(() => {
    if (cache) return undefined;
    let cancelled = false;
    inflight = inflight || apiFetch('/api/providers')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.providers?.length) cache = d.providers; return cache; })
      .catch(() => null)
      .finally(() => { inflight = null; });
    inflight.then(list => { if (!cancelled && list) setProviders(list); });
    return () => { cancelled = true; };
  }, []);

  const byId = Object.fromEntries(providers.map(p => [p.id, p]));
  return {
    providers,
    ids: providers.map(p => p.id),
    labelFor: (id) => byId[id]?.label || PROVIDER_LABELS[id] || id,
    hasCap: (id, cap) => Boolean(byId[id]?.[cap]),
  };
}
