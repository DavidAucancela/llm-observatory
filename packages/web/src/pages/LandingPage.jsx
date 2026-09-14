import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import './LandingPage.css';

/* ── Icon helper ── */
const IC = ({ d, size = 18, stroke = 'currentColor', fill = 'none', sw = 1.8 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
    {typeof d === 'string' ? <path d={d} /> : d}
  </svg>
);

const GitHubIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
  </svg>
);

/* ══════════════════════════════════════════════════════
   1. NAVBAR
══════════════════════════════════════════════════════ */
function Nav({ onDashboard }) {
  const { t, i18n } = useTranslation();
  const toggleLang = () => {
    const next = i18n.language === 'en' ? 'es' : 'en';
    i18n.changeLanguage(next);
    localStorage.setItem('lang', next);
  };
  return (
    <nav className="lp-nav">
      <a className="lp-nav-brand" href="#">
        <img src="/logo-dark.png" alt="Observatory" style={{ width: 26, height: 26, borderRadius: 6, objectFit: 'cover' }} />
        Observatory
      </a>
      <div className="lp-nav-links">
        <a className="lp-nav-link" href="#features">{t('landing.navFeatures')}</a>
        <a className="lp-nav-link" href="#architecture">{t('landing.navArchitecture')}</a>
        <a className="lp-nav-link" href="#how-it-works">{t('landing.navHowItWorks')}</a>
        <a className="lp-nav-link lp-nav-link-gh" href="https://github.com/DavidAucancela/llm-observatory" target="_blank" rel="noreferrer">
          <GitHubIcon /> GitHub
        </a>
        <button className="lp-nav-lang" onClick={toggleLang} title={t('sidebar.language')}>
          {i18n.language === 'en' ? '🇪🇸 ES' : '🇬🇧 EN'}
        </button>
        <button className="lp-nav-cta" onClick={onDashboard}>{t('landing.navDashboard')}</button>
      </div>
    </nav>
  );
}

/* ══════════════════════════════════════════════════════
   2. DASHBOARD MOCKUP (hero visual)
══════════════════════════════════════════════════════ */
const CHART_A = '0,58 32,42 64,50 96,28 128,44 160,32 192,20 224,36 256,24 288,38 320,16';
const CHART_O = '0,68 32,64 64,58 96,54 128,61 160,52 192,56 224,49 256,54 288,46 320,50';
const SPARK_PATHS = {
  requests: '0,10 10,9 20,9.5 30,7 40,8 50,5 60,6 70,2',
  tokens:   '0,9 10,10 20,8 30,9 40,7 50,8 60,4 70,3',
  cost:     '0,4 10,5 20,6 30,4 40,7 50,6 60,8 70,9',
  latency:  '0,8 10,6 20,7 30,5 40,6 50,4 60,3 70,2',
};

function DashboardMockup() {
  const { t } = useTranslation();
  return (
    <div className="lp-mockup-outer">
      <div className="lp-mockup-glow" />
      <div className="lp-hero-mockup">
        <div className="lp-mockup-window">
          {/* Topbar */}
          <div className="lp-mockup-topbar">
            <span className="lp-dot-r" /><span className="lp-dot-y" /><span className="lp-dot-g" />
            <span className="lp-mockup-topbar-title">Observatory — Dashboard</span>
          </div>

          {/* Range bar */}
          <div className="lp-mockup-rangebar">
            <span className="lp-mockup-rangebar-title">{t('landing.mockOverview')}</span>
            <div className="lp-mockup-ranges">
              {['24h', '7d', '30d'].map(r => (
                <span key={r} className={`lp-mockup-range${r === '7d' ? ' active' : ''}`}>{r}</span>
              ))}
            </div>
            <span className="lp-mockup-live"><span className="lp-mockup-live-dot" />{t('landing.mockLive')}</span>
          </div>

          {/* KPI strip */}
          <div className="lp-mockup-kpi-strip">
            {[
              { label: t('landing.kpiRequests'), val: '12.4K',  color: '#E2EAF4', spark: SPARK_PATHS.requests },
              { label: t('landing.kpiTokens'),   val: '1.84M',  color: '#06B6D4', spark: SPARK_PATHS.tokens },
              { label: t('landing.kpiCost'),      val: '$4.21',  color: '#7C3AED', spark: SPARK_PATHS.cost },
              { label: t('landing.kpiLatency'),   val: '312ms',  color: '#F59E0B', spark: SPARK_PATHS.latency },
              { label: t('landing.kpiErrorRate'),  val: '0.2%',   color: '#DC2626', spark: null },
            ].map(k => (
              <div key={k.label} className="lp-mockup-kpi" style={{ borderTopColor: k.color }}>
                <div className="lp-mockup-kpi-label">{k.label}</div>
                <div className="lp-mockup-kpi-val" style={{ color: k.color }}>{k.val}</div>
                {k.spark && (
                  <svg viewBox="0 0 70 12" preserveAspectRatio="none" className="lp-mockup-kpi-spark">
                    <polyline points={k.spark} fill="none" stroke={k.color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
            ))}
          </div>

          {/* Body: chart + breakdown */}
          <div className="lp-mockup-body">
            <div className="lp-mockup-chart">
              <div className="lp-mockup-chart-title">{t('landing.mockTokensOverTime')}</div>
              <svg viewBox="0 0 320 72" preserveAspectRatio="none" className="lp-mockup-svg">
                <defs>
                  <linearGradient id="lgA" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#D97706" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="#D97706" stopOpacity="0" />
                  </linearGradient>
                  <linearGradient id="lgO" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#059669" stopOpacity="0.2" />
                    <stop offset="100%" stopColor="#059669" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <polygon points={`${CHART_A} 320,72 0,72`} fill="url(#lgA)" />
                <polygon points={`${CHART_O} 320,72 0,72`} fill="url(#lgO)" />
                <polyline points={CHART_A} fill="none" stroke="#D97706" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                <polyline points={CHART_O} fill="none" stroke="#059669" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <div className="lp-mockup-legend">
                <span><span className="lp-mockup-dot" style={{ background: '#D97706' }} />Anthropic</span>
                <span><span className="lp-mockup-dot" style={{ background: '#059669' }} />OpenAI</span>
              </div>
            </div>
            <div className="lp-mockup-breakdown">
              <div className="lp-mockup-breakdown-title">{t('landing.mockByProvider')}</div>
              {[
                { name: 'Anthropic', pct: 95, color: '#D97706' },
                { name: 'OpenAI',    pct: 5,  color: '#059669' },
              ].map(m => (
                <div key={m.name} className="lp-mockup-row">
                  <div className="lp-mockup-row-name">{m.name}</div>
                  <div className="lp-mockup-row-track">
                    <div className="lp-mockup-row-fill" style={{ width: `${m.pct}%`, background: m.color }} />
                  </div>
                  <div className="lp-mockup-row-pct">{m.pct}%</div>
                </div>
              ))}
              <div className="lp-mockup-breakdown-title lp-mockup-breakdown-title-2">{t('landing.mockTopModels')}</div>
              {[
                { name: 'claude-sonnet-4-6',       pct: 72, color: '#D97706' },
                { name: 'claude-haiku-4-5-20251001', pct: 23, color: '#D97706' },
                { name: 'whisper-1',               pct: 5,  color: '#059669' },
              ].map(m => (
                <div key={m.name} className="lp-mockup-row">
                  <div className="lp-mockup-row-name">{m.name}</div>
                  <div className="lp-mockup-row-track">
                    <div className="lp-mockup-row-fill" style={{ width: `${m.pct}%`, background: m.color }} />
                  </div>
                  <div className="lp-mockup-row-pct">{m.pct}%</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   3. PROVIDER STRIP
══════════════════════════════════════════════════════ */
function Providers() {
  const { t } = useTranslation();
  return (
    <div className="lp-providers">
      <span className="lp-prov-label">{t('landing.worksWith')}</span>
      <div className="lp-prov-item">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="#d97706" strokeWidth="1.5" />
          <path d="M8 12h8M12 8l4 4-4 4" stroke="#d97706" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span style={{ color: '#d97706' }}>Anthropic</span>
      </div>
      <div className="lp-prov-item">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="#10b981" strokeWidth="1.5" />
          <path d="M9 12l2 2 4-4" stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ color: '#10b981' }}>OpenAI</span>
      </div>
      <div className="lp-prov-item lp-prov-item-soon">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
        </svg>
        {t('landing.moreSoon')}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   5. PROBLEM → SOLUTION
══════════════════════════════════════════════════════ */
function ProblemSolution() {
  const { t } = useTranslation();
  const vsBad  = [t('landing.vsBad0'),  t('landing.vsBad1'),  t('landing.vsBad2'),  t('landing.vsBad3'),  t('landing.vsBad4')];
  const vsGood = [t('landing.vsGood0'), t('landing.vsGood1'), t('landing.vsGood2'), t('landing.vsGood3'), t('landing.vsGood4')];
  return (
    <section className="lp-section" id="why">
      <div className="lp-section-tag">{t('landing.whyTag')}</div>
      <h2 className="lp-section-title">{t('landing.whyTitle')}</h2>
      <p className="lp-section-sub">{t('landing.whySub')}</p>
      <div className="lp-vs-grid">
        <div className="lp-vs-col lp-vs-col-bad">
          <div className="lp-vs-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            {t('landing.withoutTitle')}
          </div>
          {vsBad.map(item => (
            <div key={item} className="lp-vs-item">
              <span className="lp-vs-icon lp-vs-icon-bad">✗</span>
              {item}
            </div>
          ))}
        </div>
        <div className="lp-vs-col lp-vs-col-good">
          <div className="lp-vs-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {t('landing.withTitle')}
          </div>
          {vsGood.map(item => (
            <div key={item} className="lp-vs-item">
              <span className="lp-vs-icon lp-vs-icon-good">✓</span>
              {item}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════════════
   6. FEATURES WITH TABS
══════════════════════════════════════════════════════ */

function TabVisualMonitoring() {
  const { t } = useTranslation();
  return (
    <div className="lp-tab-visual">
      <div className="lp-tab-visual-label">{t('landing.recentRequests')}</div>
      {[
        { p: 'A', model: 'claude-sonnet-4-6', tok: '2.4K', cost: '$0.012', ok: true  },
        { p: 'O', model: 'gpt-4o',            tok: '1.1K', cost: '$0.005', ok: true  },
        { p: 'A', model: 'claude-haiku-4-5',  tok: '890',  cost: '$0.001', ok: true  },
        { p: 'A', model: 'claude-sonnet-4-6', tok: '3.2K', cost: '$0.016', ok: false },
      ].map((r, i) => (
        <div key={i} className="lp-tab-vrow">
          <span className="lp-tab-pbadge" style={{
            background: r.p === 'A' ? 'rgba(217,119,6,0.15)' : 'rgba(16,185,129,0.15)',
            color: r.p === 'A' ? '#d97706' : '#10b981',
          }}>
            {r.p === 'A' ? 'Anthropic' : 'OpenAI'}
          </span>
          <span className="lp-tab-model">{r.model}</span>
          <span className="lp-tab-num">{r.tok}</span>
          <span className="lp-tab-num">{r.cost}</span>
          <span style={{ color: r.ok ? '#10b981' : '#ef4444', fontSize: 9 }}>●</span>
        </div>
      ))}
    </div>
  );
}

function TabVisualBudgets() {
  const { t } = useTranslation();
  const rows = [
    { labelKey: 'finance.daily',   spent: 12.4,  limit: 20,  color: '#f59e0b' },
    { labelKey: 'finance.weekly',  spent: 82.1,  limit: 100, color: '#ef4444' },
    { labelKey: 'finance.monthly', spent: 142.8, limit: 500, color: '#10b981' },
  ];
  return (
    <div className="lp-tab-visual">
      <div className="lp-tab-visual-label">{t('landing.budgetLimits')}</div>
      {rows.map(b => (
        <div key={b.labelKey} className="lp-tab-budget">
          <div className="lp-tab-budget-hdr">
            <span>{t(b.labelKey)}</span>
            <span className="lp-tab-mono">${b.spent.toFixed(2)} / ${b.limit}</span>
          </div>
          <div className="lp-tab-bar-track">
            <div className="lp-tab-bar-fill" style={{ width: `${(b.spent / b.limit) * 100}%`, background: b.color }} />
          </div>
        </div>
      ))}
      <div className="lp-tab-projection">
        <span>{t('landing.projectedMonthly')}</span>
        <span className="lp-tab-mono" style={{ color: '#a855f7' }}>$248.60</span>
      </div>
    </div>
  );
}

function TabVisualTeam() {
  const { t } = useTranslation();
  const members = [
    { initials: 'DA', name: 'David A.',  email: 'david@corp.io', roleKey: 'settings.team.adminRole',  color: '#6366f1' },
    { initials: 'MR', name: 'Maria R.',  email: 'maria@corp.io', roleKey: 'settings.team.memberRole', color: '#10b981' },
    { initials: 'JL', name: 'Juan L.',   email: 'juan@corp.io',  roleKey: 'settings.team.memberRole', color: '#f59e0b' },
  ];
  return (
    <div className="lp-tab-visual">
      <div className="lp-tab-visual-label">{t('landing.teamMembers')}</div>
      {members.map(m => (
        <div key={m.email} className="lp-tab-member">
          <div className="lp-tab-avatar" style={{ background: m.color }}>{m.initials}</div>
          <div className="lp-tab-member-info">
            <div className="lp-tab-member-name">{m.name}</div>
            <div className="lp-tab-member-email">{m.email}</div>
          </div>
          <span className="lp-tab-role" style={{ color: m.roleKey.includes('admin') ? '#818cf8' : '#555' }}>{t(m.roleKey)}</span>
        </div>
      ))}
      <div className="lp-tab-token">
        <span className="lp-tab-mono" style={{ color: '#6366f1', fontSize: 10 }}>obs_sk_abc123…</span>
        <span style={{ fontSize: 10, color: '#555' }}>{t('landing.sdkToken')}</span>
      </div>
    </div>
  );
}

const TAB_VISUALS = { monitoring: TabVisualMonitoring, budgets: TabVisualBudgets, team: TabVisualTeam };

function FeaturesWithTabs() {
  const [active, setActive] = useState(0);
  const { t } = useTranslation();
  const TABS = [
    {
      label:   t('landing.tab0Label'),
      title:   t('landing.tab0Title'),
      desc:    t('landing.tab0Desc'),
      bullets: [t('landing.tab0Bullet0'), t('landing.tab0Bullet1'), t('landing.tab0Bullet2')],
      visual:  'monitoring',
    },
    {
      label:   t('landing.tab1Label'),
      title:   t('landing.tab1Title'),
      desc:    t('landing.tab1Desc'),
      bullets: [t('landing.tab1Bullet0'), t('landing.tab1Bullet1'), t('landing.tab1Bullet2')],
      visual:  'budgets',
    },
    {
      label:   t('landing.tab2Label'),
      title:   t('landing.tab2Title'),
      desc:    t('landing.tab2Desc'),
      bullets: [t('landing.tab2Bullet0'), t('landing.tab2Bullet1'), t('landing.tab2Bullet2')],
      visual:  'team',
    },
  ];
  const tab = TABS[active];
  const Visual = TAB_VISUALS[tab.visual];
  return (
    <section id="features" className="lp-section">
      <div className="lp-section-tag">{t('landing.featuresTag')}</div>
      <h2 className="lp-section-title">{t('landing.featuresTitle')}</h2>
      <p className="lp-section-sub">{t('landing.featuresSub')}</p>
      <div className="lp-tabs-bar">
        {TABS.map((tabItem, i) => (
          <button key={tabItem.label} className={`lp-tab-btn${active === i ? ' active' : ''}`} onClick={() => setActive(i)}>
            {tabItem.label}
          </button>
        ))}
      </div>
      <div className="lp-tab-content">
        <div className="lp-tab-desc">
          <h3 className="lp-tab-desc-title">{tab.title}</h3>
          <p className="lp-tab-desc-text">{tab.desc}</p>
          <ul className="lp-tab-bullets">
            {tab.bullets.map(b => (
              <li key={b}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {b}
              </li>
            ))}
          </ul>
        </div>
        <Visual />
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════════════
   7. ARCHITECTURE DIAGRAM
══════════════════════════════════════════════════════ */
function ArchNode({ label, sub, primary, accent }) {
  return (
    <div className={['lp-arch-node', primary && 'lp-arch-node-primary', accent && 'lp-arch-node-accent'].filter(Boolean).join(' ')}>
      <div className="lp-arch-node-label">{label}</div>
      {sub && <div className="lp-arch-node-sub">{sub}</div>}
    </div>
  );
}

function Arrow({ dashed }) {
  return (
    <div className={`lp-arch-arrow${dashed ? ' lp-arch-arrow-dashed' : ''}`}>
      <div className="lp-arch-arrow-line" />
      <span className="lp-arch-arrow-tip">›</span>
    </div>
  );
}

function ArchDiagram() {
  const { t } = useTranslation();
  return (
    <section id="architecture" className="lp-section" style={{ paddingTop: 0 }}>
      <div className="lp-section-tag">{t('landing.archTag')}</div>
      <h2 className="lp-section-title">{t('landing.archTitle')}</h2>
      <p className="lp-section-sub">{t('landing.archSub')}</p>
      <div className="lp-arch-wrap">
        <div className="lp-arch-row">
          <div className="lp-arch-row-tag lp-arch-row-tag-sync">{t('landing.syncAwaited')}</div>
          <div className="lp-arch-nodes">
            <ArchNode label="Your App" sub="Node.js" />
            <Arrow />
            <ArchNode label="MonitoredAnthropic" sub="SDK wrapper" primary />
            <Arrow />
            <ArchNode label="Claude / OpenAI" sub="Provider API" />
          </div>
        </div>
        <div className="lp-arch-row lp-arch-row-async">
          <div className="lp-arch-row-tag lp-arch-row-tag-async">{t('landing.asyncFire')}</div>
          <div className="lp-arch-nodes">
            <ArchNode label="MonitoredAnthropic" sub="SDK wrapper" primary />
            <Arrow dashed />
            <ArchNode label="Observatory API" sub="Express + pg" accent />
            <Arrow dashed />
            <ArchNode label="PostgreSQL" sub="metrics store" />
            <Arrow dashed />
            <ArchNode label="Socket.io" sub="real-time" />
            <Arrow dashed />
            <ArchNode label="Dashboard" sub="React + WS" primary />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════════════
   8. HOW IT WORKS
══════════════════════════════════════════════════════ */
function HowItWorks() {
  const { t } = useTranslation();
  const STEPS = [
    {
      title: t('landing.step0Title'),
      desc:  t('landing.step0Desc'),
      code:  'demo@llm-observatory.com',
      img:   '/screenshots/login.png',
    },
    {
      title: t('landing.step1Title'),
      desc:  t('landing.step1Desc'),
      code:  'Settings → Keys → Add API key',
      img:   '/screenshots/config.png',
    },
    {
      title: t('landing.step2Title'),
      desc:  t('landing.step2Desc'),
      code:  'npm install @llm-observatory/sdk',
      img:   '/screenshots/request.png',
    },
  ];
  return (
    <section id="how-it-works" className="lp-section" style={{ paddingTop: 0 }}>
      <div className="lp-section-tag">{t('landing.howTag')}</div>
      <h2 className="lp-section-title">{t('landing.howTitle')}</h2>
      <p className="lp-section-sub">{t('landing.howSub')}</p>
      <div className="lp-steps-scroller">
        <div className="lp-steps">
          {STEPS.map((s, i) => (
            <div key={i} className="lp-step">
              <div className="lp-step-num">{i + 1}</div>
              <div className="lp-step-body">
                <div className="lp-step-title">{s.title}</div>
                <div className="lp-step-desc">{s.desc}</div>
                <div className="lp-code-chip">{s.code}</div>
                <img src={s.img} alt={s.title} className="lp-step-screenshot" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════════════
   9. OPEN SOURCE CALLOUT
══════════════════════════════════════════════════════ */
function OpenSourceCallout() {
  const { t } = useTranslation();
  return (
    <section className="lp-oss-callout">
      <div className="lp-section-tag" style={{ textAlign: 'center' }}>{t('landing.ossTag')}</div>
      <h2 className="lp-oss-title">{t('landing.ossTitle')}</h2>
      <p className="lp-oss-sub">{t('landing.ossSub')}</p>
      <div className="lp-oss-badges">
        {[
          { icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',               labelKey: 'landing.dataStaysYours' },
          { icon: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z',            labelKey: 'landing.selfHosted'     },
          { icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', labelKey: 'landing.mitLicense'    },
        ].map(b => (
          <div key={b.labelKey} className="lp-oss-badge">
            <IC d={b.icon} size={15} stroke="#6366f1" />
            {t(b.labelKey)}
          </div>
        ))}
      </div>
      <a className="lp-btn-secondary" href="https://github.com/DavidAucancela/llm-observatory" target="_blank" rel="noreferrer"
        style={{ display: 'inline-flex', marginTop: 28 }}>
        <GitHubIcon /> {t('landing.viewOnGitHub')}
      </a>
    </section>
  );
}

/* ══════════════════════════════════════════════════════
   10. CTA BANNER
══════════════════════════════════════════════════════ */
function CTABanner({ onDashboard }) {
  const { t } = useTranslation();
  return (
    <div className="lp-cta-banner">
      <div className="lp-cta-glow" />
      <h2>{t('landing.ctaTitle')}</h2>
      <p>{t('landing.ctaSub')}</p>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
        <button className="lp-btn-primary" onClick={onDashboard}>{t('landing.openDashboard')}</button>
        <a className="lp-btn-secondary" href="https://github.com/DavidAucancela/llm-observatory" target="_blank" rel="noreferrer">
          <GitHubIcon /> {t('landing.viewOnGitHub')}
        </a>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   11. FOOTER
══════════════════════════════════════════════════════ */
function Footer() {
  const { t } = useTranslation();
  return (
    <footer className="lp-footer">
      <div className="lp-footer-cols">
        <div className="lp-footer-col">
          <a className="lp-nav-brand" href="#" style={{ marginBottom: 10, display: 'inline-flex' }}>
            <img src="/logo-dark.png" alt="Observatory" style={{ width: 22, height: 22, borderRadius: 5, objectFit: 'cover' }} />
            LLM Observatory
          </a>
          <p className="lp-footer-tagline">{t('landing.footerTagline')}</p>
          <span className="lp-mit">MIT © 2026 LLM Observatory</span>
        </div>
        <div className="lp-footer-col">
          <div className="lp-footer-col-title">{t('landing.footerProduct')}</div>
          <a className="lp-footer-link" href="#features">{t('landing.navFeatures')}</a>
          <a className="lp-footer-link" href="#architecture">{t('landing.navArchitecture')}</a>
          <a className="lp-footer-link" href="#how-it-works">{t('landing.navHowItWorks')}</a>
          <a className="lp-footer-link" href="/login">Dashboard</a>
        </div>
        <div className="lp-footer-col">
          <div className="lp-footer-col-title">{t('landing.footerResources')}</div>
          <a className="lp-footer-link" href="https://github.com/DavidAucancela/llm-observatory" target="_blank" rel="noreferrer">GitHub</a>
          <a className="lp-footer-link" href="https://github.com/DavidAucancela/llm-observatory/blob/main/LICENSE" target="_blank" rel="noreferrer">{t('landing.mitLicense')}</a>
          <a className="lp-footer-link" href="https://github.com/DavidAucancela/llm-observatory/issues" target="_blank" rel="noreferrer">Issues</a>
          <a className="lp-footer-link" href="https://github.com/DavidAucancela/llm-observatory/blob/main/README.md" target="_blank" rel="noreferrer">{t('landing.footerDocs')}</a>
        </div>
      </div>
    </footer>
  );
}

/* ══════════════════════════════════════════════════════
   PAGE ROOT
══════════════════════════════════════════════════════ */
export default function LandingPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const onDashboard = () => navigate('/login');

  return (
    <div className="lp-root">
      <Nav onDashboard={onDashboard} />

      {/* Hero */}
      <section className="lp-hero">
        <div className="lp-hero-bg" />
        <div className="lp-hero-grid" />
        <h1>
          {t('landing.heroTitle1')}<br />
          <span className="lp-grad">{t('landing.heroTitle2')}</span>
        </h1>
        <p>{t('landing.heroSubtitle')}</p>
        <div className="lp-hero-actions">
          <button className="lp-btn-primary" onClick={onDashboard}>{t('landing.openDashboard')}</button>
          <a className="lp-btn-secondary" href="https://github.com/DavidAucancela/llm-observatory" target="_blank" rel="noreferrer">
            <GitHubIcon /> {t('landing.starOnGitHub')}
          </a>
        </div>
        <DashboardMockup />
      </section>

      <Providers />
      <ProblemSolution />
      <FeaturesWithTabs />
      <ArchDiagram />
      <HowItWorks />
      <OpenSourceCallout />
      <CTABanner onDashboard={onDashboard} />
      <Footer />
    </div>
  );
}
