import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import ProviderBadge from '../components/ProviderBadge';
import Sparkline from '../components/Sparkline';
import HBar from '../components/HBar';
import ChartToolbar, { ChartHintBanner } from '../components/ChartToolbar';
import TopBar from '../components/TopBar';
import { useSocket } from '../hooks/useSocket';
import { useApi } from '../hooks/useApi';
import { useRangeFilter } from '../hooks/useRangeFilter';
import { formatCost, fmtLatency, fmtDateShort } from '../utils/fmt';
import { RANGE_PRESETS, buildRangeParams, todayUtc } from '../utils/dateRange';
import { buildGrid } from '../utils/metricGrid';
import { PROVIDER_COLORS } from '../utils/providerColors';
import { shortModelName } from '../utils/modelAlias';
import { errorRateSeverity, severityColor } from '../utils/severity';

// three.js + @react-three/fiber/drei add ~800KB minified — lazy-load so the
// bundle for every other route stays light; only the Dashboard route pays for it.
const MetricSurface3D = lazy(() => import('../components/MetricSurface3D'));
// recharts is also lazy-loaded so a user who stays on the (default) 3D view
// never pays for it — only fetched once they switch to the 2D view.
const ModelTrendChart2D = lazy(() => import('../components/ModelTrendChart2D'));

// ── Helpers ──────────────────────────────────────────────────────────────────

function calcDelta(current, previous) {
  const c = parseFloat(current);
  const p = parseFloat(previous);
  if (!p) return null;
  return ((c - p) / p) * 100;
}

function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toString();
}

function Delta({ value, inverse }) {
  if (value === null || value === undefined || isNaN(value)) return null;
  const up   = value > 0;
  const good = inverse ? !up : up;
  return (
    <span className={`delta ${good ? 'delta-up' : 'delta-down'}`}>
      {up ? '↑' : '↓'} {Math.abs(value).toFixed(1)}%
    </span>
  );
}

// ── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, delta, inverse, sparkData, accentColor = 'var(--border)', highlight, active, onClick }) {
  const emphasized = highlight || active;
  return (
    <div
      className={`kpi-card${onClick ? ' kpi-card-clickable' : ''}`}
      style={{
        '--kpi-accent': accentColor,
        ...(emphasized ? { borderColor: accentColor, background: `color-mix(in srgb, ${accentColor} 8%, transparent)` } : {}),
      }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className="kpi-label">{label}</div>
      <div className="kpi-row">
        <div className="kpi-value">{value ?? '—'}</div>
        <Delta value={delta} inverse={inverse} />
      </div>
      {sparkData?.length > 1 && (
        <div className="kpi-spark">
          <Sparkline data={sparkData} color={accentColor} height={32} fill />
        </div>
      )}
    </div>
  );
}

// Chart header label per KPI drill-down metric — kept alongside KpiCard since
// the two must stay in sync (adding a KPI card without an entry here just
// falls back to the generic tokensOverTime label).
const METRIC_HEADER_KEYS = {
  requests:  'dashboard.requestsOverTime',
  tokens:    'dashboard.tokensOverTime',
  cost:      'dashboard.costOverTime',
  latency:   'dashboard.latencyOverTime',
  errorRate: 'dashboard.errorRateOverTime',
};

// ── Provider breakdown with bars ──────────────────────────────────────────────

function ReconciliationBadge({ run }) {
  const { t } = useTranslation();
  if (!run) return null;
  if (run.status === 'error') return null; // job couldn't reach the provider — don't claim anything
  const deviation = parseFloat(run.deviation_pct || 0);
  const verified  = run.status !== 'alert';
  const color     = verified ? 'var(--success)' : 'var(--warning)';
  const label     = verified ? t('dashboard.reconciled') : t('dashboard.reconciliationDeviation', { pct: deviation.toFixed(1) });
  const hintKey   = run.source === 'token_estimate_fallback' ? 'dashboard.reconciliationHintFallback' : 'dashboard.reconciliationHint';
  const hint      = t(hintKey, {
    client: formatCost(parseFloat(run.client_reported_usd || 0)),
    provider: formatCost(parseFloat(run.provider_computed_usd || 0)),
  });
  return (
    <span title={hint} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9, fontWeight: 600,
      letterSpacing: '.03em', textTransform: 'uppercase', color, cursor: 'help',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, display: 'inline-block' }} />
      {label}
    </span>
  );
}

function ProviderBreakdown({ byProvider, loading, reconciliation }) {
  if (loading) return <div className="obs-skeleton" style={{ height: 90, borderRadius: 6 }} />;
  if (!byProvider.length) return (
    <div style={{ fontSize: 12, color: 'var(--muted)', padding: '16px 0' }}>—</div>
  );

  // Bar/percent track request share, not cost share — RangeSpend already
  // covers the $ breakdown, so this card's job is the volume view instead
  // of duplicating the same $+% figures.
  const totalRequests = byProvider.reduce((s, p) => s + parseInt(p.requests || 0, 10), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {byProvider.map(p => {
        const cost = parseFloat(p.total_cost || 0);
        const reqs = parseInt(p.requests || 0);
        const pct  = totalRequests > 0 ? (reqs / totalRequests) * 100 : 0;
        const color = PROVIDER_COLORS[p.provider] || 'var(--accent)';
        const run   = (reconciliation || []).find(r => r.provider === p.provider);
        return (
          <div key={p.provider}>
            {/* Provider name and the reconciliation badge stack, so the numbers
                on the right always fit — the card is one column of an auto-fit
                grid and can get down to ~320px. */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                <ProviderBadge provider={p.provider} />
                <ReconciliationBadge run={run} />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 11, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                <span style={{ fontSize: 10, textAlign: 'right', display: 'inline-block' }}>{formatCost(cost)}</span>
                <span style={{ width: 32, textAlign: 'right', display: 'inline-block' }}>{pct.toFixed(0)}%</span>
                <span style={{ color: 'var(--text)', fontWeight: 500, width: 58, textAlign: 'right', display: 'inline-block' }}>{reqs.toLocaleString()} req</span>
              </div>
            </div>
            <div className="iprog-bar" style={{ height: 5, borderRadius: 3 }}>
              <div style={{
                height: '100%', borderRadius: 3,
                width: `${pct}%`,
                background: color,
                transition: 'width 0.6s var(--ease-out)',
              }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Top models mini-section ───────────────────────────────────────────────────

function TopModels({ byModel, loading }) {
  if (loading) return <div className="obs-skeleton" style={{ height: 70, borderRadius: 6 }} />;
  if (!byModel?.length) return null;

  const top = byModel.slice(0, 5);
  const maxCost = Math.max(...top.map(m => parseFloat(m.total_cost || 0)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {top.map(m => {
        const cost = parseFloat(m.total_cost || 0);
        const pct  = maxCost > 0 ? (cost / maxCost) * 100 : 0;
        const color = PROVIDER_COLORS[m.provider] || 'var(--accent)';
        return (
          <div key={`${m.provider}-${m.model}`} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Name and bar both flex (name was a fixed 180px) so the row still
                fits when this card is one narrow column of the auto-fit grid. */}
            <div style={{
              fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)',
              flex: '2 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }} title={m.model}>
              {shortModelName(m.model)}
            </div>
            <div className="iprog-bar" style={{ flex: '1 1 0', minWidth: 24, height: 5, borderRadius: 3 }}>
              <div style={{
                height: '100%', borderRadius: 3, width: `${pct}%`,
                background: color, transition: 'width 0.6s var(--ease-out)',
              }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', width: 52, textAlign: 'right', flexShrink: 0 }}>
              {formatCost(cost)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', width: 42, textAlign: 'right', flexShrink: 0 }}>
              {parseInt(m.requests || 0).toLocaleString()}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Error type breakdown ──────────────────────────────────────────────────────

function ErrorBreakdown({ breakdown, loading }) {
  const { t } = useTranslation();

  const ERROR_TYPE_LABELS = {
    auth_error:      t('dashboard.authError'),
    rate_limit:      t('dashboard.rateLimit'),
    invalid_request: t('dashboard.invalidRequest'),
    server_error:    t('dashboard.serverError'),
    network_error:   t('dashboard.networkError'),
    timeout:         t('dashboard.timeout'),
    unknown_error:   t('dashboard.unknownError'),
  };

  if (loading) return <div className="obs-skeleton" style={{ height: 60, borderRadius: 6 }} />;
  if (!breakdown?.length) return (
    <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 0' }}>{t('dashboard.noErrors')}</div>
  );
  const max = Math.max(...breakdown.map(e => parseInt(e.count || 0)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {breakdown.map(e => (
        <HBar
          key={e.error_type}
          label={ERROR_TYPE_LABELS[e.error_type] || e.error_type}
          value={parseInt(e.count || 0)}
          max={max}
          color="var(--error)"
          valueLabel={e.count.toString()}
        />
      ))}
    </div>
  );
}

// ── Tag breakdown ─────────────────────────────────────────────────────────────

function TagBreakdown({ rangeParams, className = '' }) {
  const [tagKeys, setTagKeys]   = useState([]);
  const [tagKey, setTagKey]     = useState('');
  const [data, setData]         = useState([]);
  const [loading, setLoading]   = useState(false);
  const { apiFetch } = useApi();
  const { t } = useTranslation();
  const rangeKey = new URLSearchParams(rangeParams).toString();

  // `cancelled` guards drop a response that lands after the range changed again
  // (rapid range switches otherwise let an older request overwrite the newer one).
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/metrics/tag-keys?${rangeKey}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        const keys = d.keys || [];
        setTagKeys(keys);
        // Keep the selected key only if it still exists in the new range.
        setTagKey(prev => (keys.includes(prev) ? prev : (keys[0] || '')));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [rangeKey]);

  useEffect(() => {
    if (!tagKey) { setData([]); return; }
    let cancelled = false;
    setLoading(true);
    apiFetch(`/api/metrics/tag-breakdown?key=${encodeURIComponent(tagKey)}&${rangeKey}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) { setData(d.data || []); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tagKey, rangeKey]);

  if (!tagKeys.length) return null;

  const maxCost = Math.max(...data.map(d => parseFloat(d.total_cost || 0)), 0.0001);

  return (
    <div className={`obs-card dash-sub-card${className ? ` ${className}` : ''}`}>
      <div className="dash-card-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div className="obs-section-label">{t('dashboard.tagBreakdown')}</div>
        <select
          className="obs-btn"
          style={{ height: 26, paddingTop: 0, paddingBottom: 0, fontSize: 11 }}
          value={tagKey}
          onChange={e => setTagKey(e.target.value)}
        >
          {tagKeys.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {[...Array(3)].map((_, i) => <div key={i} className="obs-skeleton" style={{ height: 22, borderRadius: 3 }} />)}
        </div>
      ) : data.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('common.noData')}</div>
      ) : (
        <div className="dash-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {data.map(row => (
            <HBar
              key={row.value}
              label={String(row.value ?? '(empty)')}
              value={parseFloat(row.total_cost || 0)}
              max={maxCost}
              color="var(--accent)"
              valueLabel={formatCost(row.total_cost, { small: true })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Spend for the selected range, with per-provider progress bars ─────────────

const RANGE_LABEL_KEY = {
  '24h': 'dashboard.rangeLabel24h',
  '7d':  'dashboard.rangeLabel7d',
  '30d': 'dashboard.rangeLabel30d',
};

function RangeSpend({ byProvider, totalCost, prevTotalCost, range, customRange, configuredProviders, loading, className = '' }) {
  const { t, i18n } = useTranslation();
  if (loading) return <div className="obs-skeleton" style={{ height: 120, borderRadius: 6 }} />;

  const items = (byProvider || []).filter(p => configuredProviders.includes(p.provider));
  if (!items.length) return null;

  const total = parseFloat(totalCost || 0);
  const rangeLabel = range === 'custom'
    ? t('dashboard.rangeLabelCustom', {
        start: fmtDateShort(customRange?.start, i18n.language),
        end:   fmtDateShort(customRange?.end, i18n.language),
      })
    : t(RANGE_LABEL_KEY[range] || RANGE_LABEL_KEY['7d']);

  return (
    <div className={`obs-card dash-sub-card dash-range-spend${className ? ` ${className}` : ''}`}>
      <div className="dash-card-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
        <div className="obs-section-label">{t('dashboard.spentThisRange')}</div>
        <Delta value={calcDelta(totalCost, prevTotalCost)} inverse />
      </div>
      <div style={{ fontSize: 10, color: 'var(--faint)', marginBottom: 14 }}>{rangeLabel}</div>
      <div className="dash-scroll dash-range-spend-grid" style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`,
        gap: 0,
      }}>
        {items.map((p, i) => {
          const cost = parseFloat(p.total_cost || 0);
          const pct  = total > 0 ? (cost / total) * 100 : 0;
          const color = PROVIDER_COLORS[p.provider] || 'var(--accent)';

          return (
            <div key={p.provider} style={{
              paddingRight: i < items.length - 1 ? 28 : 0,
              paddingLeft:  i > 0 ? 28 : 0,
              borderRight:  i < items.length - 1 ? '1px solid var(--border-soft)' : 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <ProviderBadge provider={p.provider} size="lg" />
                <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
                  {formatCost(cost)}
                </span>
              </div>

              <div className="iprog-bar" style={{ height: 4, borderRadius: 2 }}>
                <div style={{
                  height: '100%', borderRadius: 2, width: `${pct}%`,
                  background: color, transition: 'width 0.6s var(--ease-out)',
                }} />
              </div>
              <div style={{ fontSize: 10, color: 'var(--faint)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                {pct.toFixed(0)}%
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const RANGES = RANGE_PRESETS;

export default function Dashboard({ darkMode, onToggleDarkMode }) {
  const { range, setRange, customRange, setCustomRange } = useRangeFilter('7d');
  const [summary, setSummary]     = useState(null);
  const [loading, setLoading]     = useState(true);
  const [syncing, setSyncing]     = useState(false);
  const [hasCredentials, setHasCredentials] = useState(true);
  const [configuredProviders, setConfiguredProviders] = useState([]);
  const [reconciliation, setReconciliation] = useState([]);
  const [activeMetric, setActiveMetric] = useState('tokens');
  const [chartView, setChartView] = useState(() => localStorage.getItem('obs-chart-view') || '2d');
  // Client-side-only visual toggle for which models' bars/lines are shown in
  // the chart. Not persisted: it's meant to be a lightweight, session-only declutter, same
  // as the toggle recharts' own <Legend> used to provide for the 2D view only.
  const [hiddenModels, setHiddenModels] = useState(() => new Set());
  // Mobile-only section tabs (below the 767px breakpoint) — desktop ignores
  // this entirely and keeps showing every card via .dash-cards-grid. Session
  // only, no localStorage: it's a scroll-depth aid, not a durable preference.
  const [mobileTab, setMobileTab] = useState('overview');
  const [toolbarCollapsed, setToolbarCollapsed] = useState(
    () => localStorage.getItem('obs-chart-toolbar-collapsed') === 'true'
  );
  // Usage-hint banner shown along the bottom of the chart plot (not a popover
  // in the rail — see ChartHintBanner). Session-only, no localStorage.
  const [chartHintOpen, setChartHintOpen] = useState(false);
  // 3D camera controls now live in the ChartToolbar rail (not an on-canvas
  // overlay). This state is owned here so it survives a 3D→2D→3D toggle and is
  // passed both to the rail (buttons) and down to MetricSurface3D (scene);
  // the imperative camera actions go through surface3dRef. Session-only.
  const [orbitLocked, setOrbitLocked] = useState(false);
  const [autoRotateOn, setAutoRotateOn] = useState(false);
  const surface3dRef = useRef(null);
  // 2D-only, additive metrics only (requests/tokens/cost) — see ChartToolbar's
  // showCompare prop below for where the restriction is enforced.
  const [comparePrev, setComparePrev] = useState(
    () => localStorage.getItem('obs-chart-compare-prev') === 'true'
  );
  const { on, off } = useSocket();
  const { apiFetch }  = useApi();
  const { t, i18n } = useTranslation();
  const rangeParams = useMemo(() => buildRangeParams(range, customRange), [range, customRange]);
  const rangeQuery  = useMemo(() => new URLSearchParams(rangeParams).toString(), [rangeParams]);

  // Latest-request-wins: a slow response for an old range must not overwrite the
  // one the user is looking at now. `silent` (live socket refreshes) skips the
  // loading flag so the skeletons don't flash on every incoming metric.
  const fetchSeq = useRef(0);
  const fetchAll = useCallback(async (silent = false) => {
    const seq = ++fetchSeq.current;
    if (!silent) setLoading(true);
    try {
      const [sumRes, credRes, reconRes] = await Promise.all([
        apiFetch(`/api/metrics/summary?${rangeQuery}`),
        apiFetch(`/api/credentials`),
        apiFetch(`/api/reconciliation/latest`),
      ]);
      const sum = await sumRes.json();
      const creds = (await credRes.json());
      const recon = (await reconRes.json()).latest || [];
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      setSummary(sum);
      const credList = creds.credentials || creds.data || [];
      setHasCredentials(credList.length > 0);
      setConfiguredProviders([...new Set(credList.map(c => c.provider))]);
      setReconciliation(recon);
    } catch (err) { console.error(err); }
    finally { if (seq === fetchSeq.current) setLoading(false); }
  }, [rangeQuery]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // A live metric is "now": only refresh when the selected window can contain it.
  // A historical custom range (end before today, UTC) can't change.
  const rangeIncludesNow = range !== 'custom' || (customRange?.end || '') >= todayUtc();
  useEffect(() => {
    if (!rangeIncludesNow) return undefined;
    const onNewMetric = () => fetchAll(true);
    on('new-metric', onNewMetric);
    return () => off('new-metric', onNewMetric);
  }, [on, off, fetchAll, rangeIncludesNow]);

  const s    = summary?.summary;
  const prev = summary?.prev_summary;

  const timeSeriesRaw = summary?.time_series || [];
  const hourMap = {};
  for (const row of timeSeriesRaw) {
    if (!hourMap[row.hour]) hourMap[row.hour] = { hour: row.hour, byProvider: {}, requests: 0, cost: 0 };
    const tokens = parseInt(row.total_tokens || 0);
    hourMap[row.hour].byProvider[row.provider] = (hourMap[row.hour].byProvider[row.provider] || 0) + tokens;
    hourMap[row.hour].requests += parseInt(row.requests || 0);
    hourMap[row.hour].cost     += parseFloat(row.cost_usd || 0);
  }
  const timeSeries = Object.values(hourMap).sort((a, b) => new Date(a.hour) - new Date(b.hour));

  // Previous-period series, bucketed the same way as time_series but already
  // shifted onto the current period's bucket grid server-side (see
  // prev_time_series in metrics.js) — index i here lines up with index i of
  // timeSeries/xLabels, not with any real previous-period date.
  const prevTimeSeriesRaw = summary?.prev_time_series || [];
  const prevHourMap = {};
  for (const row of prevTimeSeriesRaw) {
    if (!prevHourMap[row.hour]) prevHourMap[row.hour] = { hour: row.hour, tokens: 0, requests: 0, cost: 0 };
    prevHourMap[row.hour].tokens   += parseInt(row.total_tokens || 0);
    prevHourMap[row.hour].requests += parseInt(row.requests || 0);
    prevHourMap[row.hour].cost     += parseFloat(row.cost_usd || 0);
  }
  const prevTimeSeries = Object.values(prevHourMap).sort((a, b) => new Date(a.hour) - new Date(b.hour));

  // 24h uses hourly buckets → show hours; all other ranges use daily buckets → show dates.
  const useDate = range !== '24h';
  const axisLocale = i18n.language === 'es' ? 'es-ES' : 'en-US';
  const xLabels = timeSeries.map(r => {
    const d = new Date(r.hour);
    if (useDate) return d.toLocaleDateString(axisLocale, { month: 'short', day: 'numeric' });
    return `${String(d.getHours()).padStart(2, '0')}:00`;
  });

  const byProvider     = summary?.by_provider     || [];
  const byModel        = summary?.by_model        || [];
  const errorBreakdown = summary?.error_breakdown || [];

  // Shared model list for the chart toolbar's legend — derived independently
  // of hiddenModels, so a hidden model still shows up (dimmed) as a toggle target.
  const modelTimeSeries = summary?.model_time_series || [];
  const grid = useMemo(() => buildGrid(modelTimeSeries, activeMetric), [modelTimeSeries, activeMetric]);

  // byModel (summary.by_model) carries `.provider` per model and is
  // guaranteed to cover every model in grid.models — both come from the same
  // top-5-by-request-count query server-side — so no backend change or
  // naming heuristic is needed to color chart series by their provider's hue.
  const modelToProvider = useMemo(
    () => Object.fromEntries(byModel.map(m => [m.model, m.provider])),
    [byModel]
  );

  // Which real models the synthetic "Other" 3D bar rolls up: every model in
  // summary.all_models (whole-range counts) that isn't one of the charted
  // top-5. Feeds the pinned summary card when the "Other" bar is selected.
  const otherModels = useMemo(() => {
    const charted = new Set(grid.models.filter(m => m !== 'Other'));
    return (summary?.all_models || [])
      .filter(m => !charted.has(m.model))
      .map(m => ({ model: m.model, provider: m.provider, requests: Number(m.requests || 0) }));
  }, [summary, grid.models]);

  const toggleHiddenModel = (model) => setHiddenModels(prev => {
    const next = new Set(prev);
    next.has(model) ? next.delete(model) : next.add(model);
    return next;
  });

  // Isolating a model shows only that one (hides every other). A second
  // isolate on the same already-isolated model restores "show all" — reuses
  // the same hiddenModels Set the click-to-toggle legend already drives.
  const isolateModel = (model) => setHiddenModels(prev => {
    const allButThis = new Set(grid.models.filter(m => m !== model));
    const isAlreadyIsolated = prev.size === grid.models.length - 1 && !prev.has(model);
    return isAlreadyIsolated ? new Set() : allButThis;
  });

  const toggleToolbarCollapsed = () => setToolbarCollapsed(prev => {
    const next = !prev;
    localStorage.setItem('obs-chart-toolbar-collapsed', String(next));
    // Collapsing hides the hint trigger button itself, so leaving the banner
    // open would strand it with no way to close it short of re-expanding.
    if (next) setChartHintOpen(false);
    return next;
  });

  const toggleChartHint = () => setChartHintOpen(o => !o);

  // Click-away-to-close: dismiss on any click outside the whole chart card,
  // not just outside the banner/button — otherwise clicking the rail's own
  // 2D/3D toggle or legend (reasonable while the hint is open, e.g. to
  // compare the 3D-only rotate/zoom/pan hints against 2D) would close it too.
  useEffect(() => {
    if (!chartHintOpen) return;
    const onDoc = (e) => {
      if (e.target.closest('.dash-chart-card')) return;
      setChartHintOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [chartHintOpen]);

  const toggleComparePrev = () => setComparePrev(prev => {
    const next = !prev;
    localStorage.setItem('obs-chart-compare-prev', String(next));
    return next;
  });

  // requests/tokens/cost are additive across providers, so a single "previous
  // period total" line is honest for them — latency/errorRate would need a
  // weighted average, not a sum, so the toggle just doesn't offer those.
  const COMPARE_METRIC_FIELD = { requests: 'total_requests', tokens: 'total_tokens', cost: 'total_cost_usd' };
  const COMPARE_SERIES_KEY   = { requests: 'requests', tokens: 'tokens', cost: 'cost' };
  const compareSupported = chartView === '2d' && Boolean(COMPARE_METRIC_FIELD[activeMetric]);
  const compareDelta = compareSupported
    ? calcDelta(s?.[COMPARE_METRIC_FIELD[activeMetric]], prev?.[COMPARE_METRIC_FIELD[activeMetric]])
    : null;
  // Sliced to match ModelTrendChart2D's trimmed grid so index i of prevSeries
  // lines up with index i of the chart's own per-model data rows.
  const prevMetricSeries = compareSupported
    ? prevTimeSeries.map(r => r[COMPARE_SERIES_KEY[activeMetric]]).slice(grid.labelOffset, grid.labelOffset + grid.hours.length)
    : null;

  const tokenSpark = timeSeries.map(r => Object.values(r.byProvider).reduce((a, b) => a + b, 0));
  const reqSpark    = timeSeries.map(r => r.requests);
  const costSpark   = timeSeries.map(r => r.cost);

  const errorCount = parseInt(s?.error_count || 0);
  const totalReqs  = parseInt(s?.total_requests || 0);
  const errorPct   = totalReqs > 0 ? (errorCount / totalReqs) * 100 : 0;
  const errorRate  = `${errorPct.toFixed(1)}% (${errorCount})`;
  const errSeverity = errorRateSeverity(errorPct);

  const prevErrorCount = parseInt(prev?.error_count || 0);
  const prevTotalReqs  = parseInt(prev?.total_requests || 0);
  const prevErrorPct   = prevTotalReqs > 0 ? (prevErrorCount / prevTotalReqs) * 100 : 0;
  const errorDelta      = calcDelta(errorPct, prevErrorPct);

  if (!loading && !hasCredentials) {
    return (
      <main className="obs-main">
        <TopBar title={t('dashboard.title')} darkMode={darkMode} onToggleDarkMode={onToggleDarkMode} />
        <div className="obs-content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="obs-empty">
            <div className="obs-empty-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <div className="obs-empty-title">{t('dashboard.noKeysTitle')}</div>
            <div className="obs-empty-sub">{t('dashboard.noKeysSub')}</div>
            <a href="/settings" className="obs-btn obs-btn-primary" style={{ marginTop: 16, textDecoration: 'none' }}>
              {t('dashboard.addKeyButton')}
            </a>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="obs-main obs-fade-in">
      <TopBar
        title={t('dashboard.title')}
        ranges={RANGES}
        range={range}
        onRangeChange={setRange}
        customRange={customRange}
        onCustomRangeApply={setCustomRange}
        darkMode={darkMode}
        onToggleDarkMode={onToggleDarkMode}
      />

      <div className="obs-content dash-content">
        {/* Chart spans the full content width; the toolbar is a vertical rail on
            its right edge (row-reverse in CSS — this stays the first DOM child
            so mobile, which switches to flex-direction:column, keeps it on top
            as a horizontal bar) so nothing eats into the plot's height.
            ChartToolbar always stays mounted now (collapse only toggles a CSS
            class) so the rail animates open/closed instead of snapping, and
            renders its own floating 2D/3D toggle + expand tab that stay
            reachable while the rail is collapsed. */}
        <div className="obs-card dash-chart-card">
          <ChartToolbar
            title={t(METRIC_HEADER_KEYS[activeMetric] || 'dashboard.tokensOverTime')}
            models={grid.models}
            hiddenModels={hiddenModels}
            onToggleModel={toggleHiddenModel}
            onIsolateModel={isolateModel}
            modelToProvider={modelToProvider}
            chartView={chartView}
            onSetChartView={(v) => { setChartView(v); localStorage.setItem('obs-chart-view', v); }}
            onRefresh={async () => { setSyncing(true); await fetchAll(); setSyncing(false); }}
            syncing={syncing}
            collapsed={toolbarCollapsed}
            onToggleCollapsed={toggleToolbarCollapsed}
            hintOpen={chartHintOpen}
            onToggleHint={toggleChartHint}
            showCompare={compareSupported}
            comparePrev={comparePrev}
            onToggleCompare={toggleComparePrev}
            compareDelta={compareDelta}
            chart3d={chartView === '3d' ? {
              onView: (kind) => surface3dRef.current?.flyToView(kind),
              onRotate: (radians) => surface3dRef.current?.nudgeRotate(radians),
              onZoom: (factor) => surface3dRef.current?.nudgeZoom(factor),
              onReset: () => surface3dRef.current?.resetView(),
              orbitLocked,
              autoRotateOn,
              onToggleOrbitLock: () => setOrbitLocked(v => !v),
              onToggleAutoRotate: () => setAutoRotateOn(v => !v),
            } : null}
          />
          <div className="dash-chart-body">
            <Suspense fallback={<div className="obs-skeleton" style={{ height: '100%', borderRadius: 4 }} />}>
              {chartView === '3d' ? (
                <MetricSurface3D
                  ref={surface3dRef}
                  modelTimeSeries={modelTimeSeries}
                  metric={activeMetric}
                  xLabels={xLabels}
                  loading={loading}
                  hiddenModels={hiddenModels}
                  modelToProvider={modelToProvider}
                  otherModels={otherModels}
                  orbitLocked={orbitLocked}
                  autoRotateOn={autoRotateOn}
                  onSwitchTo2D={() => { setChartView('2d'); localStorage.setItem('obs-chart-view', '2d'); }}
                />
              ) : (
                <ModelTrendChart2D
                  modelTimeSeries={modelTimeSeries}
                  metric={activeMetric}
                  xLabels={xLabels}
                  loading={loading}
                  hiddenModels={hiddenModels}
                  modelToProvider={modelToProvider}
                  prevSeries={compareSupported && comparePrev ? prevMetricSeries : null}
                />
              )}
            </Suspense>
            <ChartHintBanner chartView={chartView} open={chartHintOpen} modelCount={grid.models.length} />
          </div>
        </div>

        {/* KPI Cards */}
        <div className="kpi-strip dash-kpi">
          <KpiCard
            label={t('activity.requestsCol')}
            value={loading ? '—' : fmt(s?.total_requests ?? 0)}
            delta={calcDelta(s?.total_requests, prev?.total_requests)}
            sparkData={reqSpark}
            accentColor="var(--text)"
            active={activeMetric === 'requests'}
            onClick={() => setActiveMetric('requests')}
          />
          <KpiCard
            label={t('activity.tokensCol')}
            value={loading ? '—' : fmt(s?.total_tokens ?? 0)}
            delta={calcDelta(s?.total_tokens, prev?.total_tokens)}
            sparkData={tokenSpark}
            accentColor="var(--tokens-color)"
            active={activeMetric === 'tokens'}
            onClick={() => setActiveMetric('tokens')}
          />
          <KpiCard
            label={t('dashboard.cost')}
            value={loading ? '—' : formatCost(s?.total_cost_usd)}
            delta={calcDelta(s?.total_cost_usd, prev?.total_cost_usd)}
            inverse
            sparkData={costSpark}
            accentColor="var(--cost-color)"
            active={activeMetric === 'cost'}
            onClick={() => setActiveMetric('cost')}
          />
          <KpiCard
            label={t('activity.avgLatencyCol')}
            value={loading ? '—' : fmtLatency(s?.avg_latency_ms)}
            delta={calcDelta(s?.avg_latency_ms, prev?.avg_latency_ms)}
            inverse
            accentColor="var(--latency-color)"
            active={activeMetric === 'latency'}
            onClick={() => setActiveMetric('latency')}
          />
          <KpiCard
            label={t('dashboard.errorRate')}
            value={loading ? '—' : errorRate}
            delta={errorDelta}
            inverse
            accentColor={severityColor(errSeverity)}
            highlight={!loading && errSeverity !== 'ok'}
            active={activeMetric === 'errorRate'}
            onClick={() => setActiveMetric('errorRate')}
          />
        </div>

        {/* Mobile-only section tabs — hidden entirely on desktop (see
            .dash-mobile-tabbar in index.css), where every section below
            already renders via .dash-cards-grid's auto-fit reflow. On mobile
            they cut the "everything stacked, infinite scroll" density down
            to one section at a time. */}
        <div className="obs-tabbar dash-mobile-tabbar">
          <button
            type="button"
            className={`obs-tab${mobileTab === 'overview' ? ' active' : ''}`}
            onClick={() => setMobileTab('overview')}
          >{t('dashboard.mobileTabOverview')}</button>
          <button
            type="button"
            className={`obs-tab${mobileTab === 'costs' ? ' active' : ''}`}
            onClick={() => setMobileTab('costs')}
          >{t('dashboard.mobileTabCosts')}</button>
          <button
            type="button"
            className={`obs-tab${mobileTab === 'more' ? ' active' : ''}`}
            onClick={() => setMobileTab('more')}
          >{t('dashboard.mobileTabMore')}</button>
        </div>

        {/* Full-width band: the providers render side by side with dividers, so
            this one card reads better spanning the row than boxed in a column. */}
        <RangeSpend
          byProvider={byProvider}
          totalCost={s?.total_cost_usd}
          prevTotalCost={prev?.total_cost_usd}
          range={range}
          customRange={customRange}
          configuredProviders={configuredProviders}
          loading={loading}
          className={mobileTab === 'overview' ? '' : 'dash-mobile-tab-hidden'}
        />

        {/* Breakdown cards — auto-fit grid, so adding a card here reflows the
            row instead of needing a hand-tuned column split. Provider
            breakdown leads the row, then the rest of the info cards. Each
            card stays a direct grid child (no extra wrapper) so desktop's
            auto-fit layout is untouched — only the mobile-tab-hidden class,
            scoped inside the mobile media query, gates visibility per tab. */}
        <div className="dash-cards-grid">
          <div className={`obs-card dash-sub-card${mobileTab === 'costs' ? '' : ' dash-mobile-tab-hidden'}`}>
            <div className="obs-section-label dash-card-head" style={{ marginBottom: 14 }}>{t('dashboard.byProvider')}</div>
            <div style={{ fontSize: 10, color: 'var(--faint)', marginTop: -10, marginBottom: 14 }}>{t('dashboard.byProviderSub')}</div>
            <div className="dash-scroll">
              <ProviderBreakdown byProvider={byProvider} loading={loading} reconciliation={reconciliation} />
            </div>
          </div>

          <div className={`obs-card dash-sub-card${mobileTab === 'costs' ? '' : ' dash-mobile-tab-hidden'}`}>
            <div className="dash-card-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div>
                <div className="obs-section-label">{t('dashboard.topModels')}</div>
                <div style={{ fontSize: 10, color: 'var(--faint)', marginTop: 2 }}>sorted by cost</div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', gap: 14, flexShrink: 0, whiteSpace: 'nowrap' }}>
                <span>{t('dashboard.cost')}</span>
                <span>{t('dashboard.reqs')}</span>
              </div>
            </div>
            <div className="dash-scroll">
              <TopModels byModel={byModel} loading={loading} />
            </div>
          </div>

          <div className={`obs-card dash-sub-card${mobileTab === 'more' ? '' : ' dash-mobile-tab-hidden'}`}>
            <div className="obs-section-label dash-card-head" style={{ marginBottom: 14 }}>{t('dashboard.errorsByType')}</div>
            <div className="dash-scroll">
              <ErrorBreakdown breakdown={errorBreakdown} loading={loading} />
            </div>
          </div>

          <TagBreakdown rangeParams={rangeParams} className={mobileTab === 'more' ? '' : 'dash-mobile-tab-hidden'} />
        </div>
      </div>
    </main>
  );
}
