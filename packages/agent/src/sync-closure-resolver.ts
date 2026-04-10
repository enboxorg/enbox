import type { SyncScope } from './types/sync.js';
import type {
  ClosureDependencyEdge,
  ClosureEvaluationContext,
  ClosureResult,
} from './sync-closure-types.js';
import type { GenericMessage, MessageStore } from '@enbox/dwn-sdk-js';

import { Message, PermissionsProtocol } from '@enbox/dwn-sdk-js';

import { isMultiPartyContext } from './protocol-utils.js';
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

  // The permissions protocol is a built-in core protocol handled natively
  // by every DWN — it never has a ProtocolsConfigure message. Exempt it
  // from protocol metadata closure to avoid spurious failures when pushing
  // permission grant records created during delegated connect flows.
  if (protocol === PermissionsProtocol.uri) { return []; }

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

  // The signature payload is at authorization.signature.payload (GeneralJws).
  // This is the base64url-encoded JSON containing permissionGrantId, protocolRole, etc.
  const payload = auth.signature?.payload;
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
 * structure tree. Returns undefined if the path doesn't exist.
 *
 * Mirrors `getRuleSetAtPath` from `@enbox/dwn-sdk-js/src/utils/protocols.ts`
 * (not in public API, reimplemented here to avoid internal path coupling).
 */
function getRuleSetAtProtocolPath(
  structure: Record<string, any> | undefined,
  protocolPath: string,
): any | undefined {
  if (!structure || !protocolPath) { return undefined; }

  const segments = protocolPath.split('/');
  let currentLevel: Record<string, any> = structure;
  let current: any;

  for (const segment of segments) {
    if (!Object.hasOwn(currentLevel, segment)) { return undefined; }
    current = currentLevel[segment];
    currentLevel = current;
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
  isDelegateSession?: boolean,
): ClosureDependencyEdge[] {
  const desc = message.descriptor as Record<string, unknown>;
  if (desc.interface !== 'Records') { return []; }

  const protocolPath = desc.protocolPath as string | undefined;
  if (!protocolPath) { return []; }

  const edges: ClosureDependencyEdge[] = [];
  const ruleSet = getRuleSetAtProtocolPath(protocolDef?.structure, protocolPath);

  // --- Class 4: Squash / visibility floor ---
  // The runtime's squash backstop derives scope entirely from the incoming
  // message's own contextId (via Records.getParentContextFromOfContextId).
  // It does NOT fetch any additional record to determine scope — the contextId
  // is part of the message, and the $squash rule is in the ProtocolsConfigure
  // (already a class 1 dependency). So no additional closure dependency is
  // needed for squash. processRawMessage triggers the DWN's built-in squash
  // resumable task which handles purging internally.
  //
  // Future work: if subset-specific squash side-effects are needed (where the
  // consumer has records that the source purged), that belongs in the engine's
  // post-apply logic, not in closure dependency extraction.

  // --- Class 5: Encryption / key-delivery closure ---
  // Two levels of dependency:
  //
  // Level 1 (protocol-definition): The ProtocolsConfigure with injected $encryption
  // key material must be present. This is satisfied by class 1.
  //
  // Level 2 (key-delivery records): For multi-party contexts (where records use
  // ProtocolContext encryption), the context key record in the key-delivery protocol
  // must be locally present for the consumer to decrypt the record. Context keys are
  // stored at protocolPath 'contextKey' in the key-delivery protocol, tagged with
  // the source protocol URI and the root contextId.
  if (ruleSet?.$encryption) {
    const typeName = protocolPath.split('/').pop();
    const typeDef = protocolDef?.types?.[typeName ?? ''];
    if (typeDef?.encryptionRequired === true) {
      // Level 1: protocol definition edge (already satisfied by class 1 ProtocolsConfigure).
      edges.push({
        dependencyClass : 5,
        label           : 'encryptionKeyMaterial',
        identifier      : desc.protocol as string,
        identifierType  : 'protocol',
      });

      // Determine whether this record uses multi-party (ProtocolContext)
      // encryption before emitting key-delivery edges.
      const contextId = (message as any).contextId as string | undefined;
      let isMultiParty = false;
      if (contextId) {
        const rootProtocolPath = protocolPath.split('/')[0];
        isMultiParty = isMultiPartyContext(protocolDef, rootProtocolPath);
      }

      // Level 2: key-delivery protocol ProtocolsConfigure.
      //
      // For **owner** sessions this is always emitted — the DWN needs the
      // protocol installed to authorize contextKey record access.
      //
      // For **delegate** sessions:
      //  - Single-party: the delegate decrypts via pre-derived
      //    `delegateDecryptionKeys` (ProtocolPath keys).  No key-delivery
      //    records are involved.  Edge is suppressed.
      //  - Multi-party: on in-memory cache miss the runtime falls back to
      //    `fetchCrossDeviceContextKey()` (dwn-encryption.ts:453,
      //    dwn-key-delivery.ts:268) which does a local RecordsQuery +
      //    RecordsRead against the owner's tenant.  That authorization path
      //    requires the key-delivery ProtocolsConfigure.  Edge is emitted.
      const suppressKeyDelivery = isDelegateSession && !isMultiParty;
      if (!suppressKeyDelivery) {
        const keyDeliveryProtocol = 'https://identity.foundation/protocols/key-delivery';
        edges.push({
          dependencyClass : 5,
          label           : 'keyDeliveryProtocol',
          identifier      : keyDeliveryProtocol,
          identifierType  : 'protocol',
        });
      }

      // Level 3: Context key enforcement for multi-party contexts.
      // Uses isMultiPartyContext() from protocol-utils to determine whether the
      // record's root protocol path has $role descendants or relational who/of
      // read rules — these indicate multi-party access where ProtocolContext
      // encryption is used and a contextKey record is required for decryption.
      //
      // Single-party contexts use ProtocolPath encryption (owner-only) and do
      // NOT need a context key — the edge is skipped entirely.
      //
      // For delegates this edge is always emitted when applicable: the
      // runtime's cross-device fallback still needs the contextKey record
      // locally (on cache miss).
      if (isMultiParty && contextId) {
        const rootContextId = contextId.split('/')[0];
        // Separator is '|' (not ':') because protocol URIs contain '://'
        // which would break indexOf(':') parsing in resolveDependency.
        edges.push({
          dependencyClass : 5,
          label           : 'contextKeyRecord',
          identifier      : `${desc.protocol}|${rootContextId}`,
          identifierType  : 'messageCid',
        });
      }
    }
  }

  // --- Class 6: Cross-protocol $ref closure ---
  // Three levels of dependency when a record is at or below a $ref node:
  //
  // Level 1 (protocol config): The referenced protocol's ProtocolsConfigure must be present.
  // Level 2 (parent record): If the record's path has exactly 2 segments (e.g., thread/comment),
  //   the parent record lives in the REFERENCED protocol, not the composing protocol.
  // Level 3 (cross-protocol role): If the message's authorization invokes a cross-protocol role
  //   (format "alias:path"), the role record in the referenced protocol must be locally present.
  const firstSegment = protocolPath.split('/')[0];
  const rootRuleSet = protocolDef?.structure?.[firstSegment];
  if (rootRuleSet?.$ref) {
    const colonIdx = rootRuleSet.$ref.indexOf(':');
    if (colonIdx > 0) {
      const alias = rootRuleSet.$ref.substring(0, colonIdx);
      const usesMap = protocolDef?.uses;
      const referencedProtocol = usesMap?.[alias];
      if (referencedProtocol) {
        // Level 1: referenced protocol ProtocolsConfigure.
        edges.push({
          dependencyClass : 6,
          label           : 'crossProtocolConfig',
          identifier      : referencedProtocol,
          identifierType  : 'protocol',
        });

        // Level 2: $ref parent record in the referenced protocol.
        // When path depth is 2 (e.g., "thread/comment"), the parent is the $ref node
        // itself, which lives in the referenced protocol. The parent's recordId is
        // the message's parentId. The query MUST be scoped to the referenced
        // protocol URI to prevent false matches from the composing protocol.
        // Identifier format: "referencedProtocol|parentId"
        const pathSegments = protocolPath.split('/');
        const parentId = desc.parentId as string | undefined;
        if (pathSegments.length === 2 && parentId) {
          edges.push({
            dependencyClass : 6,
            label           : 'crossProtocolParent',
            identifier      : `${referencedProtocol}|${parentId}`,
            identifierType  : 'recordId',
          });
        }
      }
    }
  }

  // Level 3: Cross-protocol role records.
  // If the message's authorization invokes a role in "alias:path" format,
  // the role record must be locally present in the referenced protocol.
  // This is extracted from the authorization payload regardless of $ref presence.
  const auth = (message as any).authorization;
  if (auth && protocolDef?.uses) {
    // Same payload path as class 3: authorization.signature.payload
    const payload = auth.signature?.payload;
    if (payload) {
      try {
        const decoded = JSON.parse(
          Buffer.from(payload, 'base64url').toString('utf-8')
        );
        const protocolRole = decoded.protocolRole as string | undefined;
        if (protocolRole?.includes(':')) {
          // Cross-protocol role: "alias:protocolPath"
          const roleColonIdx = protocolRole.indexOf(':');
          const roleAlias = protocolRole.substring(0, roleColonIdx);
          const roleProtocol = protocolDef.uses[roleAlias];
          if (roleProtocol) {
            // The referenced protocol's ProtocolsConfigure (may already be added above).
            edges.push({
              dependencyClass : 6,
              label           : 'crossProtocolRoleConfig',
              identifier      : roleProtocol,
              identifierType  : 'protocol',
            });

            // The actual role record in the referenced protocol.
            // Mirrors verifyInvokedRole() from protocol-authorization-action.ts:
            // queries by protocol + protocolPath + recipient + contextId prefix.
            const roleProtocolPath = protocolRole.substring(roleColonIdx + 1);
            // Derive author from the message's JWS signature, not from the
            // payload. The payload does NOT contain an author field — the
            // DWN SDK extracts it from the signature's `kid` header via
            // Message.getAuthor().
            const messageAuthor = Message.getAuthor(message);
            const messageContextId = (message as any).contextId as string | undefined;

            if (messageAuthor) {
              // Build the role record query filter.
              const roleFilter: Record<string, unknown> = {
                interface         : 'Records',
                method            : 'Write',
                protocol          : roleProtocol,
                protocolPath      : roleProtocolPath,
                recipient         : messageAuthor,
                isLatestBaseState : true,
              };

              // Context scoping: the role record must be within the same context.
              // The ancestor segment count determines how many contextId segments
              // to use as the prefix filter (matching verifyInvokedRole logic).
              if (messageContextId) {
                const ancestorCount = roleProtocolPath.split('/').length - 1;
                if (ancestorCount > 0) {
                  const contextSegments = messageContextId.split('/');
                  const contextPrefix = contextSegments.slice(0, ancestorCount).join('/');
                  if (contextPrefix) {
                    roleFilter.contextId = { gte: contextPrefix, lt: contextPrefix + '\uffff' };
                  }
                }
              }

              // Cache key must include the context prefix to prevent false
              // positives across different contexts (e.g., different threads).
              const contextPrefix = roleFilter.contextId
                ? JSON.stringify(roleFilter.contextId) : 'no-context';
              edges.push({
                dependencyClass : 6,
                label           : 'crossProtocolRoleRecord',
                identifier      : `${roleProtocol}|${roleProtocolPath}|${messageAuthor}|${contextPrefix}`,
                identifierType  : 'filter',
                filter          : roleFilter,
              });
            }
          }
        }
      } catch {
        // If we can't decode the payload, skip.
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
        const protocolDef = cachedProtocolMsg?.descriptor?.definition;
        if (protocolDef) {
          const protoAwareEdges = extractProtocolAwareDeps(current, protocolDef, context.isDelegateSession);
          const protoResult = await resolveEdges(
            protoAwareEdges, allEdges, messageStore, context, visited, queue, rootCid, currentDepth
          );
          if (protoResult) { return protoResult; }
        }
      }

      // Phase 3: Validate grant temporal ordering (causal grant check).
      // After all edges are resolved, if this message uses a grant, verify
      // that the grant is temporally valid at the message's commit point:
      //   - grant.dateGranted <= message.messageTimestamp < grant.dateExpires
      //   - no revocation exists with revocation.messageTimestamp <= message.messageTimestamp
      // This runs only for the root message (currentDepth === 0) to avoid
      // redundant checks on transitive dependencies.
      if (currentDepth === 0) {
        const grantCheckResult = validateGrantTemporal(
          current, allEdges, context, rootCid, currentDepth
        );
        if (grantCheckResult) { return grantCheckResult; }
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
// Causal grant ordering validation
// ---------------------------------------------------------------------------

/**
 * Validates that any permission grant used by the message is temporally valid
 * at the message's commit point. Returns a failure result if the grant is
 * expired or revoked at the message's timestamp, null if valid or no grant used.
 *
 * Temporal model (from grant-authorization.ts):
 *   grant.dateGranted <= message.messageTimestamp < grant.dateExpires
 *   AND (no revocation OR revocation.messageTimestamp > message.messageTimestamp)
 */
function validateGrantTemporal(
  message: GenericMessage,
  allEdges: ClosureDependencyEdge[],
  context: ClosureEvaluationContext,
  rootCid: string,
  currentDepth: number,
): ClosureResult | null {
  // Check if this message has a grant dependency.
  const grantEdge = allEdges.find(e => e.label === 'permissionGrant');
  if (!grantEdge) { return null; } // No grant used.

  const messageTimestamp = (message.descriptor as any).messageTimestamp as string;
  if (!messageTimestamp) { return null; }

  // Look up the resolved grant record from the cache.
  const grantRecord = context.grantCache.get(grantEdge.identifier);
  if (!grantRecord) { return null; } // Grant wasn't resolved (would have failed earlier).

  // Extract grant temporal bounds.
  // dateGranted = descriptor.dateCreated (set by PermissionGrant constructor)
  const dateGranted = (grantRecord.descriptor as any).dateCreated as string | undefined;
  // dateExpires is in the encoded data payload (base64url JSON).
  let dateExpires: string | undefined;
  const encodedData = (grantRecord as any).encodedData as string | undefined;
  if (encodedData) {
    try {
      const grantData = JSON.parse(Buffer.from(encodedData, 'base64url').toString('utf-8'));
      dateExpires = grantData.dateExpires;
    } catch { /* ignore parse errors */ }
  }

  // Check: grant not yet active.
  if (dateGranted && messageTimestamp < dateGranted) {
    return {
      complete       : false,
      rootMessageCid : rootCid,
      edges          : allEdges,
      failure        : {
        code   : ClosureFailureCode.GrantNotYetActive,
        edge   : grantEdge,
        detail : `grant '${grantEdge.identifier}' is not yet active at message timestamp ${messageTimestamp} (dateGranted: ${dateGranted})`,
      },
      depth: currentDepth,
    };
  }

  // Check: grant expired.
  if (dateExpires && messageTimestamp >= dateExpires) {
    return {
      complete       : false,
      rootMessageCid : rootCid,
      edges          : allEdges,
      failure        : {
        code   : ClosureFailureCode.GrantExpired,
        edge   : grantEdge,
        detail : `grant '${grantEdge.identifier}' expired at ${dateExpires}, message timestamp is ${messageTimestamp}`,
      },
      depth: currentDepth,
    };
  }

  // Check: grant revoked at or before message timestamp.
  const revocationCacheKey = `revocation:${grantEdge.identifier}`;
  const revocationRecord = context.grantCache.get(revocationCacheKey);
  if (revocationRecord && (revocationRecord.descriptor as any).interface !== 'Synthetic') {
    const revocationTimestamp = (revocationRecord.descriptor as any).messageTimestamp as string;
    if (revocationTimestamp && revocationTimestamp <= messageTimestamp) {
      return {
        complete       : false,
        rootMessageCid : rootCid,
        edges          : allEdges,
        failure        : {
          code   : ClosureFailureCode.GrantRevocationMissing,
          edge   : allEdges.find(e => e.label === 'grantRevocation') ?? grantEdge,
          detail : `grant '${grantEdge.identifier}' was revoked at ${revocationTimestamp}, before message timestamp ${messageTimestamp}`,
        },
        depth: currentDepth,
      };
    }
  }

  return null; // Grant is temporally valid.
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

    // Include label in dep key to distinguish edges with the same identifier
    // but different semantics (e.g., permissionGrant vs grantRevocation both
    // use identifierType:'grantId' with the same grantId).
    const depKey = `${edge.label}:${edge.identifierType}:${edge.identifier}`;
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

    // Add resolved record to the BFS queue for transitive dependency evaluation,
    // but skip leaf dependency types that don't have their own closure requirements:
    // - grantId: grant/revocation records are leaf nodes
    // - filter: filter-resolved records (e.g., role records) are leaf nodes
    // - messageCid with contextKeyRecord label: key-delivery records are leaf nodes
    const isLeafDep = edge.identifierType === 'grantId' ||
                      edge.identifierType === 'filter' ||
                      edge.label === 'contextKeyRecord';
    if (!isLeafDep) {
      const resolvedCid = await Message.getCid(resolved);
      if (!visited.has(resolvedCid)) {
        visited.add(resolvedCid);
        queue.push(resolved);
      }
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

      // crossProtocolParent: identifier is "referencedProtocol|parentId"
      // Query MUST be scoped to the referenced protocol URI.
      if (edge.label === 'crossProtocolParent') {
        const pipeIdx = edge.identifier.indexOf('|');
        if (pipeIdx > 0) {
          const refProtocol = edge.identifier.substring(0, pipeIdx);
          const refParentId = edge.identifier.substring(pipeIdx + 1);
          const { messages: refParents } = await messageStore.query(context.tenantDid, [{
            interface         : 'Records',
            method            : 'Write',
            protocol          : refProtocol,
            recordId          : refParentId,
            isLatestBaseState : true,
          }]);
          return refParents.length > 0 ? refParents[0] : null;
        }
      }

      // For parentRecord, contextRoot, or other recordId lookups, query latest state.
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
        // Store the result. If no revocation exists, store an explicit synthetic
        // sentinel — never use the grant record as a sentinel, because
        // validateGrantTemporal checks descriptor.interface !== 'Synthetic' to
        // distinguish real revocations from "no revocation" markers.
        // Select the oldest revocation (matching SDK's Message.getOldestMessage logic).
        // The oldest revocation determines the temporal boundary — messages at or after
        // its timestamp are rejected.
        let oldestRevocation: GenericMessage | undefined;
        for (const rev of revocations) {
          const revTs = (rev.descriptor as any).messageTimestamp as string;
          if (!oldestRevocation || revTs < (oldestRevocation.descriptor as any).messageTimestamp) {
            oldestRevocation = rev;
          }
        }

        const noRevocationSentinel = { descriptor: { interface: 'Synthetic', method: 'NoRevocation' } } as any;
        const result = oldestRevocation ?? noRevocationSentinel;
        context.grantCache.set(cacheKey, result);
        return result;
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
      // Special case: contextKeyRecord uses messageCid type but requires a
      // tag-based query against the key-delivery protocol, not a CID lookup.
      // Identifier format is "sourceProtocol|rootContextId".
      if (edge.label === 'contextKeyRecord') {
        const separatorIdx = edge.identifier.indexOf('|');
        if (separatorIdx > 0) {
          const sourceProtocol = edge.identifier.substring(0, separatorIdx);
          const rootContextId = edge.identifier.substring(separatorIdx + 1);
          const { messages: contextKeys } = await messageStore.query(context.tenantDid, [{
            interface       : 'Records',
            method          : 'Write',
            protocol        : 'https://identity.foundation/protocols/key-delivery',
            protocolPath    : 'contextKey',
            'tag.protocol'  : sourceProtocol,
            'tag.contextId' : rootContextId,
          } as any]);
          if (contextKeys.length > 0) { return contextKeys[0]; }
          // No context key found. Since the edge is only emitted for multi-party
          // contexts (isMultiPartyContext returned true), the absence of a context
          // key means the consumer cannot decrypt this record. Return null to
          // fail closure — the link will transition to repairing.
          return null;
        }
      }
      return await messageStore.get(context.tenantDid, edge.identifier) ?? null;
    }

    case 'filter': {
      // Filter-based resolution: query the MessageStore with the structured
      // filter carried in edge.filter. Used for dependencies that require
      // multi-field queries (e.g., cross-protocol role records).
      if (!edge.filter) { return null; }
      const { messages: filterResults } = await messageStore.query(
        context.tenantDid, [edge.filter as any]
      );
      return filterResults.length > 0 ? filterResults[0] : null;
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
