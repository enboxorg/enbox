import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api, setToken } from '../lib/api';

type LoginProps = {
  onLogin: () => void;
};

export function Login({ onLogin }: LoginProps) {
  const [token, setTokenValue] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError('');

    const trimmed = token.trim();
    if (!trimmed) {
      setError('Please enter a bearer token.');
      return;
    }

    setLoading(true);
    try {
      const valid = await api.validateToken(trimmed);
      if (valid) {
        setToken(trimmed);
        window.dispatchEvent(new CustomEvent('auth-change'));
        onLogin();
      } else {
        setError('Invalid token. Please check your credentials.');
      }
    } catch {
      setError('Failed to validate token. Is the server reachable?');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="login-container">
      <form class="login-card" onSubmit={handleSubmit}>
        <h1>DWN Admin</h1>
        <p class="subtitle">Enter your bearer token to sign in.</p>
        {error && <p class="error">{error}</p>}
        <input
          type="password"
          placeholder="Bearer token"
          value={token}
          onInput={(e: Event) => setTokenValue((e.target as HTMLInputElement).value)}
          autoFocus
        />
        <button type="submit" class="btn btn-primary" disabled={loading} style="width:100%">
          {loading ? 'Validating...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
