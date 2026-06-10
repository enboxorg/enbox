import type { Dwn } from '@enbox/dwn-sdk-js';
import type { ServerWebSocket } from 'bun';

import type { ActivityLog } from './admin/activity-log.js';
import type { AdminStore } from './admin/admin-store.js';
import type { ConnectionManager } from './connection/connection-manager.js';
import type { DwnServerConfig } from './config.js';
import type { MessageProcessedHook } from './message-processed-hook.js';
import type { RateLimiter } from './rate-limiter.js';
import type { RegistrationStore } from './registration/registration-store.js';
import type { HttpApi, WsData } from './http-api.js';

import { InMemoryConnectionManager } from './connection/connection-manager.js';

export type WsApiOptions = {
  activityLog? : ActivityLog;
  adminStore? : AdminStore;
  config? : DwnServerConfig;
  connectionManager? : ConnectionManager;
  maxInFlight? : number;
  messageProcessedHooks? : MessageProcessedHook[];
  registrationStore? : RegistrationStore;
  tenantRateLimiter? : RateLimiter;
};

type LegacyWsApiOptions = Pick<
  WsApiOptions,
  'adminStore' | 'config' | 'messageProcessedHooks' | 'registrationStore' | 'tenantRateLimiter'
>;

export class WsApi {
  dwn: Dwn;
  readonly #connectionManager: ConnectionManager;

  constructor(httpApi: HttpApi, dwn: Dwn, options?: WsApiOptions);
  constructor(
    httpApi: HttpApi,
    dwn: Dwn,
    connectionManager?: ConnectionManager,
    maxInFlight?: number,
    activityLog?: ActivityLog,
    options?: LegacyWsApiOptions,
  );
  constructor(
    httpApi: HttpApi,
    dwn: Dwn,
    optionsOrConnectionManager?: WsApiOptions | ConnectionManager,
    maxInFlight?: number,
    activityLog?: ActivityLog,
    legacyOptions?: LegacyWsApiOptions,
  ) {
    const options = normalizeWsApiOptions(optionsOrConnectionManager, maxInFlight, activityLog, legacyOptions);
    const config = options.config ?? httpApi.config;

    this.dwn = dwn;
    this.#connectionManager = options.connectionManager ||
      new InMemoryConnectionManager(
        dwn, new Map(), options.maxInFlight ?? config.maxInFlight, options.activityLog,
        options.adminStore ?? httpApi.adminStore,
        options.registrationStore ?? httpApi.registrationStore,
        config,
        options.tenantRateLimiter ?? httpApi.tenantRateLimiter,
        options.messageProcessedHooks ?? httpApi.messageProcessedHooks,
      );

    // Wire up the WebSocket open event from Bun.serve() to the connection manager.
    httpApi.onWebSocketConnection = (ws: ServerWebSocket<WsData>): void => {
      this.#connectionManager.connect(ws);
    };
  }

  start(): void {
    // No additional setup needed — Bun.serve() handles WebSocket lifecycle.
  }

  /**
   * Returns the connection manager. Used by the admin API for connection introspection.
   */
  get connectionManager(): ConnectionManager {
    return this.#connectionManager;
  }

  async close(): Promise<void> {
    await this.#connectionManager.closeAll();
  }
}

function normalizeWsApiOptions(
  optionsOrConnectionManager?: WsApiOptions | ConnectionManager,
  maxInFlight?: number,
  activityLog?: ActivityLog,
  legacyOptions?: LegacyWsApiOptions,
): WsApiOptions {
  if (optionsOrConnectionManager === undefined) {
    return {};
  }

  if (!isConnectionManager(optionsOrConnectionManager)) {
    return optionsOrConnectionManager;
  }

  return {
    ...legacyOptions,
    activityLog,
    connectionManager: optionsOrConnectionManager,
    maxInFlight,
  };
}

function isConnectionManager(value: WsApiOptions | ConnectionManager): value is ConnectionManager {
  return 'connect' in value &&
    'closeAll' in value &&
    'getConnectionCount' in value &&
    'getSubscriptionCount' in value;
}
