import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ProviderBadge from '../components/ProviderBadge';
import TopBar from '../components/TopBar';
import CoverageBanner from '../components/CoverageBanner';
import { useApi } from '../hooks/useApi';
import { useRangeFilter } from '../hooks/useRangeFilter';
import { RANGE_PRESETS, buildRangeParams, rangeLabel } from '../utils/dateRange';
import { fmtDateTime, formatCost } from '../utils/fmt';

// ── Tab intro paragraph ───────────────────────────────────────
function TabIntro({ text }) {
  return (
    <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--muted)', maxWidth: 720, margin: '0 0 14px' }}>
      {text}
    </p>
  );
}

// ── Overview dashboard ────────────────────────────────────────
function OverviewCard({ label, value, accentColor, active, onClick }) {
  return (
    <div
      className="kpi-card kpi-card-clickable"
      style={{
        '--kpi-accent': accentColor,
        ...(active ? { borderColor: accentColor, background: `color-mix(in srgb, ${accentColor} 8%, transparent)` } : {}),
      }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      <div className="kpi-label">{label}</div>
      <div className="kpi-row">
        <div className="kpi-value">{value ?? '—'}</div>
      </div>
    </div>
  );
}

function FinanceOverview({ rangeParams, rangeLabel, tab, onTabChange, configuredProviders, refreshTick }) {
  const [balances, setBalances] = useState(null);
  const [budgets, setBudgets]   = useState(null);
  const { apiFetch } = useApi();
  const { t } = useTranslation();
  const rangeQuery = new URLSearchParams(rangeParams).toString();

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch(`/api/balances?${rangeQuery}`).then(r => r.json()),
      apiFetch(`/api/budgets`).then(r => r.json()),
    ]).then(([bal, bud]) => {
      if (cancelled) return;
      setBalances(bal);
      setBudgets(bud.data || []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [rangeQuery, refreshTick, apiFetch]);

  const providers = (balances?.providers || []).filter(p => !configuredProviders.length || configuredProviders.includes(p.provider));
  const totalRemaining = providers.reduce((s, p) => s + (p.remaining || 0), 0);
  const totalSpent     = providers.reduce((s, p) => s + (p.total_spent || 0), 0);
  const budgetList = budgets || [];
  const atRisk = budgetList.filter(b =>
    parseFloat(b.limit_usd) > 0 && (parseFloat(b.current_spend || 0) / parseFloat(b.limit_usd)) >= 0.75
  ).length;
  const loading = balances === null || budgets === null;

  return (
    <div className="kpi-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)', margin: '16px 0 18px' }}>
      <OverviewCard label={t('finance.kpiRemaining')} value={loading ? null : formatCost(totalRemaining)}
        accentColor="var(--accent)" active={tab === 'balances'} onClick={() => onTabChange('balances')} />
      <OverviewCard label={t('finance.kpiSpent', { range: rangeLabel })} value={loading ? null : formatCost(totalSpent)}
        accentColor="var(--cost-color)" active={tab === 'balances'} onClick={() => onTabChange('balances')} />
      <OverviewCard label={t('finance.kpiBudgets')} value={loading ? null : String(budgetList.length)}
        accentColor="var(--tokens-color)" active={tab === 'budgets'} onClick={() => onTabChange('budgets')} />
      <OverviewCard label={t('finance.kpiAtRisk')} value={loading ? null : String(atRisk)}
        accentColor={atRisk > 0 ? 'var(--error)' : 'var(--latency-color)'} active={tab === 'budgets'} onClick={() => onTabChange('budgets')} />
    </div>
  );
}

// ── Balances tab ──────────────────────────────────────────────
function BalancesTab({ rangeParams, configuredProviders, onChanged }) {
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState({ provider: 'anthropic', amount_usd: '', note: '' });
  const [submitting, setSubmitting] = useState(false);
  const { apiFetch } = useApi();
  const { t } = useTranslation();
  const rangeQuery = new URLSearchParams(rangeParams).toString();

  // Latest-request-wins: fetchData is also called after add/delete, and a slow
  // response for a previous range must not overwrite the current one.
  const fetchSeq = useRef(0);
  const fetchData = async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/balances?${rangeQuery}`);
      const json = await res.json();
      if (seq !== fetchSeq.current) return;
      setData(json);
    } catch (err) {
      if (seq !== fetchSeq.current) return;
      console.error(err); setError(t('finance.loadError') || 'Failed to load balances');
    }
    finally { if (seq === fetchSeq.current) setLoading(false); }
  };

  useEffect(() => { fetchData(); }, [rangeQuery]);

  useEffect(() => {
    if (configuredProviders.length && !configuredProviders.includes(form.provider)) {
      setForm(f => ({ ...f, provider: configuredProviders[0] }));
    }
  }, [configuredProviders]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiFetch(`/api/balances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, amount_usd: parseFloat(form.amount_usd) }),
      });
      setForm({ provider: 'anthropic', amount_usd: '', note: '' });
      setShowForm(false);
      fetchData();
      onChanged?.();
    } catch (err) { console.error(err); }
    finally { setSubmitting(false); }
  };

  const handleDelete = async (id) => {
    await apiFetch(`/api/balances/${id}`, { method: 'DELETE' });
    fetchData();
    onChanged?.();
  };

  const providers = (data?.providers || []).filter(p => !configuredProviders.length || configuredProviders.includes(p.provider));
  const history   = data?.history   || [];

  if (loading) {
    return <div className="obs-skeleton" style={{ height: 160, borderRadius: 6 }} />;
  }

  if (error) {
    return (
      <div className="obs-empty">
        <div className="obs-empty-title">{error}</div>
      </div>
    );
  }

  return (
    <>
      <TabIntro text={t('finance.balancesIntro')} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 6 }}>
        <button className="obs-btn obs-btn-primary obs-btn-sm" onClick={() => setShowForm(s => !s)}>
          {t('finance.registerRecharge')}
        </button>
      </div>

      {/* Provider rows */}
      {providers.map((p) => {
        const pct = Math.min(100, p.pct_used || 0);
        const isWarn = pct > 75 && pct < 100;
        const isOver = pct >= 100;
        const fillCls = isOver ? 'error' : isWarn ? 'warning' : '';
        return (
          <div key={p.provider} className="obs-row-grid" style={{
            display: 'grid',
            gridTemplateColumns: '160px 160px 1fr 200px 110px',
            gap: 18, alignItems: 'center',
            padding: '18px 0',
            borderBottom: '1px solid var(--border-soft)'
          }}>
            <ProviderBadge provider={p.provider} size="lg" />
            <div>
              <div className="obs-section-label" style={{ fontSize: 10, marginBottom: 2 }}>{t('finance.remaining')}</div>
              <div style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em', color: 'var(--text)' }}>
                {formatCost(p.remaining)}
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {t('finance.consumed')}{' '}
              <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{formatCost(p.total_spent)}</span>
              {' '}{t('common.of')}{' '}
              <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{formatCost(p.total_loaded)}</span>
            </div>
            <div className="iprog-bar">
              <div className={`iprog-fill ${fillCls}`} style={{ width: `${pct}%` }} />
            </div>
            <button className="obs-btn" style={{ justifySelf: 'end' }} onClick={() => setShowForm(true)}>
              {t('finance.addFunds')}
            </button>
          </div>
        );
      })}

      {providers.length === 0 && (
        <div className="obs-empty">
          <div className="obs-empty-title">{t('finance.noBalances')}</div>
          <div className="obs-empty-sub">{t('finance.registerRechargeHint')}</div>
        </div>
      )}

      {/* Add funds form */}
      {showForm && (
        <div style={{ padding: '14px 0', borderBottom: '1px solid var(--border-soft)' }}>
          <form onSubmit={handleSubmit} className="obs-form-row" style={{ flexWrap: 'wrap' }}>
            <div className="obs-field">
              <label>{t('finance.providerLabel')}</label>
              <select className="obs-select" value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}>
                {(configuredProviders.length ? configuredProviders : ['anthropic', 'openai']).map(p => (
                  <option key={p} value={p}>{p === 'anthropic' ? 'Anthropic' : p === 'openai' ? 'OpenAI' : p}</option>
                ))}
              </select>
            </div>
            <div className="obs-field">
              <label>{t('finance.amountLabel')}</label>
              <input className="obs-input" type="number" step="0.01" min="0.01" required placeholder="100.00"
                value={form.amount_usd} onChange={e => setForm(f => ({ ...f, amount_usd: e.target.value }))} />
            </div>
            <div className="obs-field" style={{ flex: 1 }}>
              <label>{t('finance.noteLabel')}</label>
              <input className="obs-input" type="text" placeholder={t('finance.notePlaceholder')}
                value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
            </div>
            <button type="button" className="obs-btn" style={{ alignSelf: 'flex-end' }} onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
            <button type="submit" className="obs-btn obs-btn-primary" disabled={submitting} style={{ alignSelf: 'flex-end' }}>
              {submitting ? t('common.saving') : t('common.save')}
            </button>
          </form>
        </div>
      )}

      {/* Recharge history */}
      {history.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <div className="obs-section-label" style={{ marginBottom: 10 }}>{t('finance.rechargeHistory')}</div>
          <table className="obs-table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>{t('finance.dateColumn')}</th>
                <th>{t('finance.providerLabel')}</th>
                <th className="col-num">{t('finance.amountColumn')}</th>
                <th>{t('finance.noteColumn')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.id} style={{ cursor: 'default' }}>
                  <td className="col-muted col-mono">{fmtDateTime(h.recharged_at)}</td>
                  <td><ProviderBadge provider={h.provider} /></td>
                  <td className="col-num">{formatCost(h.amount_usd)}</td>
                  <td className="col-muted">{h.note || '—'}</td>
                  <td className="col-num">
                    <button className="obs-btn obs-btn-ghost obs-btn-sm" style={{ color: 'var(--muted)' }} onClick={() => handleDelete(h.id)}>
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ── Budgets tab ───────────────────────────────────────────────
function BudgetsTab({ onChanged }) {
  const [budgets, setBudgets]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState({ name: '', limit_usd: '', period: 'monthly' });
  const [submitting, setSubmitting] = useState(false);
  const { apiFetch } = useApi();
  const { t } = useTranslation();

  const fetchBudgets = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/budgets`);
      const d = await res.json();
      setBudgets(d.data || []);
    } catch (err) { console.error(err); setError(t('finance.loadError') || 'Failed to load budgets'); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchBudgets(); }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiFetch(`/api/budgets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, limit_usd: parseFloat(form.limit_usd) }),
      });
      setForm({ name: '', limit_usd: '', period: 'monthly' });
      setShowForm(false);
      fetchBudgets();
      onChanged?.();
    } catch (err) { console.error(err); }
    finally { setSubmitting(false); }
  };

  const handleDelete = async (id) => {
    await apiFetch(`/api/budgets/${id}`, { method: 'DELETE' });
    fetchBudgets();
    onChanged?.();
  };

  if (loading) {
    return <div className="obs-skeleton" style={{ height: 160, borderRadius: 6 }} />;
  }

  if (error) {
    return (
      <div className="obs-empty">
        <div className="obs-empty-title">{error}</div>
      </div>
    );
  }

  return (
    <>
      <TabIntro text={t('finance.budgetsIntro')} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 6 }}>
        <button className="obs-btn obs-btn-primary obs-btn-sm" onClick={() => setShowForm(s => !s)}>
          {t('finance.newBudget')}
        </button>
      </div>

      {/* New budget form */}
      {showForm && (
        <div style={{ padding: '14px 0', borderBottom: '1px solid var(--border-soft)' }}>
          <form onSubmit={handleSubmit} className="obs-form-row" style={{ flexWrap: 'wrap' }}>
            <div className="obs-field" style={{ flex: '2 1 200px' }}>
              <label>{t('finance.nameLabel')}</label>
              <input className="obs-input" required placeholder="e.g. Monthly production"
                value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="obs-field">
              <label>{t('finance.periodLabel')}</label>
              <select className="obs-select" value={form.period} onChange={e => setForm(f => ({ ...f, period: e.target.value }))}>
                <option value="daily">{t('finance.daily')}</option>
                <option value="weekly">{t('finance.weekly')}</option>
                <option value="monthly">{t('finance.monthly')}</option>
              </select>
            </div>
            <div className="obs-field">
              <label>{t('finance.limitLabel')}</label>
              <input className="obs-input" type="number" step="0.01" min="0.01" required placeholder="100.00"
                value={form.limit_usd} onChange={e => setForm(f => ({ ...f, limit_usd: e.target.value }))} />
            </div>
            <button type="button" className="obs-btn" style={{ alignSelf: 'flex-end' }} onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
            <button type="submit" className="obs-btn obs-btn-primary" disabled={submitting} style={{ alignSelf: 'flex-end' }}>
              {submitting ? t('common.saving') : t('common.save')}
            </button>
          </form>
        </div>
      )}

      {budgets.length === 0 && !showForm ? (
        <div className="obs-empty">
          <div className="obs-empty-title">{t('finance.noBudgets')}</div>
          <div className="obs-empty-sub">{t('finance.budgetHint')}</div>
        </div>
      ) : budgets.map(b => {
        const pct = Math.min(100, (parseFloat(b.current_spend || 0) / parseFloat(b.limit_usd)) * 100);
        const isOver  = pct >= 100;
        const isWarn  = pct >= 75 && pct < 100;
        const fillCls = isOver ? 'error' : isWarn ? 'warning' : '';
        return (
          <div key={b.id} className="obs-row-grid" style={{
            display: 'grid',
            gridTemplateColumns: '2fr 80px 120px 120px 1fr 80px',
            gap: 16, alignItems: 'center',
            padding: '14px 0',
            borderBottom: '1px solid var(--border-soft)'
          }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{b.name}</div>
            <span className="period-badge" style={{ justifySelf: 'start', textTransform: 'capitalize' }}>{b.period}</span>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {t('finance.limitDisplay')}{' '}
              <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{formatCost(b.limit_usd)}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {t('finance.spentDisplay')}{' '}
              <span style={{ color: isOver ? 'var(--error)' : 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                {formatCost(b.current_spend)}
              </span>
            </div>
            <div className="iprog-bar">
              <div className={`iprog-fill ${fillCls}`} style={{ width: `${pct}%` }} />
            </div>
            <button className="obs-btn obs-btn-ghost obs-btn-sm" style={{ color: 'var(--muted)', justifySelf: 'end' }} onClick={() => handleDelete(b.id)}>
              {t('common.delete')}
            </button>
          </div>
        );
      })}
    </>
  );
}

const RANGES = RANGE_PRESETS;

// ── Page ──────────────────────────────────────────────────────
export default function Finance({ darkMode, onToggleDarkMode }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get('tab') === 'budgets' ? 'budgets' : 'balances');
  const { range, setRange, customRange, setCustomRange } = useRangeFilter('7d');
  const [configuredProviders, setConfiguredProviders] = useState([]);
  // Balance tracking (GET/POST /api/balances) only supports anthropic/openai —
  // no admin-key concept exists for gemini/grok/kimi — so the "add balance"
  // dropdown must never offer them even if the org has a credential for them.
  const balanceProviders = configuredProviders.filter(p => ['anthropic', 'openai'].includes(p));
  const [refreshTick, setRefreshTick] = useState(0);
  const bumpRefresh = () => setRefreshTick(n => n + 1);
  const { apiFetch } = useApi();
  const { t, i18n } = useTranslation();
  const rangeParams = buildRangeParams(range, customRange);
  const rangeLabelText = rangeLabel(range, customRange, t, i18n.language);

  const handleTabChange = (newTab) => {
    setTab(newTab);
    setSearchParams(newTab === 'budgets' ? { tab: 'budgets' } : {}, { replace: true });
  };

  useEffect(() => {
    apiFetch('/api/credentials')
      .then(r => r.json())
      .then(d => {
        const credList = d.credentials || d.data || [];
        setConfiguredProviders([...new Set(credList.map(c => c.provider))]);
      })
      .catch(() => {});
  }, []);

  return (
    <main className="obs-main obs-fade-in">
      <TopBar
        title={t('finance.title')}
        ranges={RANGES}
        range={range}
        onRangeChange={setRange}
        customRange={customRange}
        onCustomRangeApply={setCustomRange}
        darkMode={darkMode}
        onToggleDarkMode={onToggleDarkMode}
      />

      <CoverageBanner rangeParams={rangeParams} />

      <div className="obs-content" style={{ paddingTop: 0 }}>
        <FinanceOverview
          rangeParams={rangeParams}
          rangeLabel={rangeLabelText}
          tab={tab}
          onTabChange={handleTabChange}
          configuredProviders={configuredProviders}
          refreshTick={refreshTick}
        />

        <div className="obs-tabbar">
          <button className={`obs-tab${tab === 'balances' ? ' active' : ''}`} onClick={() => handleTabChange('balances')}>
            {t('finance.balancesTab')}
          </button>
          <button className={`obs-tab${tab === 'budgets' ? ' active' : ''}`} onClick={() => handleTabChange('budgets')}>
            {t('finance.budgetsTab')}
          </button>
        </div>

        {tab === 'balances' && <BalancesTab rangeParams={rangeParams} configuredProviders={balanceProviders} onChanged={bumpRefresh} />}
        {tab === 'budgets'  && <BudgetsTab onChanged={bumpRefresh} />}
      </div>
    </main>
  );
}
