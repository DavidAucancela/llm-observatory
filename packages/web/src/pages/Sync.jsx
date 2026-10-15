import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ProviderBadge from '../components/ProviderBadge';
import TopBar from '../components/TopBar';
import { useApi } from '../hooks/useApi';
import { useSocket } from '../hooks/useSocket';
import { useAuth } from '../auth/AuthProvider';
import { invalidateDataBounds } from '../hooks/useDataBounds';
import { fmtDateTime, fmtDateYear, fmtRelative } from '../utils/fmt';
import { isValidDateOnly, monthsBackDay, todayUtc } from '../utils/dateRange';

// The single place for provider data: what's stored per provider, whether the
// auto-sync is keeping it current, importing older history, and the run log.
// Everything it explains comes from GET /api/sync/overview (bounds, key state,
// last/latest run) and every error/warning is a `code` + `params` translated
// via sync.codes.* — never a raw provider error dump on its own.

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (iso) => (iso ? String(iso).slice(0, 10) : '');
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// Socket updates drive the page; this slow poll only covers a dropped socket
// while something is running.
const FALLBACK_POLL_MS = 20000;

// Import presets. `days`/`months` go back from today; 'max' sends each provider
// its own earliest importable day (retention + its API's lookback).
const IMPORT_PRESETS = [
  { key: '30d', days: 30 },
  { key: '90d', days: 90 },
  { key: '6m',  months: 6 },
  { key: '1y',  months: 12 },
  { key: '2y',  months: 24 },
  { key: 'max' },
];

function presetStart(p, today) {
  if (p.days) return addDays(today, -(p.days - 1));
  if (p.months) return monthsBackDay(p.months, today);
  return null; // 'max' — resolved per provider
}

export default function Sync({ darkMode, onToggleDarkMode }) {
  const { apiFetch } = useApi();
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const isAdmin = user?.role === 'admin';
  const [searchParams] = useSearchParams();

  // CoverageBanner links here with ?start=&end= (the span the dashboard range
  // is missing). Honour it only when both are real dates.
  const qStart = searchParams.get('start') || '';
  const qEnd   = searchParams.get('end') || '';
  const prefilled = isValidDateOnly(qStart) && isValidDateOnly(qEnd);

  const [overview, setOverview] = useState(null);
  const [logs, setLogs]         = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [today, setToday]       = useState(todayUtc);
  const [preset, setPreset]     = useState(prefilled ? 'custom' : '90d');
  const [from, setFrom]         = useState(prefilled ? qStart : '');
  const [to, setTo]             = useState(prefilled ? qEnd : '');
  const [selected, setSelected] = useState(null);   // Set of provider ids; null = default (all with a key)
  const [busy, setBusy]         = useState(false);
  const [results, setResults]   = useState(null);   // [{ provider, ok, code, params, text }]
  const [expanded, setExpanded] = useState({});     // log id → show raw error
  const [dangerOpen, setDangerOpen] = useState(false);
  const [clearing, setClearing] = useState({});
  const [confirmClear, setConfirmClear] = useState(null); // provider row awaiting typed confirmation
  const [confirmText, setConfirmText] = useState('');
  const [progress, setProgress] = useState({});     // sync id → { done, total } from the socket
  const { on, off } = useSocket();

  const fmtDay = useCallback((d) => fmtDateYear(d, lang), [lang]);

  // Translates a server code (+params) into a sentence. Date params arrive as
  // YYYY-MM-DD and are formatted here; unknown codes fall back to the raw text.
  const explain = useCallback((code, params = {}, fallback = '') => {
    if (!code) return fallback;
    const key = `sync.codes.${code}`;
    const p = { ...params };
    if (p.date) p.date = fmtDay(p.date);
    if (Array.isArray(p.models)) p.models = p.models.join(', ');
    const text = t(key, p);
    return text === key ? (fallback || code) : text;
  }, [t, fmtDay]);

  const fetchAll = useCallback(async () => {
    try {
      const [ov, lg] = await Promise.all([
        apiFetch('/api/sync/overview').then(r => (r.ok ? r.json() : Promise.reject(r))),
        apiFetch('/api/sync/logs').then(r => (r.ok ? r.json() : { logs: [] })),
      ]);
      setOverview(ov);
      setLogs(lg.logs || []);
      setLoadError(false);
    } catch { setLoadError(true); }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Runs execute in the background on the server and announce themselves on
  // the socket ('sync-update': start, each imported chunk, finish). Progress
  // ticks update in place; a start or finish refetches the overview (the
  // event reaches only this org's sockets and carries no data — the refetch
  // is what loads it).
  useEffect(() => {
    let timer = null;
    const onUpdate = (u) => {
      if (u?.progress) setProgress(prev => ({ ...prev, [u.sync_id]: u.progress }));
      if (u?.status !== 'running' || u?.progress?.done === 0) {
        clearTimeout(timer);
        timer = setTimeout(fetchAll, 300);
      }
    };
    on('sync-update', onUpdate);
    return () => { off('sync-update', onUpdate); clearTimeout(timer); };
  }, [on, off, fetchAll]);

  // Once every run finishes, refresh the date filter's bounds (an import can
  // move "data starts on" earlier).
  const anyRunning = Boolean(overview?.providers?.some(p => p.running)) || logs.some(l => l.status === 'running');
  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    if (anyRunning) { setWasRunning(true); }
    else if (wasRunning) { setWasRunning(false); invalidateDataBounds(); }
    if (!anyRunning) return undefined;
    const id = setInterval(fetchAll, FALLBACK_POLL_MS);
    return () => clearInterval(id);
  }, [anyRunning, fetchAll]);

  // { done, total } of a running sync: the socket's latest tick, else what the
  // overview/log row last stored.
  const progressOf = (id, details) => progress[id] || details?.progress || null;

  const providers = overview?.providers || [];
  const withKey = providers.filter(p => p.syncable && p.has_admin_key && !p.missing_account_id);
  const selectedSet = selected ?? new Set(withKey.map(p => p.provider));

  // The window the user asked for, before per-provider limits.
  const req = useMemo(() => {
    if (preset === 'custom') return { start: from, end: to };
    const p = IMPORT_PRESETS.find(x => x.key === preset);
    return { start: p ? presetStart(p, today) : null, end: today };
  }, [preset, from, to, today]);

  // A problem with the requested window itself (applies to every provider).
  const rangeProblem = useMemo(() => {
    if (preset !== 'custom') return null;
    if (!from || !to) return { code: 'pick_dates' };
    if (!isValidDateOnly(from) || !isValidDateOnly(to)) return { code: 'invalid_date' };
    if (from > to) return { code: 'range_order' };
    if (from > today || to > today) return { code: 'range_future' };
    return null;
  }, [preset, from, to, today]);

  // What each provider would actually import — or why it can't.
  const plan = useMemo(() => providers.filter(p => p.syncable).map(p => {
    if (!p.has_admin_key) return { p, blocked: { code: 'no_admin_key', params: { provider: p.label } } };
    if (p.missing_account_id) return { p, blocked: { code: 'missing_account_id', params: { provider: p.label } } };
    if (p.running) return { p, blocked: { code: 'already_running', params: { provider: p.label } } };
    if (rangeProblem) return { p, blocked: rangeProblem };
    const earliest = p.earliest_syncable;
    const end = req.end;
    if (end < earliest) {
      const code = p.lookback_days ? 'range_beyond_provider_lookback' : 'range_beyond_retention';
      return { p, blocked: { code, params: { provider: p.label, days: p.lookback_days || overview.retention_days, date: earliest } } };
    }
    const start = req.start && req.start > earliest ? req.start : earliest;
    const trimmed = Boolean(req.start) && req.start < earliest;
    const note = trimmed
      ? (p.lookback_days
        ? { code: 'start_clamped_provider', params: { provider: p.label, days: p.lookback_days, date: earliest } }
        : { code: 'start_clamped_retention', params: { days: overview.retention_days, date: earliest } })
      : null;
    return { p, start, end, note };
  }), [providers, rangeProblem, req, overview]);

  const runnable = plan.filter(x => !x.blocked && selectedSet.has(x.p.provider));

  const toggleProvider = (id) => {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const handleImport = async () => {
    if (!runnable.length) return;
    setBusy(true); setResults(null); setToday(todayUtc());
    const out = [];
    for (const { p, start, end } of runnable) {
      try {
        const res = await apiFetch(`/api/sync/${p.provider}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start, end }),
        });
        const d = await res.json();
        if (d.success) {
          const w = (d.warnings || [])[0];
          out.push({ provider: p.provider, ok: true, warn: Boolean(w),
            text: w ? explain(w.code, w.params) : t('sync.import.started', { provider: p.label, from: fmtDay(start), to: fmtDay(end) }) });
        } else {
          out.push({ provider: p.provider, ok: false, text: explain(d.code, d.params, d.error) });
        }
      } catch {
        out.push({ provider: p.provider, ok: false, text: t('sync.codes.connection') });
      }
    }
    setResults(out); setBusy(false);
    fetchAll();
  };

  const handleRefresh = async () => {
    setBusy(true); setResults(null);
    try {
      const res = await apiFetch('/api/sync/refresh', { method: 'POST' });
      const d = await res.json();
      const label = (id) => providers.find(p => p.provider === id)?.label || id;
      const out = (d.results || []).map(r => (r.status === 'started'
        ? { provider: r.provider, ok: true, text: t('sync.refresh.started', { provider: label(r.provider), from: fmtDay(r.window.start), to: fmtDay(r.window.end) }) }
        : { provider: r.provider, ok: false, warn: r.code === 'already_running', text: explain(r.code, r.params, r.error) }));
      setResults(out.length ? out : [{ ok: false, warn: true, text: t('sync.refresh.nothing') }]);
    } catch {
      setResults([{ ok: false, text: t('sync.codes.connection') }]);
    } finally { setBusy(false); fetchAll(); }
  };

  const openClear = (p) => { setConfirmText(''); setConfirmClear(p); };
  const closeClear = () => setConfirmClear(null);
  const confirmMatches = confirmClear && confirmText.trim().toLowerCase() === confirmClear.label.toLowerCase();

  const handleClear = async (p) => {
    setConfirmClear(null);
    setClearing(s => ({ ...s, [p.provider]: true }));
    try {
      const d = await (await apiFetch(`/api/sync/${p.provider}/data`, { method: 'DELETE' })).json();
      setResults([d.success
        ? { provider: p.provider, ok: true, text: t('sync.danger.deleted', { count: d.deleted, provider: p.label }) }
        : { provider: p.provider, ok: false, text: d.error || t('common.error') }]);
      invalidateDataBounds();
    } catch {
      setResults([{ ok: false, text: t('sync.codes.connection') }]);
    } finally { setClearing(s => ({ ...s, [p.provider]: false })); fetchAll(); }
  };

  const range = (a, b) => (a && b ? `${fmtDay(a)} – ${fmtDay(b)}` : null);

  function ProgressBar({ value }) {
    if (!value || !value.total) return null;
    const pct = Math.round((value.done / value.total) * 100);
    return (
      <span className="sync-progress" title={t('sync.status.chunks', { done: value.done, total: value.total })}>
        <span className="iprog-bar"><span className="iprog-fill" style={{ width: `${pct}%` }} /></span>
        <span className="sync-progress-pct">{pct}%</span>
      </span>
    );
  }
  const statusColor = (s) => s === 'success' ? 'var(--success)' : s === 'error' ? 'var(--error)' : 'var(--accent)';

  // Status line for a provider row — the most relevant fact first.
  function ProviderStatus({ p }) {
    if (!p.syncable) return <span>{t('sync.status.sdkOnly')}</span>;
    if (!p.has_admin_key) {
      return (
        <>
          <span>{t('sync.status.noKey')}</span>
          {isAdmin && <Link to="/keys" className="sync-link">{t('sync.status.addKey')}</Link>}
        </>
      );
    }
    if (p.missing_account_id) {
      return (
        <>
          <span style={{ color: 'var(--warning)' }}>{explain('missing_account_id', { provider: p.label })}</span>
          {isAdmin && <Link to="/keys" className="sync-link">{t('sync.status.fixKey')}</Link>}
        </>
      );
    }
    const latest = p.latest;
    const ok = p.last_success;
    return (
      <>
        {p.running && latest && (
          <span style={{ color: 'var(--accent)' }}>
            <span className="dot dot-pulse" style={{ background: 'var(--accent)', marginRight: 6 }} />
            {t('sync.status.running', { range: range(latest.start, latest.end) || '' })}
            <ProgressBar value={progressOf(latest.id, latest.details)} />
          </span>
        )}
        {!p.running && latest?.status === 'error' && (
          <span style={{ color: 'var(--error)' }}>
            {t('sync.status.failed', { when: fmtRelative(latest.started_at, t) })}: {explain(latest.error_code, { provider: p.label }, latest.error_message)}
          </span>
        )}
        {ok ? (
          <span>
            {t('sync.status.updated', { when: fmtRelative(ok.completed_at || ok.started_at, t) })}
            {' · '}{t(ok.trigger === 'auto' ? 'sync.trigger.auto' : 'sync.trigger.manual')}
            {range(ok.start, ok.end) && <> · {t('sync.status.covers', { range: range(ok.start, ok.end) })}</>}
          </span>
        ) : !p.running && <span>{t('sync.status.never')}</span>}
        {ok?.details?.skipped_models?.length > 0 && (
          <span style={{ color: 'var(--warning)' }}>{explain('skipped_models', { models: ok.details.skipped_models })}</span>
        )}
      </>
    );
  }

  const auto = overview?.auto_sync;

  return (
    <main className="obs-main obs-fade-in">
      <TopBar title={t('settings.syncTab')} darkMode={darkMode} onToggleDarkMode={onToggleDarkMode} />

      <div className="obs-content sync-page">
        {loadError && <div className="sync-msg sync-msg--error">{t('sync.loadError')}</div>}
        {!overview && !loadError && <div style={{ color: 'var(--muted)', fontSize: 12, padding: '16px 0' }}>{t('common.loading')}</div>}

        {overview && (
          <>
            {/* ── Auto-sync + update now ─────────────────────────────── */}
            <section className="sync-auto">
              <div>
                <div className="sync-auto-title">
                  <span className={`dot${auto?.enabled ? ' dot-pulse' : ''}`} style={{ background: auto?.enabled ? 'var(--success)' : 'var(--muted)' }} />
                  {auto?.enabled ? t('sync.auto.on', { hours: auto.every_hours }) : t('sync.auto.off')}
                </div>
                <div className="sync-sub">
                  {auto?.enabled && withKey.length > 0 && t('sync.auto.next', { when: fmtDateTime(auto.next_run_at) })}
                  {auto?.enabled && withKey.length === 0 && t('sync.auto.noProviders')}
                  {' '}{t('sync.auto.explain', { days: overview.retention_days })}
                </div>
              </div>
              {isAdmin && (
                <button className="obs-btn obs-btn-primary" disabled={busy || withKey.length === 0} onClick={handleRefresh}>
                  {busy ? '…' : t('sync.refresh.button')}
                </button>
              )}
            </section>

            {results && (
              <div className="sync-results" role="status">
                {results.map((r, i) => (
                  <div key={i} className={`sync-msg ${r.ok ? (r.warn ? 'sync-msg--warn' : 'sync-msg--ok') : (r.warn ? 'sync-msg--warn' : 'sync-msg--error')}`}>
                    {r.text}
                  </div>
                ))}
              </div>
            )}

            {/* ── Per-provider state ─────────────────────────────────── */}
            <div className="obs-section-label" style={{ marginTop: 20 }}>{t('sync.providers.title')}</div>
            <div className="sync-sub" style={{ marginBottom: 6 }}>
              {overview.first_data_at
                ? t('sync.providers.dataSince', { date: fmtDay(overview.first_data_at) })
                : t('sync.providers.noData')}
            </div>
            {overview.expiring?.rows > 0 && (
              <div className="sync-msg sync-msg--warn" style={{ marginBottom: 8 }}>
                {t('sync.providers.expiring', {
                  count: overview.expiring.rows, date: fmtDay(overview.expiring.before),
                  within: overview.expiring.within_days, days: overview.retention_days,
                })}
              </div>
            )}
            {providers.map(p => (
              <div key={p.provider} className="sync-row obs-row-grid">
                <ProviderBadge provider={p.provider} size="lg" />
                <div className="sync-row-status"><ProviderStatus p={p} /></div>
                <div className="sync-row-data">
                  {p.data ? (
                    <>
                      <span style={{ color: 'var(--text)' }}>{range(p.data.first_at, p.data.last_at)}</span>
                      <span>{t('sync.providers.rows', { live: p.data.live_rows, imported: p.data.sync_rows })}</span>
                    </>
                  ) : <span>{t('sync.providers.empty')}</span>}
                  {p.has_admin_key && (
                    <span>
                      {p.lookback_days
                        ? t('sync.providers.limitProvider', { date: fmtDay(p.earliest_syncable), days: p.lookback_days })
                        : t('sync.providers.limit', { date: fmtDay(p.earliest_syncable) })}
                    </span>
                  )}
                </div>
              </div>
            ))}

            {/* ── Import older history ───────────────────────────────── */}
            {isAdmin && (
              <section className="sync-import">
                <div className="obs-section-label">{t('sync.import.title')}</div>
                <div className="sync-sub">{t('sync.import.explain')}</div>

                <div className="sync-import-controls">
                  <div className="obs-range-picker" role="group" aria-label={t('sync.import.rangeLabel')}>
                    {IMPORT_PRESETS.map(p => (
                      <button key={p.key} type="button" className={`obs-range-btn${preset === p.key ? ' active' : ''}`} onClick={() => setPreset(p.key)}>
                        {t(`sync.import.presets.${p.key}`)}
                      </button>
                    ))}
                    <button type="button" className={`obs-range-btn${preset === 'custom' ? ' active' : ''}`} onClick={() => setPreset('custom')}>
                      {t('sync.import.presets.custom')}
                    </button>
                  </div>
                  {preset === 'custom' && (
                    <div className="sync-import-dates">
                      <label htmlFor="sync-from">{t('sync.import.from')}</label>
                      <input id="sync-from" type="date" className="obs-input" value={from} min={overview.retention_cutoff} max={to || today} onChange={e => setFrom(e.target.value)} />
                      <label htmlFor="sync-to">{t('sync.import.to')}</label>
                      <input id="sync-to" type="date" className="obs-input" value={to} min={from || overview.retention_cutoff} max={today} onChange={e => setTo(e.target.value)} />
                    </div>
                  )}
                </div>

                {rangeProblem && rangeProblem.code !== 'pick_dates' && (
                  <div className="sync-msg sync-msg--error" role="alert">{explain(rangeProblem.code)}</div>
                )}

                <div className="sync-plan">
                  {plan.map(({ p, blocked, start, end, note }) => (
                    <label key={p.provider} className={`sync-plan-row${blocked ? ' is-blocked' : ''}`}>
                      <input type="checkbox" disabled={Boolean(blocked)} checked={!blocked && selectedSet.has(p.provider)} onChange={() => toggleProvider(p.provider)} />
                      <ProviderBadge provider={p.provider} />
                      <span className="sync-plan-text">
                        {blocked
                          ? (blocked.code === 'pick_dates' ? t('sync.import.pickDates') : explain(blocked.code, blocked.params))
                          : <>
                              <span style={{ color: 'var(--text)' }}>{range(start, end)}</span>
                              {note && <span style={{ color: 'var(--warning)' }}> — {explain(note.code, note.params)}</span>}
                            </>}
                      </span>
                    </label>
                  ))}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <button className="obs-btn obs-btn-primary" disabled={busy || runnable.length === 0} onClick={handleImport}>
                    {busy ? '…' : t('sync.import.button', { count: runnable.length })}
                  </button>
                  <span className="sync-sub">{t('sync.import.idempotent')}</span>
                </div>
              </section>
            )}

            {/* ── Run log ────────────────────────────────────────────── */}
            {logs.length > 0 && (
              <section style={{ marginTop: 28 }}>
                <div className="obs-section-label" style={{ marginBottom: 8 }}>{t('sync.log.title')}</div>
                {logs.slice(0, 15).map(l => {
                  const label = providers.find(p => p.provider === l.provider)?.label || l.provider;
                  const skipped = l.details?.skipped_models || [];
                  let text;
                  if (l.status === 'running') text = <>{t('sync.log.running')} <ProgressBar value={progressOf(l.id, l.details)} /></>;
                  else if (l.status === 'error') text = explain(l.error_code, { provider: label }, l.error_message || t('common.error'));
                  else if (l.details?.empty) text = t('sync.codes.empty');
                  else text = t('sync.log.done', { count: l.records_synced || 0 });
                  return (
                    <div key={l.id} className="sync-log-row obs-row-grid">
                      <span className="dot" style={{ background: statusColor(l.status), width: 7, height: 7 }} />
                      <ProviderBadge provider={l.provider} />
                      <span className="kchip">{t(l.trigger === 'auto' ? 'sync.trigger.auto' : 'sync.trigger.manual')}</span>
                      <span className="sync-log-text" style={{ color: l.status === 'error' ? 'var(--error)' : 'var(--muted)' }}>
                        {text}
                        {skipped.length > 0 && <span style={{ color: 'var(--warning)' }}> · {explain('skipped_models', { models: skipped })}</span>}
                        {range(l.date_range_start, l.date_range_end) && (
                          <span className="sync-log-range">{range(l.date_range_start, l.date_range_end)}</span>
                        )}
                        {l.status === 'error' && l.error_message && l.error_code && (
                          <button type="button" className="sync-link" onClick={() => setExpanded(e => ({ ...e, [l.id]: !e[l.id] }))}>
                            {expanded[l.id] ? t('sync.log.hideDetail') : t('sync.log.showDetail')}
                          </button>
                        )}
                        {expanded[l.id] && <code className="sync-log-raw">{l.error_message}</code>}
                      </span>
                      <span className="sync-log-time">{fmtDateTime(l.started_at)}</span>
                    </div>
                  );
                })}
              </section>
            )}

            {/* ── Danger zone ────────────────────────────────────────── */}
            {isAdmin && (
              <section style={{ marginTop: 28 }}>
                <button type="button" className="sync-link" onClick={() => setDangerOpen(o => !o)}>
                  {dangerOpen ? '▾' : '▸'} {t('sync.danger.title')}
                </button>
                {dangerOpen && (
                  <div className="sync-danger">
                    <div className="sync-sub">{t('sync.danger.explain')}</div>
                    {providers.filter(p => p.data && p.syncable).map(p => (
                      <div key={p.provider} className="sync-danger-row">
                        <ProviderBadge provider={p.provider} />
                        <span className="sync-sub">{t('sync.providers.rows', { live: p.data.live_rows, imported: p.data.sync_rows })}</span>
                        <button className="obs-btn obs-btn-danger obs-btn-sm" disabled={clearing[p.provider] || p.running} onClick={() => openClear(p)}>
                          {clearing[p.provider] ? '…' : t('sync.danger.button')}
                        </button>
                      </div>
                    ))}
                    {!providers.some(p => p.data) && <div className="sync-sub">{t('sync.providers.noData')}</div>}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>

      {/* Typed confirmation for the irreversible delete (was window.confirm). */}
      {confirmClear && (
        <div className="obs-palette-overlay sync-modal-overlay" onClick={closeClear} onKeyDown={e => { if (e.key === 'Escape') closeClear(); }}>
          <div className="sync-modal" role="dialog" aria-modal="true" aria-labelledby="sync-modal-title" onClick={e => e.stopPropagation()}>
            <div id="sync-modal-title" className="sync-modal-title">{t('sync.danger.modalTitle', { provider: confirmClear.label })}</div>
            <p className="sync-sub">
              {t('sync.danger.modalBody', {
                provider: confirmClear.label,
                live: confirmClear.data?.live_rows ?? 0, imported: confirmClear.data?.sync_rows ?? 0,
              })}
            </p>
            <label htmlFor="sync-confirm-input" className="sync-sub">{t('sync.danger.typeToConfirm', { name: confirmClear.label })}</label>
            <input
              id="sync-confirm-input" className="obs-input" autoFocus autoComplete="off"
              value={confirmText} placeholder={confirmClear.label}
              onChange={e => setConfirmText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && confirmMatches) handleClear(confirmClear); }}
            />
            <div className="sync-modal-actions">
              <button type="button" className="obs-btn" onClick={closeClear}>{t('common.cancel')}</button>
              <button type="button" className="obs-btn obs-btn-danger" disabled={!confirmMatches} onClick={() => handleClear(confirmClear)}>
                {t('sync.danger.button')}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
