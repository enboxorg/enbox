import { Counter, Gauge, Histogram } from 'prom-client';

// ---------------------------------------------------------------------------
// Existing metrics
// ---------------------------------------------------------------------------

export const requestCounter = new Counter({
  name       : 'dwn_requests_total',
  help       : 'all dwn requests processed',
  labelNames : ['method', 'status', 'error'],
});

export const responseHistogram = new Histogram({
  name       : 'http_response',
  help       : 'response histogram',
  buckets    : [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  labelNames : ['route', 'code'],
});

// ---------------------------------------------------------------------------
// Enhanced gauges — updated periodically by AdminApi.startMetricsUpdater()
// ---------------------------------------------------------------------------

/** Number of active (registered) tenants. */
export const activeTenants = new Gauge({
  name : 'dwn_active_tenants',
  help : 'number of active registered tenants',
});

/** Total messages stored across all tenants. */
export const totalMessages = new Gauge({
  name : 'dwn_total_messages',
  help : 'total messages stored across all tenants',
});

/** Total data storage in bytes across all tenants. */
export const totalDataBytes = new Gauge({
  name : 'dwn_total_data_bytes',
  help : 'total data storage bytes across all tenants',
});

/** Number of active WebSocket connections. */
export const websocketConnections = new Gauge({
  name : 'dwn_websocket_connections',
  help : 'number of active websocket connections',
});

/** Number of active WebSocket subscriptions. */
export const websocketSubscriptions = new Gauge({
  name : 'dwn_websocket_subscriptions',
  help : 'number of active websocket subscriptions',
});

// ---------------------------------------------------------------------------
// Enhanced counters — incremented per-request
// ---------------------------------------------------------------------------

/** Total data bytes written via RecordsWrite, labeled by interface + method. */
export const requestDataBytesTotal = new Counter({
  name       : 'dwn_request_data_bytes_total',
  help       : 'total data bytes processed in DWN requests',
  labelNames : ['interface', 'method'],
});
