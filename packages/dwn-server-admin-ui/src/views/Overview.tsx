import { useState, useEffect } from 'preact/hooks';

import { api } from '../lib/api';
import { formatBytes, formatNumber, formatUptime } from '../lib/format';

export function Overview() {
  const [health, setHealth] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [rateLimits, setRateLimits] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      try {
        const [h, s, r] = await Promise.all([
          api.getHealth(),
          api.getStats(),
          api.getRateLimits(),
        ]);
        if (!cancelled) {
          setHealth(h);
          setStats(s);
          setRateLimits(r);
          setError('');
        }
      } catch (err: any) {
        console.error('Overview fetch error:', err);
        if (!cancelled) { setError(err.message || 'Failed to load overview data'); }
      } finally {
        if (!cancelled) { setLoading(false); }
      }
    }

    fetchData();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div class="loading">Loading...</div>;
  }

  return (
    <div>
      <div class="page-header">
        <h2>Overview</h2>
        <p class="description">Server health and statistics</p>
      </div>

      {error && (
        <div class="card" style="color:var(--color-danger)">
          {error}
        </div>
      )}

      {/* Health status card */}
      {health && (
        <div class="card">
          <div class="card-header">
            <h3>Health</h3>
            <span class={`badge ${health.status === 'healthy' ? 'badge-success' : 'badge-danger'}`}>
              {health.status}
            </span>
          </div>
          <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:12px">
            {health.uptime !== undefined && (
              <div>
                <span style="color:var(--color-text-muted);font-size:12px">Uptime</span>
                <div style="font-weight:600">{formatUptime(health.uptime)}</div>
              </div>
            )}
            {health.version && (
              <div>
                <span style="color:var(--color-text-muted);font-size:12px">Version</span>
                <div style="font-weight:600">{health.version}</div>
              </div>
            )}
          </div>
          {health.checks && Object.keys(health.checks).length > 0 && (
            <div class="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Status</th>
                    <th>Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(health.checks).map(([name, check]: [string, any]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td>
                        <span class={`status-dot ${check.status === 'healthy' ? 'healthy' : check.status === 'unhealthy' ? 'unhealthy' : 'unknown'}`} />
                        {check.status}
                      </td>
                      <td>{check.latencyMs === undefined ? '—' : `${check.latencyMs}ms`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Stats grid */}
      {stats && (
        <div class="stat-grid">
          <div class="stat-card">
            <div class="label">Tenants</div>
            <div class="value">{formatNumber(stats.tenants?.total ?? 0)}</div>
            <div class="sub">{formatNumber(stats.tenants?.suspended ?? 0)} suspended</div>
          </div>
          <div class="stat-card">
            <div class="label">Messages</div>
            <div class="value">{formatNumber(stats.storage?.totalMessages ?? 0)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Storage</div>
            <div class="value">{formatBytes(stats.storage?.totalDataBytes ?? 0)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Protocols</div>
            <div class="value">{formatNumber(stats.storage?.totalProtocols ?? 0)}</div>
          </div>
          <div class="stat-card">
            <div class="label">WebSocket</div>
            <div class="value">{formatNumber(stats.connections?.websocket?.active ?? 0)}</div>
            <div class="sub">{formatNumber(stats.connections?.websocket?.subscriptions ?? 0)} subscriptions</div>
          </div>
          <div class="stat-card">
            <div class="label">Uptime</div>
            <div class="value">{formatUptime(stats.uptime ?? 0)}</div>
          </div>
        </div>
      )}

      {/* Rate limiting card */}
      {rateLimits && (
        <div class="card">
          <div class="card-header">
            <h3>Rate Limiting</h3>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
            {/* Per-IP config */}
            <div>
              <div style="font-size:12px;font-weight:600;color:var(--color-text-secondary);margin-bottom:8px">Per-IP</div>
              <div style="font-size:13px">
                <span class={`badge ${rateLimits.config?.perIp?.enabled ? 'badge-success' : 'badge-muted'}`}>
                  {rateLimits.config?.perIp?.enabled ? 'Enabled' : 'Disabled'}
                </span>
                {rateLimits.config?.perIp?.enabled && (
                  <span style="margin-left:8px;color:var(--color-text-secondary)">
                    {rateLimits.config.perIp.requestsPerSecond} rps / {rateLimits.config.perIp.burst} burst
                  </span>
                )}
              </div>
              {rateLimits.activeEntries?.ip !== undefined && (
                <div style="font-size:12px;color:var(--color-text-muted);margin-top:4px">
                  {formatNumber(rateLimits.activeEntries.ip)} active entries
                </div>
              )}
            </div>
            {/* Per-Tenant config */}
            <div>
              <div style="font-size:12px;font-weight:600;color:var(--color-text-secondary);margin-bottom:8px">Per-Tenant</div>
              <div style="font-size:13px">
                <span class={`badge ${rateLimits.config?.perTenant?.enabled ? 'badge-success' : 'badge-muted'}`}>
                  {rateLimits.config?.perTenant?.enabled ? 'Enabled' : 'Disabled'}
                </span>
                {rateLimits.config?.perTenant?.enabled && (
                  <span style="margin-left:8px;color:var(--color-text-secondary)">
                    {rateLimits.config.perTenant.requestsPerSecond} rps / {rateLimits.config.perTenant.burst} burst
                  </span>
                )}
              </div>
              {rateLimits.activeEntries?.tenant !== undefined && (
                <div style="font-size:12px;color:var(--color-text-muted);margin-top:4px">
                  {formatNumber(rateLimits.activeEntries.tenant)} active entries
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
