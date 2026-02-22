import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { route } from 'preact-router';

import { api } from '../lib/api';
import { formatBytes, formatNumber, formatTimestamp, truncateDid } from '../lib/format';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type TenantsProps = {
  did?: string;
};

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function TenantList() {
  const [tenants, setTenants] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [prevCursors, setPrevCursors] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    api.getTenants({ limit: 20, cursor }).then((data) => {
      if (!cancelled) {
        setTenants(data);
        setLoading(false);
      }
    }).catch((err) => {
      console.error('Tenant list fetch error:', err);
      if (!cancelled) { setLoading(false); }
    });

    return () => { cancelled = true; };
  }, [cursor]);

  if (loading) {
    return <div class="loading">Loading...</div>;
  }

  const items = tenants?.tenants ?? [];
  const nextCursor = tenants?.cursor;

  return (
    <div>
      <div class="page-header">
        <h2>Tenants</h2>
      </div>

      <div class="card">
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>DID</th>
                <th>Messages</th>
                <th>Storage</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={3}>
                    <div class="empty-state">No tenants found.</div>
                  </td>
                </tr>
              )}
              {items.map((t: any) => (
                <tr key={t.did}>
                  <td class="mono">
                    <a href={`/admin/tenants/${encodeURIComponent(t.did)}`}>
                      {truncateDid(t.did)}
                    </a>
                  </td>
                  <td>{formatNumber(t.messageCount ?? 0)}</td>
                  <td>{formatBytes(t.storageBytes ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div class="pagination">
          <div class="info">
            Showing {items.length} tenant{items.length !== 1 ? 's' : ''}
          </div>
          <div style="display:flex;gap:8px">
            <button
              class="btn btn-sm"
              disabled={prevCursors.length === 0}
              onClick={() => {
                const prev = [...prevCursors];
                const newCursor = prev.pop();
                setPrevCursors(prev);
                setCursor(newCursor);
              }}
            >
              Previous
            </button>
            <button
              class="btn btn-sm"
              disabled={!nextCursor}
              onClick={() => {
                setPrevCursors([...prevCursors, cursor as string]);
                setCursor(nextCursor);
              }}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function TenantDetail({ did }: { did: string }) {
  const [tenant, setTenant] = useState<any>(null);
  const [quota, setQuota] = useState<any>(null);
  const [messages, setMessages] = useState<any>(null);
  const [protocols, setProtocols] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      api.getTenant(did),
      api.getQuota(did),
      api.getTenantMessages(did, { limit: 10 }),
      api.getTenantProtocols(did),
    ]).then(([t, q, m, p]) => {
      if (!cancelled) {
        setTenant(t);
        setQuota(q);
        setMessages(m);
        setProtocols(p);
        setLoading(false);
      }
    }).catch((err) => {
      console.error('Tenant detail fetch error:', err);
      if (!cancelled) { setLoading(false); }
    });

    return () => { cancelled = true; };
  }, [did]);

  const handleSuspend = async () => {
    setActionLoading(true);
    try {
      if (tenant?.suspended) {
        await api.unsuspendTenant(did);
      } else {
        await api.suspendTenant(did);
      }
      const updated = await api.getTenant(did);
      setTenant(updated);
    } catch (err) {
      console.error('Suspend/unsuspend error:', err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    const confirmed = window.confirm(
      `Are you sure you want to delete tenant ${truncateDid(did)}? This action cannot be undone.`
    );
    if (!confirmed) { return; }

    setActionLoading(true);
    try {
      await api.deleteTenant(did, true);
      route('/admin/tenants');
    } catch (err) {
      console.error('Delete tenant error:', err);
      setActionLoading(false);
    }
  };

  if (loading) {
    return <div class="loading">Loading...</div>;
  }

  const messageItems = messages?.messages ?? [];
  const protocolItems = protocols?.protocols ?? [];

  return (
    <div>
      <div class="page-header">
        <div style="display:flex;align-items:center;gap:12px">
          <a href="/admin/tenants" style="color:var(--color-text-secondary);font-size:13px">&larr; Tenants</a>
        </div>
        <h2 style="margin-top:8px;word-break:break-all;font-family:var(--font-mono);font-size:14px">{did}</h2>
        {tenant && (
          <div style="display:flex;gap:8px;margin-top:8px">
            <span class={`badge ${tenant.active !== false ? 'badge-success' : 'badge-muted'}`}>
              {tenant.active !== false ? 'Active' : 'Inactive'}
            </span>
            <span class={`badge ${tenant.suspended ? 'badge-danger' : 'badge-success'}`}>
              {tenant.suspended ? 'Suspended' : 'Not Suspended'}
            </span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button
          class={`btn btn-sm ${tenant?.suspended ? 'btn-primary' : ''}`}
          disabled={actionLoading}
          onClick={handleSuspend}
        >
          {tenant?.suspended ? 'Unsuspend' : 'Suspend'}
        </button>
        <button
          class="btn btn-sm btn-danger"
          disabled={actionLoading}
          onClick={handleDelete}
        >
          Delete
        </button>
      </div>

      {/* Registration info */}
      {tenant?.registeredAt && (
        <div class="card">
          <div class="card-header">
            <h3>Registration</h3>
          </div>
          <div style="font-size:13px;color:var(--color-text-secondary)">
            Registered {formatTimestamp(tenant.registeredAt)}
          </div>
        </div>
      )}

      {/* Storage card */}
      <div class="card">
        <div class="card-header">
          <h3>Storage</h3>
        </div>
        <div class="stat-grid">
          <div class="stat-card">
            <div class="label">Messages</div>
            <div class="value">{formatNumber(tenant?.messageCount ?? 0)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Data Storage</div>
            <div class="value">{formatBytes(tenant?.storageBytes ?? 0)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Protocols</div>
            <div class="value">{formatNumber(protocolItems.length)}</div>
          </div>
        </div>
        {protocolItems.length > 0 && (
          <div style="margin-top:8px">
            <div style="font-size:12px;font-weight:600;color:var(--color-text-muted);margin-bottom:6px">Installed Protocols</div>
            <div class="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Protocol</th>
                    <th>Messages</th>
                  </tr>
                </thead>
                <tbody>
                  {protocolItems.map((p: any) => (
                    <tr key={p.protocol}>
                      <td class="mono">{p.protocol}</td>
                      <td>{formatNumber(p.messageCount ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Quota card */}
      {quota && (
        <div class="card">
          <div class="card-header">
            <h3>Quota</h3>
            <span class={`badge ${quota.source === 'unlimited' ? 'badge-muted' : 'badge-info'}`}>
              {quota.source ?? 'unknown'}
            </span>
          </div>
          {quota.source !== 'unlimited' && (
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
              {quota.limits?.maxMessages !== undefined && (
                <div>
                  <div style="font-size:12px;color:var(--color-text-muted);margin-bottom:4px">Messages</div>
                  <div style="font-size:13px">
                    {formatNumber(quota.usage?.messages ?? 0)} / {formatNumber(quota.limits.maxMessages)}
                  </div>
                  <div style="background:var(--color-border);border-radius:4px;height:6px;margin-top:6px;overflow:hidden">
                    <div
                      style={{
                        width      : `${Math.min(100, ((quota.usage?.messages ?? 0) / quota.limits.maxMessages) * 100)}%`,
                        height     : '100%',
                        background : ((quota.usage?.messages ?? 0) / quota.limits.maxMessages) > 0.9
                          ? 'var(--color-danger)'
                          : 'var(--color-primary)',
                        borderRadius: '4px',
                      }}
                    />
                  </div>
                </div>
              )}
              {quota.limits?.maxStorageBytes !== undefined && (
                <div>
                  <div style="font-size:12px;color:var(--color-text-muted);margin-bottom:4px">Storage</div>
                  <div style="font-size:13px">
                    {formatBytes(quota.usage?.storageBytes ?? 0)} / {formatBytes(quota.limits.maxStorageBytes)}
                  </div>
                  <div style="background:var(--color-border);border-radius:4px;height:6px;margin-top:6px;overflow:hidden">
                    <div
                      style={{
                        width      : `${Math.min(100, ((quota.usage?.storageBytes ?? 0) / quota.limits.maxStorageBytes) * 100)}%`,
                        height     : '100%',
                        background : ((quota.usage?.storageBytes ?? 0) / quota.limits.maxStorageBytes) > 0.9
                          ? 'var(--color-danger)'
                          : 'var(--color-primary)',
                        borderRadius: '4px',
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Messages browser */}
      <div class="card">
        <div class="card-header">
          <h3>Messages</h3>
        </div>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Message CID</th>
                <th>Interface</th>
                <th>Method</th>
                <th>Protocol</th>
                <th>Data Size</th>
                <th>Date Created</th>
              </tr>
            </thead>
            <tbody>
              {messageItems.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div class="empty-state">No messages found.</div>
                  </td>
                </tr>
              )}
              {messageItems.map((m: any) => (
                <tr key={m.messageCid}>
                  <td class="mono">{truncateDid(m.messageCid ?? '', 24)}</td>
                  <td>{m.interface ?? '—'}</td>
                  <td>{m.method ?? '—'}</td>
                  <td class="mono">{m.protocol ? truncateDid(m.protocol, 30) : '—'}</td>
                  <td>{m.dataSize !== undefined ? formatBytes(m.dataSize) : '—'}</td>
                  <td>{m.dateCreated ? formatTimestamp(m.dateCreated) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export — routes between list and detail based on `did` prop
// ---------------------------------------------------------------------------

export function Tenants({ did }: TenantsProps) {
  if (did) {
    return <TenantDetail did={decodeURIComponent(did)} />;
  }
  return <TenantList />;
}
