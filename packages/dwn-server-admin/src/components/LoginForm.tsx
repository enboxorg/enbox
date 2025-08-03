import React, { useState, FormEvent } from 'react';
import type { LoginFormProps } from '../types.js';

export const LoginForm: React.FC<LoginFormProps & { defaultServerUrl: string }> = ({ onLogin, defaultServerUrl }) => {
  const [secret, setSecret] = useState('');
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const success = await onLogin(secret, serverUrl);
      if (!success) {
        setError('Invalid admin secret');
      }
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <h1 className="text-2xl font-bold mb-6 text-center">DWN Server Admin</h1>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="serverUrl" className="block text-sm font-medium text-gray-700 mb-1">
              Server URL
            </label>
            <input
              type="url"
              id="serverUrl"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="http://localhost:3000"
              required
            />
          </div>

          <div>
            <label htmlFor="secret" className="block text-sm font-medium text-gray-700 mb-1">
              Admin Secret
            </label>
            <input
              type="password"
              id="secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter admin secret"
              required
            />
          </div>

          {error && (
            <div className="text-red-600 text-sm">{error}</div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Logging in...' : 'Login'}
          </button>
        </form>

        <div className="mt-4 text-sm text-gray-600 text-center">
          Set the DWN_ADMIN_API_SECRET environment variable on your server
        </div>
      </div>
    </div>
  );
};