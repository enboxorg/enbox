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
   * The protocols that should be synced for this identity, if an empty array is provided, all messages for all protocols will be synced.
   */
  protocols: string[];
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
      canonical.protocolPathPrefixes = [...new Set(scope.protocolPathPrefixes)].sort();
    }
    if (scope.contextIdPrefixes !== undefined) {
      canonical.contextIdPrefixes = [...new Set(scope.contextIdPrefixes)].sort();
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
  return btoa(base64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Causal frontier types
// ---------------------------------------------------------------------------

/**
 * Maximum number of out-of-order tokens a frontier may accumulate before
 * the link transitions to `repairing`. Normative per the sync redesign RFC.
 */
export const MAX_PENDING_TOKENS = 100;

/**
 * Tracks directional (pull or push) replay progression for a single
 * replication link. All tokens belong to the same `(streamId, epoch)`.
 */
export type DirectionFrontier = {
  /**
   * The latest token received from the source (pull) or confirmed by the
   * remote (push). May be ahead of `contiguousAppliedToken` when events
   * arrive out of order.
   */
  receivedToken?: ProgressToken;

  /**
   * The highest token where all prior positions have been durably applied.
   * This is the resume point after crash/reconnect. Only advances when
   * contiguous progression holds.
   */
  contiguousAppliedToken?: ProgressToken;

  /**
   * Tokens received out of order that have been applied but are not yet
   * contiguous with `contiguousAppliedToken`. Ordered ascending by position.
   * When this set exceeds {@link MAX_PENDING_TOKENS}, the link transitions
   * to `repairing`.
   */
  pendingTokens: ProgressToken[];
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

  /** Pull-direction frontier (remote → local). */
  pull: DirectionFrontier;

  /** Push-direction frontier (local → remote). */
  push: DirectionFrontier;

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
 * pattern so callers can advance the push frontier incrementally.
 */
export type PushResult = {
  /** messageCids that were accepted (202/204/409 — idempotent success). */
  succeeded: string[];
  /** messageCids that failed (retryable or hard error). */
  failed: string[];
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
   * Register an identity to be managed by the SyncEngine for syncing.
   * The options can define specific protocols that should only be synced, or a delegate DID that should be used to sign the sync messages.
   */
  registerIdentity(params: { did: string, options?: SyncIdentityOptions }): Promise<void>;
  /**
   * Unregister an identity from the SyncEngine, this will stop syncing messages for this identity.
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
   * Release all resources held by the sync engine (LevelDB handles, timers,
   * WebSocket subscriptions). After calling `close()`, the engine should not
   * be reused.
   */
  close(): Promise<void>;
}
