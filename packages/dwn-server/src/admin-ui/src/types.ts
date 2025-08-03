// API Response Types
export interface ServerStats {
  server: {
    version: string;
    uptime: number;
    memory: {
      rss: number;
      heapTotal: number;
      heapUsed: number;
      external: number;
      arrayBuffers: number;
    };
    config: {
      webSocketSupport: boolean;
      registrationRequired: boolean;
      baseUrl: string;
    };
  };
  tenants?: {
    count: number;
    active: number;
  };
  stores: {
    messageStore: string;
    dataStore: string;
    eventLog: string;
    resumableTaskStore: string;
  };
}

export interface Tenant {
  did: string;
  termsOfServiceHash?: string;
  isActive: boolean;
  inactiveReason?: string;
}

export interface TenantDetails extends Tenant {
  stats?: {
    messageCount: string | number;
    dataSize: string | number;
    lastActivity: string | number;
  };
}

// Component Props Types
export interface LoginFormProps {
  onLogin: (token: string) => Promise<void>;
}

export interface ServerStatsProps {
  stats: ServerStats;
}

export interface TenantsListProps {
  tenants: Tenant[];
  onSelectTenant: (tenant: Tenant) => void;
  onRefresh: () => void;
}

export interface TenantDetailsModalProps {
  tenant: TenantDetails;
  onClose: () => void;
  onDelete: (did: string) => Promise<void>;
}

export interface DashboardProps {
  apiClient: AdminApiClient;
}

// Import the actual AdminApiClient class
export { AdminApiClient } from './api-client.js';