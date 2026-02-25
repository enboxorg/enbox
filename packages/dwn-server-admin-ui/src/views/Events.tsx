import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../lib/api';
import { formatBytes, formatTimestamp, truncateDid } from '../lib/format';

type DwnEvent = {
  timestamp   : string;
  tenant      : string;
  interface   : string;
  method      : string;
  status      : number;
  transport   : string;
  dataSize?   : number;
};

type EventsResponse = {
  events : DwnEvent[];
  cursor : number;
};

function statusBadgeClass(code: number): string {
  if (code >= 200 && code < 300) { return 'badge badge-success'; }
  if (code >= 400 && code < 500) { return 'badge badge-warning'; }
  if (code >= 500)               { return 'badge badge-danger'; }
  return 'badge badge-muted';
}

function transportBadgeClass(transport: string): string {
  return transport === 'ws' ? 'badge badge-info' : 'badge badge-muted';
}

export function Events({ path }: { path?: string }) {
  const [events, setEvents] = useState<DwnEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [transportFilter, setTransportFilter] = useState<'all' | 'http' | 'ws'>('all');
  const cursorRef = useRef<number | undefined>(undefined);

  const fetchEvents = async (initial: boolean) => {
    try {
      const opts: { limit?: number; since?: number } = { limit: 50 };
      if (!initial && cursorRef.current !== undefined) {
        opts.since = cursorRef.current;
      }
      const data: EventsResponse = await api.getEvents(opts);
      const incoming = data.events ?? [];

      if (data.cursor !== undefined) {
        cursorRef.current = data.cursor;
      }

      if (initial) {
        setEvents(incoming);
      } else if (incoming.length > 0) {
        setEvents((prev) => [...incoming, ...prev].slice(0, 200));
      }
      setError('');
    } catch (err: any) {
      setError(err.message || 'Failed to load events');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents(true);
    const interval = setInterval(() => fetchEvents(false), 3000);
    return () => clearInterval(interval);
  }, []);

  const filtered = transportFilter === 'all'
    ? events
    : events.filter((e) => e.transport === transportFilter);

  return (
    <div>
      <div class="page-header">
        <h2>Events</h2>
        <p class="description">Recent DWN activity</p>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:12px;color:var(--color-text-secondary)">Transport:</span>
          {(['all', 'http', 'ws'] as const).map((t) => (
            <button
              key={t}
              class={`btn btn-sm${transportFilter === t ? ' btn-primary' : ''}`}
              onClick={() => setTransportFilter(t)}
            >
              {t === 'all' ? 'All' : t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {error && <div class="card" style="color:var(--color-danger)">{error}</div>}

      {loading ? (
        <div class="loading">Loading events...</div>
      ) : filtered.length === 0 ? (
        <div class="empty-state">No events to display.</div>
      ) : (
        <div class="card">
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Tenant</th>
                  <th>Interface</th>
                  <th>Method</th>
                  <th>Status</th>
                  <th>Transport</th>
                  <th>Data Size</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((evt, i) => (
                  <tr key={`${evt.timestamp}-${i}`}>
                    <td style="white-space:nowrap">{formatTimestamp(evt.timestamp)}</td>
                    <td class="mono" title={evt.tenant}>{truncateDid(evt.tenant, 30)}</td>
                    <td>{evt.interface}</td>
                    <td>{evt.method}</td>
                    <td><span class={statusBadgeClass(evt.status)}>{evt.status}</span></td>
                    <td><span class={transportBadgeClass(evt.transport)}>{evt.transport.toUpperCase()}</span></td>
                    <td>{evt.dataSize !== undefined ? formatBytes(evt.dataSize) : '\u2014'}</td>
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
