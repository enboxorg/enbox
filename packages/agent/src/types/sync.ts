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

// ---------------------------------------------------------------------------
// Sync scope and scope identity
// ---------------------------------------------------------------------------

/**
 * Root algorithm used by durable message-feed full/protocol sync scopes.
 */
export const SYNC_PROJECTION_ROOT_VERSION = 'replication-log-feed-v1';

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
 * Full and protocol-set sync use durable message-feed filters and replication
 * fingerprints. Narrow protocolPath/contextId sync is not represented here; a
 * delegate must have grant coverage for every full protocol in the protocol set.
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
    base64 += String.fromCodePoint(b);
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
   * The highest token such that all earlier delivered tokens for this link
   * have been durably applied. This is the resume point after crash/reconnect.
   *
   * Advancement is controlled by the engine's delivery-order tracking,
   * not by position arithmetic. Positions may be sparse (filtered streams).
   */
  contiguousAppliedToken?: ProgressToken;
};

/** Direction of replication relative to the local DWN. */
export type SyncDirection = 'push' | 'pull';

/**
 * Options for a one-shot {@link SyncEngine.sync} run.
 */
export type SyncRunOptions = {
  /**
   * Restrict the run to one registered identity's replication targets. The
   * run reconciles only that identity's endpoints; every other registered
   * identity is untouched. Rejects when the DID is not registered.
   */
  did?: string;

  /**
   * Verify cids-only feed convergence after reconciliation and schedule
   * repair on divergence. Used by the engine's own settle checks.
   */
  verifyConvergence?: boolean;
};

/**
 * Status of a replication link.
 *
 * - `initializing` — link created, no subscriptions open yet.
 * - `live` — actively receiving events via subscription.
 * - `repairing` — gap detected or pending overflow; running durable feed repair.
 * - `paused` — link retries are stopped until the app updates registration or recreates the link.
 */
export type LinkStatus = 'initializing' | 'live' | 'repairing' | 'paused';

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

  /** Push-direction replication checkpoint (local → remote). */
  push: DirectionCheckpoint;

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
 * pattern so callers can retry transient failures, dead-letter terminal
 * failures, and mark links for later reconciliation.
 */
/** A failed push root with diagnostic info from the latest attempt. */
export type PushFailureKind = 'Invalid' | 'Deferred' | 'Incomplete';

export type PushFailure = {
  /** Requested root CID whose push did not converge. */
  cid: string;
  /** Root protocol URI, when known from the local feed entry. */
  protocol?: string;
  /** Non-root dependency CID that caused this root to fail, when applicable. */
  dependencyCid?: string;
  /** Structured remote apply result kind that produced the failure. */
  kind?: PushFailureKind;
  /** Remote `Deferred.reason`, when `kind` is `Deferred`. */
  reason?: 'tenant-inactive' | 'resolver-unavailable' | 'storage';
  /** True only for Invalid or terminal dependency outcomes. */
  terminal?: boolean;
  /** True when the remote tenant is inactive and retrying the same message would hot-loop. */
  tenantInactive?: boolean;
  /**
   * True when the remote rejected the push for tenant storage/message quota.
   * Like {@link tenantInactive}, retrying the same message immediately would
   * hot-loop — but unlike it, the block can self-heal once the remote quota
   * grows, another device delivers the CID, or local history retires it. The
   * engine therefore defers + re-probes instead of dead-lettering.
   */
  quotaBlocked?: boolean;
  /** True when the requested root CID was definitively absent from the local DWN. */
  localMissing?: boolean;
  /** Human-readable diagnostic detail. */
  detail?: string;
};

/** How a remote DWN acknowledged a successfully pushed message. */
export type PushSuccessResolution = 'applied' | 'superseded';

/** Successful push outcome reported by the remote DWN for a root or dependency. */
export type PushAcknowledgement = {
  /** CID acknowledged by the remote DWN. */
  cid: string;
  /** Whether the remote applied the message or already held newer state. */
  resolution: PushSuccessResolution;
};

export type PushResult = {
  /** Requested root messageCids that reached Applied, Duplicate, or Superseded. */
  succeeded: string[];
  /**
   * Deduplicated acknowledgement metadata for successful roots and dependencies.
   * Consumers may treat an omitted root entry as `applied` when its CID is in
   * `succeeded`.
   */
  acknowledged: PushAcknowledgement[];
  /** Requested root messageCids that failed and should be retried or reconciled. */
  failed: PushFailure[];
};

export function isTerminalPushFailure(failure: PushFailure): boolean {
  return failure.terminal === true;
}

/** A push rejected because the remote is out of tenant storage/message quota. */
export function isQuotaBlockedPushFailure(failure: PushFailure): boolean {
  return failure.quotaBlocked === true;
}

/**
 * Returns the reconcile reason for a push batch that cannot converge under the hot
 * retry ladder, or `undefined` when the batch is worth retrying immediately.
 *
 * `Incomplete` outranks tenant-inactive: a remote that still reports already
 * acknowledged dependencies as missing will not converge however often the same
 * closure is replayed, and retrying an inactive tenant hot-loops. Both defer to
 * delayed reconciliation rather than the immediate retry ladder.
 */
export function pushBatchReconcileReason(entries: Array<{ lastFailure?: PushFailure }>): string | undefined {
  const failures = entries.flatMap(entry => entry.lastFailure ?? []);

  if (failures.some(failure => failure.kind === 'Incomplete')) {
    return 'push-incomplete';
  }
  if (failures.some(failure => failure.quotaBlocked === true)) {
    return 'push-quota-blocked';
  }
  if (failures.some(failure => failure.tenantInactive === true)) {
    return 'push-tenant-inactive';
  }
  return undefined;
}

/**
 * Parameters for {@link SyncEngine.startSync}.
 */
export type StartSyncParams = {
  /**
   * The cadence of the periodic durable feed settle check — live sync's
   * degraded-network safety net. Each tick runs a convergence-verifying feed
   * reconciliation that repairs anything the real-time subscriptions missed
   * (dropped events, links waiting on a rate-limited subscription open,
   * long offline windows).
   *
   * Accepts duration strings such as `'30s'`, `'2m'`, `'10m'`, or `'1 hour'`.
   *
   * Default: `'5m'`.
   */
  interval?: string;
};

/**
 * Options for a one-shot local-node drain. The abort signal is cooperative:
 * in-flight DWN requests are allowed to settle, then remaining drain work stops.
 */
export type SyncDrainOptions = {
  signal?: AbortSignal;
};

/**
 * Per-link drain progress for a tenant and endpoint. A tenant can have more
 * than one target when delegated grants split the requested sync scope.
 */
export type SyncDrainTargetResult = {
  tenantDid: string;
  remoteEndpoint: string;
  scope?: SyncScope;
  completed: boolean;
  /** True only when this target stopped because the caller's abort signal fired. */
  cancelled: boolean;
  converged: boolean;
  /** True when the target was reachable but intentionally remains incomplete because of durable quota omissions. */
  quotaBlocked?: boolean;
  pushCheckpoint?: ProgressToken;
  localFingerprint?: string;
  remoteFingerprint?: string;
  error?: string;
};

/**
 * Result of draining all registered sync identities to a specific DWN endpoint.
 */
export type SyncDrainResult = {
  endpoint: string;
  completed: boolean;
  /** True only when the caller's abort signal was observed before completion. */
  cancelled: boolean;
  /** True when identity registration or agent topology changed while the drain was running. */
  topologyChanged: boolean;
  targets: SyncDrainTargetResult[];
  error?: string;
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

/** Project a link scope into the scope metadata attached to observability events. */
export function syncEventScope(scope: SyncScope | undefined): SyncEventScope {
  if (scope === undefined) {
    return {};
  }

  const coveredProtocols = protocolsForSyncScope(scope);
  if (coveredProtocols === undefined) {
    return {};
  }

  const protocols = [...coveredProtocols] as NonEmptyStringArray;
  return protocols.length === 1
    ? { protocol: protocols[0], protocols }
    : { protocols };
}

type SyncEventBase = {
  tenantDid: string;
  remoteEndpoint: string;
} & SyncEventScope;

/**
 * What a sync-delivered message is, extracted from its descriptor so event
 * consumers can route a change (e.g. invalidate an app cache for one protocol
 * path) without re-reading the local store.
 */
export type SyncMessageDescriptor = {
  /** DWN interface name, e.g. `Records` or `Protocols`. */
  interface: string;
  /** DWN method name, e.g. `Write` or `Delete`. */
  method: string;
  /** The message's `messageTimestamp`, when present. */
  messageTimestamp?: string;
  /** Protocol URI, for protocol-bound messages. */
  protocol?: string;
  /** Protocol path, for records messages. */
  protocolPath?: string;
  /** Record ID, for records messages. */
  recordId?: string;
  /** Context ID, for contextual records messages. */
  contextId?: string;
  /** The DID that authored the message, when recoverable from its authorization. */
  author?: string;
};

/**
 * Events emitted by the sync engine at key state transitions.
 * Consumers subscribe via `SyncEngine.on('event', handler)` and can
 * hook these into metrics, logging, or UI state.
 */
export type SyncEvent =
  | SyncEventBase & { type: 'link:status-change'; from: LinkStatus; to: LinkStatus }
  | SyncEventBase & { type: 'link:connectivity-change'; from: SyncConnectivityState; to: SyncConnectivityState }
  | SyncEventBase & { type: 'checkpoint:pull-advance'; position: string; messageCid?: string }
  | SyncEventBase & { type: 'checkpoint:push-advance'; position: string; messageCid?: string }
  /**
   * Emitted once per FRESHLY applied message a live pull delivery admits —
   * the delivered root and any fetched dependency (parent, role record,
   * initial write) admitted alongside it — with each message described so
   * consumers can react to the specific change (protocol path, record,
   * author) without querying. `Duplicate`/`Superseded` applies (echoes of
   * messages this store already held) are silent. Live-path only: messages
   * admitted by durable-feed reconciliation are reported through
   * `reconcile:applied` (cids-only) instead — that split is the origin
   * signal (`delivery:applied` = pushed to us in real time;
   * `reconcile:applied` = found by a reconciliation pass, including one-shot
   * `sync()` runs this agent initiated itself).
   */
  | SyncEventBase & { type: 'delivery:applied'; messageCid: string; descriptor: SyncMessageDescriptor }
  /** Emitted when set reconciliation admits remote messages outside the live pull checkpoint stream. */
  | SyncEventBase & { type: 'reconcile:applied'; messageCids: string[] }
  | SyncEventBase & { type: 'reconcile:needed'; reason: string }
  | SyncEventBase & { type: 'reconcile:completed' }
  | SyncEventBase & { type: 'repair:started'; attempt: number }
  | SyncEventBase & { type: 'repair:completed' }
  | SyncEventBase & { type: 'repair:failed'; attempt: number; error: string }
  | SyncEventBase & { type: 'gap:detected'; reason: string }
  /** A push was rejected because the remote is out of storage/message quota for this tenant. Re-probing is deferred until `nextProbeAt`. */
  | SyncEventBase & { type: 'push:quota-blocked'; messageCid: string; detail?: string; nextProbeAt: string }
  /** A previously quota-blocked push was acknowledged or retired because it no longer exists locally. */
  | SyncEventBase & { type: 'push:quota-cleared'; messageCid: string; resolution: PushSuccessResolution };

export type SyncEventListener = (event: SyncEvent) => void;

// ---------------------------------------------------------------------------
// Dead letter tracking
// ---------------------------------------------------------------------------

/** A message that permanently failed to sync. */
export type DeadLetterEntry = {
  /** The message CID that failed. */
  messageCid: string;
  /** The tenant DID the message belongs to. */
  tenantDid: string;
  /** The remote DWN endpoint involved. */
  remoteEndpoint: string;
  /** The protocol URI, if applicable. */
  protocol?: string;
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
  /** Number of current sync links in `repairing` or `paused` status. */
  degradedLinkCount: number;
  /**
   * Number of messages currently deferred because a remote rejected the push
   * for tenant storage/message quota. These are re-probed on a backoff and
   * self-heal when quota grows, another device delivers the CID, or local
   * history retires it. They are user-actionable state, not a dead letter.
   */
  quotaBlockedMessageCount: number;
  /** True only when there are no failed messages, quota blocks, or degraded links. */
  syncHealthy: boolean;
};

/**
 * Coarse per-remote sync state for UI. Precedence when several apply:
 * `offline` > `quota-blocked` > `degraded` > `healthy`.
 */
export type RemoteSyncState = 'healthy' | 'quota-blocked' | 'degraded' | 'offline';

/**
 * Per-`(tenantDid, remoteEndpoint)` sync status snapshot. Returned by
 * {@link SyncEngine.getRemoteSyncStatus} so a frontend can render each remote's
 * health, alert when one stops accepting writes, and trigger a resume.
 */
export type RemoteSyncStatus = {
  tenantDid: string;
  remoteEndpoint: string;
  /** Rolled-up state for a status badge. */
  state: RemoteSyncState;
  /** Per-link connectivity as observed by the engine. */
  connectivity: SyncConnectivityState;
  /** Messages currently deferred against this remote for quota. */
  quotaBlockedMessageCount: number;
  /** Dead-lettered (terminal) messages for this remote. */
  failedMessageCount: number;
  /** ISO-8601 time of the soonest quota re-probe across this remote's blocked messages, if any. */
  nextProbeAt?: string;
  /** Human-readable detail of the most recent quota block, if any. */
  lastError?: string;
  /** ISO-8601 timestamp of the latest successful activity across current links for this remote. */
  lastActivityAt?: string;
};

/**
 * Read-only snapshot of one current replication link, one row per
 * `(tenantDid, remoteEndpoint, scope)`. Where {@link RemoteSyncStatus} rolls
 * links up per remote for a status badge, this exposes the per-link detail an
 * app needs to reason about replication progress — most notably `status`:
 * a link whose status has reached `live` has finished replaying its remote
 * backlog (the subscription's end-of-stored-events marker), so "every link
 * for this identity is `live`" is the per-identity caught-up signal.
 */
export type ReplicationLinkSnapshot = {
  /** The tenant DID this link syncs for. */
  tenantDid: string;
  /** The remote DWN endpoint URL. */
  remoteEndpoint: string;
  /** The scope definition this link covers. */
  scope: SyncScope;
  /** Current link status (`initializing` | `live` | `repairing` | `paused`). */
  status: LinkStatus;
  /** Per-link connectivity state. */
  connectivity: SyncConnectivityState;
  /** Delegate DID used to sign sync messages, if any. */
  delegateDid?: string;
  /** Durable pull checkpoint position (remote → local), when advanced past the stream start. */
  pullPosition?: string;
  /** Durable push checkpoint position (local → remote), when advanced past the stream start. */
  pushPosition?: string;
  /** ISO-8601 timestamp of last successful sync activity. */
  lastActivityAt?: string;
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
   * This is specifically about live subscriptions — it is `false` when only
   * the settle-check timer remains (e.g. after the last identity was
   * removed). Callers use this to avoid calling `startSync()` when live
   * subscriptions are active, which would tear them all down and rebuild
   * from scratch.
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
   * Performs a one-shot sync operation. If no direction is provided, it will perform both push and pull.
   *
   * Concurrent calls coalesce instead of throwing: when a sync (or drain) is
   * already holding the lock, the call joins a single queued follow-up run
   * that starts after the current operation completes. All joined callers
   * share that run's outcome, and their requested directions/scopes are
   * merged (differing directions widen to both; differing scopes widen to
   * unscoped) so the follow-up covers every joined request. A runtime
   * transition (`startSync`/`stopSync`/`clear`/`close`) while the follow-up
   * is still queued cancels it — joined callers reject with
   * `SyncRunCancelledError`, keeping "resolved ⇒ a covering run completed"
   * true for every caller.
   *
   * @param direction which direction you'd like to perform the sync operation.
   * @param options optional scoping — `did` restricts the run to one
   * registered identity's replication targets (its endpoints only), which
   * keeps an app-triggered "pull my inbox now" from re-reconciling every
   * other identity.
   *
   * @throws {Error} if `options.did` is not a registered identity, or the sync operation fails.
   */
  sync(direction?: SyncDirection, options?: SyncRunOptions): Promise<void>;
  /**
   * Drains every registered sync identity to the given DWN endpoint.
   *
   * This is a one-shot eject primitive: it creates or resumes durable
   * replication links for `endpoint`, persists it as a supplemental target
   * for later live sync, replays local and remote feeds, and requires two
   * stable cids-only convergence snapshots before marking a target complete.
   * Empty plans, paused links, cancellation, or registration changes produce
   * an incomplete result that callers may safely retry.
   *
   * @throws {Error} if another one-shot sync or drain is already in progress.
   */
  drainTo(endpoint: string, options?: SyncDrainOptions): Promise<SyncDrainResult>;
  /**
   * Starts live sync: opens `MessagesSubscribe` WebSocket subscriptions to
   * remote DWNs for real-time pull, listens to the local EventLog for
   * immediate push, and runs a periodic durable feed settle check at
   * `interval` to repair anything the subscriptions missed.
   *
   * Subsequent calls update the interval, tearing down the previous
   * runtime's resources before starting the new one.
   *
   * The returned promise resolves after the initial durable-feed catch-up
   * and after link subscriptions have been opened for identities registered
   * before the call — so `await startSync(...)` is the "initially caught up"
   * signal for those identities, best-effort: individual link failures
   * schedule repair rather than rejecting. Identities hot-added later report
   * their own catch-up through {@link SyncEngine.getReplicationLinks} (all
   * links `'live'`) and the `link:status-change` event.
   *
   * Userland polling needs no engine mode: the one-shot {@link SyncEngine.sync}
   * runs the same durable feed reconciliation on demand, e.g.
   * `setInterval(() => { agent.sync.sync().catch(console.error); }, ms)`.
   */
  startSync(params?: StartSyncParams): Promise<void>;
  /**
   * Stops the sync runtime, will complete the current sync operation if one is already in progress.
   *
   * @param timeout the maximum amount of time, in milliseconds, to wait for the current sync operation to complete. Default is 2000 (2 seconds).
   * @throws {Error} if the sync operation fails to stop before the timeout.
   */
  stopSync(timeout?: number): Promise<void>;

  /**
   * Subscribe to sync engine events. Returns an unsubscribe function.
   * Events are emitted at key state transitions: checkpoint advancement,
   * link status changes, repair, gap detection.
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

  /**
   * Returns a per-`(tenantDid, remoteEndpoint)` sync status snapshot, optionally
   * filtered by tenant. Lets a frontend render each remote's health (healthy /
   * quota-blocked / degraded / offline), show when a quota-blocked remote will
   * next be re-probed, and surface the latest error/activity. Rows are derived from
   * current durable link state plus live quota-block and dead-letter records.
   */
  getRemoteSyncStatus(tenantDid?: string): Promise<RemoteSyncStatus[]>;

  /**
   * Returns a read-only snapshot of every current replication link, optionally
   * filtered by tenant. Superseded links (from a previous scope/delegate
   * registration) are excluded. An identity has completed its initial
   * catch-up when every one of its links reports `status: 'live'` —
   * `startSync()` resolving covers identities registered before start, and
   * this surface covers hot-added identities and later inspection.
   */
  getReplicationLinks(tenantDid?: string): Promise<ReplicationLinkSnapshot[]>;

  /**
   * Immediately re-probe a remote's quota-blocked messages instead of waiting
   * for the backoff. Runs targeted, per-link probes for
   * `(tenantDid, remoteEndpoint)`, so a UI "Retry now" button (or a freshly
   * purchased quota) resumes without touching unrelated remotes. No-op when
   * nothing is blocked.
   */
  retryRemoteNow(tenantDid: string, remoteEndpoint: string): Promise<void>;
}
