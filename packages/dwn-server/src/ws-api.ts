import type { ActivityLog } from './admin/activity-log.js';
import type { Dwn } from '@enbox/dwn-sdk-js';
import type { ServerWebSocket } from 'bun';

import type { ConnectionManager } from './connection/connection-manager.js';
import type { HttpApi, WsData } from './http-api.js';

import { InMemoryConnectionManager } from './connection/connection-manager.js';

export class WsApi {
  dwn: Dwn;
  #connectionManager: ConnectionManager;

  constructor(
    httpApi: HttpApi, dwn: Dwn, connectionManager?: ConnectionManager,
    maxInFlight?: number, activityLog?: ActivityLog,
  ) {
    this.dwn = dwn;
    this.#connectionManager = connectionManager ||
      new InMemoryConnectionManager(dwn, new Map(), maxInFlight, activityLog);

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
