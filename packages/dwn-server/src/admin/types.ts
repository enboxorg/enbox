/**
 * Summary of a tenant for list endpoints.
 */
export type AdminTenantSummary = {
  did : string;
  messageCount : number;
  dataStorageBytes : number;
};

/**
 * Detailed information about a single tenant.
 */
export type AdminTenantDetail = {
  did : string;
  isActive : boolean;
  suspended : boolean;
  registration : {
    termsOfServiceHash? : string;
  } | undefined;
  storage : {
    messageCount : number;
    dataStorageBytes : number;
    protocolCount : number;
  };
  protocols : string[];
};

/**
 * Per-tenant storage and usage statistics.
 */
export type TenantStats = {
  messageCount : number;
  dataStorageBytes : number;
  protocolCount : number;
  protocols : string[];
};

/**
 * Global server statistics.
 */
export type GlobalStats = {
  tenantCount : number;
  totalMessages : number;
  totalDataBytes : number;
  totalProtocols : number;
};

/**
 * Health check result for a single backend component.
 */
export type HealthCheckResult = {
  status : 'healthy' | 'unhealthy';
  latencyMs : number;
  error? : string;
};

/**
 * Full deep health check response.
 */
export type AdminHealthCheck = {
  status : 'healthy' | 'unhealthy';
  uptime : number;
  version : string | undefined;
  checks : Record<string, HealthCheckResult>;
};

/**
 * Server statistics response.
 */
export type AdminServerStats = {
  tenants : {
    total : number;
    suspended : number;
  };
  storage : {
    totalMessages : number;
    totalDataBytes : number;
    totalProtocols : number;
  };
  connections : {
    websocket : {
      active : number;
      subscriptions : number;
    };
  };
  registration : {
    proofOfWorkEnabled : boolean;
  };
  uptime : number;
};

/**
 * Paginated response wrapper.
 */
export type PaginatedResponse<T> = {
  data : T[];
  cursor? : string;
  totalCount : number;
};

/**
 * A single DWN activity event captured by the in-memory ring buffer.
 */
export type AdminActivityEvent = {
  /** Monotonically increasing event ID (used as cursor). */
  id : number;
  /** ISO-8601 timestamp of the event. */
  timestamp : string;
  /** The tenant DID the request targeted. */
  tenant : string;
  /** DWN interface (e.g. `Records`, `Protocols`, `Events`). */
  interface : string;
  /** DWN method (e.g. `Write`, `Query`, `Read`, `Subscribe`). */
  method : string;
  /** DWN status code returned (e.g. 200, 202, 401). */
  statusCode : number;
  /** Transport used (`http` or `ws`). */
  transport : 'http' | 'ws';
  /** Data size in bytes (if applicable). */
  dataSizeBytes? : number;
};

/**
 * Snapshot of a single subscription's flow control state.
 */
export type AdminSubscriptionSnapshot = {
  /** Subscription JSON-RPC ID. */
  id : string | number;
  /** Number of events sent but not yet acknowledged. */
  inflight : number;
  /** Number of events buffered waiting for the window to open. */
  buffered : number;
};

/**
 * Snapshot of a single WebSocket connection for the admin inspector.
 */
export type AdminConnectionSnapshot = {
  /** Unique connection identifier. */
  id : string;
  /** ISO-8601 timestamp when the connection was established. */
  connectedAt : string;
  /** Number of active subscriptions on this connection. */
  subscriptionCount : number;
  /** Per-subscription flow control state. */
  subscriptions : AdminSubscriptionSnapshot[];
};
