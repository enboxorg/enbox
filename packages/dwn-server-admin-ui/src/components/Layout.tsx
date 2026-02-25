import { useState, useEffect } from 'preact/hooks';
import Router from 'preact-router';
import { clearToken } from '../lib/api';
import { Overview } from '../views/Overview';
import { Tenants } from '../views/Tenants';
import { Connections } from '../views/Connections';
import { Events } from '../views/Events';
import { Configuration } from '../views/Configuration';
import { Passkeys } from '../views/Passkeys';
import { AuditLog } from '../views/AuditLog';

type LayoutProps = {
  onLogout: () => void;
};

type NavItem = {
  path  : string;
  label : string;
};

const navItems: NavItem[] = [
  { path: '/admin/',            label: 'Overview' },
  { path: '/admin/tenants',     label: 'Tenants' },
  { path: '/admin/connections', label: 'Connections' },
  { path: '/admin/events',      label: 'Events' },
  { path: '/admin/config',      label: 'Configuration' },
  { path: '/admin/passkeys',   label: 'Passkeys' },
  { path: '/admin/audit',       label: 'Audit Log' },
];

export function Layout({ onLogout }: LayoutProps) {
  const [currentUrl, setCurrentUrl] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setCurrentUrl(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const handleRouteChange = (e: { url: string }) => {
    setCurrentUrl(e.url);
  };

  const handleLogout = () => {
    clearToken();
    window.dispatchEvent(new CustomEvent('auth-change'));
    onLogout();
  };

  const isActive = (path: string): boolean => {
    if (path === '/admin/') {
      return currentUrl === '/admin/' || currentUrl === '/admin';
    }
    return currentUrl.startsWith(path);
  };

  return (
    <div class="app-layout">
      <aside class="sidebar">
        <div class="sidebar-header">
          <h1>DWN Admin</h1>
          <div class="subtitle">Server Dashboard</div>
        </div>
        <nav class="sidebar-nav">
          {navItems.map((item) => (
            <a
              key={item.path}
              href={item.path}
              class={isActive(item.path) ? 'active' : ''}
            >
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <div class="sidebar-footer">
          <button onClick={handleLogout}>Sign Out</button>
        </div>
      </aside>
      <main class="main-content">
        <Router onChange={handleRouteChange}>
          <Overview path="/admin/" />
          <Tenants path="/admin/tenants/:did?" />
          <Connections path="/admin/connections" />
          <Events path="/admin/events" />
          <Configuration path="/admin/config" />
          <Passkeys path="/admin/passkeys" />
          <AuditLog path="/admin/audit" />
        </Router>
      </main>
    </div>
  );
}
