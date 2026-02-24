import type { DidResolver } from '@enbox/dids';
import type { DwnEndpointInfo } from '../endpoint-resolver.js';
import type { GenericMessage } from '@enbox/dwn-sdk-js';
import log from 'loglevel';
import type { RelayConfig } from '../config.js';
import { resolveEndpoints } from '../endpoint-resolver.js';
import type { DwnRpc, DwnRpcRequest } from '@enbox/dwn-clients';

/**
 * WriteForwarder forwards incoming RecordsWrite and RecordsDelete messages
 * to the tenant's other DWN endpoints.
 *
 * This complements the DeliveryService in @enbox/dwn-server (which handles
 * forwarding when `DWN_FORWARDING_ENABLED=true`). The WriteForwarder exists
 * for relay-specific behavior:
 * - Awareness of cache vs full endpoint distinction
 * - Integration with the ServerSyncEngine's priority queue (queue tenant
 *   for immediate sync after forwarding)
 * - Deduplication scoped to the relay process
 *
 * Per the delivery spec's forwarding semantics:
 * - The original signed message is sent unmodified
 * - 409 (conflict/duplicate) from a peer is treated as success
 * - Recently forwarded messageCids are tracked to avoid redundant sends
 */
export class WriteForwarder {
  #didResolver: DidResolver;
  #rpcClient: DwnRpc;
  #config: RelayConfig;
  #onTenantWrite?: (tenant: string) => void;

  /** Recently forwarded messageCids for deduplication (TTL-based). */
  #forwardedCids: Map<string, number> = new Map();

  /** Deduplication cache TTL: 60 seconds. */
  static readonly DEDUP_TTL_MS = 60_000;

  /** Maximum dedup cache size before lazy eviction. */
  static readonly DEDUP_MAX_SIZE = 10_000;

  constructor(options: {
    didResolver: DidResolver;
    rpcClient: DwnRpc;
    config: RelayConfig;
    /** Callback invoked when a write is processed for a tenant (for sync prioritization). */
    onTenantWrite?: (tenant: string) => void;
  }) {
    this.#didResolver = options.didResolver;
    this.#rpcClient = options.rpcClient;
    this.#config = options.config;
    this.#onTenantWrite = options.onTenantWrite;
  }

  /**
   * Forward a message to the tenant's peer endpoints.
   * This is fire-and-forget — errors are logged but do not propagate.
   *
   * @param tenant - The DID of the tenant whose endpoints to forward to.
   * @param message - The original signed DWN message.
   * @param messageCid - The CID of the message (for deduplication).
   * @param data - Optional record data stream for RecordsWrite.
   */
  async forward(
    tenant: string,
    message: GenericMessage,
    messageCid: string,
    data?: ReadableStream<Uint8Array>,
  ): Promise<void> {
    // Deduplication check
    if (this.#isRecentlyForwarded(messageCid)) {
      return;
    }
    this.#markForwarded(messageCid);

    // Notify sync engine of tenant write activity
    this.#onTenantWrite?.(tenant);

    // Resolve peer endpoints
    const endpoints = await resolveEndpoints(tenant, this.#didResolver);
    const peers = endpoints.filter(ep => ep.url !== this.#config.selfUrl);

    if (peers.length === 0) {
      return;
    }

    // Forward to all peers in parallel, full endpoints first
    const sorted = [...peers].sort((a, b) => {
      if (a.isFull && !b.isFull) {
        return -1;
      }
      if (!a.isFull && b.isFull) {
        return 1;
      }
      return 0;
    });

    const promises = sorted.map(endpoint => this.#sendToEndpoint(tenant, endpoint, message, data));
    const results = await Promise.allSettled(promises);

    const successes = results.filter(r => r.status === 'fulfilled' && r.value).length;
    log.debug(`WriteForwarder: forwarded ${messageCid} to ${successes}/${sorted.length} peers for tenant ${tenant}`);
  }

  /**
   * Send a message to a single peer endpoint.
   * Returns true if the forward was successful (including 409 duplicate).
   */
  async #sendToEndpoint(
    tenant: string,
    endpoint: DwnEndpointInfo,
    message: GenericMessage,
    data?: ReadableStream<Uint8Array>,
  ): Promise<boolean> {
    const maxRetries = 2;
    const retryDelays = [1_000, 5_000];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const request: DwnRpcRequest = {
          dwnUrl    : endpoint.url,
          targetDid : tenant,
          message   : message,
          data      : data,
        };

        const response = await this.#rpcClient.sendDwnRequest(request);
        const code = response.status?.code ?? 0;

        // 202 (accepted) or 409 (duplicate) are both success
        if (code === 202 || code === 409) {
          return true;
        }

        // Non-retryable error
        if (code >= 400 && code < 500 && code !== 408 && code !== 429) {
          log.debug(`WriteForwarder: non-retryable ${code} from ${endpoint.url}`);
          return false;
        }

        // Retryable — fall through to retry delay
      } catch (err) {
        log.debug(`WriteForwarder: error forwarding to ${endpoint.url} (attempt ${attempt}):`, err);
      }

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
      }
    }

    return false;
  }

  #isRecentlyForwarded(messageCid: string): boolean {
    const timestamp = this.#forwardedCids.get(messageCid);
    if (timestamp === undefined) {
      return false;
    }
    if (Date.now() - timestamp > WriteForwarder.DEDUP_TTL_MS) {
      this.#forwardedCids.delete(messageCid);
      return false;
    }
    return true;
  }

  #markForwarded(messageCid: string): void {
    // Lazy eviction when cache is too large
    if (this.#forwardedCids.size >= WriteForwarder.DEDUP_MAX_SIZE) {
      const now = Date.now();
      for (const [cid, ts] of this.#forwardedCids) {
        if (now - ts > WriteForwarder.DEDUP_TTL_MS) {
          this.#forwardedCids.delete(cid);
        }
      }
    }
    this.#forwardedCids.set(messageCid, Date.now());
  }
}
