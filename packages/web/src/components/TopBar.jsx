import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';
import NotificationBell from './NotificationBell';
import { useSidebar } from '../contexts/SidebarContext';
import { fmtRangeShort } from '../utils/fmt';
import { RANGE_LABEL_I18N_KEYS, todayUtc, customRangeError } from '../utils/dateRange';

function IconHamburger() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function IconGlobe() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function IconUser() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function IconAccount() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function IconLogout() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function IconSun() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" />
      <line x1="4.22" y1="4.22" x2="7.05" y2="7.05" /><line x1="16.95" y1="16.95" x2="19.78" y2="19.78" />
      <line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" />
      <line x1="4.22" y1="19.78" x2="7.05" y2="16.95" /><line x1="16.95" y1="7.05" x2="19.78" y2="4.22" />
    </svg>
  );
}

function IconMoon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

// Account dropdown — mirrors the sidebar's user-menu pattern (same
// obs-user-menu-item classes) so both dropdowns look and behave identically.
// Language toggle lives here too (not as its own header icon) — one fewer
// button competing for space in the header, especially on mobile.
function AccountMenu({ darkMode, onToggleDarkMode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const toggleLanguage = () => {
    const next = i18n.language === 'en' ? 'es' : 'en';
    i18n.changeLanguage(next);
    localStorage.setItem('lang', next);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const isAdmin = user?.role === 'admin';
  const roleLabel = isAdmin ? t('sidebar.roleAdmin') : t('sidebar.roleMember');

  return (
    <div className="obs-account-wrap" ref={ref}>
      <button
        type="button"
        className="obs-topbar-btn"
        onClick={() => setOpen(o => !o)}
        aria-label={t('sidebar.myAccount')}
        title={user?.email}
      >
        <IconUser />
      </button>

      {open && (
        <div className="obs-account-panel">
          {user && (
            <div className="obs-account-panel-head">
              {user.orgName && <div className="obs-user-org">{user.orgName}</div>}
              <div className="obs-user-email">{user.email}</div>
              <span className={`obs-role-badge${isAdmin ? ' role-admin' : ''}`}>{roleLabel}</span>
            </div>
          )}
          <div className="obs-user-menu-sep" />
          <button className="obs-user-menu-item" onClick={() => { setOpen(false); navigate('/settings?tab=account'); }}>
            <IconAccount />
            <span>{t('sidebar.myAccount')}</span>
          </button>
          <button className="obs-user-menu-item" onClick={() => { onToggleDarkMode(!darkMode); setOpen(false); }}>
            {darkMode ? <IconSun /> : <IconMoon />}
            <span>{darkMode ? t('sidebar.switchToLight') : t('sidebar.switchToDark')}</span>
          </button>
          <button className="obs-user-menu-item" onClick={toggleLanguage}>
            <IconGlobe />
            <span>{t('sidebar.language')} · {i18n.language === 'en' ? 'Español' : 'English'}</span>
          </button>
          <div className="obs-user-menu-sep" />
          <button className="obs-user-menu-item obs-user-menu-item--danger" onClick={() => { setOpen(false); logout(); }}>
            <IconLogout />
            <span>{t('sidebar.signOut')}</span>
          </button>
        </div>
      )}
    </div>
  );
}

// Unified top bar rendered by every page: section title, optional date range
// filter, notifications and account (language now lives inside the account
// menu, see AccountMenu) — replaces the old mix of a per-page header plus
// globally fixed theme toggle / notification bell.
export default function TopBar({
  title, ranges, range, onRangeChange,
  customRange, onCustomRangeApply,
  darkMode, onToggleDarkMode,
}) {
  const { openSidebar } = useSidebar();
  const { t, i18n } = useTranslation();
  const [customOpen, setCustomOpen] = useState(false);
  const [draftStart, setDraftStart] = useState('');
  const [draftEnd, setDraftEnd] = useState('');
  // UTC "today", refreshed every time the panel opens (a module-level constant
  // would go stale in a tab left open past midnight).
  const [today, setToday] = useState(todayUtc);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!customOpen) return;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setCustomOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [customOpen]);

  const openCustomPanel = () => {
    // Seed the draft from whatever custom range is already active (or blank
    // for a first-time pick) every time the panel opens, not just on mount.
    setDraftStart(customRange?.start || '');
    setDraftEnd(customRange?.end || '');
    setToday(todayUtc());
    setCustomOpen(o => !o);
  };

  // Typed input can bypass the inputs' min/max, so validate the values themselves.
  const draftError = customRangeError(draftStart, draftEnd, today);
  const canApply = Boolean(draftStart && draftEnd) && !draftError;
  const customLabel = range === 'custom' && customRange?.start && customRange?.end
    ? fmtRangeShort(customRange.start, customRange.end, i18n.language)
    : t('topbar.rangeCustom');

  return (
    <div className="obs-header">
      <button
        type="button"
        className="obs-topbar-hamburger"
        onClick={openSidebar}
        aria-label="Open menu"
      >
        <IconHamburger />
      </button>
      <div className="obs-page-title">{title}</div>

      {ranges && (
        <>
          <div className="obs-divider-v" />
          <div className="obs-range-wrap" ref={wrapRef}>
            <div className="obs-range-picker">
              {ranges.map(r => (
                <button
                  key={r}
                  className={`obs-range-btn${range === r ? ' active' : ''}`}
                  onClick={() => { setCustomOpen(false); onRangeChange(r); }}
                >{t(RANGE_LABEL_I18N_KEYS[r] || r)}</button>
              ))}
              {onCustomRangeApply && (
                <button
                  type="button"
                  className={`obs-range-btn${range === 'custom' ? ' active' : ''}`}
                  onClick={openCustomPanel}
                >{customLabel}</button>
              )}
            </div>

            {customOpen && (
              <div className="obs-range-custom-panel">
                <div className="obs-field">
                  <label htmlFor="range-from">{t('topbar.rangeFrom')}</label>
                  <input
                    id="range-from" type="date" className="obs-input"
                    value={draftStart} max={draftEnd || today}
                    onChange={e => setDraftStart(e.target.value)}
                  />
                </div>
                <div className="obs-field">
                  <label htmlFor="range-to">{t('topbar.rangeTo')}</label>
                  <input
                    id="range-to" type="date" className="obs-input"
                    value={draftEnd} min={draftStart || undefined} max={today}
                    onChange={e => setDraftEnd(e.target.value)}
                  />
                </div>
                <div style={{ fontSize: 11, color: draftError ? 'var(--danger, #e5484d)' : 'var(--text-muted, inherit)', opacity: draftError ? 1 : 0.7 }} role={draftError ? 'alert' : undefined}>
                  {draftError ? t(draftError) : t('topbar.rangeUtcHint')}
                </div>
                <button
                  type="button"
                  className="obs-btn obs-btn-primary"
                  disabled={!canApply}
                  onClick={() => { onCustomRangeApply({ start: draftStart, end: draftEnd }); setCustomOpen(false); }}
                >{t('topbar.rangeApply')}</button>
              </div>
            )}
          </div>
        </>
      )}

      <div className="obs-header-right">
        <NotificationBell />
        <AccountMenu darkMode={darkMode} onToggleDarkMode={onToggleDarkMode} />
      </div>
    </div>
  );
}
