import React, { useState, FormEvent } from 'react';
import type { LoginFormProps } from '../types.js';

export function LoginForm({ onLogin }: LoginFormProps): JSX.Element {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!token.trim()) {
      setError('Please enter an admin token');
      return;
    }
    onLogin(token.trim()).catch((err: Error) => {
      setError(err.message);
    });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            DWN Server Admin Dashboard
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Enter your admin token to access the dashboard
          </p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="rounded-md shadow-sm -space-y-px">
            <div>
              <label htmlFor="token" className="sr-only">Admin Token</label>
              <input
                id="token"
                name="token"
                type="password"
                autoComplete="current-password"
                required
                className="appearance-none rounded-md relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                placeholder="Admin Token (SHA256 hash of DWN_ADMIN_API_SECRET)"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          <div>
            <button
              type="submit"
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              Sign in
            </button>
          </div>
          
          <div className="text-sm text-gray-600">
            <p><strong>Note:</strong> The admin token is the SHA256 hash of your DWN_ADMIN_API_SECRET environment variable.</p>
            <p className="mt-2">If you haven't set one, the default token is:</p>
            <code className="block mt-1 p-2 bg-gray-100 rounded text-xs break-all">
              7c2b7b05359e25e3b0ecee0171d129e377ca27608c303585155511e363b10c07
            </code>
          </div>
        </form>
      </div>
    </div>
  );
}