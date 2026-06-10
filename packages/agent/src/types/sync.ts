import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './agent.js';

/** Deterministic bytewise string comparator for hash inputs and canonical IDs. */
export function lexicographicalCompare(a: string, b: string): number {
  if (a > b) { return 1; }
  if (a < b) { return -1; }
  return 0;
}

/**
 * The SyncEngine is responsible for syncing messages between the agent and the platform.
 */
export type SyncIdentityOptions = {
  /**
   * The delegate DID that should be used to sign the sync messages.
   */
  delegateDid?: string;
  /**
   * The protocols that should be synced for this identity.
   * - `'all'` — sync all protocols (full replica).
   * - `string[]` — sync only the listed protocol URIs.
   *
   * Composed protocols are not expanded automatically. If a protocol definition
   * declares `uses`, include every referenced protocol that the local DWN must
   * install or use while applying records for the requested protocol set.
   */
  protocols: 'all' | [string, ...string[]];
};

/**
 * Connectivity state of the sync engine.
 */
export type SyncConnectivityState = 'online' | 'offline' | 'unknown';

/**
 * Describes the sync mode: `'poll'` for periodic SMT reconciliation,
 * `'live'` for `MessagesSubscribe`-based real-time sync with SMT fallback.
 */
export type SyncMode = 'poll' | 'live';

// ---------------------------------------------------------------------------
// Sync scope and scope identity
// ---------------------------------------------------------------------------

/**
 * Root algorithm used by StateIndex full/protocol sync scopes.
 */
export const SYNC_PROJECTION_ROOT_VERSION = 'state-index-full-protocol-root-v1';

/**
 * Authorization-epoch algorithm used by delegated Messages.Read sync links.
 *
 * The authorization epoch is separate from the projection ID: re-granting the
 * same scope or changing delegate grants must invalidate in-flight work without
 * changing the primary CID set being compared.
 */
export const SYNC_AUTHORIZATION_EPOCH_VERSION = 'messages-read-grants-v1';

/** A non-empty, sorted, duplicate-free string list. */
export type NonEmptyStringArray = [string, ...string[]];

/**
 * Describes the primary CID set a replication link syncs.
 *
 * Full and protocol-set sync use the existing StateIndex roots. Narrow
 * protocolPath/contextId sync is not represented here; a delegate must have
 * grant coverage for every full protocol root in the protocol set.
 */
export type SyncScope = {
  /** Full-tenant scope. Valid only for owner sync or unscoped delegated grants. */
  kind: 'full';
} | {
  /** Protocol-set scope over one or more protocol roots. */
  kind: 'protocolSet';
  protocols: NonEmptyStringArray;
};

/**
 * Authorization context for a link. Owner links do not invoke grants. Delegate
 * links carry the active Messages.Read grants that authorize the scope union.
 */
export type SyncAuthorization =
  | { kind: 'owner' }
  | {
    kind: 'delegate';
    delegateDid: string;
    permissionGrantIds: NonEmptyStringArray;
  };

/** Grant metadata that participates in delegated authorization-epoch hashing. */
export type SyncAuthorizationGrant = {
  id: string;
  dateExpires: string;
  dateGranted?: string;
};

/**
 * Normalizes a protocol list into canonical scope-union order.
 */
export function normalizeSyncProtocols(protocols: [string, ...string[]] | string[]): NonEmptyStringArray {
  const unique = [...new Set(protocols)].sort(lexicographicalCompare);
  if (unique.length === 0) {
    throw new Error('SyncScope: protocol-set scope requires at least one protocol URI.');
  }
  return unique as NonEmptyStringArray;
}

/** Converts persisted identity options into the canonical sync scope. */
export function syncScopeFromProtocols(protocols: SyncIdentityOptions['protocols']): SyncScope {
  return protocols === 'all'
    ? { kind: 'full' }
    : { kind: 'protocolSet', protocols: normalizeSyncProtocols(protocols) };
}

/** Returns the protocol list covered by a scope, or `undefined` for full scope. */
export function protocolsForSyncScope(scope: SyncScope): NonEmptyStringArray | undefined {
  if (scope.kind === 'full') {
    return undefined;
  }
  return scope.protocols;
}

/** Returns the single protocol root covered by a protocol-set scope, if any. */
export function singleProtocolForSyncScope(scope: SyncScope): string | undefined {
  return scope.kind === 'protocolSet' && scope.protocols.length === 1 ? scope.protocols[0] : undefined;
}

/** Stable base64url SHA-256 hash for canonical JSON objects. */
async function hashCanonicalObject(value: Record<string, unknown>): Promise<string> {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = new Uint8Array(hashBuffer);

  let base64 = '';
  for (const b of hashArray) {
    base64 += String.fromCharCode(b);
  }
  const result = btoa(base64).replaceAll('+', '-').replaceAll('/', '_');
  let end = result.length;
  while (end > 0 && result.codePointAt(end - 1) === 61) { end--; }
  return end === result.length ? result : result.slice(0, end);
}

/** Returns a canonical JSON-ready representation of a sync scope. */
export function canonicalizeSyncScope(scope: SyncScope): SyncScope {
  if (scope.kind === 'full') {
    return { kind: 'full' };
  }
  return { kind: 'protocolSet', protocols: normalizeSyncProtocols(scope.protocols) };
}

/**
 * Computes a deterministic, collision-resistant projection ID.
 *
 * The projection ID is derived from tenant DID, normalized scope, and the
 * projection-root algorithm version. It intentionally excludes endpoint,
 * grant IDs, authorization epoch, and remote diff contents.
 */
export async function computeProjectionId(tenantDid: string, scope: SyncScope): Promise<string> {
  const canonicalScope = canonicalizeSyncScope(scope);

  return hashCanonicalObject({
    scope   : canonicalScope,
    tenantDid,
    version : SYNC_PROJECTION_ROOT_VERSION,
  });
}

/**
 * Computes the authorization epoch for a link.
 *
 * Owner epochs are stable for owner sync. Delegate epochs are derived
 * from the delegate DID plus the active grant IDs and expiry metadata. A changed
 * grant set creates a new link key even when the projection ID is unchanged.
 */
export async function computeAuthorizationEpoch(input:
  | { kind: 'owner' }
  | { kind: 'delegate'; delegateDid: string; grants: [SyncAuthorizationGrant, ...SyncAuthorizationGrant[]] }
): Promise<string> {
  if (input.kind === 'owner') {
    return hashCanonicalObject({
      kind    : 'owner',
      version : SYNC_AUTHORIZATION_EPOCH_VERSION,
    });
  }

  const grants = [...input.grants]
    .sort((a, b) => lexicographicalCompare(a.id, b.id))
    .map(grant => ({
      dateExpires : grant.dateExpires,
      dateGranted : grant.dateGranted,
      id          : grant.id,
    }));

  return hashCanonicalObject({
    delegateDid : input.delegateDid,
    grants,
    kind        : 'delegate',
    version     : SYNC_AUTHORIZATION_EPOCH_VERSION,
  });
}

// ---------------------------------------------------------------------------
// Replication checkpoint types
// ---------------------------------------------------------------------------

/**
 * Maximum number of in-flight deliveries (runtime ordinals) a link may
 * accumulate before transitioning to `repairing`. This is the overflow
 * threshold for the engine's in-memory delivery tracker, not for durable
 * checkpoint state. Normative per the sync redesign RFC.
 */
export const MAX_PENDING_TOKENS = 100;

/**
 * Tracks directional (pull or push) replay progression for a single
 * replication link. All tokens belong to the same `(streamId, epoch)`.
 *
 * This is the **durable** replication checkpoint persisted to the ledger.
 * In-memory delivery-order tracking (ordinals, in-flight commits) is owned
 * by the sync engine and is not persisted — on crash recovery, replay
 * restarts from `contiguousAppliedToken` and idempotent apply handles
 * any re-delivered events.
 */
export type DirectionCheckpoint = {
  /**
   * The latest token received from the source (pull) or confirmed by the
   * remote (push). May be ahead of `contiguousAppliedToken` when events
   * arrive out of order. Used for observability.
   */
  receivedToken?: ProgressToken;

  /**
   * The highest token such that all earlier delivered tokens for this link
   * have been durably applied. This is the resume point after crash/reconnect.
   *
   * Advancement is controlled by the engine's delivery-order tracking,
   * not by position arithmetic. Positions may be sparse (filtered streams).
   */
  contiguousAppliedToken?: ProgressToken;
};

/**
 * Status of a replication link.
 *
 * - `initializing` — link created, no subscriptions open yet.
 * - `live` — actively receiving events via subscription.
 * - `polling` — current link is reconciled by periodic SMT sync; live subscription is not supported for its scope.
 * - `repairing` — gap detected or pending overflow; running SMT reconciliation.
 * - `degraded_poll` — subscription failed; polling at reduced frequency.
 * - `terminal_incomplete` — admission failed with a terminal dependency error; requires a new scope/authorization epoch.
 * - `paused` — explicitly paused by the application.
 */
export type LinkStatus = 'initializing' | 'live' | 'polling' | 'repairing' | 'degraded_poll' | 'terminal_incomplete' | 'paused';

/**
 * Durable state of a single replication link. Persisted to LevelDB and
 * loaded on startup. Each link is identified by the tuple
 * `(tenantDid, remoteEndpoint, projectionId, authorizationEpoch)`.
 */
export type ReplicationLinkState = {
  /** The tenant DID this link syncs for. */
  tenantDid: string;

  /** The remote DWN endpoint URL. */
  remoteEndpoint: string;

  /** Deterministic hash of tenant DID, normalized scope, and root algorithm version. */
  projectionId: string;

  /** Deterministic hash of owner/delegate grant context for this link. */
  authorizationEpoch: string;

  /** The scope definition this link covers. */
  scope: SyncScope;

  /** Owner/delegate authorization context used to sign sync messages. */
  authorization: SyncAuthorization;

  /** Current link status. */
  status: LinkStatus;

  /** Pull-direction replication checkpoint (remote → local). */
  pull: DirectionCheckpoint;

  /**
   * Whether this link needs SMT reconciliation. Set when push fails after
   * retry exhaustion, when the link reconnects after an outage, or when
   * the remote epoch changes. Cleared after successful reconciliation.
   * Persisted so recovery survives app/browser restart.
   */
  needsReconcile?: boolean;

  /** Per-link connectivity state. Used to compute the aggregate engine-level state. */
  connectivity: SyncConnectivityState;

  /** Delegate DID used to sign sync messages, if any. */
  delegateDid?: string;

  /** ISO-8601 timestamp of last successful sync activity. */
  lastActivityAt?: string;
};

// ---------------------------------------------------------------------------
// Push result (per-CID outcome tracking)
// ---------------------------------------------------------------------------

/**
 * Result of a batch push operation. Replaces the previous throw-on-first-failure
 * pattern so callers can advance the push replication checkpoint incrementally.
 */
/** A failed push root with diagnostic info from the latest attempt. */
export type PushFailure = {
  cid : string;
  statusCode? : number;
  detail? : string;
};

export type PushResult = {
  /** messageCids that were accepted (202/204/409 — idempotent success). */
  succeeded: string[];
  /** Requested root messageCids that failed and should be retried or reconciled. */
  failed: PushFailure[];
};

/**
 * Parameters for {@link SyncEngine.startSync}.
 */
export type StartSyncParams = {
  /**
   * The sync mode to use. Default: `'poll'`.
   *
   * - `'live'`: Opens `MessagesSubscribe` WebSocket subscriptions to remote
   *   DWNs for real-time pull, and listens to the local EventLog for immediate
   *   push. Falls back to SMT reconciliation on cold start or long disconnect.
   *   An infrequent SMT integrity check still runs at `interval`.
   *
   * - `'poll'`: Performs a full SMT set-reconciliation sync on a
   *   fixed interval. No WebSocket subscriptions are used.
   */
  mode?: SyncMode;

  /**
   * The interval at which the sync operation should be performed.
   * Accepts any value recognised by `ms()`, e.g. `'30s'`, `'2m'`, `'10m'`.
   *
   * In `'live'` mode this controls the frequency of the SMT integrity check.
   * In `'poll'` mode this controls the polling frequency.
   *
   * Default: `'2m'` (in poll mode), `'5m'` (in live mode).
   */
  interval?: string;
};

// ---------------------------------------------------------------------------
// Sync observability events
// ---------------------------------------------------------------------------

/** Sync scope metadata attached to observability events. */
export type SyncEventScope = {
  /** Present only when the event belongs to a single-protocol link. */
  protocol?: string;
  /** Present when the event belongs to a protocol-set link. */
  protocols?: NonEmptyStringArray;
};

type SyncEventBase = {
  tenantDid: string;
  remoteEndpoint: string;
} & SyncEventScope;

/**
 * Events emitted by the sync engine at key state transitions.
 * Consumers subscribe via `SyncEngine.on('event', handler)` and can
 * hook these into metrics, logging, or UI state.
 */
export type SyncEvent =
  | SyncEventBase & { type: 'link:status-change'; from: LinkStatus; to: LinkStatus }
  | SyncEventBase & { type: 'link:connectivity-change'; from: SyncConnectivityState; to: SyncConnectivityState }
  | SyncEventBase & { type: 'checkpoint:pull-advance'; position: string; messageCid: string }
  | SyncEventBase & { type: 'reconcile:applied'; messageCids: string[] }
  | SyncEventBase & { type: 'reconcile:needed'; reason: string }
  | SyncEventBase & { type: 'reconcile:completed' }
  | SyncEventBase & { type: 'repair:started'; attempt: number }
  | SyncEventBase & { type: 'repair:completed' }
  | SyncEventBase & { type: 'repair:failed'; attempt: number; error: string }
  | SyncEventBase & { type: 'degraded-poll:entered' }
  | SyncEventBase & { type: 'gap:detected'; reason: string };

export type SyncEventListener = (event: SyncEvent) => void;

// ---------------------------------------------------------------------------
// Dead letter tracking
// ---------------------------------------------------------------------------

/** Category of sync failure for dead letter entries. */
export type DeadLetterCategory = 'admit-failed';

/** A message that permanently failed to sync. */
export type DeadLetterEntry = {
  /** The message CID that failed. */
  messageCid: string;
  /** The tenant DID the message belongs to. */
  tenantDid: string;
  /** The remote DWN endpoint involved (for push failures). */
  remoteEndpoint?: string;
  /** The protocol URI, if applicable. */
  protocol?: string;
  /** What kind of failure occurred. */
  category: DeadLetterCategory;
  /** Machine-readable error code (for example, an HTTP status or admission reason). */
  errorCode?: string;
  /** Human-readable error detail. */
  errorDetail: string;
  /** ISO-8601 timestamp of when the failure was recorded. */
  failedAt: string;
};

/**
 * Sync health summary returned by `getSyncHealth()`.
 *
 * `failedMessageCount` reflects messages that are currently failing — entries
 * are auto-cleared when the same CID later succeeds via push or pull, so the
 * count decreases as the engine self-heals through reconciliation and repair.
 */
export type SyncHealthSummary = {
  /** Current connectivity state. */
  connectivity: SyncConnectivityState;
  /**
   * Number of messages currently in the dead letter store. Decreases as
   * the engine self-heals — entries are auto-cleared on later success.
   */
  failedMessageCount: number;
  /**
   * Number of current admission failures. A link can have matching sync roots
   * while still rejecting specific roots; this count keeps that state visible
   * to callers.
   */
  admissionFailureCount: number;
  /** Number of current sync links in 'repairing', 'degraded_poll', or terminal-incomplete status. */
  degradedLinkCount: number;
  /** True only when there are no failed messages and no degraded links. */
  syncHealthy: boolean;
};

export interface SyncEngine {
  /**
   * The agent that the SyncEngine is attached to.
   */
  agent: EnboxPlatformAgent;

  /**
   * Current connectivity state as observed by the sync engine.
   * Updated when WebSocket subscriptions connect/disconnect or when the
   * browser `online`/`offline` events fire.
   */
  readonly connectivityState: SyncConnectivityState;

  /**
   * Whether at least one live pull or push subscription is open.
   *
   * This is specifically about live-mode subscriptions — it is `false` in
   * poll mode and `false` when only the integrity timer remains (e.g. after
   * the last identity was removed). Callers use this to avoid calling
   * `startSync()` when live subscriptions are active, which would tear
   * them all down and rebuild from scratch.
   */
  readonly hasActiveSubscriptions: boolean;

  /**
   * Register an identity to be managed by the SyncEngine for syncing.
   * Callers must explicitly specify which protocols to sync (`'all'` for a
   * full replica, or a list of protocol URIs) so that sync scope is always
   * a deliberate choice rather than an invisible default.
   *
   * When live sync is active, the new identity is hot-added: its replication
   * links are created and subscriptions opened immediately, without tearing
   * down existing subscriptions for other identities. This enables
   * multi-identity agents (e.g. ElectroBun desktop DWN, multi-persona dApps)
   * to add identities at runtime without disrupting sync for others.
   */
  registerIdentity(params: { did: string, options: SyncIdentityOptions }): Promise<void>;
  /**
   * Unregister an identity from the SyncEngine, this will stop syncing messages for this identity.
   *
   * When live sync is active, the identity is hot-removed: its subscriptions
   * are closed and runtime state cleaned up without affecting other identities.
   */
  unregisterIdentity(did: string): Promise<void>;
  /**
   * Get the Sync Options for a specific identity.
   */
  getIdentityOptions(did: string): Promise<SyncIdentityOptions | undefined>;
  /**
   * Update the Sync Options for a specific identity, replaces the existing options.
   */
  updateIdentityOptions(params: { did: string, options: SyncIdentityOptions }): Promise<void>;
  /**
   * Preforms a one-shot sync operation. If no direction is provided, it will perform both push and pull.
   * @param direction which direction you'd like to perform the sync operation.
   *
   * @throws {Error} if a sync is already in progress or the sync operation fails.
   */
  sync(direction?: 'push' | 'pull'): Promise<void>;
  /**
   * Starts sync. In `'live'` mode opens real-time subscriptions with SMT
   * fallback; in `'poll'` mode uses periodic SMT reconciliation.
   *
   * Subsequent calls update the mode/interval. Calling with a different mode
   * tears down the previous mode's resources before starting the new one.
   */
  startSync(params: StartSyncParams): Promise<void>;
  /**
   * Stops the periodic sync operation, will complete the current sync operation if one is already in progress.
   *
   * @param timeout the maximum amount of time, in milliseconds, to wait for the current sync operation to complete. Default is 2000 (2 seconds).
   * @throws {Error} if the sync operation fails to stop before the timeout.
   */
  stopSync(timeout?: number): Promise<void>;

  /**
   * Subscribe to sync engine events. Returns an unsubscribe function.
   * Events are emitted at key state transitions: checkpoint advancement,
   * link status changes, repair, degraded_poll, gap detection.
   */
  on(listener: SyncEventListener): () => void;

  /**
   * Release all resources held by the sync engine (LevelDB handles, timers,
   * WebSocket subscriptions). After calling `close()`, the engine should not
   * be reused.
   */
  close(): Promise<void>;

  // ---------------------------------------------------------------------------
  // Dead letter / sync health
  // ---------------------------------------------------------------------------

  /**
   * Returns messages that are currently failing to sync, optionally filtered
   * by tenant. Entries are auto-cleared when the same CID later succeeds
   * (via push or pull), so the list reflects current health — not historical
   * incidents. Sorted newest-first by `failedAt`.
   */
  getFailedMessages(tenantDid?: string): Promise<DeadLetterEntry[]>;

  /**
   * Remove dead letter entries for a CID. When `remoteEndpoint` is provided,
   * only the entry for that specific CID + remote pair is removed. Without
   * it, all entries for the CID (across all remotes) are removed. Returns
   * `true` if at least one entry was found and removed.
   */
  clearFailedMessage(messageCid: string, remoteEndpoint?: string): Promise<boolean>;

  /**
   * Clear all dead letter entries, optionally scoped to a tenant.
   */
  clearAllFailedMessages(tenantDid?: string): Promise<void>;

  /**
   * Returns a summary of sync health: connectivity, failed message count,
   * and degraded link count.
   */
  getSyncHealth(): Promise<SyncHealthSummary>;
}
