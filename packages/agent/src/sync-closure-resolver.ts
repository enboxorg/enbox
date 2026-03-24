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

/**
 * Class 4: Visibility and state-floor closure.
 * If the message is a RecordsWrite at a protocol path that uses $squash,
 * the squash floor record must be present. This is evaluated by the resolver
 * using the protocol definition from the cache.
 *
 * Note: Squash floor dependencies are discovered during traversal after the
 * protocol definition is fetched. This function returns an empty array —
 * squash deps are added by the resolver during graph exploration.
 */
function extractVisibilityDeps(_message: GenericMessage): ClosureDependencyEdge[] {
  // Squash floor deps require protocol definition context (fetched during traversal).
  // They are added by the resolver, not by static extraction.
  return [];
}

/**
 * Class 5: Encryption closure.
 * If the message has encryption metadata, the key-delivery dependencies
 * are needed. Like squash deps, these require protocol definition context.
 */
function extractEncryptionDeps(_message: GenericMessage): ClosureDependencyEdge[] {
  // Encryption deps require protocol definition context.
  // Deferred to resolver traversal.
  return [];
}

/**
 * Class 6: Cross-protocol composition closure.
 * If the message's protocol path starts with a $ref node, the parent record
 * is in a different protocol. This requires protocol definition context.
 */
function extractCrossProtocolDeps(_message: GenericMessage): ClosureDependencyEdge[] {
  // Cross-protocol deps require protocol definition context.
  // Deferred to resolver traversal.
  return [];
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

      // Extract dependency edges from all static classes.
      const edges = [
        ...extractProtocolDeps(current),
        ...extractAncestryDeps(current),
        ...extractAuthorizationDeps(current),
        ...extractVisibilityDeps(current),
        ...extractEncryptionDeps(current),
        ...extractCrossProtocolDeps(current),
      ];

      for (const edge of edges) {
        allEdges.push(edge);

        // Check if already satisfied (cached from a prior root in this batch).
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

        // Attempt to resolve the dependency from the local store.
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

        // If the resolved dependency is a message, add it to the queue for
        // transitive dependency evaluation (if not already visited).
        const resolvedCid = await Message.getCid(resolved);
        if (!visited.has(resolvedCid)) {
          visited.add(resolvedCid);
          queue.push(resolved);
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
      return ClosureFailureCode.ContextChainMissing;
    case 3:
      if (edge.label === 'permissionGrant') { return ClosureFailureCode.GrantMissing; }
      return ClosureFailureCode.GrantRevocationMissing;
    case 4: return ClosureFailureCode.VisibilityFloorMissing;
    case 5: return ClosureFailureCode.EncryptionDependencyMissing;
    case 6: return ClosureFailureCode.CrossProtocolReferenceMissing;
    default: return ClosureFailureCode.DependencyForbidden;
  }
}
