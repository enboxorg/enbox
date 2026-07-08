import { useState, useEffect } from 'preact/hooks';
import { startRegistration } from '@simplewebauthn/browser';
import { api } from '../lib/api';

type Passkey = {
  id : string;
  name : string;
  createdAt : string;
  lastUsedAt : string | null;
};

export function Passkeys() {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [registerName, setRegisterName] = useState('');
  const [registering, setRegistering] = useState(false);
  const [registerSuccess, setRegisterSuccess] = useState('');

  const loadPasskeys = async () => {
    try {
      const result = await api.getPasskeys();
      setPasskeys(result.passkeys ?? []);
    } catch (err: any) {
      if (err?.message !== 'Passkey storage is not enabled. Requires a SQL storage backend.') {
        setError(err?.message || 'Failed to load passkeys');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadPasskeys(); }, []);

  const handleRegister = async () => {
    setError('');
    setRegisterSuccess('');
    setRegistering(true);
    try {
      const options = await api.getPasskeyRegisterOptions(registerName || undefined);
      const credential = await startRegistration({ optionsJSON: options });
      await api.verifyPasskeyRegistration(credential, registerName || undefined);
      setRegisterSuccess('Passkey registered successfully.');
      setRegisterName('');
      await loadPasskeys();
    } catch (err: any) {
      if (err?.name === 'NotAllowedError') {
        setError('Passkey registration was cancelled.');
      } else if (err?.message?.includes('requires static token')) {
        setError('Passkey registration requires signing in with a bearer token (not a passkey session).');
      } else {
        setError(err?.message || 'Failed to register passkey.');
      }
    } finally {
      setRegistering(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete passkey "${name}"? This cannot be undone.`)) {
      return;
    }
    setError('');
    try {
      await api.deletePasskey(id);
      await loadPasskeys();
    } catch (err: any) {
      if (err?.message?.includes('requires static token')) {
        setError('Passkey deletion requires signing in with a bearer token (not a passkey session).');
      } else {
        setError(err?.message || 'Failed to delete passkey.');
      }
    }
  };

  const formatDate = (iso: string | null): string => {
    if (!iso) { return 'Never'; }
    return new Date(iso).toLocaleString();
  };

  if (loading) {
    return <div class="loading">Loading passkeys...</div>;
  }

  return (
    <div>
      <div class="page-header">
        <h2>Passkeys</h2>
        <p class="description">
          Manage WebAuthn passkeys for passwordless admin access.
          Register a passkey to sign in without entering a bearer token.
        </p>
      </div>

      {error && <div class="card" style="border-color:var(--color-danger);margin-bottom:16px"><p style="color:var(--color-danger);margin:0">{error}</p></div>}
      {registerSuccess && <div class="card" style="border-color:var(--color-success);margin-bottom:16px"><p style="color:var(--color-success);margin:0">{registerSuccess}</p></div>}

      <div class="card">
        <div class="card-header">
          <h3>Register New Passkey</h3>
        </div>
        <div style="display:flex;gap:12px;align-items:flex-end">
          <div class="form-group" style="flex:1;margin-bottom:0">
            <label htmlFor="passkey-register-name">Passkey Name (optional)</label>
            <input
              id="passkey-register-name"
              type="text"
              placeholder="e.g. MacBook Touch ID"
              value={registerName}
              onInput={(e: Event) => setRegisterName((e.target as HTMLInputElement).value)}
            />
          </div>
          <button
            type="button"
            class="btn btn-primary"
            disabled={registering}
            onClick={handleRegister}
            style="margin-bottom:0;height:36px"
          >
            {registering ? 'Registering...' : 'Register Passkey'}
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3>Registered Passkeys</h3>
          <span class="badge badge-muted">{passkeys.length}</span>
        </div>
        {passkeys.length === 0 ? (
          <div class="empty-state">No passkeys registered yet.</div>
        ) : (
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Created</th>
                  <th>Last Used</th>
                  <th>Credential ID</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {passkeys.map((pk) => (
                  <tr key={pk.id}>
                    <td>{pk.name}</td>
                    <td>{formatDate(pk.createdAt)}</td>
                    <td>{formatDate(pk.lastUsedAt)}</td>
                    <td class="mono" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">{pk.id}</td>
                    <td>
                      <button
                        type="button"
                        class="btn btn-sm btn-danger"
                        onClick={() => handleDelete(pk.id, pk.name)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
