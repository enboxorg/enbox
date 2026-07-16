import type { AbstractLevel } from 'abstract-level';

import type { DwnSubscriptionHandler, ResubscribeFactory } from '@enbox/dwn-clients';
import type { GenericMessage, MessageEvent, MessagesFilter, MessagesQueryReply, MessagesQueryReplyEntry, MessagesSubscribeReply, ProgressToken, ProtocolDefinition, RecordsQueryReply, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import { DwnErrorCode, DwnInterfaceName, DwnMethodName, Encoder, Message } from '@enbox/dwn-sdk-js';
import { parseDurationInMilliseconds, sleep } from '@enbox/common';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { SyncMessageEntry } from './sync-messages.js';
import type {
  DeadLetterCategory,
  DeadLetterEntry,
  DirectionCheckpoint,
  NonEmptyStringArray,
  PushFailure,
  PushResult,
  RemoteSyncState,
  RemoteSyncStatus,
  ReplicationLinkState,
  StartSyncParams,
  SyncAuthorization,
  SyncConnectivityState,
  SyncDrainOptions,
  SyncDrainResult,
  SyncDrainTargetResult,
  SyncEngine,
  SyncEvent,
  SyncEventListener,
  SyncEventScope,
  SyncHealthSummary,
  SyncIdentityOptions,
  SyncMode,
  SyncScope,
} from './types/sync.js';

import { AgentPermissionsApi } from './permissions-api.js';

import { admitClosure } from './sync-admit-closure.js';
import { buildLinkId } from './sync-link-id.js';
import { classifySyncEventScope } from './sync-scope-acceptance.js';
import { DwnInterface } from './types/dwn.js';
import { getProtocolClosureEdges } from './sync-scope-closure.js';
import { isRecordsWrite } from './utils.js';
import { ReplicationLedger } from './sync-replication-ledger.js';
import { computeAuthorizationEpoch, computeProjectionId, isQuotaBlockedPushFailure, isTerminalPushFailure, lexicographicalCompare, protocolsForSyncScope, pushBatchReconcileReason, singleProtocolForSyncScope, syncScopeFromProtocols } from './types/sync.js';
import { fetchRemoteMessages, getLocalMessage, pushMessageEntries, pushMessages, queryLocalMessageFeed, queryRemoteMessageFeed, SyncPullAbortedError } from './sync-messages.js';
import { getMessagesPermissionGrantsForScope, permissionGrantIdsFromEntries, resolveMessagesScopes, SyncProtocolRootPermissionGrantMissingError, toMessagesPermissionGrantIds, toSyncAuthorizationGrants } from './sync-permission-grants.js';

export type SyncEngineLevelParams = {
  agent?: EnboxPlatformAgent;
  dataPath?: string;
  db?: AbstractLevel<string | Buffer | Uint8Array>;
};

/**
 * Debounce window for batching writes that arrive while a push is in flight.
 * The first write in a quiet window triggers an immediate push; subsequent
 * writes arriving during the push are batched and flushed after this delay
 * once the in-flight push completes.
 */
const PUSH_DEBOUNCE_MS = 100;

/** Default durable-feed page size for engine replay. */
const FEED_PAGE_LIMIT = 100;

/** Maximum concurrent live-pull deliveries waiting for earlier ordinals to commit. */
const MAX_IN_FLIGHT_PULL_DELIVERIES = 100;

/** Page size for local retained ProtocolsConfigure history scans. */
const PROTOCOL_HISTORY_PAGE_LIMIT = 500;

/** Tracks a closable per-link subscription (live remote pull or local push). */
type SubscriptionHandle = {
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
  projectionId: string;
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

type SyncDirection = 'push' | 'pull';

type SyncReconcileOptions = {
  direction?: SyncDirection;
  forceQuotaProbe?: boolean;
  verifyConvergence?: boolean;
};

type SyncRunOptions = {
  verifyConvergence?: boolean;
};

type SyncDrainPlan = {
  targets: SyncTarget[];
  failures: SyncDrainTargetResult[];
};

type SyncDrainStopReason = 'cancelled' | 'topology-changed';

type SyncScopeClosureValidationState = {
  requestedProtocols: Set<string>;
  protocolsToScan: string[];
  scannedProtocols: Set<string>;
  missingGrantProtocols: Set<string>;
  nonScopedUsesProtocols: Set<string>;
  splitDependencyEdges: Map<string, Set<string>>;
};

type SyncReconcileResult = {
  aborted?: boolean;
  admittedCids?: string[];
  converged?: boolean;
  hasActionableDiffs?: boolean;
  localFingerprint?: string;
  pushFailures?: PushFailure[];
  quotaBlocked?: boolean;
  remoteFingerprint?: string;
};

type SyncTargetGroupRunResult = {
  dwnUrl: string;
  succeeded: boolean;
};

type SyncTargetGroupSummary = {
  failedUrls: string[];
  groupsFailed: number;
  groupsSucceeded: number;
};

type FeedConvergenceFailureState = {
  attempts: number;
  signature: string;
};

type DeferredPullState = {
  attempts: number;
  detail?: string;
  firstDeferredAt: string;
  lastDeferredAt: string;
};

/**
 * Durable state for a push message the remote rejected for tenant quota. Keyed
 * by the complete replication-link identity plus message CID. The message is
 * skipped in that link's feed push until `nextProbeAt`, then attempted once; a
 * still-quota result extends the backoff. An applied acknowledgement or local
 * retirement clears the entry; a successor/Superseded acknowledgement retains
 * a resolved omission solely to explain intentional inventory differences.
 */
type QuotaBlockState = {
  attempts: number;
  authorizationEpoch: string;
  blockedCid?: string;
  detail?: string;
  linkKey: string;
  messageCid: string;
  protocol?: string;
  projectionId: string;
  remoteEndpoint: string;
  source?: 'feed' | 'permission-grant';
  /** Retained only to explain an intentional per-link feed omission. Never probed or surfaced as blocked. */
  supersededAt?: string;
  tenantDid: string;
  firstBlockedAt: string;
  lastBlockedAt: string;
  nextProbeAt: string;
};

type PushResultTransition = {
  quotaBlocked: boolean;
  retryableFailures: PushFailure[];
  terminalFailures: PushFailure[];
  nextQuotaProbeAt?: string;
};

type FeedPageAdmissionResult =
  | { kind: 'aborted' }
  | { kind: 'deferred'; admittedCids: string[]; detail?: string; hasActionableDiffs: boolean; messageCid: string }
  | { kind: 'processed'; admittedCids: string[]; hasActionableDiffs: boolean };

type TrackedFeedPageAdmissionResult =
  | { kind: 'aborted' }
  | { kind: 'processed'; hasActionableDiffs: boolean };

type FeedCursorAdvanceResult =
  | { drained: true }
  | { cursor: ProgressToken; drained: false };

type FeedPushEntryResult =
  | { kind: 'aborted' }
  | { kind: 'pushed' }
  | { kind: 'skipped' }
  | { kind: 'failed'; failures: PushFailure[] };

type FeedPagePushResult =
  | { kind: 'aborted' }
  | { kind: 'failed'; failures: PushFailure[]; hasActionableDiffs: boolean }
  | { kind: 'processed'; hasActionableDiffs: boolean };

type PermissionGrantBootstrapResult =
  | { kind: 'aborted' }
  | { kind: 'processed'; failures: PushFailure[]; hasActionableDiffs: boolean; quotaBlocked: boolean };

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
  /** The token associated with this delivery. */
  token: ProgressToken;
  /** Whether replicated admission has completed successfully. */
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

type PushRuntimeEntry = { cid: string; lastFailure?: PushFailure };

type PushRuntimeState = {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  protocol?: string;
  scope?: SyncScope;
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

type LivePullProcessResult =
  | { messageCid: string; admitted: false }
  | { messageCid: string; admitted: true; appliedCids: string[] };

type LivePullDataStreamFactory = () => Promise<ReadableStream<Uint8Array> | undefined>;

type LivePullRecordsWriteEvent = MessageEvent & {
  message: GenericMessage & {
    descriptor: GenericMessage['descriptor'] & { dataCid?: string };
  };
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
  private _syncLockCompletion: Promise<void> = Promise.resolve();
  private _releaseSyncLockCompletion?: () => void;

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
  private _liveSubscriptions: SubscriptionHandle[] = [];

  /** Active local EventLog subscriptions for push-on-write (local -> remote). */
  private _localSubscriptions: SubscriptionHandle[] = [];

  /** Connectivity state derived from subscription health. */
  private _connectivityState: SyncConnectivityState = 'unknown';

  /** Registered event listeners for observability. */
  private readonly _eventListeners: Set<SyncEventListener> = new Set();

  /** Per-link push runtime: queue, debounce timer, retry state. */
  private readonly _pushRuntimes: Map<string, PushRuntimeState> = new Map();

  /** In-flight quota probes, keyed by tenant + remote + CID, to deduplicate concurrent retry paths. */
  private readonly _quotaProbeInFlight: Map<string, Promise<void>> = new Map();

  /** Serializes durable-feed checkpoint reads and writes for each complete replication link. */
  private readonly _durableFeedRuns: Map<string, Promise<void>> = new Map();

  /** Serializes public Retry-now operations with each other before they acquire the sync lock. */
  private _retryRemoteQueue: Promise<void> = Promise.resolve();

  /**
   * CIDs recently received via pull subscription, keyed by `cid|dwnUrl` to
   * scope suppression per remote endpoint. A message pulled from Provider A
   * is only suppressed for push back to Provider A — it still fans out to
   * Provider B and C. TTL: 60 seconds. Cap: 10,000 entries.
   */
  private readonly _recentlyPulledCids: Map<string, number> = new Map();

  /** TTL for echo-loop suppression entries (60 seconds). */
  private static readonly ECHO_SUPPRESS_TTL_MS = 60_000;

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

  private async validateSyncScopeClosure(did: string, options: SyncIdentityOptions): Promise<void> {
    const scope = syncScopeFromProtocols(options.protocols);
    if (scope.kind === 'full') {
      return;
    }

    const state = SyncEngineLevel.createScopeClosureValidationState(scope.protocols);
    await this.scanSyncScopeClosure(did, options, state);

    const details = SyncEngineLevel.scopeClosureErrorDetails(options, state);
    if (details.length > 0) {
      throw new Error(`SyncEngineLevel: sync scope closure validation failed for ${did}: ${details.join('; ')}`);
    }
  }

  private static createScopeClosureValidationState(protocols: NonEmptyStringArray): SyncScopeClosureValidationState {
    return {
      requestedProtocols     : new Set(protocols),
      protocolsToScan        : [...protocols],
      scannedProtocols       : new Set(),
      missingGrantProtocols  : new Set(),
      nonScopedUsesProtocols : new Set(),
      splitDependencyEdges   : new Map(),
    };
  }

  private async scanSyncScopeClosure(
    did: string,
    options: SyncIdentityOptions,
    state: SyncScopeClosureValidationState,
  ): Promise<void> {
    while (state.protocolsToScan.length > 0) {
      const protocol = state.protocolsToScan.shift();
      if (protocol === undefined || state.scannedProtocols.has(protocol)) {
        continue;
      }

      await this.scanSyncScopeProtocol(did, options, protocol, state);
    }
  }

  private async scanSyncScopeProtocol(
    did: string,
    options: SyncIdentityOptions,
    protocol: string,
    state: SyncScopeClosureValidationState,
  ): Promise<void> {
    state.scannedProtocols.add(protocol);

    const permissionGrantIds = await this.permissionGrantIdsForClosureProtocol(did, options, protocol);
    if (permissionGrantIds === 'missing') {
      state.missingGrantProtocols.add(protocol);
      return;
    }

    const definitions = await this.fetchLocalProtocolHistory(did, protocol, options.delegateDid, permissionGrantIds);
    for (const definition of definitions) {
      SyncEngineLevel.recordScopeClosureEdges(state, definition);
    }
  }

  private static recordScopeClosureEdges(
    state: SyncScopeClosureValidationState,
    definition: ProtocolDefinition,
  ): void {
    const edges = getProtocolClosureEdges(definition);
    SyncEngineLevel.recordUsesClosureProtocols(state, edges.usesProtocols);
    SyncEngineLevel.recordDependencyClosureProtocols(state, definition.protocol, edges.dependencyProtocols);
  }

  private static recordUsesClosureProtocols(
    state: SyncScopeClosureValidationState,
    protocols: string[],
  ): void {
    for (const protocol of protocols) {
      if (!state.requestedProtocols.has(protocol)) {
        state.nonScopedUsesProtocols.add(protocol);
      }
      SyncEngineLevel.enqueueScopeClosureProtocol(state, protocol);
    }
  }

  private static recordDependencyClosureProtocols(
    state: SyncScopeClosureValidationState,
    sourceProtocol: string,
    protocols: string[],
  ): void {
    for (const protocol of protocols) {
      if (!state.requestedProtocols.has(protocol)) {
        SyncEngineLevel.addProtocolEdge(state.splitDependencyEdges, sourceProtocol, protocol);
      }
      SyncEngineLevel.enqueueScopeClosureProtocol(state, protocol);
    }
  }

  private static enqueueScopeClosureProtocol(state: SyncScopeClosureValidationState, protocol: string): void {
    if (!state.scannedProtocols.has(protocol)) {
      state.protocolsToScan.push(protocol);
    }
  }

  private static scopeClosureErrorDetails(
    options: SyncIdentityOptions,
    state: SyncScopeClosureValidationState,
  ): string[] {
    if (state.missingGrantProtocols.size === 0 && state.splitDependencyEdges.size === 0) {
      return [];
    }

    const details: string[] = [];
    if (state.missingGrantProtocols.size > 0) {
      details.push(
        `delegate ${options.delegateDid} lacks Messages.Read grants for closure protocols: ` +
        SyncEngineLevel.formatStringSet(state.missingGrantProtocols)
      );
    }
    if (state.splitDependencyEdges.size > 0) {
      details.push(`scope splits cross-protocol dependencies: ${SyncEngineLevel.formatProtocolEdges(state.splitDependencyEdges)}`);
    }
    if (state.nonScopedUsesProtocols.size > 0) {
      details.push(`uses protocols outside the sync scope: ${SyncEngineLevel.formatStringSet(state.nonScopedUsesProtocols)}`);
    }

    return details;
  }

  private async permissionGrantIdsForClosureProtocol(
    did: string,
    options: SyncIdentityOptions,
    protocol: string,
  ): Promise<NonEmptyStringArray | undefined | 'missing'> {
    if (options.delegateDid === undefined) {
      return undefined;
    }

    try {
      const grants = await getMessagesPermissionGrantsForScope({
        did,
        delegateDid    : options.delegateDid,
        protocols      : [protocol],
        messageType    : DwnInterface.MessagesQuery,
        permissionsApi : this._permissionsApi,
      });
      return permissionGrantIdsFromEntries(grants);
    } catch (error) {
      if (error instanceof SyncProtocolRootPermissionGrantMissingError) {
        return 'missing';
      }
      throw error;
    }
  }

  private async fetchLocalProtocolHistory(
    did: string,
    protocol: string,
    delegateDid: string | undefined,
    permissionGrantIds: NonEmptyStringArray | undefined,
  ): Promise<ProtocolDefinition[]> {
    const definitions: ProtocolDefinition[] = [];
    let cursor: ProgressToken | undefined;

    for (;;) {
      const { reply } = await this.agent.dwn.processRequest({
        author        : did,
        target        : did,
        messageType   : DwnInterface.MessagesQuery,
        granteeDid    : delegateDid,
        messageParams : {
          cursor,
          filters: [{
            interface : DwnInterfaceName.Protocols,
            method    : DwnMethodName.Configure,
            protocol,
          }],
          limit              : PROTOCOL_HISTORY_PAGE_LIMIT,
          permissionGrantIds : permissionGrantIds,
        },
      });

      if (reply.status.code !== 200) {
        throw new Error(
          `SyncEngineLevel: local protocol history query failed for ${did} / ${protocol}: ${reply.status.code} ${reply.status.detail}`
        );
      }

      for (const entry of reply.entries ?? []) {
        const definition = SyncEngineLevel.protocolDefinitionFromMessage(entry.message);
        if (definition !== undefined) {
          definitions.push(definition);
        }
      }

      if (reply.drained === true) {
        return definitions;
      }
      if (reply.cursor === undefined) {
        throw new Error(`SyncEngineLevel: local protocol history query returned no cursor before drain for ${did} / ${protocol}`);
      }

      cursor = reply.cursor;
    }
  }

  private static protocolDefinitionFromMessage(message: GenericMessage | undefined): ProtocolDefinition | undefined {
    const descriptor = message?.descriptor as { interface?: string; method?: string; definition?: unknown } | undefined;
    if (
      descriptor?.interface !== DwnInterfaceName.Protocols ||
      descriptor.method !== DwnMethodName.Configure ||
      !SyncEngineLevel.isProtocolDefinition(descriptor.definition)
    ) {
      return undefined;
    }

    return descriptor.definition;
  }

  private static isProtocolDefinition(value: unknown): value is ProtocolDefinition {
    return typeof value === 'object' &&
      value !== null &&
      typeof (value as { protocol?: unknown }).protocol === 'string';
  }

  private static addProtocolEdge(edges: Map<string, Set<string>>, from: string, to: string): void {
    let targets = edges.get(from);
    if (targets === undefined) {
      targets = new Set();
      edges.set(from, targets);
    }
    targets.add(to);
  }

  private static formatStringSet(values: Set<string>): string {
    return [...values].sort(lexicographicalCompare).join(', ');
  }

  private static formatProtocolEdges(edges: Map<string, Set<string>>): string {
    return [...edges.entries()]
      .sort(([a], [b]) => lexicographicalCompare(a, b))
      .flatMap(([from, targets]) => [...targets]
        .sort(lexicographicalCompare)
        .map(to => `${from} -> ${to}`))
      .join(', ');
  }

  private async buildSyncTargetsForEndpoint(did: string, dwnUrl: string, options: SyncIdentityOptions): Promise<SyncTarget[]> {
    const requestedScope = syncScopeFromProtocols(options.protocols);
    const resolutions = await this.buildSyncTargetResolutions(did, requestedScope, options);

    return Promise.all(resolutions.map(async (resolution) => ({
      did,
      dwnUrl,
      projectionId: await computeProjectionId(did, resolution.scope),
      ...resolution,
    })));
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

    const resolvedScopes = await resolveMessagesScopes({
      did,
      delegateDid,
      requestedScope,
      messageType    : DwnInterface.MessagesQuery,
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

  /** True only when the most recent uncached target resolution covered every registration. */
  private _syncTargetsLastResolutionComplete = false;

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

  /** Count of consecutive sync failures (for backoff in poll mode). */
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

  /** LevelDB sublevel for pull entries that are temporarily deferred. */
  private get _deferredPulls(): AbstractLevel<string | Buffer | Uint8Array, string, string> {
    return this._db.sublevel('deferredPulls') as unknown as AbstractLevel<string | Buffer | Uint8Array, string, string>;
  }

  /** LevelDB sublevel for push messages deferred because the remote is out of quota. */
  private get _quotaBlocks(): AbstractLevel<string | Buffer | Uint8Array, string, string> {
    return this._db.sublevel('quotaBlocks') as unknown as AbstractLevel<string | Buffer | Uint8Array, string, string>;
  }

  private async clearSyncDb(): Promise<void> {
    const sublevelNames = [
      'deadLetters',
      'deferredPulls',
      'quotaBlocks',
      'registeredIdentities',
      'replicationLinks',
      'syncMetadata',
    ];

    for (const sublevelName of sublevelNames) {
      await this._db.sublevel(sublevelName).clear();
    }
    await this._db.clear();
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
    this.invalidateSyncTargetsCache();
  }

  /**
   * Drop the resolved sync-targets cache so the next tick re-resolves. Any
   * field that gates cache reuse must be reset here, in one place, so the reset
   * cannot drift across the many call sites that mutate sync configuration.
   */
  private invalidateSyncTargetsCache(): void {
    this._syncTargetsCache = undefined;
    this._syncTargetsLastResolutionComplete = false;
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

  private emitReconcileApplied(target: Pick<SyncTarget, 'did' | 'dwnUrl' | 'scope'>, messageCids: string[]): void {
    this.emitEvent({
      type           : 'reconcile:applied',
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      ...syncEventScope(target.scope),
      messageCids,
    });
  }

  public async clear(): Promise<void> {
    this.invalidateSyncTargetsCache();
    await this.teardownLiveSync();
    this._syncMode = undefined;
    await this._permissionsApi.clear();
    await this.clearSyncDb();
  }

  public async close(): Promise<void> {
    this.invalidateSyncTargetsCache();
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

    await this.validateSyncScopeClosure(did, options);
    await registeredIdentities.put(did, JSON.stringify(options));
    this.invalidateSyncTargetsCache();

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
    this.invalidateSyncTargetsCache();
    await this.clearQuotaBlocksForTenant(did);
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

    await this.validateSyncScopeClosure(did, options);
    await registeredIdentities.put(did, JSON.stringify(options));
    this.invalidateSyncTargetsCache();
    // Scope/delegate changes define different replication links. A block from
    // the previous authorization must not suppress the replacement link's
    // first delivery attempt.
    await this.clearQuotaBlocksForTenant(did);

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
  // One-shot sync (durable feed reconciliation)
  // ---------------------------------------------------------------------------

  public async sync(direction?: SyncDirection, options?: SyncRunOptions): Promise<void> {
    if (!this.tryAcquireSyncLock()) {
      throw new Error('SyncEngineLevel: Sync operation is already in progress.');
    }

    try {
      const syncTargets = await this.getSyncTargets();
      const groupSummary = await this.syncTargetGroups(syncTargets, direction, options);
      this.updateConnectivityAfterSync(groupSummary);
      SyncEngineLevel.assertSyncTargetGroupsSucceeded(groupSummary);
    } finally {
      this.releaseSyncLock();
    }
  }

  public async drainTo(endpoint: string, options: SyncDrainOptions = {}): Promise<SyncDrainResult> {
    if (this._syncLock) {
      throw new Error('SyncEngineLevel: Sync operation is already in progress.');
    }

    const normalizedEndpoint = SyncEngineLevel.normalizeDwnEndpoint(endpoint);
    if (options.signal?.aborted === true) {
      return {
        endpoint        : normalizedEndpoint,
        completed       : false,
        cancelled       : true,
        topologyChanged : false,
        targets         : [],
        error           : 'drain aborted',
      };
    }

    if (!this.tryAcquireSyncLock()) {
      throw new Error('SyncEngineLevel: Sync operation is already in progress.');
    }
    try {
      await this.registerSupplementalDwnEndpoint(normalizedEndpoint);
      const topologyGeneration = this._syncTargetsCacheGeneration;
      const getStopReason = (): SyncDrainStopReason | undefined => {
        if (options.signal?.aborted === true) {
          return 'cancelled';
        }
        if (this._syncTargetsCacheGeneration !== topologyGeneration) {
          return 'topology-changed';
        }
      };

      const plan = await this.buildSyncDrainPlan(normalizedEndpoint);
      await this.initializeDrainTargetsForLiveSync(plan.targets, getStopReason);
      const targets = [...plan.failures];

      for (const target of plan.targets) {
        targets.push(await this.drainSyncTarget(target, getStopReason));
      }

      const stopReason = getStopReason();
      const cancelled = stopReason === 'cancelled' || targets.some((target): boolean => target.cancelled);
      const topologyChanged = stopReason === 'topology-changed';
      const completed = targets.length > 0 && !cancelled && !topologyChanged && targets.every((target): boolean => target.completed);
      const error = SyncEngineLevel.drainResultError(targets, stopReason);
      this.updateConnectivityAfterDrain(targets);

      return {
        endpoint: normalizedEndpoint,
        completed,
        cancelled,
        topologyChanged,
        targets,
        ...(error !== undefined ? { error } : {}),
      };
    } finally {
      this.releaseSyncLock();
    }
  }

  private tryAcquireSyncLock(): boolean {
    if (this._syncLock) { return false; }

    this._syncLock = true;
    this._syncLockCompletion = new Promise<void>((resolve) => {
      this._releaseSyncLockCompletion = resolve;
    });
    return true;
  }

  private async waitForAndAcquireSyncLock(): Promise<void> {
    while (!this.tryAcquireSyncLock()) {
      await this._syncLockCompletion;
    }
  }

  private releaseSyncLock(): void {
    this._syncLock = false;
    const release = this._releaseSyncLockCompletion;
    this._releaseSyncLockCompletion = undefined;
    release?.();
  }

  private async buildSyncDrainPlan(remoteEndpoint: string): Promise<SyncDrainPlan> {
    const plan: SyncDrainPlan = {
      failures : [],
      targets  : [],
    };

    for await (const [did, options] of this._db.sublevel('registeredIdentities').iterator()) {
      let parsed: SyncIdentityOptions;
      try {
        parsed = JSON.parse(options) as SyncIdentityOptions;
      } catch (error: unknown) {
        plan.failures.push({
          tenantDid : did,
          remoteEndpoint,
          completed : false,
          cancelled : false,
          converged : false,
          error     : `corrupt sync options: ${SyncEngineLevel.errorMessage(error)}`,
        });
        continue;
      }

      try {
        plan.targets.push(...await this.buildSyncTargetsForEndpoint(did, remoteEndpoint, parsed));
      } catch (error: unknown) {
        plan.failures.push({
          tenantDid : did,
          remoteEndpoint,
          scope     : SyncEngineLevel.syncScopeForDrainFailure(parsed),
          completed : false,
          cancelled : false,
          converged : false,
          error     : SyncEngineLevel.errorMessage(error),
        });
      }
    }

    return plan;
  }

  /**
   * A drain endpoint is a durable handoff target, not only a one-shot URL.
   * When live sync is already running, open the new links before reconciling
   * so writes that race the drain continue to be delivered after parity.
   */
  private async initializeDrainTargetsForLiveSync(
    targets: SyncTarget[],
    getStopReason: () => SyncDrainStopReason | undefined,
  ): Promise<void> {
    if (this._syncMode !== 'live') {
      return;
    }

    for (const target of targets) {
      if (getStopReason() !== undefined) {
        return;
      }

      const link = await this.getOrCreateReplicationLink(target);
      const linkKey = this.getReplicationLinkKey(target, link);
      if (!this._activeLinks.has(linkKey)) {
        await this.initializeLinkTargetWithRetry(target);
      }
    }
  }

  private async drainSyncTarget(
    target: SyncTarget,
    getStopReason: () => SyncDrainStopReason | undefined,
  ): Promise<SyncDrainTargetResult> {
    const stopReasonAtStart = getStopReason();
    if (stopReasonAtStart !== undefined) {
      return SyncEngineLevel.stoppedDrainTarget(target, stopReasonAtStart);
    }

    try {
      const shouldContinue = (): boolean => getStopReason() === undefined;
      const result = await this.syncTargetWithDurableFeeds(
        target,
        { forceQuotaProbe: true, verifyConvergence: true },
        shouldContinue,
      );
      if (result.admittedCids !== undefined && result.admittedCids.length > 0) {
        this.emitReconcileApplied(target, result.admittedCids);
      }

      const pushFailures = result.pushFailures ?? [];
      if (pushFailures.length > 0) {
        await this.recordTerminalSyncPushFailures(target, pushFailures);
      }

      const link = await this.getOrCreateReplicationLink(target);
      let feedHeadChanged = false;
      if (
        link.status !== 'paused' &&
        result.converged === true &&
        pushFailures.length === 0 &&
        getStopReason() === undefined
      ) {
        const stability = await this.verifyFeedConvergence(target, (): boolean => getStopReason() === undefined);
        feedHeadChanged = stability.converged !== true ||
          stability.localFingerprint !== result.localFingerprint ||
          stability.remoteFingerprint !== result.remoteFingerprint;
        result.aborted ||= stability.aborted;
        result.converged = !feedHeadChanged;
        result.localFingerprint = stability.localFingerprint ?? result.localFingerprint;
        result.remoteFingerprint = stability.remoteFingerprint ?? result.remoteFingerprint;
      }

      let divergenceExplained = false;
      if (getStopReason() === undefined) {
        if (result.converged === false && !feedHeadChanged) {
          divergenceExplained = await this.handleVerifiedFeedDivergence(target, result);
        } else if (result.converged === true) {
          await this.clearFeedConvergenceFailure(target);
        }
      }

      const stopReason = getStopReason();
      const quotaBlocked = (await this.getQuotaBlocksForTarget(target)).length > 0;
      if (divergenceExplained && !quotaBlocked) {
        // Resolved per-link omissions are logical convergence: the remote has
        // acknowledged newer state and the intentionally absent history will
        // never be probed again, even though raw fingerprints differ.
        result.converged = true;
      }
      const error = SyncEngineLevel.drainError(result, pushFailures, link.status === 'paused', feedHeadChanged, stopReason);

      return {
        tenantDid         : target.did,
        remoteEndpoint    : target.dwnUrl,
        scope             : target.scope,
        completed         : error === undefined,
        cancelled         : stopReason === 'cancelled',
        converged         : SyncEngineLevel.drainConverged(result, link.status === 'paused', feedHeadChanged, stopReason),
        ...(quotaBlocked ? { quotaBlocked: true } : {}),
        pushCheckpoint    : link.push.contiguousAppliedToken,
        localFingerprint  : result.localFingerprint,
        remoteFingerprint : result.remoteFingerprint,
        ...(error !== undefined ? { error } : {}),
      };
    } catch (error: unknown) {
      const stopReason = getStopReason();
      if (stopReason !== undefined) {
        return SyncEngineLevel.stoppedDrainTarget(target, stopReason);
      }

      return {
        tenantDid      : target.did,
        remoteEndpoint : target.dwnUrl,
        scope          : target.scope,
        completed      : false,
        // Reached only when getStopReason() is undefined (the stop branch above
        // returns first), so this drain ended on a genuine error, not a stop.
        cancelled      : false,
        converged      : false,
        error          : SyncEngineLevel.errorMessage(error),
      };
    }
  }

  private updateConnectivityAfterDrain(targets: SyncDrainTargetResult[]): void {
    if (targets.length === 0) {
      return;
    }

    if (targets.some((target): boolean => target.completed || target.quotaBlocked === true)) {
      this.recordSyncSuccess();
      return;
    }

    this.recordSyncFailure();
  }

  private static drainError(
    result: SyncReconcileResult,
    pushFailures: PushFailure[],
    paused: boolean,
    feedHeadChanged: boolean,
    stopReason: SyncDrainStopReason | undefined,
  ): string | undefined {
    if (stopReason === 'cancelled') {
      return 'drain aborted';
    }
    if (stopReason === 'topology-changed') {
      return 'sync registrations changed during drain; retry required';
    }
    if (paused) {
      return 'replication link is paused';
    }
    if (feedHeadChanged) {
      return 'feed head changed during drain; retry required';
    }
    if (result.aborted === true) {
      return 'drain aborted';
    }
    if (pushFailures.length > 0) {
      return `drain push failed for ${pushFailures.length} message(s)`;
    }
    if (result.converged !== true) {
      return 'feed fingerprints did not converge';
    }
  }

  private static drainConverged(
    result: SyncReconcileResult,
    paused: boolean,
    feedHeadChanged: boolean,
    stopReason: SyncDrainStopReason | undefined,
  ): boolean {
    return result.converged === true && !paused && !feedHeadChanged && stopReason === undefined;
  }

  private static stoppedDrainTarget(target: SyncTarget, stopReason: SyncDrainStopReason): SyncDrainTargetResult {
    return {
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      scope          : target.scope,
      completed      : false,
      cancelled      : stopReason === 'cancelled',
      converged      : false,
      error          : stopReason === 'cancelled'
        ? 'drain aborted'
        : 'sync registrations changed during drain; retry required',
    };
  }

  private static drainResultError(
    targets: SyncDrainTargetResult[],
    stopReason: SyncDrainStopReason | undefined,
  ): string | undefined {
    if (stopReason === 'cancelled') {
      return 'drain aborted';
    }
    if (stopReason === 'topology-changed') {
      return 'sync registrations changed during drain; retry required';
    }
    if (targets.length === 0) {
      return 'drain plan contained no registered sync targets';
    }
  }

  private static syncScopeForDrainFailure(options: SyncIdentityOptions): SyncScope | undefined {
    try {
      return syncScopeFromProtocols(options.protocols);
    } catch {
      return;
    }
  }

  private static normalizeDwnEndpoint(endpoint: string): string {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error('SyncEngineLevel: drain endpoint must be a valid URL.');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('SyncEngineLevel: drain endpoint must use http or https.');
    }

    url.hash = '';
    url.search = '';
    const normalized = url.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  }

  private async registerSupplementalDwnEndpoint(endpoint: string): Promise<void> {
    const metadata = this._db.sublevel('syncMetadata');
    const existing = await this.getSupplementalDwnEndpoint();
    if (existing === endpoint) {
      return;
    }

    await metadata.put('supplementalDwnEndpoint', endpoint);
    this.invalidateSyncTargetsCache();
  }

  private async getSupplementalDwnEndpoint(): Promise<string | undefined> {
    try {
      return await this._db.sublevel('syncMetadata').get('supplementalDwnEndpoint') as string;
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'LEVEL_NOT_FOUND') {
        return;
      }
      throw error;
    }
  }

  private async getSyncEndpointUrls(did: string): Promise<string[]> {
    let supplementalEndpoint = await this.getSupplementalDwnEndpoint();
    const activeLocalEndpoint = this.agent.dwn.localDwnEndpoint;
    if (
      supplementalEndpoint !== undefined
      && this.agent.dwn.isRemoteMode
      && (activeLocalEndpoint === undefined ||
        SyncEngineLevel.normalizeDwnEndpoint(activeLocalEndpoint) === SyncEngineLevel.normalizeDwnEndpoint(supplementalEndpoint))
    ) {
      // After the session-boundary flip, the persisted handoff endpoint is
      // the agent's local side. It must never also be scheduled as a remote
      // replication target, regardless of the configured discovery strategy.
      supplementalEndpoint = undefined;
    }
    let resolvedEndpoints: string[];
    try {
      resolvedEndpoints = await this.agent.dwn.getRemoteDwnEndpointUrls(did);
    } catch (error: unknown) {
      if (supplementalEndpoint === undefined) {
        throw error;
      }
      resolvedEndpoints = [];
    }

    const endpointsByKey = new Map<string, string>();
    for (const endpoint of [supplementalEndpoint, ...resolvedEndpoints]) {
      if (endpoint === undefined) {
        continue;
      }

      let key = endpoint;
      try {
        key = SyncEngineLevel.normalizeDwnEndpoint(endpoint);
      } catch {
        // Endpoint validation still occurs at the transport boundary. This key
        // is only used to avoid duplicating an equivalent supplemental URL.
      }
      if (!endpointsByKey.has(key)) {
        endpointsByKey.set(key, endpoint);
      }
    }

    return [...endpointsByKey.values()];
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async syncTargetGroups(
    syncTargets: SyncTarget[],
    direction: SyncDirection | undefined,
    options: SyncRunOptions | undefined,
  ): Promise<SyncTargetGroupSummary> {
    // Group targets by remote endpoint so each URL group can be reconciled
    // concurrently. Within a group, targets are processed sequentially so
    // that a single network failure skips the rest of that group.
    const byUrl = SyncEngineLevel.groupSyncTargetsByDwnUrl(syncTargets);
    const results = await Promise.allSettled([...byUrl.entries()].map(([dwnUrl, targets]) =>
      this.syncTargetGroupWithUrl(dwnUrl, targets, direction, options)
    ));

    return SyncEngineLevel.summarizeSyncTargetGroupResults(results);
  }

  private static groupSyncTargetsByDwnUrl(syncTargets: SyncTarget[]): Map<string, SyncTarget[]> {
    const byUrl = new Map<string, SyncTarget[]>();
    for (const target of syncTargets) {
      const group = byUrl.get(target.dwnUrl) ?? [];
      group.push(target);
      byUrl.set(target.dwnUrl, group);
    }

    return byUrl;
  }

  private async syncTargetGroupWithUrl(
    dwnUrl: string,
    targets: SyncTarget[],
    direction: SyncDirection | undefined,
    options: SyncRunOptions | undefined,
  ): Promise<SyncTargetGroupRunResult> {
    return {
      dwnUrl,
      succeeded: await this.syncTargetGroup(dwnUrl, targets, direction, options),
    };
  }

  private static summarizeSyncTargetGroupResults(
    results: PromiseSettledResult<SyncTargetGroupRunResult>[]
  ): SyncTargetGroupSummary {
    const summary: SyncTargetGroupSummary = {
      failedUrls      : [],
      groupsFailed    : 0,
      groupsSucceeded : 0,
    };

    for (const result of results) {
      SyncEngineLevel.countSyncTargetGroupResult(summary, result);
    }

    return summary;
  }

  private static countSyncTargetGroupResult(
    summary: SyncTargetGroupSummary,
    result: PromiseSettledResult<SyncTargetGroupRunResult>
  ): void {
    if (result.status === 'rejected') {
      summary.groupsFailed++;
      return;
    }

    if (result.value.succeeded) {
      summary.groupsSucceeded++;
      return;
    }

    summary.groupsFailed++;
    summary.failedUrls.push(result.value.dwnUrl);
  }

  private updateConnectivityAfterSync(summary: SyncTargetGroupSummary): void {
    // If at least one group succeeded, stay online — partial reachability is still online.
    // Every group is counted as exactly one of succeeded/failed, so when there are no
    // groups (no targets) neither fires and connectivity is left unchanged.
    if (summary.groupsSucceeded > 0) {
      this.recordSyncSuccess();
      return;
    }

    if (summary.groupsFailed > 0) {
      this.recordSyncFailure();
    }
  }

  private recordSyncSuccess(): void {
    this._consecutiveFailures = 0;
    this._connectivityState = 'online';
  }

  private recordSyncFailure(): void {
    this._consecutiveFailures++;
    if (this._connectivityState === 'online') {
      this._connectivityState = 'offline';
    }
  }

  private static assertSyncTargetGroupsSucceeded(summary: SyncTargetGroupSummary): void {
    if (summary.groupsFailed === 0) {
      return;
    }

    throw new Error(
      `SyncEngineLevel: Sync operation failed for ${summary.groupsFailed} remote endpoint(s)`
      + (summary.failedUrls.length > 0 ? `: ${summary.failedUrls.join(', ')}` : '.')
    );
  }

  private async syncTargetGroup(
    dwnUrl: string,
    targets: SyncTarget[],
    direction: SyncDirection | undefined,
    options: SyncRunOptions | undefined,
  ): Promise<boolean> {
    for (const target of targets) {
      try {
        await this.syncSingleTarget(target, direction, options);
      } catch (error: any) {
        // Skip remaining targets for this DWN endpoint.
        console.error(`SyncEngineLevel: Error syncing ${target.did} with ${dwnUrl}`, error);
        return false;
      }
    }

    return true;
  }

  private async syncSingleTarget(
    target: SyncTarget,
    direction: SyncDirection | undefined,
    options: SyncRunOptions | undefined,
  ): Promise<void> {
    const result = await this.syncTargetWithDurableFeeds(target, {
      direction,
      verifyConvergence: options?.verifyConvergence,
    });

    if (result.admittedCids !== undefined && result.admittedCids.length > 0) {
      this.emitReconcileApplied(target, result.admittedCids);
    }

    if (result.pushFailures !== undefined && result.pushFailures.length > 0) {
      const retryableFailures = await this.recordTerminalSyncPushFailures(target, result.pushFailures);
      if (retryableFailures > 0) {
        throw new Error(`SyncEngineLevel: reconciliation push failed for ${retryableFailures} retryable message(s).`);
      }
    }

    if (options?.verifyConvergence === true) {
      if (result.converged === false) {
        await this.handleVerifiedFeedDivergence(target, result);
      } else if (result.converged === true) {
        await this.clearFeedConvergenceFailure(target);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // startSync / stopSync
  // ---------------------------------------------------------------------------

  public async startSync(params: StartSyncParams): Promise<void> {
    const mode = params.mode ?? 'poll';
    const intervalStr = params.interval ?? (mode === 'live' ? '5m' : '2m');
    const intervalMilliseconds = parseDurationInMilliseconds(intervalStr);

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

    this.invalidateSyncTargetsCache();
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
        await this.sync(undefined, { verifyConvergence: true });
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
      try {
        await this.sync(undefined, { verifyConvergence: true });
      } catch (error) {
        console.error('SyncEngineLevel: Error during initial poll sync', error);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Live-mode sync
  // ---------------------------------------------------------------------------

  /**
   * Starts live sync:
   * 1. Performs an initial durable feed catch-up.
   * 2. Opens MessagesSubscribe subscriptions to each remote DWN for real-time pull.
   * 3. Subscribes to the local EventLog for push-on-write.
   * 4. Schedules an infrequent durable feed settle check at `interval`.
   */
  private async startLiveSync(intervalMilliseconds: number): Promise<void> {
    // Step 0: Register browser connectivity listeners for instant recovery
    // on network switch, sleep/wake, or tab foregrounding. No-op in Node.
    this.startBrowserConnectivityListeners();

    // Step 1: Initial durable feed catch-up.
    try {
      await this.sync();
    } catch (error) {
      console.error('SyncEngineLevel: Error during initial live-sync catch-up', error);
    }

    // Step 2: Initialize replication links and open live subscriptions.
    // Each target's link initialization is independent — process concurrently.
    const syncTargets = await this.getSyncTargets();
    await Promise.allSettled(syncTargets.map(t => this.initializeLinkTarget(t)));

    // Step 3: Schedule infrequent durable feed settle check.
    const integrityCheck = async (): Promise<void> => {
      if (this._syncLock) {
        return;
      }

      try {
        await this.sync(undefined, { verifyConvergence: true });
      } catch (error) {
        console.error('SyncEngineLevel: Error during durable feed settle check', error);
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
  // Per-link repair orchestration
  // ---------------------------------------------------------------------------

  /** Maximum consecutive repair attempts before the link is paused. */
  private static readonly MAX_REPAIR_ATTEMPTS = 3;

  /** Maximum repeated verified feed mismatches before pausing the link. */
  private static readonly MAX_FEED_CONVERGENCE_ATTEMPTS = 3;

  /** Maximum age for a repeatedly deferred pull entry before it is dead-lettered and skipped. */
  private static readonly DEFERRED_PULL_DEAD_LETTER_AFTER_MS = 24 * 60 * 60 * 1000;

  /** Per-link repair attempt counters. */
  private readonly _repairAttempts: Map<string, number> = new Map();

  /** Per-link active repair promises — prevents concurrent repair for the same link. */
  private readonly _activeRepairs: Map<string, Promise<void>> = new Map();

  /** Per-link retry timers for failed repairs below max attempts. */
  private readonly _repairRetryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Repeated feed fingerprint mismatches explained by durable dead letters. */
  private readonly _feedConvergenceFailures: Map<string, FeedConvergenceFailureState> = new Map();

  /** Backoff schedule for repair retries (milliseconds). */
  private static readonly REPAIR_BACKOFF_MS = [1_000, 3_000, 10_000];

  /**
   * Per-link repair context — stores ProgressGap metadata for use during
   * repair. The `resumeToken` (from `gapInfo.latestAvailable`) is used as
   * the post-repair checkpoint so the reopened subscription replays from
   * a valid boundary instead of starting live-only.
   */
  private readonly _repairContext: Map<string, ProgressToken> = new Map();

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
    if (link.status === 'paused') {
      return;
    }

    await this.setLinkOfflineStatus(link, 'repairing');

    if (options?.resumeToken) {
      this._repairContext.set(linkKey, options.resumeToken);
    }

    // Clear runtime ordinals immediately — stale state must not linger
    // across repair attempts.
    this.clearLinkRuntimeInflight(linkKey);

    // Kick off repair with retry scheduling on failure.
    void this.repairLink(linkKey).catch(() => {
      this.scheduleRepairRetry(linkKey);
    });
  }

  private async transitionToPaused(
    linkKey: string,
    link: ReplicationLinkState,
  ): Promise<void> {
    if (link.status === 'paused') {
      return;
    }

    await this.setLinkOfflineStatus(link, 'paused');

    await this.closeLinkSubscriptions(link);

    this.clearLinkRuntimeInflight(linkKey);

    const retryTimer = this._repairRetryTimers.get(linkKey);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this._repairRetryTimers.delete(linkKey);
    }
    const reconcileTimer = this._reconcileTimers.get(linkKey);
    if (reconcileTimer) {
      clearTimeout(reconcileTimer);
      this._reconcileTimers.delete(linkKey);
      this._reconcileTimerDueAt.delete(linkKey);
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
   * No-op if the link is paused or a retry is already scheduled.
   */
  private scheduleRepairRetry(linkKey: string): void {
    const link = this._activeLinks.get(linkKey);
    if (!link || link.status === 'paused') { return; }
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
        // repairLink handles max attempts by pausing the link internally.
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

      // Close the gap between feed catch-up and the reopened push subscription.
      const link = this._activeLinks.get(linkKey);
      if (link?.status === 'live') {
        this.scheduleLinkReconcile(linkKey, link, 'post-repair-gap', 500);
      }
    });
    this._activeRepairs.set(linkKey, promise);
    return promise;
  }

  /**
   * Internal repair implementation. Replays durable feed entries for a single
   * link, then attempts to re-establish live subscriptions. If repair succeeds,
   * transitions to `live`. If it fails, throws so callers can retry.
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
    // A stale repair callback must not mutate the replacement link's state.
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
      // Step 3: Replay durable feed entries for this link.
      const reconcileOutcome = await this.syncTargetWithDurableFeeds({
        did,
        dwnUrl,
        delegateDid,
        projectionId       : link.projectionId,
        scope,
        authorization,
        authorizationEpoch : link.authorizationEpoch,
        permissionGrantIds : this.getAuthorizationGrantIds(authorization),
      }, undefined, () => this._engineGeneration === generation && !isStaleLink());
      if (reconcileOutcome.aborted) { return; }
      if (this._engineGeneration !== generation || isStaleLink()) { return; }
      const reconcilePushFailures = reconcileOutcome.pushFailures ?? [];
      if (reconcileOutcome.admittedCids !== undefined && reconcileOutcome.admittedCids.length > 0) {
        this.emitEvent({
          type           : 'reconcile:applied',
          tenantDid      : did,
          remoteEndpoint : dwnUrl,
          ...eventScope,
          messageCids    : reconcileOutcome.admittedCids,
        });
      }

      // Step 4: Determine the post-repair pull resume token.
      // - If repair was triggered by ProgressGap, use the stored resumeToken
      //   (from gapInfo.latestAvailable) so the reopened subscription replays
      //   from a valid boundary, closing the race window between feed catch-up and resubscribe.
      // - Otherwise, use the existing contiguousAppliedToken if still valid.
      // The push checkpoint is independent of the pull resume token and remains intact.
      const resumeToken = this._repairContext.get(linkKey) ?? link.pull.contiguousAppliedToken;
      ReplicationLedger.resetCheckpoint(link.pull, resumeToken);
      await this.ledger.saveLink(link);
      if (this._engineGeneration !== generation || isStaleLink()) { return; }

      // Step 5: Reopen subscriptions.
      const target = {
        did,
        dwnUrl,
        delegateDid,
        projectionId       : link.projectionId,
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

      // Note: post-repair reconcile to close the repair-window gap is scheduled
      // by repairLink() AFTER _activeRepairs is cleared.

      // Step 6: Clean up repair context and transition to live.
      this._repairContext.delete(linkKey);
      this._repairAttempts.delete(linkKey);
      const retryTimer = this._repairRetryTimers.get(linkKey);
      if (retryTimer) { clearTimeout(retryTimer); this._repairRetryTimers.delete(linkKey); }
      const prevRepairConnectivity = link.connectivity;
      link.connectivity = 'online';
      await this.ledger.setStatus(link, 'live');
      if (reconcilePushFailures.length > 0) {
        await this.handleReconcilePushFailures(linkKey, link, reconcilePushFailures);
      }

      this.emitEvent({ type: 'repair:completed', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope });
      if (prevRepairConnectivity !== 'online') {
        this.emitEvent({ type: 'link:connectivity-change', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, from: prevRepairConnectivity, to: 'online' });
      }
      this.emitEvent({ type: 'link:status-change', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, from: 'repairing', to: 'live' });

    } catch (error: any) {
      // If teardown occurred during repair or the link was replaced by a
      // hot-remove + re-add, don't retry or terminalize the replacement link.
      if (this._engineGeneration !== generation || isStaleLink()) { return; }

      if (SyncEngineLevel.isTerminalAuthorizationFailure(String(error?.message ?? error))) {
        console.warn(`SyncEngineLevel: sync authorization for ${did} -> ${dwnUrl} was revoked or expired — pausing link (reconnect to resume).`);
        this.emitEvent({ type: 'repair:failed', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, attempt: attempts, error: String(error.message ?? error) });
        await this.transitionToPaused(linkKey, link);
        return;
      }

      console.error(`SyncEngineLevel: Repair failed for ${did} -> ${dwnUrl} (attempt ${attempts})`, error);
      this.emitEvent({ type: 'repair:failed', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, attempt: attempts, error: String(error.message ?? error) });

      if (attempts >= SyncEngineLevel.MAX_REPAIR_ATTEMPTS) {
        console.warn(`SyncEngineLevel: Max repair attempts reached for ${did} -> ${dwnUrl}, pausing link`);
        await this.transitionToPaused(linkKey, link);
        return;
      }

      // Re-throw so callers can handle retry scheduling.
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

      // Kick off an immediate durable feed reconcile to catch up after being offline.
      if (!this._syncLock) {
        this.sync(undefined, { verifyConvergence: true }).catch((err) => {
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
      // sync via durable feed reconciliation detects and repairs any divergence.
      if (!this._syncLock) {
        this.sync(undefined, { verifyConvergence: true }).catch((err) => {
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
    // (repairs, retry timers). Any async work that
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

    // Clear repair state.
    this._repairAttempts.clear();
    this._activeRepairs.clear();
    for (const timer of this._repairRetryTimers.values()) {
      clearTimeout(timer);
    }
    this._repairRetryTimers.clear();
    this._repairContext.clear();
    this._feedConvergenceFailures.clear();

    // Clear reconcile timers and in-flight operations.
    for (const timer of this._reconcileTimers.values()) {
      clearTimeout(timer);
    }
    this._reconcileTimers.clear();
    this._reconcileTimerDueAt.clear();
    this._reconcileInFlight.clear();

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
      if (link.status === 'paused') {
        return this.createActiveLinkInitializationResult(link);
      }

      const subscriptionResult = await this.openLinkSubscriptions({ ...target, linkKey });
      if (subscriptionResult === LinkSubscriptionOpenResult.ReadyForLive) {
        await this.markLinkLive(target, link);
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

  private async markLinkLive(target: SyncTarget, link: ReplicationLinkState): Promise<void> {
    this.emitEvent({
      type           : 'link:status-change',
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      ...syncEventScope(target.scope),
      from           : 'initializing',
      to             : 'live'
    });
    await this.ledger.setStatus(link, 'live');
    const nextProbeAt = await this.getNextQuotaProbeAtForTarget(target);
    if (nextProbeAt !== undefined) {
      this.scheduleQuotaProbeForActiveLink(this.getReplicationLinkKey(target, link), link, nextProbeAt);
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
    const dwnEndpointUrls = await this.getSyncEndpointUrls(did);
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
      if (this.isLinkKeyForDid(key, did)) {
        clearTimeout(timer);
        this._reconcileTimers.delete(key);
        this._reconcileTimerDueAt.delete(key);
      }
    }
    for (const key of this._reconcileInFlight.keys()) {
      if (this.isLinkKeyForDid(key, did)) { this._reconcileInFlight.delete(key); }
    }
    for (const key of this._activeLinks.keys()) {
      if (this.isLinkKeyForDid(key, did)) { this._activeLinks.delete(key); this._linkRuntimes.delete(key); }
    }
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
    const resubscribeFactory: ResubscribeFactory = async () => {
      // On reconnect, resume from the latest durable applied checkpoint, not
      // the transport's last-delivered cursor. The transport may have delivered
      // an event that has not been locally applied yet.
      let effectiveCursor = link?.pull.contiguousAppliedToken ?? cursor;
      if (effectiveCursor && (!effectiveCursor.streamId || !effectiveCursor.epoch || !effectiveCursor.position)) {
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
    return !!(token.streamId && token.epoch && token.position);
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

    this.markPullLinkOnline({ did, dwnUrl, eventScope, link });
  }

  private markPullLinkOnline({ did, dwnUrl, eventScope, link }: {
    did: string;
    dwnUrl: string;
    eventScope: SyncEventScope;
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
  }

  /**
   * Authorization failures that cannot heal by retrying — the link's grant
   * was revoked or expired, so every repair attempt would fail identically.
   * Such links park (`paused`) until a reconnect installs fresh grants.
   */
  private static isTerminalAuthorizationFailure(detail: string | undefined): boolean {
    if (!detail) {
      return false;
    }

    return detail.includes(DwnErrorCode.GrantAuthorizationGrantRevoked) ||
      detail.includes(DwnErrorCode.GrantAuthorizationGrantExpired) ||
      detail.includes(DwnErrorCode.MessagesSubscribeDeliveryAuthorizationFailed);
  }

  private async handleLivePullSubscriptionError(
    { did, dwnUrl, linkKey, link, isStale }: LivePullContext,
    subMessage: Extract<SubscriptionMessage, { type: 'error' }>,
  ): Promise<void> {
    if (SyncEngineLevel.isTerminalAuthorizationFailure(String(subMessage.error.code ?? ''))) {
      console.warn(`SyncEngineLevel: sync authorization for ${did} -> ${dwnUrl} was revoked or expired — pausing link (reconnect to resume).`);
      if (link && !isStale()) {
        await this.transitionToPaused(linkKey, link);
      }
      return;
    }

    console.warn(`SyncEngineLevel: subscription error for ${did} -> ${dwnUrl}: ${subMessage.error.code}`);

    if (link && !isStale()) {
      await this.transitionToRepairing(linkKey, link);
    }
  }

  private async handleLivePullEvent(
    context: LivePullContext,
    subMessage: Extract<SubscriptionMessage, { type: 'event' }>,
  ): Promise<void> {
    if (await this.shouldSkipLivePullEvent(context, subMessage)) {
      return;
    }

    const delivery = this.startPullDelivery(context, subMessage.cursor);
    try {
      const result = await this.processLivePullEvent(context, subMessage);
      if (!result) { return; }

      if (result.admitted) {
        if (context.link === undefined) {
          this.trackRecentlyPulledMessage(result.messageCid, context.dwnUrl);
          await this.clearFailedMessage(result.messageCid, context.dwnUrl);
        } else {
          await this.trackRemoteFeedAppliedCids(result.appliedCids, this.syncTargetFromLink(context.link));
        }
      }
      await this.commitPullDelivery(context, subMessage.cursor, delivery);
    } catch (error: any) {
      await this.handleLivePullProcessingError(context, error);
    }
  }

  private async shouldSkipLivePullEvent(
    { did, dwnUrl, linkKey, link, isStale }: LivePullContext,
    subMessage: Extract<SubscriptionMessage, { type: 'event' }>,
  ): Promise<boolean> {
    // Guard: if the link is not live (e.g., repairing, paused),
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
      runtime.inflight.set(ordinal, { token: cursor, committed: false });
    }
    return { runtime, ordinal };
  }

  private async processLivePullEvent(
    context: LivePullContext,
    subMessage: Extract<SubscriptionMessage, { type: 'event' }>,
  ): Promise<LivePullProcessResult | undefined> {
    const event = subMessage.event;
    const dataStreamFactory = await this.createLivePullDataStreamFactory(context, event);
    const rootCid = await Message.getCid(event.message);
    const prefetched: SyncMessageEntry[] = [{
      message           : event.message,
      dataStreamFactory : dataStreamFactory,
      isLatestBaseState : subMessage.isLatestBaseState,
    }];
    if (event.initialWrite !== undefined) {
      prefetched.push({ message: event.initialWrite, isLatestBaseState: false });
    }

    const outcome = await admitClosure(rootCid, {
      did                : context.did,
      dwnUrl             : context.dwnUrl,
      delegateDid        : context.delegateDid,
      permissionGrantIds : context.permissionGrantIds,
      scope              : context.link?.scope,
      agent              : this.agent,
      permissionsApi     : this._permissionsApi,
      prefetched,
      shouldContinue     : () => !context.isStale(),
    });

    if (context.isStale()) { return undefined; }

    if (outcome.kind === 'admitted') {
      return { messageCid: rootCid, admitted: true, appliedCids: outcome.appliedCids };
    }

    if (outcome.kind === 'failed') {
      await this.recordAdmissionFailure(context, rootCid, event, outcome);
      return { messageCid: rootCid, admitted: false };
    }

    if (context.link !== undefined) {
      this.scheduleLinkReconcile(context.linkKey, context.link, `pull-${outcome.kind}`);
    }
    return { messageCid: rootCid, admitted: false };
  }

  private async recordAdmissionFailure(
    context: LivePullContext,
    rootCid: string,
    event: MessageEvent,
    outcome: { kind: 'failed'; reason: 'invalid' | 'terminal'; detail?: string },
  ): Promise<void> {
    await this.recordDeadLetter({
      messageCid     : rootCid,
      tenantDid      : context.did,
      remoteEndpoint : context.dwnUrl,
      protocol       : (event.message.descriptor as Record<string, unknown>).protocol as string | undefined,
      category       : 'admit-failed',
      errorCode      : outcome.reason,
      errorDetail    : outcome.detail ?? 'replicated message admission failed',
    });
  }

  private async createLivePullDataStreamFactory(
    context: LivePullContext,
    event: MessageEvent,
  ): Promise<LivePullDataStreamFactory> {
    if (!isRecordsWrite(event)) {
      return async () => undefined;
    }

    const recordsWriteEvent = event as LivePullRecordsWriteEvent;
    const { encodedData } = recordsWriteEvent.message;
    if (encodedData) {
      delete recordsWriteEvent.message.encodedData;
      const bytes = Encoder.base64UrlToBytes(encodedData);
      return async () => SyncEngineLevel.dataStreamFromBytes(bytes);
    }

    if (recordsWriteEvent.message.descriptor.dataCid === undefined) {
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

  private static dataStreamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes);
        controller.close();
      }
    });
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

    if (delivery.runtime.inflight.size > MAX_IN_FLIGHT_PULL_DELIVERIES) {
      console.warn(`SyncEngineLevel: Pull in-flight overflow for ${did} -> ${dwnUrl}, transitioning to repairing`);
      await this.transitionToRepairing(linkKey, link);
    }
  }

  private emitPullCheckpointAdvance(link: ReplicationLinkState): void {
    const token = link.pull.contiguousAppliedToken;
    if (token === undefined) {
      return;
    }

    const event: SyncEvent = {
      type           : 'checkpoint:pull-advance',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...syncEventScope(link.scope),
      position       : token.position,
    };

    // Emit after durable save — "advanced" means persisted.
    if (token.messageCid === undefined) {
      this.emitEvent(event);
      return;
    }

    this.emitEvent({ ...event, messageCid: token.messageCid });
  }

  private emitPushCheckpointAdvance(link: ReplicationLinkState): void {
    const token = link.push.contiguousAppliedToken;
    if (token === undefined) {
      return;
    }

    const event: SyncEvent = {
      type           : 'checkpoint:push-advance',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...syncEventScope(link.scope),
      position       : token.position,
    };

    if (token.messageCid === undefined) {
      this.emitEvent(event);
      return;
    }

    this.emitEvent({ ...event, messageCid: token.messageCid });
  }

  private async handleLivePullProcessingError(
    { did, linkKey, link, isStale }: LivePullContext,
    error: any,
  ): Promise<void> {
    if (error instanceof SyncPullAbortedError) {
      return;
    }

    console.error(`SyncEngineLevel: Error processing live-pull event for ${did}`, error);

    // Unexpected exceptions are treated as transient transport/runtime failures,
    // not admission failures. Recording them as `admit-failed` would suppress
    // the root permanently during reconcile.
    if (link && !isStale()) {
      await this.transitionToRepairing(linkKey, link);
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
          this.scheduleLinkReconcile(pushLinkKey, pushLink, 'push-scope-unclassified');
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
        scope              : target.scope,
        permissionGrantIds : target.permissionGrantIds,
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
    const { did, dwnUrl, delegateDid, protocol, scope, permissionGrantIds, retryCount } = pushRuntime;

    try {
      const result = await pushMessages({
        did,
        dwnUrl,
        delegateDid,
        permissionGrantIds,
        messageCids    : pushEntries.map((entry) => entry.cid),
        agent          : this.agent,
        permissionsApi : this._permissionsApi,
      });

      await this.handlePushBatchResult(linkKey, batch, result);
    } catch (error: any) {
      if (isStale()) { return; }
      console.error(`SyncEngineLevel: Push batch failed for ${did} -> ${dwnUrl}`, error);
      await this.requeueOrReconcile(linkKey, {
        did,
        dwnUrl,
        delegateDid,
        protocol,
        scope,
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

    const link = this._activeLinks.get(linkKey);
    if (link === undefined) { return; }
    const target = this.syncTargetFromLink(link);
    const transition = await this.transitionPushResult(target, result, {
      protocol : batch.pushRuntime.protocol,
      source   : 'feed',
    });

    if (transition.nextQuotaProbeAt !== undefined) {
      this.scheduleQuotaProbeForActiveLink(linkKey, link, transition.nextQuotaProbeAt);
    }

    if (transition.retryableFailures.length > 0) {
      await this.requeueFailedPushes(linkKey, batch, transition.retryableFailures);
      return;
    }

    this.cleanupSuccessfulPushRuntime(linkKey, batch.pushRuntime);
  }

  private syncTargetFromLink(link: ReplicationLinkState): SyncTarget {
    return {
      did                : link.tenantDid,
      dwnUrl             : link.remoteEndpoint,
      delegateDid        : link.delegateDid,
      projectionId       : link.projectionId,
      scope              : link.scope,
      authorization      : link.authorization,
      authorizationEpoch : link.authorizationEpoch,
      permissionGrantIds : this.getAuthorizationGrantIds(link.authorization),
    };
  }

  private scheduleQuotaProbeForActiveLink(
    linkKey: string,
    link: ReplicationLinkState,
    nextProbeAt: string,
  ): void {
    const parsed = Date.parse(nextProbeAt);
    const delay = Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : 0;
    this.scheduleLinkReconcile(linkKey, link, 'push-quota-probe', delay);
  }

  private async requeueFailedPushes(linkKey: string, batch: PushFlushBatch, failed: PushFailure[]): Promise<void> {
    if (batch.isStale()) { return; }

    const { did, dwnUrl, delegateDid, protocol, scope, permissionGrantIds, retryCount } = batch.pushRuntime;
    const failedEntries = failed.map((failure) => ({
      cid         : failure.cid,
      lastFailure : failure,
    }));
    await this.requeueOrReconcile(linkKey, {
      did,
      dwnUrl,
      delegateDid,
      protocol,
      scope,
      permissionGrantIds,
      entries    : failedEntries,
      retryCount : retryCount + 1,
    });
  }

  private async handleReconcilePushFailures(linkKey: string, link: ReplicationLinkState, failed: PushFailure[]): Promise<void> {
    await this.requeueOrReconcile(linkKey, {
      did                : link.tenantDid,
      dwnUrl             : link.remoteEndpoint,
      delegateDid        : link.delegateDid,
      protocol           : singleProtocolForSyncScope(link.scope),
      scope              : link.scope,
      permissionGrantIds : this.getAuthorizationGrantIds(link.authorization),
      entries            : failed.map((failure) => ({
        cid         : failure.cid,
        lastFailure : failure,
      })),
      retryCount: 1,
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
  /** Reconcile delay for push failures the hot retry ladder cannot resolve. */
  private static readonly DEFERRED_PUSH_RECONCILE_DELAY_MS = 30_000;

  private async recordTerminalSyncPushFailures(
    target: SyncTarget,
    failures: PushFailure[],
  ): Promise<number> {
    let retryableFailures = 0;
    for (const failure of failures) {
      if (!isTerminalPushFailure(failure)) {
        retryableFailures++;
        continue;
      }

      await this.clearQuotaBlock(target, failure.cid);
      await this.recordDeadLetter({
        messageCid     : failure.cid,
        tenantDid      : target.did,
        remoteEndpoint : target.dwnUrl,
        protocol       : failure.protocol ?? singleProtocolForSyncScope(target.scope),
        category       : 'admit-failed',
        errorCode      : failure.kind ?? 'Invalid',
        errorDetail    : failure.detail ?? 'push rejected during sync reconciliation',
      });
    }

    return retryableFailures;
  }

  /**
   * Re-queues a failed push batch for retry, or schedules a feed check when
   * retries are exhausted. Bounded to prevent infinite retry loops.
   */
  private async requeueOrReconcile(targetKey: string, pending: {
    did: string; dwnUrl: string; delegateDid?: string; protocol?: string;
    scope?: SyncScope;
    permissionGrantIds?: NonEmptyStringArray;
    entries: PushRuntimeEntry[];
    retryCount: number;
  }): Promise<void> {
    const maxRetries = SyncEngineLevel.PUSH_RETRY_BACKOFF_MS.length;
    const pushRuntime = this.getOrCreatePushRuntime(targetKey, pending);
    const link = this._activeLinks.get(targetKey);
    pending = {
      ...pending,
      entries: await this.recordImmediateTerminalPushFailures(targetKey, pending),
    };
    if (pending.entries.length === 0) {
      this.stopPushRuntime(targetKey, pushRuntime);
      this.scheduleLinkReconcileIfActive(targetKey, link, 'push-terminal');
      return;
    }

    const reconcileReason = pushBatchReconcileReason(pending.entries);
    if (reconcileReason !== undefined) {
      this.stopPushRuntime(targetKey, pushRuntime);
      this.scheduleLinkReconcileIfActive(
        targetKey,
        link,
        reconcileReason,
        SyncEngineLevel.DEFERRED_PUSH_RECONCILE_DELAY_MS,
      );
      return;
    }

    if (pending.retryCount >= maxRetries) {
      this.stopPushRuntime(targetKey, pushRuntime);
      this.scheduleLinkReconcileIfActive(targetKey, link, 'push-retry-exhausted');
      return;
    }

    this.schedulePushRetry(targetKey, pushRuntime, pending);
  }

  private async recordImmediateTerminalPushFailures(targetKey: string, pending: {
    did: string;
    dwnUrl: string;
    protocol?: string;
    scope?: SyncScope;
    entries: PushRuntimeEntry[];
  }): Promise<PushRuntimeEntry[]> {
    const retryableEntries: PushRuntimeEntry[] = [];
    for (const entry of pending.entries) {
      const failure = entry.lastFailure;
      if (failure === undefined || !isTerminalPushFailure(failure)) {
        retryableEntries.push(entry);
        continue;
      }

      await this.clearQuotaBlockByLinkKey(pending.did, targetKey, entry.cid);
      await this.recordDeadLetter({
        messageCid     : entry.cid,
        tenantDid      : pending.did,
        remoteEndpoint : pending.dwnUrl,
        protocol       : pending.protocol,
        category       : 'admit-failed',
        errorCode      : failure.kind ?? 'Invalid',
        errorDetail    : failure.detail ?? 'terminal push failure',
      });
    }
    return retryableEntries;
  }

  private async handleVerifiedFeedDivergence(target: SyncTarget, result: SyncReconcileResult, active?: {
    link: ReplicationLinkState;
    linkKey: string;
  }): Promise<boolean> {
    if (await this.isFeedDivergenceExplainedByQuotaBlocks(target, result)) {
      await this.clearFeedConvergenceFailure(target, active);
      const nextProbeAt = await this.getNextQuotaProbeAtForTarget(target);
      if (nextProbeAt !== undefined) {
        const ledgerLink = active?.link ?? await this.getOrCreateReplicationLink(target);
        const linkKey = active?.linkKey ?? this.getReplicationLinkKey(target, ledgerLink);
        const liveLink = this._activeLinks.get(linkKey);
        if (liveLink?.status === 'live') {
          this.scheduleQuotaProbeForActiveLink(linkKey, liveLink, nextProbeAt);
        }
      }
      return true;
    }

    const deadLetterCids = await this.getAdmissionDeadLetterCidsForTarget(target);
    await this.handleRepeatedFeedConvergenceMismatch(target, result, deadLetterCids, active);
    return false;
  }

  private async clearFeedConvergenceFailure(target: SyncTarget, active?: {
    link: ReplicationLinkState;
    linkKey: string;
  }): Promise<void> {
    if (active !== undefined) {
      this._feedConvergenceFailures.delete(active.linkKey);
      return;
    }

    const link = await this.getOrCreateReplicationLink(target);
    this._feedConvergenceFailures.delete(this.getReplicationLinkKey(target, link));
  }

  private async handleRepeatedFeedConvergenceMismatch(
    target: SyncTarget,
    result: SyncReconcileResult,
    deadLetterCids: string[],
    active?: {
      link: ReplicationLinkState;
      linkKey: string;
    },
  ): Promise<void> {
    const ledgerLink = active?.link ?? await this.getOrCreateReplicationLink(target);
    const linkKey = active?.linkKey ?? this.getReplicationLinkKey(target, ledgerLink);
    const activeLink = this._activeLinks.get(linkKey);
    if (activeLink !== undefined && activeLink !== ledgerLink) {
      activeLink.pull = ledgerLink.pull;
      activeLink.push = ledgerLink.push;
    }
    const link = activeLink ?? ledgerLink;
    const signature = SyncEngineLevel.feedConvergenceFailureSignature(result, deadLetterCids);
    const previous = this._feedConvergenceFailures.get(linkKey);
    const attempts = previous?.signature === signature ? previous.attempts + 1 : 1;

    this._feedConvergenceFailures.set(linkKey, { attempts, signature });

    if (attempts >= SyncEngineLevel.MAX_FEED_CONVERGENCE_ATTEMPTS) {
      await this.transitionToPaused(linkKey, link);
      return;
    }

    await this.handleFeedConvergenceMismatch(target, 'feed-fingerprint-mismatch', { link, linkKey });
  }

  private async getAdmissionDeadLetterCidsForTarget(target: SyncTarget): Promise<string[]> {
    const messageCids = new Set<string>();
    for await (const [, value] of this._deadLetters.iterator(SyncEngineLevel.tenantKeyRange(target.did))) {
      const entry = JSON.parse(value) as DeadLetterEntry;
      if (
        entry.tenantDid === target.did &&
        entry.remoteEndpoint === target.dwnUrl &&
        entry.category === 'admit-failed' &&
        SyncEngineLevel.deadLetterMatchesTarget(entry, target.scope)
      ) {
        messageCids.add(entry.messageCid);
      }
    }

    return [...messageCids].sort((a, b) => a.localeCompare(b));
  }

  /**
   * LevelDB range that selects every key beginning with `${tenantDid}|`. Both
   * the dead-letter and quota-block sublevels prefix their compound keys with
   * the tenant DID, so this scheme-neutral range enumerates either one per
   * tenant. The tenant DID never contains `|`, so the range is exact.
   */
  private static tenantKeyRange(tenantDid: string): { gte: string; lte: string } {
    return {
      gte : `${tenantDid}|`,
      lte : `${tenantDid}|\xff`,
    };
  }

  private static deadLetterMatchesTarget(entry: DeadLetterEntry, scope: SyncScope): boolean {
    if (scope.kind === 'full') {
      return true;
    }

    return entry.protocol === undefined || scope.protocols.includes(entry.protocol);
  }

  private static feedConvergenceFailureSignature(result: SyncReconcileResult, deadLetterCids: string[]): string {
    return JSON.stringify({
      deadLetterCids,
      localFingerprint  : result.localFingerprint,
      remoteFingerprint : result.remoteFingerprint,
    });
  }

  private async handleFeedConvergenceMismatch(target: SyncTarget, reason: string, active?: {
    link: ReplicationLinkState;
    linkKey: string;
  }): Promise<void> {
    const ledgerLink = active?.link ?? await this.getOrCreateReplicationLink(target);
    const linkKey = active?.linkKey ?? this.getReplicationLinkKey(target, ledgerLink);
    const activeLink = this._activeLinks.get(linkKey);
    const link = activeLink ?? ledgerLink;

    ReplicationLedger.resetCheckpoint(link.pull);
    ReplicationLedger.resetCheckpoint(link.push);
    await this.ledger.saveLink(link);

    if (activeLink?.status === 'live') {
      this.scheduleLinkReconcile(linkKey, activeLink, reason, 0);
    }
  }

  private stopPushRuntime(targetKey: string, pushRuntime: PushRuntimeState): void {
    if (pushRuntime.timer) {
      clearTimeout(pushRuntime.timer);
    }
    this._pushRuntimes.delete(targetKey);
  }

  private scheduleLinkReconcileIfActive(
    linkKey: string,
    link: ReplicationLinkState | undefined,
    reason: string,
    delayMs?: number,
  ): void {
    if (link === undefined) {
      return;
    }

    this.scheduleLinkReconcile(linkKey, link, reason, delayMs);
  }

  private schedulePushRetry(targetKey: string, pushRuntime: PushRuntimeState, pending: {
    entries: PushRuntimeEntry[];
    retryCount: number;
  }): void {
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

  private scheduleLinkReconcile(linkKey: string, link: ReplicationLinkState, reason: string, delayMs?: number): void {
    if (link.status !== 'live') {
      return;
    }

    if (this.scheduleReconcile(linkKey, delayMs)) {
      this.emitEvent({
        type           : 'reconcile:needed',
        tenantDid      : link.tenantDid,
        remoteEndpoint : link.remoteEndpoint,
        ...syncEventScope(link.scope),
        reason,
      });
    }
  }

  private getAuthorizationGrantIds(authorization: SyncAuthorization): NonEmptyStringArray | undefined {
    return authorization.kind === 'delegate' ? authorization.permissionGrantIds : undefined;
  }

  private async syncTargetWithDurableFeeds(
    target: SyncTarget,
    options?: SyncReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    const { linkKey } = this.quotaBlockIdentity(target);
    const previous = this._durableFeedRuns.get(linkKey) ?? Promise.resolve();
    const run = previous.catch((): void => {
      // A failed predecessor must not poison this link's queue.
    }).then(async (): Promise<SyncReconcileResult> => {
      if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
        return { ...SyncEngineLevel.emptySyncReconcileResult(options), aborted: true };
      }
      return this.doSyncTargetWithDurableFeeds(target, options, shouldContinue);
    });
    const settled = run.then((): void => {}, (): void => {});
    this._durableFeedRuns.set(linkKey, settled);

    try {
      return await run;
    } finally {
      if (this._durableFeedRuns.get(linkKey) === settled) {
        this._durableFeedRuns.delete(linkKey);
      }
    }
  }

  private async doSyncTargetWithDurableFeeds(
    target: SyncTarget,
    options?: SyncReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    const result = SyncEngineLevel.emptySyncReconcileResult(options);
    const link = await this.getOrCreateReplicationLink(target);
    if (link.status === 'paused') {
      return result;
    }

    const feedPullResult = await this.pullRemoteFeedForSyncTarget(target, options, shouldContinue);
    SyncEngineLevel.mergeSyncReconcileResult(result, feedPullResult, options);
    if (SyncEngineLevel.shouldStopAfterFeedResult(result, feedPullResult)) {
      return result;
    }
    if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
      return { ...result, aborted: true };
    }

    const feedPushResult = await this.pushLocalFeedForSyncTarget(target, options, shouldContinue);
    SyncEngineLevel.mergeSyncReconcileResult(result, feedPushResult, options);
    if (SyncEngineLevel.shouldStopAfterFeedResult(result, feedPushResult)) {
      return result;
    }
    if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
      return { ...result, aborted: true };
    }

    if (options?.verifyConvergence === true) {
      const convergence = await this.verifyFeedConvergence(target, shouldContinue);
      SyncEngineLevel.mergeSyncReconcileResult(result, convergence, options);
    }
    return result;
  }

  private static emptySyncReconcileResult(options?: SyncReconcileOptions): SyncReconcileResult {
    return {
      admittedCids       : [],
      ...(options?.verifyConvergence === true ? { converged: true } : {}),
      hasActionableDiffs : false,
      pushFailures       : [],
    };
  }

  private static mergeSyncReconcileResult(
    target: SyncReconcileResult,
    source: SyncReconcileResult,
    options?: SyncReconcileOptions,
  ): void {
    target.aborted ||= source.aborted;
    target.admittedCids?.push(...(source.admittedCids ?? []));
    target.pushFailures?.push(...(source.pushFailures ?? []));
    target.hasActionableDiffs ||= source.hasActionableDiffs === true;
    target.quotaBlocked ||= source.quotaBlocked === true;
    target.localFingerprint = source.localFingerprint ?? target.localFingerprint;
    target.remoteFingerprint = source.remoteFingerprint ?? target.remoteFingerprint;

    if (
      options?.verifyConvergence === true &&
      (source.converged === false || source.quotaBlocked === true || (source.pushFailures?.length ?? 0) > 0)
    ) {
      target.converged = false;
    }
  }

  private static feedFingerprintsConverged(result: SyncReconcileResult): boolean {
    if ((result.pushFailures?.length ?? 0) > 0) {
      return false;
    }

    return result.localFingerprint !== undefined &&
      result.remoteFingerprint !== undefined &&
      result.localFingerprint === result.remoteFingerprint;
  }

  private async verifyFeedConvergence(
    target: SyncTarget,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
      return { aborted: true };
    }

    const filters = SyncEngineLevel.messageFeedFiltersForScope(target.scope);
    const [localReply, remoteReply] = await Promise.all([
      queryLocalMessageFeed({
        did                : target.did,
        delegateDid        : target.delegateDid,
        permissionGrantIds : target.permissionGrantIds,
        filters,
        cidsOnly           : true,
        limit              : 1,
        agent              : this.agent,
      }),
      queryRemoteMessageFeed({
        did                : target.did,
        dwnUrl             : target.dwnUrl,
        delegateDid        : target.delegateDid,
        permissionGrantIds : target.permissionGrantIds,
        filters,
        cidsOnly           : true,
        limit              : 1,
        agent              : this.agent,
      }),
    ]);

    if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
      return { aborted: true };
    }

    SyncEngineLevel.assertFeedPushSucceeded(localReply, target);
    SyncEngineLevel.assertFeedPullSucceeded(remoteReply, target);

    const result: SyncReconcileResult = {
      localFingerprint  : localReply.fingerprint,
      remoteFingerprint : remoteReply.fingerprint,
      pushFailures      : [],
    };
    const converged = SyncEngineLevel.feedFingerprintsConverged(result);
    if (converged) {
      // Exact equality means every locally retained resolved CID is now present
      // remotely (or has retired from both feeds), so its explanatory row is no
      // longer needed.
      await this.clearResolvedQuotaOmissionsForTarget(target);
    }
    return { ...result, converged };
  }

  private static shouldStopAfterFeedResult(
    accumulator: SyncReconcileResult,
    latest: SyncReconcileResult,
  ): boolean {
    return latest.aborted === true || latest.quotaBlocked === true || (accumulator.pushFailures?.length ?? 0) > 0;
  }

  private async pullRemoteFeedForSyncTarget(
    target: SyncTarget,
    options?: SyncReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    if (options?.direction === 'push') {
      return {};
    }

    const link = await this.getOrCreateReplicationLink(target);
    return this.pullRemoteFeedPages(target, link, shouldContinue);
  }

  private async pullRemoteFeedPages(
    target: SyncTarget,
    link: ReplicationLinkState,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    if (link.pull.contiguousAppliedToken === undefined) {
      const result = await this.pullRemoteFeedDiffWhenUseful(target, link, shouldContinue);
      if (result !== undefined) {
        return result;
      }
    }

    const admittedCids: string[] = [];
    let hasActionableDiffs = false;
    let cursor: ProgressToken | undefined = link.pull.contiguousAppliedToken;
    let resetAfterProgressGap = false;

    while (true) {
      if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
        return { aborted: true };
      }

      const reply = await queryRemoteMessageFeed({
        did                : target.did,
        dwnUrl             : target.dwnUrl,
        delegateDid        : target.delegateDid,
        permissionGrantIds : target.permissionGrantIds,
        filters            : SyncEngineLevel.messageFeedFiltersForScope(target.scope),
        cursor,
        limit              : FEED_PAGE_LIMIT,
        agent              : this.agent,
      });

      if (await this.resetFeedPullAfterProgressGap(reply, link, resetAfterProgressGap)) {
        resetAfterProgressGap = true;
        cursor = undefined;
        const result = await this.pullRemoteFeedDiffWhenUseful(target, link, shouldContinue);
        if (result !== undefined) {
          return result;
        }
        continue;
      }

      SyncEngineLevel.assertFeedPullSucceeded(reply, target);
      const pageResult = await this.admitRemoteFeedPageAndTrack({
        target         : target,
        entries        : reply.entries ?? [],
        admittedCids   : admittedCids,
        shouldContinue : shouldContinue,
      });
      if (pageResult.kind === 'aborted') {
        return { aborted: true };
      }

      hasActionableDiffs ||= pageResult.hasActionableDiffs;

      const cursorAdvance = await this.advanceFeedPullCursor(link, cursor, reply, target);
      if (cursorAdvance.drained) {
        return { admittedCids, hasActionableDiffs, remoteFingerprint: reply.fingerprint };
      }

      cursor = cursorAdvance.cursor;
    }
  }

  private async pullRemoteFeedDiffPages(
    target: SyncTarget,
    link: ReplicationLinkState,
    localCids: Set<string>,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    const admittedCids: string[] = [];
    let hasActionableDiffs = false;
    let cursor: ProgressToken | undefined;
    let resetAfterProgressGap = false;

    while (true) {
      if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
        return { aborted: true };
      }

      const reply = await this.queryFeedCidsPage(target, 'remote', cursor);

      if (await this.resetFeedPullAfterProgressGap(reply, link, resetAfterProgressGap)) {
        resetAfterProgressGap = true;
        cursor = undefined;
        continue;
      }

      SyncEngineLevel.assertFeedPullSucceeded(reply, target);
      const missingEntries = SyncEngineLevel.feedEntriesMissingFrom(localCids, reply.entries ?? []);
      const pageResult = await this.admitRemoteFeedPageAndTrack({
        target         : target,
        entries        : missingEntries,
        admittedCids   : admittedCids,
        knownCids      : localCids,
        shouldContinue : shouldContinue,
      });
      if (pageResult.kind === 'aborted') {
        return { aborted: true };
      }

      hasActionableDiffs ||= pageResult.hasActionableDiffs;

      const cursorAdvance = await this.advanceFeedPullCursor(link, cursor, reply, target);
      if (cursorAdvance.drained) {
        return { admittedCids, hasActionableDiffs, remoteFingerprint: reply.fingerprint };
      }

      cursor = cursorAdvance.cursor;
    }
  }

  private async pushLocalFeedForSyncTarget(
    target: SyncTarget,
    options?: SyncReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    if (options?.direction === 'pull') {
      return {};
    }

    const forceQuotaProbe = options?.forceQuotaProbe === true;
    const forceProbeCids = forceQuotaProbe
      ? new Set((await this.getQuotaBlocksForTarget(target)).map(({ messageCid }) => messageCid))
      : undefined;
    const link = await this.getOrCreateReplicationLink(target);
    const result = await this.pushLocalFeedPages(
      target,
      link,
      shouldContinue,
      forceQuotaProbe,
    );

    // Feed checkpoints intentionally advance past quota-blocked roots so one
    // oversized record cannot hold newer records (or other remotes) behind it.
    // Process later feed state first: an update/delete may replay a retained
    // dataless ancestor as its dependency. Only then probe remaining roots
    // independently of the advanced checkpoint.
    if (
      result.aborted !== true &&
      result.quotaBlocked !== true &&
      (result.pushFailures?.length ?? 0) === 0
    ) {
      await this.probeQuotaBlocksForTarget(target, forceQuotaProbe, forceProbeCids, shouldContinue);
    }

    return result;
  }

  private async pushLocalFeedPages(
    target: SyncTarget,
    link: ReplicationLinkState,
    shouldContinue?: () => boolean,
    forceQuotaProbe = false,
  ): Promise<SyncReconcileResult> {
    if (link.push.contiguousAppliedToken === undefined) {
      return this.pushLocalFeedDiffWithRemoteInventory(target, link, shouldContinue, forceQuotaProbe);
    }

    let hasActionableDiffs = false;
    let cursor: ProgressToken | undefined = link.push.contiguousAppliedToken;

    while (true) {
      if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
        return { aborted: true };
      }

      const reply = await queryLocalMessageFeed({
        did                : target.did,
        delegateDid        : target.delegateDid,
        permissionGrantIds : target.permissionGrantIds,
        filters            : SyncEngineLevel.messageFeedFiltersForScope(target.scope),
        cursor,
        limit              : FEED_PAGE_LIMIT,
        agent              : this.agent,
      });

      if (await this.resetFeedPushAfterProgressGap(reply, link, false)) {
        return this.pushLocalFeedDiffWithRemoteInventory(target, link, shouldContinue, forceQuotaProbe);
      }

      SyncEngineLevel.assertFeedPushSucceeded(reply, target);
      const pageResult = await this.pushLocalFeedPage(target, reply.entries ?? [], shouldContinue);
      if (pageResult.kind === 'aborted') {
        return { aborted: true };
      }

      hasActionableDiffs ||= pageResult.hasActionableDiffs;
      if (pageResult.kind === 'failed') {
        return { hasActionableDiffs, pushFailures: pageResult.failures };
      }

      const cursorAdvance = await this.advanceFeedPushCursor(link, cursor, reply, target);
      if (cursorAdvance.drained) {
        return { hasActionableDiffs, localFingerprint: reply.fingerprint, pushFailures: [] };
      }

      cursor = cursorAdvance.cursor;
    }
  }

  private async pullRemoteFeedDiffWhenUseful(
    target: SyncTarget,
    link: ReplicationLinkState,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult | undefined> {
    const localCids = await this.collectLocalFeedCids(target, shouldContinue);
    if (localCids === undefined) {
      return { aborted: true };
    }
    if (localCids.size === 0) {
      return undefined;
    }

    return this.pullRemoteFeedDiffPages(target, link, localCids, shouldContinue);
  }

  private async pushLocalFeedDiffWithRemoteInventory(
    target: SyncTarget,
    link: ReplicationLinkState,
    shouldContinue?: () => boolean,
    forceQuotaProbe = false,
  ): Promise<SyncReconcileResult> {
    const grantBootstrap = await this.bootstrapRemotePermissionGrants(target, shouldContinue, forceQuotaProbe);
    if (grantBootstrap.kind === 'aborted') {
      return { aborted: true };
    }
    if (grantBootstrap.quotaBlocked) {
      return { hasActionableDiffs: grantBootstrap.hasActionableDiffs, pushFailures: [], quotaBlocked: true };
    }
    if (grantBootstrap.failures.length > 0) {
      return { hasActionableDiffs: grantBootstrap.hasActionableDiffs, pushFailures: grantBootstrap.failures };
    }

    const remoteCids = await this.collectRemoteFeedCids(target, shouldContinue);
    if (remoteCids === undefined) {
      return { aborted: true };
    }

    const result = await this.pushLocalFeedDiffPages(target, link, remoteCids, shouldContinue);
    if (result.aborted === true) {
      return result;
    }

    return { ...result, hasActionableDiffs: result.hasActionableDiffs === true || grantBootstrap.hasActionableDiffs };
  }

  private async pushLocalFeedDiffPages(
    target: SyncTarget,
    link: ReplicationLinkState,
    remoteCids: Set<string>,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    let hasActionableDiffs = false;
    let cursor: ProgressToken | undefined;
    let resetAfterProgressGap = false;

    while (true) {
      if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
        return { aborted: true };
      }

      const reply = await this.queryFeedCidsPage(target, 'local', cursor);

      if (await this.resetFeedPushAfterProgressGap(reply, link, resetAfterProgressGap)) {
        resetAfterProgressGap = true;
        cursor = undefined;
        continue;
      }

      SyncEngineLevel.assertFeedPushSucceeded(reply, target);
      const missingEntries = SyncEngineLevel.feedEntriesMissingFrom(remoteCids, reply.entries ?? []);
      const pageResult = await this.pushLocalFeedPage(target, missingEntries, shouldContinue);
      if (pageResult.kind === 'aborted') {
        return { aborted: true };
      }

      hasActionableDiffs ||= pageResult.hasActionableDiffs;
      if (pageResult.kind === 'failed') {
        return { hasActionableDiffs, pushFailures: pageResult.failures };
      }
      for (const entry of missingEntries) {
        remoteCids.add(entry.messageCid);
      }

      const cursorAdvance = await this.advanceFeedPushCursor(link, cursor, reply, target);
      if (cursorAdvance.drained) {
        return { hasActionableDiffs, localFingerprint: reply.fingerprint, pushFailures: [] };
      }

      cursor = cursorAdvance.cursor;
    }
  }

  private async bootstrapRemotePermissionGrants(
    target: SyncTarget,
    shouldContinue?: () => boolean,
    forceQuotaProbe = false,
  ): Promise<PermissionGrantBootstrapResult> {
    if (target.permissionGrantIds === undefined) {
      return { kind: 'processed', failures: [], hasActionableDiffs: false, quotaBlocked: false };
    }

    const grantEntries = await this.localPermissionGrantBootstrapEntries(target, shouldContinue);
    if (grantEntries === undefined) {
      return { kind: 'aborted' };
    }
    if (grantEntries.failures.length > 0 || grantEntries.entries.length === 0) {
      return { kind: 'processed', failures: grantEntries.failures, hasActionableDiffs: false, quotaBlocked: false };
    }

    for (const entry of grantEntries.entries) {
      const messageCid = await Message.getCid(entry.message);
      const state = await this.getQuotaBlockState(target, messageCid);
      if (state?.source !== 'permission-grant') { continue; }
      const nextProbeAt = Date.parse(state.nextProbeAt);
      if (!forceQuotaProbe && Number.isFinite(nextProbeAt) && Date.now() < nextProbeAt) {
        return { kind: 'processed', failures: [], hasActionableDiffs: false, quotaBlocked: true };
      }
    }

    const result = await this.pushMessageEntries({
      did                : target.did,
      dwnUrl             : target.dwnUrl,
      delegateDid        : target.delegateDid,
      permissionGrantIds : target.permissionGrantIds,
      entries            : grantEntries.entries,
    });
    if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
      return { kind: 'aborted' };
    }
    const transition = await this.transitionPushResult(target, result, { source: 'permission-grant' });
    return {
      kind               : 'processed',
      failures           : [...transition.retryableFailures, ...transition.terminalFailures],
      hasActionableDiffs : result.succeeded.length > 0,
      quotaBlocked       : transition.quotaBlocked,
    };
  }

  private async localPermissionGrantBootstrapEntries(
    target: SyncTarget,
    shouldContinue?: () => boolean,
  ): Promise<{ failures: PushFailure[]; entries: SyncMessageEntry[] } | undefined> {
    const entriesByCid = new Map<string, SyncMessageEntry>();
    const failures: PushFailure[] = [];

    for (const permissionGrantId of target.permissionGrantIds ?? []) {
      if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
        return undefined;
      }

      const entries = await this.localPermissionGrantEntries(target, permissionGrantId);
      if (entries.length === 0) {
        failures.push({
          cid    : permissionGrantId,
          detail : `local permission grant ${permissionGrantId} not found for delegated sync`,
        });
        continue;
      }

      for (const entry of entries) {
        entriesByCid.set(await Message.getCid(entry.message), entry);
      }
    }

    return { failures, entries: [...entriesByCid.values()] };
  }

  private async localPermissionGrantEntries(target: SyncTarget, permissionGrantId: string): Promise<SyncMessageEntry[]> {
    if (target.delegateDid === undefined) {
      return this.queryLocalPermissionGrantEntries(target, permissionGrantId, target.did);
    }

    const delegateEntries = await this.queryLocalPermissionGrantEntries(
      target,
      permissionGrantId,
      target.delegateDid,
      target.delegateDid,
    );
    if (delegateEntries.length > 0) {
      return delegateEntries;
    }

    return this.queryLocalPermissionGrantEntries(target, permissionGrantId, target.delegateDid, target.did);
  }

  private async queryLocalPermissionGrantEntries(
    target: SyncTarget,
    permissionGrantId: string,
    author: string,
    tenantDid = target.did,
  ): Promise<SyncMessageEntry[]> {
    const { reply } = await this.agent.dwn.processRequest({
      author,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { recordId: permissionGrantId } },
    });
    const recordsReply = reply as RecordsQueryReply;
    if (recordsReply.status.code !== 200 || recordsReply.entries === undefined) {
      return [];
    }

    const entries: SyncMessageEntry[] = [];
    for (const entry of recordsReply.entries) {
      if (entry.initialWrite !== undefined) {
        entries.push({ message: SyncEngineLevel.toCanonicalGrantMessage(entry.initialWrite) });
      }
      const { encodedData: _encodedData, initialWrite: _initialWrite, ...message } = entry;
      const syncEntry: SyncMessageEntry = { message: SyncEngineLevel.toCanonicalGrantMessage(message as GenericMessage) };
      if (_encodedData !== undefined) {
        syncEntry.bufferedData = Encoder.base64UrlToBytes(_encodedData);
      }
      entries.push(syncEntry);
    }

    return entries;
  }

  /**
   * Reduce a locally-read permission grant to its canonical, owner-authored form
   * for pushing to the owner's tenant.
   *
   * A permission grant is authored (and signed) by the owner. When a
   * wallet-connected delegate — which does not hold the owner's signing key —
   * stores the grant on its own tenant, it must attach a `signAsOwner`
   * `ownerSignature` (the delegate is the tenant owner there). That signature is
   * tenant-local: pushing such a copy to the owner's tenant is rejected by the
   * DWN with `RecordsWriteOwnerAndTenantMismatch`, because the ownerSignature's
   * signer (the delegate) is not the target tenant (the owner). Stripping the
   * `ownerSignature` restores the exact owner-authored message the owner already
   * signed, which the owner's tenant accepts on its own authority.
   */
  private static toCanonicalGrantMessage(message: GenericMessage): GenericMessage {
    const authorization = (message as { authorization?: { ownerSignature?: unknown } }).authorization;
    if (authorization?.ownerSignature === undefined) {
      return message;
    }

    const { ownerSignature: _ownerSignature, ...remainingAuthorization } = authorization;
    return { ...message, authorization: remainingAuthorization } as GenericMessage;
  }

  private async pushMessageEntries({ did, dwnUrl, delegateDid, permissionGrantIds, entries }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    permissionGrantIds?: string[];
    entries: SyncMessageEntry[];
  }): Promise<PushResult> {
    return pushMessageEntries({
      did, dwnUrl, delegateDid, permissionGrantIds, entries,
      agent          : this.agent,
      permissionsApi : this._permissionsApi,
    });
  }

  private async collectLocalFeedCids(target: SyncTarget, shouldContinue?: () => boolean): Promise<Set<string> | undefined> {
    return this.collectFeedCids(target, 'local', shouldContinue);
  }

  private async collectRemoteFeedCids(target: SyncTarget, shouldContinue?: () => boolean): Promise<Set<string> | undefined> {
    return this.collectFeedCids(target, 'remote', shouldContinue);
  }

  private async collectFeedCids(
    target: SyncTarget,
    source: 'local' | 'remote',
    shouldContinue?: () => boolean,
  ): Promise<Set<string> | undefined> {
    const cids = new Set<string>();
    let cursor: ProgressToken | undefined;

    while (true) {
      if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
        return undefined;
      }

      const reply = await this.queryFeedCidsPage(target, source, cursor);
      if (source === 'local') {
        SyncEngineLevel.assertFeedPushSucceeded(reply, target);
      } else {
        SyncEngineLevel.assertFeedPullSucceeded(reply, target);
      }
      for (const entry of reply.entries ?? []) {
        cids.add(entry.messageCid);
      }

      const advance = this.nextFeedEnumerationCursor(reply, target, source);
      if (advance.drained) {
        return cids;
      }

      cursor = advance.cursor;
    }
  }

  private async queryFeedCidsPage(
    target: SyncTarget,
    source: 'local' | 'remote',
    cursor: ProgressToken | undefined,
  ): Promise<MessagesQueryReply> {
    const params = {
      did                : target.did,
      delegateDid        : target.delegateDid,
      permissionGrantIds : target.permissionGrantIds,
      filters            : SyncEngineLevel.messageFeedFiltersForScope(target.scope),
      cursor,
      cidsOnly           : true,
      limit              : FEED_PAGE_LIMIT,
      agent              : this.agent,
    };

    return source === 'local'
      ? queryLocalMessageFeed(params)
      : queryRemoteMessageFeed({ ...params, dwnUrl: target.dwnUrl });
  }

  private nextFeedEnumerationCursor(
    reply: MessagesQueryReply,
    target: SyncTarget,
    source: 'local' | 'remote',
  ): FeedCursorAdvanceResult {
    const drained = reply.drained === true;
    if (reply.cursor === undefined) {
      if (drained) {
        return { drained: true };
      }
      throw new Error(`SyncEngineLevel: ${source} MessagesQuery for ${target.did} -> ${target.dwnUrl} returned no cursor before drain`);
    }

    if (!this.isValidProgressToken(reply.cursor)) {
      throw new Error(`SyncEngineLevel: ${source} MessagesQuery returned an invalid cursor for ${target.did} -> ${target.dwnUrl}`);
    }

    return drained ? { drained: true } : { cursor: reply.cursor, drained: false };
  }

  private static feedEntriesMissingFrom(knownCids: Set<string>, entries: MessagesQueryReplyEntry[]): MessagesQueryReplyEntry[] {
    return entries.filter(entry => !knownCids.has(entry.messageCid));
  }

  private async admitRemoteFeedPageAndTrack({
    target,
    entries,
    admittedCids,
    knownCids,
    shouldContinue,
  }: {
    target: SyncTarget;
    entries: MessagesQueryReplyEntry[];
    admittedCids: string[];
    knownCids?: Set<string>;
    shouldContinue?: () => boolean;
  }): Promise<TrackedFeedPageAdmissionResult> {
    const pageResult = await this.admitRemoteFeedPage(target, entries, shouldContinue);
    if (pageResult.kind === 'aborted') {
      return { kind: 'aborted' };
    }

    admittedCids.push(...pageResult.admittedCids);
    for (const messageCid of pageResult.admittedCids) {
      knownCids?.add(messageCid);
    }

    if (pageResult.kind === 'deferred') {
      if (admittedCids.length > 0) {
        this.emitReconcileApplied(target, admittedCids);
      }
      throw new Error(`SyncEngineLevel: pull deferred for ${pageResult.messageCid}: ${pageResult.detail ?? 'dependency unavailable'}`);
    }

    return { kind: 'processed', hasActionableDiffs: pageResult.hasActionableDiffs };
  }

  private async pushLocalFeedPage(
    target: SyncTarget,
    entries: MessagesQueryReplyEntry[],
    shouldContinue?: () => boolean,
  ): Promise<FeedPagePushResult> {
    let hasActionableDiffs = false;

    for (const entry of entries) {
      if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
        return { kind: 'aborted' };
      }

      const result = await this.pushLocalFeedEntry(target, entry, shouldContinue);
      if (result.kind === 'aborted') {
        return { kind: 'aborted' };
      }
      if (result.kind === 'failed') {
        return { kind: 'failed', failures: result.failures, hasActionableDiffs };
      }
      if (result.kind === 'pushed') {
        hasActionableDiffs = true;
      }
    }

    return { kind: 'processed', hasActionableDiffs };
  }

  private async pushLocalFeedEntry(
    target: SyncTarget,
    entry: MessagesQueryReplyEntry,
    shouldContinue?: () => boolean,
  ): Promise<FeedPushEntryResult> {
    if (await this.hasAdmissionDeadLetter(target.did, target.dwnUrl, entry.messageCid)) {
      return { kind: 'skipped' };
    }

    // Every durable quota block is skipped in the ordinary feed. Due probes
    // are driven independently at the start of target push, because this feed
    // checkpoint is allowed to advance past the omitted CID.
    if (await this.getQuotaBlockState(target, entry.messageCid) !== undefined) {
      return { kind: 'skipped' };
    }

    if (this.isRecentlyPulled(entry.messageCid, target.dwnUrl)) {
      return { kind: 'skipped' };
    }

    const quotaBlockedInitialCids = await this.getQuotaBlockedInitialCidsForFeedEntry(target, entry);
    const result = await this.pushMessages({
      did                : target.did,
      dwnUrl             : target.dwnUrl,
      delegateDid        : target.delegateDid,
      permissionGrantIds : target.permissionGrantIds,
      messageCids        : [...quotaBlockedInitialCids, entry.messageCid],
    });
    if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
      return { kind: 'aborted' };
    }
    const attributedResult = SyncEngineLevel.attributeBlockedFeedDependency(
      result,
      entry.messageCid,
      quotaBlockedInitialCids,
    );
    const transition = await this.transitionPushResult(target, attributedResult, {
      protocol : entry.protocol,
      source   : 'feed',
    });

    if (attributedResult.failed.length === 0) {
      return { kind: 'pushed' };
    }

    if (transition.retryableFailures.length === 0) {
      return { kind: 'skipped' };
    }

    return { kind: 'failed', failures: transition.retryableFailures };
  }

  /**
   * A deleted record's missing-initial response identifies the dependency by
   * recordId, which can no longer be queried after deletion. If the exact
   * retained initial CID staged ahead of that tombstone was quota-rejected,
   * attribute the root omission to that CID so the cursor can advance and a
   * later direct probe can replay the same ancestry deterministically.
   */
  private static attributeBlockedFeedDependency(
    result: PushResult,
    rootCid: string,
    stagedDependencyCids: string[],
  ): PushResult {
    const blockedDependency = result.failed.find(
      (failure): boolean => failure.quotaBlocked === true && stagedDependencyCids.includes(failure.cid),
    );
    if (blockedDependency === undefined) { return result; }

    return {
      ...result,
      failed: result.failed.map((failure): PushFailure => {
        if (failure.cid !== rootCid || failure.quotaBlocked === true || failure.terminal === true) {
          return failure;
        }

        return {
          ...failure,
          dependencyCid : blockedDependency.cid,
          kind          : 'Deferred',
          reason        : 'storage',
          quotaBlocked  : true,
          detail        : blockedDependency.detail,
        };
      }),
    };
  }

  /**
   * A later update or delete is a useful signal that a quota-blocked initial
   * write may now be retained without its old payload. Replay that exact
   * ancestor in the same batch without stripping data from a still-current
   * record or waiting for the probe timer.
   */
  private async getQuotaBlockedInitialCidsForFeedEntry(
    target: SyncTarget,
    entry: MessagesQueryReplyEntry,
  ): Promise<string[]> {
    const dataBlocks = (await this.getQuotaBlocksForTarget(target))
      .filter(({ state }) => state.source !== 'permission-grant');
    if (dataBlocks.length === 0) { return []; }

    const recordId = await this.resolveRecordIdForFeedEntry(target, entry);
    if (recordId === undefined) { return []; }

    const initialCids: string[] = [];
    for (const { messageCid, state } of dataBlocks) {
      const blockedCid = state.blockedCid ?? messageCid;
      if (blockedCid === entry.messageCid || initialCids.includes(blockedCid)) { continue; }
      const local = await this.getLocalMessageForTarget(target, blockedCid);
      if (
        local !== undefined &&
        local.dataStream === undefined &&
        SyncEngineLevel.isInitialWriteForRecord(local.message, recordId)
      ) {
        initialCids.push(blockedCid);
      }
    }
    return initialCids;
  }

  /**
   * The diff push path enumerates the local feed with `cidsOnly`, so
   * `entry.message` is absent there. Resolve the record id from the entry when
   * present, otherwise load the message from the local store by cid so blocked
   * initial-write dependency replay behaves identically on the incremental and
   * diff push paths (a tombstone enumerated without its message would otherwise
   * never stage its retained dataless ancestor and could never converge).
   */
  private async resolveRecordIdForFeedEntry(
    target: SyncTarget,
    entry: MessagesQueryReplyEntry,
  ): Promise<string | undefined> {
    const fromEntry = SyncEngineLevel.recordIdForRecordsMessage(entry.message);
    if (fromEntry !== undefined) { return fromEntry; }

    const local = await this.getLocalMessageForTarget(target, entry.messageCid);
    return SyncEngineLevel.recordIdForRecordsMessage(local?.message);
  }

  private static recordIdForRecordsMessage(message: GenericMessage | undefined): string | undefined {
    if (
      message?.descriptor.interface !== DwnInterfaceName.Records ||
      (
        message.descriptor.method !== DwnMethodName.Write &&
        message.descriptor.method !== DwnMethodName.Delete
      )
    ) {
      return undefined;
    }

    const recordId = (message as { recordId?: unknown }).recordId ??
      (message.descriptor as { recordId?: unknown }).recordId;
    return typeof recordId === 'string' ? recordId : undefined;
  }

  private static isInitialWriteForRecord(message: GenericMessage, recordId: string): boolean {
    if (!SyncEngineLevel.isRecordsWriteForRecord(message, recordId)) {
      return false;
    }

    const recordsWrite = message as GenericMessage & {
      descriptor: GenericMessage['descriptor'] & { dateCreated?: string };
    };
    return recordsWrite.descriptor.dateCreated === recordsWrite.descriptor.messageTimestamp;
  }

  private static isRecordsWriteForRecord(message: GenericMessage, recordId: string): boolean {
    if (
      message.descriptor.interface !== DwnInterfaceName.Records ||
      message.descriptor.method !== DwnMethodName.Write
    ) {
      return false;
    }

    return (message as GenericMessage & { recordId?: string }).recordId === recordId;
  }

  private async resetFeedPullAfterProgressGap(
    reply: MessagesQueryReply,
    link: ReplicationLinkState,
    alreadyReset: boolean,
  ): Promise<boolean> {
    if (reply.status.code !== 410 || alreadyReset) {
      return false;
    }

    ReplicationLedger.resetCheckpoint(link.pull);
    await this.ledger.saveLink(link);
    return true;
  }

  private async resetFeedPushAfterProgressGap(
    reply: MessagesQueryReply,
    link: ReplicationLinkState,
    alreadyReset: boolean,
  ): Promise<boolean> {
    if (reply.status.code !== 410 || alreadyReset) {
      return false;
    }

    ReplicationLedger.resetCheckpoint(link.push);
    await this.ledger.saveLink(link);
    return true;
  }

  private static assertFeedPullSucceeded(reply: MessagesQueryReply, target: SyncTarget): void {
    if (reply.status.code !== 200) {
      throw new Error(`SyncEngineLevel: MessagesQuery failed for ${target.did} -> ${target.dwnUrl}: ${reply.status.code} ${reply.status.detail}`);
    }
  }

  private static assertFeedPushSucceeded(reply: MessagesQueryReply, target: SyncTarget): void {
    if (reply.status.code !== 200) {
      const detail = `${reply.status.code} ${reply.status.detail}`;
      throw new Error(`SyncEngineLevel: local MessagesQuery failed for ${target.did} -> ${target.dwnUrl}: ${detail}`);
    }
  }

  private async admitRemoteFeedPage(
    target: SyncTarget,
    entries: MessagesQueryReplyEntry[],
    shouldContinue?: () => boolean,
  ): Promise<FeedPageAdmissionResult> {
    const admittedCids: string[] = [];
    let hasActionableDiffs = false;

    for (const entry of entries) {
      if (await this.hasAdmissionDeadLetter(target.did, target.dwnUrl, entry.messageCid)) {
        continue;
      }

      const outcome = await this.admitRemoteFeedEntry(target, entry, shouldContinue);
      if (outcome.kind === 'aborted') {
        return { kind: 'aborted' };
      }

      if (outcome.kind === 'deferred') {
        if (!await this.deadLetterExpiredDeferredPull(target, entry, outcome.detail)) {
          return { kind: 'deferred', admittedCids, detail: outcome.detail, hasActionableDiffs, messageCid: entry.messageCid };
        }
        hasActionableDiffs = true;
        continue;
      }

      hasActionableDiffs = true;
      if (outcome.kind === 'admitted') {
        admittedCids.push(...outcome.appliedCids);
        await this.trackRemoteFeedAppliedCids(outcome.appliedCids, target);
      }
    }

    return { kind: 'processed', admittedCids, hasActionableDiffs };
  }

  private async trackRemoteFeedAppliedCids(messageCids: string[], target: SyncTarget): Promise<void> {
    for (const cid of messageCids) {
      this.trackRecentlyPulledMessage(cid, target.dwnUrl);
      await this.clearFailedMessage(cid, target.dwnUrl);
      await this.clearDeferredPull(target.did, target.dwnUrl, cid);
      // A pull admission only proves that the signed message exists remotely.
      // The remote may retain a RecordsWrite CID as dataless ancestry, while
      // the local admission reports Duplicate because it already has the full
      // record. Only a push acknowledgement can prove that the remote has the
      // payload and clear an exact-CID quota block.
      await this.resolveQuotaBlocksSupersededByAcknowledgement(target, cid);
    }
  }

  private async deadLetterExpiredDeferredPull(
    target: SyncTarget,
    entry: MessagesQueryReplyEntry,
    detail: string | undefined,
  ): Promise<boolean> {
    const state = await this.recordDeferredPull(target, entry.messageCid, detail);
    const firstDeferredAt = Date.parse(state.firstDeferredAt);
    if (!Number.isFinite(firstDeferredAt) || Date.now() - firstDeferredAt < SyncEngineLevel.DEFERRED_PULL_DEAD_LETTER_AFTER_MS) {
      return false;
    }

    await this.recordDeadLetter({
      messageCid     : entry.messageCid,
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      protocol       : entry.protocol ?? SyncEngineLevel.protocolFromDescriptor(entry.message?.descriptor),
      category       : 'admit-failed',
      errorCode      : 'Deferred',
      errorDetail    : detail ?? 'pull admission deferred beyond retry window',
    });
    await this.clearDeferredPull(target.did, target.dwnUrl, entry.messageCid);
    return true;
  }

  private async recordDeferredPull(target: SyncTarget, messageCid: string, detail: string | undefined): Promise<DeferredPullState> {
    const key = SyncEngineLevel.deadLetterKey(target.did, messageCid, target.dwnUrl);
    const now = new Date().toISOString();
    let previous: DeferredPullState | undefined;
    try {
      previous = JSON.parse(await this._deferredPulls.get(key)) as DeferredPullState;
    } catch (error) {
      const e = error as { code?: string };
      if (e.code !== 'LEVEL_NOT_FOUND') {
        throw error;
      }
    }

    const state: DeferredPullState = {
      attempts        : (previous?.attempts ?? 0) + 1,
      detail,
      firstDeferredAt : previous?.firstDeferredAt ?? now,
      lastDeferredAt  : now,
    };
    await this._deferredPulls.put(key, JSON.stringify(state));
    return state;
  }

  private async clearDeferredPull(tenantDid: string, dwnUrl: string, messageCid: string): Promise<void> {
    try {
      await this._deferredPulls.del(SyncEngineLevel.deadLetterKey(tenantDid, messageCid, dwnUrl));
    } catch (error) {
      const e = error as { code?: string };
      if (e.code !== 'LEVEL_NOT_FOUND') {
        throw error;
      }
    }
  }

  /**
   * Quota-block re-probe backoff: 30s, 1m, 5m, 15m, then 30m (clamped). The
   * poll/reconcile cadence drives the probes; `nextProbeAt` throttles how often
   * a blocked message is actually re-attempted so the remote is not hammered.
   */
  private static readonly QUOTA_BLOCK_BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 1_800_000];

  private static quotaBlockKey(tenantDid: string, messageCid: string, linkKey: string): string {
    return `${tenantDid}|${messageCid}|${encodeURIComponent(linkKey)}`;
  }

  private quotaBlockIdentity(target: SyncTarget): { keyFor: (messageCid: string) => string; linkKey: string; projectionId: string } {
    const projectionId = target.projectionId;
    const linkKey = this.buildLinkKey(target.did, target.dwnUrl, projectionId, target.authorizationEpoch);
    return {
      keyFor: (messageCid: string): string => SyncEngineLevel.quotaBlockKey(target.did, messageCid, linkKey),
      linkKey,
      projectionId,
    };
  }

  private async getQuotaBlockState(target: SyncTarget, messageCid: string): Promise<QuotaBlockState | undefined> {
    const { keyFor } = this.quotaBlockIdentity(target);
    try {
      return JSON.parse(await this._quotaBlocks.get(keyFor(messageCid))) as QuotaBlockState;
    } catch (error) {
      const e = error as { code?: string };
      if (e.code === 'LEVEL_NOT_FOUND') { return undefined; }
      throw error;
    }
  }

  /** Record a fresh quota block or extend an existing one's backoff. Returns the persisted state. */
  private async recordQuotaBlock(
    target: SyncTarget,
    messageCid: string,
    protocol: string | undefined,
    detail: string | undefined,
    source: QuotaBlockState['source'] = 'feed',
    blockedCid = messageCid,
  ): Promise<QuotaBlockState> {
    const identity = this.quotaBlockIdentity(target);
    const key = identity.keyFor(messageCid);
    const previous = await this.getQuotaBlockState(target, messageCid);
    // A newer same-record acknowledgement permanently resolved this omission.
    // A stale in-flight quota response must not reactivate it.
    if (previous?.supersededAt !== undefined) {
      return previous;
    }
    const now = Date.now();
    const attempts = (previous?.attempts ?? 0) + 1;
    const backoff = SyncEngineLevel.QUOTA_BLOCK_BACKOFF_MS;
    const delay = backoff[Math.min(attempts - 1, backoff.length - 1)];
    const state: QuotaBlockState = {
      attempts,
      authorizationEpoch : target.authorizationEpoch,
      blockedCid,
      detail,
      linkKey            : identity.linkKey,
      messageCid,
      protocol           : protocol ?? previous?.protocol,
      projectionId       : identity.projectionId,
      remoteEndpoint     : target.dwnUrl,
      source,
      tenantDid          : target.did,
      firstBlockedAt     : previous?.firstBlockedAt ?? new Date(now).toISOString(),
      lastBlockedAt      : new Date(now).toISOString(),
      nextProbeAt        : new Date(now + delay).toISOString(),
    };
    await this._quotaBlocks.put(key, JSON.stringify(state));
    return state;
  }

  private async clearQuotaBlock(target: SyncTarget, messageCid: string): Promise<boolean> {
    const { linkKey } = this.quotaBlockIdentity(target);
    return this.clearQuotaBlockByLinkKey(target.did, linkKey, messageCid);
  }

  private async clearQuotaBlockByLinkKey(tenantDid: string, linkKey: string, messageCid: string): Promise<boolean> {
    const key = SyncEngineLevel.quotaBlockKey(tenantDid, messageCid, linkKey);
    try {
      await this._quotaBlocks.get(key);
    } catch (error) {
      const e = error as { code?: string };
      if (e.code === 'LEVEL_NOT_FOUND') { return false; }
      throw error;
    }
    try {
      await this._quotaBlocks.del(key);
    } catch (error) {
      const e = error as { code?: string };
      if (e.code !== 'LEVEL_NOT_FOUND') { throw error; }
    }
    return true;
  }

  private async clearQuotaBlockWithResolution(
    target: SyncTarget,
    messageCid: string,
    resolution: 'applied' | 'superseded',
    preserveSupersededOmission = false,
  ): Promise<void> {
    const state = await this.getQuotaBlockState(target, messageCid);
    if (
      preserveSupersededOmission &&
      resolution === 'superseded' &&
      state !== undefined &&
      state.source !== 'permission-grant'
    ) {
      await this.markQuotaBlockAsSupersededOmission(target, messageCid, state);
      return;
    }
    if (!await this.clearQuotaBlock(target, messageCid)) {
      return;
    }
    if (state?.supersededAt !== undefined) {
      return;
    }

    this.emitQuotaCleared(target, messageCid, resolution);
  }

  /**
   * Preserve an intentionally omitted historical write after the remote has
   * acknowledged a newer state for the same record. The row remains durable so
   * exact inventory checks can explain the missing CID, but it is no longer an
   * active quota block and will never be probed again.
   */
  private async resolveQuotaBlocksSupersededByAcknowledgement(
    target: SyncTarget,
    acknowledgedCid: string,
  ): Promise<void> {
    const activeBlocks = await this.getQuotaBlocksForTarget(target);
    if (activeBlocks.length === 0) { return; }

    const acknowledged = await this.getLocalMessageForTarget(target, acknowledgedCid);
    if (acknowledged === undefined) { return; }

    for (const { messageCid, state } of activeBlocks) {
      if (messageCid === acknowledgedCid || state.source === 'permission-grant') { continue; }
      const blockedRoot = await this.getLocalMessageForTarget(target, messageCid);
      if (
        blockedRoot === undefined ||
        !await SyncEngineLevel.acknowledgementSupersedesBlockedWrite(
          acknowledged.message,
          blockedRoot.message,
        )
      ) {
        continue;
      }

      await this.markQuotaBlockAsSupersededOmission(target, messageCid, state);
    }
  }

  /** Delete-wins supersession plus normal RecordsWrite ordering for one record. */
  private static async acknowledgementSupersedesBlockedWrite(
    acknowledgement: GenericMessage,
    blocked: GenericMessage,
  ): Promise<boolean> {
    const recordId = SyncEngineLevel.recordIdForRecordsMessage(acknowledgement);
    if (recordId === undefined || !SyncEngineLevel.isRecordsWriteForRecord(blocked, recordId)) {
      return false;
    }

    if (acknowledgement.descriptor.method === DwnMethodName.Delete) {
      return true;
    }

    return acknowledgement.descriptor.method === DwnMethodName.Write &&
      !SyncEngineLevel.isInitialWriteForRecord(acknowledgement, recordId) &&
      await Message.isNewer(acknowledgement, blocked);
  }

  /**
   * Optimistic-concurrency check for an in-flight quota-block operation: has the
   * durable row changed (superseded, or advanced attempts/last-blocked) since it
   * was read, or been cleared entirely? If so the caller must abort rather than
   * overwrite the newer authoritative state.
   */
  private static quotaBlockChangedSince(
    current: QuotaBlockState | undefined,
    expected: QuotaBlockState,
  ): boolean {
    return current === undefined ||
      current.supersededAt !== undefined ||
      current.attempts !== expected.attempts ||
      current.lastBlockedAt !== expected.lastBlockedAt;
  }

  private emitQuotaCleared(
    target: SyncTarget,
    messageCid: string,
    resolution: 'applied' | 'superseded',
  ): void {
    this.emitEvent({
      type           : 'push:quota-cleared',
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      ...syncEventScope(target.scope),
      messageCid,
      resolution,
    });
  }

  private async markQuotaBlockAsSupersededOmission(
    target: SyncTarget,
    messageCid: string,
    expected: QuotaBlockState,
  ): Promise<void> {
    const current = await this.getQuotaBlockState(target, messageCid);
    if (SyncEngineLevel.quotaBlockChangedSince(current, expected)) {
      return;
    }

    const supersededAt = new Date().toISOString();
    const { keyFor } = this.quotaBlockIdentity(target);
    await this._quotaBlocks.put(keyFor(messageCid), JSON.stringify({ ...current, supersededAt }));
    this.emitQuotaCleared(target, messageCid, 'superseded');
  }

  /** Apply push outcomes consistently for feed, live, bootstrap, and direct quota-probe paths. */
  private async transitionPushResult(
    target: SyncTarget,
    result: PushResult,
    options?: { protocol?: string; source?: QuotaBlockState['source'] },
  ): Promise<PushResultTransition> {
    const transition: PushResultTransition = { quotaBlocked: false, retryableFailures: [], terminalFailures: [] };
    const acknowledgementsByCid = new Map(
      (result.acknowledged ?? []).map((acknowledgement) => [acknowledgement.cid, acknowledgement] as const),
    );
    for (const cid of result.succeeded) {
      if (!acknowledgementsByCid.has(cid)) {
        acknowledgementsByCid.set(cid, { cid, resolution: 'applied' });
      }
    }

    // Superseded-omission resolution scans the whole quota-block range per
    // acknowledgement; skip it entirely when the tenant has no active blocks
    // (acknowledgements only clear blocks, so an empty set stays empty).
    const hasActiveQuotaBlocks = (await this.getQuotaBlocksForTarget(target)).length > 0;
    for (const acknowledgement of acknowledgementsByCid.values()) {
      await this.clearFailedMessage(acknowledgement.cid, target.dwnUrl);
      await this.clearQuotaBlockWithResolution(
        target,
        acknowledgement.cid,
        acknowledgement.resolution,
        acknowledgement.resolution === 'superseded',
      );
      if (hasActiveQuotaBlocks) {
        await this.resolveQuotaBlocksSupersededByAcknowledgement(target, acknowledgement.cid);
      }
    }

    for (const originalFailure of result.failed) {
      if (acknowledgementsByCid.has(originalFailure.cid)) {
        continue;
      }
      const failure: PushFailure = {
        ...originalFailure,
        protocol: originalFailure.protocol ?? options?.protocol,
      };

      if (isQuotaBlockedPushFailure(failure)) {
        const state = await this.recordQuotaBlock(
          target,
          failure.cid,
          failure.protocol,
          failure.detail,
          options?.source,
          failure.dependencyCid,
        );
        if (state.supersededAt !== undefined) { continue; }
        transition.quotaBlocked = true;
        transition.nextQuotaProbeAt = SyncEngineLevel.earliestTimestamp(transition.nextQuotaProbeAt, state.nextProbeAt);
        this.emitEvent({
          type           : 'push:quota-blocked',
          tenantDid      : target.did,
          remoteEndpoint : target.dwnUrl,
          ...syncEventScope(target.scope),
          messageCid     : failure.cid,
          ...(failure.detail === undefined ? {} : { detail: failure.detail }),
          nextProbeAt    : state.nextProbeAt,
        });
        continue;
      }

      const previousBlock = await this.getQuotaBlockState(target, failure.cid);
      if (previousBlock?.supersededAt !== undefined) {
        // Resolved omissions are never pushed again. Any failure still arriving
        // for this CID belongs to an older in-flight request and cannot undo the
        // successor acknowledgement that resolved it.
        continue;
      }
      if (failure.localMissing === true && previousBlock !== undefined) {
        await this.clearQuotaBlockWithResolution(target, failure.cid, 'superseded');
        continue;
      }

      if (isTerminalPushFailure(failure)) {
        await this.clearQuotaBlock(target, failure.cid);
        await this.recordDeadLetter({
          messageCid     : failure.cid,
          tenantDid      : target.did,
          remoteEndpoint : target.dwnUrl,
          protocol       : failure.protocol ?? singleProtocolForSyncScope(target.scope),
          category       : 'admit-failed',
          errorCode      : failure.kind ?? 'Invalid',
          errorDetail    : failure.detail ?? 'push rejected during sync reconciliation',
        });
        transition.terminalFailures.push(failure);
        continue;
      }

      if (previousBlock !== undefined) {
        const state = await this.recordQuotaBlock(
          target,
          failure.cid,
          failure.protocol,
          failure.detail ?? previousBlock.detail,
          previousBlock.source,
          previousBlock.blockedCid,
        );
        if (state.supersededAt !== undefined) { continue; }
        transition.quotaBlocked = true;
        transition.nextQuotaProbeAt = SyncEngineLevel.earliestTimestamp(transition.nextQuotaProbeAt, state.nextProbeAt);
        continue;
      }

      transition.retryableFailures.push(failure);
    }

    return transition;
  }

  private static earliestTimestamp(current: string | undefined, candidate: string): string {
    return current === undefined || lexicographicalCompare(candidate, current) < 0 ? candidate : current;
  }

  private static latestTimestamp(current: string | undefined, candidate: string): string {
    return current === undefined || lexicographicalCompare(candidate, current) > 0 ? candidate : current;
  }

  /** Re-probe due feed roots independently of the feed checkpoint that advanced past them. */
  private async probeQuotaBlocksForTarget(
    target: SyncTarget,
    force = false,
    forceProbeCids?: Set<string>,
    shouldContinue?: () => boolean,
  ): Promise<void> {
    const dueCids: string[] = [];
    for (const { messageCid, state } of await this.getQuotaBlocksForTarget(target)) {
      if (state.source === 'permission-grant') { continue; }
      const nextProbeAt = Date.parse(state.nextProbeAt);
      const isForced = force && (forceProbeCids === undefined || forceProbeCids.has(messageCid));
      if (isForced || !Number.isFinite(nextProbeAt) || Date.now() >= nextProbeAt) {
        dueCids.push(messageCid);
      }
    }

    for (const messageCid of dueCids) {
      if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
        return;
      }
      await this.probeQuotaBlock(
        target,
        messageCid,
        force && (forceProbeCids === undefined || forceProbeCids.has(messageCid)),
        shouldContinue,
      );
    }
  }

  private async probeQuotaBlock(
    target: SyncTarget,
    messageCid: string,
    force: boolean,
    shouldContinue?: () => boolean,
  ): Promise<void> {
    const { keyFor } = this.quotaBlockIdentity(target);
    const key = keyFor(messageCid);
    const existing = this._quotaProbeInFlight.get(key);
    if (existing !== undefined) {
      await existing;
      return;
    }

    const probe = this.doProbeQuotaBlock(target, messageCid, force, shouldContinue).finally((): void => {
      if (this._quotaProbeInFlight.get(key) === probe) {
        this._quotaProbeInFlight.delete(key);
      }
    });
    this._quotaProbeInFlight.set(key, probe);
    await probe;
  }

  private async doProbeQuotaBlock(
    target: SyncTarget,
    messageCid: string,
    force: boolean,
    shouldContinue?: () => boolean,
  ): Promise<void> {
    const generation = this._engineGeneration;
    if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) { return; }
    const state = await this.getQuotaBlockState(target, messageCid);
    if (state === undefined || state.source === 'permission-grant' || state.supersededAt !== undefined) { return; }
    const nextProbeAt = Date.parse(state.nextProbeAt);
    if (!force && Number.isFinite(nextProbeAt) && Date.now() < nextProbeAt) { return; }

    const localEntry = await this.getLocalMessageForTarget(target, messageCid);
    if (this._engineGeneration !== generation) { return; }
    if (localEntry !== undefined && SyncEngineLevel.hasUnmaterializedRecordsWriteData(localEntry)) {
      await this.deferUnmaterializedQuotaProbe(target, messageCid, state);
      return;
    }

    const blockedDependencyEntry =
      localEntry !== undefined && state.blockedCid !== undefined && state.blockedCid !== messageCid
        ? await this.getLocalMessageForTarget(target, state.blockedCid)
        : undefined;
    if (this._engineGeneration !== generation) { return; }

    const result = localEntry === undefined
      ? await this.pushMessages({
        did                : target.did,
        dwnUrl             : target.dwnUrl,
        delegateDid        : target.delegateDid,
        permissionGrantIds : target.permissionGrantIds,
        messageCids        : [messageCid],
      })
      : await this.pushMessageEntries({
        did                : target.did,
        dwnUrl             : target.dwnUrl,
        delegateDid        : target.delegateDid,
        permissionGrantIds : target.permissionGrantIds,
        entries            : [
          ...(blockedDependencyEntry === undefined ? [] : [blockedDependencyEntry]),
          localEntry,
        ],
      });
    if (
      this._engineGeneration !== generation ||
      SyncEngineLevel.shouldAbortReconcile(shouldContinue)
    ) {
      return;
    }
    const currentState = await this.getQuotaBlockState(target, messageCid);
    if (SyncEngineLevel.quotaBlockChangedSince(currentState, state)) {
      // A later remote acknowledgement, local retirement, or link lifecycle
      // transition won the race while this request was in flight. Its newer
      // state is authoritative; do not recreate/overwrite it with a stale
      // probe result.
      return;
    }
    await this.transitionPushResult(target, result, { protocol: state.protocol, source: state.source });
  }

  private getLocalMessageForTarget(target: SyncTarget, messageCid: string): Promise<SyncMessageEntry | undefined> {
    return getLocalMessage({
      author             : target.did,
      delegateDid        : target.delegateDid,
      permissionGrantIds : target.permissionGrantIds,
      messageCid,
      agent              : this.agent,
    });
  }

  /**
   * A positive-size RecordsWrite with no local data is retained ancestry, not a
   * standalone record to expose remotely. Its later update/delete is responsible
   * for replaying that metadata dependency, so keep the omission durable and
   * move its direct probe into the next backoff window.
   */
  private async deferUnmaterializedQuotaProbe(
    target: SyncTarget,
    messageCid: string,
    state: QuotaBlockState,
  ): Promise<void> {
    const currentState = await this.getQuotaBlockState(target, messageCid);
    if (SyncEngineLevel.quotaBlockChangedSince(currentState, state)) {
      return;
    }

    const delayIndex = Math.min(state.attempts, SyncEngineLevel.QUOTA_BLOCK_BACKOFF_MS.length - 1);
    const nextProbeAt = new Date(Date.now() + SyncEngineLevel.QUOTA_BLOCK_BACKOFF_MS[delayIndex]).toISOString();
    const { keyFor } = this.quotaBlockIdentity(target);
    await this._quotaBlocks.put(keyFor(messageCid), JSON.stringify({ ...state, nextProbeAt }));
  }

  private async clearQuotaBlocksForTenant(tenantDid: string): Promise<void> {
    const batch: { type: 'del'; key: string }[] = [];
    for await (const [key] of this._quotaBlocks.iterator(SyncEngineLevel.tenantKeyRange(tenantDid))) {
      batch.push({ type: 'del', key });
    }
    if (batch.length > 0) {
      await this._quotaBlocks.batch(batch);
    }
  }

  private async pruneQuotaBlocksForCurrentTargets(targets: SyncTarget[], expectedGeneration: number): Promise<void> {
    const currentLinkKeys = new Set(targets.map((target) => this.quotaBlockIdentity(target).linkKey));
    const registeredTenants = new Set(targets.map((target) => target.did));
    const batch: { type: 'del'; key: string }[] = [];
    for await (const [key, value] of this._quotaBlocks.iterator()) {
      const state = JSON.parse(value) as QuotaBlockState;
      if (registeredTenants.has(state.tenantDid) && !currentLinkKeys.has(state.linkKey)) {
        batch.push({ type: 'del', key });
      }
    }
    if (this._syncTargetsCacheGeneration !== expectedGeneration) {
      return;
    }
    if (batch.length > 0) {
      await this._quotaBlocks.batch(batch);
    }
  }

  private async getQuotaBlocksForTarget(
    target: SyncTarget,
  ): Promise<Array<{ messageCid: string; state: QuotaBlockState }>> {
    return (await this.getQuotaStatesForTarget(target))
      .filter(({ state }) => state.supersededAt === undefined);
  }

  /** Includes resolved omissions retained solely for exact feed-divergence accounting. */
  private async getQuotaStatesForTarget(
    target: SyncTarget,
  ): Promise<Array<{ messageCid: string; state: QuotaBlockState }>> {
    const blocks: Array<{ messageCid: string; state: QuotaBlockState }> = [];
    const { linkKey } = this.quotaBlockIdentity(target);
    const targetProtocols = protocolsForSyncScope(target.scope);
    for await (const [, value] of this._quotaBlocks.iterator(SyncEngineLevel.tenantKeyRange(target.did))) {
      const state = JSON.parse(value) as QuotaBlockState;
      if (state.linkKey !== linkKey) { continue; }
      if (targetProtocols !== undefined && state.protocol !== undefined && !targetProtocols.includes(state.protocol)) {
        continue;
      }
      blocks.push({ messageCid: state.messageCid, state });
    }
    return blocks;
  }

  private async clearResolvedQuotaOmissionsForTarget(target: SyncTarget): Promise<void> {
    for (const { messageCid, state } of await this.getQuotaStatesForTarget(target)) {
      if (state.supersededAt !== undefined) {
        await this.clearQuotaBlock(target, messageCid);
      }
    }
  }

  private async getNextQuotaProbeAtForTarget(target: SyncTarget): Promise<string | undefined> {
    let nextFeedProbeAt: string | undefined;
    let grantBundleProbeAt: string | undefined;
    for (const block of await this.getQuotaBlocksForTarget(target)) {
      if (block.state.source === 'permission-grant') {
        // A delegated target's grant set is one authorization bundle. Wait for
        // every blocked grant to become due before replaying the bundle, or a
        // past-due sibling can continuously schedule zero-delay reconciles.
        grantBundleProbeAt = SyncEngineLevel.latestTimestamp(grantBundleProbeAt, block.state.nextProbeAt);
      } else {
        nextFeedProbeAt = SyncEngineLevel.earliestTimestamp(nextFeedProbeAt, block.state.nextProbeAt);
      }
    }
    if (grantBundleProbeAt === undefined) { return nextFeedProbeAt; }
    if (nextFeedProbeAt === undefined) { return grantBundleProbeAt; }
    return SyncEngineLevel.earliestTimestamp(nextFeedProbeAt, grantBundleProbeAt);
  }

  /**
   * Exact quota-divergence check. A block only suppresses pause/reset when the
   * remote has no unexplained extra CIDs and every local-only CID is one of
   * this link's durable omissions. This avoids masking unrelated corruption.
   */
  private async isFeedDivergenceExplainedByQuotaBlocks(
    target: SyncTarget,
    result: SyncReconcileResult,
  ): Promise<boolean> {
    let blocks = await this.getQuotaStatesForTarget(target);
    if (blocks.length === 0) { return false; }

    // A quota-blocked permission grant prevents an authorized remote inventory
    // query. The bootstrap result itself is the complete explanation until its
    // independently scheduled grant probe succeeds.
    if (result.quotaBlocked === true && blocks.some(({ state }) => state.source === 'permission-grant')) {
      return true;
    }

    const [localCids, remoteCids] = await Promise.all([
      this.collectLocalFeedCids(target),
      this.collectRemoteFeedCids(target),
    ]);
    if (localCids === undefined || remoteCids === undefined) { return false; }

    // Local feed retirement is authoritative. Remote CID presence alone is not
    // enough to clear an active root: a replicated initial write may exist only
    // as dataless ancestry. A resolved row can be collected only after every
    // local-only CID it explains (root and distinct blocked dependency) is gone.
    for (const block of blocks) {
      const blockedCid = block.state.blockedCid;
      const blockedDependencyIsLocalOnly = blockedCid !== undefined &&
        blockedCid !== block.messageCid &&
        localCids.has(blockedCid) &&
        !remoteCids.has(blockedCid);

      if (block.state.supersededAt !== undefined) {
        const rootIsLocalOnly = localCids.has(block.messageCid) && !remoteCids.has(block.messageCid);
        if (!rootIsLocalOnly && !blockedDependencyIsLocalOnly) {
          await this.clearQuotaBlock(target, block.messageCid);
        }
        continue;
      }

      if (!localCids.has(block.messageCid) && blockedDependencyIsLocalOnly) {
        await this.markQuotaBlockAsSupersededOmission(target, block.messageCid, block.state);
      } else if (!localCids.has(block.messageCid)) {
        await this.clearQuotaBlockWithResolution(target, block.messageCid, 'superseded');
      }
    }

    blocks = await this.getQuotaStatesForTarget(target);
    if (blocks.length === 0) {
      return localCids.size === remoteCids.size &&
        [...localCids].every((cid) => remoteCids.has(cid));
    }
    const omittedCids = new Set<string>();
    for (const { messageCid, state } of blocks) {
      if (state.source === 'permission-grant') { continue; }
      omittedCids.add(messageCid);
      if (state.blockedCid !== undefined && localCids.has(state.blockedCid)) {
        omittedCids.add(state.blockedCid);
      }
    }
    const localOnly = [...localCids].filter((cid) => !remoteCids.has(cid));
    const remoteOnly = [...remoteCids].filter((cid) => !localCids.has(cid));

    return remoteOnly.length === 0 &&
      localOnly.length > 0 &&
      localOnly.every((cid) => omittedCids.has(cid));
  }

  private async advanceFeedPullCursor(
    link: ReplicationLinkState,
    previousCursor: ProgressToken | undefined,
    reply: MessagesQueryReply,
    target: SyncTarget,
  ): Promise<FeedCursorAdvanceResult> {
    const drained = reply.drained === true;
    if (reply.cursor === undefined) {
      if (drained) {
        return { drained: true };
      }
      throw new Error(`SyncEngineLevel: MessagesQuery for ${target.did} -> ${target.dwnUrl} returned no cursor before drain`);
    }

    this.assertFeedCursorProgress(link, link.pull, previousCursor, reply.cursor, drained, target.dwnUrl, 'pull');
    ReplicationLedger.setReceivedToken(link.pull, reply.cursor);
    ReplicationLedger.commitContiguousToken(link.pull, reply.cursor);
    await this.ledger.saveLink(link);
    this.emitPullCheckpointAdvance(link);

    return drained ? { drained: true } : { cursor: reply.cursor, drained: false };
  }

  private async advanceFeedPushCursor(
    link: ReplicationLinkState,
    previousCursor: ProgressToken | undefined,
    reply: MessagesQueryReply,
    target: SyncTarget,
  ): Promise<FeedCursorAdvanceResult> {
    const drained = reply.drained === true;
    if (reply.cursor === undefined) {
      if (drained) {
        return { drained: true };
      }
      throw new Error(`SyncEngineLevel: local MessagesQuery for ${target.did} -> ${target.dwnUrl} returned no cursor before drain`);
    }

    this.assertFeedCursorProgress(link, link.push, previousCursor, reply.cursor, drained, target.dwnUrl, 'push');
    ReplicationLedger.setReceivedToken(link.push, reply.cursor);
    ReplicationLedger.commitContiguousToken(link.push, reply.cursor);
    await this.ledger.saveLink(link);
    this.emitPushCheckpointAdvance(link);

    return drained ? { drained: true } : { cursor: reply.cursor, drained: false };
  }

  private assertFeedCursorProgress(
    link: ReplicationLinkState,
    checkpoint: DirectionCheckpoint,
    previousCursor: ProgressToken | undefined,
    nextCursor: ProgressToken,
    drained: boolean,
    dwnUrl: string,
    direction: 'pull' | 'push',
  ): void {
    if (!this.isValidProgressToken(nextCursor)) {
      throw new Error(`SyncEngineLevel: ${direction} MessagesQuery returned an invalid cursor for ${link.tenantDid} -> ${dwnUrl}`);
    }

    if (!ReplicationLedger.validateTokenDomain(checkpoint, nextCursor)) {
      throw new Error(`SyncEngineLevel: ${direction} MessagesQuery token domain mismatch for ${link.tenantDid} -> ${dwnUrl}`);
    }

    if (previousCursor === undefined) {
      return;
    }

    const comparison = ReplicationLedger.comparePosition(nextCursor, previousCursor);
    if (comparison < 0 || (comparison === 0 && !drained)) {
      throw new Error(`SyncEngineLevel: ${direction} MessagesQuery cursor did not advance for ${link.tenantDid} -> ${dwnUrl}`);
    }
  }

  private async admitRemoteFeedEntry(
    target: SyncTarget,
    entry: MessagesQueryReplyEntry,
    shouldContinue?: () => boolean,
  ): Promise<
    | { kind: 'aborted' }
    | { kind: 'admitted'; appliedCids: string[] }
    | { kind: 'dead-lettered' }
    | { kind: 'deferred'; detail?: string }
  > {
    if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
      return { kind: 'aborted' };
    }

    const prefetched = await this.syncEntriesFromFeedEntry(target, entry);
    const outcome = await admitClosure(entry.messageCid, {
      did                : target.did,
      dwnUrl             : target.dwnUrl,
      delegateDid        : target.delegateDid,
      permissionGrantIds : target.permissionGrantIds,
      scope              : target.scope,
      agent              : this.agent,
      permissionsApi     : this._permissionsApi,
      prefetched,
      shouldContinue,
    });

    if (outcome.kind === 'admitted') {
      return { kind: 'admitted', appliedCids: outcome.appliedCids };
    }

    if (outcome.kind === 'deferred') {
      return { kind: 'deferred', detail: outcome.detail };
    }

    await this.recordDeadLetter({
      messageCid     : entry.messageCid,
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      protocol       : SyncEngineLevel.protocolFromFeedEntry(entry, prefetched),
      category       : 'admit-failed',
      errorCode      : outcome.reason,
      errorDetail    : outcome.detail ?? 'replicated message admission failed',
    });
    return { kind: 'dead-lettered' };
  }

  private async syncEntriesFromFeedEntry(
    target: SyncTarget,
    entry: MessagesQueryReplyEntry,
  ): Promise<SyncMessageEntry[]> {
    if (entry.message === undefined) {
      const fetched = await fetchRemoteMessages({
        did                : target.did,
        dwnUrl             : target.dwnUrl,
        delegateDid        : target.delegateDid,
        permissionGrantIds : target.permissionGrantIds,
        messageCids        : [entry.messageCid],
        agent              : this.agent,
      });
      return fetched.map((fetchedEntry): SyncMessageEntry => ({
        ...fetchedEntry,
        isLatestBaseState: entry.isLatestBaseState,
      }));
    }

    const message = { ...entry.message };
    const messageEncodedData = message.encodedData;
    delete message.encodedData;
    const syncEntry: SyncMessageEntry = {
      message,
      isLatestBaseState: entry.isLatestBaseState,
    };
    const encodedData = entry.encodedData ?? messageEncodedData;
    if (encodedData !== undefined) {
      syncEntry.bufferedData = Encoder.base64UrlToBytes(encodedData);
    } else if (SyncEngineLevel.recordsWriteRequiresRemoteData(message)) {
      syncEntry.dataStreamFactory = async (): Promise<ReadableStream<Uint8Array> | undefined> => {
        const fetched = await fetchRemoteMessages({
          did                : target.did,
          dwnUrl             : target.dwnUrl,
          delegateDid        : target.delegateDid,
          permissionGrantIds : target.permissionGrantIds,
          messageCids        : [entry.messageCid],
          agent              : this.agent,
        });
        return fetched[0]?.dataStream;
      };
    }

    return [syncEntry];
  }

  private static messageFeedFiltersForScope(scope: SyncScope): MessagesFilter[] | undefined {
    if (scope.kind === 'full') {
      return undefined;
    }

    return scope.protocols.map(protocol => ({ protocol }));
  }

  private static protocolFromFeedEntry(
    entry: MessagesQueryReplyEntry,
    prefetched: SyncMessageEntry[],
  ): string | undefined {
    if (entry.protocol !== undefined) {
      return entry.protocol;
    }

    return SyncEngineLevel.protocolFromDescriptor(entry.message?.descriptor) ??
      SyncEngineLevel.protocolFromDescriptor(prefetched[0]?.message.descriptor);
  }

  private static protocolFromDescriptor(descriptor: GenericMessage['descriptor'] | undefined): string | undefined {
    if (descriptor === undefined || !('protocol' in descriptor) || typeof descriptor.protocol !== 'string') {
      return undefined;
    }

    return descriptor.protocol;
  }

  private static recordsWriteRequiresRemoteData(message: GenericMessage): boolean {
    const { descriptor } = message;
    return descriptor.interface === DwnInterfaceName.Records &&
      descriptor.method === DwnMethodName.Write &&
      'dataCid' in descriptor &&
      typeof descriptor.dataCid === 'string';
  }

  private static hasUnmaterializedRecordsWriteData(entry: SyncMessageEntry): boolean {
    const { descriptor } = entry.message;
    const dataSize = (descriptor as { dataSize?: unknown }).dataSize;
    if (
      descriptor.interface !== DwnInterfaceName.Records ||
      descriptor.method !== DwnMethodName.Write ||
      typeof dataSize !== 'number' ||
      dataSize <= 0
    ) {
      return false;
    }

    return entry.dataStream === undefined &&
      entry.bufferedData === undefined &&
      typeof (entry.message as { encodedData?: unknown }).encodedData !== 'string';
  }

  private static shouldAbortReconcile(shouldContinue?: () => boolean): boolean {
    return shouldContinue?.() === false;
  }

  // ---------------------------------------------------------------------------
  // Per-link reconciliation
  // ---------------------------------------------------------------------------

  /** Active reconcile timers, keyed by link key. */
  private readonly _reconcileTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Scheduled wall-clock time for each reconcile timer, so earlier work can preempt a quota timer. */
  private readonly _reconcileTimerDueAt: Map<string, number> = new Map();

  /** Active reconcile operations, keyed by link key (dedup). */
  private readonly _reconcileInFlight: Map<string, Promise<void>> = new Map();

  /**
   * Schedule a per-link reconciliation after a short debounce. Coalesces
   * repeated requests for the same link.
   */
  private scheduleReconcile(linkKey: string, delayMs: number = 1500): boolean {
    if (this._activeRepairs.has(linkKey)) { return false; }

    const normalizedDelay = Math.max(0, delayMs);
    const dueAt = Date.now() + normalizedDelay;
    const existingTimer = this._reconcileTimers.get(linkKey);
    if (existingTimer !== undefined) {
      const existingDueAt = this._reconcileTimerDueAt.get(linkKey);
      if (existingDueAt !== undefined && existingDueAt <= dueAt) {
        return false;
      }
      clearTimeout(existingTimer);
      this._reconcileTimers.delete(linkKey);
      this._reconcileTimerDueAt.delete(linkKey);
    }

    const generation = this._engineGeneration;
    const timer = setTimeout((): void => {
      this._reconcileTimers.delete(linkKey);
      this._reconcileTimerDueAt.delete(linkKey);
      if (this._engineGeneration !== generation) { return; }
      // Guard: bail if this link was hot-removed since the timer was
      // scheduled. Without this, a stale timer could restart reconcile
      // work for a DID that is no longer active.
      if (!this._activeLinks.has(linkKey)) { return; }
      void this.reconcileLink(linkKey).catch((): void => {
        // Errors are already logged inside doReconcileLink; swallow here
        // to prevent unhandled-rejection flakes in the test runner.
      });
    }, normalizedDelay);
    this._reconcileTimers.set(linkKey, timer);
    this._reconcileTimerDueAt.set(linkKey, dueAt);
    return true;
  }

  /**
   * Run durable feed reconciliation for a single link. Deduplicates concurrent calls.
   * On success, emits completion. On failure, schedules retry.
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
   * same durable feed pull/push that `sync()` does, but scoped to one link.
   */
  private async doReconcileLink(linkKey: string): Promise<void> {
    const link = this._activeLinks.get(linkKey);
    if (!link) { return; }

    // Only reconcile live links — repairing links have their own
    // recovery path.
    if (link.status !== 'live') {
      return;
    }

    // Skip if a repair is in progress for this link.
    if (this._activeRepairs.has(linkKey)) {
      return;
    }

    const generation = this._engineGeneration;

    // Identity guard: if the DID was hot-removed and re-added, this
    // callback's captured `link` reference may no longer be the active
    // link object. Bail before mutating the replacement's state.
    const isStaleLink = (): boolean => this._activeLinks.get(linkKey) !== link;
    const shouldContinue = (): boolean =>
      this._engineGeneration === generation &&
      !isStaleLink() &&
      link.status === 'live';

    const { tenantDid: did, remoteEndpoint: dwnUrl, delegateDid, scope, authorization } = link;
    const eventScope = syncEventScope(scope);
    const reconcileTarget: SyncTarget = {
      did,
      dwnUrl,
      delegateDid,
      projectionId       : link.projectionId,
      scope,
      authorization,
      authorizationEpoch : link.authorizationEpoch,
      permissionGrantIds : this.getAuthorizationGrantIds(authorization),
    };

    try {
      const reconcileOutcome = await this.syncTargetWithDurableFeeds(reconcileTarget, { verifyConvergence: true }, shouldContinue);
      if (reconcileOutcome.aborted || isStaleLink()) { return; }
      if (reconcileOutcome.admittedCids !== undefined && reconcileOutcome.admittedCids.length > 0) {
        this.emitEvent({
          type           : 'reconcile:applied',
          tenantDid      : did,
          remoteEndpoint : dwnUrl,
          ...eventScope,
          messageCids    : reconcileOutcome.admittedCids,
        });
      }

      const pushFailures = reconcileOutcome.pushFailures ?? [];
      if (pushFailures.length > 0) {
        await this.handleReconcilePushFailures(linkKey, link, pushFailures);
        return;
      }

      if (reconcileOutcome.converged) {
        this._feedConvergenceFailures.delete(linkKey);
        this.emitEvent({ type: 'reconcile:completed', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope });
      } else if (!isStaleLink()) {
        // Feed fingerprints still differ — retry after a delay. This can
        // happen when push retries were exhausted, remote admission partially
        // failed, or new writes arrived during reconciliation.
        await this.handleVerifiedFeedDivergence(reconcileTarget, reconcileOutcome, { link, linkKey });
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
    scope?: SyncScope;
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
   * in dependency order.
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
      agent          : this.agent,
      permissionsApi : this._permissionsApi,
    });
  }

  // ---------------------------------------------------------------------------
  // Dead letter tracking
  // ---------------------------------------------------------------------------

  /**
   * Build a compound dead letter key. Different tenants and remotes can fail
   * the same CID for different reasons, so the durable key includes both.
   */
  private static deadLetterKey(tenantDid: string, messageCid: string, remoteEndpoint?: string): string {
    return `${tenantDid}|${messageCid}|${remoteEndpoint ?? ''}`;
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
    const key = SyncEngineLevel.deadLetterKey(params.tenantDid, params.messageCid, params.remoteEndpoint);
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

  private async hasAdmissionDeadLetter(
    tenantDid: string,
    remoteEndpoint: string,
    messageCid: string,
  ): Promise<boolean> {
    const key = SyncEngineLevel.deadLetterKey(tenantDid, messageCid, remoteEndpoint);
    try {
      const value = await this._deadLetters.get(key);
      const entry = JSON.parse(value) as DeadLetterEntry;
      return entry.tenantDid === tenantDid && entry.category === 'admit-failed';
    } catch (error) {
      const e = error as { code?: string };
      if (e.code === 'LEVEL_NOT_FOUND') { return false; }
      throw error;
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
    // Clear all matching entries. The durable key includes tenant, but this
    // API intentionally clears by message CID and optional remote regardless
    // of tenant, matching the previous public contract.
    let found = false;
    const batch: { type: 'del'; key: string }[] = [];
    for await (const [key, value] of this._deadLetters.iterator()) {
      const entry = JSON.parse(value) as DeadLetterEntry;
      if (entry.messageCid === messageCid && (remoteEndpoint === undefined || entry.remoteEndpoint === remoteEndpoint)) {
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
    let admissionFailureCount = 0;
    for await (const [, value] of this._deadLetters.iterator()) {
      failedMessageCount++;
      const entry = JSON.parse(value) as DeadLetterEntry;
      if (entry.category === 'admit-failed') {
        admissionFailureCount++;
      }
    }

    const currentQuotaLinkKeys = await this.getCurrentQuotaLinkKeys();
    let quotaBlockedMessageCount = 0;
    for await (const [, value] of this._quotaBlocks.iterator()) {
      const state = JSON.parse(value) as QuotaBlockState;
      if (state.supersededAt !== undefined) { continue; }
      if (currentQuotaLinkKeys === undefined || currentQuotaLinkKeys.has(state.linkKey)) {
        quotaBlockedMessageCount++;
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
      connectivity             : this.connectivityState,
      failedMessageCount       : failedMessageCount,
      admissionFailureCount    : admissionFailureCount,
      degradedLinkCount        : degradedLinkCount,
      quotaBlockedMessageCount : quotaBlockedMessageCount,
      syncHealthy              : failedMessageCount === 0 && degradedLinkCount === 0 && quotaBlockedMessageCount === 0,
    };
  }

  public async getRemoteSyncStatus(tenantDid?: string): Promise<RemoteSyncStatus[]> {
    type Accumulator = {
      tenantDid: string;
      remoteEndpoint: string;
      connectivity: SyncConnectivityState;
      quotaBlockedMessageCount: number;
      failedMessageCount: number;
      degraded: boolean;
      nextProbeAt?: string;
      lastError?: string;
      lastErrorAt?: string;
      lastActivityAt?: string;
    };
    const rows = new Map<string, Accumulator>();
    const rowKey = (did: string, remote: string): string => `${did}|${remote}`;
    const rowFor = (did: string, remote: string): Accumulator => {
      const key = rowKey(did, remote);
      let row = rows.get(key);
      if (row === undefined) {
        row = { tenantDid: did, remoteEndpoint: remote, connectivity: 'unknown', quotaBlockedMessageCount: 0, failedMessageCount: 0, degraded: false };
        rows.set(key, row);
      }
      return row;
    };
    const matchesTenant = (did: string): boolean => tenantDid === undefined || did === tenantDid;

    // Durable links seed connectivity + degraded state per (tenant, remote).
    const currentLinkIdentityKeys = await this.getCurrentDurableLinkIdentityKeys();
    const currentQuotaLinkKeys = await this.getCurrentQuotaLinkKeys();
    for (const link of await this.ledger.getAllLinks()) {
      if (!matchesTenant(link.tenantDid)) { continue; }
      const isCurrentLink = currentLinkIdentityKeys === undefined || currentLinkIdentityKeys.has(this.getDurableLinkIdentityKey(link));
      if (!isCurrentLink) { continue; }
      const row = rowFor(link.tenantDid, link.remoteEndpoint);
      if (link.connectivity === 'offline') { row.connectivity = 'offline'; }
      else if (row.connectivity !== 'offline' && link.connectivity === 'online') { row.connectivity = 'online'; }
      if (SyncEngineLevel.isUnhealthyLinkStatus(link.status)) { row.degraded = true; }
      if (link.lastActivityAt !== undefined) {
        row.lastActivityAt = SyncEngineLevel.latestTimestamp(row.lastActivityAt, link.lastActivityAt);
      }
    }

    // Quota blocks: count, soonest next probe, latest detail.
    for await (const [, value] of this._quotaBlocks.iterator()) {
      const state = JSON.parse(value) as QuotaBlockState;
      if (!matchesTenant(state.tenantDid)) { continue; }
      if (currentQuotaLinkKeys !== undefined && !currentQuotaLinkKeys.has(state.linkKey)) { continue; }
      if (state.supersededAt !== undefined) { continue; }
      const row = rowFor(state.tenantDid, state.remoteEndpoint);
      row.quotaBlockedMessageCount++;
      row.nextProbeAt = SyncEngineLevel.earliestTimestamp(row.nextProbeAt, state.nextProbeAt);
      // Quota blocks feed lastErrorAt directly; blocked-at and error-at coincide here
      // and only diverge once the dead-letter loop below records a later failure.
      if (row.lastErrorAt === undefined || lexicographicalCompare(state.lastBlockedAt, row.lastErrorAt) > 0) {
        row.lastErrorAt = state.lastBlockedAt;
        row.lastError = state.detail;
      }
    }

    // Dead letters: terminal failure counts per (tenant, remote).
    for await (const [, value] of this._deadLetters.iterator()) {
      const entry = JSON.parse(value) as DeadLetterEntry;
      if (!matchesTenant(entry.tenantDid) || entry.remoteEndpoint === undefined) { continue; }
      const row = rowFor(entry.tenantDid, entry.remoteEndpoint);
      row.failedMessageCount++;
      row.degraded = true;
      if (row.lastErrorAt === undefined || lexicographicalCompare(entry.failedAt, row.lastErrorAt) > 0) {
        row.lastErrorAt = entry.failedAt;
        row.lastError = entry.errorDetail;
      }
    }

    return [...rows.values()]
      .map((row): RemoteSyncStatus => ({
        tenantDid                : row.tenantDid,
        remoteEndpoint           : row.remoteEndpoint,
        state                    : SyncEngineLevel.rollUpRemoteState(row),
        connectivity             : row.connectivity,
        quotaBlockedMessageCount : row.quotaBlockedMessageCount,
        failedMessageCount       : row.failedMessageCount,
        ...(row.nextProbeAt === undefined ? {} : { nextProbeAt: row.nextProbeAt }),
        ...(row.lastError === undefined ? {} : { lastError: row.lastError }),
        ...(row.lastActivityAt === undefined ? {} : { lastActivityAt: row.lastActivityAt }),
      }))
      .sort((a, b) => lexicographicalCompare(rowKey(a.tenantDid, a.remoteEndpoint), rowKey(b.tenantDid, b.remoteEndpoint)));
  }

  private static rollUpRemoteState(
    row: { connectivity: SyncConnectivityState; quotaBlockedMessageCount: number; failedMessageCount: number; degraded: boolean },
  ): RemoteSyncState {
    if (row.connectivity === 'offline') { return 'offline'; }
    if (row.quotaBlockedMessageCount > 0) { return 'quota-blocked'; }
    if (row.degraded || row.failedMessageCount > 0) { return 'degraded'; }
    return 'healthy';
  }

  public async retryRemoteNow(tenantDid: string, remoteEndpoint: string): Promise<void> {
    const generation = this._engineGeneration;
    const retry = this._retryRemoteQueue.then(async (): Promise<void> => {
      await this.doRetryRemoteNow(tenantDid, remoteEndpoint, generation);
    });
    this._retryRemoteQueue = retry.catch((): void => {
      // Keep the queue usable after surfacing the original operation failure.
    });
    await retry;
  }

  private async doRetryRemoteNow(tenantDid: string, remoteEndpoint: string, generation: number): Promise<void> {
    // A normal sync/drain already owns the feed checkpoints. Let that operation
    // finish, then preserve the explicit retry request rather than racing its
    // checkpoint writes or silently dropping a UI Retry-now action.
    await this.waitForAndAcquireSyncLock();

    try {
      if (this._engineGeneration !== generation) {
        return;
      }
      const topologyGeneration = this._syncTargetsCacheGeneration;
      const targets = (await this.getSyncTargets()).filter(
        (target) => target.did === tenantDid && target.dwnUrl === remoteEndpoint,
      );

      await Promise.all(targets.map(async (target) => {
        await this.retryQuotaBlocksForTarget(target, generation, topologyGeneration);
      }));
    } finally {
      this.releaseSyncLock();
    }
  }

  private async retryQuotaBlocksForTarget(
    target: SyncTarget,
    generation: number,
    topologyGeneration: number,
  ): Promise<void> {
    const { linkKey } = this.quotaBlockIdentity(target);
    const key = `${linkKey}|__retry-target__`;
    const existing = this._quotaProbeInFlight.get(key);
    if (existing !== undefined) {
      await existing;
      return;
    }

    const retry = (async (): Promise<void> => {
      const blocks = await this.getQuotaBlocksForTarget(target);
      if (
        blocks.length === 0 ||
        this._engineGeneration !== generation ||
        this._syncTargetsCacheGeneration !== topologyGeneration
      ) {
        return;
      }

      // Reconcile this exact projection/authorization link before forcing any
      // remaining direct probes. A later delete/update can therefore replay a
      // retained dataless ancestor as its dependency instead of exposing that
      // ancestor as standalone remote state.
      await this.syncTargetWithDurableFeeds(
        target,
        { direction: 'push', forceQuotaProbe: true },
        (): boolean =>
          this._engineGeneration === generation &&
          this._syncTargetsCacheGeneration === topologyGeneration,
      );
    })().finally((): void => {
      if (this._quotaProbeInFlight.get(key) === retry) {
        this._quotaProbeInFlight.delete(key);
      }
    });
    this._quotaProbeInFlight.set(key, retry);
    await retry;
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

  private async getCurrentQuotaLinkKeys(): Promise<Set<string> | undefined> {
    try {
      const targets = await this.getSyncTargets();
      if (!this._syncTargetsLastResolutionComplete || targets.length === 0) {
        return undefined;
      }

      return new Set(targets.map((target) => this.quotaBlockIdentity(target).linkKey));
    } catch (error: unknown) {
      console.warn('SyncEngineLevel: Failed to resolve current quota link keys for health; falling back to all quota blocks', error);
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
    return status === 'repairing' || status === 'paused';
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
      this._syncTargetsLastResolutionComplete = true;
      return this._syncTargetsCache.targets;
    }

    // Capture the generation before any async work so we can detect
    // concurrent invalidations (register/unregister/update) that would
    // make our result stale.
    const generationAtStart = this._syncTargetsCacheGeneration;

    const targets: SyncTarget[] = [];
    let hasRegisteredIdentities = false;
    let anyTargetUnavailable = false;
    this._syncTargetsLastResolutionComplete = false;

    for await (const [did, options] of this._db.sublevel('registeredIdentities').iterator()) {
      hasRegisteredIdentities = true;
      let parsed: SyncIdentityOptions;
      try {
        parsed = JSON.parse(options) as SyncIdentityOptions;
      } catch (error: unknown) {
        anyTargetUnavailable = true;
        console.warn(`SyncEngineLevel: Corrupt sync options for ${did}, skipping identity:`, error);
        continue;
      }

      const dwnEndpointUrls = await this.getSyncEndpointUrls(did);
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
    const generationIsCurrent = this._syncTargetsCacheGeneration === generationAtStart;
    this._syncTargetsLastResolutionComplete = !anyTargetUnavailable && generationIsCurrent;
    const isComplete = hasRegisteredIdentities && this._syncTargetsLastResolutionComplete;
    if (targets.length > 0 && isComplete && this._syncTargetsCacheGeneration === generationAtStart) {
      await this.pruneQuotaBlocksForCurrentTargets(targets, generationAtStart);
      if (this._syncTargetsCacheGeneration === generationAtStart) {
        this._syncTargetsCache = { targets, timestamp: Date.now() };
      } else {
        this._syncTargetsLastResolutionComplete = false;
      }
    }
    return targets;
  }

}
