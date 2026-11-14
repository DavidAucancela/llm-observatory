import React, { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import Sidebar from './components/Sidebar';
import CommandPalette from './components/CommandPalette';
import { SidebarProvider } from './contexts/SidebarContext';
import Dashboard from './pages/Dashboard';
import Activity from './pages/Activity';
import Models from './pages/Models';
import Keys from './pages/Keys';
import Sync from './pages/Sync';
import Security from './pages/Security';
import Finance from './pages/Finance';
import Settings from './pages/Settings';
import LandingPage    from './pages/LandingPage';
import Login          from './pages/Login';
import Register       from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword  from './pages/ResetPassword';
import AcceptInvite   from './pages/AcceptInvite';

function ProtectedRoute({ children }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="theme-light obs-login-root">
        <div className="dot dot-pulse" style={{ background: 'var(--accent)', width: 10, height: 10 }} />
      </div>
    );
  }
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

// Root: landing if not logged in, redirect to /dashboard if logged in
function RootRoute() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return null;
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
  return <LandingPage />;
}

function AppShell() {
  const [darkMode, setDarkMode] = useState(
    () => localStorage.getItem('dark-mode') !== 'false'
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('sidebar-collapsed') === 'true'
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const toggleDarkMode = (value) => {
    localStorage.setItem('dark-mode', String(value));
    setDarkMode(value);
  };

  const toggleSidebarCollapse = () => {
    setSidebarCollapsed(v => {
      localStorage.setItem('sidebar-collapsed', String(!v));
      return !v;
    });
  };


  return (
    <div className={darkMode ? 'theme-dark' : 'theme-light'} style={{ width: '100%', height: '100%' }}>
      <CommandPalette />
      {/* No standalone mobile header/branding bar — the hamburger that opens
          the sidebar on small screens lives inside each page's own TopBar
          (title + range + icons), via SidebarProvider, so mobile shows a
          single header instead of two stacked bars. */}
      <SidebarProvider openSidebar={() => setSidebarOpen(true)}>
        <div className="obs-root">
          {/* Overlay for mobile sidebar */}
          {sidebarOpen && (
            <div className="obs-sidebar-overlay" onClick={() => setSidebarOpen(false)} />
          )}
          <Sidebar
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            collapsed={sidebarCollapsed}
            onToggleCollapse={toggleSidebarCollapse}
            darkMode={darkMode}
          />
          <Routes>
            <Route path="/dashboard" element={<Dashboard darkMode={darkMode} onToggleDarkMode={toggleDarkMode} />} />
            <Route path="/activity"  element={<Activity darkMode={darkMode} onToggleDarkMode={toggleDarkMode} />} />
            <Route path="/models"    element={<Models darkMode={darkMode} onToggleDarkMode={toggleDarkMode} />} />
            <Route path="/keys"      element={<Keys darkMode={darkMode} onToggleDarkMode={toggleDarkMode} />} />
            <Route path="/sync"      element={<Sync darkMode={darkMode} onToggleDarkMode={toggleDarkMode} />} />
            <Route path="/security"  element={<Security darkMode={darkMode} onToggleDarkMode={toggleDarkMode} />} />
            <Route path="/finance"   element={<Finance darkMode={darkMode} onToggleDarkMode={toggleDarkMode} />} />
            <Route path="/settings"  element={<Settings darkMode={darkMode} onToggleDarkMode={toggleDarkMode} />} />
            {/* Legacy redirects */}
            <Route path="/"          element={<Navigate to="/dashboard" replace />} />
            <Route path="/requests"  element={<Navigate to="/activity" replace />} />
            <Route path="/account"   element={<Navigate to="/settings?tab=account" replace />} />
            <Route path="/providers" element={<Navigate to="/finance" replace />} />
            <Route path="/budgets"   element={<Navigate to="/finance?tab=budgets" replace />} />
          </Routes>
        </div>
      </SidebarProvider>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/"                element={<RootRoute />} />
      <Route path="/login"           element={<Login />} />
      <Route path="/register"        element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password"  element={<ResetPassword  />} />
      <Route path="/accept-invite"   element={<AcceptInvite />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
