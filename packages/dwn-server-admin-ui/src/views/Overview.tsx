import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';

import { api } from '../lib/api';
import { formatBytes, formatNumber, formatUptime } from '../lib/format';

export function Overview() {
  const [health, setHealth] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [rateLimits, setRateLimits] = useState<any>(null);
  const [loading, setLoading] = useState(true);

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
        }
      } catch (err) {
        console.error('Overview fetch error:', err);
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
          {health.checks && health.checks.length > 0 && (
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
                  {health.checks.map((check: any) => (
                    <tr key={check.name}>
                      <td>{check.name}</td>
                      <td>
                        <span class={`status-dot ${check.status === 'healthy' ? 'healthy' : check.status === 'unhealthy' ? 'unhealthy' : 'unknown'}`} />
                        {check.status}
                      </td>
                      <td>{check.latency !== undefined ? `${check.latency}ms` : '—'}</td>
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
            <div class="value">{formatNumber(stats.messages?.total ?? 0)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Storage</div>
            <div class="value">{formatBytes(stats.storage?.totalBytes ?? 0)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Protocols</div>
            <div class="value">{formatNumber(stats.protocols?.count ?? 0)}</div>
          </div>
          <div class="stat-card">
            <div class="label">WebSocket</div>
            <div class="value">{formatNumber(stats.websocket?.active ?? 0)}</div>
            <div class="sub">{formatNumber(stats.websocket?.subscriptions ?? 0)} subscriptions</div>
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
                <span class={`badge ${rateLimits.perIp?.enabled ? 'badge-success' : 'badge-muted'}`}>
                  {rateLimits.perIp?.enabled ? 'Enabled' : 'Disabled'}
                </span>
                {rateLimits.perIp?.enabled && (
                  <span style="margin-left:8px;color:var(--color-text-secondary)">
                    {rateLimits.perIp.rps} rps / {rateLimits.perIp.burst} burst
                  </span>
                )}
              </div>
              {rateLimits.perIp?.activeEntries !== undefined && (
                <div style="font-size:12px;color:var(--color-text-muted);margin-top:4px">
                  {formatNumber(rateLimits.perIp.activeEntries)} active entries
                </div>
              )}
            </div>
            {/* Per-Tenant config */}
            <div>
              <div style="font-size:12px;font-weight:600;color:var(--color-text-secondary);margin-bottom:8px">Per-Tenant</div>
              <div style="font-size:13px">
                <span class={`badge ${rateLimits.perTenant?.enabled ? 'badge-success' : 'badge-muted'}`}>
                  {rateLimits.perTenant?.enabled ? 'Enabled' : 'Disabled'}
                </span>
                {rateLimits.perTenant?.enabled && (
                  <span style="margin-left:8px;color:var(--color-text-secondary)">
                    {rateLimits.perTenant.rps} rps / {rateLimits.perTenant.burst} burst
                  </span>
                )}
              </div>
              {rateLimits.perTenant?.activeEntries !== undefined && (
                <div style="font-size:12px;color:var(--color-text-muted);margin-top:4px">
                  {formatNumber(rateLimits.perTenant.activeEntries)} active entries
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
