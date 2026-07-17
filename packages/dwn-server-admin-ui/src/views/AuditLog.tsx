import { useState, useEffect } from 'preact/hooks';
import { api } from '../lib/api';
import { formatTimestamp, truncateDid } from '../lib/format';

type AuditEntry = {
  id        : string;
  timestamp : string;
  actor     : string;
  action    : string;
  target    : string;
  detail    : string;
};

type AuditResponse = {
  entries : AuditEntry[];
  cursor  : number;
  total?  : number;
};

type Filters = {
  action : string;
  target : string;
  since  : string;
};

export function AuditLog({ path }: { path?: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({ action: '', target: '', since: '' });

  const fetchAudit = async (append = false) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }

    try {
      const opts: { limit: number; cursor?: number; action?: string; target?: string; since?: string } = { limit: 50 };
      if (append && cursor !== undefined) {
        opts.cursor = cursor;
      }
      if (filters.action.trim()) { opts.action = filters.action.trim(); }
      if (filters.target.trim()) { opts.target = filters.target.trim(); }
      if (filters.since)         { opts.since = new Date(filters.since).toISOString(); }

      const data: AuditResponse = await api.getAudit(opts);
      const incoming = data.entries ?? [];

      if (append) {
        setEntries((prev) => [...prev, ...incoming]);
      } else {
        setEntries(incoming);
        if (data.total !== undefined) {
          setTotal(data.total);
        }
      }

      setCursor(data.cursor);
      setError('');
    } catch (err: any) {
      setError(err.message || 'Failed to load audit log');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => { fetchAudit(); }, []);

  const handleApplyFilters = () => {
    setCursor(undefined);
    setTotal(undefined);
    fetchAudit(false);
  };

  const toggleDetail = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const auditContent = entries.length === 0 ? (
    <div class="empty-state">No audit entries found.</div>
  ) : (
    <div class="card">
      {total !== undefined && (
        <div style="font-size:12px;color:var(--color-text-secondary);margin-bottom:12px">
          Total entries: {total}
        </div>
      )}
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Timestamp</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td class="mono">{entry.id}</td>
                <td style="white-space:nowrap">{formatTimestamp(entry.timestamp)}</td>
                <td>{entry.actor}</td>
                <td class="mono">{entry.action}</td>
                <td class="mono" title={entry.target}>{truncateDid(entry.target, 30)}</td>
                <td>
                  {entry.detail && entry.detail.length > 60 ? (
                    <button
                      type="button"
                      onClick={() => toggleDetail(entry.id)}
                      style="cursor:pointer;color:var(--color-primary);background:none;border:none;padding:0;font:inherit"
                      title={expandedId === entry.id ? 'Click to collapse' : 'Click to expand'}
                    >
                      {expandedId === entry.id
                        ? entry.detail
                        : entry.detail.slice(0, 60) + '...'}
                    </button>
                  ) : (
                    <span>{entry.detail || '\u2014'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cursor !== undefined && (
        <div class="pagination">
          <span class="info">
            Showing {entries.length} entries{total === undefined ? '' : ` of ${total}`}
          </span>
          <button class="btn" onClick={() => fetchAudit(true)} disabled={loadingMore}>
            {loadingMore ? 'Loading...' : 'Load More'}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div>
      <div class="page-header">
        <h2>Audit Log</h2>
        <p class="description">Admin action history</p>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
          <div class="form-group" style="margin-bottom:0;flex:1;min-width:160px">
            <label htmlFor="audit-filter-action">Action</label>
            <input
              id="audit-filter-action"
              type="text"
              placeholder="e.g. tenant.*"
              value={filters.action}
              onInput={(e: Event) =>
                setFilters((f) => ({ ...f, action: (e.target as HTMLInputElement).value }))
              }
            />
          </div>
          <div class="form-group" style="margin-bottom:0;flex:1;min-width:160px">
            <label htmlFor="audit-filter-target">Target (DID)</label>
            <input
              id="audit-filter-target"
              type="text"
              placeholder="did:dht:..."
              value={filters.target}
              onInput={(e: Event) =>
                setFilters((f) => ({ ...f, target: (e.target as HTMLInputElement).value }))
              }
            />
          </div>
          <div class="form-group" style="margin-bottom:0;flex:1;min-width:160px">
            <label htmlFor="audit-filter-since">Since</label>
            <input
              id="audit-filter-since"
              type="datetime-local"
              value={filters.since}
              onInput={(e: Event) =>
                setFilters((f) => ({ ...f, since: (e.target as HTMLInputElement).value }))
              }
            />
          </div>
          <button class="btn btn-primary" onClick={handleApplyFilters} style="height:34px">
            Apply Filters
          </button>
        </div>
      </div>

      {error && <div class="card" style="color:var(--color-danger)">{error}</div>}

      {loading ? (
        <div class="loading">Loading audit log...</div>
      ) : auditContent}
    </div>
  );
}
