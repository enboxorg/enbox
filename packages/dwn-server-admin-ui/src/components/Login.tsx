import { useState, useEffect } from 'preact/hooks';
import { startAuthentication } from '@simplewebauthn/browser';
import { api, setToken } from '../lib/api';

type LoginProps = {
  onLogin: () => void;
};

export function Login({ onLogin }: LoginProps) {
  const [token, setTokenValue] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasPasskeys, setHasPasskeys] = useState(false);
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [checkingPasskeys, setCheckingPasskeys] = useState(true);

  // Check if any passkeys are registered on mount.
  useEffect(() => {
    api.getPasskeyStatus().then((status) => {
      setHasPasskeys(status.hasPasskeys);
      setCheckingPasskeys(false);
    }).catch(() => {
      setCheckingPasskeys(false);
    });
  }, []);

  const handlePasskeyLogin = async () => {
    setError('');
    setLoading(true);
    try {
      const options = await api.getPasskeyLoginOptions();
      const credential = await startAuthentication({ optionsJSON: options });
      const result = await api.verifyPasskeyLogin(credential);
      if (result.verified && result.token) {
        setToken(result.token);
        window.dispatchEvent(new CustomEvent('auth-change'));
        onLogin();
      } else {
        setError('Passkey authentication failed.');
      }
    } catch (err: any) {
      if (err?.name === 'NotAllowedError') {
        setError('Passkey authentication was cancelled.');
      } else {
        setError(err?.message || 'Passkey authentication failed.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleTokenSubmit = async (e: Event) => {
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

  if (checkingPasskeys) {
    return (
      <div class="login-container">
        <div class="login-card">
          <h1>DWN Admin</h1>
          <p class="subtitle">Loading...</p>
        </div>
      </div>
    );
  }

  // If passkeys exist and user hasn't clicked "use token", show passkey-first UI.
  if (hasPasskeys && !showTokenForm) {
    return (
      <div class="login-container">
        <div class="login-card">
          <h1>DWN Admin</h1>
          <p class="subtitle">Sign in with your passkey.</p>
          {error && <p class="error">{error}</p>}
          <button
            type="button"
            class="btn btn-primary"
            disabled={loading}
            style="width:100%"
            onClick={handlePasskeyLogin}
          >
            {loading ? 'Authenticating...' : 'Sign in with Passkey'}
          </button>
          <div style="margin-top:16px;text-align:center">
            <button
              type="button"
              class="btn btn-sm"
              style="color:var(--color-text-secondary);border:none"
              onClick={() => { setShowTokenForm(true); setError(''); }}
            >
              Use bearer token instead
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Token-based login form (original flow, or fallback when no passkeys).
  return (
    <div class="login-container">
      <form class="login-card" onSubmit={handleTokenSubmit}>
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
        {hasPasskeys && (
          <div style="margin-top:16px;text-align:center">
            <button
              type="button"
              class="btn btn-sm"
              style="color:var(--color-text-secondary);border:none"
              onClick={() => { setShowTokenForm(false); setError(''); }}
            >
              Sign in with passkey instead
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
