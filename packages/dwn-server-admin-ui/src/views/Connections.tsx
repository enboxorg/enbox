import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { api } from '../lib/api';
import { formatTimestamp } from '../lib/format';

type Subscription = {
  id        : string;
  inflight  : number;
  buffered  : number;
};

type Connection = {
  id            : string;
  connectedAt   : string;
  subscriptions : Subscription[];
};

export function Connections({ path }: { path?: string }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchConnections = async () => {
    try {
      const data = await api.getConnections();
      setConnections(data.connections ?? data ?? []);
      setError('');
    } catch (err: any) {
      setError(err.message || 'Failed to load connections');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConnections();
    const interval = setInterval(fetchConnections, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between">
        <div>
          <h2>Connections</h2>
          <p class="description">Active WebSocket connections</p>
        </div>
        <button class="btn" onClick={fetchConnections}>Refresh</button>
      </div>

      {error && <div class="card" style="color:var(--color-danger)">{error}</div>}

      {loading ? (
        <div class="loading">Loading connections...</div>
      ) : connections.length === 0 ? (
        <div class="empty-state">No active WebSocket connections.</div>
      ) : (
        <div class="card">
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Connected At</th>
                  <th>Subscriptions</th>
                  <th>Subscription Details</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((conn) => (
                  <tr key={conn.id}>
                    <td class="mono">{conn.id.slice(0, 12)}</td>
                    <td>{formatTimestamp(conn.connectedAt)}</td>
                    <td>{conn.subscriptions?.length ?? 0}</td>
                    <td>
                      {conn.subscriptions && conn.subscriptions.length > 0 ? (
                        <table style="margin:0;font-size:12px">
                          <thead>
                            <tr>
                              <th style="padding:2px 8px">Sub ID</th>
                              <th style="padding:2px 8px">Inflight</th>
                              <th style="padding:2px 8px">Buffered</th>
                            </tr>
                          </thead>
                          <tbody>
                            {conn.subscriptions.map((sub) => (
                              <tr key={sub.id}>
                                <td class="mono" style="padding:2px 8px">{sub.id.slice(0, 10)}</td>
                                <td style="padding:2px 8px">{sub.inflight}</td>
                                <td style="padding:2px 8px">{sub.buffered}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <span style="color:var(--color-text-muted)">None</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
