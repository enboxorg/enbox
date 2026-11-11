import type { DwnServerConfig } from './config.js';
import type { JsonRpcRequest } from '@enbox/dwn-clients';
import type { DidDocument, DidResolver, DidService, DidServiceEndpoint } from '@enbox/dids';
import type { Dwn, GenericMessage, ModuleDefinition, RecordsQueryReplyEntry, RecordsWriteMessage, ResolvedModuleNode, ResolvedRoleReference } from '@enbox/dwn-sdk-js';
import type { MessageProcessedContext, MessageProcessedHook } from './message-processed-hook.js';

import log from 'loglevel';

import { sleep } from '@enbox/common';
import { createHttpDwnRpcRequestBody, createJsonRpcRequest, HTTP_DWN_RPC_MEDIA_TYPE } from '@enbox/dwn-clients';
import { DataStream, DwnConstant, DwnInterfaceName, DwnMethodName, Encoder, getRoleContextPrefix, getRuleSetAtPath, Message, preloadModuleDefinitions, Records, resolveModuleGraph } from '@enbox/dwn-sdk-js';

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
 * Result of resolving delivery targets for a record at a given module path.
 * Each entry maps a target DID to its DWN endpoints.
 */
type DeliveryTarget = {
  did: string;
  endpoints: DwnEndpoint[];
};

type SendMessageAttemptResult = 'retry' | 'sent' | 'skipped';

type RequestInitWithDuplex = RequestInit & { duplex?: 'half' };

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
 *    module path with `$delivery`, proactively delivers to participants' DWN
 *    endpoints determined from module `$actions` role records.
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
   * the module's `$delivery` directive and `$actions` role records.
   */
  async #deliverToParticipants(tenant: string, message: GenericMessage, messageCid: string): Promise<void> {
    const descriptor = message.descriptor as {
      module?: string;
      modulePath?: string;
      contextId?: string;
      recipient?: string;
    };

    // Only module-governed records can have $delivery.
    if (!descriptor.module || !descriptor.modulePath) {
      return;
    }

    // Look up the module definition to check for $delivery.
    const moduleDefinition = await this.#getModuleDefinition(tenant, descriptor.module);
    if (!moduleDefinition) {
      return;
    }

    const ruleSet = getRuleSetAtPath(descriptor.modulePath, moduleDefinition.structure);
    // Subscription delivery is driven by participants; only direct delivery pushes from this node.
    if (ruleSet?.$delivery !== 'direct') {
      return;
    }

    const definitions = await preloadModuleDefinitions(moduleDefinition, uri => this.#getModuleDefinition(tenant, uri));
    const graph = resolveModuleGraph(moduleDefinition, uri => definitions.get(uri));
    const node = graph.nodesByDeclaredPath.get(descriptor.modulePath);
    if (node === undefined || node.kind !== 'record') {
      return;
    }
    const contextId = (message as RecordsWriteMessage).contextId;
    const targets = await this.#resolveDeliveryTargets(
      tenant, node, contextId, descriptor.recipient,
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

  // -------------------------------------------------------------------------
  // Delivery Target Resolution
  // -------------------------------------------------------------------------

  /**
   * Resolves the set of DIDs that should receive a record at the given module path.
   * Targets are determined by querying role records in the tenant's DWN.
   *
   * For each `$actions` rule that references a `role`, we query for role records
   * at that role's module path, scoped to the record's contextId. The `recipient`
   * field of each matching role record is a participant DID.
   */
  async #resolveDeliveryTargets(
    tenant: string,
    node: ResolvedModuleNode,
    contextId?: string,
    recipient?: string,
  ): Promise<DeliveryTarget[]> {
    const targetDids = new Set<string>();

    // Method 1: Explicit recipient on the record itself.
    if (recipient) {
      targetDids.add(recipient);
    }

    // Method 2 & 3: Role-based and actor-based discovery from $actions rules.
    await this.#collectRoleAndActorTargets(tenant, node, contextId, targetDids);

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
   * Adds delivery target DIDs discovered via a module rule set's `$actions`
   * to `targetDids`, mutating the set in place. Covers role-based discovery
   * (Method 2) and actor-based discovery via `who`/`of` (Method 3). Extracted
   * from `#resolveDeliveryTargets()`.
   */
  async #collectRoleAndActorTargets(
    tenant: string,
    node: ResolvedModuleNode,
    contextId: string | undefined,
    targetDids: Set<string>,
  ): Promise<void> {
    for (const action of node.actions) {
      const recipients = await this.#queryActionRecipients(tenant, action, contextId); // NOSONAR: S9382 — one DWN lookup at a time.
      for (const did of recipients) {
        targetDids.add(did);
      }
    }
  }

  /** Resolve one action's role holders and ancestor actor without changing action-order target precedence. */
  async #queryActionRecipients(
    tenant: string,
    { resolvedRole, resolvedActor }: ResolvedModuleNode['actions'][number],
    contextId: string | undefined,
  ): Promise<string[]> {
    const recipients = resolvedRole === undefined ? [] : await this.#queryRoleRecipients(tenant, resolvedRole, contextId);
    if (resolvedActor !== undefined) {
      const actorDid = await this.#queryActorFromAncestor(
        tenant, resolvedActor.owningModuleUri, resolvedActor.owningModulePath,
        resolvedActor.who, resolvedActor.physicalDepth, contextId,
      );
      if (actorDid !== undefined) {
        recipients.push(actorDid);
      }
    }
    return recipients;
  }

  /**
   * Queries the tenant's DWN for role records at the given module path
   * and returns the set of unique recipient DIDs.
   */
  async #queryRoleRecipients(
    tenant: string,
    role: ResolvedRoleReference,
    contextId?: string,
  ): Promise<string[]> {
    try {
      const contextPrefix = getRoleContextPrefix(role, contextId);
      if (role.parentPhysicalDepth > 0 && contextPrefix === undefined) {
        return [];
      }
      const filter: Record<string, unknown> = {
        module     : role.owningModuleUri,
        modulePath : role.owningModulePath,
        ...(contextPrefix === undefined ? {} : { contextId: contextPrefix }),
      };

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
      log.warn(`DeliveryService: failed to query role recipients for ${role.owningModulePath}`, err);
      return [];
    }
  }

  /**
   * Queries the tenant's DWN for the ancestor record at the given module path
   * (within the same context) and extracts the author or recipient DID.
   *
   * This is the delivery-side inverse of `checkActor()` in module authorization:
   * instead of "is this DID the author/recipient?", we ask "who IS the author/recipient?".
   *
   * @param actorType - `"author"` or `"recipient"`.
   * @returns The DID of the actor, or `undefined` if the ancestor cannot be found.
   */
  async #queryActorFromAncestor(
    tenant: string,
    moduleUri: string,
    ofPath: string,
    actorType: string,
    physicalDepth: number,
    contextId?: string,
  ): Promise<string | undefined> {
    try {
      const filter: Record<string, unknown> = {
        module     : moduleUri,
        modulePath : ofPath,
      };

      // Scope to the record's context. The `of` path identifies an ancestor,
      // so the ancestor's contextId is a prefix of (or equal to) the current
      // record's contextId. For a top-level `of` path (no slashes), the ancestor
      // IS the context root — its recordId equals the first contextId segment.
      if (contextId !== undefined) {
        const ofDepth = physicalDepth;
        const contextSegments = contextId.split('/');
        // The ancestor at depth N has a contextId formed by the first N segments.
        if (contextSegments.length >= ofDepth) {
          filter.contextId = contextSegments.slice(0, ofDepth).join('/');
          filter.recordId = contextSegments[ofDepth - 1];
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
    if (!didDocument.service) {
      return [];
    }

    const endpoints: DwnEndpoint[] = [];
    for (const service of didDocument.service) {
      endpoints.push(...DeliveryService.#extractEndpointsFromService(service));
    }

    return endpoints;
  }

  /**
   * Extracts DWN endpoints from a single DID document service entry. Returns
   * an empty array for non-`DecentralizedWebNode` services — mirrors the
   * `continue` in the original per-service scan — and for any
   * `serviceEndpoint` shape not covered by the string/array/object cases.
   */
  static #extractEndpointsFromService(service: DidService): DwnEndpoint[] {
    if (service.type !== 'DecentralizedWebNode') {
      return [];
    }

    // serviceEndpoint can be a string, string[], object with nodes, or map with url.
    const epValue = service.serviceEndpoint;

    if (typeof epValue === 'string') {
      return [{ url: stripTrailingSlashes(epValue), isFull: true }];
    }

    if (Array.isArray(epValue)) {
      return DeliveryService.#extractEndpointsFromArray(epValue);
    }

    if (epValue && typeof epValue === 'object') {
      return DeliveryService.#extractEndpointsFromObject(epValue as Record<string, unknown>);
    }

    return [];
  }

  /**
   * Extracts endpoints from a `serviceEndpoint` array. Each entry may be a
   * bare URL string or a map entry (`{ url, dataRetention? }`); any other
   * entry shape is silently skipped, matching the original per-entry scan.
   */
  static #extractEndpointsFromArray(entries: DidServiceEndpoint[]): DwnEndpoint[] {
    const endpoints: DwnEndpoint[] = [];

    for (const entry of entries) {
      if (typeof entry === 'string') {
        endpoints.push({ url: stripTrailingSlashes(entry), isFull: true });
      } else if (entry && typeof entry === 'object') {
        // Map entry: { url: "...", dataRetention?: "full" | "cache" }
        const mapEndpoint = DeliveryService.#extractMapEndpoint(entry as Record<string, unknown>);
        if (mapEndpoint) {
          endpoints.push(mapEndpoint);
        }
      }
    }

    return endpoints;
  }

  /**
   * Extracts endpoints from an object-shaped `serviceEndpoint`. The legacy
   * `{ nodes: [...] }` format and the map format `{ url, dataRetention? }`
   * are checked independently — not mutually exclusive, matching the
   * original scan — so an object carrying both keys yields endpoints from
   * each, `nodes` first.
   */
  static #extractEndpointsFromObject(epValue: Record<string, unknown>): DwnEndpoint[] {
    const endpoints: DwnEndpoint[] = [];

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
      const mapEndpoint = DeliveryService.#extractMapEndpoint(epValue);
      if (mapEndpoint) {
        endpoints.push(mapEndpoint);
      }
    }

    return endpoints;
  }

  /**
   * Builds a `DwnEndpoint` from a map-shaped service endpoint entry
   * (`{ url: "...", dataRetention?: "full" | "cache" }`). Returns `undefined`
   * when `url` is not a string, matching the original guard.
   */
  static #extractMapEndpoint(value: Record<string, unknown>): DwnEndpoint | undefined {
    const mapEntry = value as { url?: string; dataRetention?: string };
    if (typeof mapEntry.url !== 'string') {
      return undefined;
    }

    return {
      url    : stripTrailingSlashes(mapEntry.url),
      isFull : mapEntry.dataRetention !== 'cache',
    };
  }

  // -------------------------------------------------------------------------
  // Module Definition Lookup
  // -------------------------------------------------------------------------

  /**
   * Fetches the installed module definition for a given module URI from
   * the tenant's DWN.
   */
  async #getModuleDefinition(tenant: string, moduleUri: string): Promise<ModuleDefinition | undefined> {
    try {
      const queryMessage = {
        descriptor: {
          interface        : DwnInterfaceName.Modules,
          method           : DwnMethodName.Query,
          messageTimestamp : new Date().toISOString(),
          filter           : { module: moduleUri },
        },
      };

      const reply = await this.#dwn.processMessage(tenant, queryMessage as GenericMessage);

      if (reply.status.code !== 200 || !reply.entries || reply.entries.length === 0) {
        return undefined;
      }

      const configMessage = reply.entries[0] as { descriptor?: { definition?: ModuleDefinition } };
      return configMessage.descriptor?.definition;
    } catch (err) {
      log.warn(`DeliveryService: failed to query module definition for ${moduleUri}`, err);
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
   * The JSON-RPC envelope and optional record data stream ride in a framed
   * `application/vnd.enbox.dwn-rpc` request body, reading record data back
   * from the source tenant's local stores since the original request stream
   * was consumed when the message was processed.
   * Follows the same retry pattern as WebhookManager.
   */
  async #sendMessage(endpointUrl: string, target: string, message: GenericMessage, sourceTenant: string): Promise<void> {
    const rpcRequest = createJsonRpcRequest(
      crypto.randomUUID(),
      'dwn.processMessage',
      { target, message },
    );

    const dataBearingWrite = DeliveryService.#getDataBearingWrite(message);
    const headers = { 'content-type': HTTP_DWN_RPC_MEDIA_TYPE };

    for (let attempt = 0; attempt <= DeliveryService.#maxRetries; attempt++) {
      const result = await this.#sendMessageAttempt({
        attempt,
        dataBearingWrite,
        endpointUrl,
        headers,
        rpcRequest,
        sourceTenant,
        target,
      });
      if (result !== 'retry') {
        return;
      }

      await DeliveryService.#sleepBeforeRetry(attempt);
    }

    log.error(`DeliveryService: delivery to ${endpointUrl} failed after ${DeliveryService.#maxRetries + 1} attempts`);
  }

  async #sendMessageAttempt({
    attempt,
    dataBearingWrite,
    endpointUrl,
    headers,
    rpcRequest,
    sourceTenant,
    target,
  }: {
    attempt: number;
    dataBearingWrite: RecordsWriteMessage | undefined;
    endpointUrl: string;
    headers: Record<string, string>;
    rpcRequest: JsonRpcRequest;
    sourceTenant: string;
    target: string;
  }): Promise<SendMessageAttemptResult> {
    try {
      const fetchOptions = await this.#createFetchOptions(sourceTenant, endpointUrl, headers, rpcRequest, dataBearingWrite);
      if (fetchOptions === undefined) {
        return 'skipped';
      }

      const response = await fetch(endpointUrl, fetchOptions);
      return DeliveryService.#handleSendResponse(endpointUrl, target, response, attempt);
    } catch (err) {
      log.warn(`DeliveryService: fetch error to ${endpointUrl} (attempt ${attempt + 1}):`, err);
      return 'retry';
    }
  }

  async #createFetchOptions(
    sourceTenant: string,
    endpointUrl: string,
    headers: Record<string, string>,
    rpcRequest: JsonRpcRequest,
    dataBearingWrite: RecordsWriteMessage | undefined,
  ): Promise<RequestInitWithDuplex | undefined> {
    const body = await this.#createRequestBody(sourceTenant, endpointUrl, rpcRequest, dataBearingWrite);
    if (body === undefined) {
      return undefined;
    }

    const fetchOptions: RequestInitWithDuplex = {
      body,
      headers,
      method : 'POST',
      signal : AbortSignal.timeout(DeliveryService.#requestTimeoutMs),
    };

    if (body instanceof ReadableStream) {
      // Required by the Fetch standard for streaming request bodies.
      fetchOptions.duplex = 'half';
    }

    return fetchOptions;
  }

  /**
   * Creates the request body for one send attempt; record data streams are one-shot,
   * so retries must re-read them from local storage instead of replaying a prior body.
   */
  async #createRequestBody(
    sourceTenant: string,
    endpointUrl: string,
    rpcRequest: JsonRpcRequest,
    dataBearingWrite: RecordsWriteMessage | undefined,
  ): Promise<BodyInit | undefined> {
    if (dataBearingWrite === undefined) {
      return createHttpDwnRpcRequestBody(rpcRequest);
    }

    const data = await this.#getRecordsWriteData(sourceTenant, dataBearingWrite);
    if (data === undefined) {
      log.warn(`DeliveryService: data for ${dataBearingWrite.recordId} is no longer available locally; skipping send to ${endpointUrl}`);
      return undefined;
    }

    return createHttpDwnRpcRequestBody(rpcRequest, data);
  }

  static #getDataBearingWrite(message: GenericMessage): RecordsWriteMessage | undefined {
    return Records.isRecordsWrite(message) && message.descriptor.dataSize > 0 ? message : undefined;
  }

  static #handleSendResponse(endpointUrl: string, target: string, response: Response, attempt: number): SendMessageAttemptResult {
    if (response.ok) {
      log.debug(`DeliveryService: sent to ${endpointUrl} for ${target} (${response.status})`);
      return 'sent';
    }

    // 409 means duplicate — the remote already has this message. That's success.
    if (response.status === 409) {
      log.debug(`DeliveryService: ${endpointUrl} already has message for ${target} (409)`);
      return 'sent';
    }

    log.warn(`DeliveryService: ${endpointUrl} returned ${response.status} (attempt ${attempt + 1})`);
    return 'retry';
  }

  static async #sleepBeforeRetry(attempt: number): Promise<void> {
    if (attempt < DeliveryService.#maxRetries) {
      await sleep(DeliveryService.#retryDelaysMs[attempt]);
    }
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
