import type { DwnRpc, DwnRpcRequest, DwnRpcResponse } from '@enbox/dwn-clients';
import { HttpDwnRpcClient } from '@enbox/dwn-clients';
import log from 'loglevel';

/**
 * Health status for a host.
 */
interface HostHealth {
  consecutiveFailures: number;
  lastFailureTime: number;
  /** Epoch ms when the host becomes eligible for retry after backoff. */
  retryAfter: number;
}

/**
 * Connection pool for outbound RPC connections to peer DWN endpoints.
 *
 * Keyed by host (URL origin), not by tenant. This is critical for scaling:
 * 100K tenants across 500 distinct providers = ~500 connections, not 100K.
 *
 * Uses @enbox/dwn-clients HttpDwnRpcClient for the underlying HTTP transport.
 */
export class ConnectionPool implements DwnRpc {
  #clients: Map<string, DwnRpc> = new Map();
  #health: Map<string, HostHealth> = new Map();

  /** Maximum consecutive failures before a host is considered unreachable. */
  static readonly MAX_CONSECUTIVE_FAILURES = 5;

  /** Base backoff for unreachable hosts: 30 seconds. */
  static readonly BASE_BACKOFF_MS = 30_000;

  /** Maximum backoff: 10 minutes. */
  static readonly MAX_BACKOFF_MS = 600_000;

  get transportProtocols(): string[] {
    return ['http:', 'https:'];
  }

  /**
   * Send a DWN request, reusing or creating a client for the target host.
   */
  async sendDwnRequest(request: DwnRpcRequest): Promise<DwnRpcResponse> {
    const origin = new URL(request.dwnUrl).origin;

    // Check if host is in backoff
    const health = this.#health.get(origin);
    if (health && health.retryAfter > Date.now()) {
      throw new Error(`Host ${origin} is in backoff (${health.consecutiveFailures} consecutive failures)`);
    }

    const client = this.#getOrCreateClient(origin);

    try {
      const response = await client.sendDwnRequest(request);

      // Reset health on success
      if (health) {
        this.#health.delete(origin);
      }

      return response;
    } catch (err) {
      this.#recordFailure(origin);
      throw err;
    }
  }

  /**
   * Check if a host is currently healthy (not in backoff).
   */
  isHostHealthy(url: string): boolean {
    const origin = new URL(url).origin;
    const health = this.#health.get(origin);
    if (!health) return true;
    return health.retryAfter <= Date.now();
  }

  /**
   * Get the number of consecutive failures for a host.
   */
  getHostFailures(url: string): number {
    const origin = new URL(url).origin;
    return this.#health.get(origin)?.consecutiveFailures ?? 0;
  }

  /**
   * Reset health tracking for a host. Useful when a host comes back online.
   */
  resetHostHealth(url: string): void {
    const origin = new URL(url).origin;
    this.#health.delete(origin);
  }

  /**
   * Get the number of active host connections.
   */
  get size(): number {
    return this.#clients.size;
  }

  #getOrCreateClient(origin: string): DwnRpc {
    let client = this.#clients.get(origin);
    if (!client) {
      client = new HttpDwnRpcClient();
      this.#clients.set(origin, client);
    }
    return client;
  }

  #recordFailure(origin: string): void {
    const existing = this.#health.get(origin);
    const failures = (existing?.consecutiveFailures ?? 0) + 1;

    // Exponential backoff: 30s * 2^(failures - 1), capped at 10 minutes
    const backoffMs = Math.min(
      ConnectionPool.BASE_BACKOFF_MS * Math.pow(2, failures - 1),
      ConnectionPool.MAX_BACKOFF_MS,
    );

    this.#health.set(origin, {
      consecutiveFailures : failures,
      lastFailureTime     : Date.now(),
      retryAfter          : Date.now() + backoffMs,
    });

    if (failures >= ConnectionPool.MAX_CONSECUTIVE_FAILURES) {
      log.warn(`ConnectionPool: host ${origin} has ${failures} consecutive failures, ` +
        `backoff until ${new Date(Date.now() + backoffMs).toISOString()}`);
    }
  }
}
