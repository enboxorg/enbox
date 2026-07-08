import type { DwnServerConfig } from './config.js';
import type { DidDocument, DidResolver } from '@enbox/dids';
import type { Dwn, GenericMessage, ProtocolDefinition, ProtocolRuleSet, RecordsQueryReplyEntry, RecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type { MessageProcessedContext, MessageProcessedHook } from './message-processed-hook.js';

import log from 'loglevel';

import { createJsonRpcRequest } from '@enbox/dwn-clients';
import { sleep } from '@enbox/common';
import { DataStream, DwnConstant, DwnInterfaceName, DwnMethodName, Encoder, getRuleSetAtPath, Message, Records } from '@enbox/dwn-sdk-js';

/** Strips trailing `/` characters without regex (avoids ReDoS scanners). */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) { // 47 === '/'
    end--;
  }
  return end === value.length ? value : value.slice(0, end);
}

/**
 * Type guard for `RecordsWrite` messages as read back from the message store,
 * which optionally carry the record data inline as `encodedData`
 * (`RecordsQueryReplyEntry`).
 */
function isStoredRecordsWrite(message: GenericMessage): message is RecordsQueryReplyEntry {
  return Records.isRecordsWrite(message);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Describes a DWN service endpoint extracted from a DID document.
 */
type DwnEndpoint = {
  /** The full URL of the DWN service endpoint. */
  url: string;
  /** Whether this endpoint is a full node (retains all data). Cache nodes have `isFull: false`. */
  isFull: boolean;
};

/**
 * Result of resolving delivery targets for a record at a given protocol path.
 * Each entry maps a target DID to its DWN endpoints.
 */
type DeliveryTarget = {
  did: string;
  endpoints: DwnEndpoint[];
};

// ---------------------------------------------------------------------------
// DeliveryService
// ---------------------------------------------------------------------------

/**
 * Server-side service that handles two complementary features:
 *
 * 1. **Endpoint forwarding** — When a RecordsWrite/RecordsDelete is processed,
 *    forwards the original signed message to the tenant's *other* DWN service
 *    endpoints (peer replication without the agent mediating).
 *
 * 2. **Record delivery** — When a RecordsWrite/RecordsDelete is processed at a
 *    protocol path with `$delivery`, proactively delivers to participants' DWN
 *    endpoints determined from protocol `$actions` role records.
 *
 * Both operations are fire-and-forget: failures are logged but never propagate
 * to the original request handler.
 */
export class DeliveryService implements MessageProcessedHook {

  static readonly #maxRetries = 2;
  static readonly #retryDelaysMs = [1_000, 5_000] as const;
  static readonly #requestTimeoutMs = 10_000;

  readonly #dwn: Dwn;
  readonly #didResolver: DidResolver;
  readonly #config: DwnServerConfig;
  readonly #selfBaseUrl: string;

  /**
   * Simple TTL cache for DID-document-derived endpoint lists.
   * Key: DID URI, Value: { endpoints, expiresAt }.
   */
  readonly #endpointCache = new Map<string, { endpoints: DwnEndpoint[]; expiresAt: number }>();

  /**
   * Short-lived dedup cache for recently forwarded messageCids.
   * Prevents forwarding loops when multiple providers forward to each other.
   * Key: `${targetDid}:${messageCid}`, Value: expiry timestamp.
   */
  readonly #forwardedCids = new Map<string, number>();

  private constructor(dwn: Dwn, didResolver: DidResolver, config: DwnServerConfig) {
    this.#dwn = dwn;
    this.#didResolver = didResolver;
    this.#config = config;
    this.#selfBaseUrl = stripTrailingSlashes(config.baseUrl);
  }

  /**
   * Factory method following the established server service pattern.
   */
  public static create(dwn: Dwn, didResolver: DidResolver, config: DwnServerConfig): DeliveryService {
    return new DeliveryService(dwn, didResolver, config);
  }

  // -------------------------------------------------------------------------
  // MessageProcessedHook implementation
  // -------------------------------------------------------------------------

  /**
   * Hook entry point invoked by the hooks runner after `dwn.processMessage()`.
   */
  public onMessageProcessed(context: MessageProcessedContext): void {
    this.dispatchIfNeeded(context.tenant, context.message, context.status.code);
  }

  // -------------------------------------------------------------------------
  // Public API — called from processMessage handler (fire-and-forget)
  // -------------------------------------------------------------------------

  /**
   * Evaluates whether forwarding or delivery should occur for a successfully
   * processed message, and dispatches outbound requests asynchronously.
   *
   * This method does NOT await the outbound requests — it returns immediately
   * after scheduling them.
   *
   * @param tenant   - The tenant DID that owns the DWN.
   * @param message  - The original signed DWN message.
   * @param statusCode - The reply status code from `dwn.processMessage()`.
   */
  public dispatchIfNeeded(tenant: string, message: GenericMessage, statusCode: number): void {
    // Only act on successful writes (202) and deletes (202).
    if (statusCode !== 202) {
      return;
    }

    const iface = message.descriptor.interface as string;
    const method = message.descriptor.method as string;

    // Only forward RecordsWrite and RecordsDelete messages.
    if (
      iface !== DwnInterfaceName.Records ||
      (method !== DwnMethodName.Write && method !== DwnMethodName.Delete)
    ) {
      return;
    }

    const messageCid = (message as { recordId?: string }).recordId ?? '';

    // Schedule forwarding (fire-and-forget).
    if (this.#config.forwardingEnabled) {
      this.#forwardToEndpoints(tenant, message, messageCid).catch((err: unknown): void => {
        log.error('DeliveryService: forwarding error', err);
      });
    }

    // Schedule delivery (fire-and-forget).
    if (this.#config.deliveryEnabled && method === DwnMethodName.Write) {
      this.#deliverToParticipants(tenant, message, messageCid).catch((err: unknown): void => {
        log.error('DeliveryService: delivery error', err);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Endpoint Forwarding
  // -------------------------------------------------------------------------

  /**
   * Forwards the message to the tenant's *other* DWN service endpoints.
   * The tenant's DID document is resolved to discover all DWN endpoints,
   * then the message is sent to every endpoint except this server's own URL.
   */
  async #forwardToEndpoints(tenant: string, message: GenericMessage, messageCid: string): Promise<void> {
    const endpoints = await this.#resolveDwnEndpoints(tenant);
    if (endpoints.length === 0) {
      return;
    }

    // Filter out self.
    const peerEndpoints = endpoints.filter(
      (ep: DwnEndpoint): boolean => !ep.url.startsWith(this.#selfBaseUrl),
    );

    if (peerEndpoints.length === 0) {
      return;
    }

    const concurrency = this.#config.deliveryMaxConcurrency;

    // Deduplicate: skip if this messageCid was recently forwarded to these endpoints.
    const dedupKey = `fwd:${tenant}:${messageCid}`;
    if (this.#isRecentlyForwarded(dedupKey)) {
      log.debug(`DeliveryService: skipping duplicate forward for ${messageCid}`);
      return;
    }
    this.#markForwarded(dedupKey);

    // Sort full endpoints first — ensure full nodes receive writes before cache nodes.
    peerEndpoints.sort((a: DwnEndpoint, b: DwnEndpoint): number => {
      if (a.isFull && !b.isFull) {
        return -1;
      }
      if (!a.isFull && b.isFull) {
        return 1;
      }
      return 0;
    });

    // Send to each peer endpoint with bounded concurrency.
    await this.#sendToEndpoints(peerEndpoints, tenant, message, concurrency);
  }

  // -------------------------------------------------------------------------
  // Record Delivery
  // -------------------------------------------------------------------------

  /**
   * Delivers the message to all participant DWN endpoints determined by
   * the protocol's `$delivery` directive and `$actions` role records.
   */
  async #deliverToParticipants(tenant: string, message: GenericMessage, messageCid: string): Promise<void> {
    const descriptor = message.descriptor as {
      protocol?: string;
      protocolPath?: string;
      contextId?: string;
      recipient?: string;
    };

    // Only protocol-governed records can have $delivery.
    if (!descriptor.protocol || !descriptor.protocolPath) {
      return;
    }

    // Look up the protocol definition to check for $delivery.
    const protocolDefinition = await this.#getProtocolDefinition(tenant, descriptor.protocol);
    if (!protocolDefinition) {
      return;
    }

    const ruleSet = getRuleSetAtPath(descriptor.protocolPath, protocolDefinition.structure);
    if (!ruleSet?.$delivery) {
      return;
    }

    // For 'direct' strategy: resolve targets and push.
    if (ruleSet.$delivery === 'direct') {
      const targets = await this.#resolveDeliveryTargets(
        tenant, protocolDefinition, ruleSet, descriptor.protocolPath, descriptor.contextId, descriptor.recipient,
      );

      if (targets.length === 0) {
        return;
      }

      // Filter out the tenant itself (they already have the record).
      const externalTargets = targets.filter((t: DeliveryTarget): boolean => t.did !== tenant);
      if (externalTargets.length === 0) {
        return;
      }

      const concurrency = this.#config.deliveryMaxConcurrency;
      const allEndpoints: DwnEndpoint[] = [];
      const endpointTargetMap = new Map<string, string>(); // url -> target DID

      for (const target of externalTargets) {
        for (const ep of target.endpoints) {
          allEndpoints.push(ep);
          endpointTargetMap.set(ep.url, target.did);
        }
      }

      // Deduplicate per-target.
      const uniqueEndpoints = allEndpoints.filter((ep: DwnEndpoint): boolean => {
        const targetDid = endpointTargetMap.get(ep.url)!;
        const dedupKey = `dlv:${targetDid}:${messageCid}`;
        if (this.#isRecentlyForwarded(dedupKey)) {
          return false;
        }
        this.#markForwarded(dedupKey);
        return true;
      });

      if (uniqueEndpoints.length === 0) {
        return;
      }

      // For delivery, the target is the participant DID (not the tenant).
      // We need to send to each participant's DWN with the *participant* as the target.
      await this.#sendToEndpointsGrouped(uniqueEndpoints, endpointTargetMap, tenant, message, concurrency);
    }

    // 'subscribe' strategy: no outbound push needed from the origin.
    // Participant providers are responsible for establishing RecordsSubscribe connections.
  }

  // -------------------------------------------------------------------------
  // Delivery Target Resolution
  // -------------------------------------------------------------------------

  /**
   * Resolves the set of DIDs that should receive a record at the given protocol path.
   * Targets are determined by querying role records in the tenant's DWN.
   *
   * For each `$actions` rule that references a `role`, we query for role records
   * at that role's protocol path, scoped to the record's contextId. The `recipient`
   * field of each matching role record is a participant DID.
   */
  async #resolveDeliveryTargets(
    tenant: string,
    protocolDefinition: ProtocolDefinition,
    ruleSet: ProtocolRuleSet,
    protocolPath: string,
    contextId?: string,
    recipient?: string,
  ): Promise<DeliveryTarget[]> {
    const targetDids = new Set<string>();

    // Method 1: Explicit recipient on the record itself.
    if (recipient) {
      targetDids.add(recipient);
    }

    // Method 2: Role-based discovery from $actions rules.
    const actionRules = ruleSet.$actions ?? [];

    for (const rule of actionRules) {
      // Role-based rules: query for role records at the role path.
      if (rule.role !== undefined) {
        const roleDids = await this.#queryRoleRecipients(
          tenant, protocolDefinition.protocol, rule.role, contextId,
        );
        for (const did of roleDids) {
          targetDids.add(did);
        }
      }

      // Method 3: Actor-based discovery — `who: "author"/"recipient"` + `of` path.
      // Find the ancestor record at the `of` protocol path within the same context,
      // then extract its author or recipient as a delivery target.
      if (rule.who !== undefined && rule.of !== undefined && rule.who !== 'anyone') {
        // Skip cross-protocol `of` references (e.g., "threads:thread") for now.
        if (!rule.of.includes(':')) {
          const actorDid = await this.#queryActorFromAncestor(
            tenant, protocolDefinition.protocol, rule.of, rule.who as string, contextId,
          );
          if (actorDid) {
            targetDids.add(actorDid);
          }
        }
      }
    }

    // Resolve endpoints for each target DID.
    const targets: DeliveryTarget[] = [];
    for (const did of targetDids) {
      const endpoints = await this.#resolveDwnEndpoints(did);
      if (endpoints.length > 0) {
        targets.push({ did, endpoints });
      }
    }

    return targets;
  }

  /**
   * Queries the tenant's DWN for role records at the given protocol path
   * and returns the set of unique recipient DIDs.
   */
  async #queryRoleRecipients(
    tenant: string,
    protocolUri: string,
    rolePath: string,
    contextId?: string,
  ): Promise<string[]> {
    try {
      // Build a RecordsQuery to find role records.
      const filter: Record<string, unknown> = {
        protocol     : protocolUri,
        protocolPath : rolePath,
      };

      // Scope to context if the role is nested (has ancestors).
      if (contextId !== undefined && rolePath.includes('/')) {
        // For a nested role like 'thread/participant', the role record's contextId
        // shares the same prefix as the target record's contextId.
        const roleDepth = rolePath.split('/').length - 1;
        const contextSegments = contextId.split('/');
        if (contextSegments.length >= roleDepth) {
          const contextPrefix = contextSegments.slice(0, roleDepth).join('/');
          filter.contextId = contextPrefix;
        }
      }

      // Use the DWN's processMessage to query for role records.
      const queryMessage = {
        descriptor: {
          interface        : DwnInterfaceName.Records,
          method           : DwnMethodName.Query,
          messageTimestamp : new Date().toISOString(),
          filter,
        },
      };

      const reply = await this.#dwn.processMessage(tenant, queryMessage as GenericMessage);

      if (reply.status.code !== 200 || !reply.entries) {
        return [];
      }

      // Extract unique recipient DIDs from the role records.
      const dids = new Set<string>();
      for (const entry of reply.entries) {
        const recipient = (entry as { descriptor?: { recipient?: string } }).descriptor?.recipient
          ?? (entry as { recipient?: string }).recipient;
        if (recipient) {
          dids.add(recipient);
        }
      }

      return Array.from(dids);
    } catch (err) {
      log.warn(`DeliveryService: failed to query role recipients for ${rolePath}`, err);
      return [];
    }
  }

  /**
   * Queries the tenant's DWN for the ancestor record at the given protocol path
   * (within the same context) and extracts the author or recipient DID.
   *
   * This is the delivery-side inverse of `checkActor()` in protocol authorization:
   * instead of "is this DID the author/recipient?", we ask "who IS the author/recipient?".
   *
   * @param actorType - `"author"` or `"recipient"`.
   * @returns The DID of the actor, or `undefined` if the ancestor cannot be found.
   */
  async #queryActorFromAncestor(
    tenant: string,
    protocolUri: string,
    ofPath: string,
    actorType: string,
    contextId?: string,
  ): Promise<string | undefined> {
    try {
      const filter: Record<string, unknown> = {
        protocol     : protocolUri,
        protocolPath : ofPath,
      };

      // Scope to the record's context. The `of` path identifies an ancestor,
      // so the ancestor's contextId is a prefix of (or equal to) the current
      // record's contextId. For a top-level `of` path (no slashes), the ancestor
      // IS the context root — its recordId equals the first contextId segment.
      if (contextId !== undefined) {
        const ofDepth = ofPath.split('/').length;
        const contextSegments = contextId.split('/');
        // The ancestor at depth N has a contextId formed by the first N segments.
        if (contextSegments.length >= ofDepth) {
          filter.contextId = contextSegments.slice(0, ofDepth).join('/');
        }
      }

      const queryMessage = {
        descriptor: {
          interface        : DwnInterfaceName.Records,
          method           : DwnMethodName.Query,
          messageTimestamp : new Date().toISOString(),
          filter,
        },
      };

      const reply = await this.#dwn.processMessage(tenant, queryMessage as GenericMessage);

      if (reply.status.code !== 200 || !reply.entries || reply.entries.length === 0) {
        return undefined;
      }

      const ancestor = reply.entries[0] as GenericMessage;

      if (actorType === 'author') {
        return Message.getAuthor(ancestor);
      } else if (actorType === 'recipient') {
        return (ancestor as { descriptor?: { recipient?: string } }).descriptor?.recipient;
      }

      return undefined;
    } catch (err) {
      log.warn(`DeliveryService: failed to query ancestor at ${ofPath} for actor resolution`, err);
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // DID Resolution & Endpoint Discovery
  // -------------------------------------------------------------------------

  /**
   * Resolves a DID and extracts DWN service endpoints from the DID document.
   * Results are cached with a configurable TTL.
   */
  async #resolveDwnEndpoints(did: string): Promise<DwnEndpoint[]> {
    // Check cache.
    const cached = this.#endpointCache.get(did);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.endpoints;
    }

    try {
      const resolution = await this.#didResolver.resolve(did);
      if (!resolution.didDocument) {
        return [];
      }

      const endpoints = DeliveryService.#extractDwnEndpoints(resolution.didDocument);

      // Cache the result.
      const ttlMs = this.#config.deliveryEndpointCacheTtlSeconds * 1_000;
      this.#endpointCache.set(did, { endpoints, expiresAt: Date.now() + ttlMs });

      return endpoints;
    } catch (err) {
      log.warn(`DeliveryService: failed to resolve DID ${did}`, err);
      return [];
    }
  }

  /**
   * Extracts DWN service endpoints from a DID document.
   * Looks for services of type `DecentralizedWebNode` with `serviceEndpoint` entries.
   *
   * Supports all endpoint formats:
   * - `"https://example.com"` — bare string, implicitly full
   * - `["https://a.com", "https://b.com"]` — string array, implicitly full
   * - `{ nodes: ["https://a.com"] }` — legacy object format, implicitly full
   * - `{ url: "https://a.com", dataRetention: "cache" }` — map format with explicit retention
   */
  static #extractDwnEndpoints(didDocument: DidDocument): DwnEndpoint[] {
    const endpoints: DwnEndpoint[] = [];

    if (!didDocument.service) {
      return endpoints;
    }

    for (const service of didDocument.service) {
      if (service.type !== 'DecentralizedWebNode') {
        continue;
      }

      // serviceEndpoint can be a string, string[], object with nodes, or map with url.
      const epValue = service.serviceEndpoint;

      if (typeof epValue === 'string') {
        endpoints.push({ url: stripTrailingSlashes(epValue), isFull: true });
      } else if (Array.isArray(epValue)) {
        for (const entry of epValue) {
          if (typeof entry === 'string') {
            endpoints.push({ url: stripTrailingSlashes(entry), isFull: true });
          } else if (entry && typeof entry === 'object') {
            // Map entry: { url: "...", dataRetention?: "full" | "cache" }
            const mapEntry = entry as { url?: string; dataRetention?: string };
            if (typeof mapEntry.url === 'string') {
              endpoints.push({
                url    : stripTrailingSlashes(mapEntry.url),
                isFull : mapEntry.dataRetention !== 'cache',
              });
            }
          }
        }
      } else if (epValue && typeof epValue === 'object') {
        // Legacy object format: { nodes: [...] }
        if ('nodes' in epValue) {
          const nodes = (epValue as { nodes: string[] }).nodes;
          if (Array.isArray(nodes)) {
            for (const node of nodes) {
              if (typeof node === 'string') {
                endpoints.push({ url: stripTrailingSlashes(node), isFull: true });
              }
            }
          }
        }
        // Map format at top level: { url: "...", dataRetention?: "..." }
        if ('url' in epValue) {
          const mapEntry = epValue as { url?: string; dataRetention?: string };
          if (typeof mapEntry.url === 'string') {
            endpoints.push({
              url    : stripTrailingSlashes(mapEntry.url),
              isFull : mapEntry.dataRetention !== 'cache',
            });
          }
        }
      }
    }

    return endpoints;
  }

  // -------------------------------------------------------------------------
  // Protocol Definition Lookup
  // -------------------------------------------------------------------------

  /**
   * Fetches the installed protocol definition for a given protocol URI from
   * the tenant's DWN.
   */
  async #getProtocolDefinition(tenant: string, protocolUri: string): Promise<ProtocolDefinition | undefined> {
    try {
      const queryMessage = {
        descriptor: {
          interface        : DwnInterfaceName.Protocols,
          method           : DwnMethodName.Query,
          messageTimestamp : new Date().toISOString(),
          filter           : { protocol: protocolUri },
        },
      };

      const reply = await this.#dwn.processMessage(tenant, queryMessage as GenericMessage);

      if (reply.status.code !== 200 || !reply.entries || reply.entries.length === 0) {
        return undefined;
      }

      const configMessage = reply.entries[0] as { descriptor?: { definition?: ProtocolDefinition } };
      return configMessage.descriptor?.definition;
    } catch (err) {
      log.warn(`DeliveryService: failed to query protocol definition for ${protocolUri}`, err);
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Outbound HTTP Dispatch
  // -------------------------------------------------------------------------

  /**
   * Sends a DWN message to multiple endpoints with bounded concurrency.
   * Used for forwarding where the target DID is the tenant.
   */
  async #sendToEndpoints(
    endpoints: DwnEndpoint[],
    tenant: string,
    message: GenericMessage,
    concurrency: number,
  ): Promise<void> {
    // Process in batches of `concurrency`.
    for (let i = 0; i < endpoints.length; i += concurrency) {
      const batch = endpoints.slice(i, i + concurrency);
      await Promise.allSettled(
        batch.map((ep: DwnEndpoint): Promise<void> => this.#sendMessage(ep.url, tenant, message, tenant)),
      );
    }
  }

  /**
   * Sends a DWN message to endpoints grouped by target DID.
   * Used for delivery where each endpoint maps to a specific participant DID.
   * The record data still lives in the *origin* tenant's stores, so `tenant`
   * is threaded through separately from the per-endpoint target DID.
   */
  async #sendToEndpointsGrouped(
    endpoints: DwnEndpoint[],
    endpointTargetMap: Map<string, string>,
    tenant: string,
    message: GenericMessage,
    concurrency: number,
  ): Promise<void> {
    for (let i = 0; i < endpoints.length; i += concurrency) {
      const batch = endpoints.slice(i, i + concurrency);
      await Promise.allSettled(
        batch.map((ep: DwnEndpoint): Promise<void> => {
          const targetDid = endpointTargetMap.get(ep.url)!;
          return this.#sendMessage(ep.url, targetDid, message, tenant);
        }),
      );
    }
  }

  /**
   * Sends a single DWN message to a remote endpoint via JSON-RPC over HTTP.
   * The JSON-RPC envelope rides the `dwn-request` header; for data-bearing
   * `RecordsWrite` messages the record data is sent as an
   * `application/octet-stream` request body (the same wire shape
   * `HttpDwnRpcClient.sendDwnRequest` produces), read back from the source
   * tenant's local stores since the original request stream was consumed
   * when the message was processed.
   * Follows the same retry pattern as WebhookManager.
   */
  async #sendMessage(endpointUrl: string, target: string, message: GenericMessage, sourceTenant: string): Promise<void> {
    const rpcRequest = createJsonRpcRequest(
      crypto.randomUUID(),
      'dwn.processMessage',
      { target, message },
    );

    const dataBearingWrite = Records.isRecordsWrite(message) && message.descriptor.dataSize > 0 ? message : undefined;

    const headers: Record<string, string> = {
      'content-type' : dataBearingWrite !== undefined ? 'application/octet-stream' : 'application/json',
      'dwn-request'  : JSON.stringify(rpcRequest),
    };

    for (let attempt = 0; attempt <= DeliveryService.#maxRetries; attempt++) {
      try {
        // Data streams are one-shot, so the body is re-read from local
        // storage on every attempt rather than replayed.
        let body: BodyInit = new Uint8Array(0);
        if (dataBearingWrite !== undefined) {
          const data = await this.#getRecordsWriteData(sourceTenant, dataBearingWrite);
          if (data === undefined) {
            log.warn(`DeliveryService: data for ${dataBearingWrite.recordId} is no longer available locally; skipping send to ${endpointUrl}`);
            return;
          }
          body = data;
        }

        const fetchOptions: RequestInit & { duplex?: 'half' } = {
          method: 'POST', headers, body, signal: AbortSignal.timeout(DeliveryService.#requestTimeoutMs),
        };
        if (body instanceof ReadableStream) {
          // Required by the Fetch standard for streaming request bodies.
          fetchOptions.duplex = 'half';
        }

        const response = await fetch(endpointUrl, fetchOptions);

        if (response.ok) {
          log.debug(`DeliveryService: sent to ${endpointUrl} for ${target} (${response.status})`);
          return;
        }

        // 409 means duplicate — the remote already has this message. That's success.
        if (response.status === 409) {
          log.debug(`DeliveryService: ${endpointUrl} already has message for ${target} (409)`);
          return;
        }

        log.warn(`DeliveryService: ${endpointUrl} returned ${response.status} (attempt ${attempt + 1})`);
      } catch (err) {
        log.warn(`DeliveryService: fetch error to ${endpointUrl} (attempt ${attempt + 1}):`, err);
      }

      // Wait before retry (skip wait on last attempt).
      if (attempt < DeliveryService.#maxRetries) {
        await sleep(DeliveryService.#retryDelaysMs[attempt]);
      }
    }

    log.error(`DeliveryService: delivery to ${endpointUrl} failed after ${DeliveryService.#maxRetries + 1} attempts`);
  }

  /**
   * Reads the stored record data of a data-bearing `RecordsWrite` as a stream
   * for use as the outbound request body. Data at or below
   * `DwnConstant.maxDataSizeAllowedToBeEncoded` lives as `encodedData` on the
   * stored message; larger data lives in the data store.
   *
   * Returns `undefined` when the data is no longer available locally — e.g.
   * the message was displaced by a newer write between processing and this
   * fire-and-forget send. The displacing write triggers its own dispatch, so
   * the stale send is skipped rather than retried.
   */
  async #getRecordsWriteData(tenant: string, message: RecordsWriteMessage): Promise<ReadableStream<Uint8Array> | undefined> {
    const { dataCid, dataSize } = message.descriptor;

    if (dataSize <= DwnConstant.maxDataSizeAllowedToBeEncoded) {
      const messageCid = await Message.getCid(message);
      const storedMessage = await this.#dwn.storage.messageStore.get(tenant, messageCid);
      if (storedMessage === undefined || !isStoredRecordsWrite(storedMessage) || storedMessage.encodedData === undefined) {
        return undefined;
      }
      return DataStream.fromBytes(Encoder.base64UrlToBytes(storedMessage.encodedData));
    }

    const result = await this.#dwn.storage.dataStore.get(tenant, message.recordId, dataCid);
    return result?.dataStream;
  }

  // -------------------------------------------------------------------------
  // Deduplication Cache
  // -------------------------------------------------------------------------

  #isRecentlyForwarded(key: string): boolean {
    const expiry = this.#forwardedCids.get(key);
    if (expiry === undefined) {
      return false;
    }
    if (expiry < Date.now()) {
      this.#forwardedCids.delete(key);
      return false;
    }
    return true;
  }

  #markForwarded(key: string): void {
    const ttlMs = this.#config.forwardingDeduplicationTtlSeconds * 1_000;
    this.#forwardedCids.set(key, Date.now() + ttlMs);

    // Lazy eviction: purge expired entries when cache grows large.
    if (this.#forwardedCids.size > 10_000) {
      const now = Date.now();
      for (const [k, v] of this.#forwardedCids) {
        if (v < now) {
          this.#forwardedCids.delete(k);
        }
      }
    }
  }
}
