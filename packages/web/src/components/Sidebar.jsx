import React from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/* ── Nav icons ── */
function IconDashboard() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  );
}

function IconActivity() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

function IconModels() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 21 7 21 17 12 22 3 17 3 7 12 2" />
      <polyline points="3 7 12 12 21 7" />
      <line x1="12" y1="12" x2="12" y2="22" />
    </svg>
  );
}

function IconKey() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.6 12.4 20 3l2 2-1.5 1.5L22 8l-2.5 2.5-2-2-2.6 2.6" />
    </svg>
  );
}

function IconSync() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M20.49 9A9 9 0 0 0 5.6 5.6L1 10m22 4-4.6 4.4A9 9 0 0 1 3.51 15" />
    </svg>
  );
}

function IconFinance() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconChevronLeft() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function IconChevronRight() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// Requests/Models/Keys/Sync used to be tabs inside single pages (Activity,
// Settings); they're now their own top-level items with their own routes.
// Account/language/logout live in the top bar's account menu now (see
// TopBar.jsx), not in the sidebar.
const navDefs = [
  { to: '/dashboard', labelKey: 'nav.dashboard', descKey: 'nav.dashboard_desc', Icon: IconDashboard },
  { to: '/activity',  labelKey: 'nav.requests', descKey: 'nav.requests_desc', Icon: IconActivity },
  { to: '/models',    labelKey: 'nav.models',   descKey: 'nav.models_desc',   Icon: IconModels   },
  { to: '/finance',   labelKey: 'nav.finance',  descKey: 'nav.finance_desc',  Icon: IconFinance  },
  { to: '/keys',      labelKey: 'nav.keys',     descKey: 'nav.keys_desc',     Icon: IconKey      },
  { to: '/sync',      labelKey: 'nav.sync',     descKey: 'nav.sync_desc',     Icon: IconSync     },
  { to: '/security',  labelKey: 'nav.security', descKey: 'nav.security_desc', Icon: IconShield   },
  { to: '/settings',  labelKey: 'nav.settings', descKey: 'nav.settings_desc', Icon: IconSettings },
];

export default function Sidebar({ isOpen, onClose, collapsed, onToggleCollapse, darkMode }) {
  const { t } = useTranslation();
  const logoSrc = darkMode ? '/logo-dark.png' : '/logo-light.png';

  return (
    <aside className={`obs-sidebar${isOpen ? ' open' : ''}${collapsed ? ' collapsed' : ''}`}>
      {/* Brand — decorative only now; Dashboard is its own nav item below */}
      <div className="obs-brand">
        <span className="obs-brand-link">
          <img src={logoSrc} alt="Observatory" className="obs-brand-logo" />
          <span className="obs-brand-text">Observatory</span>
        </span>
        <button
          className="obs-sidebar-toggle"
          onClick={onToggleCollapse}
          title={collapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')}
        >
          {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
        </button>
      </div>

      {/* Nav */}
      <nav className="obs-nav">
        {navDefs.map(({ to, labelKey, descKey, Icon }) => {
          const label = t(labelKey);
          return (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `obs-nav-item${isActive ? ' active' : ''}`}
              onClick={onClose}
              title={collapsed ? label : undefined}
            >
              <span className="obs-nav-icon"><Icon /></span>
              <span className="obs-nav-body">
                <span className="obs-nav-label">{label}</span>
                <span className="obs-nav-desc">{t(descKey)}</span>
              </span>
            </NavLink>
          );
        })}
      </nav>

      <div className="obs-nav-spacer" />
    </aside>
  );
}
