import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ProviderBadge from '../components/ProviderBadge';
import TopBar from '../components/TopBar';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../auth/AuthProvider';
import { fmtDateTime, fmtRangeShort } from '../utils/fmt';
import { customRangeError, isValidDateOnly, todayUtc } from '../utils/dateRange';

const dayOf = (iso) => (iso ? String(iso).slice(0, 10) : '');

export default function Sync({ darkMode, onToggleDarkMode }) {
  const { apiFetch } = useApi();
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const isAdmin = user?.role === 'admin';
  const [searchParams] = useSearchParams();

  // The coverage banner links here with ?start=&end= (a suggested backfill).
  // Honour it only when both are real dates; anything else falls back to "last N days".
  const qStart = searchParams.get('start') || '';
  const qEnd   = searchParams.get('end') || '';
  const prefilled = isValidDateOnly(qStart) && isValidDateOnly(qEnd);

  const [providers, setProviders] = useState([]);           // sync-capable, from GET /api/providers
  const [retentionDays, setRetentionDays] = useState(null);
  const [logs, setLogs]         = useState([]);
  const [syncing, setSyncing]   = useState({});
  const [clearing, setClearing] = useState({});
  const [mode, setMode]         = useState(prefilled ? 'range' : 'days');
  const [syncDays, setSyncDays] = useState('30');
  const [from, setFrom]         = useState(prefilled ? qStart : '');
  const [to, setTo]             = useState(prefilled ? qEnd : '');
  const [today, setToday]       = useState(todayUtc);
  const [msg, setMsg]           = useState(null);

  const fetchLogs = useCallback(async () => {
    try { const d = await (await apiFetch('/api/sync/logs')).json(); setLogs(d.logs || []); } catch {}
  }, []);

  useEffect(() => {
    fetchLogs();
    apiFetch('/api/providers').then(r => r.json())
      .then(d => setProviders((d.providers || []).filter(p => p.sync).map(p => p.id)))
      .catch(() => {});
    // retention_days is only reported by the coverage endpoint; any valid range works.
    apiFetch('/api/metrics/coverage?range=7d').then(r => r.json())
      .then(d => setRetentionDays(d.retention_days ?? null))
      .catch(() => {});
  }, []);

  // A sync runs in the background on the server; keep polling while any log is
  // still 'running' (a fixed single re-fetch left long syncs "running" forever).
  const anyRunning = logs.some(l => l.status === 'running');
  useEffect(() => {
    if (!anyRunning) return undefined;
    const id = setInterval(fetchLogs, 4000);
    return () => clearInterval(id);
  }, [anyRunning, fetchLogs]);

  const rangeError = mode === 'range' ? customRangeError(from, to, today) : null;
  const rangeReady = mode === 'days' || (Boolean(from && to) && !rangeError);

  const handleSync = async (provider) => {
    if (!rangeReady) { setMsg({ ok: false, text: t('settings.sync.invalidRange') }); return; }
    setToday(todayUtc());
    setSyncing(s => ({ ...s, [provider]: true })); setMsg(null);
    const qs = mode === 'range'
      ? `start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}`
      : `days=${encodeURIComponent(syncDays)}`;
    try {
      const res = await apiFetch(`/api/sync/${provider}?${qs}`, { method: 'POST' });
      const d = await res.json();
      if (d.success) {
        setMsg({ ok: true, warn: Boolean(d.warning), text: d.warning || `Sync started for ${provider}` });
      } else {
        setMsg({ ok: false, text: d.error || 'Sync error' });
      }
      fetchLogs();
    } catch { setMsg({ ok: false, text: 'Connection error' }); }
    finally { setSyncing(s => ({ ...s, [provider]: false })); }
  };

  const handleClear = async (provider) => {
    if (!confirm(`Delete ALL ${provider} data? This cannot be undone.`)) return;
    setClearing(s => ({ ...s, [provider]: true })); setMsg(null);
    try {
      const d = await (await apiFetch(`/api/sync/${provider}/data`, { method: 'DELETE' })).json();
      setMsg(d.success ? { ok: true, text: `${d.deleted} records deleted` } : { ok: false, text: 'Error' });
    } catch { setMsg({ ok: false, text: 'Connection error' }); }
    finally { setClearing(s => ({ ...s, [provider]: false })); }
  };

  const stateColor = (s) => s === 'success' ? 'var(--success)' : s === 'error' ? 'var(--error)' : 'var(--accent)';
  const covers = (l) => (l?.date_range_start && l?.date_range_end)
    ? fmtRangeShort(dayOf(l.date_range_start), dayOf(l.date_range_end), i18n.language)
    : null;

  return (
    <main className="obs-main obs-fade-in">
      <TopBar title={t('settings.syncTab')} darkMode={darkMode} onToggleDarkMode={onToggleDarkMode} />

      <div className="obs-content" style={{ paddingTop: 0 }}>
        {isAdmin && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '14px 0', borderBottom: '1px solid var(--border-soft)' }}>
            <div className="obs-section-label" style={{ margin: 0 }}>{t('settings.sync.rangeLabel')}</div>
            <select className="obs-select" style={{ height: 30 }} value={mode} onChange={e => setMode(e.target.value)} aria-label={t('settings.sync.rangeLabel')}>
              <option value="days">{t('settings.sync.modeDays')}</option>
              <option value="range">{t('settings.sync.modeRange')}</option>
            </select>
            {mode === 'days' ? (
              <select className="obs-select" style={{ height: 30 }} value={syncDays} onChange={e => setSyncDays(e.target.value)}>
                <option value="7">{t('settings.sync.days7')}</option>
                <option value="30">{t('settings.sync.days30')}</option>
                <option value="60">{t('settings.sync.days60')}</option>
                <option value="90">{t('settings.sync.days90')}</option>
              </select>
            ) : (
              <>
                <label style={{ fontSize: 12, color: 'var(--muted)' }} htmlFor="sync-from">{t('settings.sync.from')}</label>
                <input id="sync-from" type="date" className="obs-input" style={{ height: 30 }}
                  value={from} max={to || today} onChange={e => setFrom(e.target.value)} />
                <label style={{ fontSize: 12, color: 'var(--muted)' }} htmlFor="sync-to">{t('settings.sync.to')}</label>
                <input id="sync-to" type="date" className="obs-input" style={{ height: 30 }}
                  value={to} min={from || undefined} max={today} onChange={e => setTo(e.target.value)} />
              </>
            )}
            {rangeError && <span role="alert" style={{ fontSize: 11, color: 'var(--error)' }}>{t(rangeError)}</span>}
            {retentionDays != null && (
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('settings.sync.retentionNote', { days: retentionDays })}</span>
            )}
          </div>
        )}

        {providers.map(p => {
          const providerLogs = logs.filter(l => l.provider === p);
          const latest  = providerLogs[0];
          const success = providerLogs.find(l => l.status === 'success');
          const failedSince = latest && latest.status === 'error' && latest !== success;
          return (
            <div key={p} className="obs-row-grid" style={{
              display: 'grid',
              gridTemplateColumns: '140px 1fr auto auto',
              gap: 14, alignItems: 'center',
              padding: '16px 0',
              borderBottom: '1px solid var(--border-soft)'
            }}>
              <ProviderBadge provider={p} size="lg" />
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {success ? (
                  <>
                    {t('settings.sync.lastSuccess')}{' '}
                    <span style={{ color: 'var(--text)' }}>{fmtDateTime(success.completed_at || success.started_at)}</span>
                    {covers(success) && <> · {t('settings.sync.covers')} <span style={{ color: 'var(--text)' }}>{covers(success)}</span></>}
                  </>
                ) : t('settings.sync.neverSynced')}
                {failedSince && (
                  <div style={{ color: 'var(--error)', marginTop: 2 }}>
                    {t('settings.sync.lastAttempt')}: {fmtDateTime(latest.started_at)} — {latest.error_message || 'error'}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {isAdmin && (
                  <button className="obs-btn obs-btn-primary obs-btn-sm" disabled={syncing[p] || !rangeReady} onClick={() => handleSync(p)}>
                    {syncing[p] ? '…' : t('settings.sync.runButton')}
                  </button>
                )}
              </div>
              {isAdmin && (
                <button className="obs-btn obs-btn-danger obs-btn-sm" disabled={clearing[p]} onClick={() => handleClear(p)}>
                  {clearing[p] ? '…' : t('settings.sync.clearButton')}
                </button>
              )}
            </div>
          );
        })}

        {msg && (
          <div style={{ marginTop: 10, fontSize: 12, color: msg.ok ? (msg.warn ? 'var(--warning)' : 'var(--success)') : 'var(--error)' }}>{msg.text}</div>
        )}

        {logs.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div className="obs-section-label" style={{ marginBottom: 10 }}>{t('settings.sync.logTitle')}</div>
            {logs.slice(0, 10).map(l => (
              <div key={l.id} className="obs-row-grid" style={{
                display: 'grid', gridTemplateColumns: '14px 120px 1fr 80px 90px',
                gap: 12, alignItems: 'center', padding: '8px 0',
                fontSize: 12, borderBottom: '1px solid var(--border-soft)'
              }}>
                <span className="dot" style={{ background: stateColor(l.status), width: 7, height: 7 }} />
                <ProviderBadge provider={l.provider} />
                <span style={{ color: l.status === 'error' ? 'var(--error)' : 'var(--muted)' }}>
                  {l.error_message || (l.status === 'running' ? t('settings.sync.inProgress') : t('settings.sync.completed'))}
                  {covers(l) && <span style={{ marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 11 }}>{covers(l)}</span>}
                </span>
                <span style={{ color: 'var(--muted)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {l.records_synced > 0 ? `+${l.records_synced}` : '—'}
                </span>
                <span style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 11, textAlign: 'right' }}>
                  {fmtDateTime(l.started_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
