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
