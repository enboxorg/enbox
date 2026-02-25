import { useState, useEffect } from 'preact/hooks';
import { getToken } from '../lib/api';
import { Login } from './Login';
import { Layout } from './Layout';

export function App() {
  const [authenticated, setAuthenticated] = useState(!!getToken());

  useEffect(() => {
    const handler = () => setAuthenticated(!!getToken());
    window.addEventListener('auth-change', handler);
    return () => window.removeEventListener('auth-change', handler);
  }, []);

  if (!authenticated) {
    return <Login onLogin={() => { setAuthenticated(true); }} />;
  }

  return <Layout onLogout={() => { setAuthenticated(false); }} />;
}
