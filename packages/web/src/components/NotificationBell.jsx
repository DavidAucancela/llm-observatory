import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useApi } from '../hooks/useApi';
import { fmtRelative, formatCost } from '../utils/fmt';
import { SEVERITY_COLOR, severityLabel, titleAndDetail } from '../utils/insightFormat';
import Sparkline from './Sparkline';

function IconBell() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function TypeIcon({ type, insightType }) {
  if (type === 'team_joined') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    );
  }
  if (type === 'sync_failing' || type === 'sync_unpriced') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    );
  }
  if (type === 'reconciliation') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18.36 6.64a9 9 0 1 1-12.73 0" /><line x1="12" y1="2" x2="12" y2="12" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 9v4" /><circle cx="12" cy="12" r="9" /><path d="M12 16h.01" />
    </svg>
  );
}

function notifSeverityColor(n) {
  if (n.type === 'team_joined') return 'var(--success)';
  if (n.type === 'reconciliation') return n.data.status === 'error' ? 'var(--error)' : 'var(--warning)';
  if (n.type === 'insight') return SEVERITY_COLOR[n.data.severity];
  if (n.type === 'sync_failing') return 'var(--error)';
  return 'var(--warning)'; // budget_alert
}

function messageFor(t, n) {
  switch (n.type) {
    case 'budget_alert': {
      const provider = n.data.provider === 'all' ? t('notifications.allProviders') : n.data.provider;
      const base = t('notifications.budgetAlertMsg', {
        provider, current: formatCost(n.data.currentValue), threshold: formatCost(n.data.thresholdUsd),
      });
      return { text: n.data.success ? base : `${base} ${t('notifications.deliveryFailed')}` };
    }
    case 'reconciliation':
      return { text: t('notifications.reconciliationMsg', { provider: n.data.provider, pct: n.data.deviationPct.toFixed(1) }) };
    case 'team_joined':
      return { text: t('notifications.teamJoinedMsg', { email: n.data.email }) };
    case 'sync_failing': {
      const key = n.data.errorCode === 'provider_auth' ? 'notifications.syncFailingAuth' : 'notifications.syncFailingMsg';
      const base = t(key, { provider: n.data.providerLabel, failures: n.data.failures });
      return { text: n.data.discord === false ? `${base} ${t('notifications.deliveryFailed')}` : base };
    }
    case 'sync_unpriced':
      return { text: t('notifications.syncUnpricedMsg', { provider: n.data.providerLabel, models: (n.data.models || []).join(', ') }) };
    case 'insight':
      return titleAndDetail(t, { type: n.insight_type, model: n.data.model, metrics: n.data.metrics });
    default:
      return { text: '' };
  }
}

function navigateTargetFor(n) {
  switch (n.type) {
    case 'budget_alert':   return '/settings?tab=alerts';
    case 'team_joined':    return '/settings?tab=team';
    case 'reconciliation': return '/dashboard';
    case 'sync_failing':   return '/sync';
    case 'sync_unpriced':  return '/sync';
    case 'insight':
      if (n.insight_type === 'improvement') return '/models';
      { const p = new URLSearchParams({ model: n.data.model });
        if (n.insight_type === 'error_rate') p.set('status', 'error');
        return `/activity?${p}`; }
    default: return null;
  }
}

function getSeenInsights() {
  try {
    return new Set(JSON.parse(sessionStorage.getItem('obs_seen_insights') || '[]'));
  } catch {
    return new Set();
  }
}

function computeClientUnreadCount(serverUnreadCount, notifications) {
  const seen = getSeenInsights();
  const unseenInsights = notifications.filter(n => n.type === 'insight' && !seen.has(n.data.insight_key)).length;
  return serverUnreadCount + unseenInsights;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [serverUnreadCount, setServerUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [mutingId, setMutingId] = useState(null);
  const ref = useRef(null);
  const { apiFetch } = useApi();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const fetchNotifications = () => {
    apiFetch('/api/notifications')
      .then(r => r.json())
      .then(d => {
        setNotifications(d.notifications || []);
        setServerUnreadCount(d.unread_count || 0);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => { fetchNotifications(); }, []);

  useEffect(() => {
    if (!open) return;
    fetchNotifications();
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const handleMarkAllRead = async () => {
    const insightKeys = notifications
      .filter(n => n.type === 'insight')
      .map(n => n.data.insight_key);
    sessionStorage.setItem('obs_seen_insights', JSON.stringify(insightKeys));
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setServerUnreadCount(0);
    try { await apiFetch('/api/notifications/read-all', { method: 'POST' }); } catch {}
  };

  const handleMuteInsight = async (e, n) => {
    e.stopPropagation();
    setMutingId(n.id);
    try {
      await apiFetch('/api/insights/dismiss', {
        method: 'POST',
        body: JSON.stringify({ insight_key: n.data.insight_key, hours: 24 }),
      });
      setNotifications(prev => prev.filter(notif => notif.id !== n.id));
    } catch {
      console.error('Failed to mute insight');
    } finally {
      setMutingId(null);
    }
  };

  const handleRowClick = (n) => {
    const target = navigateTargetFor(n);
    if (target) {
      setOpen(false);
      navigate(target);
    }
  };

  const unreadCount = computeClientUnreadCount(serverUnreadCount, notifications);

  return (
    <div className="obs-notif-bell-wrap" ref={ref}>
      <button
        type="button"
        className="obs-notif-bell"
        onClick={() => setOpen(o => !o)}
        aria-label={t('notifications.title')}
        title={t('notifications.title')}
      >
        <IconBell />
        {unreadCount > 0 && <span className="obs-notif-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
      </button>

      {open && (
        <div className="obs-notif-panel">
          <div className="obs-notif-panel-head">
            <span>{t('notifications.title')}</span>
            {unreadCount > 0 && (
              <button type="button" className="obs-notif-markread" onClick={handleMarkAllRead}>
                {t('notifications.markAllRead')}
              </button>
            )}
          </div>

          <div className="obs-notif-list">
            {loading ? (
              <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="obs-skeleton" style={{ height: 40, borderRadius: 6 }} />
                <div className="obs-skeleton" style={{ height: 40, borderRadius: 6 }} />
              </div>
            ) : notifications.length === 0 ? (
              <div className="obs-notif-empty">{t('notifications.empty')}</div>
            ) : notifications.map(n => {
              const seen = getSeenInsights();
              const isRead = n.type === 'insight' ? seen.has(n.data.insight_key) : n.read;
              const msg = messageFor(t, n);
              return (
                <div
                  key={n.id}
                  className={`obs-notif-item${isRead ? ' read' : ''}`}
                  onClick={() => handleRowClick(n)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleRowClick(n); }}
                >
                  <span className="obs-notif-icon" style={{ color: notifSeverityColor(n) }}>
                    <TypeIcon type={n.type} insightType={n.insight_type} />
                  </span>
                  <div className="obs-notif-body">
                    <div className="obs-notif-text">{msg.title || msg.text}</div>
                    {msg.detail && <div className="obs-notif-detail">{msg.detail}</div>}
                    {n.data?.spark?.length > 1 && (
                      <div style={{ height: 18, marginTop: 6, marginBottom: 4 }}>
                        <Sparkline data={n.data.spark} color={notifSeverityColor(n)} height={18} />
                      </div>
                    )}
                    <div className="obs-notif-time">{fmtRelative(n.occurred_at, t)}</div>
                  </div>
                  {n.type === 'insight' && (
                    <button
                      type="button"
                      className="obs-notif-mute-btn"
                      onClick={(e) => handleMuteInsight(e, n)}
                      disabled={mutingId === n.id}
                      title={t('notifications.muteInsight')}
                      aria-label={t('notifications.muteInsight')}
                    >
                      {mutingId === n.id ? '…' : '✕'}
                    </button>
                  )}
                  {!isRead && <span className="obs-notif-dot" />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
