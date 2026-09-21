import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ProviderBadge from '../components/ProviderBadge';
import TopBar from '../components/TopBar';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../auth/AuthProvider';
import { fmtDateTime, fmtDate } from '../utils/fmt';

// ── Account tab ───────────────────────────────────────────────
function Field({ label, children, hint }) {
  return (
    <div className="obs-field" style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 5 }}>
        {label}
      </label>
      {children}
      {hint && <p style={{ fontSize: 11, color: 'var(--faint)', marginTop: 4 }}>{hint}</p>}
    </div>
  );
}

function StatusMsg({ ok, msg }) {
  if (!msg) return null;
  return (
    <p style={{
      fontSize: 12,
      color: ok ? 'var(--success)' : 'var(--error)',
      marginTop: 10,
      padding: '7px 10px',
      borderRadius: 5,
      background: ok
        ? 'color-mix(in oklab, var(--success) 10%, transparent)'
        : 'color-mix(in oklab, var(--error) 10%, transparent)',
    }}>
      {msg}
    </p>
  );
}

function ProfileSection({ user, updateUser, apiFetch }) {
  const { t } = useTranslation();
  const [email,   setEmail]   = useState(user?.email || '');
  const [orgName, setOrgName] = useState(user?.orgName || '');
  const [saving,  setSaving]  = useState(false);
  const [status,  setStatus]  = useState(null);

  const isAdmin = user?.role === 'admin';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    try {
      const body = {};
      if (email !== user.email) body.email = email;
      if (isAdmin && orgName !== user.orgName) body.org_name = orgName;

      if (!Object.keys(body).length) {
        setStatus({ ok: true, msg: t('account.noChanges') });
        return;
      }

      const res = await apiFetch('/api/auth/profile', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setStatus({ ok: false, msg: data.error }); return; }

      updateUser({ email: data.email, orgName: data.orgName });
      setEmail(data.email);
      setOrgName(data.orgName || '');
      setStatus({ ok: true, msg: t('account.profileUpdated') });
    } catch (err) {
      setStatus({ ok: false, msg: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="obs-card">
      <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 18 }}>
        {t('account.profileSection')}
      </h2>
      <form onSubmit={handleSubmit}>
        <Field label={t('account.emailLabel')} hint={t('account.emailHint')}>
          <input
            className="obs-input"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            style={{ width: '100%' }}
          />
        </Field>

        {isAdmin && (
          <Field label={t('account.orgNameLabel')} hint={t('account.orgNameHint')}>
            <input
              className="obs-input"
              type="text"
              value={orgName}
              onChange={e => setOrgName(e.target.value)}
              maxLength={100}
              style={{ width: '100%' }}
            />
          </Field>
        )}

        <StatusMsg {...(status || {})} msg={status?.msg} />

        <button
          type="submit"
          className="obs-btn obs-btn-primary obs-btn-sm"
          disabled={saving}
          style={{ marginTop: 12 }}
        >
          {saving ? t('common.saving') : t('account.saveButton')}
        </button>
      </form>
    </section>
  );
}

function PasswordSection({ apiFetch }) {
  const { t } = useTranslation();
  const [current,  setCurrent]  = useState('');
  const [next,     setNext]     = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [saving,   setSaving]   = useState(false);
  const [status,   setStatus]   = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (next !== confirm) {
      setStatus({ ok: false, msg: t('account.passwordMismatch') });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const res = await apiFetch('/api/auth/password', {
        method: 'PUT',
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      const data = await res.json();
      if (!res.ok) { setStatus({ ok: false, msg: data.error }); return; }

      setStatus({ ok: true, msg: data.message });
      setCurrent(''); setNext(''); setConfirm('');
    } catch (err) {
      setStatus({ ok: false, msg: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="obs-card">
      <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 18 }}>
        {t('account.passwordSection')}
      </h2>
      <form onSubmit={handleSubmit}>
        <Field label={t('account.currentPassword')}>
          <input
            className="obs-input"
            type="password"
            value={current}
            onChange={e => setCurrent(e.target.value)}
            required
            autoComplete="current-password"
            style={{ width: '100%' }}
          />
        </Field>
        <Field label={t('account.newPassword')} hint={t('account.passwordMinHint')}>
          <input
            className="obs-input"
            type="password"
            value={next}
            onChange={e => setNext(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            style={{ width: '100%' }}
          />
        </Field>
        <Field label={t('account.confirmPassword')}>
          <input
            className="obs-input"
            type="password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            style={{ width: '100%' }}
          />
        </Field>

        <StatusMsg {...(status || {})} msg={status?.msg} />

        <button
          type="submit"
          className="obs-btn obs-btn-primary obs-btn-sm"
          disabled={saving}
          style={{ marginTop: 12 }}
        >
          {saving ? t('account.updating') : t('account.updateButton')}
        </button>
      </form>
    </section>
  );
}

function SessionSection({ user, apiFetch, logout }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState(null);

  useEffect(() => {
    apiFetch('/api/auth/me')
      .then(r => r.json())
      .then(d => setInfo(d))
      .catch(() => {});
  }, []);

  const roleLabel = user?.role === 'admin' ? t('sidebar.roleAdmin') : t('sidebar.roleMember');

  return (
    <section className="obs-card" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: 0 }}>
          {t('account.sessionSection')}
        </h2>
        <button
          className="obs-btn obs-btn-sm"
          style={{ color: 'var(--error)', borderColor: 'color-mix(in oklab, var(--error) 30%, transparent)' }}
          onClick={logout}
        >
          {t('account.logoutButton')}
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 20 }}>
        {[
          { label: t('account.emailInfo'),    value: user?.email,            mono: true },
          { label: t('account.orgInfo'),      value: user?.orgName || '—' },
          { label: t('account.roleInfo'),     value: roleLabel },
          { label: t('account.memberSince'),  value: fmtDate(info?.createdAt) },
          { label: t('account.lastLogin'),    value: fmtDate(info?.lastLoginAt) },
        ].map(({ label, value, mono }) => (
          <div key={label}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
            <div style={{ fontSize: 13, color: 'var(--text)', fontFamily: mono ? 'var(--font-mono)' : undefined, wordBreak: 'break-all' }}>
              {value}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AccountTab() {
  const { user, updateUser, logout } = useAuth();
  const { apiFetch } = useApi();

  return (
    <>
      <SessionSection user={user} apiFetch={apiFetch} logout={logout} />

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: 20,
        alignItems: 'start',
      }}>
        <ProfileSection  user={user} updateUser={updateUser} apiFetch={apiFetch} />
        <PasswordSection apiFetch={apiFetch} />
      </div>
    </>
  );
}

// ── Alerts tab ────────────────────────────────────────────────
function AlertsTab() {
  const { apiFetch } = useApi();
  const { user } = useAuth();
  const { t } = useTranslation();
  const isAdmin = user?.role === 'admin';
  const [rules, setRules]       = useState([]);
  const [history, setHistory]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState({ provider: 'all', threshold_usd: '', discord_webhook_url: '', debounce_hours: '6' });
  const [saving, setSaving]     = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [testMsg, setTestMsg]   = useState({});

  const fetchData = async () => {
    try {
      const [r, h] = await Promise.all([
        apiFetch('/api/alerts/rules').then(r => r.json()),
        apiFetch('/api/alerts/history').then(r => r.json()),
      ]);
      setRules(r.rules || []); setHistory(h.history || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { fetchData(); }, []);

  const handleSave = async () => {
    if (!form.threshold_usd || !form.discord_webhook_url) return;
    setSaving(true);
    try {
      const d = await (await apiFetch('/api/alerts/rules', {
        method: 'POST',
        body: JSON.stringify({ ...form, threshold_usd: parseFloat(form.threshold_usd), debounce_hours: parseInt(form.debounce_hours) || 6 })
      })).json();
      if (d.success) { setShowForm(false); setForm({ provider: 'all', threshold_usd: '', discord_webhook_url: '', debounce_hours: '6' }); fetchData(); }
    } finally { setSaving(false); }
  };

  const toggleEnabled = async (rule) => {
    await apiFetch(`/api/alerts/rules/${rule.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !rule.enabled }) });
    fetchData();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this rule?')) return;
    await apiFetch(`/api/alerts/rules/${id}`, { method: 'DELETE' }); fetchData();
  };

  const handleTest = async (id) => {
    setTestingId(id); setTestMsg({});
    try {
      const d = await (await apiFetch(`/api/alerts/rules/${id}/test`, { method: 'POST' })).json();
      setTestMsg({ [id]: { ok: d.success, text: d.success ? t('settings.alerts.testSuccess') : t('settings.alerts.testError') } });
    } finally { setTestingId(null); }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 6 }}>
        {isAdmin && <button className="obs-btn obs-btn-primary obs-btn-sm" onClick={() => setShowForm(v => !v)}>{t('settings.alerts.newRule')}</button>}
      </div>

      {showForm && (
        <div style={{ padding: '14px 0', borderBottom: '1px solid var(--border-soft)', marginBottom: 4 }}>
          <div className="obs-row-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div className="obs-field">
              <label>{t('settings.alerts.providerLabel')}</label>
              <select className="obs-select" value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}>
                <option value="all">{t('settings.alerts.allProviders')}</option>
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="gemini">Gemini</option>
                <option value="grok">Grok</option>
                <option value="kimi">Kimi</option>
                <option value="deepinfra">DeepInfra</option>
              </select>
            </div>
            <div className="obs-field">
              <label>{t('settings.alerts.thresholdLabel')}</label>
              <input className="obs-input" type="number" step="0.01" min="0" placeholder="10.00"
                value={form.threshold_usd} onChange={e => setForm(f => ({ ...f, threshold_usd: e.target.value }))} />
            </div>
            <div className="obs-field">
              <label>{t('settings.alerts.debounceLabel')}</label>
              <select className="obs-select" value={form.debounce_hours} onChange={e => setForm(f => ({ ...f, debounce_hours: e.target.value }))}>
                <option value="1">1h</option><option value="2">2h</option><option value="6">6h</option>
                <option value="12">12h</option><option value="24">24h</option>
              </select>
            </div>
          </div>
          <div className="obs-field" style={{ marginTop: 10 }}>
            <label>{t('settings.alerts.webhookLabel')}</label>
            <input className="obs-input" type="url" placeholder={t('settings.alerts.webhookPlaceholder')}
              style={{ fontFamily: 'var(--font-mono)' }}
              value={form.discord_webhook_url} onChange={e => setForm(f => ({ ...f, discord_webhook_url: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button className="obs-btn obs-btn-primary obs-btn-sm" disabled={saving} onClick={handleSave}>{saving ? '…' : t('common.save')}</button>
            <button className="obs-btn obs-btn-sm" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="obs-skeleton" style={{ height: 40, borderRadius: 4 }} />
      ) : rules.length === 0 && !showForm ? (
        <div className="obs-empty">
          <div className="obs-empty-title">{t('settings.alerts.noRules')}</div>
          <div className="obs-empty-sub">{t('settings.alerts.rulesHint')}</div>
        </div>
      ) : rules.map(rule => (
        <div key={rule.id} className="obs-row-grid" style={{
          display: 'grid',
          gridTemplateColumns: '140px 140px 80px 1fr 28px 64px 64px',
          gap: 12, alignItems: 'center',
          padding: '13px 0',
          borderBottom: '1px solid var(--border-soft)',
          opacity: rule.enabled ? 1 : 0.5
        }}>
          {rule.provider === 'all'
            ? <span style={{ fontSize: 12, color: 'var(--text)' }}>{t('settings.alerts.allProviders')}</span>
            : <ProviderBadge provider={rule.provider} />
          }
          <div style={{ fontSize: 12 }}>
            <span style={{ color: 'var(--muted)' }}>Threshold </span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>${parseFloat(rule.threshold_usd).toFixed(2)}{t('settings.alerts.perDay')}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{rule.debounce_hours || 6}h {t('settings.alerts.debounceDisplay')}</div>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {rule.discord_webhook_url}
          </div>
          {isAdmin
            ? <button className={`tsw ${rule.enabled ? 'on' : ''}`} onClick={() => toggleEnabled(rule)} title={rule.enabled ? t('common.disable') : t('common.enable')} />
            : <span />
          }
          <div>
            <button className="obs-btn obs-btn-sm" disabled={testingId === rule.id} onClick={() => handleTest(rule.id)}>
              {testingId === rule.id ? '…' : t('common.test')}
            </button>
            {testMsg[rule.id] && (
              <div style={{ fontSize: 10, marginTop: 2, color: testMsg[rule.id].ok ? 'var(--success)' : 'var(--error)' }}>
                {testMsg[rule.id].text}
              </div>
            )}
          </div>
          {isAdmin && (
            <button className="obs-btn obs-btn-ghost obs-btn-sm" style={{ color: 'var(--muted)' }} onClick={() => handleDelete(rule.id)}>
              {t('common.delete')}
            </button>
          )}
        </div>
      ))}

      {history.length > 0 && (
        <details style={{ marginTop: 28 }}>
          <summary style={{
            listStyle: 'none', cursor: 'pointer',
            fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10
          }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="6 9 12 15 18 9" /></svg>
            {t('settings.alerts.recentAlerts')} ({history.length})
          </summary>
          {history.slice(0, 10).map(h => (
            <div key={h.id} className="obs-row-grid" style={{
              display: 'grid', gridTemplateColumns: '14px 70px 120px 1fr',
              gap: 12, alignItems: 'center', padding: '8px 0',
              fontSize: 12, borderBottom: '1px solid var(--border-soft)'
            }}>
              <span className="dot" style={{ background: h.success ? 'var(--success)' : 'var(--error)', width: 7, height: 7 }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>
                {fmtDateTime(h.sent_at)}
              </span>
              <ProviderBadge provider={h.provider} />
              <span style={{ color: 'var(--muted)' }}>${parseFloat(h.current_value).toFixed(4)} vs limit ${parseFloat(h.threshold_usd).toFixed(2)}</span>
            </div>
          ))}
        </details>
      )}
    </>
  );
}

// ── Webhooks tab ──────────────────────────────────────────────
function WebhooksTab() {
  const { apiFetch } = useApi();
  const { user }     = useAuth();
  const { t }        = useTranslation();
  const isAdmin = user?.role === 'admin';

  const [items,     setItems]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [showForm,  setShowForm]  = useState(false);
  const [form,      setForm]      = useState({ name: '', url: '' });
  const [saving,    setSaving]    = useState(false);
  const [newSecret, setNewSecret] = useState(null);
  const [copied,    setCopied]    = useState(false);
  const [testState, setTestState] = useState({});

  const fetchItems = async () => {
    try {
      const res = await apiFetch('/api/webhooks');
      const d = await res.json();
      setItems(d.webhooks || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { fetchItems(); }, []);

  const handleSave = async () => {
    if (!form.name.trim() || !form.url.trim()) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/webhooks', {
        method: 'POST',
        body: JSON.stringify({ name: form.name.trim(), url: form.url.trim(), events: ['metric.created'] }),
      });
      const d = await res.json();
      if (!res.ok) return;
      setNewSecret(d.secret || null);
      setShowForm(false);
      setForm({ name: '', url: '' });
      fetchItems();
    } finally { setSaving(false); }
  };

  const handleDelete = async (id, name) => {
    if (!confirm(`Delete webhook "${name}"?`)) return;
    await apiFetch(`/api/webhooks/${id}`, { method: 'DELETE' });
    fetchItems();
  };

  const handleTest = async (id) => {
    setTestState(s => ({ ...s, [id]: 'testing' }));
    try {
      const res = await apiFetch(`/api/webhooks/${id}/test`, { method: 'POST' });
      const d = await res.json();
      setTestState(s => ({ ...s, [id]: d.success ? 'ok' : 'fail' }));
      setTimeout(() => setTestState(s => { const n = { ...s }; delete n[id]; return n; }), 3000);
    } catch {
      setTestState(s => ({ ...s, [id]: 'fail' }));
      setTimeout(() => setTestState(s => { const n = { ...s }; delete n[id]; return n; }), 3000);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(newSecret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <>
      {newSecret && (
        <div style={{
          background: 'color-mix(in oklab, var(--success, #22c55e) 8%, transparent)',
          border: '1px solid color-mix(in oklab, var(--success, #22c55e) 30%, transparent)',
          borderRadius: 6, padding: '10px 14px', marginBottom: 14,
          fontSize: 12, display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{t('settings.webhooks.secretBanner')}</span>
          <code style={{ fontFamily: 'var(--font-mono)', flex: 1, wordBreak: 'break-all', fontSize: 11 }}>{newSecret}</code>
          <button className="obs-btn obs-btn-sm" onClick={handleCopy}>
            {copied ? '✓' : t('common.copy', 'Copy')}
          </button>
          <button className="obs-btn obs-btn-sm" style={{ color: 'var(--muted)' }} onClick={() => setNewSecret(null)}>✕</button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div className="obs-section-label">{t('settings.webhooks.title')}</div>
        {isAdmin && (
          <button className="obs-btn obs-btn-primary obs-btn-sm" onClick={() => setShowForm(v => !v)}>
            {t('settings.webhooks.addButton')}
          </button>
        )}
      </div>

      {showForm && (
        <div style={{ padding: '14px 0', borderBottom: '1px solid var(--border-soft)', marginBottom: 4 }}>
          <div className="obs-row-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
            <div className="obs-field">
              <label>{t('settings.webhooks.nameLabel')}</label>
              <input
                className="obs-input"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="My system"
              />
            </div>
            <div className="obs-field">
              <label>{t('settings.webhooks.urlLabel')}</label>
              <input
                className="obs-input"
                value={form.url}
                onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                placeholder="https://example.com/webhook"
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button className="obs-btn obs-btn-primary obs-btn-sm" disabled={saving} onClick={handleSave}>
              {saving ? '…' : t('common.save')}
            </button>
            <button className="obs-btn obs-btn-sm" onClick={() => { setShowForm(false); setForm({ name: '', url: '' }); }}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="obs-skeleton" style={{ height: 40, borderRadius: 4 }} />
      ) : items.length === 0 && !showForm ? (
        <div style={{ fontSize: 12, color: 'var(--muted)', padding: '12px 0' }}>
          {t('settings.webhooks.noWebhooks')}
        </div>
      ) : items.map(wh => (
        <div key={wh.id} className="obs-row-grid" style={{
          display: 'grid', gridTemplateColumns: '140px 1fr 80px auto auto',
          gap: 12, alignItems: 'center', padding: '11px 0',
          borderBottom: '1px solid var(--border-soft)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {wh.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {wh.url.length > 50 ? wh.url.slice(0, 50) + '…' : wh.url}
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {(wh.events || []).map(ev => (
              <span key={ev} className="kchip">{ev}</span>
            ))}
          </div>
          <button
            className="obs-btn obs-btn-sm"
            disabled={testState[wh.id] === 'testing'}
            onClick={() => handleTest(wh.id)}
            style={testState[wh.id] === 'ok' ? { color: 'var(--success, #22c55e)' } : testState[wh.id] === 'fail' ? { color: 'var(--error, #ef4444)' } : {}}
          >
            {testState[wh.id] === 'testing' ? '…' : testState[wh.id] === 'ok' ? '✓' : testState[wh.id] === 'fail' ? '✗' : t('settings.webhooks.testButton')}
          </button>
          {isAdmin && (
            <button className="obs-btn obs-btn-ghost obs-btn-sm" style={{ color: 'var(--muted)' }} onClick={() => handleDelete(wh.id, wh.name)}>
              {t('common.delete')}
            </button>
          )}
        </div>
      ))}
    </>
  );
}

// ── Team tab ──────────────────────────────────────────────────
function TeamTab() {
  const { apiFetch } = useApi();
  const { user }     = useAuth();
  const { t }        = useTranslation();
  const PAGE_SIZE = 20;
  const [members, setMembers]             = useState([]);
  const [membersTotal, setMembersTotal]   = useState(0);
  const [membersPage, setMembersPage]     = useState(1);
  const [invites, setInvites]             = useState([]);
  const [invitesTotal, setInvitesTotal]   = useState(0);
  const [invitesPage, setInvitesPage]     = useState(1);
  const [loading, setLoading]             = useState(true);
  const [inviteEmail, setInviteEmail]     = useState('');
  const [inviteRole, setInviteRole]       = useState('member');
  const [inviting, setInviting]           = useState(false);
  const [msg, setMsg]                     = useState(null);

  const fetchAll = async (mPage = 1, iPage = 1) => {
    try {
      const [m, i] = await Promise.all([
        apiFetch(`/api/team/members?page=${mPage}&limit=${PAGE_SIZE}`).then(r => r.json()),
        apiFetch(`/api/team/invitations?page=${iPage}&limit=${PAGE_SIZE}`).then(r => r.json()),
      ]);
      setMembers(m.members || []);
      setMembersTotal(m.total || 0);
      setMembersPage(mPage);
      setInvites(i.invitations || []);
      setInvitesTotal(i.total || 0);
      setInvitesPage(iPage);
    } finally { setLoading(false); }
  };
  useEffect(() => { fetchAll(); }, []);

  const handleMembersPage = (page) => {
    apiFetch(`/api/team/members?page=${page}&limit=${PAGE_SIZE}`)
      .then(r => r.json())
      .then(d => { setMembers(d.members || []); setMembersTotal(d.total || 0); setMembersPage(page); })
      .catch(() => {});
  };

  const handleInvitesPage = (page) => {
    apiFetch(`/api/team/invitations?page=${page}&limit=${PAGE_SIZE}`)
      .then(r => r.json())
      .then(d => { setInvites(d.invitations || []); setInvitesTotal(d.total || 0); setInvitesPage(page); })
      .catch(() => {});
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true); setMsg(null);
    try {
      const res = await apiFetch('/api/team/invite', {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const d = await res.json();
      if (res.ok) { setMsg({ ok: true, text: 'Invitation sent' }); setInviteEmail(''); fetchAll(1, 1); }
      else         { setMsg({ ok: false, text: d.error || 'Error sending invitation' }); }
    } finally { setInviting(false); }
  };

  const handleRemove = async (userId, email) => {
    if (!confirm(`Remove ${email} from the organization?`)) return;
    await apiFetch(`/api/team/members/${userId}`, { method: 'DELETE' });
    fetchAll(1, 1);
  };

  const handleCancelInvite = async (id) => {
    await apiFetch(`/api/team/invitations/${id}`, { method: 'DELETE' });
    fetchAll(1, 1);
  };

  const isAdmin = user?.role === 'admin';

  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <div className="obs-section-label" style={{ marginBottom: 4 }}>{t('settings.team.orgLabel')}</div>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>{user?.orgName || '—'}</div>
      </div>

      {isAdmin && (
        <div style={{ marginBottom: 24 }}>
          <div className="obs-section-label" style={{ marginBottom: 10 }}>{t('settings.team.inviteLabel')}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              className="obs-input"
              type="email"
              placeholder={t('settings.team.emailPlaceholder')}
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleInvite()}
              style={{ flex: 1 }}
            />
            <select className="obs-select" value={inviteRole} onChange={e => setInviteRole(e.target.value)} style={{ width: 110 }}>
              <option value="member">{t('settings.team.memberRole')}</option>
              <option value="admin">{t('settings.team.adminRole')}</option>
            </select>
            <button className="obs-btn obs-btn-primary obs-btn-sm" disabled={!inviteEmail.trim() || inviting} onClick={handleInvite}>
              {inviting ? t('settings.team.inviting') : t('settings.team.inviteButton')}
            </button>
          </div>
          {msg && <div style={{ marginTop: 6, fontSize: 12, color: msg.ok ? 'var(--success)' : 'var(--error)' }}>{msg.text}</div>}
        </div>
      )}

      <div className="obs-section-label" style={{ marginBottom: 10 }}>
        {t('settings.team.membersLabel')}{membersTotal > 0 ? ` (${membersTotal})` : ''}
      </div>
      {loading ? (
        <div className="obs-skeleton" style={{ height: 40, borderRadius: 4 }} />
      ) : members.map(m => (
        <div key={m.id} className="obs-row-grid" style={{
          display: 'grid', gridTemplateColumns: '1fr 80px 130px auto',
          gap: 12, alignItems: 'center',
          padding: '10px 0', borderBottom: '1px solid var(--border-soft)',
        }}>
          <div>
            <div style={{ fontSize: 13, color: 'var(--text)' }}>{m.email}</div>
            {m.invited_by_email && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t('settings.team.invitedBy')} {m.invited_by_email}</div>}
          </div>
          <span className="kchip" style={{ textTransform: 'capitalize' }}>{m.role}</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('settings.team.joinedLabel')} {fmtDate(m.joined_at)}</span>
          {isAdmin && m.id !== user?.id && (
            <button className="obs-btn obs-btn-ghost obs-btn-sm" style={{ color: 'var(--muted)' }} onClick={() => handleRemove(m.id, m.email)}>
              {t('common.remove')}
            </button>
          )}
        </div>
      ))}
      {membersTotal > PAGE_SIZE && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
          <button className="obs-btn obs-btn-sm" disabled={membersPage <= 1} onClick={() => handleMembersPage(membersPage - 1)}>←</button>
          <span>{t('settings.team.page', { page: membersPage, pages: Math.ceil(membersTotal / PAGE_SIZE) })}</span>
          <button className="obs-btn obs-btn-sm" disabled={membersPage >= Math.ceil(membersTotal / PAGE_SIZE)} onClick={() => handleMembersPage(membersPage + 1)}>→</button>
        </div>
      )}

      {isAdmin && invitesTotal > 0 && (
        <div style={{ marginTop: 28 }}>
          <div className="obs-section-label" style={{ marginBottom: 10 }}>{t('settings.team.invitationsLabel')} ({invitesTotal})</div>
          {invites.map(inv => (
            <div key={inv.id} className="obs-row-grid" style={{
              display: 'grid', gridTemplateColumns: '1fr 80px 130px auto',
              gap: 12, alignItems: 'center',
              padding: '10px 0', borderBottom: '1px solid var(--border-soft)',
            }}>
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>{inv.email}</span>
              <span className="kchip" style={{ textTransform: 'capitalize' }}>{inv.role}</span>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('settings.team.expiresLabel')} {fmtDate(inv.expires_at)}</span>
              <button className="obs-btn obs-btn-ghost obs-btn-sm" style={{ color: 'var(--muted)' }} onClick={() => handleCancelInvite(inv.id)}>
                {t('settings.team.cancelInvite')}
              </button>
            </div>
          ))}
          {invitesTotal > PAGE_SIZE && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
              <button className="obs-btn obs-btn-sm" disabled={invitesPage <= 1} onClick={() => handleInvitesPage(invitesPage - 1)}>←</button>
              <span>{t('settings.team.page', { page: invitesPage, pages: Math.ceil(invitesTotal / PAGE_SIZE) })}</span>
              <button className="obs-btn obs-btn-sm" disabled={invitesPage >= Math.ceil(invitesTotal / PAGE_SIZE)} onClick={() => handleInvitesPage(invitesPage + 1)}>→</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────
const VALID_TABS = ['account', 'alerts', 'webhooks', 'team'];

export default function Settings({ darkMode, onToggleDarkMode }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = VALID_TABS.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'account';
  const [tab, setTab] = useState(initialTab);
  const { t } = useTranslation();

  const handleTabChange = (newTab) => {
    setTab(newTab);
    setSearchParams(newTab === 'account' ? {} : { tab: newTab }, { replace: true });
  };

  return (
    <main className="obs-main obs-fade-in">
      <TopBar title={t('settings.title')} darkMode={darkMode} onToggleDarkMode={onToggleDarkMode} />

      <div className="obs-content" style={{ paddingTop: 0 }}>
        <div className="obs-tabbar">
          <button className={`obs-tab${tab === 'account'  ? ' active' : ''}`} onClick={() => handleTabChange('account')}>{t('settings.accountTab')}</button>
          <button className={`obs-tab${tab === 'alerts'   ? ' active' : ''}`} onClick={() => handleTabChange('alerts')}>{t('settings.alertsTab')}</button>
          <button className={`obs-tab${tab === 'webhooks' ? ' active' : ''}`} onClick={() => handleTabChange('webhooks')}>{t('settings.webhooksTab')}</button>
          <button className={`obs-tab${tab === 'team'     ? ' active' : ''}`} onClick={() => handleTabChange('team')}>{t('settings.teamTab')}</button>
        </div>

        {tab === 'account'  && <AccountTab />}
        {tab === 'alerts'   && <AlertsTab />}
        {tab === 'webhooks' && <WebhooksTab />}
        {tab === 'team'     && <TeamTab />}
      </div>
    </main>
  );
}
