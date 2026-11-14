import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ProviderBadge from '../components/ProviderBadge';
import TopBar from '../components/TopBar';
import { useApi } from '../hooks/useApi';
import { useSocket } from '../hooks/useSocket';
import { useAuth } from '../auth/AuthProvider';
import { fmtRelative } from '../utils/fmt';
import { eventTitle, eventReason, usageSummary, severityColor } from '../utils/keyWatchFormat';

// Key audit: what each provider API key actually did (as the provider reports
// it, hourly) next to what the SDK recorded — so a key used outside its
// project shows up here and in the bell within the hour. Everything comes
// from /api/key-watch/*; errors are `code` + `params` translated via
// security.codes.*.

const STATUS_CLASS = { active: 'vbadge-valid', deleted: 'vbadge-invalid', inactive: 'vbadge-invalid', archived: 'vbadge-invalid', expired: 'vbadge-invalid' };

function coverageClass(pct) {
  if (pct == null) return '';
  if (pct < 50) return 'error';
  if (pct < 90) return 'warning';
  return '';
}

export default function Security({ darkMode, onToggleDarkMode }) {
  const { apiFetch } = useApi();
  const { user } = useAuth();
  const { t } = useTranslation();
  const isAdmin = user?.role === 'admin';
  const [searchParams] = useSearchParams();
  const focusKey = searchParams.get('key');

  const [overview, setOverview] = useState(null);
  const [events, setEvents]     = useState([]);
  const [creds, setCreds]       = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [results, setResults]   = useState(null);
  const [expanded, setExpanded] = useState(focusKey || null);
  const [keyEvents, setKeyEvents] = useState({});
  const [disabling, setDisabling] = useState(null); // key row being confirmed
  const [confirmText, setConfirmText] = useState('');
  const [disableBusy, setDisableBusy] = useState(false);
  const [disableErr, setDisableErr] = useState(null);
  const focusRef = useRef(null);
  const { on, off } = useSocket();

  const explain = useCallback((code, params = {}, raw) => {
    const key = `security.codes.${code}`;
    const text = t(key, { ...params, defaultValue: '' });
    return text || raw || t('security.codes.watch_failed');
  }, [t]);

  const fetchAll = useCallback(async () => {
    try {
      const [o, e] = await Promise.all([
        apiFetch('/api/key-watch/overview').then(r => r.json()),
        apiFetch('/api/key-watch/events').then(r => r.json()),
      ]);
      setOverview(o); setEvents(e.events || []); setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [apiFetch]);

  const fetchKeyEvents = useCallback(async (keyId) => {
    try {
      const d = await apiFetch(`/api/key-watch/events?key_id=${encodeURIComponent(keyId)}&include_historical=true&include_acknowledged=true`).then(r => r.json());
      setKeyEvents(s => ({ ...s, [keyId]: d.events || [] }));
    } catch { /* the row just shows no history */ }
  }, [apiFetch]);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => {
    if (!isAdmin) return;
    apiFetch('/api/credentials').then(r => r.json()).then(d => setCreds((d.credentials || []).filter(c => c.key_type === 'sdk'))).catch(() => {});
  }, [apiFetch, isAdmin]);

  // A new finding (the hourly cron or someone's "Revisar ahora") → refetch.
  useEffect(() => {
    const onAlert = () => { fetchAll(); if (expanded) fetchKeyEvents(expanded); };
    on('key-alert', onAlert);
    return () => off('key-alert', onAlert);
  }, [on, off, fetchAll, fetchKeyEvents, expanded]);

  useEffect(() => { if (expanded) fetchKeyEvents(expanded); }, [expanded, fetchKeyEvents]);

  // ?key= (from the bell or a Discord alert) scrolls to that key once loaded.
  useEffect(() => {
    if (focusKey && overview && focusRef.current) focusRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusKey, overview]);

  const providers = overview?.providers || [];
  const keys = overview?.keys || [];
  const watched = providers.filter(p => p.has_admin_key);
  const labelOf = useCallback((id) => providers.find(p => p.provider === id)?.label || id, [providers]);

  const handleRun = async () => {
    setBusy(true); setResults(null);
    try {
      const d = await apiFetch('/api/key-watch/run', { method: 'POST' }).then(r => r.json());
      const out = (d.results || []).map(r => (r.status === 'ok'
        ? { ok: true, text: t('security.run.done', { provider: labelOf(r.provider), count: r.new_events || 0 }) }
        : { ok: false, warn: r.code === 'already_running', text: `${labelOf(r.provider)}: ${explain(r.code, { provider: labelOf(r.provider) })}` }));
      setResults(out.length ? out : [{ ok: false, warn: true, text: t('security.run.nothing') }]);
    } catch {
      setResults([{ ok: false, text: t('security.codes.connection') }]);
    } finally { setBusy(false); fetchAll(); }
  };

  const handleAck = async (ev) => {
    try {
      await apiFetch(`/api/key-watch/events/${ev.id}/ack`, { method: 'POST' });
    } finally { fetchAll(); if (expanded) fetchKeyEvents(expanded); }
  };

  const patchKey = async (k, body) => {
    try {
      const res = await apiFetch(`/api/key-watch/keys/${k.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setResults([{ ok: false, text: explain(d.code, {}, d.error) }]);
      }
    } finally { fetchAll(); }
  };

  const openDisable = (k) => { setConfirmText(''); setDisableErr(null); setDisabling(k); };
  const closeDisable = () => { if (!disableBusy) setDisabling(null); };
  const confirmName = disabling ? (disabling.name || disabling.key_id) : '';
  const confirmMatches = disabling && confirmText.trim() === confirmName;

  const handleDisable = async () => {
    if (!confirmMatches) return;
    setDisableBusy(true); setDisableErr(null);
    try {
      const res = await apiFetch(`/api/key-watch/keys/${disabling.id}/disable`, {
        method: 'POST', body: JSON.stringify({ confirm_name: confirmText.trim() }),
      });
      const d = await res.json();
      if (!res.ok) { setDisableErr(explain(d.code, { provider: labelOf(disabling.provider), ...d.params }, d.error)); return; }
      setResults([{ ok: true, text: t(d.mode === 'delete' ? 'security.disable.doneDelete' : 'security.disable.done', { name: confirmName }) }]);
      setDisabling(null);
      fetchAll(); fetchKeyEvents(disabling.key_id);
    } catch {
      setDisableErr(t('security.codes.connection'));
    } finally { setDisableBusy(false); }
  };

  const openEvents = useMemo(() => events.filter(e => e.type !== 'key_disabled'), [events]);

  function ProviderLine({ p }) {
    if (!p.has_admin_key) {
      return (
        <div className="sync-sub">
          {t('security.provider.noKey', { provider: p.label })}
          {isAdmin && <> · <Link to="/keys" className="sync-link">{t('security.provider.addKey')}</Link></>}
        </div>
      );
    }
    if (p.running) return <div className="sync-sub" style={{ color: 'var(--accent)' }}>{t('security.provider.running', { provider: p.label })}</div>;
    const r = p.last_run;
    if (!r) return <div className="sync-sub">{t('security.provider.never', { provider: p.label })}</div>;
    if (r.status === 'error') {
      return (
        <div className="sync-sub" style={{ color: 'var(--error)' }}>
          {t('security.provider.failed', { provider: p.label, when: fmtRelative(r.completed_at || r.started_at, t), reason: explain(r.error_code, { provider: p.label }) })}
        </div>
      );
    }
    return (
      <div className="sync-sub">
        {t('security.provider.ok', { provider: p.label, when: fmtRelative(r.completed_at || r.started_at, t), keys: r.details?.keys ?? 0 })}
      </div>
    );
  }

  function EventRow({ ev, compact = false }) {
    const reason = eventReason(t, ev.type, ev.details);
    const usage = ev.type === 'key_disabled' ? '' : usageSummary(t, ev.details);
    return (
      <div className="sec-event">
        <span className="dot" style={{ background: ev.type === 'key_disabled' ? 'var(--muted)' : severityColor(ev.severity), marginTop: 5 }} />
        <div className="sec-event-body">
          <div className="sec-event-title">
            {eventTitle(t, ev.type)}
            {!compact && <> · <strong>{ev.key_name || ev.key_id}</strong> <span className="sync-sub">({labelOf(ev.provider)})</span></>}
            {ev.historical && <span className="kchip" style={{ marginLeft: 6 }}>{t('security.detail.historical')}</span>}
          </div>
          {(usage || reason) && <div className="sync-sub">{[usage, reason].filter(Boolean).join(' — ')}</div>}
          <div className="sync-sub">{String(ev.day).slice(0, 10)}{ev.acknowledged_at && ev.type !== 'key_disabled' ? ` · ${t('security.findings.acked')}` : ''}</div>
        </div>
        <div className="sec-event-actions">
          {!compact && <button type="button" className="sync-link" onClick={() => setExpanded(ev.key_id)}>{t('security.findings.viewKey')}</button>}
          {isAdmin && !ev.acknowledged_at && ev.type !== 'key_disabled' && (
            <button type="button" className="obs-btn" onClick={() => handleAck(ev)}>{t('security.findings.ack')}</button>
          )}
        </div>
      </div>
    );
  }

  function KeyDetail({ k }) {
    const list = keyEvents[k.key_id];
    const providerCreds = creds.filter(c => c.provider === k.provider);
    const canDisable = isAdmin && k.status === 'active' && providers.find(p => p.provider === k.provider)?.disable_mode;
    const mode = providers.find(p => p.provider === k.provider)?.disable_mode;
    return (
      <div className="sec-detail">
        <div className="sec-detail-grid">
          <div>
            <div className="obs-section-label">{t('security.detail.usage7d')}</div>
            <div className="sync-sub">{usageSummary(t, k.usage_7d) || t('security.usage.none')}</div>
            {k.usage_7d.models?.length > 0 && (
              <ul className="sec-models">
                {k.usage_7d.models.slice(0, 6).map(m => (
                  <li key={`${m.kind}|${m.model}`}>
                    <span className="kchip">{t(`security.kinds.${m.kind}`, { defaultValue: m.kind })}</span> {m.model}
                    <span className="sync-sub"> — {usageSummary(t, m)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="obs-section-label">{t('security.detail.observatory')}</div>
            <div className="sync-sub">
              {k.link ? t(`security.link.${k.link}`) : t('security.link.none')}
              {k.linked_credential && <> · <span className="kchip">{k.linked_credential.key_hint}</span></>}
            </div>
            {isAdmin && (
              <div className="sec-controls">
                <label className="obs-field">
                  <span>{t('security.detail.linkLabel')}</span>
                  <select
                    className="obs-select" value={k.linked_credential?.id || ''}
                    onChange={e => patchKey(k, { linked_credential_id: e.target.value ? Number(e.target.value) : null })}
                  >
                    <option value="">{t('security.detail.linkNone')}</option>
                    {providerCreds.map(c => <option key={c.id} value={c.id}>{c.label || c.key_hint} ({c.key_hint})</option>)}
                  </select>
                </label>
                <label className="sec-toggle">
                  <button
                    type="button" className={`tsw${k.expected_unmonitored ? ' on' : ''}`} role="switch"
                    aria-checked={k.expected_unmonitored} aria-label={t('security.detail.expected')}
                    onClick={() => patchKey(k, { expected_unmonitored: !k.expected_unmonitored })}
                  />
                  <span className="sync-sub">{t('security.detail.expected')}</span>
                </label>
              </div>
            )}
          </div>
        </div>

        <div className="obs-section-label" style={{ marginTop: 12 }}>{t('security.detail.events')}</div>
        {!list ? <div className="sync-sub">{t('common.loading')}</div>
          : list.length === 0 ? <div className="sync-sub">{t('security.detail.noEvents')}</div>
          : list.map(ev => <EventRow key={ev.id} ev={ev} compact />)}

        {canDisable && (
          <div className="sync-danger" style={{ marginTop: 12 }}>
            <div className="sync-danger-row">
              <span className="sync-sub">{t(mode === 'delete' ? 'security.disable.hintDelete' : 'security.disable.hintDeactivate', { provider: labelOf(k.provider) })}</span>
              <button type="button" className="obs-btn obs-btn-danger" onClick={() => openDisable(k)}>
                {t(mode === 'delete' ? 'security.disable.deleteButton' : 'security.disable.button')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <main className="obs-main obs-fade-in">
      <TopBar title={t('security.title')} darkMode={darkMode} onToggleDarkMode={onToggleDarkMode} />

      <div className="obs-content sync-page">
        {loadError && <div className="sync-msg sync-msg--error">{t('security.loadError')}</div>}
        {!overview && !loadError && <div style={{ color: 'var(--muted)', fontSize: 12, padding: '16px 0' }}>{t('common.loading')}</div>}

        {overview && (
          <>
            <section className="sync-auto">
              <div>
                <div className="sync-auto-title">
                  <span className={`dot${overview.auto?.enabled && watched.length ? ' dot-pulse' : ''}`}
                        style={{ background: overview.auto?.enabled && watched.length ? 'var(--success)' : 'var(--muted)' }} />
                  {!watched.length ? t('security.auto.noProviders')
                    : overview.auto?.enabled ? t('security.auto.on') : t('security.auto.off')}
                </div>
                <div className="sync-sub" style={{ marginBottom: 4 }}>{t('security.auto.sub')}</div>
                {providers.map(p => <ProviderLine key={p.provider} p={p} />)}
              </div>
              {isAdmin && watched.length > 0 && (
                <button type="button" className="obs-btn obs-btn-primary" disabled={busy} onClick={handleRun}>
                  {busy ? t('security.run.running') : t('security.run.button')}
                </button>
              )}
            </section>

            {results && (
              <div className="sync-results">
                {results.map((r, i) => (
                  <div key={i} className={`sync-msg ${r.ok ? 'sync-msg--ok' : r.warn ? 'sync-msg--warn' : 'sync-msg--error'}`}>{r.text}</div>
                ))}
              </div>
            )}

            <section style={{ marginTop: 20 }}>
              <div className="obs-section-label">{t('security.findings.title', { count: openEvents.length })}</div>
              {openEvents.length === 0
                ? <div className="sync-sub" style={{ padding: '8px 0' }}>{t(watched.length ? 'security.findings.none' : 'security.findings.notWatching')}</div>
                : openEvents.map(ev => <EventRow key={ev.id} ev={ev} />)}
            </section>

            <section style={{ marginTop: 24 }}>
              <div className="obs-section-label">{t('security.keys.title', { count: keys.length })}</div>
              {keys.length === 0 ? (
                <div className="sync-sub" style={{ padding: '8px 0' }}>{t(watched.length ? 'security.keys.empty' : 'security.findings.notWatching')}</div>
              ) : (
                <div className="obs-table-wrap">
                  <table className="obs-table sec-table">
                    <thead>
                      <tr>
                        <th>{t('security.cols.key')}</th>
                        <th>{t('security.cols.lastUse')}</th>
                        <th>{t('security.cols.day')}</th>
                        <th>{t('security.cols.week')}</th>
                        <th>{t('security.cols.coverage')}</th>
                        <th>{t('security.cols.status')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {keys.map(k => {
                        const open = expanded === k.key_id;
                        const pct = k.coverage?.pct;
                        const lastUse = k.last_usage_hour || k.provider_last_used_at;
                        return (
                          <React.Fragment key={`${k.provider}:${k.key_id}`}>
                            <tr
                              ref={k.key_id === focusKey ? focusRef : null}
                              className={`${open ? 'is-open' : ''}${k.key_id === focusKey ? ' is-focus' : ''}`}
                              onClick={() => setExpanded(open ? null : k.key_id)}
                              aria-expanded={open}
                            >
                              <td>
                                <div className="sec-keyname">
                                  {k.open_events && <span className="dot" title={t('security.findings.openCount', { count: k.open_events.count })} style={{ background: 'var(--error)' }} />}
                                  <span>{k.name || k.key_id}</span>
                                </div>
                                <div className="sec-keymeta">
                                  <ProviderBadge provider={k.provider} />
                                  {k.redacted_hint && <span className="kchip">{k.redacted_hint}</span>}
                                  {k.project_name && <span className="sync-sub">{k.project_name}</span>}
                                </div>
                              </td>
                              <td className="col-muted">{lastUse ? fmtRelative(lastUse, t) : t('security.usage.never')}</td>
                              <td className="sec-usage">{usageSummary(t, k.usage_24h) || '—'}</td>
                              <td className="sec-usage">{usageSummary(t, k.usage_7d) || '—'}</td>
                              <td>
                                {k.expected_unmonitored ? <span className="vbadge">{t('security.link.expected')}</span>
                                  : !k.link ? <span className={`vbadge${(k.usage_7d.requests || k.usage_7d.tokens || k.usage_7d.images) ? ' vbadge-invalid' : ''}`}>{t('security.link.none')}</span>
                                  : pct == null ? '—' : (
                                    <span className="sec-coverage" title={t('security.cols.coverageHelp', { sdk: k.coverage.sdk, total: k.coverage.provider })}>
                                      <span className="iprog-bar"><span className={`iprog-fill ${coverageClass(pct)}`} style={{ width: `${pct}%` }} /></span>
                                      <span>{pct}%</span>
                                    </span>
                                  )}
                              </td>
                              <td><span className={`vbadge ${STATUS_CLASS[k.status] || ''}`}>{t(`security.status.${k.status}`, { defaultValue: k.status })}</span></td>
                            </tr>
                            {open && (
                              <tr className="sec-detail-row">
                                <td colSpan={6} onClick={e => e.stopPropagation()}><KeyDetail k={k} /></td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="sync-sub" style={{ marginTop: 8 }}>{t('security.keys.footnote')}</div>
            </section>
          </>
        )}
      </div>

      {disabling && (
        <div className="obs-palette-overlay sync-modal-overlay" onClick={closeDisable} onKeyDown={e => { if (e.key === 'Escape') closeDisable(); }}>
          <div className="sync-modal" role="dialog" aria-modal="true" aria-labelledby="sec-modal-title" onClick={e => e.stopPropagation()}>
            {(() => {
              const mode = providers.find(p => p.provider === disabling.provider)?.disable_mode;
              const provider = labelOf(disabling.provider);
              return (
                <>
                  <div id="sec-modal-title" className="sync-modal-title">
                    {t(mode === 'delete' ? 'security.disable.titleDelete' : 'security.disable.titleDeactivate', { name: confirmName, provider })}
                  </div>
                  <p className="sync-sub" style={mode === 'delete' ? { color: 'var(--error)' } : undefined}>
                    {t(mode === 'delete' ? 'security.disable.bodyDelete' : 'security.disable.bodyDeactivate', { provider })}
                  </p>
                  <label htmlFor="sec-confirm-input" className="sync-sub">{t('security.disable.typeToConfirm', { name: confirmName })}</label>
                  <input
                    id="sec-confirm-input" className="obs-input" autoFocus autoComplete="off"
                    value={confirmText} placeholder={confirmName}
                    onChange={e => setConfirmText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleDisable(); }}
                  />
                  {disableErr && <div className="sync-msg sync-msg--error">{disableErr}</div>}
                  <div className="sync-modal-actions">
                    <button type="button" className="obs-btn" onClick={closeDisable} disabled={disableBusy}>{t('common.cancel')}</button>
                    <button type="button" className="obs-btn obs-btn-danger" disabled={!confirmMatches || disableBusy} onClick={handleDisable}>
                      {disableBusy ? t('security.disable.working') : t(mode === 'delete' ? 'security.disable.deleteButton' : 'security.disable.button')}
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </main>
  );
}

