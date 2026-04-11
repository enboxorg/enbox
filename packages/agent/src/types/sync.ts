import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './agent.js';

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
   */
  protocols: 'all' | string[];
  /**
   * Sync privacy mode. `'standard'` is the default wire-visible protocol
   * scoping; `'private'` will use a single opaque SMT with no per-protocol
   * identifiers on the wire (not yet implemented — reserved for future use).
   */
  syncMode?: 'standard' | 'private';
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
 * Describes what a replication link syncs. Currently whole-tenant only
 * (`kind: 'full'`). Scoped subset sync (`kind: 'protocol'` with
 * `protocolPathPrefixes` / `contextIdPrefixes`) is deferred to Phase 3.
 */
export type SyncScope = {
  /** Scope kind. Only `'full'` is implemented in Phase 1. */
  kind: 'full';
} | {
  /**
   * Protocol-scoped sync. Deferred to Phase 3 — included here for type
   * forward-compatibility only.
   */
  kind: 'protocol';
  protocol: string;
  protocolPathPrefixes?: string[];
  contextIdPrefixes?: string[];
};

/**
 * Computes a deterministic, collision-resistant identifier for a {@link SyncScope}.
 *
 * The ID is `base64url(SHA-256(canonicalJSON))` where `canonicalJSON` is the
 * scope object with keys sorted alphabetically and array values sorted
 * lexicographically.
 *
 * Used as part of the LevelDB key for the replication ledger:
 * `{tenantDid}^{remoteEndpoint}^{scopeId}`.
 */
export async function computeScopeId(scope: SyncScope): Promise<string> {
  const canonical: Record<string, unknown> = { kind: scope.kind };
  if (scope.kind === 'protocol') {
    canonical.protocol = scope.protocol;
    if (scope.protocolPathPrefixes !== undefined) {
      canonical.protocolPathPrefixes = [...new Set(scope.protocolPathPrefixes)].sort((a, b) => a.localeCompare(b));
    }
    if (scope.contextIdPrefixes !== undefined) {
      canonical.contextIdPrefixes = [...new Set(scope.contextIdPrefixes)].sort((a, b) => a.localeCompare(b));
    }
  }

  // Stable JSON: keys sorted by construction order (kind < protocol < protocolPathPrefixes).
  const json = JSON.stringify(canonical);
  const bytes = new TextEncoder().encode(json);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = new Uint8Array(hashBuffer);

  // base64url encode (no padding).
  let base64 = '';
  for (const b of hashArray) {
    base64 += String.fromCharCode(b);
  }
  const result = btoa(base64).replaceAll('+', '-').replaceAll('/', '_');
  // Strip trailing '=' padding without regex quantifiers (avoids ReDoS scanners).
  let end = result.length;
  while (end > 0 && result.codePointAt(end - 1) === 61) { end--; } // 61 === '='
  return end === result.length ? result : result.slice(0, end);
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
 * - `repairing` — gap detected or pending overflow; running SMT reconciliation.
 * - `degraded_poll` — subscription failed; polling at reduced frequency.
 * - `paused` — explicitly paused by the application.
 */
export type LinkStatus = 'initializing' | 'live' | 'repairing' | 'degraded_poll' | 'paused';

/**
 * Durable state of a single replication link. Persisted to LevelDB and
 * loaded on startup. Each link is identified by the tuple
 * `(tenantDid, remoteEndpoint, scopeId)`.
 */
export type ReplicationLinkState = {
  /** The tenant DID this link syncs for. */
  tenantDid: string;

  /** The remote DWN endpoint URL. */
  remoteEndpoint: string;

  /** Deterministic hash of the {@link SyncScope}. See {@link computeScopeId}. */
  scopeId: string;

  /** The scope definition this link covers. */
  scope: SyncScope;

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

  /**
   * Protocol filter for this link, if any. Duplicates the protocol in `scope`
   * for operational convenience — used by permission lookups and cursor key
   * building. The scope is the source of truth for what to sync; this field
   * is the source of truth for how to authenticate. To be consolidated in
   * Phase 3 when scope resolution is more complex.
   */
  protocol?: string;

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
/** A permanently failed push entry with diagnostic info. */
export type PermanentPushFailure = {
  cid : string;
  statusCode : number;
  detail : string;
};

export type PushResult = {
  /** messageCids that were accepted (202/204/409 — idempotent success). */
  succeeded: string[];
  /** messageCids that failed with a transient error (5xx, network) — worth retrying. */
  failed: string[];
  /** Messages that failed permanently (400/401/403) — will never succeed, do NOT retry. */
  permanentlyFailed: PermanentPushFailure[];
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
   * - `'poll'`: Legacy mode. Performs a full SMT set-reconciliation sync on a
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

/**
 * Events emitted by the sync engine at key state transitions.
 * Consumers subscribe via `SyncEngine.on('event', handler)` and can
 * hook these into metrics, logging, or UI state.
 */
export type SyncEvent =
  | { type: 'link:status-change'; tenantDid: string; remoteEndpoint: string; protocol?: string; from: LinkStatus; to: LinkStatus }
  | { type: 'link:connectivity-change'; tenantDid: string; remoteEndpoint: string; protocol?: string; from: SyncConnectivityState; to: SyncConnectivityState }
  | { type: 'checkpoint:pull-advance'; tenantDid: string; remoteEndpoint: string; protocol?: string; position: string; messageCid: string }
  | { type: 'reconcile:needed'; tenantDid: string; remoteEndpoint: string; protocol?: string; reason: string }
  | { type: 'reconcile:completed'; tenantDid: string; remoteEndpoint: string; protocol?: string }
  | { type: 'repair:started'; tenantDid: string; remoteEndpoint: string; protocol?: string; attempt: number }
  | { type: 'repair:completed'; tenantDid: string; remoteEndpoint: string; protocol?: string }
  | { type: 'repair:failed'; tenantDid: string; remoteEndpoint: string; protocol?: string; attempt: number; error: string }
  | { type: 'degraded-poll:entered'; tenantDid: string; remoteEndpoint: string; protocol?: string }
  | { type: 'gap:detected'; tenantDid: string; remoteEndpoint: string; protocol?: string; reason: string };

export type SyncEventListener = (event: SyncEvent) => void;

// ---------------------------------------------------------------------------
// Dead letter tracking
// ---------------------------------------------------------------------------

/** Category of sync failure for dead letter entries. */
export type DeadLetterCategory = 'push-permanent' | 'push-exhausted' | 'pull-processing' | 'closure';

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
  /** Machine-readable error code (e.g., HTTP status or ClosureFailureCode). */
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
  /** Number of links currently in 'repairing' or 'degraded_poll' status. */
  degradedLinkCount: number;
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
