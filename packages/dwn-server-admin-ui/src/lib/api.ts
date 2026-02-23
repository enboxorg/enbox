/**
 * Admin API client. All requests go through this module so auth
 * and base URL logic live in one place.
 */

let token: string | null = null;

export function setToken(t: string | null): void {
  token = t;
  if (t) {
    sessionStorage.setItem('adminToken', t);
  } else {
    sessionStorage.removeItem('adminToken');
  }
}

export function getToken(): string | null {
  if (!token) {
    token = sessionStorage.getItem('adminToken');
  }
  return token;
}

export function clearToken(): void {
  token = null;
  sessionStorage.removeItem('adminToken');
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const t = getToken();
  if (!t) {
    throw new Error('Not authenticated');
  }

  const url = `/admin/api${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${t}`,
      ...options.headers,
    },
  });

  if (response.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent('auth-change'));
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Typed API methods
// ---------------------------------------------------------------------------

export const api = {
  // Health & info
  getHealth: ()      => request<any>('/health'),
  getStats:  (opts?: { refresh?: boolean }) =>
    request<any>(`/stats${opts?.refresh ? '?refresh=true' : ''}`),
  getInfo:   ()      => request<any>('/info'),

  // Tenants
  getTenants: (opts?: { limit?: number; cursor?: string; search?: string; status?: string; sort?: string; order?: string }) => {
    const params = new URLSearchParams();
    if (opts?.limit)  { params.set('limit', String(opts.limit)); }
    if (opts?.cursor) { params.set('cursor', opts.cursor); }
    if (opts?.search) { params.set('search', opts.search); }
    if (opts?.status) { params.set('status', opts.status); }
    if (opts?.sort)   { params.set('sort', opts.sort); }
    if (opts?.order)  { params.set('order', opts.order); }
    const qs = params.toString();
    return request<any>(`/tenants${qs ? '?' + qs : ''}`);
  },
  getTenant:       (did: string)          => request<any>(`/tenants/${encodeURIComponent(did)}`),
  suspendTenant:   (did: string)          => request<any>(`/tenants/${encodeURIComponent(did)}/suspend`, { method: 'POST' }),
  unsuspendTenant: (did: string)          => request<any>(`/tenants/${encodeURIComponent(did)}/unsuspend`, { method: 'POST' }),
  deleteTenant:    (did: string, purge = false) =>
    request<any>(`/tenants/${encodeURIComponent(did)}${purge ? '?purge=true' : ''}`, { method: 'DELETE' }),

  // Tenant quota
  getQuota:    (did: string) => request<any>(`/tenants/${encodeURIComponent(did)}/quota`),
  setQuota:    (did: string, body: { maxMessages?: number; maxStorageBytes?: number }) =>
    request<any>(`/tenants/${encodeURIComponent(did)}/quota`, {
      method  : 'PUT',
      headers : { 'content-type': 'application/json' },
      body    : JSON.stringify(body),
    }),
  deleteQuota: (did: string) => request<any>(`/tenants/${encodeURIComponent(did)}/quota`, { method: 'DELETE' }),

  // Tenant data browser
  getTenantMessages: (did: string, opts?: { interface?: string; method?: string; protocol?: string; limit?: number; cursor?: number }) => {
    const params = new URLSearchParams();
    if (opts?.interface) { params.set('interface', opts.interface); }
    if (opts?.method)    { params.set('method', opts.method); }
    if (opts?.protocol)  { params.set('protocol', opts.protocol); }
    if (opts?.limit)     { params.set('limit', String(opts.limit)); }
    if (opts?.cursor)    { params.set('cursor', String(opts.cursor)); }
    const qs = params.toString();
    return request<any>(`/tenants/${encodeURIComponent(did)}/messages${qs ? '?' + qs : ''}`);
  },
  getTenantProtocols: (did: string) => request<any>(`/tenants/${encodeURIComponent(did)}/protocols`),

  // Connections
  getConnections: () => request<any>('/connections'),

  // Events
  getEvents: (opts?: { since?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.since) { params.set('since', String(opts.since)); }
    if (opts?.limit) { params.set('limit', String(opts.limit)); }
    const qs = params.toString();
    return request<any>(`/events${qs ? '?' + qs : ''}`);
  },

  // Config
  getConfig:   () => request<any>('/config'),
  patchConfig: (body: Record<string, unknown>) =>
    request<any>('/config', {
      method  : 'PATCH',
      headers : { 'content-type': 'application/json' },
      body    : JSON.stringify(body),
    }),

  // Audit
  getAudit: (opts?: { since?: string; action?: string; target?: string; limit?: number; cursor?: number }) => {
    const params = new URLSearchParams();
    if (opts?.since)  { params.set('since', opts.since); }
    if (opts?.action) { params.set('action', opts.action); }
    if (opts?.target) { params.set('target', opts.target); }
    if (opts?.limit)  { params.set('limit', String(opts.limit)); }
    if (opts?.cursor) { params.set('cursor', String(opts.cursor)); }
    const qs = params.toString();
    return request<any>(`/audit${qs ? '?' + qs : ''}`);
  },

  // Rate limits
  getRateLimits: () => request<any>('/rate-limits'),

  // Public profile (no auth — uses DWN convenience routes)
  getProfile: async (did: string): Promise<{ displayName: string; bio?: string; tagline?: string; location?: string; website?: string; pronouns?: string } | null> => {
    const protocol = 'aHR0cHM6Ly9pZGVudGl0eS5mb3VuZGF0aW9uL3Byb3RvY29scy9wcm9maWxl';
    try {
      const res = await fetch(`/${encodeURIComponent(did)}/read/protocols/${protocol}/profile`);
      if (!res.ok) { return null; }
      return res.json();
    } catch {
      return null;
    }
  },
  getProfileAvatarUrl: (did: string): string => {
    const protocol = 'aHR0cHM6Ly9pZGVudGl0eS5mb3VuZGF0aW9uL3Byb3RvY29scy9wcm9maWxl';
    return `/${encodeURIComponent(did)}/read/protocols/${protocol}/profile/avatar`;
  },
  getProfileHeroUrl: (did: string): string => {
    const protocol = 'aHR0cHM6Ly9pZGVudGl0eS5mb3VuZGF0aW9uL3Byb3RvY29scy9wcm9maWxl';
    return `/${encodeURIComponent(did)}/read/protocols/${protocol}/profile/hero`;
  },

  // Validate token — tries /info and returns true if 200.
  validateToken: async (t: string): Promise<boolean> => {
    try {
      const response = await fetch('/admin/api/info', {
        headers: { authorization: `Bearer ${t}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  },
};
