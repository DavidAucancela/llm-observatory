import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ProviderBadge from '../components/ProviderBadge';
import TopBar from '../components/TopBar';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../auth/AuthProvider';
import { fmtDateTime, fmtDate } from '../utils/fmt';

// ── Keys ──────────────────────────────────────────────────
function KeyRow({ cred, onDeleted, onTested, isAdmin }) {
  const { apiFetch } = useApi();
  const { t } = useTranslation();
  const [testing,  setTesting]  = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [syncing,  setSyncing]  = useState(false);
  const [syncOk,   setSyncOk]   = useState(null);
  const [testErr,  setTestErr]  = useState(null);

  const handleTest = async () => {
    setTesting(true); setTestErr(null);
    try {
      const res = await apiFetch(`/api/credentials/${cred.id}/test`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) {
        setTestErr(d.error || `Error ${res.status}`);
        return;
      }
      onTested(cred.id, d.valid);
      if (!d.valid && d.error) setTestErr(d.error);
    } catch (e) { setTestErr(e.message); } finally { setTesting(false); }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete key "${cred.label}"?`)) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/credentials/${cred.id}`, { method: 'DELETE' });
      onDeleted(cred.id);
    } finally { setDeleting(false); }
  };

  const handleSync = async () => {
    setSyncing(true); setSyncOk(null);
    try {
      const res = await apiFetch(`/api/credentials/${cred.id}/ping`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) { setSyncOk(false); return; }
      setSyncOk(d.success ?? false);
      if (d.success) setTimeout(() => setSyncOk(null), 3000);
    } catch { setSyncOk(false); } finally { setSyncing(false); }
  };

  const isValid = cred.is_valid;
  const tested  = !!cred.last_tested_at;

  return (
    <div className="obs-row-grid" style={{
      display: 'grid',
      gridTemplateColumns: '1fr 110px 170px 100px auto',
      gap: 14, alignItems: 'center',
      padding: '11px 0',
      borderBottom: '1px solid var(--border-soft)'
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{cred.label}</div>
        {testErr && <span style={{ fontSize: 11, color: 'var(--error)' }}>{testErr}</span>}
      </div>
      <ProviderBadge provider={cred.provider} />
      <span className="kchip">{cred.key_hint}</span>
      <span className={`vbadge ${!tested ? '' : isValid ? 'vbadge-valid' : 'vbadge-invalid'}`}>
        <span className="dot" style={{ background: !tested ? 'var(--faint)' : isValid ? 'var(--success)' : 'var(--error)', width: 5, height: 5 }} />
        {!tested ? t('settings.keys.untested') : isValid ? t('settings.keys.valid') : t('settings.keys.invalid')}
      </span>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {cred.key_type === 'sdk' && (
          <button className="obs-btn obs-btn-sm" disabled={syncing} onClick={handleSync}>
            {syncing ? '…' : t('settings.keys.syncButton')}
          </button>
        )}
        <button className="obs-btn obs-btn-sm" disabled={testing} onClick={handleTest}>
          {testing ? '…' : t('settings.keys.testButton')}
        </button>
        {isAdmin && (
          <button className="obs-btn obs-btn-ghost obs-btn-sm" disabled={deleting} onClick={handleDelete}
            style={{ color: 'var(--muted)' }}>
            {deleting ? '…' : t('common.delete')}
          </button>
        )}
      </div>
    </div>
  );
}

// Providers with no admin/org-level key concept — sync happens only via the SDK's
// real-time metric POSTs, never a historical org usage export (see credentials.js/
// sync.js). Locking key_type to 'sdk' here matches the server: nothing stops an
// 'admin' row for these being created via a raw API call, but there's no UI/test
// path or sync route that would ever use one.
const SDK_ONLY_PROVIDERS = ['gemini', 'grok', 'kimi', 'deepinfra'];

function AddKeyForm({ onSaved, onCancel }) {
  const { apiFetch } = useApi();
  const { t } = useTranslation();
  const [form, setForm]   = useState({ provider: 'anthropic', key_type: 'sdk', label: '', value: '' });
  const [show, setShow]   = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.label.trim() || !form.value.trim()) return;
    setSaving(true); setError('');
    try {
      const res = await apiFetch('/api/credentials', { method: 'POST', body: JSON.stringify(form) });
      const d = await res.json();
      if (res.ok) { onSaved(d.data); }
      else { setError(Array.isArray(d.error) ? d.error.map(e => e.message).join(', ') : (d.error || 'Error saving')); }
    } catch { setError('Connection error'); } finally { setSaving(false); }
  };

  const phLabel = form.provider === 'anthropic' ? (form.key_type === 'admin' ? 'sk-ant-admin-…' : 'sk-ant-api03-…')
    : form.provider === 'gemini' ? 'AIza…'
    : form.provider === 'grok' ? 'xai-…'
    : form.provider === 'kimi' ? 'sk-…'
    : form.provider === 'deepinfra' ? 'DeepInfra API key'
    : (form.key_type === 'admin' ? 'sk-admin-…' : 'sk-proj-…');

  return (
    <div style={{ padding: '14px 0', borderBottom: '1px solid var(--border-soft)', marginBottom: 4 }}>
      <div className="obs-row-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr auto auto', gap: 10, alignItems: 'flex-end' }}>
        <div className="obs-field">
          <label>{t('settings.keys.labelField')}</label>
          <input className="obs-input obs-input-lg" placeholder={t('settings.keys.labelPlaceholder')} value={form.label} onChange={e => set('label', e.target.value)} />
        </div>
        <div className="obs-field">
          <label>{t('settings.keys.providerTypeField')}</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <select className="obs-select" style={{ height: 36, flex: 1 }} value={form.provider} onChange={e => {
              const provider = e.target.value;
              setForm(f => ({ ...f, provider, key_type: SDK_ONLY_PROVIDERS.includes(provider) ? 'sdk' : f.key_type }));
            }}>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
              <option value="grok">Grok</option>
              <option value="kimi">Kimi</option>
              <option value="deepinfra">DeepInfra</option>
            </select>
            <select className="obs-select" style={{ height: 36, flex: 1 }} value={form.key_type} disabled={SDK_ONLY_PROVIDERS.includes(form.provider)} onChange={e => set('key_type', e.target.value)}>
              <option value="sdk">{t('settings.keys.sdkType')}</option>
              {!SDK_ONLY_PROVIDERS.includes(form.provider) && <option value="admin">{t('settings.keys.adminType')}</option>}
            </select>
          </div>
        </div>
        <div className="obs-field" style={{ position: 'relative' }}>
          <label>{t('settings.keys.apiKeyField')}</label>
          <input
            className="obs-input obs-input-lg"
            type={show ? 'text' : 'password'}
            placeholder={phLabel}
            value={form.value}
            onChange={e => set('value', e.target.value)}
            style={{ fontFamily: 'var(--font-mono)', paddingRight: 32 }}
          />
          <button type="button" onClick={() => setShow(v => !v)}
            style={{ position: 'absolute', right: 8, bottom: 8, background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11 }}>
            {show ? t('auth.hidePassword') : t('auth.showPassword')}
          </button>
        </div>
        <button className="obs-btn" onClick={onCancel} style={{ alignSelf: 'flex-end', height: 36 }}>{t('common.cancel')}</button>
        <button className="obs-btn obs-btn-primary" disabled={saving} onClick={handleSave} style={{ alignSelf: 'flex-end', height: 36 }}>
          {saving ? '…' : t('common.save')}
        </button>
      </div>
      {error && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--error)' }}>{error}</div>}
    </div>
  );
}

// ── Observatory Tokens section ─────────────────────────────────────────
function ObservatoryTokensSection() {
  const { apiFetch } = useApi();
  const { user } = useAuth();
  const { t } = useTranslation();
  const isAdmin = user?.role === 'admin';
  const [tokens, setTokens]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName]       = useState('');
  const [saving, setSaving]   = useState(false);
  const [newToken, setNewToken] = useState(null);
  const [copiedId, setCopiedId] = useState(null);

  const fetchTokens = async () => {
    try {
      const d = await (await apiFetch('/api/tokens')).json();
      setTokens(d.tokens || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { fetchTokens(); }, []);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const d = await (await apiFetch('/api/tokens', { method: 'POST', body: JSON.stringify({ name: name.trim() }) })).json();
      if (d.success) { setNewToken(d.data); setName(''); fetchTokens(); }
    } finally { setSaving(false); }
  };

  const handleRevoke = async (id) => {
    if (!confirm('Revoke this token? SDK calls using it will stop working.')) return;
    await apiFetch(`/api/tokens/${id}`, { method: 'DELETE' });
    fetchTokens();
  };

  const copy = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div style={{ marginTop: 36 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="obs-section-label">{t('settings.keys.tokensSection')}</div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.6 }}>
        {t('settings.keys.tokensInfo')}
      </div>

      {newToken && (
        <div style={{ background: 'color-mix(in oklab, var(--success) 8%, transparent)', border: '1px solid color-mix(in oklab, var(--success) 30%, transparent)', borderRadius: 6, padding: '12px 14px', marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--success)', fontWeight: 600, marginBottom: 6 }}>{t('settings.keys.tokenCreated')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, flex: 1, wordBreak: 'break-all', color: 'var(--text)' }}>{newToken.token}</code>
            <button className="obs-btn obs-btn-sm" onClick={() => copy(newToken.token, 'new')}>
              {copiedId === 'new' ? t('common.copied') : t('common.copy')}
            </button>
          </div>
          <button style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setNewToken(null)}>
            {t('common.dismiss')}
          </button>
        </div>
      )}

      {isAdmin && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <input
            className="obs-input"
            placeholder={t('settings.keys.tokenNamePlaceholder')}
            value={name}
            onChange={e => setName(e.target.value)}
            style={{ flex: 1 }}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
          />
          <button className="obs-btn obs-btn-primary obs-btn-sm" disabled={!name.trim() || saving} onClick={handleCreate}>
            {saving ? '…' : t('settings.keys.createButton')}
          </button>
        </div>
      )}

      {loading ? (
        <div className="obs-skeleton" style={{ height: 36, borderRadius: 4 }} />
      ) : tokens.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 0' }}>{t('settings.keys.noTokens')}</div>
      ) : tokens.map(tok => (
        <div key={tok.id} className="obs-row-grid" style={{
          display: 'grid', gridTemplateColumns: '1fr 140px 110px auto',
          gap: 12, alignItems: 'center',
          padding: '10px 0', borderBottom: '1px solid var(--border-soft)',
          opacity: tok.revoked_at ? 0.45 : 1,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{tok.name}</div>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>{tok.token_prefix}…</code>
          </div>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {tok.last_used_at ? t('settings.keys.lastUsed', { date: fmtDateTime(tok.last_used_at) }) : t('settings.keys.neverUsed')}
          </span>
          <span style={{ fontSize: 11, color: tok.revoked_at ? 'var(--error)' : 'var(--muted)' }}>
            {tok.revoked_at ? t('settings.keys.revokedStatus') : t('settings.keys.createdDate', { date: fmtDate(tok.created_at) })}
          </span>
          {isAdmin && !tok.revoked_at && (
            <button className="obs-btn obs-btn-ghost obs-btn-sm" style={{ color: 'var(--muted)' }} onClick={() => handleRevoke(tok.id)}>
              {t('common.revoke')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────
export default function Keys({ darkMode, onToggleDarkMode }) {
  const { apiFetch } = useApi();
  const { user } = useAuth();
  const { t } = useTranslation();
  const isAdmin = user?.role === 'admin';
  const [credentials, setCredentials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const fetchCredentials = async () => {
    try {
      const res = await apiFetch('/api/credentials');
      const d = await res.json();
      setCredentials(d.credentials || d.data || []);
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchCredentials(); }, []);

  const handleDeleted = (id) => setCredentials(cs => cs.filter(c => c.id !== id));
  const handleTested  = (id, isValid) => setCredentials(cs => cs.map(c => c.id === id ? { ...c, is_valid: isValid, last_tested_at: new Date().toISOString() } : c));
  const handleSaved   = (cred) => { setCredentials(cs => [cred, ...cs]); setShowForm(false); };

  const sdkKeys   = credentials.filter(c => c.key_type === 'sdk');
  const adminKeys = credentials.filter(c => c.key_type === 'admin');

  return (
    <main className="obs-main obs-fade-in">
      <TopBar title={t('settings.keysTab')} darkMode={darkMode} onToggleDarkMode={onToggleDarkMode} />

      <div className="obs-content" style={{ paddingTop: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <div className="obs-section-label">{t('settings.keys.sdkTitle')}</div>
          {isAdmin && <button className="obs-btn obs-btn-primary obs-btn-sm" onClick={() => setShowForm(v => !v)}>{t('settings.keys.addButton')}</button>}
        </div>

        {showForm && <AddKeyForm onSaved={handleSaved} onCancel={() => setShowForm(false)} />}

        {loading ? (
          <div className="obs-skeleton" style={{ height: 40, borderRadius: 4 }} />
        ) : sdkKeys.length === 0 && !showForm ? (
          <div style={{ fontSize: 12, color: 'var(--muted)', padding: '12px 0' }}>{t('settings.keys.noSdk')}</div>
        ) : (
          sdkKeys.map(c => <KeyRow key={c.id} cred={c} onDeleted={handleDeleted} onTested={handleTested} isAdmin={isAdmin} />)
        )}

        <div style={{ marginTop: 28, display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <div className="obs-section-label">{t('settings.keys.adminTitle')}</div>
        </div>

        {!loading && adminKeys.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--muted)', padding: '12px 0' }}>{t('settings.keys.noAdmin')}</div>
        ) : (
          adminKeys.map(c => <KeyRow key={c.id} cred={c} onDeleted={handleDeleted} onTested={handleTested} isAdmin={isAdmin} />)
        )}

        <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          {t('settings.keys.encryption')}
        </div>

        <ObservatoryTokensSection />
      </div>
    </main>
  );
}
