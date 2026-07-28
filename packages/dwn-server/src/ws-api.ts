import type { Dwn } from '@enbox/dwn-sdk-js';
import type { ServerWebSocket } from 'bun';

import type { ActivityLog } from './admin/activity-log.js';
import type { ConnectionManager } from './connection/connection-manager.js';
import type { HttpApi, WsData } from './http-api.js';

import { InMemoryConnectionManager } from './connection/connection-manager.js';

export type WsApiOptions = {
  activityLog? : ActivityLog;
};

export class WsApi {
  readonly #connectionManager: ConnectionManager;

  constructor(httpApi: HttpApi, dwn: Dwn, options: WsApiOptions = {}) {
    const config = httpApi.config;

    this.#connectionManager = new InMemoryConnectionManager(dwn, {
      activityLog           : options.activityLog,
      adminStore            : httpApi.adminStore,
      ipRateLimiter         : httpApi.ipRateLimiter,
      maxInFlight           : config.maxInFlight,
      maxSubscriptions      : config.webSocketMaxSubscriptionsPerConnection,
      messageProcessedHooks : httpApi.messageProcessedHooks,
      registrationStore     : httpApi.registrationStore,
      serverConfig          : config,
      tenantRateLimiter     : httpApi.tenantRateLimiter,
    });

    // Wire up the WebSocket open event from Bun.serve() to the connection manager.
    httpApi.onWebSocketConnection = (ws: ServerWebSocket<WsData>): void => {
      this.#connectionManager.connect(ws);
    };
  }

  /**
   * Returns the connection manager. Used by the admin API for connection introspection.
   */
  get connectionManager(): ConnectionManager {
    return this.#connectionManager;
  }

  /**
   * Closes live local-node WebSocket connections authenticated by the given pairing token.
   */
  async closeLocalNodeConnectionsByToken(token: string): Promise<number> {
    return this.#connectionManager.closeLocalNodeConnectionsByToken(token);
  }

  async close(): Promise<void> {
    await this.#connectionManager.closeAll();
  }
}
