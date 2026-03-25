import type { GenericMessage } from '@enbox/dwn-sdk-js';

// ---------------------------------------------------------------------------
// Closure failure codes
// ---------------------------------------------------------------------------

/**
 * Typed failure codes for closure resolution. Each code maps to a specific
 * dependency class from the closure RFC.
 */
export enum ClosureFailureCode {
  /** Class 1: The ProtocolsConfigure for the protocol could not be found. */
  ProtocolMetadataMissing = 'ClosureProtocolMetadataMissing',
  /** Class 2: The initialWrite for a non-initial RecordsWrite is missing. */
  InitialWriteMissing = 'ClosureInitialWriteMissing',
  /** Class 2: A parent record in the parentId chain is missing. */
  ParentChainMissing = 'ClosureParentChainMissing',
  /** Class 2: A context ancestor record is missing. */
  ContextChainMissing = 'ClosureContextChainMissing',
  /** Class 3: A permission grant referenced by permissionGrantId is missing. */
  GrantMissing = 'ClosureGrantMissing',
  /** Class 3: The grant exists but is not yet active at the message's timestamp. */
  GrantNotYetActive = 'ClosureGrantNotYetActive',
  /** Class 3: The grant exists but has expired at the message's timestamp. */
  GrantExpired = 'ClosureGrantExpired',
  /** Class 3: A revocation record that affects a referenced grant is missing. */
  GrantRevocationMissing = 'ClosureGrantRevocationMissing',
  /** Class 4: A squash floor or visibility-floor record is missing. */
  VisibilityFloorMissing = 'ClosureVisibilityFloorMissing',
  /** Class 5: An encryption/key-delivery dependency is missing. */
  EncryptionDependencyMissing = 'ClosureEncryptionDependencyMissing',
  /** Class 6: A cross-protocol $ref dependency is missing. */
  CrossProtocolReferenceMissing = 'ClosureCrossProtocolReferenceMissing',
  /** A dependency exists but the syncing principal is not authorized to fetch it. */
  DependencyForbidden = 'ClosureDependencyForbidden',
  /** Traversal depth exceeded the configured maximum (default 32). */
  DepthExceeded = 'ClosureDepthExceeded',
}

// ---------------------------------------------------------------------------
// Closure dependency edge
// ---------------------------------------------------------------------------

/**
 * A single dependency edge in the closure graph — identifies what is needed
 * and why. Used for diagnostics, deduplication, and fetch queue management.
 */
export type ClosureDependencyEdge = {
  /** The dependency class that produced this edge. */
  dependencyClass: 1 | 2 | 3 | 4 | 5 | 6;
  /** Human-readable label for the dependency (e.g., "initialWrite", "grant", "protocolsConfigure"). */
  label: string;
  /**
   * The identifier used to look up this dependency. Typically a `messageCid`
   * or `recordId` depending on the dependency class.
   */
  identifier: string;
  /** The type of identifier — determines the fetch strategy. */
  identifierType: 'messageCid' | 'recordId' | 'protocol' | 'grantId' | 'filter';
  /**
   * When `identifierType` is `'filter'`, this carries the full query filter
   * as a structured object. Used for dependencies that require multi-field
   * queries (e.g., cross-protocol role records queried by protocol +
   * protocolPath + recipient + contextId prefix).
   */
  filter?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Closure result
// ---------------------------------------------------------------------------

/**
 * Result of closure evaluation for a single operation (closure root).
 */
export type ClosureResult = {
  /** Whether all hard dependencies are satisfied. */
  complete: boolean;
  /** The closure root's messageCid. */
  rootMessageCid: string;
  /** All dependency edges that were evaluated. */
  edges: ClosureDependencyEdge[];
  /**
   * If incomplete, the first unsatisfied dependency. Used for diagnostics
   * and determines the failure code for repair transitions.
   */
  failure?: {
    code: ClosureFailureCode;
    edge: ClosureDependencyEdge;
    detail: string;
  };
  /** Total number of dependency hops traversed. */
  depth: number;
};

// ---------------------------------------------------------------------------
// Closure evaluation context (per-batch caching)
// ---------------------------------------------------------------------------

/**
 * Shared context for a batch of closure evaluations. Caches protocol
 * definitions, grant records, and previously resolved operations to avoid
 * redundant queries across closure roots in the same evaluation pass.
 */
export type ClosureEvaluationContext = {
  /** Tenant DID for this evaluation batch. */
  tenantDid: string;
  /** Cached ProtocolsConfigure definitions keyed by protocol URI. */
  protocolCache: Map<string, any>;
  /** Cached grant records keyed by grantId. */
  grantCache: Map<string, GenericMessage | null>;
  /**
   * Set of dependency identifiers already known to be locally present.
   * Keyed by `${identifierType}:${identifier}` to prevent cross-namespace
   * collisions (e.g., a recordId and a grantId with the same string value).
   */
  satisfiedDeps: Set<string>;
  /**
   * Set of dependency identifiers already known to be missing/unfetchable.
   * Same composite key format as `satisfiedDeps`.
   */
  missingDeps: Set<string>;
  /** Maximum traversal depth. Default 32. */
  maxDepth: number;
};

/**
 * Create a fresh evaluation context for a batch of closure evaluations.
 */
export function createClosureContext(tenantDid: string, maxDepth?: number): ClosureEvaluationContext {
  return {
    tenantDid,
    protocolCache : new Map(),
    grantCache    : new Map(),
    satisfiedDeps : new Set(),
    missingDeps   : new Set(),
    maxDepth      : maxDepth ?? 32,
  };
}

/**
 * Invalidate cached entries that may be affected by a newly processed message.
 * Called after `processRawMessage` succeeds to ensure subsequent closure
 * evaluations see the updated state.
 *
 * - `ProtocolsConfigure` → clears protocolCache for that protocol URI
 * - Permissions grant write → clears grantCache for that recordId
 * - Permissions revocation → clears grantCache for the parent grantId
 * - Any Records message → clears satisfiedDeps/missingDeps for that recordId
 *   (the message may have changed what's locally present)
 */
export function invalidateClosureCache(
  context: ClosureEvaluationContext,
  message: GenericMessage,
): void {
  const desc = message.descriptor as Record<string, unknown>;

  // ProtocolsConfigure update → invalidate protocol cache.
  if (desc.interface === 'Protocols' && desc.method === 'Configure') {
    const protocol = desc.definition
      ? (desc.definition as any).protocol as string | undefined
      : undefined;
    if (protocol) {
      context.protocolCache.delete(protocol);
    }
  }

  // Permissions protocol messages → invalidate grant/revocation cache.
  if (desc.protocol === 'https://identity.foundation/dwn/permissions') {
    const recordId = (message as any).recordId as string | undefined;
    const protocolPath = desc.protocolPath as string | undefined;

    if (protocolPath === 'grant' && recordId) {
      // Grant write → invalidate the grant cache and dep keys.
      context.grantCache.delete(recordId);
      context.satisfiedDeps.delete(`permissionGrant:grantId:${recordId}`);
      context.missingDeps.delete(`permissionGrant:grantId:${recordId}`);
    }

    if (protocolPath === 'grant/revocation') {
      // Revocation write → invalidate revocation cache and both dep keys.
      const parentId = desc.parentId as string | undefined;
      if (parentId) {
        context.grantCache.delete(`revocation:${parentId}`);
        context.satisfiedDeps.delete(`grantRevocation:grantId:${parentId}`);
        context.missingDeps.delete(`grantRevocation:grantId:${parentId}`);
        // Also invalidate the grant itself since its revocation state changed.
        context.satisfiedDeps.delete(`permissionGrant:grantId:${parentId}`);
        context.missingDeps.delete(`permissionGrant:grantId:${parentId}`);
      }
    }
  }

  // Any Records message → invalidate dep keys that could be affected.
  // Handles multiple key formats:
  //   - plain recordId entries (class 2 parent/context/initialWrite)
  //   - composite protocol|recordId entries (class 6 crossProtocolParent)
  //   - filter-based entries keyed by protocol+protocolPath (class 6 role records)
  //   - contextKeyRecord entries keyed by source protocol from tags (class 5)
  // Uses boundary-aware matching for recordId to avoid substring collisions,
  // prefix matching for filter/contextKey entries, and tag-based source
  // protocol extraction for key-delivery records.
  if (desc.interface === 'Records') {
    const recordId = (message as any).recordId as string | undefined;
    const protocol = desc.protocol as string | undefined;
    const protocolPath = desc.protocolPath as string | undefined;

    if (recordId) {
      // Invalidate dep keys that reference this exact recordId.
      // Check for recordId at a key boundary (preceded by ':' or '|')
      // to avoid substring false matches (e.g., 'thread-1' matching 'thread-10').
      const matchesRecordId = (key: string): boolean => {
        const idx = key.indexOf(recordId);
        if (idx === -1) { return false; }
        const charBefore = idx > 0 ? key[idx - 1] : ':';
        const charAfter = idx + recordId.length < key.length ? key[idx + recordId.length] : '|';
        const validBefore = charBefore === ':' || charBefore === '|';
        const validAfter = charAfter === '|' || charAfter === undefined;
        return validBefore && (idx + recordId.length === key.length || validAfter);
      };
      for (const key of context.satisfiedDeps) {
        if (matchesRecordId(key)) { context.satisfiedDeps.delete(key); }
      }
      for (const key of context.missingDeps) {
        if (matchesRecordId(key)) { context.missingDeps.delete(key); }
      }
    }

    // Invalidate filter-based role record deps that match this protocol + protocolPath.
    // These are keyed like "filter:protocol|protocolPath|author|context".
    if (protocol && protocolPath) {
      const filterPrefix = `filter:${protocol}|${protocolPath}`;
      for (const key of context.satisfiedDeps) {
        if (key.startsWith(filterPrefix)) { context.satisfiedDeps.delete(key); }
      }
      for (const key of context.missingDeps) {
        if (key.startsWith(filterPrefix)) { context.missingDeps.delete(key); }
      }
    }

    // Invalidate contextKeyRecord deps.
    // Context key records are in the key-delivery protocol, but their closure
    // cache keys use the SOURCE protocol (from tags.protocol), not the
    // key-delivery protocol URI. So when a key-delivery record arrives, we
    // must extract the source protocol from the record's tags.
    if (protocol === 'https://identity.foundation/protocols/key-delivery') {
      // Real key-delivery writes have tags: { protocol: sourceProtocol, contextId: ... }
      const tags = (message as any).descriptor?.tags as Record<string, string> | undefined;
      const sourceProtocol = tags?.protocol;
      if (sourceProtocol) {
        const ctxKeyPrefix = `messageCid:${sourceProtocol}|`;
        for (const key of context.satisfiedDeps) {
          if (key.startsWith(ctxKeyPrefix)) { context.satisfiedDeps.delete(key); }
        }
        for (const key of context.missingDeps) {
          if (key.startsWith(ctxKeyPrefix)) { context.missingDeps.delete(key); }
        }
      }
    } else if (protocol) {
      // For non-key-delivery protocols, invalidate contextKeyRecord entries
      // keyed by this protocol (e.g., if a record write changes the context).
      const ctxKeyPrefix = `messageCid:${protocol}|`;
      for (const key of context.satisfiedDeps) {
        if (key.startsWith(ctxKeyPrefix)) { context.satisfiedDeps.delete(key); }
      }
      for (const key of context.missingDeps) {
        if (key.startsWith(ctxKeyPrefix)) { context.missingDeps.delete(key); }
      }
    }
  }
}
