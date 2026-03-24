import type { SyncScope } from './types/sync.js';
import type {
  ClosureDependencyEdge,
  ClosureEvaluationContext,
  ClosureResult,
} from './sync-closure-types.js';
import type { GenericMessage, MessageStore } from '@enbox/dwn-sdk-js';

import { Message } from '@enbox/dwn-sdk-js';

import { ClosureFailureCode, createClosureContext } from './sync-closure-types.js';

// ---------------------------------------------------------------------------
// Dependency extraction helpers (one per dependency class)
// ---------------------------------------------------------------------------

/**
 * Class 1: Protocol metadata closure.
 * Extract the protocol URI from the message descriptor. The ProtocolsConfigure
 * for that protocol must be present locally.
 */
function extractProtocolDeps(message: GenericMessage): ClosureDependencyEdge[] {
  const desc = message.descriptor as Record<string, unknown>;
  const protocol = desc.protocol as string | undefined;
  if (!protocol) { return []; }

  return [{
    dependencyClass : 1,
    label           : 'protocolsConfigure',
    identifier      : protocol,
    identifierType  : 'protocol',
  }];
}

/**
 * Class 2: Record ancestry closure.
 * - initialWrite (for non-initial writes)
 * - parentId chain
 */
function extractAncestryDeps(message: GenericMessage): ClosureDependencyEdge[] {
  const desc = message.descriptor as Record<string, unknown>;
  const edges: ClosureDependencyEdge[] = [];

  // Only Records interface messages have ancestry dependencies.
  if (desc.interface !== 'Records') { return []; }

  const recordId = (message as any).recordId as string | undefined;

  // parentId dependency — the parent record must be present.
  const parentId = desc.parentId as string | undefined;
  if (parentId) {
    edges.push({
      dependencyClass : 2,
      label           : 'parentRecord',
      identifier      : parentId,
      identifierType  : 'recordId',
    });
  }

  // contextId dependency — if the record has a contextId that differs from
  // its own recordId, the context root record must be present. The contextId
  // is a hierarchical path of recordIds (e.g., "rootId/childId/grandchildId").
  // The context root is the first segment.
  const contextId = (message as any).contextId as string | undefined;
  if (contextId && recordId && contextId !== recordId) {
    const contextRootId = contextId.split('/')[0];
    edges.push({
      dependencyClass : 2,
      label           : 'contextRoot',
      identifier      : contextRootId,
      identifierType  : 'recordId',
    });
  }

  // initialWrite dependency — non-initial writes need their initialWrite.
  // An initial write has entryId === recordId, but we can't compute entryId here
  // without the full CID computation. Instead, check dateCreated vs messageTimestamp
  // as a heuristic, then the resolver will verify via the message store.
  if (recordId && desc.method === 'Write') {
    const dateCreated = desc.dateCreated as string | undefined;
    const messageTimestamp = desc.messageTimestamp as string | undefined;
    if (dateCreated && messageTimestamp && dateCreated !== messageTimestamp) {
      // Non-initial write — needs the initialWrite.
      edges.push({
        dependencyClass : 2,
        label           : 'initialWrite',
        identifier      : recordId,
        identifierType  : 'recordId',
      });
    }
  }

  // RecordsDelete also needs the initialWrite for authorization and index construction.
  if (recordId && desc.method === 'Delete') {
    edges.push({
      dependencyClass : 2,
      label           : 'initialWrite',
      identifier      : recordId,
      identifierType  : 'recordId',
    });
  }

  return edges;
}

/**
 * Class 3: Authorization closure.
 * If the message uses a permissionGrantId, the grant record must be present.
 */
function extractAuthorizationDeps(message: GenericMessage): ClosureDependencyEdge[] {
  const edges: ClosureDependencyEdge[] = [];
  const auth = (message as any).authorization;
  if (!auth) { return []; }

  // Check for permissionGrantId in the signature payload.
  const payload = auth.authorSignature?.payload ?? auth.payload;
  if (payload) {
    try {
      // Payload is base64url-encoded JSON.
      const decoded = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf-8')
      );
      if (decoded.permissionGrantId) {
        edges.push({
          dependencyClass : 3,
          label           : 'permissionGrant',
          identifier      : decoded.permissionGrantId,
          identifierType  : 'grantId',
        });
        // Also require the grant's revocation state to be resolvable.
        // The revocation is a child record at protocolPath 'grant/revocation'
        // with parentId === grantId. We add it as a separate edge so the
        // resolver can check for its presence (or confirmed absence).
        edges.push({
          dependencyClass : 3,
          label           : 'grantRevocation',
          identifier      : decoded.permissionGrantId,
          identifierType  : 'grantId',
        });
      }
    } catch {
      // If we can't decode, skip — authorization will fail at apply time.
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Protocol-definition-aware dependency extraction (classes 4, 5, 6)
//
// These classes require the ProtocolDefinition to be available (fetched by
// class 1 resolution). They are called during BFS traversal, not as static
// extractors from the message alone.
// ---------------------------------------------------------------------------

/**
 * Look up the ProtocolRuleSet for a given protocolPath within a protocol
 * definition's structure tree. Returns undefined if the path doesn't exist.
 */
function resolveRuleSet(
  definition: any,
  protocolPath: string,
): any | undefined {
  if (!definition?.structure || !protocolPath) { return undefined; }

  const segments = protocolPath.split('/');
  let current = definition.structure;

  for (const segment of segments) {
    if (!current || typeof current !== 'object') { return undefined; }
    current = current[segment];
  }

  return current;
}

/**
 * Extract protocol-definition-aware dependencies for classes 4, 5, and 6.
 * Called during BFS traversal after the ProtocolDefinition has been fetched
 * and cached (class 1 resolution ensures this).
 *
 * @param message - The message being evaluated.
 * @param protocolDef - The cached ProtocolDefinition (from class 1 resolution).
 * @param context - The evaluation context (for accessing `uses` map resolution).
 */
function extractProtocolAwareDeps(
  message: GenericMessage,
  protocolDef: any,
): ClosureDependencyEdge[] {
  const desc = message.descriptor as Record<string, unknown>;
  if (desc.interface !== 'Records') { return []; }

  const protocolPath = desc.protocolPath as string | undefined;
  if (!protocolPath) { return []; }

  const edges: ClosureDependencyEdge[] = [];
  const ruleSet = resolveRuleSet(protocolDef, protocolPath);

  // --- Class 4: Squash / visibility floor ---
  // If the protocol path has $squash: true, the closure must include the
  // context scope root so squash scope can be determined. The runtime
  // determines squash scope using Records.getParentContextFromOfContextId(contextId):
  //   - Root records (contextId = recordId, no '/'): parent context is "" → unscoped
  //   - Nested records (contextId = "a/b/c"): parent context is "a/b" → scoped
  // For closure, the parent context root record (first segment of contextId)
  // must be present so the subset consumer can determine what gets purged.
  if (ruleSet?.$squash === true) {
    const contextId = (message as any).contextId as string | undefined;
    if (contextId && contextId.includes('/')) {
      // Nested context — extract the root of the parent context.
      // contextId = "rootId/childId/thisId" → parent context root = "rootId"
      const contextRootId = contextId.split('/')[0];
      edges.push({
        dependencyClass : 4,
        label           : 'squashContextRoot',
        identifier      : contextRootId,
        identifierType  : 'recordId',
      });
    }
    // For root-level squash (contextId has no '/'), no parent context dependency
    // is needed — squash is unscoped across all siblings at that protocolPath.
  }

  // --- Class 5: Encryption ---
  // If the rule set has $encryption and the protocol type has encryptionRequired,
  // the ProtocolsConfigure with injected $encryption keys must be present.
  // Class 1 already ensures ProtocolsConfigure is in the closure. For class 5,
  // we verify the actual type definition requires encryption — if so, the
  // ProtocolsConfigure's $encryption block is the dependency (already satisfied
  // by class 1). We add an explicit marker edge for diagnostics.
  if (ruleSet?.$encryption) {
    // Check if the type has encryptionRequired.
    const typeName = protocolPath.split('/').pop();
    const typeDef = protocolDef?.types?.[typeName ?? ''];
    if (typeDef?.encryptionRequired === true) {
      edges.push({
        dependencyClass : 5,
        label           : 'encryptionKeyMaterial',
        identifier      : desc.protocol as string,
        identifierType  : 'protocol',
      });
    }
  }

  // --- Class 6: Cross-protocol $ref ---
  // If the first segment of the protocol path is a $ref node, the record's
  // parent lives in a different protocol. The referenced protocol's
  // ProtocolsConfigure must be in the closure set.
  const firstSegment = protocolPath.split('/')[0];
  const rootRuleSet = protocolDef?.structure?.[firstSegment];
  if (rootRuleSet?.$ref) {
    // Parse the $ref value: "alias:typePath"
    const colonIdx = rootRuleSet.$ref.indexOf(':');
    if (colonIdx > 0) {
      const alias = rootRuleSet.$ref.substring(0, colonIdx);
      const usesMap = protocolDef?.uses;
      const referencedProtocol = usesMap?.[alias];
      if (referencedProtocol) {
        // The referenced protocol's ProtocolsConfigure must be present.
        edges.push({
          dependencyClass : 6,
          label           : 'crossProtocolConfig',
          identifier      : referencedProtocol,
          identifierType  : 'protocol',
        });
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Closure resolver
// ---------------------------------------------------------------------------

/**
 * Evaluates closure completeness for a single operation (closure root).
 *
 * Uses BFS traversal with deduplication and depth limiting. Shared caching
 * across evaluation batches via {@link ClosureEvaluationContext}.
 *
 * The resolver queries the local MessageStore directly (bypassing auth)
 * because it needs to verify dependency presence, not access-control the
 * syncing agent's own local store.
 */
export async function evaluateClosure(
  message: GenericMessage,
  messageStore: MessageStore,
  scope: SyncScope,
  context: ClosureEvaluationContext,
): Promise<ClosureResult> {
  // Full-tenant scope bypasses closure evaluation entirely.
  if (scope.kind === 'full') {
    const cid = await Message.getCid(message);
    return {
      complete       : true,
      rootMessageCid : cid,
      edges          : [],
      depth          : 0,
    };
  }

  const rootCid = await Message.getCid(message);
  const allEdges: ClosureDependencyEdge[] = [];
  const visited = new Set<string>();
  let currentDepth = 0;

  // BFS queue: each item is a message to evaluate for dependencies.
  const queue: GenericMessage[] = [message];
  visited.add(rootCid);

  while (queue.length > 0) {
    if (currentDepth >= context.maxDepth) {
      return {
        complete       : false,
        rootMessageCid : rootCid,
        edges          : allEdges,
        failure        : {
          code   : ClosureFailureCode.DepthExceeded,
          edge   : { dependencyClass: 1, label: 'depth', identifier: String(currentDepth), identifierType: 'messageCid' },
          detail : `closure traversal exceeded max depth of ${context.maxDepth}`,
        },
        depth: currentDepth,
      };
    }

    const batchSize = queue.length;
    for (let i = 0; i < batchSize; i++) {
      const current = queue.shift()!;

      // Phase 1: Extract and resolve static dependency edges (classes 1-3).
      // This populates the protocolCache when class 1 (ProtocolsConfigure)
      // is resolved, which is needed by classes 4-6.
      const staticEdges = [
        ...extractProtocolDeps(current),
        ...extractAncestryDeps(current),
        ...extractAuthorizationDeps(current),
      ];

      const resolveResult = await resolveEdges(
        staticEdges, allEdges, messageStore, context, visited, queue, rootCid, currentDepth
      );
      if (resolveResult) { return resolveResult; } // Early failure.

      // Phase 2: Extract protocol-definition-aware edges (classes 4-6).
      // Runs AFTER static resolution so the ProtocolDefinition is in the cache.
      const currentDesc = current.descriptor as Record<string, unknown>;
      const currentProtocol = currentDesc.protocol as string | undefined;
      if (currentProtocol) {
        const cachedProtocolMsg = context.protocolCache.get(currentProtocol);
        const protocolDef = (cachedProtocolMsg?.descriptor as any)?.definition;
        if (protocolDef) {
          const protoAwareEdges = extractProtocolAwareDeps(current, protocolDef);
          const protoResult = await resolveEdges(
            protoAwareEdges, allEdges, messageStore, context, visited, queue, rootCid, currentDepth
          );
          if (protoResult) { return protoResult; }
        }
      }
    }

    currentDepth++;
  }

  return {
    complete       : true,
    rootMessageCid : rootCid,
    edges          : allEdges,
    depth          : currentDepth,
  };
}

/**
 * Evaluate closure for a batch of messages. Shares caching across all roots.
 */
export async function evaluateClosureBatch(
  messages: GenericMessage[],
  messageStore: MessageStore,
  scope: SyncScope,
  tenantDid: string,
  maxDepth?: number,
): Promise<ClosureResult[]> {
  const context = createClosureContext(tenantDid, maxDepth);
  const results: ClosureResult[] = [];

  for (const msg of messages) {
    const result = await evaluateClosure(msg, messageStore, scope, context);
    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a list of dependency edges. Returns a ClosureResult on failure,
 * or null if all edges were resolved successfully.
 */
async function resolveEdges(
  edges: ClosureDependencyEdge[],
  allEdges: ClosureDependencyEdge[],
  messageStore: MessageStore,
  context: ClosureEvaluationContext,
  visited: Set<string>,
  queue: GenericMessage[],
  rootCid: string,
  currentDepth: number,
): Promise<ClosureResult | null> {
  for (const edge of edges) {
    allEdges.push(edge);

    const depKey = `${edge.identifierType}:${edge.identifier}`;
    if (context.satisfiedDeps.has(depKey)) { continue; }
    if (context.missingDeps.has(depKey)) {
      return {
        complete       : false,
        rootMessageCid : rootCid,
        edges          : allEdges,
        failure        : {
          code   : mapEdgeToFailureCode(edge),
          edge,
          detail : `dependency '${edge.label}' (${edge.identifier}) is missing`,
        },
        depth: currentDepth,
      };
    }

    const resolved = await resolveDependency(edge, messageStore, context);
    if (!resolved) {
      context.missingDeps.add(depKey);
      return {
        complete       : false,
        rootMessageCid : rootCid,
        edges          : allEdges,
        failure        : {
          code   : mapEdgeToFailureCode(edge),
          edge,
          detail : `dependency '${edge.label}' (${edge.identifier}) not found locally`,
        },
        depth: currentDepth,
      };
    }

    context.satisfiedDeps.add(depKey);

    const resolvedCid = await Message.getCid(resolved);
    if (!visited.has(resolvedCid)) {
      visited.add(resolvedCid);
      queue.push(resolved);
    }
  }

  return null; // All edges resolved successfully.
}

/**
 * Resolve a dependency edge by querying the local MessageStore.
 * Returns the resolved message or null if not found.
 */
async function resolveDependency(
  edge: ClosureDependencyEdge,
  messageStore: MessageStore,
  context: ClosureEvaluationContext,
): Promise<GenericMessage | null> {
  switch (edge.identifierType) {
    case 'protocol': {
    // Check cache first.
      if (context.protocolCache.has(edge.identifier)) {
        return context.protocolCache.get(edge.identifier) ?? null;
      }
      // Query for ProtocolsConfigure.
      const { messages } = await messageStore.query(context.tenantDid, [{
        interface         : 'Protocols',
        method            : 'Configure',
        protocol          : edge.identifier,
        isLatestBaseState : true,
      }]);
      const found = messages.length > 0 ? messages[0] : null;
      context.protocolCache.set(edge.identifier, found);
      return found;
    }

    case 'recordId': {
      if (edge.label === 'initialWrite') {
      // Query specifically for the initial write: entryId === recordId,
      // stored with isLatestBaseState: false after subsequent writes.
      // Try entryId first (canonical), fall back to recordId + non-latest.
        const { messages: byEntryId } = await messageStore.query(context.tenantDid, [{
          entryId: edge.identifier,
        }]);
        if (byEntryId.length > 0) { return byEntryId[0]; }

        // Fallback: query by recordId with isLatestBaseState: false
        // (initial writes are re-stored with this flag after updates).
        const { messages: byRecordId } = await messageStore.query(context.tenantDid, [{
          interface         : 'Records',
          method            : 'Write',
          recordId          : edge.identifier,
          isLatestBaseState : false,
        }]);
        return byRecordId.length > 0 ? byRecordId[0] : null;
      }

      // For parentRecord or other recordId lookups, query latest state.
      const { messages } = await messageStore.query(context.tenantDid, [{
        interface         : 'Records',
        recordId          : edge.identifier,
        isLatestBaseState : true,
      }]);
      return messages.length > 0 ? messages[0] : null;
    }

    case 'grantId': {
      if (edge.label === 'grantRevocation') {
      // Query for revocation records: child records at 'grant/revocation'
      // protocolPath with parentId === grantId. The absence of a revocation
      // is a valid result (grant is not revoked) — return a synthetic
      // "no revocation" marker so the dependency is considered satisfied.
        const cacheKey = `revocation:${edge.identifier}`;
        if (context.grantCache.has(cacheKey)) {
          return context.grantCache.get(cacheKey) ?? null;
        }
        const { messages: revocations } = await messageStore.query(context.tenantDid, [{
          interface         : 'Records',
          method            : 'Write',
          protocol          : 'https://identity.foundation/dwn/permissions',
          parentId          : edge.identifier,
          protocolPath      : 'grant/revocation',
          isLatestBaseState : true,
        }]);
        // If no revocation exists, the dependency is still satisfied (grant is active).
        // Store whatever we found (or the grant itself as a sentinel) so we don't re-query.
        const grantForSentinel = context.grantCache.get(edge.identifier);
        const result = revocations.length > 0 ? revocations[0] : (grantForSentinel ?? null);
        context.grantCache.set(cacheKey, result);
        // Revocation presence or absence is always satisfiable — the closure
        // question is "can we evaluate grant validity?" and we can as long as
        // we have the grant record (already a separate edge).
        return result ?? { descriptor: { interface: 'Synthetic', method: 'NoRevocation' } } as any;
      }

      // Grant record lookup.
      if (context.grantCache.has(edge.identifier)) {
        return context.grantCache.get(edge.identifier) ?? null;
      }
      const { messages } = await messageStore.query(context.tenantDid, [{
        interface         : 'Records',
        method            : 'Write',
        protocol          : 'https://identity.foundation/dwn/permissions',
        protocolPath      : 'grant',
        recordId          : edge.identifier,
        isLatestBaseState : true,
      }]);
      const found = messages.length > 0 ? messages[0] : null;
      context.grantCache.set(edge.identifier, found);
      return found;
    }

    case 'messageCid': {
      return await messageStore.get(context.tenantDid, edge.identifier) ?? null;
    }

    default:
      return null;
  }
}

/**
 * Map a dependency edge to the appropriate failure code.
 */
function mapEdgeToFailureCode(edge: ClosureDependencyEdge): ClosureFailureCode {
  switch (edge.dependencyClass) {
    case 1: return ClosureFailureCode.ProtocolMetadataMissing;
    case 2:
      if (edge.label === 'initialWrite') { return ClosureFailureCode.InitialWriteMissing; }
      if (edge.label === 'parentRecord') { return ClosureFailureCode.ParentChainMissing; }
      if (edge.label === 'contextRoot') { return ClosureFailureCode.ContextChainMissing; }
      return ClosureFailureCode.ParentChainMissing;
    case 3:
      if (edge.label === 'permissionGrant') { return ClosureFailureCode.GrantMissing; }
      return ClosureFailureCode.GrantRevocationMissing;
    case 4:
      if (edge.label === 'squashContextRoot') { return ClosureFailureCode.VisibilityFloorMissing; }
      return ClosureFailureCode.VisibilityFloorMissing;
    case 5: return ClosureFailureCode.EncryptionDependencyMissing;
    case 6: return ClosureFailureCode.CrossProtocolReferenceMissing;
    default: return ClosureFailureCode.DependencyForbidden;
  }
}
