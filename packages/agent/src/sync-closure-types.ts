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
  identifierType: 'messageCid' | 'recordId' | 'protocol' | 'grantId';
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
