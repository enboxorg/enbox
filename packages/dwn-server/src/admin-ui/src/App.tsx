import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { AdminApiClient } from './api-client.js';
import { LoginForm } from './components/LoginForm.js';
import { Dashboard } from './components/Dashboard.js';

function App(): JSX.Element {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('adminToken'));
  const [apiClient, setApiClient] = useState<AdminApiClient | null>(null);

  const handleLogin = async (adminToken: string): Promise<void> => {
    const client = new AdminApiClient(window.location.origin, adminToken);
    
    try {
      // Test the token by making a request
      await client.getStats();
      
      // Token is valid, save it
      localStorage.setItem('adminToken', adminToken);
      setToken(adminToken);
      setApiClient(client);
    } catch (err: any) {
      throw new Error(`Login failed: ${err.message}`);
    }
  };

  const handleLogout = (): void => {
    localStorage.removeItem('adminToken');
    setToken(null);
    setApiClient(null);
  };

  useEffect(() => {
    if (token && !apiClient) {
      void handleLogin(token).catch(() => {
        // Invalid token, clear it
        handleLogout();
      });
    }
  }, [token, apiClient]);

  if (!apiClient) {
    return <LoginForm onLogin={handleLogin} />;
  }

  return (
    <>
      <Dashboard apiClient={apiClient} />
      <button
        onClick={handleLogout}
        className="fixed bottom-4 right-4 bg-gray-600 text-white py-2 px-4 rounded-md hover:bg-gray-700"
      >
        Logout
      </button>
    </>
  );
}

// Render the app
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

const root = ReactDOM.createRoot(rootElement);
root.render(<App />);