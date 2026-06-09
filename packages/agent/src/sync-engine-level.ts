import type { AbstractLevel } from 'abstract-level';

import type { DwnSubscriptionHandler, ResubscribeFactory } from '@enbox/dwn-clients';
import type { GenericMessage, MessageEvent, MessagesSubscribeReply, MessagesSyncDiffEntry, MessagesSyncReply, ProgressToken, ProtocolsConfigureMessage, ProtocolsQueryReply, RecordsWriteMessage, StateIndex, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import ms from 'ms';

import { Level } from 'level';
import { sleep } from '@enbox/common';
import { authenticate, DwnInterfaceName, DwnMethodName, Encoder, hashToHex, initDefaultHashes, Message, ProtocolsConfigure, RecordsWrite } from '@enbox/dwn-sdk-js';

import type { DwnMessageParams } from './types/dwn.js';
import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { SyncMessageEntry } from './sync-messages.js';
import type { SyncScopeClassification } from './sync-scope-acceptance.js';
import type { ClosureEvaluationContext, ClosureResult } from './sync-closure-types.js';
import type { DeadLetterCategory, DeadLetterEntry, NonEmptyStringArray, PushResult, ReplicationLinkState, StartSyncParams, SyncAuthorization, SyncConnectivityState, SyncEngine, SyncEvent, SyncEventListener, SyncEventScope, SyncHealthSummary, SyncIdentityOptions, SyncMode, SyncScope } from './types/sync.js';

import { AgentPermissionsApi } from './permissions-api.js';

import { buildLinkId } from './sync-link-id.js';
import { DwnInterface } from './types/dwn.js';
import { evaluateClosure } from './sync-closure-resolver.js';
import { isRecordsWrite } from './utils.js';
import { ReplicationLedger } from './sync-replication-ledger.js';
import { topologicalSort } from './sync-topological-sort.js';
import { classifySyncEventScope, classifySyncMessageScope } from './sync-scope-acceptance.js';
import { ClosureFailureCode, createClosureContext, invalidateClosureCache, isTerminalClosureFailureCode } from './sync-closure-types.js';
import { computeAuthorizationEpoch, computeProjectionId, lexicographicalCompare, MAX_PENDING_TOKENS, protocolsForSyncScope, singleProtocolForSyncScope, syncScopeFromProtocols } from './types/sync.js';
import { fetchRemoteMessages, getMessageCid, pullMessages, pushMessages, SyncPullAbortedError } from './sync-messages.js';
import { partitionRemoteEntries, SyncLinkReconciler } from './sync-link-reconciler.js';
import { permissionGrantIdsFromEntries, resolveMessagesSyncScopes, toMessagesPermissionGrantIds, toSyncAuthorizationGrants } from './sync-permission-grants.js';

export type SyncEngineLevelParams = {
  agent?: EnboxPlatformAgent;
  dataPath?: string;
  db?: AbstractLevel<string | Buffer | Uint8Array>;
};

/**
 * Maximum bit prefix depth for the per-node tree walk fallback.
 * At depth 16, each subtree covers ~1/65536 of the key space.
 */
const MAX_DIFF_DEPTH = 16;

/**
 * Bit depth for the batched diff protocol.
 * Lower than MAX_DIFF_DEPTH because the batched diff sends all subtree hashes
 * in a single request — fine granularity comes from the server-side leaf
 * enumeration, not from deeper prefixes. Depth 8 = 256 buckets, which is
 * a good balance between hash map size and leaf-set resolution.
 */
const BATCHED_DIFF_DEPTH = 8;

/**
 * Debounce window for batching writes that arrive while a push is in flight.
 * The first write in a quiet window triggers an immediate push; subsequent
 * writes arriving during the push are batched and flushed after this delay
 * once the in-flight push completes.
 */
const PUSH_DEBOUNCE_MS = 100;

/** Tracks a live subscription to a remote DWN for one sync target. */
type LiveSubscription = {
  linkKey: string;
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  close: () => Promise<void>;
};

/** Tracks a local EventLog subscription for push-on-write. */
type LocalSubscription = {
  linkKey: string;
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  close: () => Promise<void>;
};

type SyncTarget = {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  scope: SyncScope;
  authorization: SyncAuthorization;
  authorizationEpoch: string;
  permissionGrantIds?: NonEmptyStringArray;
};

type SyncTargetResolution = Pick<SyncTarget, 'authorization' | 'authorizationEpoch' | 'delegateDid' | 'permissionGrantIds' | 'scope'>;

type LinkSyncTarget = SyncTarget & { linkKey: string };

enum LinkSubscriptionOpenResult {
  ReadyForLive = 'readyForLive',
  Polling = 'polling',
  Repairing = 'repairing',
}

enum LinkInitializationStatus {
  Active = 'active',
  Failed = 'failed',
}

type LinkInitializationResult =
  | { status: LinkInitializationStatus.Active; durableLinkIdentityKey: string }
  | { status: LinkInitializationStatus.Failed };

type PullAcceptanceResult =
  | { accepted: true }
  | { accepted: false; classification: Exclude<SyncScopeClassification, 'in-scope'> };

type ProtocolsConfigureDefinition = {
  protocol: string;
  uses?: Record<string, unknown>;
};
type ProtocolsConfigureDefinitionDescriptor = GenericMessage['descriptor'] & {
  definition: ProtocolsConfigureDefinition;
};
type MaybeProtocolsConfigureDefinitionDescriptor = GenericMessage['descriptor'] & {
  definition?: {
    protocol?: string;
    uses?: Record<string, unknown>;
  };
};

type SyncReconcileTarget = {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  scope: SyncScope;
  authorization: SyncAuthorization;
};

type SyncReconcileOptions = {
  direction?: 'push' | 'pull';
  verifyConvergence?: boolean;
};

type SyncReconcileResult = {
  aborted?: boolean;
  converged?: boolean;
};

type SyncDiffResult = {
  onlyRemote: MessagesSyncDiffEntry[];
  onlyLocal: string[];
};

type ProtocolSetReconcileContext = {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  scope: SyncScope;
  permissionGrantIds?: NonEmptyStringArray;
  protocols: NonEmptyStringArray;
  shouldContinue?: () => boolean;
};

type ProtocolSetDiffCollectionResult =
  | { aborted: true }
  | { aborted: false; diffs: SyncDiffResult[] };

// ---------------------------------------------------------------------------
// Per-link in-memory delivery-order tracking (not persisted to ledger)
// ---------------------------------------------------------------------------

/**
 * Tracks an in-flight delivery that has been started but may not yet be
 * durably committed. Used by the pull path to handle async completion
 * reordering — subscription callbacks are fire-and-forget, so event B
 * can complete before event A even though A was delivered first.
 */
type InFlightCommit = {
  /** Monotonic delivery ordinal for this link. */
  ordinal: number;
  /** The token associated with this delivery. */
  token: ProgressToken;
  /** Whether processRawMessage has completed successfully. */
  committed: boolean;
};

/**
 * Per-link runtime state held in memory. Not persisted — on crash,
 * replay restarts from `contiguousAppliedToken` (idempotent apply).
 */
type LinkRuntimeState = {
  /** Next ordinal to assign when a pull event is delivered. */
  nextDeliveryOrdinal: number;
  /** Next ordinal to check when draining committed entries. */
  nextCommitOrdinal: number;
  /** In-flight deliveries keyed by ordinal. */
  inflight: Map<number, InFlightCommit>;
};

type PushRuntimeEntry = { cid: string };

type PushRuntimeState = {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  protocol?: string;
  permissionGrantIds?: NonEmptyStringArray;
  entries: PushRuntimeEntry[];
  retryCount: number;
  timer?: ReturnType<typeof setTimeout>;
  /** True while a push HTTP request is in flight for this link. */
  flushing?: boolean;
};

type PushFlushBatch = {
  pushRuntime: PushRuntimeState;
  pushEntries: PushRuntimeEntry[];
  isStale: () => boolean;
};

type LivePullContext = {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  eventScope: SyncEventScope;
  linkKey: string;
  link?: ReplicationLinkState;
  permissionGrantIds?: NonEmptyStringArray;
  isStale: () => boolean;
};

type PullDelivery = {
  runtime?: LinkRuntimeState;
  ordinal: number;
};

type LivePullDataStreamFactory = () => Promise<ReadableStream<Uint8Array> | undefined>;

type ApplyStatus = {
  code: number;
  detail?: string;
};

function syncEventScope(scope: SyncScope | undefined): SyncEventScope {
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

export class SyncEngineLevel implements SyncEngine {
  /**
   * Holds the instance of a `EnboxPlatformAgent` that represents the current execution context for
   * the `SyncEngineLevel`. This agent is used to interact with other Enbox agent components. It's
   * vital to ensure this instance is set to correctly contextualize operations within the broader
   * Enbox Agent framework.
   */
  private _agent?: EnboxPlatformAgent;

  /**
   * An instance of the `AgentPermissionsApi` that is used to interact with permissions grants used during sync
   */
  private _permissionsApi: PermissionsApi;

  private readonly _db: AbstractLevel<string | Buffer | Uint8Array>;
  private _syncIntervalId?: ReturnType<typeof setInterval>;
  private _syncLock = false;

  /**
   * Durable replication ledger — persists per-link checkpoint state.
   * Used by live sync to track pull progression per link.
   * Lazily initialized on first use to avoid sublevel() calls on mock dbs.
   */
  private _ledger?: ReplicationLedger;

  /**
   * In-memory cache of active links, keyed by `{did}^{dwnUrl}^{protocol}`.
   * Populated from the ledger on `startLiveSync`, used by subscription handlers
   * to avoid async ledger lookups on every event.
   */
  private readonly _activeLinks: Map<string, ReplicationLinkState> = new Map();

  /**
   * Per-link in-memory delivery-order tracking for the pull path. Keyed by
   * the same link key as `_activeLinks`. Not persisted — on crash, replay
   * restarts from `contiguousAppliedToken` and idempotent apply handles
   * re-delivered events.
   */
  private readonly _linkRuntimes: Map<string, LinkRuntimeState> = new Map();

  /**
   * Hex-encoded default hashes for empty subtrees at each depth, keyed by depth.
   * Lazily initialized on first use. Used by `walkTreeDiff` to detect empty subtrees
   * and short-circuit the recursive walk instead of descending all the way to MAX_DIFF_DEPTH.
   */
  private _defaultHashHex?: Map<number, string>;

  // ---------------------------------------------------------------------------
  // Live sync state
  // ---------------------------------------------------------------------------

  /** Current sync mode, set by `startSync`. Reset to `undefined` by `stopSync`/`clear`. */
  private _syncMode: SyncMode | undefined = 'poll';

  /**
   * Monotonic session generation counter. Incremented on every teardown.
   * Async operations (repair, retry timers) capture the generation at start
   * and bail if it has changed — this prevents stale work from mutating
   * state after teardown or mode switch.
   */
  private _engineGeneration = 0;

  /** Active live pull subscriptions (remote -> local via MessagesSubscribe). */
  private _liveSubscriptions: LiveSubscription[] = [];

  /** Active local EventLog subscriptions for push-on-write (local -> remote). */
  private _localSubscriptions: LocalSubscription[] = [];

  /** Connectivity state derived from subscription health. */
  private _connectivityState: SyncConnectivityState = 'unknown';

  /** Registered event listeners for observability. */
  private readonly _eventListeners: Set<SyncEventListener> = new Set();

  /** Per-link push runtime: queue, debounce timer, retry state. */
  private readonly _pushRuntimes: Map<string, PushRuntimeState> = new Map();

  /**
   * CIDs recently received via pull subscription, keyed by `cid|dwnUrl` to
   * scope suppression per remote endpoint. A message pulled from Provider A
   * is only suppressed for push back to Provider A — it still fans out to
   * Provider B and C. TTL: 60 seconds. Cap: 10,000 entries.
   */
  private readonly _recentlyPulledCids: Map<string, number> = new Map();

  /** TTL for echo-loop suppression entries (60 seconds). */
  private static readonly ECHO_SUPPRESS_TTL_MS = 60_000;

  /**
   * Per-tenant closure evaluation contexts for the current live sync session.
   * Caches ProtocolsConfigure and grant lookups across events for the same
   * tenant. Keyed by tenantDid to prevent cross-tenant cache pollution.
   */
  private readonly _closureContexts: Map<string, ClosureEvaluationContext> = new Map();

  /** Deduplicates concurrent live-sync repairs for the same tenant/protocol. */
  private readonly _protocolMetadataRepairs: Map<string, Promise<boolean>> = new Map();

  /** Maximum entries in the echo-loop suppression cache. */
  private static readonly ECHO_SUPPRESS_MAX_ENTRIES = 10_000;

  /** Validate `SyncIdentityOptions` for `registerIdentity` and `updateIdentityOptions`. */
  private static validateSyncIdentityOptions(options: SyncIdentityOptions): void {
    if (!options || !('protocols' in options)) {
      throw new Error('SyncEngineLevel: options.protocols is required — pass \'all\' for a full replica or a non-empty protocol list.');
    }
    if (options.protocols !== 'all' && !Array.isArray(options.protocols)) {
      throw new Error('SyncEngineLevel: protocols must be \'all\' or a non-empty string array.');
    }
    if (Array.isArray(options.protocols) && options.protocols.length === 0) {
      throw new Error('SyncEngineLevel: protocols must be \'all\' or a non-empty array of protocol URIs. An empty array is ambiguous.');
    }
  }

  private async buildSyncTargetsForEndpoint(did: string, dwnUrl: string, options: SyncIdentityOptions): Promise<SyncTarget[]> {
    const requestedScope = syncScopeFromProtocols(options.protocols);
    const resolutions = await this.buildSyncTargetResolutions(did, requestedScope, options);

    return resolutions.map(resolution => ({
      did,
      dwnUrl,
      ...resolution,
    }));
  }

  private async buildSyncTargetResolutions(did: string, requestedScope: SyncScope, options: SyncIdentityOptions): Promise<SyncTargetResolution[]> {
    const { delegateDid } = options;

    if (delegateDid === undefined) {
      return [{
        scope              : requestedScope,
        authorization      : { kind: 'owner' },
        authorizationEpoch : await computeAuthorizationEpoch({ kind: 'owner' }),
      }];
    }

    const resolvedScopes = await resolveMessagesSyncScopes({
      did,
      delegateDid,
      requestedScope,
      messageType    : DwnInterface.MessagesSync,
      permissionsApi : this._permissionsApi,
    });

    return Promise.all(resolvedScopes.map(async ({ scope, permissionGrants }) => {
      const permissionGrantIds = permissionGrantIdsFromEntries(permissionGrants);
      if (permissionGrantIds === undefined) {
        throw new Error(`SyncEngineLevel: delegate ${delegateDid} has no active sync grants for ${did}.`);
      }

      return {
        scope,
        delegateDid,
        authorization: {
          kind: 'delegate' as const,
          delegateDid,
          permissionGrantIds,
        },
        authorizationEpoch: await computeAuthorizationEpoch({
          kind   : 'delegate' as const,
          delegateDid,
          grants : toSyncAuthorizationGrants(permissionGrants),
        }),
        permissionGrantIds,
      };
    }));
  }

  /**
   * Cached sync targets result from the last {@link getSyncTargets} call.
   * Invalidated on identity registration/unregistration/update.
   * TTL-based: cleared after 30 seconds to pick up DID document changes.
   */
  private _syncTargetsCache?: {
    targets: SyncTarget[];
    timestamp: number;
  };

  /**
   * Monotonic generation counter for sync target cache invalidation.
   * Bumped on every invalidation (register/unregister/update/clear/close/stopSync).
   * An in-flight `getSyncTargets()` captures the generation before awaiting
   * and only writes to the cache if it hasn't changed, preventing a
   * concurrent mutation from being masked by stale data.
   */
  private _syncTargetsCacheGeneration = 0;

  /** TTL for the sync targets cache (30 seconds). */
  private static readonly SYNC_TARGETS_CACHE_TTL_MS = 30_000;

  /** Backoff schedule for recently published did:dht records. */
  private static readonly DID_RESOLUTION_RETRY_BACKOFF_MS = [2000, 4000, 8000];

  /** Count of consecutive SMT sync failures (for backoff in poll mode). */
  private _consecutiveFailures = 0;

  /** Maximum consecutive failures before entering backoff. */
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;

  /** Backoff multiplier for consecutive failures (caps at 4x the configured interval). */
  private static readonly MAX_BACKOFF_MULTIPLIER = 4;

  /**
   * Bound browser event handlers so they can be added and removed.
   * Set in `startBrowserConnectivityListeners`, cleared in `stopBrowserConnectivityListeners`.
   */
  private _onOnline?: () => void;
  private _onOffline?: () => void;
  private _onVisibilityChange?: () => void;

  constructor({ agent, dataPath, db }: SyncEngineLevelParams) {
    this._agent = agent;
    this._permissionsApi = new AgentPermissionsApi({ agent });
    this._db = (db) ? db : new Level<string, string>(dataPath ?? 'DATA/AGENT/SYNC_STORE');
  }

  /** Lazy accessor for the replication ledger. */
  private get ledger(): ReplicationLedger {
    if (!this._ledger) {
      this._ledger = new ReplicationLedger(this._db);
    }
    return this._ledger;
  }

  /** LevelDB sublevel for permanently failed messages (dead letters). */
  private get _deadLetters(): AbstractLevel<string | Buffer | Uint8Array, string, string> {
    return this._db.sublevel('deadLetters') as unknown as AbstractLevel<string | Buffer | Uint8Array, string, string>;
  }

  /**
   * Retrieves the `EnboxPlatformAgent` execution context.
   *
   * @returns The `EnboxPlatformAgent` instance that represents the current execution context.
   * @throws Will throw an error if the `agent` instance property is undefined.
   */
  get agent(): EnboxPlatformAgent {
    if (this._agent === undefined) {
      throw new Error('SyncEngineLevel: Unable to determine agent execution context.');
    }

    return this._agent;
  }

  set agent(agent: EnboxPlatformAgent) {
    this._agent = agent;
    this._permissionsApi = new AgentPermissionsApi({ agent });
    // Cached sync targets were resolved through the previous agent's
    // DID resolver / endpoint lookup — invalidate so the next sync
    // tick re-resolves through the new agent.
    this._syncTargetsCache = undefined;
    this._syncTargetsCacheGeneration++;
  }

  get hasActiveSubscriptions(): boolean {
    return this._liveSubscriptions.length > 0 ||
           this._localSubscriptions.length > 0;
  }

  get connectivityState(): SyncConnectivityState {
    // Aggregate per-link connectivity: if any link is online, report online.
    // If all are offline, report offline. If all unknown, report unknown.
    // Falls back to the global _connectivityState for poll-mode (no active links).
    if (this._activeLinks.size === 0) {
      return this._connectivityState;
    }

    let hasOnline = false;
    let hasOffline = false;
    for (const link of this._activeLinks.values()) {
      if (link.connectivity === 'online') { hasOnline = true; }
      if (link.connectivity === 'offline') { hasOffline = true; }
    }

    if (hasOnline) { return 'online'; }
    if (hasOffline) { return 'offline'; }
    return 'unknown';
  }

  public on(listener: SyncEventListener): () => void {
    this._eventListeners.add(listener);
    return (): void => { this._eventListeners.delete(listener); };
  }

  /** Emit a sync event to all registered listeners. */
  private emitEvent(event: SyncEvent): void {
    for (const listener of this._eventListeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors propagate into sync engine logic.
      }
    }
  }

  public async clear(): Promise<void> {
    this._syncTargetsCache = undefined;
    this._syncTargetsCacheGeneration++;
    await this.teardownLiveSync();
    this._syncMode = undefined;
    await this._permissionsApi.clear();
    await this._db.clear();
  }

  public async close(): Promise<void> {
    this._syncTargetsCache = undefined;
    this._syncTargetsCacheGeneration++;
    await this.teardownLiveSync();
    await this._db.close();
  }

  public async registerIdentity({ did, options }: { did: string; options: SyncIdentityOptions }): Promise<void> {
    SyncEngineLevel.validateSyncIdentityOptions(options);

    const registeredIdentities = this._db.sublevel('registeredIdentities');

    const existing = await this.getIdentityOptions(did);
    if (existing) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is already registered.`);
    }

    await registeredIdentities.put(did, JSON.stringify(options));
    this._syncTargetsCache = undefined;
    this._syncTargetsCacheGeneration++;

    // If live sync is active, hot-add subscriptions for this identity.
    if (this._syncMode === 'live') {
      const currentIdentityKeys = await this.addIdentityToLiveSync(did, options);
      if (currentIdentityKeys.size > 0) {
        await this.pruneSupersededDurableLinksForIdentity(did, currentIdentityKeys);
      }
    } else {
      await this.tryPruneSupersededDurableLinksForRegisteredIdentity(did, options);
    }
  }

  public async unregisterIdentity(did: string): Promise<void> {
    const registeredIdentities = this._db.sublevel('registeredIdentities');
    const existing = await this.getIdentityOptions(did);
    if (!existing) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
    }

    // If live sync is active, hot-remove subscriptions for this identity.
    if (this._syncMode === 'live') {
      await this.removeIdentityFromLiveSync(did);
    }

    await registeredIdentities.del(did);
    this._syncTargetsCache = undefined;
    this._syncTargetsCacheGeneration++;
    await this.pruneSupersededDurableLinksForIdentity(did, new Set());
  }

  public async getIdentityOptions(did: string): Promise<SyncIdentityOptions | undefined> {
    const registeredIdentities = this._db.sublevel('registeredIdentities');
    try {
      const options = await registeredIdentities.get(did);
      if (options) {
        return JSON.parse(options) as SyncIdentityOptions;
      }
    } catch (error) {
      const e = error as { code: string };
      // `Level` throws an error if the key is not present. Return `undefined` in this case.
      if (e.code === 'LEVEL_NOT_FOUND') {
        return;
      } else {
        throw new Error(`SyncEngineLevel: Error reading level: ${e.code}.`);
      }
    }
  }

  public async updateIdentityOptions({ did, options }: { did: string, options: SyncIdentityOptions }): Promise<void> {
    SyncEngineLevel.validateSyncIdentityOptions(options);

    const registeredIdentities = this._db.sublevel('registeredIdentities');
    const existingOptions = await this.getIdentityOptions(did);
    if (!existingOptions) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
    }

    await registeredIdentities.put(did, JSON.stringify(options));
    this._syncTargetsCache = undefined;
    this._syncTargetsCacheGeneration++;

    // If live sync is active, tear down and rebuild subscriptions with
    // the new options. Delegate/scope changes derive a new authorization
    // epoch, so existing durable links are not mutated in place.
    if (this._syncMode === 'live' && this.hasActiveLinksForDid(did)) {
      await this.removeIdentityFromLiveSync(did);
      const currentIdentityKeys = await this.addIdentityToLiveSync(did, options);
      if (currentIdentityKeys.size > 0) {
        await this.pruneSupersededDurableLinksForIdentity(did, currentIdentityKeys);
      }
    } else {
      await this.tryPruneSupersededDurableLinksForRegisteredIdentity(did, options);
    }
  }

  // ---------------------------------------------------------------------------
  // One-shot sync (SMT set reconciliation)
  // ---------------------------------------------------------------------------

  public async sync(direction?: 'push' | 'pull'): Promise<void> {
    if (this._syncLock) {
      throw new Error('SyncEngineLevel: Sync operation is already in progress.');
    }

    this._syncLock = true;
    try {
      // Group targets by remote endpoint so each URL group can be reconciled
      // concurrently. Within a group, targets are processed sequentially so
      // that a single network failure skips the rest of that group.
      const syncTargets = await this.getSyncTargets();
      const byUrl = new Map<string, typeof syncTargets>();
      for (const target of syncTargets) {
        let group = byUrl.get(target.dwnUrl);
        if (!group) {
          group = [];
          byUrl.set(target.dwnUrl, group);
        }
        group.push(target);
      }

      let groupsSucceeded = 0;
      let groupsFailed = 0;

      const results = await Promise.allSettled([...byUrl.entries()].map(async ([dwnUrl, targets]) => {
        for (const target of targets) {
          try {
            await this.reconcileSyncTarget(target, { direction });
          } catch (error: any) {
            // Skip remaining targets for this DWN endpoint.
            groupsFailed++;
            console.error(`SyncEngineLevel: Error syncing ${target.did} with ${dwnUrl}`, error);
            return;
          }
        }
        groupsSucceeded++;
      }));

      // Check for unexpected rejections (should not happen given inner try/catch).
      for (const result of results) {
        if (result.status === 'rejected') {
          groupsFailed++;
        }
      }

      // Track connectivity based on per-group outcomes. If at least one
      // group succeeded, stay online — partial reachability is still online.
      if (groupsSucceeded > 0) {
        this._consecutiveFailures = 0;
        this._connectivityState = 'online';
      } else if (groupsFailed > 0) {
        this._consecutiveFailures++;
        if (this._connectivityState === 'online') {
          this._connectivityState = 'offline';
        }
      } else if (syncTargets.length > 0) {
        // All targets had matching roots (no reconciliation needed).
        this._consecutiveFailures = 0;
        this._connectivityState = 'online';
      }
    } finally {
      this._syncLock = false;
    }
  }

  // ---------------------------------------------------------------------------
  // startSync / stopSync
  // ---------------------------------------------------------------------------

  public async startSync(params: StartSyncParams): Promise<void> {
    const mode = params.mode ?? 'poll';
    const intervalStr = params.interval ?? (mode === 'live' ? '5m' : '2m');
    const intervalMilliseconds = ms(intervalStr);

    // Tear down previous mode if there are active live resources.
    if (this._liveSubscriptions.length > 0 || this._localSubscriptions.length > 0) {
      await this.teardownLiveSync();
    }
    if (this._syncIntervalId) {
      clearInterval(this._syncIntervalId);
      this._syncIntervalId = undefined;
    }

    this._syncMode = mode;

    if (mode === 'live') {
      await this.startLiveSync(intervalMilliseconds);
    } else {
      await this.startPollSync(intervalMilliseconds);
    }
  }

  /**
   * stopSync awaits the completion of the current sync operation before stopping the sync interval
   * and tearing down any live subscriptions.
   *
   * @param timeout - Maximum milliseconds to wait for an in-progress
   *   sync cycle to finish. Non-finite values (`NaN`, `Infinity`) are
   *   coerced to the default to avoid a tight poll loop or never-exit
   *   condition.
   */
  public async stopSync(timeout: number = 2000): Promise<void> {
    // Coerce non-finite timeouts (NaN, Infinity) to the default. NaN
    // comparisons are always false, so `elapsedTimeout >= NaN` would
    // never trip the timeout exit; `Math.min(NaN, 100)` is NaN and
    // `setTimeout(_, NaN)` clamps to 0, spinning the poll loop. Both
    // are footguns for callers passing a computed timeout that
    // accidentally evaluates to NaN.
    const safeTimeout = Number.isFinite(timeout) ? timeout : 2000;
    this._engineGeneration++;
    let elapsedTimeout = 0;

    while (this._syncLock) {
      if (elapsedTimeout >= safeTimeout) {
        throw new Error(`SyncEngineLevel: Existing sync operation did not complete within ${safeTimeout} milliseconds.`);
      }

      elapsedTimeout += 100;
      await sleep(Math.min(safeTimeout, 100));
    }

    if (this._syncIntervalId) {
      clearInterval(this._syncIntervalId);
      this._syncIntervalId = undefined;
    }

    this._syncTargetsCache = undefined;
    this._syncTargetsCacheGeneration++;
    await this.teardownLiveSync();
    this._syncMode = undefined;
  }

  // ---------------------------------------------------------------------------
  // Poll-mode sync
  // ---------------------------------------------------------------------------

  private async startPollSync(intervalMilliseconds: number): Promise<void> {
    const generation = this._engineGeneration;
    const intervalSync = async (): Promise<void> => {
      if (this._engineGeneration !== generation) { return; }
      if (this._syncLock) {
        return;
      }

      clearInterval(this._syncIntervalId);
      this._syncIntervalId = undefined;

      try {
        await this.sync();
      } catch (error) {
        console.error('SyncEngineLevel: Error during sync operation', error);
      }

      // Apply backoff on consecutive failures.
      const backoffMultiplier = Math.min(
        Math.pow(2, this._consecutiveFailures),
        SyncEngineLevel.MAX_BACKOFF_MULTIPLIER,
      );
      const effectiveInterval = this._consecutiveFailures > 0
        ? intervalMilliseconds * backoffMultiplier
        : intervalMilliseconds;

      if (this._engineGeneration !== generation) { return; }
      if (!this._syncIntervalId) {
        this._syncIntervalId = setInterval(intervalSync, effectiveInterval);
      }
    };

    if (this._syncIntervalId) {
      clearInterval(this._syncIntervalId);
    }

    this._syncIntervalId = setInterval(intervalSync, intervalMilliseconds);

    // Initiate an immediate sync.
    if (!this._syncLock) {
      await this.sync();
    }
  }

  // ---------------------------------------------------------------------------
  // Live-mode sync
  // ---------------------------------------------------------------------------

  /**
   * Starts live sync:
   * 1. Performs an initial SMT reconciliation to catch up.
   * 2. Opens MessagesSubscribe subscriptions to each remote DWN for real-time pull.
   * 3. Subscribes to the local EventLog for push-on-write.
   * 4. Schedules an infrequent SMT integrity check at `interval`.
   */
  private async startLiveSync(intervalMilliseconds: number): Promise<void> {
    // Step 0: Register browser connectivity listeners for instant recovery
    // on network switch, sleep/wake, or tab foregrounding. No-op in Node.
    this.startBrowserConnectivityListeners();

    // Step 1: Initial SMT catch-up.
    try {
      await this.sync();
    } catch (error) {
      console.error('SyncEngineLevel: Error during initial live-sync catch-up', error);
    }

    // Step 2: Initialize replication links and open live subscriptions.
    // Each target's link initialization is independent — process concurrently.
    const syncTargets = await this.getSyncTargets();
    await Promise.allSettled(syncTargets.map(t => this.initializeLinkTarget(t)));

    // Step 3: Schedule infrequent SMT integrity check.
    const integrityCheck = async (): Promise<void> => {
      if (this._syncLock) {
        return;
      }

      try {
        await this.sync();
      } catch (error) {
        console.error('SyncEngineLevel: Error during SMT integrity check', error);
      }
    };

    this._syncIntervalId = setInterval(integrityCheck, intervalMilliseconds);
  }

  /**
   * Get or create the runtime state for a link.
   */
  private getOrCreateRuntime(linkKey: string): LinkRuntimeState {
    let rt = this._linkRuntimes.get(linkKey);
    if (!rt) {
      rt = { nextDeliveryOrdinal: 0, nextCommitOrdinal: 0, inflight: new Map() };
      this._linkRuntimes.set(linkKey, rt);
    }
    return rt;
  }

  /**
   * Drain contiguously committed ordinals from the runtime state, advancing
    * the link's pull checkpoint for each drained entry. Returns the number of
   * entries drained (0 if the next ordinal is not yet committed).
   */
  private drainCommittedPull(linkKey: string): number {
    const rt = this._linkRuntimes.get(linkKey);
    const link = this._activeLinks.get(linkKey);
    if (!rt || !link) { return 0; }

    let drained = 0;
    while (true) {
      const entry = rt.inflight.get(rt.nextCommitOrdinal);
      if (!entry?.committed) { break; }

      // This ordinal is committed — advance the durable checkpoint.
      ReplicationLedger.commitContiguousToken(link.pull, entry.token);
      ReplicationLedger.setReceivedToken(link.pull, entry.token);
      rt.inflight.delete(rt.nextCommitOrdinal);
      rt.nextCommitOrdinal++;
      drained++;
      // Note: checkpoint:pull-advance event is emitted AFTER saveLink succeeds
      // in the caller, not here. "Advanced" means durably persisted.
    }

    return drained;
  }

  // ---------------------------------------------------------------------------
  // Per-link repair and degraded-poll orchestration
  // ---------------------------------------------------------------------------

  /** Maximum consecutive repair attempts before falling back to degraded_poll. */
  private static readonly MAX_REPAIR_ATTEMPTS = 3;

  /** Per-link degraded-poll interval timers. */
  private readonly _degradedPollTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  /** Per-link repair attempt counters. */
  private readonly _repairAttempts: Map<string, number> = new Map();

  /** Per-link active repair promises — prevents concurrent repair for the same link. */
  private readonly _activeRepairs: Map<string, Promise<void>> = new Map();

  /** Per-link retry timers for failed repairs below max attempts. */
  private readonly _repairRetryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Backoff schedule for repair retries (milliseconds). */
  private static readonly REPAIR_BACKOFF_MS = [1_000, 3_000, 10_000];

  /**
   * Per-link repair context — stores ProgressGap metadata for use during
   * repair. The `resumeToken` (from `gapInfo.latestAvailable`) is used as
   * the post-repair checkpoint so the reopened subscription replays from
   * a valid boundary instead of starting live-only.
   */
  private readonly _repairContext: Map<string, { resumeToken?: ProgressToken }> = new Map();

  /**
   * Central helper for transitioning a link to `repairing`. Encapsulates:
   * - status change
   * - optional gap context storage
   * - repair kick-off with retry scheduling on failure
   *
   * All code paths that set `repairing` should go through this helper to
   * guarantee a future retry path.
   */
  private async transitionToRepairing(
    linkKey: string,
    link: ReplicationLinkState,
    options?: { resumeToken?: ProgressToken },
  ): Promise<void> {
    if (link.status === 'terminal_incomplete') {
      return;
    }

    await this.setLinkOfflineStatus(link, 'repairing');

    if (options?.resumeToken) {
      this._repairContext.set(linkKey, { resumeToken: options.resumeToken });
    }

    // Clear runtime ordinals immediately — stale state must not linger
    // across repair attempts.
    this.clearLinkRuntimeInflight(linkKey);

    // Kick off repair with retry scheduling on failure.
    void this.repairLink(linkKey).catch(() => {
      this.scheduleRepairRetry(linkKey);
    });
  }

  private async transitionToTerminalIncomplete(
    linkKey: string,
    link: ReplicationLinkState,
  ): Promise<void> {
    if (link.status === 'terminal_incomplete') {
      return;
    }

    await this.setLinkOfflineStatus(link, 'terminal_incomplete');

    await this.closeLinkSubscriptions(link);

    this.clearLinkRuntimeInflight(linkKey);

    const retryTimer = this._repairRetryTimers.get(linkKey);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this._repairRetryTimers.delete(linkKey);
    }
    const degradedTimer = this._degradedPollTimers.get(linkKey);
    if (degradedTimer) {
      clearInterval(degradedTimer);
      this._degradedPollTimers.delete(linkKey);
    }
    const reconcileTimer = this._reconcileTimers.get(linkKey);
    if (reconcileTimer) {
      clearTimeout(reconcileTimer);
      this._reconcileTimers.delete(linkKey);
    }
    const pushRuntime = this._pushRuntimes.get(linkKey);
    if (pushRuntime?.timer) {
      clearTimeout(pushRuntime.timer);
    }
    this._pushRuntimes.delete(linkKey);

    this._repairAttempts.delete(linkKey);
    this._repairContext.delete(linkKey);
  }

  private async setLinkOfflineStatus(link: ReplicationLinkState, status: ReplicationLinkState['status']): Promise<void> {
    const prevStatus = link.status;
    const prevConnectivity = link.connectivity;
    link.connectivity = 'offline';
    await this.ledger.setStatus(link, status);

    const eventScope = syncEventScope(link.scope);
    this.emitEvent({ type: 'link:status-change', tenantDid: link.tenantDid, remoteEndpoint: link.remoteEndpoint, ...eventScope, from: prevStatus, to: status });
    if (prevConnectivity !== 'offline') {
      this.emitEvent({ type: 'link:connectivity-change', tenantDid: link.tenantDid, remoteEndpoint: link.remoteEndpoint, ...eventScope, from: prevConnectivity, to: 'offline' });
    }
  }

  private clearLinkRuntimeInflight(linkKey: string): void {
    const rt = this._linkRuntimes.get(linkKey);
    if (!rt) {
      return;
    }

    rt.inflight.clear();
    rt.nextCommitOrdinal = rt.nextDeliveryOrdinal;
  }

  /**
   * Schedule a retry for a failed repair. Uses exponential backoff.
   * No-op if the link is already in `degraded_poll` (timer loop owns retries)
   * or if a retry is already scheduled.
   */
  private scheduleRepairRetry(linkKey: string): void {
    // Don't schedule if already in degraded_poll or retry pending.
    const link = this._activeLinks.get(linkKey);
    if (!link || link.status === 'degraded_poll') { return; }
    if (this._repairRetryTimers.has(linkKey)) { return; }

    // attempts is already post-increment from doRepairLink, so subtract 1
    // for the backoff index: first failure (attempts=1) → backoff[0]=1s.
    const attempts = this._repairAttempts.get(linkKey) ?? 1;
    const backoff = SyncEngineLevel.REPAIR_BACKOFF_MS;
    const delayMs = backoff[Math.min(attempts - 1, backoff.length - 1)];

    const timerGeneration = this._engineGeneration;
    const timer = setTimeout(async (): Promise<void> => {
      this._repairRetryTimers.delete(linkKey);

      // Bail if teardown occurred since this timer was scheduled.
      if (this._engineGeneration !== timerGeneration) { return; }

      // Verify link still exists and is still repairing.
      const currentLink = this._activeLinks.get(linkKey);
      if (currentLink?.status !== 'repairing') { return; }

      try {
        await this.repairLink(linkKey);
      } catch {
        // repairLink handles max attempts → degraded_poll internally.
        // If still below max, schedule another retry.
        if (currentLink.status === 'repairing') {
          this.scheduleRepairRetry(linkKey);
        }
      }
    }, delayMs);

    this._repairRetryTimers.set(linkKey, timer);
  }

  /**
   * Repair a single link. Deduplicates concurrent calls via `_activeRepairs`.
   * If repair is already running for this link, returns the existing promise.
   */
  private repairLink(linkKey: string): Promise<void> {
    const existing = this._activeRepairs.get(linkKey);
    if (existing) { return existing; }

    const promise = this.doRepairLink(linkKey).finally(() => {
      this._activeRepairs.delete(linkKey);

      // Post-repair reconcile: if doRepairLink() marked needsReconcile
      // (to close the gap between diff snapshot and new push subscription),
      // schedule reconciliation NOW — after _activeRepairs is cleared so
      // scheduleReconcile() won't skip it.
      const link = this._activeLinks.get(linkKey);
      if (link?.needsReconcile && link.status === 'live') {
        this.scheduleReconcile(linkKey, 500);
      }
    });
    this._activeRepairs.set(linkKey, promise);
    return promise;
  }

  /**
   * Internal repair implementation. Runs SMT set reconciliation for a single
   * link, then attempts to re-establish live subscriptions. If repair succeeds,
   * transitions to `live`. If it fails, throws so callers (degraded_poll timer,
   * startup) can handle retry scheduling.
   */
  private async doRepairLink(linkKey: string): Promise<void> {
    const link = this._activeLinks.get(linkKey);
    if (!link) { return; }

    // Capture the sync generation at repair start. If teardown occurs during
    // any await, the generation will have incremented and we bail before
    // mutating state — preventing the race where repair continues after teardown.
    const generation = this._engineGeneration;

    // Identity guard helper: if the DID was hot-removed and quickly re-added,
    // `_activeLinks` may contain a *different* link object for the same key.
    // The old repair closure must not mutate the replacement link's state.
    const isStaleLink = (): boolean => this._activeLinks.get(linkKey) !== link;

    const { tenantDid: did, remoteEndpoint: dwnUrl, delegateDid, scope, authorization } = link;
    const eventScope = syncEventScope(scope);

    this.emitEvent({ type: 'repair:started', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, attempt: (this._repairAttempts.get(linkKey) ?? 0) + 1 });
    const attempts = (this._repairAttempts.get(linkKey) ?? 0) + 1;
    this._repairAttempts.set(linkKey, attempts);

    // Step 1: Close existing subscriptions FIRST to stop old events from
    // mutating local state while repair runs.
    await this.closeLinkSubscriptions(link);
    if (this._engineGeneration !== generation || isStaleLink()) { return; }

    // Step 2: Clear runtime ordinals immediately — stale state must not
    // persist across repair attempts (successful or failed).
    const rt = this.getOrCreateRuntime(linkKey);
    rt.inflight.clear();
    rt.nextDeliveryOrdinal = 0;
    rt.nextCommitOrdinal = 0;

    try {
      // Step 3: Run SMT reconciliation for this link.
      const reconcileOutcome = await this.reconcileSyncTarget({
        did,
        dwnUrl,
        delegateDid,
        scope,
        authorization,
      }, undefined, () => this._engineGeneration === generation && !isStaleLink());
      if (reconcileOutcome.aborted) { return; }

      // Step 4: Determine the post-repair pull resume token.
      // - If repair was triggered by ProgressGap, use the stored resumeToken
      //   (from gapInfo.latestAvailable) so the reopened subscription replays
      //   from a valid boundary, closing the race window between SMT and resubscribe.
      // - Otherwise, use the existing contiguousAppliedToken if still valid.
      // Push is opportunistic — no push checkpoint to reset.
      const repairCtx = this._repairContext.get(linkKey);
      const resumeToken = repairCtx?.resumeToken ?? link.pull.contiguousAppliedToken;
      ReplicationLedger.resetCheckpoint(link.pull, resumeToken);
      await this.ledger.saveLink(link);
      if (this._engineGeneration !== generation || isStaleLink()) { return; }

      // Step 5: Reopen subscriptions.
      // Mark needsReconcile BEFORE reopening — local push starts from "now",
      // so any writes between the diff snapshot (step 3) and the new push
      // subscription are invisible to both mechanisms. A short post-reopen
      // reconcile will close this gap (cheap: SMT root comparison short-circuits
      // if roots already match).
      link.needsReconcile = true;
      await this.ledger.saveLink(link);
      if (this._engineGeneration !== generation || isStaleLink()) { return; }

      const target = {
        did,
        dwnUrl,
        delegateDid,
        scope,
        authorization,
        authorizationEpoch : link.authorizationEpoch,
        permissionGrantIds : this.getAuthorizationGrantIds(authorization),
        linkKey,
      };
      try {
        await this.openLivePullSubscription(target);
      } catch (pullErr: any) {
        if (pullErr.isProgressGap) {
          console.warn(`SyncEngineLevel: Stale pull resume token for ${did} -> ${dwnUrl}, resetting to start fresh`);
          ReplicationLedger.resetCheckpoint(link.pull);
          await this.ledger.saveLink(link);
          if (this._engineGeneration !== generation || isStaleLink()) { return; }
          await this.openLivePullSubscription(target);
        } else {
          throw pullErr;
        }
      }
      if (this._engineGeneration !== generation || isStaleLink()) { return; }
      try {
        await this.openLocalPushSubscription(target);
      } catch (pushError) {
        const pullSub = this._liveSubscriptions.find((s) => s.linkKey === linkKey);
        if (pullSub) {
          try { await pullSub.close(); } catch { /* best effort */ }
          this._liveSubscriptions = this._liveSubscriptions.filter(s => s !== pullSub);
        }
        throw pushError;
      }
      if (this._engineGeneration !== generation || isStaleLink()) { return; }

      // Note: post-repair reconcile to close the repair-window gap is
      // scheduled by repairLink() AFTER _activeRepairs is cleared — not
      // here, because scheduleReconcile() would skip it while _activeRepairs
      // still contains this link.

      // Step 6: Clean up repair context and transition to live.
      this._repairContext.delete(linkKey);
      this._repairAttempts.delete(linkKey);
      const retryTimer = this._repairRetryTimers.get(linkKey);
      if (retryTimer) { clearTimeout(retryTimer); this._repairRetryTimers.delete(linkKey); }
      const prevRepairConnectivity = link.connectivity;
      link.connectivity = 'online';
      await this.ledger.setStatus(link, 'live');

      // Root convergence proves primary CID membership matches, but it does
      // not prove dependencies are usable. Keep closure failures until a later
      // successful apply/closure pass clears the specific CID.
      await this.clearRootConvergenceDeadLettersForScope(did, dwnUrl, scope);
      this.emitEvent({ type: 'repair:completed', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope });
      if (prevRepairConnectivity !== 'online') {
        this.emitEvent({ type: 'link:connectivity-change', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, from: prevRepairConnectivity, to: 'online' });
      }
      this.emitEvent({ type: 'link:status-change', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, from: 'repairing', to: 'live' });

    } catch (error: any) {
      // If teardown occurred during repair or the link was replaced by a
      // hot-remove + re-add, don't retry or enter degraded_poll.
      if (this._engineGeneration !== generation || isStaleLink()) { return; }

      console.error(`SyncEngineLevel: Repair failed for ${did} -> ${dwnUrl} (attempt ${attempts})`, error);
      this.emitEvent({ type: 'repair:failed', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, attempt: attempts, error: String(error.message ?? error) });

      if (attempts >= SyncEngineLevel.MAX_REPAIR_ATTEMPTS) {
        console.warn(`SyncEngineLevel: Max repair attempts reached for ${did} -> ${dwnUrl}, entering degraded_poll`);
        await this.enterDegradedPoll(linkKey);
        return;
      }

      // Re-throw so callers (degraded_poll timer) can handle retry scheduling.
      throw error;
    }
  }

  /**
   * Close pull and push subscriptions for a specific link.
   */
  private async closeLinkSubscriptions(link: ReplicationLinkState): Promise<void> {
    const { tenantDid: did, remoteEndpoint: dwnUrl } = link;
    const linkKey = this.buildLinkKey(did, dwnUrl, link.projectionId, link.authorizationEpoch);

    await this.closeLiveSubscription(linkKey);
    await this.closeLocalSubscription(linkKey);
  }

  private async closeLiveSubscription(linkKey: string): Promise<void> {
    const pullSub = this._liveSubscriptions.find((s) => s.linkKey === linkKey);
    if (!pullSub) { return; }

    try { await pullSub.close(); } catch { /* best effort */ }
    this._liveSubscriptions = this._liveSubscriptions.filter(s => s !== pullSub);
  }

  private async closeLocalSubscription(linkKey: string): Promise<void> {
    const pushSub = this._localSubscriptions.find((s) => s.linkKey === linkKey);
    if (!pushSub) { return; }

    try { await pushSub.close(); } catch { /* best effort */ }
    this._localSubscriptions = this._localSubscriptions.filter(s => s !== pushSub);
  }

  /**
   * Transition a link to `degraded_poll` and start a per-link polling timer.
   * The timer runs SMT reconciliation at a reduced frequency (30s with jitter)
   * and attempts to re-establish live subscriptions after each successful repair.
   */
  private async enterDegradedPoll(linkKey: string): Promise<void> {
    const link = this._activeLinks.get(linkKey);
    if (!link) { return; }
    link.connectivity = 'offline';

    const prevDegradedStatus = link.status;
    await this.ledger.setStatus(link, 'degraded_poll');
    this._repairAttempts.delete(linkKey);
    const eventScope = syncEventScope(link.scope);
    this.emitEvent({ type: 'link:status-change', tenantDid: link.tenantDid, remoteEndpoint: link.remoteEndpoint, ...eventScope, from: prevDegradedStatus, to: 'degraded_poll' });
    this.emitEvent({ type: 'degraded-poll:entered', tenantDid: link.tenantDid, remoteEndpoint: link.remoteEndpoint, ...eventScope });

    // Clear any existing timer for this link.
    const existing = this._degradedPollTimers.get(linkKey);
    if (existing) { clearInterval(existing); }

    // Schedule per-link polling with jitter (15-30 seconds).
    // Rejection sampling: mask to 14 bits ([0, 16383]), reject >= 15000.
    const baseInterval = 15_000;
    const randomBuf = new Uint32Array(1);
    let jitter: number;
    do {
      crypto.getRandomValues(randomBuf);
      jitter = randomBuf[0] & 0x3FFF;
    } while (jitter >= baseInterval);
    const interval = baseInterval + jitter;

    const pollGeneration = this._engineGeneration;
    const timer = setInterval(async (): Promise<void> => {
      // Bail if teardown occurred since this timer was created.
      if (this._engineGeneration !== pollGeneration) {
        clearInterval(timer);
        this._degradedPollTimers.delete(linkKey);
        return;
      }

      // Resolve the *current* link from _activeLinks on each tick, not the
      // captured closure reference. After hot-remove + re-add, the captured
      // `link` object is stale and must not be used for status checks or
      // ledger writes.
      const currentLink = this._activeLinks.get(linkKey);
      if (currentLink?.status !== 'degraded_poll') {
        clearInterval(timer);
        this._degradedPollTimers.delete(linkKey);
        return;
      }

      try {
        // Attempt repair. Reset attempt counter so repairLink doesn't
        // immediately re-enter degraded_poll on failure.
        this._repairAttempts.set(linkKey, 0);
        await this.ledger.setStatus(currentLink, 'repairing');
        await this.repairLink(linkKey);

        // If repairLink succeeded, link is now 'live' — stop polling.
        if ((currentLink.status as string) === 'live') {
          clearInterval(timer);
          this._degradedPollTimers.delete(linkKey);
        }
      } catch {
        // Repair failed — restore degraded_poll status so the timer continues.
        // This is critical: repairLink sets status to 'repairing' internally,
        // and if we don't restore degraded_poll, the next tick would see
        // status !== 'degraded_poll' and stop the timer permanently.
        if (this._activeLinks.get(linkKey) === currentLink) {
          await this.ledger.setStatus(currentLink, 'degraded_poll');
        }
      }
    }, interval);

    this._degradedPollTimers.set(linkKey, timer);
  }

  /**
   * Tears down all live subscriptions and push listeners.
   */
  // ---------------------------------------------------------------------------
  // Browser connectivity: online/offline + visibilitychange
  // ---------------------------------------------------------------------------

  /**
   * Registers browser `online`, `offline`, and `visibilitychange` event
   * listeners to detect connectivity changes that WebSocket `close` events
   * miss (NAT timeout, network switch, sleep/wake). Safe to call in Node —
   * the guards skip registration when browser APIs are unavailable.
   */
  private startBrowserConnectivityListeners(): void {
    this.stopBrowserConnectivityListeners();

    // Guard: only run in browser environments with the required APIs.
    if (typeof globalThis.addEventListener !== 'function') { return; }

    const generation = this._engineGeneration;

    this._onOnline = (): void => {
      if (this._engineGeneration !== generation) { return; }
      console.info('SyncEngineLevel: browser online — triggering immediate integrity check');
      // Don't set _connectivityState here — individual links will transition
      // to online as their WebSocket connections actually recover during the
      // sync below. The public getter uses per-link aggregation.

      // Kick off an immediate SMT reconciliation to catch up after being offline.
      if (!this._syncLock) {
        this.sync().catch((err) => {
          console.error('SyncEngineLevel: post-online sync failed', err);
        });
      }
    };

    this._onOffline = (): void => {
      if (this._engineGeneration !== generation) { return; }
      console.info('SyncEngineLevel: browser offline');
      this._connectivityState = 'offline';

      // Transition every active link to offline so the public
      // connectivityState getter (which aggregates per-link state)
      // reflects the browser's network status immediately.
      for (const link of this._activeLinks.values()) {
        const prev = link.connectivity;
        if (prev !== 'offline') {
          link.connectivity = 'offline';
          this.emitEvent({
            type           : 'link:connectivity-change',
            tenantDid      : link.tenantDid,
            remoteEndpoint : link.remoteEndpoint,
            ...syncEventScope(link.scope),
            from           : prev,
            to             : 'offline',
          });
        }
      }
    };

    this._onVisibilityChange = (): void => {
      if (this._engineGeneration !== generation) { return; }

      // Only act when the page becomes visible again — the user is back.
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') { return; }

      console.info('SyncEngineLevel: page became visible — triggering integrity check');

      // The device may have slept and WebSockets may be dead. An immediate
      // sync via SMT reconciliation detects and repairs any divergence.
      if (!this._syncLock) {
        this.sync().catch((err) => {
          console.error('SyncEngineLevel: post-visibility sync failed', err);
        });
      }
    };

    globalThis.addEventListener('online', this._onOnline);
    globalThis.addEventListener('offline', this._onOffline);

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    }
  }

  /** Removes browser connectivity listeners if they were registered. */
  private stopBrowserConnectivityListeners(): void {
    if (this._onOnline) {
      globalThis.removeEventListener('online', this._onOnline);
      this._onOnline = undefined;
    }
    if (this._onOffline) {
      globalThis.removeEventListener('offline', this._onOffline);
      this._onOffline = undefined;
    }
    if (this._onVisibilityChange && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
      this._onVisibilityChange = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  private async teardownLiveSync(): Promise<void> {
    // Remove browser connectivity listeners before tearing down.
    this.stopBrowserConnectivityListeners();

    // Increment generation to invalidate all in-flight async operations
    // (repairs, retry timers, degraded-poll ticks). Any async work that
    // captured the previous generation will bail on its next checkpoint.
    this._engineGeneration++;

    // Clear per-link push runtime state.
    for (const pushRuntime of this._pushRuntimes.values()) {
      if (pushRuntime.timer) {
        clearTimeout(pushRuntime.timer);
      }
    }
    this._pushRuntimes.clear();

    // Close all live pull subscriptions.
    for (const sub of this._liveSubscriptions) {
      try {
        await sub.close();
      } catch {
        // Best-effort cleanup.
      }
    }
    this._liveSubscriptions = [];

    // Close all local push subscriptions.
    for (const sub of this._localSubscriptions) {
      try {
        await sub.close();
      } catch {
        // Best-effort cleanup.
      }
    }
    this._localSubscriptions = [];

    // Clear degraded-poll timers and repair state.
    for (const timer of this._degradedPollTimers.values()) {
      clearInterval(timer);
    }
    this._degradedPollTimers.clear();
    this._repairAttempts.clear();
    this._activeRepairs.clear();
    for (const timer of this._repairRetryTimers.values()) {
      clearTimeout(timer);
    }
    this._repairRetryTimers.clear();
    this._repairContext.clear();

    // Clear reconcile timers and in-flight operations.
    for (const timer of this._reconcileTimers.values()) {
      clearTimeout(timer);
    }
    this._reconcileTimers.clear();
    this._reconcileInFlight.clear();

    // Clear closure evaluation contexts.
    this._closureContexts.clear();
    this._protocolMetadataRepairs.clear();
    this._recentlyPulledCids.clear();

    // Clear the in-memory link and runtime state.
    this._activeLinks.clear();
    this._linkRuntimes.clear();
  }

  // ---------------------------------------------------------------------------
  // Per-target link initialization (shared by startLiveSync + addIdentityToLiveSync)
  // ---------------------------------------------------------------------------

  /**
   * Initialize a single replication link target: create or resume the durable
   * link, open pull + push subscriptions, and transition the link to `'live'`.
   */
  private async initializeLinkTarget(target: SyncTarget): Promise<LinkInitializationResult> {
    let link: ReplicationLinkState | undefined;
    try {
      link = await this.getOrCreateReplicationLink(target);
      const linkKey = this.getReplicationLinkKey(target, link);
      this._activeLinks.set(linkKey, link);
      if (link.status === 'terminal_incomplete') {
        return this.createActiveLinkInitializationResult(link);
      }

      const subscriptionResult = await this.openLinkSubscriptions({ ...target, linkKey });
      if (subscriptionResult === LinkSubscriptionOpenResult.ReadyForLive) {
        await this.markLinkLive(target, link, linkKey);
      } else if (subscriptionResult === LinkSubscriptionOpenResult.Polling) {
        await this.markLinkPolling(target, link);
      }
      return this.createActiveLinkInitializationResult(link);
    } catch (error: any) {
      return this.handleInitializeLinkTargetError(target, link, error);
    }
  }

  private async getOrCreateReplicationLink(target: SyncTarget): Promise<ReplicationLinkState> {
    return this.ledger.getOrCreateLink({
      tenantDid          : target.did,
      remoteEndpoint     : target.dwnUrl,
      scope              : target.scope,
      authorization      : target.authorization,
      authorizationEpoch : target.authorizationEpoch,
      delegateDid        : target.delegateDid,
    });
  }

  private getReplicationLinkKey(target: SyncTarget, link: ReplicationLinkState): string {
    return this.buildLinkKey(target.did, target.dwnUrl, link.projectionId, link.authorizationEpoch);
  }

  private async openLinkSubscriptions(target: LinkSyncTarget): Promise<LinkSubscriptionOpenResult> {
    await this.openLivePullSubscription(target);
    const link = this._activeLinks.get(target.linkKey);
    if (link?.status === 'repairing') {
      await this.closeLiveSubscription(target.linkKey);
      return LinkSubscriptionOpenResult.Repairing;
    }

    try {
      await this.openLocalPushSubscription(target);
    } catch (error) {
      await this.closeLiveSubscription(target.linkKey);
      throw error;
    }
    return LinkSubscriptionOpenResult.ReadyForLive;
  }

  private async markLinkLive(target: SyncTarget, link: ReplicationLinkState, linkKey: string): Promise<void> {
    this.emitEvent({
      type           : 'link:status-change',
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      ...syncEventScope(target.scope),
      from           : 'initializing',
      to             : 'live'
    });
    await this.ledger.setStatus(link, 'live');

    if (link.needsReconcile) {
      this.scheduleReconcile(linkKey, 1000);
    }
  }

  private async markLinkPolling(target: SyncTarget, link: ReplicationLinkState): Promise<void> {
    this.emitEvent({
      type           : 'link:status-change',
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      ...syncEventScope(target.scope),
      from           : 'initializing',
      to             : 'polling'
    });
    await this.ledger.setStatus(link, 'polling');
  }

  private async handleInitializeLinkTargetError(
    target: SyncTarget,
    link: ReplicationLinkState | undefined,
    error: any,
  ): Promise<LinkInitializationResult> {
    if (error.isProgressGap && link) {
      const linkKey = this.getReplicationLinkKey(target, link);
      console.warn(`SyncEngineLevel: ProgressGap detected for ${target.did} -> ${target.dwnUrl}, initiating repair`);
      this.emitEvent({
        type           : 'gap:detected',
        tenantDid      : target.did,
        remoteEndpoint : target.dwnUrl,
        ...syncEventScope(target.scope),
        reason         : 'ProgressGap'
      });
      await this.transitionToRepairing(linkKey, link, {
        resumeToken: error.gapInfo?.latestAvailable,
      });
      return this.createActiveLinkInitializationResult(link);
    }

    console.error(`SyncEngineLevel: Failed to open live subscription for ${target.did} -> ${target.dwnUrl}`, error);
    if (link) {
      this.cleanupFailedLinkInitialization(this.getReplicationLinkKey(target, link));
    }
    if (this.isDidResolutionFailure(error)) {
      throw error;
    }
    return { status: LinkInitializationStatus.Failed };
  }

  private createActiveLinkInitializationResult(link: ReplicationLinkState): LinkInitializationResult {
    return {
      status                 : LinkInitializationStatus.Active,
      durableLinkIdentityKey : this.getDurableLinkIdentityKey(link),
    };
  }

  private cleanupFailedLinkInitialization(linkKey: string): void {
    this._activeLinks.delete(linkKey);
    this._linkRuntimes.delete(linkKey);

    if (this._liveSubscriptions.length === 0) {
      this._connectivityState = 'unknown';
    }
  }

  /**
   * Wrapper around {@link initializeLinkTarget} that retries on DID
   * resolution failures. Newly published `did:dht` DIDs take a few
   * seconds to propagate through the DHT network. During this window,
   * the remote DWN can't resolve the DID to verify request signatures,
   * causing a 401. Retrying with exponential backoff lets the
   * propagation settle before giving up.
   */
  private async initializeLinkTargetWithRetry(target: SyncTarget): Promise<LinkInitializationResult> {
    try {
      return await this.initializeLinkTarget(target);
    } catch (error: any) {
      if (!this.isDidResolutionFailure(error)) { throw error; }

      for (const delay of SyncEngineLevel.DID_RESOLUTION_RETRY_BACKOFF_MS) {
        await sleep(delay);
        try {
          return await this.initializeLinkTarget(target);
        } catch {
          // Continue to next attempt.
        }
      }
      // All retries exhausted — the original error was already logged
      // by initializeLinkTarget's catch block.
      return { status: LinkInitializationStatus.Failed };
    }
  }

  private isDidResolutionFailure(error: any): boolean {
    const message = error.message ?? '';
    return message.includes('GetPublicKeyNotFound');
  }

  // ---------------------------------------------------------------------------
  // Hot-add / hot-remove: per-identity live sync management
  // ---------------------------------------------------------------------------

  /** Check whether a link key belongs to a given DID. */
  private isLinkKeyForDid(key: string, did: string): boolean {
    return key.startsWith(did + '^') || key.startsWith(did + '_');
  }

  /** Check whether this DID has any active links. */
  private hasActiveLinksForDid(did: string): boolean {
    for (const key of this._activeLinks.keys()) {
      if (this.isLinkKeyForDid(key, did)) { return true; }
    }
    return false;
  }

  /** Hot-add a single identity to the active live sync session. */
  private async addIdentityToLiveSync(did: string, options: SyncIdentityOptions): Promise<Set<string>> {
    const dwnEndpointUrls = await this.agent.dwn.getDwnEndpointUrlsForTarget(did);
    if (dwnEndpointUrls.length === 0) { return new Set(); }

    const targets: SyncTarget[] = [];
    for (const dwnUrl of dwnEndpointUrls) {
      targets.push(...await this.buildSyncTargetsForEndpoint(did, dwnUrl, options));
    }

    const results = await Promise.allSettled(targets.map(t => this.initializeLinkTargetWithRetry(t)));
    const currentIdentityKeys = new Set<string>();
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.status === LinkInitializationStatus.Active) {
        currentIdentityKeys.add(result.value.durableLinkIdentityKey);
      }
    }
    return currentIdentityKeys;
  }

  /** Hot-remove a single identity from the active live sync session. */
  private async removeIdentityFromLiveSync(did: string): Promise<void> {
    for (const sub of this._liveSubscriptions.filter(s => s.did === did)) {
      try { await sub.close(); } catch { /* best effort */ }
    }
    this._liveSubscriptions = this._liveSubscriptions.filter(s => s.did !== did);

    for (const sub of this._localSubscriptions.filter(s => s.did === did)) {
      try { await sub.close(); } catch { /* best effort */ }
    }
    this._localSubscriptions = this._localSubscriptions.filter(s => s.did !== did);

    for (const [key, runtime] of this._pushRuntimes) {
      if (runtime.did === did) {
        if (runtime.timer) { clearTimeout(runtime.timer); }
        this._pushRuntimes.delete(key);
      }
    }

    for (const [key, timer] of this._degradedPollTimers) {
      if (this.isLinkKeyForDid(key, did)) { clearInterval(timer); this._degradedPollTimers.delete(key); }
    }
    for (const key of this._repairAttempts.keys()) {
      if (this.isLinkKeyForDid(key, did)) { this._repairAttempts.delete(key); }
    }
    for (const key of this._activeRepairs.keys()) {
      if (this.isLinkKeyForDid(key, did)) { this._activeRepairs.delete(key); }
    }
    for (const key of this._repairContext.keys()) {
      if (this.isLinkKeyForDid(key, did)) { this._repairContext.delete(key); }
    }
    for (const [key, timer] of this._repairRetryTimers) {
      if (this.isLinkKeyForDid(key, did)) { clearTimeout(timer); this._repairRetryTimers.delete(key); }
    }
    for (const [key, timer] of this._reconcileTimers) {
      if (this.isLinkKeyForDid(key, did)) { clearTimeout(timer); this._reconcileTimers.delete(key); }
    }
    for (const key of this._reconcileInFlight.keys()) {
      if (this.isLinkKeyForDid(key, did)) { this._reconcileInFlight.delete(key); }
    }
    for (const key of this._activeLinks.keys()) {
      if (this.isLinkKeyForDid(key, did)) { this._activeLinks.delete(key); this._linkRuntimes.delete(key); }
    }
    this._closureContexts.delete(did);
  }

  private async tryPruneSupersededDurableLinksForRegisteredIdentity(did: string, options: SyncIdentityOptions): Promise<void> {
    try {
      const currentIdentityKeys = await this.getDurableLinkIdentityKeysForRegisteredIdentity(did, options);
      await this.pruneSupersededDurableLinksForIdentity(did, currentIdentityKeys);
    } catch (error: unknown) {
      console.warn(`SyncEngineLevel: Failed to prune superseded durable links for ${did}`, error);
    }
  }

  private async getDurableLinkIdentityKeysForRegisteredIdentity(did: string, options: SyncIdentityOptions): Promise<Set<string>> {
    const scope = syncScopeFromProtocols(options.protocols);
    const resolutions = await this.buildSyncTargetResolutions(did, scope, options);
    const keys = new Set<string>();
    for (const resolution of resolutions) {
      const projectionId = await computeProjectionId(did, resolution.scope);
      keys.add(SyncEngineLevel.durableLinkIdentityKey(did, projectionId, resolution.authorizationEpoch));
    }
    return keys;
  }

  private async pruneSupersededDurableLinksForIdentity(did: string, currentIdentityKeys: Set<string>): Promise<void> {
    const links = await this.ledger.getLinksForTenant(did);
    await Promise.all(links.map(async link => {
      if (currentIdentityKeys.has(this.getDurableLinkIdentityKey(link))) {
        return;
      }
      await this.ledger.deleteLink(link.tenantDid, link.remoteEndpoint, link.projectionId, link.authorizationEpoch);
    }));
  }

  // ---------------------------------------------------------------------------
  // Live pull: MessagesSubscribe to remote DWN
  // ---------------------------------------------------------------------------

  /**
   * Opens a MessagesSubscribe WebSocket subscription to a remote DWN.
   * Incoming events are processed locally as they arrive.
   */
  private async openLivePullSubscription(target: LinkSyncTarget): Promise<void> {
    const { did, delegateDid, dwnUrl } = target;
    const eventScope = syncEventScope(target.scope);

    const cursorKey = target.linkKey;
    const link = this._activeLinks.get(cursorKey);
    const cursor = await this.getInitialPullCursor({ did, dwnUrl, link });

    const filters = target.scope.kind === 'protocolSet'
      ? target.scope.protocols.map(protocol => ({ protocol }))
      : [];

    const handlerGeneration = this._engineGeneration;

    // Define the subscription handler that processes incoming events.
    // NOTE: The WebSocket client fires handlers without awaiting (fire-and-forget),
    // so multiple handlers can be in-flight concurrently. The ordinal tracker
    // ensures the checkpoint advances only when all earlier deliveries are committed.
    // Capture the link reference at subscription-open time so we can
    // detect remove+re-add via object identity, not just key existence.
    const isStale = this.createLinkStalePredicate(cursorKey, link, handlerGeneration);
    const pullContext: LivePullContext = {
      did,
      dwnUrl,
      delegateDid,
      eventScope,
      linkKey            : cursorKey,
      link,
      permissionGrantIds : target.permissionGrantIds,
      isStale,
    };

    const subscriptionHandler = async (subMessage: SubscriptionMessage): Promise<void> => {
      await this.handleLivePullMessage(pullContext, subMessage);
    };

    // Construct the subscribe message and send it directly to the specific
    // dwnUrl via WebSocket.  We do NOT use agent.dwn.sendRequest() because
    // that resolves endpoints from the DID document and picks the first one
    // — which may be a different server than the one this sync target needs.
    const subscribeRequest = {
      store         : false as const,
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSubscribe as const,
      granteeDid    : delegateDid,
      messageParams : { filters, cursor, permissionGrantIds: toMessagesPermissionGrantIds(target.permissionGrantIds) },
    };

    const { message } = await this.agent.dwn.processRequest(subscribeRequest);
    if (!message) {
      throw new Error(`SyncEngineLevel: Failed to construct MessagesSubscribe for ${dwnUrl}`);
    }

    // Build a resubscribe factory so the WebSocket client can resume with
    // a fresh cursor-stamped message after reconnection.
    const resubscribeFactory: ResubscribeFactory = async (resumeCursor?: ProgressToken) => {
      // On reconnect, use the latest durable checkpoint position if available.
      // Discard tokens with empty fields to avoid schema validation failures.
      let effectiveCursor = resumeCursor ?? link?.pull.contiguousAppliedToken ?? cursor;
      if (effectiveCursor && (!effectiveCursor.streamId || !effectiveCursor.messageCid || !effectiveCursor.epoch || !effectiveCursor.position)) {
        effectiveCursor = undefined;
      }
      const resumeRequest = {
        ...subscribeRequest,
        messageParams: { ...subscribeRequest.messageParams, cursor: effectiveCursor },
      };
      const { message: resumeMsg } = await this.agent.dwn.processRequest(resumeRequest);
      if (!resumeMsg) {
        throw new Error(`SyncEngineLevel: Failed to construct resume MessagesSubscribe for ${dwnUrl}`);
      }
      return resumeMsg;
    };

    // Convert http(s) URL to ws(s) for WebSocket transport.
    const parsedUrl = new URL(dwnUrl);
    parsedUrl.protocol = parsedUrl.protocol === 'http:' ? 'ws:' : 'wss:';
    const wsUrl = parsedUrl.toString();

    const reply = await this.agent.rpc.sendDwnRequest({
      dwnUrl       : wsUrl,
      targetDid    : did,
      message,
      subscription : {
        handler: subscriptionHandler as DwnSubscriptionHandler,
        resubscribeFactory,
      },
    }) as MessagesSubscribeReply;
    if (reply.status.code === 410) {
      // ProgressGap — the cursor is no longer replayable. The link needs repair.
      const gapError = new Error(`SyncEngineLevel: ProgressGap for ${did} -> ${dwnUrl}: ${reply.status.detail}`);
      (gapError as any).isProgressGap = true;
      (gapError as any).gapInfo = reply.error;
      throw gapError;
    }
    if (reply.status.code !== 200 || !reply.subscription) {
      throw new Error(`SyncEngineLevel: MessagesSubscribe failed for ${did} -> ${dwnUrl}: ${reply.status.code} ${reply.status.detail}`);
    }

    const linkKey = cursorKey;
    const close = async (): Promise<void> => { await reply.subscription!.close(); };
    this._liveSubscriptions.push({
      linkKey,
      did,
      dwnUrl,
      delegateDid,
      close,
    });

    // Set per-link connectivity to online after successful subscription setup.
    const pullLink = this._activeLinks.get(cursorKey);
    if (pullLink) {
      const prevPullConnectivity = pullLink.connectivity;
      pullLink.connectivity = 'online';
      if (prevPullConnectivity !== 'online') {
        this.emitEvent({ type: 'link:connectivity-change', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, from: prevPullConnectivity, to: 'online' });
      }
    }
  }

  private async getInitialPullCursor({ did, dwnUrl, link }: {
    did: string;
    dwnUrl: string;
    link?: ReplicationLinkState;
  }): Promise<ProgressToken | undefined> {
    // Resolve the cursor from the link's durable pull checkpoint.
    if (!link) {
      return undefined;
    }

    const cursor = link.pull.contiguousAppliedToken;
    if (!cursor || this.isValidProgressToken(cursor)) {
      return cursor;
    }

    // Guard against corrupted tokens with empty fields — these would fail
    // MessagesSubscribe JSON schema validation (minLength: 1). Discard and
    // start from the beginning rather than crash the subscription.
    console.warn(`SyncEngineLevel: Discarding stored cursor with empty field(s) for ${did} -> ${dwnUrl}`);
    ReplicationLedger.resetCheckpoint(link.pull);
    await this.ledger.saveLink(link);
    return undefined;
  }

  private isValidProgressToken(token: ProgressToken): boolean {
    return !!(token.streamId && token.messageCid && token.epoch && token.position);
  }

  private createLinkStalePredicate(
    linkKey: string,
    capturedLink: ReplicationLinkState | undefined,
    generation: number,
  ): () => boolean {
    return (): boolean =>
      this._engineGeneration !== generation ||
      !this._activeLinks.has(linkKey) ||
      (capturedLink !== undefined && this._activeLinks.get(linkKey) !== capturedLink);
  }

  private async handleLivePullMessage(context: LivePullContext, subMessage: SubscriptionMessage): Promise<void> {
    if (context.isStale()) {
      return;
    }

    if (subMessage.type === 'eose') {
      await this.handleLivePullEose(context, subMessage);
      return;
    }

    if (subMessage.type === 'error') {
      await this.handleLivePullSubscriptionError(context, subMessage);
      return;
    }

    if (subMessage.type === 'event') {
      await this.handleLivePullEvent(context, subMessage);
    }
  }

  private async handleLivePullEose(
    { did, dwnUrl, eventScope, linkKey, link, isStale }: LivePullContext,
    subMessage: Extract<SubscriptionMessage, { type: 'eose' }>,
  ): Promise<void> {
    if (link) {
      // Guard: if the link transitioned to repairing while catch-up events
      // were being processed, skip all mutations — repair owns the state now.
      if (link.status !== 'live' && link.status !== 'initializing') {
        return;
      }

      if (!ReplicationLedger.validateTokenDomain(link.pull, subMessage.cursor)) {
        console.warn(`SyncEngineLevel: Token domain mismatch on EOSE for ${did} -> ${dwnUrl}, transitioning to repairing`);
        if (!isStale()) { await this.transitionToRepairing(linkKey, link); }
        return;
      }
      ReplicationLedger.setReceivedToken(link.pull, subMessage.cursor);
      this.drainCommittedPull(linkKey);
      if (isStale()) { return; }
      await this.ledger.saveLink(link);
    }

    this.markPullLinkOnline({ did, dwnUrl, eventScope, linkKey, link });
  }

  private markPullLinkOnline({ did, dwnUrl, eventScope, linkKey, link }: {
    did: string;
    dwnUrl: string;
    eventScope: SyncEventScope;
    linkKey: string;
    link?: ReplicationLinkState;
  }): void {
    if (!link) {
      this._connectivityState = 'online';
      return;
    }

    const previous = link.connectivity;
    link.connectivity = 'online';
    if (previous !== 'online') {
      this.emitEvent({ type: 'link:connectivity-change', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, from: previous, to: 'online' });
    }
    if (link.needsReconcile) {
      this.scheduleReconcile(linkKey, 500);
    }
  }

  private async handleLivePullSubscriptionError(
    { did, dwnUrl, linkKey, link, isStale }: LivePullContext,
    subMessage: Extract<SubscriptionMessage, { type: 'error' }>,
  ): Promise<void> {
    console.warn(`SyncEngineLevel: subscription error for ${did} -> ${dwnUrl}: ${subMessage.error.code}`);

    if (link && !isStale()) {
      await this.transitionToRepairing(linkKey, link);
    }
  }

  private async handleLivePullEvent(
    context: LivePullContext,
    subMessage: Extract<SubscriptionMessage, { type: 'event' }>,
  ): Promise<void> {
    const event = subMessage.event;
    if (await this.shouldSkipLivePullEvent(context, subMessage)) {
      return;
    }

    const delivery = this.startPullDelivery(context, subMessage.cursor);
    try {
      const pulledCid = await this.processLivePullEvent(context, event);
      if (!pulledCid) { return; }

      this.trackRecentlyPulledMessage(pulledCid, context.dwnUrl);
      this.clearFailedMessage(pulledCid, context.dwnUrl).catch(() => { /* teardown race */ });
      await this.commitPullDelivery(context, subMessage.cursor, delivery);
    } catch (error: any) {
      await this.handleLivePullProcessingError(context, event, error);
    }
  }

  private async shouldSkipLivePullEvent(
    { did, dwnUrl, linkKey, link, isStale }: LivePullContext,
    subMessage: Extract<SubscriptionMessage, { type: 'event' }>,
  ): Promise<boolean> {
    // Guard: if the link is not live (e.g., repairing, degraded_poll, paused),
    // skip all processing. Old subscription handlers may still fire after the
    // link transitions — these events should be ignored entirely, not just
    // skipped at the checkpoint level.
    if (link && link.status !== 'live' && link.status !== 'initializing') {
      return true;
    }

    // Domain validation: reject tokens from a different stream/epoch.
    if (link && !ReplicationLedger.validateTokenDomain(link.pull, subMessage.cursor)) {
      console.warn(`SyncEngineLevel: Token domain mismatch for ${did} -> ${dwnUrl}, transitioning to repairing`);
      if (!isStale()) { await this.transitionToRepairing(linkKey, link); }
      return true;
    }

    if (link) {
      const scopeClassification = classifySyncEventScope(subMessage.event, link.scope);
      if (scopeClassification === 'out-of-scope') {
        await this.skipOutOfScopePullEvent({ link, cursor: subMessage.cursor, isStale });
        return true;
      }
      if (scopeClassification === 'unknown') {
        console.warn(`SyncEngineLevel: Unable to classify scoped pull event for ${did} -> ${dwnUrl}, transitioning to repair`);
        if (!isStale()) { await this.transitionToRepairing(linkKey, link); }
        return true;
      }
    }

    return false;
  }

  private async skipOutOfScopePullEvent({ link, cursor, isStale }: {
    link: ReplicationLinkState;
    cursor: ProgressToken;
    isStale: () => boolean;
  }): Promise<void> {
    // Skipped events MUST advance contiguousAppliedToken — otherwise the link
    // would replay the same filtered-out events indefinitely after reconnect or
    // repair. This is safe because the event is intentionally excluded from
    // this scope and doesn't need processing.
    if (isStale()) { return; }

    ReplicationLedger.setReceivedToken(link.pull, cursor);
    ReplicationLedger.commitContiguousToken(link.pull, cursor);
    await this.ledger.saveLink(link);
  }

  private startPullDelivery({ linkKey, link }: LivePullContext, cursor: ProgressToken): PullDelivery {
    // Assign a delivery ordinal BEFORE async processing begins. This captures
    // delivery order even if processing completes out of order.
    const runtime = link ? this.getOrCreateRuntime(linkKey) : undefined;
    const ordinal = runtime ? runtime.nextDeliveryOrdinal++ : -1;
    if (runtime) {
      runtime.inflight.set(ordinal, { ordinal, token: cursor, committed: false });
    }
    return { runtime, ordinal };
  }

  private async processLivePullEvent(context: LivePullContext, event: MessageEvent): Promise<string | undefined> {
    const dataStreamFactory = await this.createLivePullDataStreamFactory(context, event);
    let applyStatus = await this.applyLivePullEvent(context, event, dataStreamFactory);
    if (context.isStale()) { return undefined; }

    let applied = SyncEngineLevel.isApplySuccess(applyStatus.code);
    if (applied) {
      this.invalidateClosureCacheForMessage(context.did, event.message);
    }

    if (!await this.ensureClosureComplete(context, event)) {
      return undefined;
    }

    if (!applied) {
      applyStatus = await this.applyLivePullEvent(context, event, dataStreamFactory);
      if (context.isStale()) { return undefined; }

      applied = SyncEngineLevel.isApplySuccess(applyStatus.code);
      if (!applied) {
        throw await this.createLivePullApplyError(event, applyStatus);
      }
      this.invalidateClosureCacheForMessage(context.did, event.message);
    }

    // Squash convergence: processRawMessage triggers the DWN's built-in
    // squash resumable task (performRecordsSquash), so no additional
    // sync-engine side effect is needed here.
    return Message.getCid(event.message);
  }

  private async applyLivePullEvent(
    context: LivePullContext,
    event: MessageEvent,
    dataStreamFactory: LivePullDataStreamFactory,
  ): Promise<ApplyStatus> {
    const dataStream = await dataStreamFactory();
    const reply = await this.agent.dwn.processRawMessage(context.did, event.message, { dataStream });
    return reply.status;
  }

  private async createLivePullDataStreamFactory(
    context: LivePullContext,
    event: MessageEvent,
  ): Promise<LivePullDataStreamFactory> {
    if (!isRecordsWrite(event)) {
      return async () => undefined;
    }

    const encodedData = (event.message as any).encodedData as string | undefined;
    if (encodedData) {
      delete (event.message as any).encodedData;
      const bytes = Encoder.base64UrlToBytes(encodedData);
      return async () => SyncEngineLevel.dataStreamFromBytes(bytes);
    }

    const eventData = (event as any).data as ReadableStream<Uint8Array> | undefined;
    if (eventData) {
      const bytes = await SyncEngineLevel.readStreamBytes(eventData);
      return async () => SyncEngineLevel.dataStreamFromBytes(bytes);
    }

    if (!(event.message.descriptor as any).dataCid) {
      return async () => undefined;
    }

    // For large RecordsWrite messages (no inline data), fetch the data from
    // the remote DWN via MessagesRead before each store attempt. ReadableStream
    // instances are single-use, so a repair-triggered retry needs a fresh fetch.
    const { did, dwnUrl, delegateDid, permissionGrantIds } = context;
    const messageCid = await Message.getCid(event.message);
    return async () => {
      const fetched = await fetchRemoteMessages({
        did,
        dwnUrl,
        delegateDid,
        permissionGrantIds,
        messageCids : [messageCid],
        agent       : this.agent,
      });
      return fetched[0]?.dataStream;
    };
  }

  private async createLivePullApplyError(event: MessageEvent, status: ApplyStatus): Promise<Error> {
    const cid = await Message.getCid(event.message);
    return new Error(
      `SyncEngineLevel: live pull apply failed for ${cid}: ${status.code} ${status.detail ?? ''}`.trim()
    );
  }

  private static dataStreamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes);
        controller.close();
      }
    });
  }

  private static async readStreamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        chunks.push(value);
        totalSize += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private static isApplySuccess(code: number): boolean {
    return (code >= 200 && code < 300) || code === 409;
  }

  private invalidateClosureCacheForMessage(did: string, message: GenericMessage): void {
    // Must run before closure validation so subsequent evaluations in the same
    // session see the updated local state.
    const closureCtx = this._closureContexts.get(did);
    if (closureCtx) {
      invalidateClosureCache(closureCtx, message);
    }
  }

  private async ensureClosureComplete(context: LivePullContext, event: MessageEvent): Promise<boolean> {
    const { did, delegateDid, link, isStale } = context;
    if (!link || link.scope.kind === 'full') {
      return true;
    }

    let closureCtx = this._closureContexts.get(did);
    if (!closureCtx) {
      closureCtx = createClosureContext(did, undefined, {
        isDelegateSession: !!delegateDid,
      });
      this._closureContexts.set(did, closureCtx);
    }

    const messageStore = this.agent.dwn.node.storage.messageStore;
    let closureResult = await evaluateClosure(event.message, messageStore, link.scope, closureCtx);
    if (isStale()) { return false; }
    if (closureResult.complete) { return true; }

    if (await this.tryRepairMissingProtocolMetadata(context, closureCtx, closureResult)) {
      if (isStale()) { return false; }

      closureResult = await evaluateClosure(event.message, messageStore, link.scope, closureCtx);
      if (isStale()) { return false; }
      if (closureResult.complete) { return true; }
    }

    await this.recordClosureFailure(context, event, closureResult.failure!.code, closureResult.failure!.detail);
    return false;
  }

  private async tryRepairMissingProtocolMetadata(
    context: LivePullContext,
    closureCtx: ClosureEvaluationContext,
    closureResult: ClosureResult,
  ): Promise<boolean> {
    const failure = closureResult.failure;
    if (!SyncEngineLevel.isRepairableProtocolMetadataFailure(failure)) {
      return false;
    }

    const { did } = context;
    const repairKey = `${did}|${failure.edge.identifier}`;
    const activeRepair = this._protocolMetadataRepairs.get(repairKey);
    if (activeRepair) {
      return activeRepair;
    }

    const repair = this.repairMissingProtocolMetadata(context, closureCtx, failure.edge.identifier);
    this._protocolMetadataRepairs.set(repairKey, repair);
    repair.finally(() => {
      if (this._protocolMetadataRepairs.get(repairKey) === repair) {
        this._protocolMetadataRepairs.delete(repairKey);
      }
    }).catch(() => { /* caller handles the repair result */ });
    return repair;
  }

  private async repairMissingProtocolMetadata(
    { did, dwnUrl, delegateDid, isStale }: LivePullContext,
    closureCtx: ClosureEvaluationContext,
    protocol: string,
  ): Promise<boolean> {
    if (isStale()) {
      return false;
    }

    const configs = await this.fetchRemoteProtocolConfigClosure({
      authorDid : delegateDid ?? did,
      delegateDid,
      dwnUrl,
      protocol,
      tenantDid : did,
    });
    if (isStale() || configs.length === 0) {
      return false;
    }

    // Live subscriptions can deliver scoped records before the local replica
    // has the tenant's protocol metadata. Reuse the DWN ProtocolsQuery path and
    // only install configs that are signed by the tenant, including composed
    // protocol dependencies needed to authorize the record.
    let repaired = false;
    for (const config of configs) {
      if (isStale()) {
        return repaired;
      }
      const reply = await this.agent.dwn.processRawMessage(did, config);
      if (isStale()) {
        return repaired;
      }
      if (!SyncEngineLevel.protocolConfigApplySucceeded(reply.status.code)) {
        return repaired;
      }

      invalidateClosureCache(closureCtx, config);
      repaired = true;
    }

    return repaired;
  }

  private async fetchRemoteProtocolConfigClosure({
    authorDid,
    delegateDid,
    dwnUrl,
    protocol,
    tenantDid,
  }: {
    authorDid: string;
    delegateDid?: string;
    dwnUrl: string;
    protocol: string;
    tenantDid: string;
  }): Promise<ProtocolsConfigureMessage[]> {
    const configsByProtocol = new Map<string, ProtocolsConfigureMessage>();
    const visiting = new Set<string>();

    const visit = async (protocolUri: string): Promise<boolean> => {
      if (configsByProtocol.has(protocolUri)) {
        return true;
      }
      if (visiting.has(protocolUri)) {
        return true;
      }
      visiting.add(protocolUri);

      const config = await this.fetchRemoteProtocolConfig({
        authorDid,
        delegateDid,
        dwnUrl,
        protocol: protocolUri,
        tenantDid,
      });
      if (config === undefined) {
        visiting.delete(protocolUri);
        return false;
      }

      for (const usedProtocol of SyncEngineLevel.protocolsConfigureUses(config)) {
        if (!await visit(usedProtocol)) {
          visiting.delete(protocolUri);
          return false;
        }
      }

      configsByProtocol.set(protocolUri, config);
      visiting.delete(protocolUri);
      return true;
    };

    return await visit(protocol) ? [...configsByProtocol.values()] : [];
  }

  private async fetchRemoteProtocolConfig({
    authorDid,
    delegateDid,
    dwnUrl,
    protocol,
    tenantDid,
  }: {
    authorDid: string;
    delegateDid?: string;
    dwnUrl: string;
    protocol: string;
    tenantDid: string;
  }): Promise<ProtocolsConfigureMessage | undefined> {
    try {
      const permissionGrantId = await this.getProtocolsQueryPermissionGrantId({
        delegateDid,
        protocol,
        tenantDid,
      });
      const { message } = await this.agent.processDwnRequest({
        author        : authorDid,
        messageParams : {
          filter: { protocol },
          ...(permissionGrantId === undefined ? {} : { permissionGrantId }),
        },
        messageType : DwnInterface.ProtocolsQuery,
        store       : false,
        target      : tenantDid,
      });

      const reply = await this.agent.rpc.sendDwnRequest({
        dwnUrl,
        message,
        targetDid: tenantDid,
      }) as ProtocolsQueryReply;
      if (reply.status.code !== 200 || reply.entries === undefined) {
        return undefined;
      }

      const candidates: ProtocolsConfigureMessage[] = [];
      for (const entry of reply.entries) {
        const config = await this.toAuthenticatedTenantProtocolConfig(tenantDid, entry);
        if (config?.descriptor.definition.protocol === protocol) {
          candidates.push(config);
        }
      }

      return SyncEngineLevel.newestProtocolConfig(candidates);
    } catch {
      return undefined;
    }
  }

  private async getProtocolsQueryPermissionGrantId({
    delegateDid,
    protocol,
    tenantDid,
  }: {
    delegateDid?: string;
    protocol: string;
    tenantDid: string;
  }): Promise<string | undefined> {
    if (delegateDid === undefined) {
      return undefined;
    }

    try {
      const { grant } = await this._permissionsApi.getPermissionForRequest({
        connectedDid : tenantDid,
        delegateDid,
        protocol,
        cached       : true,
        messageType  : DwnInterface.ProtocolsQuery,
      });
      return grant.id;
    } catch {
      return undefined;
    }
  }

  private async toAuthenticatedTenantProtocolConfig(
    tenantDid: string,
    message: GenericMessage,
  ): Promise<ProtocolsConfigureMessage | undefined> {
    if (!SyncEngineLevel.isProtocolsConfigureDefinitionMessage(message)) {
      return undefined;
    }

    try {
      await ProtocolsConfigure.parse(message);
      if (Message.getAuthor(message) !== tenantDid) {
        return undefined;
      }
      await authenticate(message.authorization, this.agent.did);
      return message;
    } catch {
      return undefined;
    }
  }

  private static isProtocolsConfigureDefinitionMessage(
    message: GenericMessage,
  ): message is ProtocolsConfigureMessage & { descriptor: ProtocolsConfigureDefinitionDescriptor } {
    const descriptor: MaybeProtocolsConfigureDefinitionDescriptor = message.descriptor;
    return message.authorization !== undefined &&
      descriptor.interface === DwnInterfaceName.Protocols &&
      descriptor.method === DwnMethodName.Configure &&
      typeof descriptor.definition?.protocol === 'string';
  }

  private static protocolsConfigureUses(message: ProtocolsConfigureMessage): string[] {
    const uses = message.descriptor.definition.uses;
    if (uses === undefined) {
      return [];
    }

    return Object.values(uses)
      .filter((protocol): protocol is string => typeof protocol === 'string')
      .sort(lexicographicalCompare);
  }

  private static newestProtocolConfig(
    configs: ProtocolsConfigureMessage[],
  ): ProtocolsConfigureMessage | undefined {
    let newest: ProtocolsConfigureMessage | undefined;
    for (const config of configs) {
      if (newest === undefined || SyncEngineLevel.isProtocolConfigNewer(config, newest)) {
        newest = config;
      }
    }
    return newest;
  }

  private static isProtocolConfigNewer(
    candidate: ProtocolsConfigureMessage,
    current: ProtocolsConfigureMessage,
  ): boolean {
    return candidate.descriptor.messageTimestamp > current.descriptor.messageTimestamp;
  }

  private static protocolConfigApplySucceeded(code: number): boolean {
    return (code >= 200 && code < 300) || code === 409;
  }

  private static isRepairableProtocolMetadataFailure(
    failure: ClosureResult['failure'] | undefined,
  ): failure is NonNullable<ClosureResult['failure']> {
    return failure?.edge.identifierType === 'protocol' &&
      (
        failure.code === ClosureFailureCode.ProtocolMetadataMissing ||
        failure.code === ClosureFailureCode.CrossProtocolReferenceMissing ||
        failure.code === ClosureFailureCode.EncryptionDependencyMissing
      );
  }

  private async recordClosureFailure(
    { did, dwnUrl, linkKey, link, isStale }: LivePullContext,
    event: MessageEvent,
    failureCode: string,
    failureDetail: string,
  ): Promise<void> {
    console.warn(
      `SyncEngineLevel: Closure incomplete for ${did} -> ${dwnUrl}: ` +
      `${failureCode} — ${failureDetail}`
    );

    const closureCid = await Message.getCid(event.message);
    void this.recordDeadLetter({
      messageCid     : closureCid,
      tenantDid      : did,
      remoteEndpoint : dwnUrl,
      protocol       : (event.message.descriptor as Record<string, unknown>).protocol as string | undefined,
      category       : 'closure',
      errorCode      : failureCode,
      errorDetail    : failureDetail,
    });

    if (link && !isStale() && isTerminalClosureFailureCode(failureCode)) {
      await this.transitionToTerminalIncomplete(linkKey, link);
      return;
    }

    if (link && !isStale()) {
      await this.transitionToRepairing(linkKey, link);
    }
  }

  private trackRecentlyPulledMessage(messageCid: string, dwnUrl: string): void {
    this._recentlyPulledCids.set(`${messageCid}|${dwnUrl}`, Date.now() + SyncEngineLevel.ECHO_SUPPRESS_TTL_MS);
    this.evictExpiredEchoEntries();
  }

  private async commitPullDelivery(
    { did, dwnUrl, linkKey, link, isStale }: LivePullContext,
    cursor: ProgressToken,
    delivery: PullDelivery,
  ): Promise<void> {
    // Guard: if the link transitioned to repairing while this handler was
    // in-flight, skip all state mutations — the repair process owns progression.
    if (!link || !delivery.runtime || link.status !== 'live' || isStale()) {
      return;
    }

    const entry = delivery.runtime.inflight.get(delivery.ordinal);
    if (entry) { entry.committed = true; }

    ReplicationLedger.setReceivedToken(link.pull, cursor);
    const drained = this.drainCommittedPull(linkKey);
    if (drained > 0) {
      await this.ledger.saveLink(link);
      this.emitPullCheckpointAdvance(link);
    }

    if (delivery.runtime.inflight.size > MAX_PENDING_TOKENS) {
      console.warn(`SyncEngineLevel: Pull in-flight overflow for ${did} -> ${dwnUrl}, transitioning to repairing`);
      await this.transitionToRepairing(linkKey, link);
    }
  }

  private emitPullCheckpointAdvance(link: ReplicationLinkState): void {
    if (!link.pull.contiguousAppliedToken) {
      return;
    }

    // Emit after durable save — "advanced" means persisted.
    this.emitEvent({
      type           : 'checkpoint:pull-advance',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...syncEventScope(link.scope),
      position       : link.pull.contiguousAppliedToken.position,
      messageCid     : link.pull.contiguousAppliedToken.messageCid,
    });
  }

  private async handleLivePullProcessingError(
    { did, dwnUrl, linkKey, link, isStale }: LivePullContext,
    event: MessageEvent,
    error: any,
  ): Promise<void> {
    console.error(`SyncEngineLevel: Error processing live-pull event for ${did}`, error);
    await this.recordPullProcessingFailure({ did, dwnUrl, event, error });

    // A failed processRawMessage means local state is incomplete. Transition
    // to repairing immediately — do NOT advance the checkpoint past this
    // failure or let later ordinals commit past it. SMT reconciliation will
    // discover and fill the gap.
    if (link && !isStale()) {
      await this.transitionToRepairing(linkKey, link);
    }
  }

  private async recordPullProcessingFailure({ did, dwnUrl, event, error }: {
    did: string;
    dwnUrl: string;
    event: MessageEvent;
    error: any;
  }): Promise<void> {
    try {
      const failedCid = await Message.getCid(event.message);
      void this.recordDeadLetter({
        messageCid     : failedCid,
        tenantDid      : did,
        remoteEndpoint : dwnUrl,
        protocol       : (event.message.descriptor as Record<string, unknown>).protocol as string | undefined,
        category       : 'pull-processing',
        errorDetail    : error.message ?? String(error),
      });
    } catch {
      // Best effort — don't let dead letter recording block repair.
    }
  }

  // ---------------------------------------------------------------------------
  // Live push: local EventLog subscription for immediate push
  // ---------------------------------------------------------------------------

  /**
   * Subscribes to the local DWN's EventLog so that writes by the user are
   * immediately pushed to the remote DWN instead of waiting for the next poll.
   */
  private async openLocalPushSubscription(target: LinkSyncTarget): Promise<void> {
    const { did, delegateDid, dwnUrl } = target;
    const protocol = singleProtocolForSyncScope(target.scope);

    const filters = target.scope.kind === 'protocolSet'
      ? target.scope.protocols.map(protocol => ({ protocol }))
      : [];

    const handlerGeneration = this._engineGeneration;

    // Capture the link for identity-based staleness detection.
    const capturedPushLink = this._activeLinks.get(target.linkKey);
    const isPushStale = (): boolean =>
      this._engineGeneration !== handlerGeneration ||
      !this._activeLinks.has(target.linkKey) ||
      (capturedPushLink !== undefined && this._activeLinks.get(target.linkKey) !== capturedPushLink);

    // Subscribe to the local DWN's EventLog.
    const subscriptionHandler = async (subMessage: SubscriptionMessage): Promise<void> => {
      if (isPushStale()) {
        return;
      }

      if (subMessage.type !== 'event') {
        return;
      }

      // Subset scope filtering: only push events that match the link scope.
      // Events outside the scope are not this link's responsibility.
      const pushLinkKey = target.linkKey;
      const pushLink = this._activeLinks.get(pushLinkKey);
      if (pushLink) {
        const scopeClassification = classifySyncEventScope(subMessage.event, pushLink.scope);
        if (scopeClassification === 'out-of-scope') {
          return;
        }
        if (scopeClassification === 'unknown') {
          this.markLinkNeedsReconcile(pushLinkKey, pushLink, 'push-scope-unclassified');
          return;
        }
      }

      // Accumulate the message CID for a debounced push.
      const targetKey = pushLinkKey;
      const cid = await Message.getCid(subMessage.event.message);
      if (cid === undefined || isPushStale()) {
        return;
      }

      // Echo-loop suppression: skip CIDs that were recently pulled from this
      // specific remote. A message pulled from Provider A is only suppressed
      // for push to A — it still fans out to Provider B and C.
      if (this.isRecentlyPulled(cid, dwnUrl)) {
        return;
      }

      const pushRuntime = this.getOrCreatePushRuntime(targetKey, {
        did,
        dwnUrl,
        delegateDid,
        protocol,
        permissionGrantIds: target.permissionGrantIds,
      });
      pushRuntime.entries.push({ cid });

      // Immediate-first: if no push is in flight and no batch timer is
      // pending, push immediately. Otherwise, the pending batch timer
      // or the post-flush drain will pick up the new entry.
      if (!pushRuntime.flushing && !pushRuntime.timer) {
        void this.flushPendingPushesForLink(targetKey);
      }
    };

    // Subscribe to the local DWN EventLog from "now" — opportunistic push
    // does not replay from a stored cursor. Any writes missed during outages
    // are recovered by the post-repair reconciliation path.
    const response = await this.agent.dwn.processRequest({
      author              : did,
      target              : did,
      messageType         : DwnInterface.MessagesSubscribe,
      granteeDid          : delegateDid,
      messageParams       : { filters, permissionGrantIds: toMessagesPermissionGrantIds(target.permissionGrantIds) },
      subscriptionHandler : subscriptionHandler as any,
    });

    const reply = response.reply as MessagesSubscribeReply;
    if (reply.status.code !== 200 || !reply.subscription) {
      throw new Error(`SyncEngineLevel: Local MessagesSubscribe failed for ${did}: ${reply.status.code} ${reply.status.detail}`);
    }

    const close = async (): Promise<void> => { await reply.subscription!.close(); };
    this._localSubscriptions.push({
      linkKey: target.linkKey,
      did,
      dwnUrl,
      delegateDid,
      close,
    });
  }

  /**
   * Flushes accumulated push CIDs to remote DWNs.
   */
  private async flushPendingPushes(): Promise<void> {
    await Promise.all([...this._pushRuntimes.keys()].map(async (linkKey) => {
      await this.flushPendingPushesForLink(linkKey);
    }));
  }

  private async flushPendingPushesForLink(linkKey: string): Promise<void> {
    const batch = this.takePushFlushBatch(linkKey);
    if (!batch) { return; }

    const { pushRuntime, pushEntries, isStale } = batch;
    const { did, dwnUrl, delegateDid, protocol, permissionGrantIds, retryCount } = pushRuntime;

    try {
      const result = await pushMessages({
        did,
        dwnUrl,
        delegateDid,
        permissionGrantIds,
        messageCids : pushEntries.map((entry) => entry.cid),
        agent       : this.agent,
      });

      await this.handlePushBatchResult(linkKey, batch, result);
    } catch (error: any) {
      if (isStale()) { return; }
      console.error(`SyncEngineLevel: Push batch failed for ${did} -> ${dwnUrl}`, error);
      this.requeueOrReconcile(linkKey, {
        did,
        dwnUrl,
        delegateDid,
        protocol,
        permissionGrantIds,
        entries    : pushEntries,
        retryCount : retryCount + 1,
      });
    } finally {
      this.finishPushFlush(linkKey, pushRuntime);
    }
  }

  private takePushFlushBatch(linkKey: string): PushFlushBatch | undefined {
    // Guard: bail if this link was hot-removed or is no longer live. Without
    // this, a stale debounce timer or retry callback could send pushes after
    // the DID was removed or the link entered repair/terminal state.
    const flushLink = this._activeLinks.get(linkKey);
    if (flushLink?.status !== 'live') {
      const staleRuntime = this._pushRuntimes.get(linkKey);
      if (staleRuntime?.timer) {
        clearTimeout(staleRuntime.timer);
      }
      this._pushRuntimes.delete(linkKey);
      return undefined;
    }

    const pushRuntime = this._pushRuntimes.get(linkKey);
    if (!pushRuntime) {
      return undefined;
    }

    const { entries: pushEntries, retryCount } = pushRuntime;
    pushRuntime.entries = [];

    if (pushEntries.length === 0) {
      if (!pushRuntime.timer && !pushRuntime.flushing && retryCount === 0) {
        this._pushRuntimes.delete(linkKey);
      }
      return undefined;
    }

    // Capture the current active link identity so we can detect
    // remove+re-add during the await pushMessages() call.
    const isStale = (): boolean =>
      !this._activeLinks.has(linkKey) ||
      (flushLink !== undefined && this._activeLinks.get(linkKey) !== flushLink);

    pushRuntime.flushing = true;
    return { pushRuntime, pushEntries, isStale };
  }

  private async handlePushBatchResult(
    linkKey: string,
    batch: PushFlushBatch,
    result: PushResult,
  ): Promise<void> {
    if (batch.isStale()) { return; }

    this.clearSucceededPushFailures(result.succeeded, batch.pushRuntime.dwnUrl);
    await this.recordPermanentPushFailures(batch.pushRuntime, result.permanentlyFailed);

    if (result.failed.length > 0) {
      this.requeueFailedPushes(linkKey, batch, result.failed);
      return;
    }

    this.cleanupSuccessfulPushRuntime(linkKey, batch.pushRuntime);
  }

  private clearSucceededPushFailures(cids: string[], dwnUrl: string): void {
    for (const cid of cids) {
      this.clearFailedMessage(cid, dwnUrl).catch(() => { /* teardown race */ });
    }
  }

  private async recordPermanentPushFailures(
    pushRuntime: PushRuntimeState,
    permanentlyFailed: PushResult['permanentlyFailed'],
  ): Promise<void> {
    for (const entry of permanentlyFailed) {
      await this.recordDeadLetter({
        messageCid     : entry.cid,
        tenantDid      : pushRuntime.did,
        remoteEndpoint : pushRuntime.dwnUrl,
        protocol       : pushRuntime.protocol,
        category       : 'push-permanent',
        errorCode      : String(entry.statusCode ?? ''),
        errorDetail    : entry.detail ?? 'permanent push failure',
      });
    }
  }

  private requeueFailedPushes(linkKey: string, batch: PushFlushBatch, failedCids: string[]): void {
    if (batch.isStale()) { return; }

    const { did, dwnUrl, delegateDid, protocol, permissionGrantIds, retryCount } = batch.pushRuntime;
    const failedSet = new Set(failedCids);
    const failedEntries = batch.pushEntries.filter((entry) => failedSet.has(entry.cid));
    this.requeueOrReconcile(linkKey, {
      did,
      dwnUrl,
      delegateDid,
      protocol,
      permissionGrantIds,
      entries    : failedEntries,
      retryCount : retryCount + 1,
    });
  }

  private cleanupSuccessfulPushRuntime(linkKey: string, pushRuntime: PushRuntimeState): void {
    // Successful push — reset retry count so subsequent unrelated batches on
    // this link start with a fresh budget.
    pushRuntime.retryCount = 0;
    if (!pushRuntime.timer && pushRuntime.entries.length === 0) {
      this._pushRuntimes.delete(linkKey);
    }
  }

  private finishPushFlush(linkKey: string, pushRuntime: PushRuntimeState): void {
    pushRuntime.flushing = false;

    // If new entries accumulated while this push was in flight, schedule a
    // short drain to flush them. This gives a brief batching window for burst
    // writes while keeping single-write latency low.
    const rt = this._pushRuntimes.get(linkKey);
    if (rt && rt.entries.length > 0 && !rt.timer) {
      rt.timer = setTimeout((): void => {
        rt.timer = undefined;
        void this.flushPendingPushesForLink(linkKey);
      }, PUSH_DEBOUNCE_MS);
    }
  }

  /** Push retry backoff schedule: immediate, 250ms, 1s, 2s, then give up. */
  private static readonly PUSH_RETRY_BACKOFF_MS = [0, 250, 1000, 2000];
  private static readonly ROOT_CONVERGENCE_CLEARABLE_DEAD_LETTER_CATEGORIES: ReadonlySet<DeadLetterCategory> =
    new Set(['push-permanent', 'push-exhausted', 'pull-processing', 'pull-scope-rejected']);

  /**
   * Re-queues a failed push batch for retry, or marks the link
   * `needsReconcile` if retries are exhausted. Bounded to prevent
   * infinite retry loops.
   */
  private requeueOrReconcile(targetKey: string, pending: {
    did: string; dwnUrl: string; delegateDid?: string; protocol?: string;
    permissionGrantIds?: NonEmptyStringArray;
    entries: PushRuntimeEntry[];
    retryCount: number;
  }): void {
    const maxRetries = SyncEngineLevel.PUSH_RETRY_BACKOFF_MS.length;
    const pushRuntime = this.getOrCreatePushRuntime(targetKey, pending);

    if (pending.retryCount >= maxRetries) {
      // Retry budget exhausted — record each CID as a dead letter and mark
      // the link dirty for reconciliation.
      for (const entry of pending.entries) {
        void this.recordDeadLetter({
          messageCid     : entry.cid,
          tenantDid      : pending.did,
          remoteEndpoint : pending.dwnUrl,
          protocol       : pending.protocol,
          category       : 'push-exhausted',
          errorDetail    : `push retries exhausted after ${maxRetries} attempts`,
        });
      }
      if (pushRuntime.timer) {
        clearTimeout(pushRuntime.timer);
      }
      this._pushRuntimes.delete(targetKey);
      const link = this._activeLinks.get(targetKey);
      if (link) {
        this.markLinkNeedsReconcile(targetKey, link, 'push-retry-exhausted');
      }
      return;
    }

    pushRuntime.entries.push(...pending.entries);
    pushRuntime.retryCount = pending.retryCount;
    const delayMs = SyncEngineLevel.PUSH_RETRY_BACKOFF_MS[pending.retryCount] ?? 2000;
    if (pushRuntime.timer) {
      clearTimeout(pushRuntime.timer);
    }
    pushRuntime.timer = setTimeout((): void => {
      pushRuntime.timer = undefined;
      void this.flushPendingPushesForLink(targetKey);
    }, delayMs);
  }

  private markLinkNeedsReconcile(linkKey: string, link: ReplicationLinkState, reason: string): void {
    if (link.needsReconcile) {
      this.scheduleReconcile(linkKey);
      return;
    }

    link.needsReconcile = true;
    void this.ledger.saveLink(link).then(() => {
      this.emitEvent({
        type           : 'reconcile:needed',
        tenantDid      : link.tenantDid,
        remoteEndpoint : link.remoteEndpoint,
        ...syncEventScope(link.scope),
        reason,
      });
      this.scheduleReconcile(linkKey);
    }).catch((error: unknown) => {
      console.error(`SyncEngineLevel: Failed to mark link for reconciliation ${link.tenantDid} -> ${link.remoteEndpoint}`, error);
    });
  }

  private createLinkReconciler(shouldContinue?: () => boolean): SyncLinkReconciler {
    return new SyncLinkReconciler({
      getLocalRoot  : async (did, delegateDid, protocol, permissionGrantIds) => this.getLocalRoot(did, delegateDid, protocol, permissionGrantIds),
      getRemoteRoot : async (did, dwnUrl, delegateDid, protocol, permissionGrantIds) =>
        this.getRemoteRoot(did, dwnUrl, delegateDid, protocol, permissionGrantIds),
      diffWithRemote : async (target) => this.diffWithRemote(target),
      pullMessages   : async (params) => this.pullMessages(params),
      pushMessages   : async (params) => this.pushMessages(params),
      shouldContinue,
    });
  }

  private getReconcileProtocols(scope: SyncScope): (string | undefined)[] {
    return protocolsForSyncScope(scope) ?? [undefined];
  }

  private getAuthorizationGrantIds(authorization: SyncAuthorization): NonEmptyStringArray | undefined {
    return authorization.kind === 'delegate' ? authorization.permissionGrantIds : undefined;
  }

  private async reconcileSyncTarget(
    target: SyncReconcileTarget,
    options?: SyncReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    const protocols = protocolsForSyncScope(target.scope);
    if (protocols && protocols.length > 1) {
      return this.reconcileProtocolSetSyncTarget(target, protocols, options, shouldContinue);
    }

    let converged = true;
    const permissionGrantIds = this.getAuthorizationGrantIds(target.authorization);
    const reconciler = this.createLinkReconciler(shouldContinue);

    for (const protocol of protocols ?? [undefined]) {
      const outcome = await reconciler.reconcile({
        did         : target.did,
        dwnUrl      : target.dwnUrl,
        delegateDid : target.delegateDid,
        protocol,
        permissionGrantIds,
      }, options);
      if (outcome.aborted) {
        return { aborted: true };
      }
      if (options?.verifyConvergence === true && outcome.converged !== true) {
        converged = false;
      }
    }

    return options?.verifyConvergence === true ? { converged } : {};
  }

  private async reconcileProtocolSetSyncTarget(
    target: SyncReconcileTarget,
    protocols: NonEmptyStringArray,
    options?: SyncReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    const context = this.createProtocolSetReconcileContext(target, protocols, shouldContinue);
    const diffResult = await this.collectProtocolSetDiffs(context);
    if (diffResult.aborted) {
      return { aborted: true };
    }

    const pullResult = await this.applyProtocolSetRemoteDiffs(context, diffResult.diffs, options);
    if (pullResult) {
      return pullResult;
    }

    const pushResult = await this.applyProtocolSetLocalDiffs(context, diffResult.diffs, options);
    if (pushResult) {
      return pushResult;
    }

    if (options?.verifyConvergence !== true) {
      return {};
    }

    return this.verifyProtocolSetConvergence(context);
  }

  private createProtocolSetReconcileContext(
    target: SyncReconcileTarget,
    protocols: NonEmptyStringArray,
    shouldContinue?: () => boolean,
  ): ProtocolSetReconcileContext {
    return {
      did                : target.did,
      dwnUrl             : target.dwnUrl,
      delegateDid        : target.delegateDid,
      scope              : target.scope,
      permissionGrantIds : this.getAuthorizationGrantIds(target.authorization),
      protocols,
      shouldContinue,
    };
  }

  private static shouldAbortReconcile(shouldContinue?: () => boolean): boolean {
    return shouldContinue?.() === false;
  }

  private async collectProtocolSetDiffs(
    context: ProtocolSetReconcileContext,
  ): Promise<ProtocolSetDiffCollectionResult> {
    const diffs: SyncDiffResult[] = [];

    for (const protocol of context.protocols) {
      const localRoot = await this.getLocalRoot(
        context.did,
        context.delegateDid,
        protocol,
        context.permissionGrantIds,
      );
      if (SyncEngineLevel.shouldAbortReconcile(context.shouldContinue)) {
        return { aborted: true };
      }

      const remoteRoot = await this.getRemoteRoot(
        context.did,
        context.dwnUrl,
        context.delegateDid,
        protocol,
        context.permissionGrantIds,
      );
      if (SyncEngineLevel.shouldAbortReconcile(context.shouldContinue)) {
        return { aborted: true };
      }
      if (localRoot === remoteRoot) {
        continue;
      }

      diffs.push(await this.diffWithRemote({
        did                : context.did,
        dwnUrl             : context.dwnUrl,
        delegateDid        : context.delegateDid,
        protocol,
        permissionGrantIds : context.permissionGrantIds,
      }));
      if (SyncEngineLevel.shouldAbortReconcile(context.shouldContinue)) {
        return { aborted: true };
      }
    }

    return { aborted: false, diffs };
  }

  private async applyProtocolSetRemoteDiffs(
    context: ProtocolSetReconcileContext,
    diffs: SyncDiffResult[],
    options?: SyncReconcileOptions,
  ): Promise<SyncReconcileResult | undefined> {
    const onlyRemote = diffs.flatMap(diff => diff.onlyRemote);
    if (options?.direction === 'push' || onlyRemote.length === 0) {
      return undefined;
    }

    const { prefetched, needsFetchCids } = partitionRemoteEntries(onlyRemote);
    try {
      await this.pullMessages({
        did                : context.did,
        dwnUrl             : context.dwnUrl,
        delegateDid        : context.delegateDid,
        scope              : context.scope,
        permissionGrantIds : context.permissionGrantIds,
        messageCids        : needsFetchCids,
        prefetched,
        shouldContinue     : context.shouldContinue,
      });
    } catch (error) {
      if (error instanceof SyncPullAbortedError) {
        return { aborted: true };
      }
      throw error;
    }

    return SyncEngineLevel.shouldAbortReconcile(context.shouldContinue)
      ? { aborted: true }
      : undefined;
  }

  private async applyProtocolSetLocalDiffs(
    context: ProtocolSetReconcileContext,
    diffs: SyncDiffResult[],
    options?: SyncReconcileOptions,
  ): Promise<SyncReconcileResult | undefined> {
    const onlyLocal = [...new Set(diffs.flatMap(diff => diff.onlyLocal))];
    if (options?.direction === 'pull' || onlyLocal.length === 0) {
      return undefined;
    }

    await this.pushMessages({
      did                : context.did,
      dwnUrl             : context.dwnUrl,
      delegateDid        : context.delegateDid,
      permissionGrantIds : context.permissionGrantIds,
      messageCids        : onlyLocal,
    });

    return SyncEngineLevel.shouldAbortReconcile(context.shouldContinue)
      ? { aborted: true }
      : undefined;
  }

  private async verifyProtocolSetConvergence(
    context: ProtocolSetReconcileContext,
  ): Promise<SyncReconcileResult> {
    for (const protocol of context.protocols) {
      const postLocalRoot = await this.getLocalRoot(
        context.did,
        context.delegateDid,
        protocol,
        context.permissionGrantIds,
      );
      if (SyncEngineLevel.shouldAbortReconcile(context.shouldContinue)) {
        return { aborted: true };
      }

      const postRemoteRoot = await this.getRemoteRoot(
        context.did,
        context.dwnUrl,
        context.delegateDid,
        protocol,
        context.permissionGrantIds,
      );
      if (SyncEngineLevel.shouldAbortReconcile(context.shouldContinue)) {
        return { aborted: true };
      }
      if (postLocalRoot !== postRemoteRoot) {
        return { converged: false };
      }
    }

    return { converged: true };
  }

  private async clearRootConvergenceDeadLettersForScope(
    tenantDid: string,
    remoteEndpoint: string,
    scope: SyncScope,
  ): Promise<void> {
    for (const protocol of this.getReconcileProtocols(scope)) {
      await this.clearRootConvergenceDeadLetters(tenantDid, remoteEndpoint, protocol);
    }
    if (scope.kind === 'protocolSet' && scope.protocols.length > 1) {
      // Multi-protocol reconciliation applies one combined dependency-sorted
      // batch, so operational dead letters from that batch are stored without a
      // single protocol label.
      await this.clearRootConvergenceDeadLetters(tenantDid, remoteEndpoint);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-link reconciliation
  // ---------------------------------------------------------------------------

  /** Active reconcile timers, keyed by link key. */
  private readonly _reconcileTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Active reconcile operations, keyed by link key (dedup). */
  private readonly _reconcileInFlight: Map<string, Promise<void>> = new Map();

  /**
   * Schedule a per-link reconciliation after a short debounce. Coalesces
   * repeated requests for the same link.
   */
  private scheduleReconcile(linkKey: string, delayMs: number = 1500): void {
    if (this._reconcileTimers.has(linkKey)) { return; }
    if (this._reconcileInFlight.has(linkKey)) { return; }
    if (this._activeRepairs.has(linkKey)) { return; }

    const generation = this._engineGeneration;
    const timer = setTimeout((): void => {
      this._reconcileTimers.delete(linkKey);
      if (this._engineGeneration !== generation) { return; }
      // Guard: bail if this link was hot-removed since the timer was
      // scheduled. Without this, a stale timer could restart reconcile
      // work for a DID that is no longer active.
      if (!this._activeLinks.has(linkKey)) { return; }
      void this.reconcileLink(linkKey).catch((): void => {
        // Errors are already logged inside doReconcileLink; swallow here
        // to prevent unhandled-rejection flakes in the test runner.
      });
    }, delayMs);
    this._reconcileTimers.set(linkKey, timer);
  }

  /**
   * Run SMT reconciliation for a single link. Deduplicates concurrent calls.
   * On success, clears `needsReconcile`. On failure, schedules retry.
   */
  private async reconcileLink(linkKey: string): Promise<void> {
    const existing = this._reconcileInFlight.get(linkKey);
    if (existing) { return existing; }

    const promise = this.doReconcileLink(linkKey).finally(() => {
      this._reconcileInFlight.delete(linkKey);
    });
    this._reconcileInFlight.set(linkKey, promise);
    return promise;
  }

  /**
   * Internal reconciliation implementation for a single link. Runs the
   * same SMT diff + pull/push that `sync()` does, but scoped to one link.
   */
  private async doReconcileLink(linkKey: string): Promise<void> {
    const link = this._activeLinks.get(linkKey);
    if (!link) { return; }

    // Only reconcile live links — repairing/degraded links have their own
    // recovery path. Reconciling during repair would race with SMT diff.
    if (link.status !== 'live') {
      return;
    }

    // Skip if a repair is in progress for this link.
    if (this._activeRepairs.has(linkKey)) {
      return;
    }

    const generation = this._engineGeneration;

    // Identity guard: if the DID was hot-removed and re-added, this
    // closure's captured `link` reference may no longer be the active
    // link object. Bail before mutating the replacement's state.
    const isStaleLink = (): boolean => this._activeLinks.get(linkKey) !== link;
    const shouldContinue = (): boolean =>
      this._engineGeneration === generation &&
      !isStaleLink() &&
      link.status === 'live';

    const { tenantDid: did, remoteEndpoint: dwnUrl, delegateDid, scope, authorization } = link;
    const eventScope = syncEventScope(scope);

    try {
      const reconcileOutcome = await this.reconcileSyncTarget({
        did,
        dwnUrl,
        delegateDid,
        scope,
        authorization,
      }, { verifyConvergence: true }, shouldContinue);
      if (reconcileOutcome.aborted || isStaleLink()) { return; }

      if (reconcileOutcome.converged) {
        await this.ledger.clearNeedsReconcile(link);
        // SMT roots match, so transport/apply failures for this link may no
        // longer be current. Closure failures are not cleared by root equality.
        await this.clearRootConvergenceDeadLettersForScope(did, dwnUrl, scope);
        this.emitEvent({ type: 'reconcile:completed', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope });
      } else {
        // Roots still differ — retry after a delay. This can happen when
        // pushMessages() had permanent failures, pullMessages() partially
        // failed, or new writes arrived during reconciliation.
        if (!isStaleLink()) { this.scheduleReconcile(linkKey, 5000); }
      }
    } catch (error: any) {
      if (isStaleLink()) { return; }
      console.error(`SyncEngineLevel: Reconciliation failed for ${did} -> ${dwnUrl}`, error);
      // Schedule retry with longer delay.
      this.scheduleReconcile(linkKey, 5000);
    }
  }

  private getOrCreatePushRuntime(linkKey: string, params: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    permissionGrantIds?: NonEmptyStringArray;
  }): PushRuntimeState {
    let pushRuntime = this._pushRuntimes.get(linkKey);
    if (!pushRuntime) {
      pushRuntime = {
        ...params,
        entries    : [],
        retryCount : 0,
      };
      this._pushRuntimes.set(linkKey, pushRuntime);
    }

    return pushRuntime;
  }

  // ---------------------------------------------------------------------------
  // Cursor persistence
  // ---------------------------------------------------------------------------

  /**
   * Build the runtime key for a replication link.
   *
   * Live-mode subscription methods (`openLivePullSubscription`,
   * `openLocalPushSubscription`) receive `linkKey` directly and never
   * call this. The remaining callers are poll-mode `sync()` and the
   * live-mode startup/error paths that already have a projection ID and
   * authorization epoch.
   */
  private buildLinkKey(did: string, dwnUrl: string, projectionId: string, authorizationEpoch: string): string {
    return buildLinkId(did, dwnUrl, projectionId, authorizationEpoch);
  }

  // ---------------------------------------------------------------------------
  // Default Hash Cache
  // ---------------------------------------------------------------------------

  /**
   * Returns the hex-encoded default (empty-subtree) hash for a given depth.
   * Lazily initializes the cache on first call.
   */
  private async getDefaultHashHex(depth: number): Promise<string> {
    if (this._defaultHashHex === undefined) {
      const defaults = await initDefaultHashes();
      const map = new Map<number, string>();
      // Pre-compute hex strings for depths 0 through MAX_DIFF_DEPTH (inclusive).
      for (let d = 0; d <= MAX_DIFF_DEPTH; d++) {
        map.set(d, hashToHex(defaults[d]));
      }
      this._defaultHashHex = map;
    }
    return this._defaultHashHex.get(depth) ?? '';
  }

  /**
   * Parse a bit prefix string (e.g. "0110101") into a boolean array
   * for the StateIndex API. Each '1' maps to `true` (right child),
   * each '0' maps to `false` (left child).
   */
  private static parseBitPrefix(prefix: string): boolean[] {
    return Array.from(prefix, (ch): boolean => ch === '1');
  }

  // ---------------------------------------------------------------------------
  // SMT Root Comparison
  // ---------------------------------------------------------------------------

  /**
   * Access the local DWN's StateIndex directly, bypassing the `processMessage`
   * pipeline. The sync engine runs in the same process as the local DWN, so
   * there is no need for message signing, schema validation, or authentication
   * when querying our own state.
   *
   * Returns `undefined` in remote mode (no in-process DWN). The local methods
   * fall back to `processRequest` in that case, routing through RPC to the
   * local DWN server.
   */
  private get stateIndex(): StateIndex | undefined {
    if (this.agent.dwn.isRemoteMode) {
      return undefined;
    }
    return this.agent.dwn.node.storage.stateIndex;
  }

  /**
   * Get the SMT root hash from the local DWN.
   *
   * In local mode: queries the StateIndex directly (fast, no processMessage overhead).
   * In remote mode: constructs a signed MessagesSync message and routes through RPC.
   *
   * Returns a hex-encoded root hash string.
   */
  private async getLocalRoot(
    did: string,
    delegateDid?: string,
    protocol?: string,
    permissionGrantIds?: string[],
  ): Promise<string> {
    const si = this.stateIndex;
    if (si) {
      const rootHash = protocol === undefined
        ? await si.getRoot(did)
        : await si.getProtocolRoot(did, protocol);
      return hashToHex(rootHash);
    }

    // Remote mode fallback: go through processRequest → RPC.
    const response = await this.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action             : 'root',
        protocol,
        permissionGrantIds : toMessagesPermissionGrantIds(permissionGrantIds),
      }
    });
    const reply = response.reply as MessagesSyncReply;
    return reply.root ?? '';
  }

  /**
   * Get the SMT root hash from a remote DWN via a MessagesSync 'root' action.
   * Returns a hex-encoded root hash string.
   */
  private async getRemoteRoot(
    did: string,
    dwnUrl: string,
    delegateDid?: string,
    protocol?: string,
    permissionGrantIds?: string[],
  ): Promise<string> {
    const syncMessage = await this.agent.dwn.processRequest({
      store         : false,
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action             : 'root',
        protocol,
        permissionGrantIds : toMessagesPermissionGrantIds(permissionGrantIds)
      }
    });

    const reply = await this.agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : did,
      message   : syncMessage.message,
    }) as MessagesSyncReply;

    return reply.root ?? '';
  }

  // ---------------------------------------------------------------------------
  // Batched Diff — single round-trip set reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Compute the diff between local and remote in a single HTTP round-trip.
   *
   * 1. Walk the local SMT directly (no processMessage) to collect subtree
   *    hashes at `MAX_DIFF_DEPTH`.
   * 2. Send a single `MessagesSync action:'diff'` to the remote with all
   *    non-empty subtree hashes.
   * 3. The remote compares and returns `onlyRemote` (with inline messages)
   *    and `onlyLocal` prefixes.
   * 4. Enumerate local leaves for the `onlyLocal` prefixes directly.
   *
   * This replaces `walkTreeDiff()` which required one HTTP call per tree node.
   */
  private async diffWithRemote({ did, dwnUrl, delegateDid, protocol, permissionGrantIds }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    permissionGrantIds?: string[];
  }): Promise<SyncDiffResult> {
    // Step 1: Collect local subtree hashes at BATCHED_DIFF_DEPTH directly from StateIndex.
    const localHashes = await this.collectLocalSubtreeHashes(did, protocol, BATCHED_DIFF_DEPTH, permissionGrantIds);

    // Step 2: Send a single 'diff' request to the remote with our hashes.
    const messageParams: DwnMessageParams[DwnInterface.MessagesSync] = {
      action             : 'diff',
      protocol,
      hashes             : localHashes,
      depth              : BATCHED_DIFF_DEPTH,
      permissionGrantIds : toMessagesPermissionGrantIds(permissionGrantIds),
    };

    // Step 3: Enumerate local leaves for prefixes the remote reported as onlyLocal.
    // Reuse the same grant set from step 2.
    return this.diffRemoteMessages(
      { did, dwnUrl, delegateDid },
      messageParams,
      prefix => this.getLocalLeaves(did, prefix, delegateDid, protocol, permissionGrantIds),
      'diff',
    );
  }

  private async diffRemoteMessages(
    target: Pick<SyncReconcileTarget, 'did' | 'dwnUrl' | 'delegateDid'>,
    messageParams: DwnMessageParams[DwnInterface.MessagesSync],
    getLocalLeavesForPrefix: (prefix: string) => Promise<string[]>,
    operationName: string,
  ): Promise<SyncDiffResult> {
    const syncMessage = await this.agent.dwn.processRequest({
      store       : false,
      author      : target.did,
      target      : target.did,
      messageType : DwnInterface.MessagesSync,
      granteeDid  : target.delegateDid,
      messageParams,
    });

    const reply = await this.agent.rpc.sendDwnRequest({
      dwnUrl    : target.dwnUrl,
      targetDid : target.did,
      message   : syncMessage.message,
    }) as MessagesSyncReply;

    if (reply.status.code !== 200) {
      throw new Error(`SyncEngineLevel: ${operationName} failed with ${reply.status.code}: ${reply.status.detail}`);
    }

    const onlyLocalCids: string[] = [];
    for (const prefix of reply.onlyLocal ?? []) {
      const leaves = await getLocalLeavesForPrefix(prefix);
      onlyLocalCids.push(...leaves);
    }

    return {
      onlyRemote : reply.onlyRemote ?? [],
      onlyLocal  : onlyLocalCids,
    };
  }

  /**
   * Walk the local SMT to a given depth and collect non-empty subtree hashes.
   * Returns a `{ prefix: hexHash }` map. Empty subtrees (matching the default
   * hash) are omitted.
   *
   * Uses direct StateIndex access in local mode. In remote mode, falls back
   * to `getLocalSubtreeHash` which routes through RPC.
   */
  private async collectLocalSubtreeHashes(
    did: string,
    protocol: string | undefined,
    depth: number,
    permissionGrantIds?: string[],
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const defaultHash = await this.getDefaultHashHex(depth);
    const si = this.stateIndex;

    const walk = async (prefix: string, currentDepth: number): Promise<void> => {
      let hexHash: string;

      if (si) {
        // Fast path: direct StateIndex access (local mode).
        const bitPath = SyncEngineLevel.parseBitPrefix(prefix);
        const hash = protocol === undefined
          ? await si.getSubtreeHash(did, bitPath)
          : await si.getProtocolSubtreeHash(did, protocol, bitPath);
        hexHash = hashToHex(hash);
      } else {
        // Remote mode fallback.
        hexHash = await this.getLocalSubtreeHash(did, prefix, undefined, protocol, permissionGrantIds);
      }

      if (hexHash === defaultHash) {
        // Empty subtree — omit from the map.
        return;
      }

      if (currentDepth >= depth) {
        result[prefix] = hexHash;
        return;
      }

      // Recurse into children.
      await Promise.all([
        walk(prefix + '0', currentDepth + 1),
        walk(prefix + '1', currentDepth + 1),
      ]);
    };

    await walk('', 0);
    return result;
  }

  /**
   * Get the subtree hash at a given bit prefix from the local DWN.
   *
   * In local mode: queries the StateIndex directly.
   * In remote mode: constructs a signed MessagesSync message and routes through RPC.
   */
  private async getLocalSubtreeHash(
    did: string, prefix: string, delegateDid?: string, protocol?: string, permissionGrantIds?: string[]
  ): Promise<string> {
    const si = this.stateIndex;
    if (si) {
      const bitPath = SyncEngineLevel.parseBitPrefix(prefix);
      const hash = protocol === undefined
        ? await si.getSubtreeHash(did, bitPath)
        : await si.getProtocolSubtreeHash(did, protocol, bitPath);
      return hashToHex(hash);
    }

    // Remote mode fallback.
    const response = await this.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action             : 'subtree',
        prefix,
        protocol,
        permissionGrantIds : toMessagesPermissionGrantIds(permissionGrantIds)
      }
    });
    const reply = response.reply as MessagesSyncReply;
    return reply.hash ?? '';
  }

  /**
   * Get all leaf messageCids under a given prefix from the local DWN.
   *
   * In local mode: queries the StateIndex directly.
   * In remote mode: constructs a signed MessagesSync message and routes through RPC.
   */
  private async getLocalLeaves(
    did: string, prefix: string, delegateDid?: string, protocol?: string, permissionGrantIds?: string[]
  ): Promise<string[]> {
    const si = this.stateIndex;
    if (si) {
      const bitPath = SyncEngineLevel.parseBitPrefix(prefix);
      return protocol === undefined
        ? await si.getLeaves(did, bitPath)
        : await si.getProtocolLeaves(did, protocol, bitPath);
    }

    // Remote mode fallback.
    const response = await this.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action             : 'leaves',
        prefix,
        protocol,
        permissionGrantIds : toMessagesPermissionGrantIds(permissionGrantIds)
      }
    });
    const reply = response.reply as MessagesSyncReply;
    return reply.entries ?? [];
  }

  // ---------------------------------------------------------------------------
  // Pull / Push — delegates to standalone functions in sync-messages.ts
  // ---------------------------------------------------------------------------

  /**
   * Fetches missing messages from the remote DWN and processes them locally
   * in dependency order (topological sort).
   *
   * When prefetched entries are provided (from the batched diff response),
   * they are processed directly without additional HTTP round-trips.
   * Only `messageCids` that were NOT prefetched are fetched individually.
   */
  private async pullMessages({
    did,
    dwnUrl,
    delegateDid,
    protocol,
    scope,
    permissionGrantIds,
    messageCids,
    prefetched,
    shouldContinue,
  }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    scope?: SyncScope;
    permissionGrantIds?: string[];
    messageCids: string[];
    prefetched?: MessagesSyncDiffEntry[];
    shouldContinue?: () => boolean;
  }): Promise<void> {
    const acceptanceScope: SyncScope = scope ?? (protocol === undefined
      ? { kind: 'full' }
      : { kind: 'protocolSet', protocols: [protocol] });
    const rejectedPullEntries = new Map<string, Extract<PullAcceptanceResult, { accepted: false }>>();
    const failedCids = await pullMessages({
      did,
      dwnUrl,
      delegateDid,
      permissionGrantIds,
      messageCids,
      prefetched,
      shouldContinue,
      agent       : this.agent,
      acceptEntry : async (entry, entries) => {
        const result = await this.acceptPulledSyncEntry(did, acceptanceScope, entry, entries);
        if (!result.accepted) {
          rejectedPullEntries.set(await getMessageCid(entry.message), result);
        }
        return result.accepted;
      },
    });

    // Record permanently failed pull entries in the dead letter store.
    for (const cid of failedCids) {
      const rejection = rejectedPullEntries.get(cid);
      await this.recordDeadLetter({
        messageCid     : cid,
        tenantDid      : did,
        remoteEndpoint : dwnUrl,
        protocol,
        category       : rejection ? 'pull-scope-rejected' : 'pull-processing',
        errorCode      : rejection?.classification,
        errorDetail    : rejection
          ? `pulled message rejected by ${rejection.classification} sync scope gate`
          : 'pull processing failed after retry passes exhausted',
      });
    }
  }

  private async acceptPulledSyncEntry(
    did: string,
    scope: SyncScope,
    entry: SyncMessageEntry,
    entries: SyncMessageEntry[],
  ): Promise<PullAcceptanceResult> {
    if (scope.kind === 'full') {
      return { accepted: true };
    }

    const initialWrite = await this.resolvePulledDeleteInitialWrite(did, entry.message, entries);
    const classification = classifySyncMessageScope({
      message: entry.message,
      initialWrite,
      scope,
    });

    if (classification === 'in-scope') {
      return { accepted: true };
    }

    const messageCid = await getMessageCid(entry.message);
    console.warn(`SyncEngineLevel: refusing to apply ${classification} pulled message ${messageCid}`);
    return { accepted: false, classification };
  }

  private async resolvePulledDeleteInitialWrite(
    did: string,
    message: GenericMessage,
    entries: SyncMessageEntry[],
  ): Promise<RecordsWriteMessage | undefined> {
    const descriptor = message.descriptor as Record<string, unknown>;
    if (
      descriptor.interface !== DwnInterfaceName.Records ||
      descriptor.method !== DwnMethodName.Delete ||
      typeof descriptor.recordId !== 'string'
    ) {
      return undefined;
    }

    if (!this.agent.dwn.isRemoteMode) {
      const localInitialWrite = await RecordsWrite.fetchInitialRecordsWriteMessage(
        this.agent.dwn.node.storage.messageStore,
        did,
        descriptor.recordId,
      );
      if (localInitialWrite) {
        return localInitialWrite;
      }
    }

    // Batch entries are only used when the initial write has not been applied
    // locally yet. They are still parsed as initial RecordsWrite messages, and
    // processRawMessage authenticates the delete before any local mutation
    // occurs.
    return this.findInitialWriteInPullBatch(descriptor.recordId, entries);
  }

  private async findInitialWriteInPullBatch(
    recordId: string,
    entries: SyncMessageEntry[],
  ): Promise<RecordsWriteMessage | undefined> {
    for (const entry of entries) {
      if (entry.message.descriptor.interface !== DwnInterfaceName.Records ||
        entry.message.descriptor.method !== DwnMethodName.Write) {
        continue;
      }

      const candidate = entry.message as RecordsWriteMessage;
      if (candidate.recordId === recordId && await RecordsWrite.isInitialWrite(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Echo-loop suppression
  // ---------------------------------------------------------------------------

  /**
   * Evicts expired entries from the echo-loop suppression cache.
   * Also enforces the size cap by evicting oldest entries first.
   */
  private evictExpiredEchoEntries(): void {
    const now = Date.now();

    // Evict expired entries.
    for (const [cid, expiry] of this._recentlyPulledCids) {
      if (now >= expiry) {
        this._recentlyPulledCids.delete(cid);
      }
    }

    // Enforce size cap by evicting oldest entries.
    if (this._recentlyPulledCids.size > SyncEngineLevel.ECHO_SUPPRESS_MAX_ENTRIES) {
      const excess = this._recentlyPulledCids.size - SyncEngineLevel.ECHO_SUPPRESS_MAX_ENTRIES;
      let evicted = 0;
      for (const key of this._recentlyPulledCids.keys()) {
        if (evicted >= excess) { break; }
        this._recentlyPulledCids.delete(key);
        evicted++;
      }
    }
  }

  /**
   * Checks whether a CID was recently pulled from a specific remote endpoint
   * and should not be pushed back to that same endpoint (echo-loop suppression).
   * Does not suppress pushes to other endpoints — multi-provider fan-out works.
   */
  private isRecentlyPulled(cid: string, dwnUrl: string): boolean {
    const key = `${cid}|${dwnUrl}`;
    const expiry = this._recentlyPulledCids.get(key);
    if (expiry === undefined) { return false; }
    if (Date.now() >= expiry) {
      this._recentlyPulledCids.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Reads missing messages from the local DWN and pushes them to the remote DWN
   * in dependency order (topological sort).
   */
  private async pushMessages({ did, dwnUrl, delegateDid, permissionGrantIds, messageCids }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    permissionGrantIds?: string[];
    messageCids: string[];
  }): Promise<PushResult> {
    return pushMessages({
      did, dwnUrl, delegateDid, permissionGrantIds, messageCids,
      agent: this.agent,
    });
  }

  // ---------------------------------------------------------------------------
  // Dependency-aware topological sort — delegates to sync-topological-sort.ts
  // ---------------------------------------------------------------------------

  /**
   * Delegate to the standalone `topologicalSort` function.
   * Tests call `SyncEngineLevel.topologicalSort(...)` so this static method must remain.
   */
  public static topologicalSort<T extends { message: GenericMessage }>(
    messages: T[]
  ): T[] {
    return topologicalSort(messages);
  }

  // ---------------------------------------------------------------------------
  // Dead letter tracking
  // ---------------------------------------------------------------------------

  /**
   * Clear dead letter entries scoped to a specific sync link. Matches on
   * (tenantDid, remoteEndpoint, protocol) so that repairing protocol A
   * does not erase still-valid failures for protocol B on the same remote.
   * When `protocol` is undefined (full-tenant link), clears entries that
   * also have no protocol.
   */
  private async clearDeadLettersForLink(
    tenantDid: string,
    remoteEndpoint: string,
    protocol?: string,
    options: { categories?: ReadonlySet<DeadLetterCategory> } = {},
  ): Promise<void> {
    const batch: { type: 'del'; key: string }[] = [];
    try {
      for await (const [key, value] of this._deadLetters.iterator()) {
        const entry = JSON.parse(value) as DeadLetterEntry;
        if (entry.tenantDid === tenantDid &&
            entry.remoteEndpoint === remoteEndpoint &&
            entry.protocol === protocol &&
            (options.categories === undefined || options.categories.has(entry.category))) {
          batch.push({ type: 'del', key });
        }
      }
      if (batch.length > 0) {
        await this._deadLetters.batch(batch);
      }
    } catch (error) {
      const e = error as { code?: string };
      if (e.code !== 'LEVEL_DATABASE_NOT_OPEN') { throw error; }
    }
  }

  private async clearRootConvergenceDeadLetters(
    tenantDid: string,
    remoteEndpoint: string,
    protocol?: string,
  ): Promise<void> {
    try {
      await this.clearDeadLettersForLink(tenantDid, remoteEndpoint, protocol, {
        categories: SyncEngineLevel.ROOT_CONVERGENCE_CLEARABLE_DEAD_LETTER_CATEGORIES,
      });
    } catch (error) {
      console.warn(`SyncEngineLevel: Failed to clear root-convergence dead letters for ${tenantDid} -> ${remoteEndpoint}`, error);
    }
  }

  /**
   * Build a compound dead letter key. Different remotes can fail the same CID
   * for different reasons, so the key includes the remote endpoint.
   */
  private static deadLetterKey(messageCid: string, remoteEndpoint?: string): string {
    return remoteEndpoint ? `${messageCid}|${remoteEndpoint}` : messageCid;
  }

  public async recordDeadLetter(params: {
    messageCid : string;
    tenantDid : string;
    remoteEndpoint? : string;
    protocol? : string;
    category : DeadLetterCategory;
    errorCode? : string;
    errorDetail : string;
  }): Promise<void> {
    const entry: DeadLetterEntry = {
      ...params,
      failedAt: new Date().toISOString(),
    };
    const key = SyncEngineLevel.deadLetterKey(params.messageCid, params.remoteEndpoint);
    try {
      await this._deadLetters.put(key, JSON.stringify(entry));
    } catch (error) {
      // Suppress only the expected teardown race — any other error surfaces.
      const e = error as { code?: string };
      if (e.code !== 'LEVEL_DATABASE_NOT_OPEN') {
        throw error;
      }
    }
  }

  public async getFailedMessages(tenantDid?: string): Promise<DeadLetterEntry[]> {
    const entries: DeadLetterEntry[] = [];
    for await (const [, value] of this._deadLetters.iterator()) {
      const entry = JSON.parse(value) as DeadLetterEntry;
      if (!tenantDid || entry.tenantDid === tenantDid) {
        entries.push(entry);
      }
    }
    // Deterministic ordering: newest first so apps see the most recent failures.
    entries.sort((a, b) => lexicographicalCompare(b.failedAt, a.failedAt));
    return entries;
  }

  public async clearFailedMessage(messageCid: string, remoteEndpoint?: string): Promise<boolean> {
    if (remoteEndpoint) {
      // Clear a specific CID + remote pair.
      const key = SyncEngineLevel.deadLetterKey(messageCid, remoteEndpoint);
      try {
        await this._deadLetters.get(key);
        await this._deadLetters.del(key);
        return true;
      } catch (error) {
        const e = error as { code?: string };
        if (e.code === 'LEVEL_NOT_FOUND') { return false; }
        throw error;
      }
    }

    // No remote specified — clear ALL entries for this CID (any remote).
    let found = false;
    const batch: { type: 'del'; key: string }[] = [];
    for await (const [key, value] of this._deadLetters.iterator()) {
      const entry = JSON.parse(value) as DeadLetterEntry;
      if (entry.messageCid === messageCid) {
        batch.push({ type: 'del', key });
        found = true;
      }
    }
    if (batch.length > 0) {
      await this._deadLetters.batch(batch);
    }
    return found;
  }

  public async clearAllFailedMessages(tenantDid?: string): Promise<void> {
    if (!tenantDid) {
      await this._deadLetters.clear();
      return;
    }

    const batch: { type: 'del'; key: string }[] = [];
    for await (const [key, value] of this._deadLetters.iterator()) {
      const entry = JSON.parse(value) as DeadLetterEntry;
      if (entry.tenantDid === tenantDid) {
        batch.push({ type: 'del', key });
      }
    }
    if (batch.length > 0) {
      await this._deadLetters.batch(batch);
    }
  }

  public async getSyncHealth(): Promise<SyncHealthSummary> {
    let failedMessageCount = 0;
    let closureFailureCount = 0;
    for await (const [, value] of this._deadLetters.iterator()) {
      failedMessageCount++;
      const entry = JSON.parse(value) as DeadLetterEntry;
      if (entry.category === 'closure') {
        closureFailureCount++;
      }
    }

    // Superseded authorization epochs can leave durable link state behind. Only
    // links that still belong to the current registered projection/epoch should
    // affect health. Endpoint-level orphan cleanup is a separate GC concern.
    const currentLinkIdentityKeys = await this.getCurrentDurableLinkIdentityKeys();
    let degradedLinkCount = 0;
    const allLinks = await this.ledger.getAllLinks();
    for (const link of allLinks) {
      const isCurrentLink = currentLinkIdentityKeys === undefined || currentLinkIdentityKeys.has(this.getDurableLinkIdentityKey(link));
      if (isCurrentLink && SyncEngineLevel.isUnhealthyLinkStatus(link.status)) {
        degradedLinkCount++;
      }
    }

    return {
      connectivity        : this.connectivityState,
      failedMessageCount  : failedMessageCount,
      closureFailureCount : closureFailureCount,
      degradedLinkCount   : degradedLinkCount,
      syncHealthy         : failedMessageCount === 0 && degradedLinkCount === 0,
    };
  }

  private async getCurrentDurableLinkIdentityKeys(): Promise<Set<string> | undefined> {
    try {
      const identityKeys = new Set<string>();
      for await (const [did, options] of this._db.sublevel('registeredIdentities').iterator()) {
        let parsed: SyncIdentityOptions;
        try {
          parsed = JSON.parse(options) as SyncIdentityOptions;
        } catch (error: unknown) {
          console.warn(`SyncEngineLevel: Corrupt sync options for ${did}, skipping health target:`, error);
          continue;
        }

        const scope = syncScopeFromProtocols(parsed.protocols);
        const resolutions = await this.buildSyncTargetResolutions(did, scope, parsed);
        for (const resolution of resolutions) {
          const projectionId = await computeProjectionId(did, resolution.scope);
          identityKeys.add(SyncEngineLevel.durableLinkIdentityKey(did, projectionId, resolution.authorizationEpoch));
        }
      }
      return identityKeys;
    } catch (error: unknown) {
      console.warn('SyncEngineLevel: Failed to resolve current durable link identity keys for health; falling back to all durable links', error);
      return undefined;
    }
  }

  private getDurableLinkIdentityKey(link: ReplicationLinkState): string {
    return SyncEngineLevel.durableLinkIdentityKey(link.tenantDid, link.projectionId, link.authorizationEpoch);
  }

  private static durableLinkIdentityKey(tenantDid: string, projectionId: string, authorizationEpoch: string): string {
    return `${tenantDid}^${projectionId}^${authorizationEpoch}`;
  }

  private static isUnhealthyLinkStatus(status: ReplicationLinkState['status']): boolean {
    return status === 'repairing' || status === 'degraded_poll' || status === 'terminal_incomplete';
  }

  // ---------------------------------------------------------------------------
  // Sync targets
  // ---------------------------------------------------------------------------

  /**
   * Returns the list of sync targets: one canonical projection target per
   * registered DID and resolved DWN endpoint.
   * Results are cached for up to 30 seconds to avoid redundant DID resolution
   * on every sync tick. The cache is invalidated when identities are registered,
   * unregistered, or updated.
   */
  private async getSyncTargets(): Promise<SyncTarget[]> {
    // Return cached targets if still valid.
    if (this._syncTargetsCache
        && (Date.now() - this._syncTargetsCache.timestamp) < SyncEngineLevel.SYNC_TARGETS_CACHE_TTL_MS) {
      return this._syncTargetsCache.targets;
    }

    // Capture the generation before any async work so we can detect
    // concurrent invalidations (register/unregister/update) that would
    // make our result stale.
    const generationAtStart = this._syncTargetsCacheGeneration;

    const targets: SyncTarget[] = [];
    let hasRegisteredIdentities = false;
    let anyTargetUnavailable = false;

    for await (const [did, options] of this._db.sublevel('registeredIdentities').iterator()) {
      hasRegisteredIdentities = true;
      let parsed: SyncIdentityOptions;
      try {
        parsed = JSON.parse(options) as SyncIdentityOptions;
      } catch (error: unknown) {
        console.warn(`SyncEngineLevel: Corrupt sync options for ${did}, skipping identity:`, error);
        continue;
      }

      const dwnEndpointUrls = await this.agent.dwn.getDwnEndpointUrlsForTarget(did);
      if (dwnEndpointUrls.length === 0) {
        anyTargetUnavailable = true;
        continue;
      }

      for (const dwnUrl of dwnEndpointUrls) {
        try {
          targets.push(...await this.buildSyncTargetsForEndpoint(did, dwnUrl, parsed));
        } catch (error: unknown) {
          anyTargetUnavailable = true;
          console.warn(`SyncEngineLevel: Unable to resolve sync targets for ${did} at ${dwnUrl}, skipping identity endpoint:`, error);
        }
      }
    }

    // Only cache when:
    // - The result is non-empty (empty = transient resolution failure).
    // - All registered identities resolved successfully (partial =
    //   one identity's endpoints or sync authorization failed transiently;
    //   caching would suppress retries for that identity for the full TTL).
    // - The generation hasn't changed (a concurrent register/unregister
    //   invalidated the cache while we were awaiting).
    const isComplete = hasRegisteredIdentities && !anyTargetUnavailable;
    if (targets.length > 0 && isComplete && this._syncTargetsCacheGeneration === generationAtStart) {
      this._syncTargetsCache = { targets, timestamp: Date.now() };
    }
    return targets;
  }

}
