import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { AdminApiClient } from './api-client.js';
import { Dashboard, LoginForm } from './components/index.js';

const App: React.FC = () => {
  const [apiClient, setApiClient] = useState<AdminApiClient | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [serverUrl, setServerUrl] = useState('http://localhost:3000');

  useEffect(() => {
    // Check if there's a saved server URL in localStorage
    const savedUrl = localStorage.getItem('dwn-admin-server-url');
    if (savedUrl) {
      setServerUrl(savedUrl);
    }

    // Initialize API client
    const client = new AdminApiClient(savedUrl || serverUrl);
    setApiClient(client);

    // Check if there's a saved token
    const savedToken = localStorage.getItem('dwn-admin-token');
    if (savedToken && savedUrl) {
      // Try to validate the saved token by making a test request
      client.getStats()
        .then(() => setIsAuthenticated(true))
        .catch(() => {
          localStorage.removeItem('dwn-admin-token');
        });
    }
  }, []);

  const handleLogin = async (secret: string, url?: string) => {
    if (url && url !== serverUrl) {
      setServerUrl(url);
      localStorage.setItem('dwn-admin-server-url', url);
      const newClient = new AdminApiClient(url);
      setApiClient(newClient);
      
      const success = await newClient.authenticate(secret);
      if (success) {
        localStorage.setItem('dwn-admin-token', 'authenticated');
        setIsAuthenticated(true);
      }
      return success;
    }

    if (!apiClient) return false;

    const success = await apiClient.authenticate(secret);
    if (success) {
      localStorage.setItem('dwn-admin-token', 'authenticated');
      setIsAuthenticated(true);
    }
    return success;
  };

  const handleLogout = () => {
    if (apiClient) {
      apiClient.clearToken();
    }
    localStorage.removeItem('dwn-admin-token');
    setIsAuthenticated(false);
  };

  if (!isAuthenticated || !apiClient) {
    return <LoginForm onLogin={handleLogin} defaultServerUrl={serverUrl} />;
  }

  return <Dashboard apiClient={apiClient} onLogout={handleLogout} />;
};

// Mount the app
const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);