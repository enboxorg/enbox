import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
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
// Profile card (public DWN data)
// ---------------------------------------------------------------------------

function ProfileCard({ did }: { did: string }) {
  const [profile, setProfile] = useState<any>(null);
  const [avatarOk, setAvatarOk] = useState(false);
  const [heroOk, setHeroOk] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    api.getProfile(did).then((data) => {
      if (!cancelled) {
        setProfile(data);
        setLoaded(true);
      }
    });

    // Probe avatar and hero URLs to check if they exist.
    const avatarUrl = api.getProfileAvatarUrl(did);
    const heroUrl = api.getProfileHeroUrl(did);

    fetch(avatarUrl, { method: 'HEAD' }).then((res) => {
      if (!cancelled && res.ok) { setAvatarOk(true); }
    }).catch(() => {});

    fetch(heroUrl, { method: 'HEAD' }).then((res) => {
      if (!cancelled && res.ok) { setHeroOk(true); }
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [did]);

  if (!loaded || !profile) { return null; }

  const avatarUrl = api.getProfileAvatarUrl(did);
  const heroUrl = api.getProfileHeroUrl(did);

  return (
    <div class="card" style="overflow:hidden;padding:0">
      {/* Hero banner */}
      {heroOk && (
        <div style="width:100%;height:120px;overflow:hidden;background:var(--color-bg)">
          <img
            src={heroUrl}
            alt=""
            style="width:100%;height:100%;object-fit:cover"
          />
        </div>
      )}

      <div style={`padding:20px;${heroOk ? 'padding-top:0' : ''}`}>
        <div style="display:flex;align-items:center;gap:14px">
          {/* Avatar */}
          {avatarOk ? (
            <img
              src={avatarUrl}
              alt=""
              style={`width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid var(--color-border);flex-shrink:0;${heroOk ? 'margin-top:-28px;border-color:var(--color-surface)' : ''}`}
            />
          ) : (
            <div style={`width:56px;height:56px;border-radius:50%;background:var(--color-primary);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:#fff;flex-shrink:0;${heroOk ? 'margin-top:-28px;border:2px solid var(--color-surface)' : ''}`}>
              {(profile.displayName || '?')[0].toUpperCase()}
            </div>
          )}

          <div style="min-width:0">
            <div style="font-size:16px;font-weight:600;color:var(--color-text)">
              {profile.displayName}
            </div>
            {profile.tagline && (
              <div style="font-size:13px;color:var(--color-text-secondary);margin-top:1px">
                {profile.tagline}
              </div>
            )}
          </div>
        </div>

        {profile.bio && (
          <div style="font-size:13px;color:var(--color-text-secondary);margin-top:12px;line-height:1.5">
            {profile.bio}
          </div>
        )}

        {/* Metadata row */}
        {(profile.location || profile.website || profile.pronouns) && (
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:12px;color:var(--color-text-muted)">
            {profile.location && (
              <span>{profile.location}</span>
            )}
            {profile.website && (
              <a href={profile.website} target="_blank" rel="noopener noreferrer" style="font-size:12px">
                {profile.website.replace(/^https?:\/\//, '')}
              </a>
            )}
            {profile.pronouns && (
              <span>{profile.pronouns}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function TenantList() {
  const [tenants, setTenants] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [prevCursors, setPrevCursors] = useState<string[]>([]);

  // Filter / search state
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('');
  const [order, setOrder] = useState('asc');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input (400ms)
  const handleSearchInput = useCallback((value: string): void => {
    setSearch(value);
    if (debounceRef.current) { clearTimeout(debounceRef.current); }
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setCursor(undefined);
      setPrevCursors([]);
    }, 400);
  }, []);

  // Reset pagination when filters change
  useEffect(() => {
    setCursor(undefined);
    setPrevCursors([]);
  }, [status, sort, order]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    api.getTenants({
      limit  : 20,
      cursor,
      search : debouncedSearch || undefined,
      status : status || undefined,
      sort   : sort || undefined,
      order  : sort ? order : undefined,
    }).then((data) => {
      if (!cancelled) {
        setTenants(data);
        setLoading(false);
      }
    }).catch((err) => {
      console.error('Tenant list fetch error:', err);
      if (!cancelled) { setLoading(false); }
    });

    return () => { cancelled = true; };
  }, [cursor, debouncedSearch, status, sort, order]);

  const items = tenants?.data ?? [];
  const nextCursor = tenants?.cursor;
  const totalCount = tenants?.totalCount;

  const handleSort = (field: string): void => {
    if (sort === field) {
      setOrder(order === 'asc' ? 'desc' : 'asc');
    } else {
      setSort(field);
      setOrder('asc');
    }
  };

  const sortIndicator = (field: string): string => {
    if (sort !== field) { return ''; }
    return order === 'asc' ? ' \u2191' : ' \u2193';
  };

  return (
    <div>
      <div class="page-header">
        <h2>Tenants</h2>
      </div>

      {/* Search & filter toolbar */}
      <div class="card" style="padding:12px 16px;margin-bottom:12px">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <div class="form-group" style="margin-bottom:0;flex:1;min-width:200px">
            <input
              type="text"
              placeholder="Search by DID..."
              value={search}
              onInput={(e: any) => handleSearchInput(e.target.value)}
              style="margin-bottom:0"
            />
          </div>
          <div class="form-group" style="margin-bottom:0;min-width:120px">
            <select value={status} onChange={(e: any) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0;min-width:120px">
            <select value={sort} onChange={(e: any) => setSort(e.target.value)}>
              <option value="">Default sort</option>
              <option value="did">Sort by DID</option>
              <option value="messages">Sort by Messages</option>
              <option value="storage">Sort by Storage</option>
            </select>
          </div>
          {sort && (
            <button
              type="button"
              class="btn btn-sm"
              onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')}
              title={order === 'asc' ? 'Ascending' : 'Descending'}
            >
              {order === 'asc' ? '\u2191 Asc' : '\u2193 Desc'}
            </button>
          )}
        </div>
      </div>

      <div class="card">
        {loading ? (
          <div class="loading">Loading...</div>
        ) : (
          <>
            <div class="table-container">
              <table>
                <thead>
                  <tr>
                    <th
                      style="cursor:pointer;user-select:none"
                      onClick={() => handleSort('did')}
                    >
                      DID{sortIndicator('did')}
                    </th>
                    <th
                      style="cursor:pointer;user-select:none"
                      onClick={() => handleSort('messages')}
                    >
                      Messages{sortIndicator('messages')}
                    </th>
                    <th
                      style="cursor:pointer;user-select:none"
                      onClick={() => handleSort('storage')}
                    >
                      Storage{sortIndicator('storage')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={3}>
                        <div class="empty-state">
                          {debouncedSearch || status ? 'No tenants match the current filters.' : 'No tenants found.'}
                        </div>
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
                      <td>{formatBytes(t.dataStorageBytes ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div class="pagination">
              <div class="info">
                Showing {items.length}{totalCount === undefined ? '' : ` of ${formatNumber(totalCount)}`} tenant{items.length === 1 ? '' : 's'}
              </div>
              <div style="display:flex;gap:8px">
                <button
                  type="button"
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
                  type="button"
                  class="btn btn-sm"
                  disabled={!nextCursor}
                  onClick={() => {
                    if (cursor !== undefined) {
                      setPrevCursors([...prevCursors, cursor]);
                    }
                    setCursor(nextCursor);
                  }}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message browser component (used within tenant detail)
// ---------------------------------------------------------------------------

function MessageBrowser({ did }: { did: string }) {
  const [messages, setMessages] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [prevCursors, setPrevCursors] = useState<number[]>([]);

  // Filters
  const [filterInterface, setFilterInterface] = useState('');
  const [filterMethod, setFilterMethod] = useState('');
  const [filterProtocol, setFilterProtocol] = useState('');

  const PAGE_SIZE = 20;

  // Reset pagination when filters change
  useEffect(() => {
    setCursor(undefined);
    setPrevCursors([]);
  }, [filterInterface, filterMethod, filterProtocol]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    api.getTenantMessages(did, {
      limit     : PAGE_SIZE,
      cursor,
      interface : filterInterface || undefined,
      method    : filterMethod || undefined,
      protocol  : filterProtocol || undefined,
    }).then((data) => {
      if (!cancelled) {
        setMessages(data);
        setLoading(false);
      }
    }).catch((err) => {
      console.error('Message browser fetch error:', err);
      if (!cancelled) { setLoading(false); }
    });

    return () => { cancelled = true; };
  }, [did, cursor, filterInterface, filterMethod, filterProtocol]);

  const messageItems = messages?.messages ?? [];
  const nextCursor = messages?.cursor;

  return (
    <div class="card">
      <div class="card-header">
        <h3>Messages</h3>
      </div>

      {/* Message filters */}
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <div class="form-group" style="margin-bottom:0;min-width:100px">
          <select value={filterInterface} onChange={(e: any) => setFilterInterface(e.target.value)}>
            <option value="">All interfaces</option>
            <option value="Records">Records</option>
            <option value="Protocols">Protocols</option>
            <option value="Messages">Messages</option>
            <option value="Permissions">Permissions</option>
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0;min-width:100px">
          <select value={filterMethod} onChange={(e: any) => setFilterMethod(e.target.value)}>
            <option value="">All methods</option>
            <option value="Write">Write</option>
            <option value="Read">Read</option>
            <option value="Query">Query</option>
            <option value="Subscribe">Subscribe</option>
            <option value="Delete">Delete</option>
            <option value="Configure">Configure</option>
            <option value="Grant">Grant</option>
            <option value="Request">Request</option>
            <option value="Revoke">Revoke</option>
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0;flex:1;min-width:150px">
          <input
            type="text"
            placeholder="Filter by protocol URI..."
            value={filterProtocol}
            onInput={(e: any) => setFilterProtocol(e.target.value)}
            style="margin-bottom:0"
          />
        </div>
        {(filterInterface || filterMethod || filterProtocol) && (
          <button
            type="button"
            class="btn btn-sm"
            onClick={() => { setFilterInterface(''); setFilterMethod(''); setFilterProtocol(''); }}
          >
            Clear filters
          </button>
        )}
      </div>

      {loading ? (
        <div class="loading">Loading...</div>
      ) : (
        <>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Message CID</th>
                  <th>Interface</th>
                  <th>Method</th>
                  <th>Protocol</th>
                  <th>Schema</th>
                  <th>Data Format</th>
                  <th>Data Size</th>
                  <th>Date Created</th>
                </tr>
              </thead>
              <tbody>
                {messageItems.length === 0 && (
                  <tr>
                    <td colSpan={8}>
                      <div class="empty-state">
                        {filterInterface || filterMethod || filterProtocol
                          ? 'No messages match the current filters.'
                          : 'No messages found.'}
                      </div>
                    </td>
                  </tr>
                )}
                {messageItems.map((m: any) => (
                  <tr key={m.messageCid}>
                    <td class="mono">{truncateDid(m.messageCid ?? '', 20)}</td>
                    <td>{m.interface ?? '\u2014'}</td>
                    <td>{m.method ?? '\u2014'}</td>
                    <td class="mono">{m.protocol ? truncateDid(m.protocol, 24) : '\u2014'}</td>
                    <td class="mono" style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={m.schema ?? ''}>
                      {m.schema ? truncateDid(m.schema, 20) : '\u2014'}
                    </td>
                    <td>{m.dataFormat ?? '\u2014'}</td>
                    <td>{m.dataSize !== undefined && m.dataSize !== null ? formatBytes(m.dataSize) : '\u2014'}</td>
                    <td>{m.dateCreated ? formatTimestamp(m.dateCreated) : '\u2014'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div class="pagination">
            <div class="info">
               Showing {messageItems.length} message{messageItems.length === 1 ? '' : 's'}
            </div>
            <div style="display:flex;gap:8px">
              <button
                type="button"
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
                type="button"
                class="btn btn-sm"
                disabled={!nextCursor}
                onClick={() => {
                  if (cursor !== undefined) {
                    setPrevCursors([...prevCursors, cursor]);
                  }
                  setCursor(nextCursor);
                }}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function TenantDetail({ did }: { did: string }) {
  const [tenant, setTenant] = useState<any>(null);
  const [quota, setQuota] = useState<any>(null);
  const [protocols, setProtocols] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      api.getTenant(did),
      api.getQuota(did),
      api.getTenantProtocols(did),
    ]).then(([t, q, p]) => {
      if (!cancelled) {
        setTenant(t);
        setQuota(q);
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
            <span class={`badge ${tenant.isActive === false ? 'badge-muted' : 'badge-success'}`}>
              {tenant.isActive === false ? 'Inactive' : 'Active'}
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
          type="button"
          class={`btn btn-sm ${tenant?.suspended ? 'btn-primary' : ''}`}
          disabled={actionLoading}
          onClick={handleSuspend}
        >
          {tenant?.suspended ? 'Unsuspend' : 'Suspend'}
        </button>
        <button
          type="button"
          class="btn btn-sm btn-danger"
          disabled={actionLoading}
          onClick={handleDelete}
        >
          Delete
        </button>
      </div>

      {/* Public profile card */}
      <ProfileCard did={did} />

      {/* Storage card */}
      <div class="card">
        <div class="card-header">
          <h3>Storage</h3>
        </div>
        <div class="stat-grid">
          <div class="stat-card">
            <div class="label">Messages</div>
            <div class="value">{formatNumber(tenant?.storage?.messageCount ?? 0)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Data Storage</div>
            <div class="value">{formatBytes(tenant?.storage?.dataStorageBytes ?? 0)}</div>
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
            <span class={`badge ${quota.quota?.source === 'unlimited' ? 'badge-muted' : 'badge-info'}`}>
              {quota.quota?.source ?? 'unknown'}
            </span>
          </div>
          {quota.quota?.source !== 'unlimited' && (
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
              {quota.quota?.maxMessages !== undefined && (
                <div>
                  <div style="font-size:12px;color:var(--color-text-muted);margin-bottom:4px">Messages</div>
                  <div style="font-size:13px">
                    {formatNumber(quota.usage?.messageCount ?? 0)} / {formatNumber(quota.quota.maxMessages)}
                  </div>
                  <div style="background:var(--color-border);border-radius:4px;height:6px;margin-top:6px;overflow:hidden">
                    <div
                      style={{
                        width      : `${Math.min(100, ((quota.usage?.messageCount ?? 0) / quota.quota.maxMessages) * 100)}%`,
                        height     : '100%',
                        background : ((quota.usage?.messageCount ?? 0) / quota.quota.maxMessages) > 0.9
                          ? 'var(--color-danger)'
                          : 'var(--color-primary)',
                        borderRadius: '4px',
                      }}
                    />
                  </div>
                </div>
              )}
              {quota.quota?.maxStorageBytes !== undefined && (
                <div>
                  <div style="font-size:12px;color:var(--color-text-muted);margin-bottom:4px">Storage</div>
                  <div style="font-size:13px">
                    {formatBytes(quota.usage?.storageBytes ?? 0)} / {formatBytes(quota.quota.maxStorageBytes)}
                  </div>
                  <div style="background:var(--color-border);border-radius:4px;height:6px;margin-top:6px;overflow:hidden">
                    <div
                      style={{
                        width      : `${Math.min(100, ((quota.usage?.storageBytes ?? 0) / quota.quota.maxStorageBytes) * 100)}%`,
                        height     : '100%',
                        background : ((quota.usage?.storageBytes ?? 0) / quota.quota.maxStorageBytes) > 0.9
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

      {/* Messages browser (separate component with its own state) */}
      <MessageBrowser did={did} />
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
