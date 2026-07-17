import type { AbstractLevel } from 'abstract-level';

import type { DwnSubscriptionHandler, ResubscribeFactory } from '@enbox/dwn-clients';
import type { GenericMessage, MessageEvent, MessagesFilter, MessagesQueryReply, MessagesQueryReplyEntry, MessagesSubscribeReply, ProgressToken, RecordsQueryReply, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import { RateLimitError } from '@enbox/dwn-clients';
import { DwnErrorCode, DwnInterfaceName, DwnMethodName, Encoder, Message } from '@enbox/dwn-sdk-js';
import { parseDurationInMilliseconds, sleep } from '@enbox/common';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { SyncDeadLetterStore } from './sync-dead-letter-store.js';
import type { SyncEndpointStore } from './sync-endpoint-store.js';
import type { SyncIdentityStore } from './sync-identity-store.js';
import type { SyncMessageEntry } from './sync-messages.js';
import type { SyncReplicationLinkStore } from './sync-replication-link-store.js';
import type { SyncRunOptions } from './sync-run-coordinator.js';
import type {
  DeadLetterCategory,
  DeadLetterEntry,
  NonEmptyStringArray,
  PushFailure,
  PushResult,
  RemoteSyncStatus,
  ReplicationLinkState,
  StartSyncParams,
  SyncAuthorization,
  SyncConnectivityState,
  SyncDirection,
  SyncDrainOptions,
  SyncDrainResult,
  SyncEngine,
  SyncEvent,
  SyncEventListener,
  SyncEventScope,
  SyncHealthSummary,
  SyncIdentityOptions,
  SyncMode,
  SyncScope,
} from './types/sync.js';
import type {
  SyncDurableFeedPageAdmissionResult as FeedPageAdmissionResult,
  SyncDurableFeedPagePushResult as FeedPagePushResult,
  SyncDurableFeedPermissionGrantBootstrapResult as PermissionGrantBootstrapResult,
  SyncDurableFeedQuery,
  SyncDurableFeedReconcileOptions as SyncReconcileOptions,
  SyncDurableFeedReconcileResult as SyncReconcileResult,
} from './sync-durable-feed-reconciler.js';
import type { SyncDeferredPullState, SyncDeferredPullStore } from './sync-deferred-pull-store.js';
import type { SyncEndpointDiscovery, SyncTarget } from './sync-target-resolver.js';
import type { SyncPushRuntimeEntry, SyncPushRuntimeState } from './sync-link-controller.js';
import type { SyncQuotaBlockEntry, SyncQuotaPushResultTransition } from './sync-quota-manager.js';
import type { SyncQuotaBlockSource, SyncQuotaBlockState } from './sync-quota-store.js';
import type {
  SyncScopeClosureGrantQuery,
  SyncScopeClosureGrantResolution,
  SyncScopeProtocolHistoryPage,
  SyncScopeProtocolHistoryQuery,
} from './sync-scope-closure-validator.js';

import { AgentPermissionsApi } from './permissions-api.js';

import { admitClosure } from './sync-admit-closure.js';
import { classifySyncEventScope } from './sync-scope-acceptance.js';
import { DwnInterface } from './types/dwn.js';
import { isRecordsWrite } from './utils.js';
import { SyncCheckpoint } from './sync-checkpoint.js';
import { SyncConnectivityManager } from './sync-connectivity-manager.js';
import { SyncDeadLetterStoreLevel } from './sync-dead-letter-store-level.js';
import { SyncDeferredPullStoreLevel } from './sync-deferred-pull-store-level.js';
import { SyncDrainCoordinator } from './sync-drain-coordinator.js';
import { SyncDurableFeedReconciler } from './sync-durable-feed-reconciler.js';
import { SyncEchoSuppressor } from './sync-echo-suppressor.js';
import { SyncEndpointStoreLevel } from './sync-endpoint-store-level.js';
import { SyncFeedConvergenceManager } from './sync-feed-convergence-manager.js';
import { SyncIdentityStoreLevel } from './sync-identity-store-level.js';
import { SyncLifecycleCoordinator } from './sync-lifecycle-coordinator.js';
import { SyncLinkController } from './sync-link-controller.js';
import { SyncQuotaManager } from './sync-quota-manager.js';
import { SyncQuotaStoreLevel } from './sync-quota-store-level.js';
import { SyncReplicationLinkStoreLevel } from './sync-replication-link-store-level.js';
import { SyncRunCoordinator } from './sync-run-coordinator.js';
import { SyncScopeClosureValidator } from './sync-scope-closure-validator.js';
import { SyncStatusReporter } from './sync-status-reporter.js';
import { SyncTargetPlanner } from './sync-target-planner.js';
import { buildDurableLinkIdentityKey, buildLinkId } from './sync-link-id.js';
import { computeProjectionId, isTerminalPushFailure, lexicographicalCompare, protocolsForSyncScope, pushBatchReconcileReason, singleProtocolForSyncScope, syncScopeFromProtocols } from './types/sync.js';
import { fetchRemoteMessages, getLocalMessage, pushMessageEntries, pushMessages, queryLocalMessageFeed, queryRemoteMessageFeed, SyncPullAbortedError } from './sync-messages.js';
import { getMessagesPermissionGrantsForScope, permissionGrantIdsFromEntries, SyncProtocolRootPermissionGrantMissingError, toMessagesPermissionGrantIds } from './sync-permission-grants.js';
import { normalizeDwnEndpoint, SyncTargetResolver } from './sync-target-resolver.js';

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

/** Maximum concurrent live-pull deliveries waiting for earlier ordinals to commit. */
const MAX_IN_FLIGHT_PULL_DELIVERIES = 100;

type LinkSyncTarget = SyncTarget & { linkKey: string };

enum LinkSubscriptionOpenResult {
  Inactive = 'inactive',
  ReadyForLive = 'readyForLive',
  Repairing = 'repairing',
}

enum LinkInitializationStatus {
  Active = 'active',
  Failed = 'failed',
}

type LinkInitializationResult =
  | { status: LinkInitializationStatus.Active; durableLinkIdentityKey: string }
  | { status: LinkInitializationStatus.Failed };

type FeedPushEntryResult =
  | { kind: 'aborted' }
  | { kind: 'pushed' }
  | { kind: 'skipped' }
  | { kind: 'failed'; failures: PushFailure[] };

type PushFlushBatch = {
  controller: SyncLinkController;
  pushRuntime: SyncPushRuntimeState;
  pushEntries: SyncPushRuntimeEntry[];
  isStale: () => boolean;
};

type LivePullContext = {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  eventScope: SyncEventScope;
  controller?: SyncLinkController;
  linkKey: string;
  link?: ReplicationLinkState;
  permissionGrantIds?: NonEmptyStringArray;
  isStale: () => boolean;
};

type PullDelivery = {
  controller?: SyncLinkController;
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
  private readonly _connectivityManager: SyncConnectivityManager;
  private readonly _deadLetterStore: SyncDeadLetterStore;
  private readonly _deferredPullStore: SyncDeferredPullStore;
  private readonly _drainCoordinator: SyncDrainCoordinator;
  private readonly _echoSuppressor = new SyncEchoSuppressor();
  private readonly _endpointStore: SyncEndpointStore;
  private readonly _durableFeedReconciler: SyncDurableFeedReconciler;
  private readonly _feedConvergenceManager: SyncFeedConvergenceManager;
  private readonly _identityStore: SyncIdentityStore;
  private readonly _lifecycle = new SyncLifecycleCoordinator();
  private readonly _quotaManager: SyncQuotaManager;
  private readonly _runCoordinator: SyncRunCoordinator;
  private readonly _scopeClosureValidator: SyncScopeClosureValidator;
  private readonly _statusReporter: SyncStatusReporter;
  private readonly _targetPlanner: SyncTargetPlanner;
  private _targetResolver?: SyncTargetResolver;
  private _syncIntervalId?: ReturnType<typeof setInterval>;

  /**
   * Durable replication ledger — persists per-link checkpoint state.
   * Used by live sync to track pull progression per link.
   * Lazily initialized on first use to avoid sublevel() calls on mock dbs.
   */
  private _ledger?: SyncReplicationLinkStore;

  /** Active link lifetimes and their backend-neutral ephemeral state. */
  private readonly _linkControllers: Map<string, SyncLinkController> = new Map();

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

  /** Registered event listeners for observability. */
  private readonly _eventListeners: Set<SyncEventListener> = new Set();

  /** In-flight Retry-now target reconciliations, keyed by complete replication link. */
  private readonly _quotaRetryInFlight: Map<string, Promise<void>> = new Map();

  /** Serializes public Retry-now operations with each other before they acquire the sync lock. */
  private _retryRemoteQueue: Promise<void> = Promise.resolve();

  /** Backoff schedule for recently published did:dht records. */
  private static readonly DID_RESOLUTION_RETRY_BACKOFF_MS = [2000, 4000, 8000];

  constructor({ agent, dataPath, db }: SyncEngineLevelParams) {
    this._agent = agent;
    this._permissionsApi = new AgentPermissionsApi({ agent });
    this._db = db ?? new Level<string, string>(dataPath ?? 'DATA/AGENT/SYNC_STORE');
    this._deadLetterStore = new SyncDeadLetterStoreLevel(this._db);
    this._deferredPullStore = new SyncDeferredPullStoreLevel(this._db);
    this._connectivityManager = new SyncConnectivityManager({
      operations: {
        getGeneration          : (): number => this._engineGeneration,
        isSyncInProgress       : (): boolean => this._lifecycle.isSyncInProgress,
        markActiveLinksOffline : (): void => { this.markActiveLinksOffline(); },
        runBackgroundTask      : (operation): Promise<void> => this._lifecycle.runBackgroundTask(operation),
        runIntegrityCheck      : (): Promise<void> => this.sync(undefined, { verifyConvergence: true }),
      },
    });
    this._endpointStore = new SyncEndpointStoreLevel(this._db);
    this._identityStore = new SyncIdentityStoreLevel(this._db);
    this._drainCoordinator = new SyncDrainCoordinator({
      identityStore : this._identityStore,
      operations    : {
        buildTargetsForEndpoint: (did, remoteEndpoint, options): Promise<SyncTarget[]> =>
          this.targetResolver.buildTargetsForEndpoint(did, remoteEndpoint, options),
        clearFeedConvergenceFailure: (target): Promise<void> =>
          this._feedConvergenceManager.clear(target),
        getLink                      : (target): Promise<ReplicationLinkState> => this.getOrCreateReplicationLink(target),
        getQuotaBlockCount           : async (target): Promise<number> => (await this.getQuotaBlocksForTarget(target)).length,
        getTopologyGeneration        : (): number => this._targetPlanner.generation,
        handleVerifiedFeedDivergence : (target, result): Promise<boolean> =>
          this._feedConvergenceManager.handleVerifiedDivergence(target, result),
        onReconcileApplied : (target, messageCids): void => { this.emitReconcileApplied(target, messageCids); },
        prepareLiveTarget  : (target): Promise<void> => this.prepareDrainLiveTarget(target),
        reconcileTarget    : (target, options, shouldContinue): Promise<SyncReconcileResult> =>
          this.syncTargetWithDurableFeeds(target, options, shouldContinue),
        recordConnectivityFailure : (): void => { this._connectivityManager.recordFailure(); },
        recordConnectivitySuccess : (): void => { this._connectivityManager.recordSuccess(); },
        recordPushFailures        : async (target, failures): Promise<void> => {
          await this.recordTerminalSyncPushFailures(target, failures);
        },
        registerEndpoint: (remoteEndpoint): Promise<void> =>
          this.registerSupplementalDwnEndpoint(remoteEndpoint),
        verifyConvergence: (target, shouldContinue): Promise<SyncReconcileResult> =>
          this.verifyFeedConvergence(target, shouldContinue),
      },
    });
    this._runCoordinator = new SyncRunCoordinator({
      operations: {
        clearFeedConvergenceFailure: (target): Promise<void> =>
          this._feedConvergenceManager.clear(target),
        getTargets                   : (): Promise<SyncTarget[]> => this.getSyncTargets(),
        handleVerifiedFeedDivergence : async (target, result): Promise<void> => {
          await this._feedConvergenceManager.handleVerifiedDivergence(target, result);
        },
        onReconcileApplied : (target, messageCids): void => { this.emitReconcileApplied(target, messageCids); },
        reconcileTarget    : (target, direction, verifyConvergence): Promise<SyncReconcileResult> =>
          this.syncTargetWithDurableFeeds(target, { direction, verifyConvergence }),
        recordConnectivityFailure : (): void => { this._connectivityManager.recordFailure(); },
        recordConnectivitySuccess : (): void => { this._connectivityManager.recordSuccess(); },
        recordPushFailures        : (target, failures): Promise<number> =>
          this.recordTerminalSyncPushFailures(target, failures),
        reportError: (message, error): void => { console.error(message, error); },
      },
    });
    this._scopeClosureValidator = new SyncScopeClosureValidator({
      operations: {
        queryProtocolHistory: (query): Promise<SyncScopeProtocolHistoryPage> =>
          this.queryScopeProtocolHistory(query),
        resolvePermissionGrantIds: (query): Promise<SyncScopeClosureGrantResolution> =>
          this.resolveScopeClosurePermissionGrantIds(query),
      },
    });
    this._quotaManager = new SyncQuotaManager({
      store      : new SyncQuotaStoreLevel(this._db),
      operations : {
        clearFailedMessage: (target, messageCid): Promise<void> =>
          this.clearFailedMessageForTenant(target.did, messageCid, target.dwnUrl),
        collectLocalFeedCids  : (target): Promise<Set<string> | undefined> => this.collectLocalFeedCids(target),
        collectRemoteFeedCids : (target): Promise<Set<string> | undefined> => this.collectRemoteFeedCids(target),
        getGeneration         : (): number => this._engineGeneration,
        getLocalMessage       : (target, messageCid): Promise<SyncMessageEntry | undefined> =>
          this.getLocalMessageForTarget(target, messageCid),
        onQuotaBlocked: (target, messageCid, detail, nextProbeAt): void => {
          this.emitEvent({
            type           : 'push:quota-blocked',
            tenantDid      : target.did,
            remoteEndpoint : target.dwnUrl,
            ...syncEventScope(target.scope),
            messageCid,
            ...(detail === undefined ? {} : { detail }),
            nextProbeAt,
          });
        },
        onQuotaCleared: (target, messageCid, resolution): void => {
          this.emitEvent({
            type           : 'push:quota-cleared',
            tenantDid      : target.did,
            remoteEndpoint : target.dwnUrl,
            ...syncEventScope(target.scope),
            messageCid,
            resolution,
          });
        },
        pushEntries: (target, entries): Promise<PushResult> => this.pushMessageEntries({
          did                : target.did,
          dwnUrl             : target.dwnUrl,
          delegateDid        : target.delegateDid,
          permissionGrantIds : target.permissionGrantIds,
          entries,
        }),
        pushMessages: (target, messageCids): Promise<PushResult> => this.pushMessages({
          did                : target.did,
          dwnUrl             : target.dwnUrl,
          delegateDid        : target.delegateDid,
          permissionGrantIds : target.permissionGrantIds,
          messageCids,
        }),
        recordTerminalFailure: (target, failure): Promise<void> =>
          this.recordTerminalQuotaFailure(target, failure),
      },
    });
    this._feedConvergenceManager = new SyncFeedConvergenceManager({
      operations: {
        getActiveLink           : (linkKey): ReplicationLinkState | undefined => this.getActiveLink(linkKey),
        getDeadLettersForTenant : (tenantDid): Promise<DeadLetterEntry[]> =>
          this._deadLetterStore.getForTenant(tenantDid),
        getLink             : (target): Promise<ReplicationLinkState> => this.getOrCreateReplicationLink(target),
        getLinkKey          : (target, link): string => this.getReplicationLinkKey(target, link),
        getNextQuotaProbeAt : (target): Promise<string | undefined> =>
          this.getNextQuotaProbeAtForTarget(target),
        isDivergenceExplained: (target, result): Promise<boolean> =>
          this.isFeedDivergenceExplainedByQuotaBlocks(target, result),
        isLinkKeyForTenant    : (linkKey, tenantDid): boolean => this.isLinkKeyForDid(linkKey, tenantDid),
        resetCheckpoints      : (link): Promise<void> => this.ledger.resetCheckpoints(link),
        scheduleLinkReconcile : (linkKey, link, reason, delayMs): void => {
          this.scheduleLinkReconcile(linkKey, link, reason, delayMs);
        },
        scheduleQuotaProbe: (linkKey, link, nextProbeAt): void => {
          this.scheduleQuotaProbeForActiveLink(linkKey, link, nextProbeAt);
        },
        transitionToPaused: (linkKey, link): Promise<void> => this.transitionToPaused(linkKey, link),
      },
    });
    this._durableFeedReconciler = new SyncDurableFeedReconciler({
      admitRemotePage: (target, entries, shouldContinue): Promise<FeedPageAdmissionResult> =>
        this.admitRemoteFeedPage(target, entries, shouldContinue),
      bootstrapRemotePermissionGrants: (
        target,
        shouldContinue,
        forceQuotaProbe,
      ): Promise<PermissionGrantBootstrapResult> =>
        this.bootstrapRemotePermissionGrants(target, shouldContinue, forceQuotaProbe),
      clearResolvedQuotaOmissions: (target): Promise<void> =>
        this.clearResolvedQuotaOmissionsForTarget(target),
      getLinkStore    : (): SyncReplicationLinkStore => this.ledger,
      getOrCreateLink : (target): Promise<ReplicationLinkState> =>
        this.getOrCreateReplicationLink(target),
      getQuotaBlockCids: async (target): Promise<string[]> =>
        (await this.getQuotaBlocksForTarget(target)).map(({ messageCid }) => messageCid),
      onCheckpointAdvanced : (link, direction): void => { this.emitCheckpointAdvance(link, direction); },
      onReconcileApplied   : (target, messageCids): void => { this.emitReconcileApplied(target, messageCids); },
      probeQuotaBlocks     : (target, force, forceProbeCids, shouldContinue): Promise<void> =>
        this.probeQuotaBlocksForTarget(target, force, forceProbeCids, shouldContinue),
      pushLocalPage: (target, entries, shouldContinue): Promise<FeedPagePushResult> =>
        this.pushLocalFeedPage(target, entries, shouldContinue),
      queryFeed: (query): Promise<MessagesQueryReply> => this.queryDurableFeed(query),
    });
    this._targetPlanner = new SyncTargetPlanner({
      getTargetResolver : (): SyncTargetResolver => this.targetResolver,
      identityStore     : this._identityStore,
      warn              : (message, error): void => { console.warn(message, error); },
    });
    this._statusReporter = new SyncStatusReporter({
      operations: {
        getConnectivityState       : (): SyncConnectivityState => this.connectivityState,
        getCurrentLinkIdentityKeys : (): Promise<Set<string> | undefined> => this.getCurrentDurableLinkIdentityKeys(),
        getCurrentQuotaLinkKeys    : (): Promise<Set<string> | undefined> => this.getCurrentQuotaLinkKeys(),
        getDeadLetters             : (): Promise<DeadLetterEntry[]> => this._deadLetterStore.getAll(),
        getLinks                   : (): Promise<ReplicationLinkState[]> => this.ledger.getAllLinks(),
        getQuotaBlocks             : (): Promise<SyncQuotaBlockState[]> => this._quotaManager.getAllStates(),
      },
    });
  }

  /** Lazy accessor for the replication ledger. */
  private get ledger(): SyncReplicationLinkStore {
    this._ledger ??= new SyncReplicationLinkStoreLevel(this._db);
    return this._ledger;
  }

  /** Lazy accessor bound to the current agent and permissions context. */
  private get targetResolver(): SyncTargetResolver {
    this._targetResolver ??= new SyncTargetResolver({
      endpointStore        : this._endpointStore,
      getEndpointDiscovery : (): SyncEndpointDiscovery => this.agent.dwn,
      permissionsApi       : this._permissionsApi,
    });

    return this._targetResolver;
  }

  private async resolveScopeClosurePermissionGrantIds(
    query: SyncScopeClosureGrantQuery,
  ): Promise<SyncScopeClosureGrantResolution> {
    try {
      const grants = await getMessagesPermissionGrantsForScope({
        did            : query.did,
        delegateDid    : query.delegateDid,
        protocols      : [query.protocol],
        messageType    : DwnInterface.MessagesQuery,
        permissionsApi : this._permissionsApi,
      });
      return {
        kind               : 'granted',
        permissionGrantIds : permissionGrantIdsFromEntries(grants),
      };
    } catch (error) {
      if (error instanceof SyncProtocolRootPermissionGrantMissingError) {
        return { kind: 'missing' };
      }
      throw error;
    }
  }

  private async queryScopeProtocolHistory(
    query: SyncScopeProtocolHistoryQuery,
  ): Promise<SyncScopeProtocolHistoryPage> {
    const { reply } = await this.agent.dwn.processRequest({
      author        : query.did,
      target        : query.did,
      messageType   : DwnInterface.MessagesQuery,
      granteeDid    : query.delegateDid,
      messageParams : {
        cursor  : query.cursor,
        filters : [{
          interface : DwnInterfaceName.Protocols,
          method    : DwnMethodName.Configure,
          protocol  : query.protocol,
        }],
        limit              : query.limit,
        permissionGrantIds : query.permissionGrantIds,
      },
    });
    return reply;
  }

  private async clearSyncDb(): Promise<void> {
    await this._deadLetterStore.clear();
    await this._deferredPullStore.clear();
    await this._quotaManager.clear();
    await this._identityStore.clear();
    await this.ledger.clear();
    await this._endpointStore.clear();
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
    this._targetResolver = undefined;
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
    this._targetPlanner.invalidate();
  }

  get hasActiveSubscriptions(): boolean {
    for (const controller of this._linkControllers.values()) {
      if (controller.hasLiveSubscription || controller.hasLocalSubscription) {
        return true;
      }
    }
    return false;
  }

  get connectivityState(): SyncConnectivityState {
    const linkStates = [...this._linkControllers.values()].map(({ link }) => link.connectivity);
    return this._connectivityManager.getState(linkStates);
  }

  private activateLink(linkKey: string, link: ReplicationLinkState): SyncLinkController {
    const pendingInitializationRetry = this._linkInitRetryTimers.get(linkKey);
    if (pendingInitializationRetry !== undefined) {
      clearTimeout(pendingInitializationRetry);
      this._linkInitRetryTimers.delete(linkKey);
    }

    const existing = this._linkControllers.get(linkKey);
    if (existing?.link === link && existing.isActive) {
      return existing;
    }

    if (existing !== undefined) {
      // Closing starts synchronously; the controller absorbs transport teardown
      // errors while the replacement lifetime is installed.
      void existing.shutdown();
    }
    const controller = new SyncLinkController(linkKey, link);
    this._linkControllers.set(linkKey, controller);
    return controller;
  }

  private getLinkController(linkKey: string): SyncLinkController | undefined {
    return this._linkControllers.get(linkKey);
  }

  private getActiveLink(linkKey: string): ReplicationLinkState | undefined {
    return this.getLinkController(linkKey)?.link;
  }

  private getMatchingLinkController(
    linkKey: string,
    link: ReplicationLinkState,
  ): SyncLinkController | undefined {
    const controller = this.getLinkController(linkKey);
    return controller?.link === link ? controller : undefined;
  }

  private removeLinkController(linkKey: string, expected?: SyncLinkController): void {
    const controller = this.getLinkController(linkKey);
    if (controller === undefined || (expected !== undefined && controller !== expected)) {
      return;
    }

    // Removal is synchronous for callback invalidation; subscription teardown
    // is best effort and cannot reject from the controller.
    void controller.shutdown();
    this._linkControllers.delete(linkKey);
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

  public clear(): Promise<void> {
    return this._lifecycle.runTransition(async (): Promise<void> => {
      await this.stopSyncRuntime();
      await this._permissionsApi.clear();
      await this.clearSyncDb();
    });
  }

  public close(): Promise<void> {
    return this._lifecycle.runTransition(async (): Promise<void> => {
      await this.stopSyncRuntime();
      await this._db.close();
    });
  }

  public registerIdentity(params: { did: string; options: SyncIdentityOptions }): Promise<void> {
    return this._lifecycle.runIdentityMutation(async (): Promise<void> => {
      await this.doRegisterIdentity(params);
    });
  }

  private async doRegisterIdentity({ did, options }: { did: string; options: SyncIdentityOptions }): Promise<void> {
    this._scopeClosureValidator.validateOptions(options);

    const existing = await this.getIdentityOptions(did);
    if (existing) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is already registered.`);
    }

    await this._scopeClosureValidator.validateClosure(did, options);
    await this._identityStore.set(did, options);
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

  public unregisterIdentity(did: string): Promise<void> {
    return this._lifecycle.runIdentityMutation(async (): Promise<void> => {
      await this.doUnregisterIdentity(did);
    });
  }

  private async doUnregisterIdentity(did: string): Promise<void> {
    const existing = await this.getIdentityOptions(did);
    if (!existing) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
    }

    // If live sync is active, hot-remove subscriptions for this identity.
    if (this._syncMode === 'live') {
      await this.removeIdentityFromLiveSync(did);
    }

    await this._identityStore.delete(did);
    this.invalidateSyncTargetsCache();
    await this.clearQuotaBlocksForTenant(did);
    await this.pruneSupersededDurableLinksForIdentity(did, new Set());
  }

  public async getIdentityOptions(did: string): Promise<SyncIdentityOptions | undefined> {
    try {
      return await this._identityStore.get(did);
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      throw new Error(`SyncEngineLevel: Error reading level: ${code}.`);
    }
  }

  public updateIdentityOptions(params: { did: string, options: SyncIdentityOptions }): Promise<void> {
    return this._lifecycle.runIdentityMutation(async (): Promise<void> => {
      await this.doUpdateIdentityOptions(params);
    });
  }

  private async doUpdateIdentityOptions({ did, options }: { did: string, options: SyncIdentityOptions }): Promise<void> {
    this._scopeClosureValidator.validateOptions(options);

    const existingOptions = await this.getIdentityOptions(did);
    if (!existingOptions) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
    }

    await this._scopeClosureValidator.validateClosure(did, options);
    await this._identityStore.set(did, options);
    this.invalidateSyncTargetsCache();

    const rebuildLiveLinks = this._syncMode === 'live' && this.hasActiveLinksForDid(did);
    if (rebuildLiveLinks) {
      await this.removeIdentityFromLiveSync(did);
    }

    // Scope/delegate changes define different replication links. A block from
    // the previous authorization must not suppress the replacement link's
    // first delivery attempt. Clear only after old link work has drained so it
    // cannot recreate stale state behind this cleanup.
    await this.clearQuotaBlocksForTenant(did);

    // Rebuild live subscriptions with the new options. Delegate/scope changes
    // derive a new authorization epoch, so durable links are not mutated in place.
    if (rebuildLiveLinks) {
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
    if (!this._lifecycle.tryAcquireSync()) {
      throw new Error('SyncEngineLevel: Sync operation is already in progress.');
    }

    try {
      await this._runCoordinator.run(direction, options);
    } finally {
      this._lifecycle.releaseSync();
    }
  }

  public async drainTo(endpoint: string, options: SyncDrainOptions = {}): Promise<SyncDrainResult> {
    if (this._lifecycle.isSyncInProgress) {
      throw new Error('SyncEngineLevel: Sync operation is already in progress.');
    }

    const normalizedEndpoint = normalizeDwnEndpoint(endpoint);
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

    if (!this._lifecycle.tryAcquireSync()) {
      throw new Error('SyncEngineLevel: Sync operation is already in progress.');
    }
    try {
      return await this._drainCoordinator.drain(normalizedEndpoint, options);
    } finally {
      this._lifecycle.releaseSync();
    }
  }

  /**
   * A drain endpoint is a durable handoff target, not only a one-shot URL.
   * When live sync is already running, open the new links before reconciling
   * so writes that race the drain continue to be delivered after parity.
   */
  private async prepareDrainLiveTarget(target: SyncTarget): Promise<void> {
    if (this._syncMode !== 'live') {
      return;
    }

    const link = await this.getOrCreateReplicationLink(target);
    const linkKey = this.getReplicationLinkKey(target, link);
    if (!this._linkControllers.has(linkKey)) {
      await this.initializeLinkTargetWithRetry(target);
    }
  }

  private async registerSupplementalDwnEndpoint(endpoint: string): Promise<void> {
    const existing = await this._endpointStore.get();
    if (existing === endpoint) {
      return;
    }

    await this._endpointStore.set(endpoint);
    this.invalidateSyncTargetsCache();
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // ---------------------------------------------------------------------------
  // startSync / stopSync
  // ---------------------------------------------------------------------------

  public startSync(params: StartSyncParams): Promise<void> {
    return this._lifecycle.runTransition(async (): Promise<void> => {
      await this.startSyncRuntime(params);
    });
  }

  private async startSyncRuntime(params: StartSyncParams): Promise<void> {
    const mode = params.mode ?? 'poll';
    const intervalStr = params.interval ?? (mode === 'live' ? '5m' : '2m');
    const intervalMilliseconds = parseDurationInMilliseconds(intervalStr);

    const hadLiveRuntime = this.hasLiveSyncRuntime();
    this.prepareForSyncRuntimeTransition();
    if (hadLiveRuntime) {
      await this.teardownLiveSync();
    }
    if (this._lifecycle.isSyncInProgress) {
      await this.waitForSyncCompletion();
    }
    if (this._lifecycle.backgroundTaskCount > 0) {
      await this.waitForBackgroundTasks();
    }
    this._lifecycle.clearIdentityTaskGroups();
    this._lifecycle.resumeTaskAdmission();

    this._syncMode = mode;

    if (mode === 'live') {
      await this.startLiveSync(intervalMilliseconds);
    } else {
      await this.startPollSync(intervalMilliseconds);
    }
  }

  /**
   * stopSync invalidates scheduled work and closes live subscriptions, then
   * waits for current lock-owning and background sync operations to finish.
   *
   * @param timeout - Maximum milliseconds to wait for in-progress sync work
   *   to finish. Non-finite values (`NaN`, `Infinity`) are
   *   coerced to the default to avoid a tight poll loop or never-exit
   *   condition.
   */
  public stopSync(timeout: number = 2000): Promise<void> {
    return this._lifecycle.runTransition(async (): Promise<void> => {
      await this.stopSyncRuntime(timeout);
    });
  }

  private hasLiveSyncRuntime(): boolean {
    return this._syncMode === 'live' ||
      this._linkControllers.size > 0 ||
      this._linkInitRetryTimers.size > 0 ||
      this.hasActiveSubscriptions;
  }

  private prepareForSyncRuntimeTransition(): void {
    this._engineGeneration++;
    this._lifecycle.pauseTaskAdmission();
    if (this._syncIntervalId) {
      clearInterval(this._syncIntervalId);
      this._syncIntervalId = undefined;
    }
    this.invalidateSyncTargetsCache();
    this._syncMode = undefined;
  }

  /**
   * Coerce a caller-supplied stop timeout: `undefined` waits without a bound,
   * while a non-finite value (`NaN`, `Infinity`) falls back to the default so
   * the wait can neither spin nor never exit.
   */
  private static coerceStopSyncTimeout(timeout: number | undefined): number | undefined {
    if (timeout === undefined) {
      return undefined;
    }
    return Number.isFinite(timeout) ? timeout : 2000;
  }

  private async stopSyncRuntime(timeout?: number): Promise<void> {
    const safeTimeout = SyncEngineLevel.coerceStopSyncTimeout(timeout);
    this.prepareForSyncRuntimeTransition();
    await this.teardownLiveSync();
    const [syncCompletion, backgroundCompletion] = await Promise.allSettled([
      this.waitForSyncCompletion(safeTimeout),
      this.waitForBackgroundTasks(safeTimeout),
    ]);
    if (backgroundCompletion.status === 'fulfilled') {
      this._lifecycle.clearIdentityTaskGroups();
    }
    // A scheduled sync interval is itself a supervised task, so both waits can
    // time out together. Preserve the established lock-timeout error as the
    // primary failure in that case.
    if (syncCompletion.status === 'rejected') {
      throw syncCompletion.reason;
    }
    if (backgroundCompletion.status === 'rejected') {
      throw backgroundCompletion.reason;
    }
  }

  private async waitForSyncCompletion(timeout?: number): Promise<void> {
    if (!await this._lifecycle.waitForSyncCompletion(timeout)) {
      throw new Error(`SyncEngineLevel: Existing sync operation did not complete within ${timeout} milliseconds.`);
    }
  }

  private async waitForBackgroundTasks(timeout?: number): Promise<void> {
    if (!await this._lifecycle.waitForBackgroundTasks(timeout)) {
      throw new Error(`SyncEngineLevel: Background sync operations did not complete within ${timeout} milliseconds.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Poll-mode sync
  // ---------------------------------------------------------------------------

  private async startPollSync(intervalMilliseconds: number): Promise<void> {
    const generation = this._engineGeneration;
    const intervalSync = async (): Promise<void> => {
      if (this._engineGeneration !== generation) { return; }
      if (this._lifecycle.isSyncInProgress) {
        return;
      }

      clearInterval(this._syncIntervalId);
      this._syncIntervalId = undefined;

      try {
        await this.sync(undefined, { verifyConvergence: true });
      } catch (error) {
        console.error('SyncEngineLevel: Error during sync operation', error);
      }

      const effectiveInterval = this._connectivityManager.getPollInterval(intervalMilliseconds);

      if (this._engineGeneration !== generation) { return; }
      this._syncIntervalId ??= this.scheduleSyncInterval(intervalSync, effectiveInterval);
    };

    if (this._syncIntervalId) {
      clearInterval(this._syncIntervalId);
    }

    this._syncIntervalId = this.scheduleSyncInterval(intervalSync, intervalMilliseconds);

    // Initiate an immediate sync.
    if (!this._lifecycle.isSyncInProgress) {
      try {
        await this.sync(undefined, { verifyConvergence: true });
      } catch (error) {
        console.error('SyncEngineLevel: Error during initial poll sync', error);
      }
    }
  }

  private scheduleSyncInterval(operation: () => Promise<void>, intervalMilliseconds: number): ReturnType<typeof setInterval> {
    return setInterval((): void => {
      void this._lifecycle.runBackgroundTask(operation);
    }, intervalMilliseconds);
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
    const generation = this._engineGeneration;

    // Step 0: Register browser connectivity listeners for instant recovery
    // on network switch, sleep/wake, or tab foregrounding. No-op in Node.
    this._connectivityManager.start();

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
    const integrityCheck = async (): Promise<void> => this.runLiveIntegrityCheck(generation);

    this._syncIntervalId = this.scheduleSyncInterval(integrityCheck, intervalMilliseconds);
  }

  private async runLiveIntegrityCheck(generation: number): Promise<void> {
    if (this._engineGeneration !== generation || this._lifecycle.isSyncInProgress) {
      return;
    }

    try {
      await this.sync(undefined, { verifyConvergence: true });
    } catch (error) {
      console.error('SyncEngineLevel: Error during durable feed settle check', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-link repair orchestration
  // ---------------------------------------------------------------------------

  /** Maximum consecutive repair attempts before the link is paused. */
  private static readonly MAX_REPAIR_ATTEMPTS = 3;

  /** Maximum age for a repeatedly deferred pull entry before it is dead-lettered and skipped. */
  private static readonly DEFERRED_PULL_DEAD_LETTER_AFTER_MS = 24 * 60 * 60 * 1000;

  /** Backoff schedule for repair retries (milliseconds). */
  private static readonly REPAIR_BACKOFF_MS = [1_000, 3_000, 10_000];

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

    const controller = this.getMatchingLinkController(linkKey, link);
    if (controller?.isActive !== true) {
      return;
    }

    await this.setLinkOfflineStatus(link, 'repairing');
    if (!controller.isActive) {
      return;
    }

    if (options?.resumeToken) {
      controller.setRepairResumeToken(options.resumeToken);
    }

    // Clear runtime ordinals immediately — stale state must not linger
    // across repair attempts.
    controller.clearPullInflight();

    // Kick off repair with retry scheduling on failure.
    const taskGroup = this._lifecycle.getIdentityTaskGroup(link.tenantDid);
    void this._lifecycle.runIdentityTask(taskGroup, async (): Promise<void> => {
      try {
        await this.repairLink(controller);
      } catch {
        this.scheduleRepairRetry(controller);
      }
    });
  }

  private async transitionToPaused(
    linkKey: string,
    link: ReplicationLinkState,
  ): Promise<void> {
    if (link.status === 'paused') {
      return;
    }

    const controller = this.getLinkController(linkKey);
    if (controller !== undefined && controller.link !== link) {
      return;
    }

    await this.setLinkOfflineStatus(link, 'paused');
    if (!controller?.isActive) {
      return;
    }

    await controller.closeSubscriptions();
    controller.clearPullInflight();
    controller.cancelReconcileTimer();
    controller.clearPushRuntime();
    controller.clearRepairProgress();
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

  /**
   * Schedule a retry for a failed repair. Uses exponential backoff.
   * No-op if the link is paused or a retry is already scheduled.
   */
  private scheduleRepairRetry(controller: SyncLinkController): void {
    const { link } = controller;
    if (!controller.isActive || link.status !== 'repairing') { return; }
    if (controller.repairRetryTimer !== undefined) { return; }

    // attempts is already post-increment from doRepairLink, so subtract 1
    // for the backoff index: first failure (attempts=1) → backoff[0]=1s.
    const attempts = controller.repairAttempts || 1;
    const backoff = SyncEngineLevel.REPAIR_BACKOFF_MS;
    const delayMs = backoff[Math.min(attempts - 1, backoff.length - 1)];
    const taskGroup = this._lifecycle.getIdentityTaskGroup(link.tenantDid);

    const timerGeneration = this._engineGeneration;
    const timer = setTimeout((): void => {
      if (!controller.consumeRepairRetryTimer(timer)) { return; }

      // Bail if teardown occurred since this timer was scheduled.
      if (this._engineGeneration !== timerGeneration || !controller.isActive) { return; }

      // Verify link still exists and is still repairing.
      if (link.status !== 'repairing') { return; }

      void this._lifecycle.runIdentityTask(taskGroup, async (): Promise<void> => {
        try {
          await this.repairLink(controller);
        } catch {
          // repairLink handles max attempts by pausing the link internally.
          // If still below max, schedule another retry.
          if (controller.isActive && link.status === 'repairing') {
            this.scheduleRepairRetry(controller);
          }
        }
      });
    }, delayMs);

    controller.setRepairRetryTimer(timer);
  }

  /**
   * Repair a single link. Deduplicates concurrent calls through its controller.
   * If repair is already running for this link, returns the existing promise.
   */
  private repairLink(controller: SyncLinkController): Promise<void> {
    if (!controller.isActive) { return Promise.resolve(); }
    const { linkKey } = controller;

    const existing = controller.repairInFlight;
    if (existing !== undefined) { return existing; }

    const promise = this.doRepairLink(controller).finally(() => {
      controller.clearRepairInFlight(promise);

      // Close the gap between feed catch-up and the reopened push subscription.
      if (controller.isActive && controller.link.status === 'live') {
        this.scheduleLinkReconcile(linkKey, controller.link, 'post-repair-gap', 500);
      }
    });
    controller.setRepairInFlight(promise);
    return promise;
  }

  /**
   * Internal repair implementation. Replays durable feed entries for a single
   * link, then attempts to re-establish live subscriptions. If repair succeeds,
   * transitions to `live`. If it fails, throws so callers can retry.
   */
  private async doRepairLink(controller: SyncLinkController): Promise<void> {
    const { link } = controller;
    const generation = this._engineGeneration;
    const { tenantDid: did, remoteEndpoint: dwnUrl, scope } = link;
    const eventScope = syncEventScope(scope);
    const attempts = controller.incrementRepairAttempts();
    this.emitEvent({ type: 'repair:started', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, attempt: attempts });

    // Step 1: Close existing subscriptions FIRST to stop old events from
    // mutating local state while repair runs.
    await controller.closeSubscriptions();
    if (this.isRepairStale(controller, generation)) { return; }

    // Step 2: Clear runtime ordinals immediately — stale state must not
    // persist across repair attempts (successful or failed).
    controller.resetPullRuntime();

    try {
      // Step 3: Replay durable feed entries for this link.
      const target = this.createRepairTarget(controller);
      const reconcileOutcome = await this.syncTargetWithDurableFeeds(
        target,
        undefined,
        () => !this.isRepairStale(controller, generation),
      );
      if (reconcileOutcome.aborted) { return; }
      if (this.isRepairStale(controller, generation)) { return; }
      const reconcilePushFailures = reconcileOutcome.pushFailures ?? [];
      const { admittedCids } = reconcileOutcome;
      if (admittedCids?.length) {
        this.emitEvent({
          type           : 'reconcile:applied',
          tenantDid      : did,
          remoteEndpoint : dwnUrl,
          ...eventScope,
          messageCids    : admittedCids,
        });
      }

      // Step 4: Determine the post-repair pull resume token.
      // - If repair was triggered by ProgressGap, use the stored resumeToken
      //   (from gapInfo.latestAvailable) so the reopened subscription replays
      //   from a valid boundary, closing the race window between feed catch-up and resubscribe.
      // - Otherwise, use the existing contiguousAppliedToken if still valid.
      // The push checkpoint is independent of the pull resume token and remains intact.
      const resumeToken = controller.repairResumeToken ?? link.pull.contiguousAppliedToken;
      await this.ledger.resetCheckpoint(link, 'pull', resumeToken);
      if (this.isRepairStale(controller, generation)) { return; }

      // Step 5: Reopen subscriptions.
      const subscriptionsOpened = await this.reopenRepairSubscriptions(target, controller, generation);
      if (!subscriptionsOpened) { return; }

      // Note: post-repair reconcile to close the repair-window gap is scheduled
      // by repairLink() after the controller clears its active repair.

      // Step 6: Clean up repair context and transition to live.
      await this.completeRepair(controller, generation, reconcilePushFailures);
    } catch (error: unknown) {
      await this.handleRepairFailure(controller, generation, attempts, error);
    }
  }

  private createRepairTarget(controller: SyncLinkController): LinkSyncTarget {
    const { link, linkKey } = controller;
    const { tenantDid: did, remoteEndpoint: dwnUrl, delegateDid, scope, authorization } = link;
    return {
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
  }

  private isRepairStale(controller: SyncLinkController, generation: number): boolean {
    return this._engineGeneration !== generation || !controller.isActive;
  }

  private async reopenRepairSubscriptions(
    target: LinkSyncTarget,
    controller: SyncLinkController,
    generation: number,
  ): Promise<boolean> {
    const pullOpened = await this.openRepairPullSubscription(target, controller, generation);
    if (!pullOpened) { return false; }

    if (this.isRepairStale(controller, generation)) {
      await controller.closeSubscriptions();
      return false;
    }

    try {
      const pushOpened = await this.openLocalPushSubscription(target, controller);
      if (!pushOpened) {
        await controller.closeSubscriptions();
        return false;
      }
    } catch (error: unknown) {
      await controller.closeSubscriptions();
      throw error;
    }

    if (!this.isRepairStale(controller, generation)) { return true; }
    await controller.closeSubscriptions();
    return false;
  }

  private async openRepairPullSubscription(
    target: LinkSyncTarget,
    controller: SyncLinkController,
    generation: number,
  ): Promise<boolean> {
    try {
      return await this.openLivePullSubscription(target, controller);
    } catch (error: unknown) {
      if (!SyncEngineLevel.isProgressGapError(error)) { throw error; }

      console.warn(`SyncEngineLevel: Stale pull resume token for ${target.did} -> ${target.dwnUrl}, resetting to start fresh`);
      await this.ledger.resetCheckpoint(controller.link, 'pull');
      if (this.isRepairStale(controller, generation)) { return false; }
      return this.openLivePullSubscription(target, controller);
    }
  }

  private async completeRepair(
    controller: SyncLinkController,
    generation: number,
    reconcilePushFailures: PushFailure[],
  ): Promise<void> {
    const { link, linkKey } = controller;
    const { tenantDid: did, remoteEndpoint: dwnUrl, scope } = link;
    const eventScope = syncEventScope(scope);

    controller.clearRepairProgress();
    const prevRepairConnectivity = link.connectivity;
    link.connectivity = 'online';
    await this.ledger.setStatus(link, 'live');
    if (this.isRepairStale(controller, generation)) { return; }

    if (reconcilePushFailures.length > 0) {
      await this.handleReconcilePushFailures(linkKey, link, reconcilePushFailures);
      if (this.isRepairStale(controller, generation)) { return; }
    }

    this.emitEvent({ type: 'repair:completed', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope });
    if (prevRepairConnectivity !== 'online') {
      this.emitEvent({ type: 'link:connectivity-change', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, from: prevRepairConnectivity, to: 'online' });
    }
    this.emitEvent({ type: 'link:status-change', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, from: 'repairing', to: 'live' });
  }

  private async handleRepairFailure(
    controller: SyncLinkController,
    generation: number,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    if (this.isRepairStale(controller, generation)) { return; }

    const { link, linkKey } = controller;
    const { tenantDid: did, remoteEndpoint: dwnUrl, scope } = link;
    const eventScope = syncEventScope(scope);
    const errorMessage = SyncEngineLevel.errorMessage(error);

    if (SyncEngineLevel.isTerminalAuthorizationFailure(errorMessage)) {
      console.warn(`SyncEngineLevel: sync authorization for ${did} -> ${dwnUrl} was revoked or expired — pausing link (reconnect to resume).`);
      this.emitEvent({ type: 'repair:failed', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, attempt: attempts, error: errorMessage });
      await this.transitionToPaused(linkKey, link);
      return;
    }

    console.error(`SyncEngineLevel: Repair failed for ${did} -> ${dwnUrl} (attempt ${attempts})`, error);
    this.emitEvent({ type: 'repair:failed', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, attempt: attempts, error: errorMessage });

    if (attempts >= SyncEngineLevel.MAX_REPAIR_ATTEMPTS) {
      console.warn(`SyncEngineLevel: Max repair attempts reached for ${did} -> ${dwnUrl}, pausing link`);
      await this.transitionToPaused(linkKey, link);
      return;
    }

    // Re-throw so callers can handle retry scheduling.
    throw error;
  }

  private static isProgressGapError(error: unknown): boolean {
    return typeof error === 'object' && error !== null &&
      (error as { isProgressGap?: unknown }).isProgressGap === true;
  }

  private markActiveLinksOffline(): void {
    for (const { link } of this._linkControllers.values()) {
      const previous = link.connectivity;
      if (previous === 'offline') {
        continue;
      }

      link.connectivity = 'offline';
      this.emitEvent({
        type           : 'link:connectivity-change',
        tenantDid      : link.tenantDid,
        remoteEndpoint : link.remoteEndpoint,
        ...syncEventScope(link.scope),
        from           : previous,
        to             : 'offline',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  private async teardownLiveSync(): Promise<void> {
    // Remove browser connectivity listeners before tearing down.
    this._connectivityManager.stop();

    // Invalidate callbacks, cancel timers, and close subscriptions through the
    // same lifetime owner used by normal hot-remove and repair paths.
    const controllers = [...this._linkControllers.values()];
    for (const controller of controllers) {
      controller.deactivate();
    }
    this._linkControllers.clear();
    for (const controller of controllers) {
      await controller.closeSubscriptions();
    }

    this._feedConvergenceManager.clearAll();

    // Clear pending rate-limit link-init retries.
    for (const timer of this._linkInitRetryTimers.values()) {
      clearTimeout(timer);
    }
    this._linkInitRetryTimers.clear();

    this._echoSuppressor.clear();

  }

  // ---------------------------------------------------------------------------
  // Per-target link initialization (shared by startLiveSync + addIdentityToLiveSync)
  // ---------------------------------------------------------------------------

  /**
   * Initialize a single replication link target: create or resume the durable
   * link, open pull + push subscriptions, and transition the link to `'live'`.
   */
  private async initializeLinkTarget(target: SyncTarget): Promise<LinkInitializationResult> {
    const generation = this._engineGeneration;
    let link: ReplicationLinkState | undefined;
    let controller: SyncLinkController | undefined;
    try {
      link = await this.getOrCreateReplicationLink(target);
      if (this._engineGeneration !== generation) {
        return { status: LinkInitializationStatus.Failed };
      }
      const linkKey = this.getReplicationLinkKey(target, link);
      controller = this.activateLink(linkKey, link);
      if (link.status === 'paused') {
        if (!controller.isActive) {
          return { status: LinkInitializationStatus.Failed };
        }
        return this.createActiveLinkInitializationResult(link);
      }

      const subscriptionResult = await this.openLinkSubscriptions({ ...target, linkKey }, controller);
      if (subscriptionResult === LinkSubscriptionOpenResult.Inactive || !controller.isActive) {
        return { status: LinkInitializationStatus.Failed };
      }
      if (subscriptionResult === LinkSubscriptionOpenResult.ReadyForLive) {
        await this.markLinkLive(target, controller);
        if (!controller.isActive) {
          return { status: LinkInitializationStatus.Failed };
        }
      }
      return this.createActiveLinkInitializationResult(link);
    } catch (error: any) {
      if (this._engineGeneration !== generation) {
        return { status: LinkInitializationStatus.Failed };
      }
      return this.handleInitializeLinkTargetError(target, link, controller, error);
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
    return buildLinkId(target.did, target.dwnUrl, link.projectionId, link.authorizationEpoch);
  }

  private async openLinkSubscriptions(
    target: LinkSyncTarget,
    controller: SyncLinkController,
  ): Promise<LinkSubscriptionOpenResult> {
    const pullOpened = await this.openLivePullSubscription(target, controller);
    if (pullOpened === false || !controller.isActive) {
      await controller.closeSubscriptions();
      return LinkSubscriptionOpenResult.Inactive;
    }
    if (controller.link.status === 'repairing') {
      await controller.closeLiveSubscription();
      return LinkSubscriptionOpenResult.Repairing;
    }

    try {
      const pushOpened = await this.openLocalPushSubscription(target, controller);
      if (pushOpened === false || !controller.isActive) {
        await controller.closeSubscriptions();
        return LinkSubscriptionOpenResult.Inactive;
      }
    } catch (error) {
      await controller.closeSubscriptions();
      throw error;
    }
    return LinkSubscriptionOpenResult.ReadyForLive;
  }

  private async markLinkLive(target: SyncTarget, controller: SyncLinkController): Promise<void> {
    if (!controller.isActive) { return; }
    const { link } = controller;
    this.emitEvent({
      type           : 'link:status-change',
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      ...syncEventScope(target.scope),
      from           : 'initializing',
      to             : 'live'
    });
    await this.ledger.setStatus(link, 'live');
    if (!controller.isActive) { return; }
    const nextProbeAt = await this.getNextQuotaProbeAtForTarget(target);
    if (nextProbeAt !== undefined && controller.isActive) {
      this.scheduleQuotaProbeForActiveLink(this.getReplicationLinkKey(target, link), link, nextProbeAt);
    }
  }

  private async handleInitializeLinkTargetError(
    target: SyncTarget,
    link: ReplicationLinkState | undefined,
    controller: SyncLinkController | undefined,
    error: any,
  ): Promise<LinkInitializationResult> {
    if (controller !== undefined && !controller.isActive) {
      return { status: LinkInitializationStatus.Failed };
    }

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

    if (this.isRateLimitError(error) && link) {
      const linkKey = this.getReplicationLinkKey(target, link);
      const retryAfterSec = error.retryAfterSec > 0 ? error.retryAfterSec : 1;
      console.warn(
        `SyncEngineLevel: Rate limited opening live subscription for ${target.did} -> ${target.dwnUrl}, ` +
        `retrying in ${retryAfterSec}s`,
      );
      // Drop the half-open link and re-attempt initialization after the
      // server-provided Retry-After window instead of failing permanently.
      // Durable feed reconciliation still runs via the periodic settle check,
      // so no data is lost while the live subscription is deferred.
      this.cleanupFailedLinkInitialization(linkKey, controller);
      this.scheduleLinkInitRetry(target, linkKey, retryAfterSec * 1000);
      return { status: LinkInitializationStatus.Failed };
    }

    console.error(`SyncEngineLevel: Failed to open live subscription for ${target.did} -> ${target.dwnUrl}`, error);
    if (link) {
      this.cleanupFailedLinkInitialization(this.getReplicationLinkKey(target, link), controller);
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

  private cleanupFailedLinkInitialization(linkKey: string, controller?: SyncLinkController): void {
    this.removeLinkController(linkKey, controller);

    if (!this.hasActiveSubscriptions) {
      this._connectivityManager.setState('unknown');
    }
  }

  /** Pending link-initialization retries scheduled after a rate-limit (429), keyed by link key. */
  private readonly _linkInitRetryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  private isRateLimitError(error: unknown): error is RateLimitError {
    return error instanceof RateLimitError;
  }

  /**
   * Re-attempt live-subscription initialization for a rate-limited link after
   * the server-provided Retry-After window. Coalesces repeated requests for the
   * same link so a burst of 429s schedules a single pending retry. A repeated
   * rate limit on the retry reschedules again via
   * {@link handleInitializeLinkTargetError}.
   */
  private scheduleLinkInitRetry(target: SyncTarget, linkKey: string, delayMs: number): void {
    const existing = this._linkInitRetryTimers.get(linkKey);
    if (existing) {
      clearTimeout(existing);
    }

    const generation = this._engineGeneration;
    const taskGroup = this._lifecycle.getIdentityTaskGroup(target.did);
    const timer = setTimeout((): void => {
      if (this._linkInitRetryTimers.get(linkKey) !== timer) {
        return;
      }
      this._linkInitRetryTimers.delete(linkKey);
      if (this._engineGeneration !== generation) {
        return;
      }
      void this._lifecycle.runIdentityTask(taskGroup, async (): Promise<void> => {
        try {
          await this.initializeLinkTarget(target);
        } catch {
          // Errors are handled inside initializeLinkTarget's catch block,
          // which reschedules another retry on a repeat rate limit.
        }
      });
    }, delayMs);
    this._linkInitRetryTimers.set(linkKey, timer);
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
    for (const controller of this._linkControllers.values()) {
      if (controller.link.tenantDid === did) { return true; }
    }
    return false;
  }

  /** Hot-add a single identity to the active live sync session. */
  private async addIdentityToLiveSync(did: string, options: SyncIdentityOptions): Promise<Set<string>> {
    const dwnEndpointUrls = await this.targetResolver.getEndpointUrls(did);
    if (dwnEndpointUrls.length === 0) { return new Set(); }

    const targets: SyncTarget[] = [];
    for (const dwnUrl of dwnEndpointUrls) {
      targets.push(...await this.targetResolver.buildTargetsForEndpoint(did, dwnUrl, options));
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
    const taskGroup = this._lifecycle.getIdentityTaskGroup(did);
    taskGroup.pause();

    const controllers = [...this._linkControllers.values()].filter(controller => controller.link.tenantDid === did);
    await Promise.all(controllers.map(controller => controller.closeSubscriptions()));

    // Stop queued work first, but retain its runtime state until callbacks that
    // are already in flight finish using it.
    this.cancelIdentityRuntimeTimers(did);
    await taskGroup.settle();

    // A running task may have armed a follow-up timer before observing the
    // paused group. Cancel that timer before discarding the link state.
    this.cancelIdentityRuntimeTimers(did);
    this.clearIdentityRuntimeState(did);

    this._lifecycle.deleteIdentityTaskGroup(did, taskGroup);
  }

  private cancelIdentityRuntimeTimers(did: string): void {
    for (const controller of this._linkControllers.values()) {
      if (controller.link.tenantDid === did) {
        const runtime = controller.pushRuntime;
        if (runtime?.timer !== undefined) {
          controller.cancelPushTimer(runtime);
        }
        controller.cancelRepairRetry();
        controller.cancelReconcileTimer();
      }
    }
    for (const [key, timer] of this._linkInitRetryTimers) {
      if (this.isLinkKeyForDid(key, did)) {
        clearTimeout(timer);
        this._linkInitRetryTimers.delete(key);
      }
    }
  }

  private clearIdentityRuntimeState(did: string): void {
    for (const [linkKey, controller] of this._linkControllers) {
      if (controller.link.tenantDid === did) {
        this.removeLinkController(linkKey, controller);
      }
    }

    this._feedConvergenceManager.clearTenant(did);
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
    const resolutions = await this.targetResolver.buildTargetResolutions(did, scope, options);
    const keys = new Set<string>();
    for (const resolution of resolutions) {
      const projectionId = await computeProjectionId(did, resolution.scope);
      keys.add(buildDurableLinkIdentityKey(did, projectionId, resolution.authorizationEpoch));
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
  private async openLivePullSubscription(
    target: LinkSyncTarget,
    controller: SyncLinkController,
  ): Promise<boolean> {
    const { did, delegateDid, dwnUrl } = target;
    const eventScope = syncEventScope(target.scope);

    const cursorKey = target.linkKey;
    if (!controller.isActive || controller.linkKey !== cursorKey) { return false; }
    const { link } = controller;
    const cursor = await this.getInitialPullCursor({ did, dwnUrl, link });
    if (!controller.isActive || controller.linkKey !== cursorKey) { return false; }

    const filters = target.scope.kind === 'protocolSet'
      ? target.scope.protocols.map(protocol => ({ protocol }))
      : [];

    const handlerGeneration = this._engineGeneration;

    // Define the subscription handler that processes incoming events.
    // NOTE: The WebSocket client fires handlers without awaiting (fire-and-forget),
    // so multiple handlers can be in-flight concurrently. The ordinal tracker
    // ensures the checkpoint advances only when all earlier deliveries are committed.
    // Capture the controller lifetime so remove+re-add invalidates callbacks
    // even when the replacement uses the same durable link key.
    const isStale = this.createLinkStalePredicate(controller, handlerGeneration);
    const pullContext: LivePullContext = {
      did,
      dwnUrl,
      delegateDid,
      eventScope,
      controller,
      linkKey            : cursorKey,
      link,
      permissionGrantIds : target.permissionGrantIds,
      isStale,
    };
    const taskGroup = this._lifecycle.getIdentityTaskGroup(did);

    const subscriptionHandler = (subMessage: SubscriptionMessage): Promise<void> =>
      this._lifecycle.runIdentityTask(taskGroup, () => this.handleLivePullMessage(pullContext, subMessage));

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

    const close = async (): Promise<void> => { await reply.subscription!.close(); };
    if (!controller.setLiveSubscription({ close })) {
      try {
        await close();
      } catch {
        // Best-effort cleanup of a subscription opened for a stale lifetime.
      }
      return false;
    }

    // Set per-link connectivity to online after successful subscription setup.
    const pullLink = controller.isActive ? controller.link : undefined;
    if (pullLink) {
      const prevPullConnectivity = pullLink.connectivity;
      pullLink.connectivity = 'online';
      if (prevPullConnectivity !== 'online') {
        this.emitEvent({ type: 'link:connectivity-change', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope, from: prevPullConnectivity, to: 'online' });
      }
    }
    return true;
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
    await this.ledger.resetCheckpoint(link, 'pull');
    return undefined;
  }

  private isValidProgressToken(token: ProgressToken): boolean {
    return !!(token.streamId && token.epoch && token.position);
  }

  private createLinkStalePredicate(
    controller: SyncLinkController | undefined,
    generation: number,
  ): () => boolean {
    return (): boolean =>
      this._engineGeneration !== generation ||
      controller?.isActive !== true;
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
    { did, dwnUrl, eventScope, controller, linkKey, link, isStale }: LivePullContext,
    subMessage: Extract<SubscriptionMessage, { type: 'eose' }>,
  ): Promise<void> {
    if (link) {
      // Guard: if the link transitioned to repairing while catch-up events
      // were being processed, skip all mutations — repair owns the state now.
      if (link.status !== 'live' && link.status !== 'initializing') {
        return;
      }

      if (!SyncCheckpoint.validateTokenDomain(link.pull, subMessage.cursor)) {
        console.warn(`SyncEngineLevel: Token domain mismatch on EOSE for ${did} -> ${dwnUrl}, transitioning to repairing`);
        if (!isStale()) { await this.transitionToRepairing(linkKey, link); }
        return;
      }
      SyncCheckpoint.setReceivedToken(link.pull, subMessage.cursor);
      controller?.drainCommittedPull();
      if (isStale()) { return; }
      await this.ledger.persistCheckpoint(link, 'pull');
      if (isStale()) { return; }
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
      this._connectivityManager.setState('online');
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
    if (await this.shouldSkipLivePullEvent(context, subMessage) || context.isStale()) {
      return;
    }

    const delivery = this.startPullDelivery(context, subMessage.cursor);
    try {
      const messageCid = await Message.getCid(subMessage.event.message);
      if (this._echoSuppressor.hasRecentlyPushed(context.did, messageCid, context.dwnUrl)) {
        await this.commitPullDelivery(context, subMessage.cursor, delivery);
        return;
      }

      const result = await this.processLivePullEvent(context, subMessage, messageCid);
      if (!result) { return; }

      if (result.admitted) {
        if (context.link === undefined) {
          this._echoSuppressor.trackPulled(context.did, result.messageCid, context.dwnUrl);
          await this.clearFailedMessageForTenant(context.did, result.messageCid, context.dwnUrl);
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
    if (link && !SyncCheckpoint.validateTokenDomain(link.pull, subMessage.cursor)) {
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

    SyncCheckpoint.setReceivedToken(link.pull, cursor);
    SyncCheckpoint.commitContiguousToken(link.pull, cursor);
    await this.ledger.persistCheckpoint(link, 'pull');
  }

  private startPullDelivery({ controller, link }: LivePullContext, cursor: ProgressToken): PullDelivery {
    // Assign a delivery ordinal BEFORE async processing begins. This captures
    // delivery order even if processing completes out of order.
    const deliveryController = controller?.isActive === true && link === controller.link
      ? controller
      : undefined;
    const ordinal = deliveryController?.startPullDelivery(cursor) ?? -1;
    return { controller: deliveryController, ordinal };
  }

  private async processLivePullEvent(
    context: LivePullContext,
    subMessage: Extract<SubscriptionMessage, { type: 'event' }>,
    rootCid: string,
  ): Promise<LivePullProcessResult | undefined> {
    const event = subMessage.event;
    const dataStreamFactory = await this.createLivePullDataStreamFactory(context, event);
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

  private async commitPullDelivery(
    { did, dwnUrl, linkKey, link, isStale }: LivePullContext,
    cursor: ProgressToken,
    delivery: PullDelivery,
  ): Promise<void> {
    // Guard: if the link transitioned to repairing while this handler was
    // in-flight, skip all state mutations — the repair process owns progression.
    // A remote subscription can deliver while the link is still initializing;
    // those events are accepted above and must not strand an uncommitted ordinal.
    if (
      !link ||
      !delivery.controller ||
      (link.status !== 'live' && link.status !== 'initializing') ||
      isStale()
    ) {
      return;
    }

    const drained = delivery.controller.commitPullDelivery(delivery.ordinal, cursor);
    if (drained > 0) {
      await this.ledger.persistCheckpoint(link, 'pull');
      if (isStale()) { return; }
      this.emitCheckpointAdvance(link, 'pull');
    }

    if (delivery.controller.pullInflightCount > MAX_IN_FLIGHT_PULL_DELIVERIES) {
      console.warn(`SyncEngineLevel: Pull in-flight overflow for ${did} -> ${dwnUrl}, transitioning to repairing`);
      await this.transitionToRepairing(linkKey, link);
    }
  }

  private emitCheckpointAdvance(link: ReplicationLinkState, direction: SyncDirection): void {
    const token = link[direction].contiguousAppliedToken;
    if (token === undefined) {
      return;
    }

    // Emit after durable save — "advanced" means persisted.
    const base = {
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...syncEventScope(link.scope),
      position       : token.position,
      ...(token.messageCid === undefined ? {} : { messageCid: token.messageCid }),
    };

    this.emitEvent(
      direction === 'pull'
        ? { type: 'checkpoint:pull-advance', ...base }
        : { type: 'checkpoint:push-advance', ...base },
    );
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
  private async openLocalPushSubscription(
    target: LinkSyncTarget,
    controller: SyncLinkController,
  ): Promise<boolean> {
    const { did, delegateDid, dwnUrl } = target;
    const protocol = singleProtocolForSyncScope(target.scope);

    const filters = target.scope.kind === 'protocolSet'
      ? target.scope.protocols.map(protocol => ({ protocol }))
      : [];

    const handlerGeneration = this._engineGeneration;

    if (!controller.isActive || controller.linkKey !== target.linkKey) { return false; }
    const isPushStale = (): boolean =>
      this._engineGeneration !== handlerGeneration ||
      !controller.isActive;
    const taskGroup = this._lifecycle.getIdentityTaskGroup(did);

    // Subscribe to the local DWN's EventLog.
    const subscriptionHandler = (subMessage: SubscriptionMessage): Promise<void> =>
      this._lifecycle.runIdentityTask(taskGroup, async (): Promise<void> => {
        if (isPushStale()) {
          return;
        }

        if (subMessage.type !== 'event') {
          return;
        }

        // Subset scope filtering: only push events that match the link scope.
        // Events outside the scope are not this link's responsibility.
        const pushLinkKey = target.linkKey;
        const pushLink = controller.link;
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
        if (this._echoSuppressor.hasRecentlyPulled(did, cid, dwnUrl)) {
          return;
        }

        const pushRuntime = controller.getOrCreatePushRuntime({
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
          void this._lifecycle.runIdentityTask(
            taskGroup,
            () => this.flushPendingPushesForLink(targetKey, controller),
          );
        }
      });

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
    if (!controller.setLocalSubscription({ close })) {
      try {
        await close();
      } catch {
        // Best-effort cleanup of a subscription opened for a stale lifetime.
      }
      return false;
    }
    return true;
  }

  /**
   * Flushes accumulated push CIDs to remote DWNs.
   */
  private async flushPendingPushes(): Promise<void> {
    const pendingControllers = [...this._linkControllers.values()]
      .filter(controller => controller.pushRuntime !== undefined);
    await Promise.all(pendingControllers.map(
      controller => this.flushPendingPushesForLink(controller.linkKey, controller)
    ));
  }

  private async flushPendingPushesForLink(
    linkKey: string,
    expectedController?: SyncLinkController,
  ): Promise<void> {
    const batch = this.takePushFlushBatch(linkKey, expectedController);
    if (!batch) { return; }

    const { controller, pushRuntime, pushEntries, isStale } = batch;
    const { did, dwnUrl, delegateDid, protocol, scope, permissionGrantIds, retryCount } = pushRuntime;

    try {
      const result = await this.pushMessages({
        did,
        dwnUrl,
        delegateDid,
        permissionGrantIds,
        messageCids: pushEntries.map((entry) => entry.cid),
      });

      await this.handlePushBatchResult(linkKey, batch, result);
    } catch (error: any) {
      if (isStale()) { return; }
      console.error(`SyncEngineLevel: Push batch failed for ${did} -> ${dwnUrl}`, error);
      await this.requeueOrReconcile(controller, {
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
      this.finishPushFlush(controller, pushRuntime);
    }
  }

  private takePushFlushBatch(
    linkKey: string,
    expectedController?: SyncLinkController,
  ): PushFlushBatch | undefined {
    // Guard: bail if this link was hot-removed or is no longer live. Without
    // this, a stale debounce timer or retry callback could send pushes after
    // the DID was removed or the link entered repair/terminal state.
    const controller = this.getLinkController(linkKey);
    if (controller === undefined || (expectedController !== undefined && controller !== expectedController)) {
      return undefined;
    }
    const { link: flushLink } = controller;
    if (flushLink.status !== 'live') {
      controller.clearPushRuntime();
      return undefined;
    }

    const pushRuntime = controller.pushRuntime;
    if (pushRuntime === undefined) {
      return undefined;
    }

    const { entries: pushEntries, retryCount } = pushRuntime;
    pushRuntime.entries = [];

    if (pushEntries.length === 0) {
      if (!pushRuntime.timer && !pushRuntime.flushing && retryCount === 0) {
        controller.clearPushRuntime(pushRuntime);
      }
      return undefined;
    }

    // Capture the current active link identity so we can detect
    // remove+re-add during the await pushMessages() call.
    const isStale = (): boolean => !controller.isActive;

    pushRuntime.flushing = true;
    return { controller, pushRuntime, pushEntries, isStale };
  }

  private async handlePushBatchResult(
    linkKey: string,
    batch: PushFlushBatch,
    result: PushResult,
  ): Promise<void> {
    if (batch.isStale()) { return; }

    const { link } = batch.controller;
    const target = this.syncTargetFromLink(link);
    const transition = await this.transitionPushResult(target, result, {
      protocol : batch.pushRuntime.protocol,
      source   : 'feed',
    });
    if (batch.isStale()) { return; }

    if (transition.nextQuotaProbeAt !== undefined) {
      this.scheduleQuotaProbeForActiveLink(linkKey, link, transition.nextQuotaProbeAt);
    }

    if (transition.retryableFailures.length > 0) {
      await this.requeueFailedPushes(batch, transition.retryableFailures);
      return;
    }

    this.cleanupSuccessfulPushRuntime(batch.controller, batch.pushRuntime);
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

  private async requeueFailedPushes(batch: PushFlushBatch, failed: PushFailure[]): Promise<void> {
    if (batch.isStale()) { return; }

    const { did, dwnUrl, delegateDid, protocol, scope, permissionGrantIds, retryCount } = batch.pushRuntime;
    const failedEntries = failed.map((failure) => ({
      cid         : failure.cid,
      lastFailure : failure,
    }));
    await this.requeueOrReconcile(batch.controller, {
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
    const controller = this.getMatchingLinkController(linkKey, link);
    if (controller?.isActive !== true) {
      return;
    }

    await this.requeueOrReconcile(controller, {
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

  private cleanupSuccessfulPushRuntime(controller: SyncLinkController, pushRuntime: SyncPushRuntimeState): void {
    // Successful push — reset retry count so subsequent unrelated batches on
    // this link start with a fresh budget.
    pushRuntime.retryCount = 0;
    if (!pushRuntime.timer && pushRuntime.entries.length === 0) {
      controller.clearPushRuntime(pushRuntime);
    }

  }

  private finishPushFlush(controller: SyncLinkController, pushRuntime: SyncPushRuntimeState): void {
    pushRuntime.flushing = false;

    // If new entries accumulated while this push was in flight, schedule a
    // short drain to flush them. This gives a brief batching window for burst
    // writes while keeping single-write latency low.
    const rt = controller.pushRuntime;
    if (controller.isActive && rt === pushRuntime && rt.entries.length > 0 && !rt.timer) {
      const taskGroup = this._lifecycle.getIdentityTaskGroup(rt.did);
      const timer = setTimeout((): void => {
        if (!controller.consumePushTimer(rt, timer)) { return; }
        void this._lifecycle.runIdentityTask(
          taskGroup,
          () => this.flushPendingPushesForLink(controller.linkKey, controller),
        );
      }, PUSH_DEBOUNCE_MS);
      controller.setPushTimer(rt, timer);
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

  private recordTerminalQuotaFailure(target: SyncTarget, failure: PushFailure): Promise<void> {
    return this.recordDeadLetter({
      messageCid     : failure.cid,
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      protocol       : failure.protocol ?? singleProtocolForSyncScope(target.scope),
      category       : 'admit-failed',
      errorCode      : failure.kind ?? 'Invalid',
      errorDetail    : failure.detail ?? 'push rejected during sync reconciliation',
    });
  }

  /**
   * Re-queues a failed push batch for retry, or schedules a feed check when
   * retries are exhausted. Bounded to prevent infinite retry loops.
   */
  private async requeueOrReconcile(controller: SyncLinkController, pending: {
    did: string; dwnUrl: string; delegateDid?: string; protocol?: string;
    scope?: SyncScope;
    permissionGrantIds?: NonEmptyStringArray;
    entries: SyncPushRuntimeEntry[];
    retryCount: number;
  }): Promise<void> {
    if (!controller.isActive) {
      return;
    }

    const targetKey = controller.linkKey;
    const maxRetries = SyncEngineLevel.PUSH_RETRY_BACKOFF_MS.length;
    const pushRuntime = controller.getOrCreatePushRuntime(pending);
    const { link } = controller;
    pending = {
      ...pending,
      entries: await this.recordImmediateTerminalPushFailures(targetKey, pending),
    };
    if (!controller.isActive) {
      return;
    }
    if (pending.entries.length === 0) {
      this.stopPushRuntime(controller, pushRuntime);
      this.scheduleLinkReconcileIfActive(targetKey, link, 'push-terminal');
      return;
    }

    const reconcileReason = pushBatchReconcileReason(pending.entries);
    if (reconcileReason !== undefined) {
      this.stopPushRuntime(controller, pushRuntime);
      this.scheduleLinkReconcileIfActive(
        targetKey,
        link,
        reconcileReason,
        SyncEngineLevel.DEFERRED_PUSH_RECONCILE_DELAY_MS,
      );
      return;
    }

    if (pending.retryCount >= maxRetries) {
      this.stopPushRuntime(controller, pushRuntime);
      this.scheduleLinkReconcileIfActive(targetKey, link, 'push-retry-exhausted');
      return;
    }

    this.schedulePushRetry(controller, pushRuntime, pending);
  }

  private async recordImmediateTerminalPushFailures(targetKey: string, pending: {
    did: string;
    dwnUrl: string;
    protocol?: string;
    scope?: SyncScope;
    entries: SyncPushRuntimeEntry[];
  }): Promise<SyncPushRuntimeEntry[]> {
    const retryableEntries: SyncPushRuntimeEntry[] = [];
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

  private stopPushRuntime(controller: SyncLinkController, pushRuntime: SyncPushRuntimeState): void {
    controller.clearPushRuntime(pushRuntime);
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

  private schedulePushRetry(controller: SyncLinkController, pushRuntime: SyncPushRuntimeState, pending: {
    entries: SyncPushRuntimeEntry[];
    retryCount: number;
  }): void {
    pushRuntime.entries.push(...pending.entries);
    pushRuntime.retryCount = pending.retryCount;
    const delayMs = SyncEngineLevel.PUSH_RETRY_BACKOFF_MS[pending.retryCount] ?? 2000;
    const taskGroup = this._lifecycle.getIdentityTaskGroup(pushRuntime.did);
    const timer = setTimeout((): void => {
      if (!controller.consumePushTimer(pushRuntime, timer)) { return; }
      void this._lifecycle.runIdentityTask(
        taskGroup,
        () => this.flushPendingPushesForLink(controller.linkKey, controller),
      );
    }, delayMs);
    controller.setPushTimer(pushRuntime, timer);
  }

  private scheduleLinkReconcile(linkKey: string, link: ReplicationLinkState, reason: string, delayMs?: number): void {
    if (link.status !== 'live' || this.getMatchingLinkController(linkKey, link)?.isActive !== true) {
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

  private syncTargetWithDurableFeeds(
    target: SyncTarget,
    options?: SyncReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    return this._durableFeedReconciler.reconcile(target, options, shouldContinue);
  }

  private verifyFeedConvergence(
    target: SyncTarget,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    return this._durableFeedReconciler.verifyConvergence(target, shouldContinue);
  }

  private queryDurableFeed({
    cidsOnly,
    cursor,
    limit,
    source,
    target,
  }: SyncDurableFeedQuery): Promise<MessagesQueryReply> {
    const params = {
      did                : target.did,
      delegateDid        : target.delegateDid,
      permissionGrantIds : target.permissionGrantIds,
      filters            : SyncEngineLevel.messageFeedFiltersForScope(target.scope),
      cursor,
      cidsOnly,
      limit,
      agent              : this.agent,
    };

    return source === 'local'
      ? queryLocalMessageFeed(params)
      : queryRemoteMessageFeed({ ...params, dwnUrl: target.dwnUrl });
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
      // A canonicalized delegate-local grant may not exist in the owner's local
      // tenant yet. Let its remote echo follow the normal pull path so that it
      // materializes locally instead of being mistaken for an already-local push.
      suppressRemoteEcho : false,
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

  private async pushMessageEntries({
    did,
    dwnUrl,
    delegateDid,
    permissionGrantIds,
    entries,
    suppressRemoteEcho = true,
  }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    permissionGrantIds?: string[];
    entries: SyncMessageEntry[];
    suppressRemoteEcho?: boolean;
  }): Promise<PushResult> {
    return pushMessageEntries({
      did, dwnUrl, delegateDid, permissionGrantIds, entries,
      agent          : this.agent,
      permissionsApi : this._permissionsApi,
      onBeforeApply  : suppressRemoteEcho
        ? (messageCid): void => { this._echoSuppressor.trackPushed(did, messageCid, dwnUrl); }
        : undefined,
    });
  }

  private collectLocalFeedCids(
    target: SyncTarget,
    shouldContinue?: () => boolean,
  ): Promise<Set<string> | undefined> {
    return this._durableFeedReconciler.collectLocalCids(target, shouldContinue);
  }

  private collectRemoteFeedCids(
    target: SyncTarget,
    shouldContinue?: () => boolean,
  ): Promise<Set<string> | undefined> {
    return this._durableFeedReconciler.collectRemoteCids(target, shouldContinue);
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

    if (this._echoSuppressor.hasRecentlyPulled(target.did, entry.messageCid, target.dwnUrl)) {
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
      this._echoSuppressor.trackPulled(target.did, cid, target.dwnUrl);
      await this.clearFailedMessageForTenant(target.did, cid, target.dwnUrl);
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

  private async recordDeferredPull(
    target: SyncTarget,
    messageCid: string,
    detail: string | undefined,
  ): Promise<SyncDeferredPullState> {
    const now = new Date().toISOString();
    const previous = await this._deferredPullStore.get(target.did, messageCid, target.dwnUrl);

    const state: SyncDeferredPullState = {
      attempts        : (previous?.attempts ?? 0) + 1,
      detail,
      firstDeferredAt : previous?.firstDeferredAt ?? now,
      lastDeferredAt  : now,
    };
    await this._deferredPullStore.put(target.did, messageCid, target.dwnUrl, state);
    return state;
  }

  private async clearDeferredPull(tenantDid: string, dwnUrl: string, messageCid: string): Promise<void> {
    await this._deferredPullStore.delete(tenantDid, messageCid, dwnUrl);
  }
  private getQuotaBlockState(target: SyncTarget, messageCid: string): Promise<SyncQuotaBlockState | undefined> {
    return this._quotaManager.getState(target, messageCid);
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

  private resolveQuotaBlocksSupersededByAcknowledgement(
    target: SyncTarget,
    acknowledgedCid: string,
  ): Promise<void> {
    return this._quotaManager.resolveBlocksSupersededByAcknowledgement(target, acknowledgedCid);
  }

  private recordQuotaBlock(
    target: SyncTarget,
    messageCid: string,
    protocol: string | undefined,
    detail: string | undefined,
    source: SyncQuotaBlockSource = 'feed',
    blockedCid = messageCid,
  ): Promise<SyncQuotaBlockState> {
    return this._quotaManager.recordBlock(target, messageCid, protocol, detail, source, blockedCid);
  }

  private clearQuotaBlock(target: SyncTarget, messageCid: string): Promise<boolean> {
    return this._quotaManager.clearBlock(target, messageCid);
  }

  private clearQuotaBlockByLinkKey(tenantDid: string, linkKey: string, messageCid: string): Promise<boolean> {
    return this._quotaManager.clearBlockByLinkKey(tenantDid, linkKey, messageCid);
  }

  private transitionPushResult(
    target: SyncTarget,
    result: PushResult,
    options?: { protocol?: string; source?: SyncQuotaBlockSource },
  ): Promise<SyncQuotaPushResultTransition> {
    return this._quotaManager.transitionPushResult(target, result, options);
  }

  private probeQuotaBlocksForTarget(
    target: SyncTarget,
    force = false,
    forceProbeCids?: Set<string>,
    shouldContinue?: () => boolean,
  ): Promise<void> {
    return this._quotaManager.probeBlocksForTarget(target, force, forceProbeCids, shouldContinue);
  }

  private clearQuotaBlocksForTenant(tenantDid: string): Promise<void> {
    return this._quotaManager.clearTenant(tenantDid);
  }

  private pruneQuotaBlocksForCurrentTargets(targets: SyncTarget[], expectedGeneration: number): Promise<void> {
    return this._quotaManager.pruneForCurrentTargets(
      targets,
      (): boolean => this._targetPlanner.generation === expectedGeneration,
    );
  }

  private getQuotaBlocksForTarget(target: SyncTarget): Promise<SyncQuotaBlockEntry[]> {
    return this._quotaManager.getActiveBlocksForTarget(target);
  }

  private getQuotaStatesForTarget(target: SyncTarget): Promise<SyncQuotaBlockEntry[]> {
    return this._quotaManager.getStatesForTarget(target);
  }

  private clearResolvedQuotaOmissionsForTarget(target: SyncTarget): Promise<void> {
    return this._quotaManager.clearResolvedOmissionsForTarget(target);
  }

  private getNextQuotaProbeAtForTarget(target: SyncTarget): Promise<string | undefined> {
    return this._quotaManager.getNextProbeAtForTarget(target);
  }

  private isFeedDivergenceExplainedByQuotaBlocks(
    target: SyncTarget,
    result: SyncReconcileResult,
  ): Promise<boolean> {
    return this._quotaManager.isFeedDivergenceExplained(target, result);
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

  private static shouldAbortReconcile(shouldContinue?: () => boolean): boolean {
    return shouldContinue?.() === false;
  }

  // ---------------------------------------------------------------------------
  // Per-link reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Schedule a per-link reconciliation after a short debounce. Coalesces
   * repeated requests for the same link.
   */
  private scheduleReconcile(linkKey: string, delayMs: number = 1500): boolean {
    const controller = this.getLinkController(linkKey);
    if (controller === undefined || controller.repairInFlight !== undefined) { return false; }
    const { link } = controller;

    const normalizedDelay = Math.max(0, delayMs);
    const dueAt = Date.now() + normalizedDelay;
    const existingTimer = controller.reconcileTimer;
    if (existingTimer !== undefined) {
      const existingDueAt = controller.reconcileTimerDueAt;
      if (existingDueAt !== undefined && existingDueAt <= dueAt) {
        return false;
      }
      controller.cancelReconcileTimer();
    }

    const taskGroup = this._lifecycle.getIdentityTaskGroup(link.tenantDid);
    const generation = this._engineGeneration;
    const timer = setTimeout((): void => {
      if (!controller.consumeReconcileTimer(timer)) { return; }
      if (this._engineGeneration !== generation || !controller.isActive) { return; }
      void this._lifecycle.runIdentityTask(taskGroup, async (): Promise<void> => {
        try {
          await this.reconcileLink(controller);
        } catch {
          // Errors are already logged inside doReconcileLink; swallow here
          // to prevent unhandled-rejection flakes in the test runner.
        }
      });
    }, normalizedDelay);
    controller.setReconcileTimer(timer, dueAt);
    return true;
  }

  /**
   * Run durable feed reconciliation for a single link. Deduplicates concurrent calls.
   * On success, emits completion. On failure, schedules retry.
   */
  private async reconcileLink(controller: SyncLinkController): Promise<void> {
    const existing = controller.reconcileInFlight;
    if (existing !== undefined) { return existing; }

    const promise = this.doReconcileLink(controller).finally(() => {
      controller.clearReconcileInFlight(promise);
    });
    controller.setReconcileInFlight(promise);
    return promise;
  }

  /**
   * Internal reconciliation implementation for a single link. Runs the
   * same durable feed pull/push that `sync()` does, but scoped to one link.
   */
  private async doReconcileLink(controller: SyncLinkController): Promise<void> {
    const { link, linkKey } = controller;
    if (!controller.isActive) { return; }

    // Only reconcile live links — repairing links have their own
    // recovery path.
    if (link.status !== 'live') {
      return;
    }

    // Skip if a repair is in progress for this link.
    if (controller.repairInFlight !== undefined) {
      return;
    }

    const generation = this._engineGeneration;

    const isStaleLink = (): boolean => !controller.isActive;
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
        this._feedConvergenceManager.clearLink(linkKey);
        this.emitEvent({ type: 'reconcile:completed', tenantDid: did, remoteEndpoint: dwnUrl, ...eventScope });
      } else if (!isStaleLink()) {
        // Feed fingerprints still differ — retry after a delay. This can
        // happen when push retries were exhausted, remote admission partially
        // failed, or new writes arrived during reconciliation.
        await this._feedConvergenceManager.handleVerifiedDivergence(
          reconcileTarget,
          reconcileOutcome,
          { link, linkKey },
        );
      }
    } catch (error: any) {
      if (isStaleLink()) { return; }
      console.error(`SyncEngineLevel: Reconciliation failed for ${did} -> ${dwnUrl}`, error);
      // Schedule retry with longer delay.
      this.scheduleReconcile(linkKey, 5000);
    }
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
      onBeforeApply  : (messageCid): void => { this._echoSuppressor.trackPushed(did, messageCid, dwnUrl); },
    });
  }

  // ---------------------------------------------------------------------------
  // Dead letter tracking
  // ---------------------------------------------------------------------------

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
    try {
      await this._deadLetterStore.put(entry);
    } catch (error) {
      // Suppress only the expected teardown race — any other error surfaces.
      if (!SyncEngineLevel.isDatabaseNotOpenError(error)) {
        throw error;
      }
    }
  }

  private async hasAdmissionDeadLetter(
    tenantDid: string,
    remoteEndpoint: string,
    messageCid: string,
  ): Promise<boolean> {
    const entry = await this._deadLetterStore.get(tenantDid, messageCid, remoteEndpoint);
    return entry?.tenantDid === tenantDid && entry.category === 'admit-failed';
  }

  public async getFailedMessages(tenantDid?: string): Promise<DeadLetterEntry[]> {
    const entries = (await this._deadLetterStore.getAll())
      .filter((entry): boolean => !tenantDid || entry.tenantDid === tenantDid);
    // Deterministic ordering: newest first so apps see the most recent failures.
    entries.sort((a, b) => lexicographicalCompare(b.failedAt, a.failedAt));
    return entries;
  }

  /** Clear the exact dead letter resolved by an internal tenant sync outcome. */
  private async clearFailedMessageForTenant(tenantDid: string, messageCid: string, remoteEndpoint: string): Promise<void> {
    try {
      await this._deadLetterStore.deleteExact(tenantDid, messageCid, remoteEndpoint);
    } catch (error) {
      // A late live callback may race orderly storage teardown.
      if (!SyncEngineLevel.isDatabaseNotOpenError(error)) {
        throw error;
      }
    }
  }

  private static isDatabaseNotOpenError(error: unknown): boolean {
    return typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'LEVEL_DATABASE_NOT_OPEN';
  }

  public async clearFailedMessage(messageCid: string, remoteEndpoint?: string): Promise<boolean> {
    // The durable key includes tenant, but this API intentionally clears by
    // message CID and optional remote regardless of tenant, matching the
    // previous public contract.
    const deleted = await this._deadLetterStore.deleteForMessage(messageCid, remoteEndpoint);
    return deleted > 0;
  }

  public async clearAllFailedMessages(tenantDid?: string): Promise<void> {
    if (!tenantDid) {
      await this._deadLetterStore.clear();
      return;
    }

    await this._deadLetterStore.deleteForTenant(tenantDid);
  }

  public async getSyncHealth(): Promise<SyncHealthSummary> {
    return this._statusReporter.getHealth();
  }

  public async getRemoteSyncStatus(tenantDid?: string): Promise<RemoteSyncStatus[]> {
    return this._statusReporter.getRemoteStatus(tenantDid);
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
    await this._lifecycle.acquireSync();

    try {
      if (this._engineGeneration !== generation) {
        return;
      }
      const topologyGeneration = this._targetPlanner.generation;
      const targets = (await this.getSyncTargets()).filter(
        (target) => target.did === tenantDid && target.dwnUrl === remoteEndpoint,
      );

      await Promise.all(targets.map(async (target) => {
        await this.retryQuotaBlocksForTarget(target, generation, topologyGeneration);
      }));
    } finally {
      this._lifecycle.releaseSync();
    }
  }

  private async retryQuotaBlocksForTarget(
    target: SyncTarget,
    generation: number,
    topologyGeneration: number,
  ): Promise<void> {
    const linkKey = this._quotaManager.getLinkKey(target);
    const key = `${linkKey}|__retry-target__`;
    const existing = this._quotaRetryInFlight.get(key);
    if (existing !== undefined) {
      await existing;
      return;
    }

    const retry = (async (): Promise<void> => {
      const blocks = await this.getQuotaBlocksForTarget(target);
      if (
        blocks.length === 0 ||
        this._engineGeneration !== generation ||
        this._targetPlanner.generation !== topologyGeneration
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
          this._targetPlanner.generation === topologyGeneration,
      );
    })().finally((): void => {
      if (this._quotaRetryInFlight.get(key) === retry) {
        this._quotaRetryInFlight.delete(key);
      }
    });
    this._quotaRetryInFlight.set(key, retry);
    await retry;
  }

  private async getCurrentDurableLinkIdentityKeys(): Promise<Set<string> | undefined> {
    try {
      const identityKeys = new Set<string>();
      for await (const entry of this._identityStore.entries()) {
        if (entry.status === 'corrupt') {
          console.warn(`SyncEngineLevel: Corrupt sync options for ${entry.did}, skipping health target:`, entry.error);
          continue;
        }

        const scope = syncScopeFromProtocols(entry.options.protocols);
        const resolutions = await this.targetResolver.buildTargetResolutions(entry.did, scope, entry.options);
        for (const resolution of resolutions) {
          const projectionId = await computeProjectionId(entry.did, resolution.scope);
          identityKeys.add(buildDurableLinkIdentityKey(entry.did, projectionId, resolution.authorizationEpoch));
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
      if (!this._targetPlanner.lastResolutionComplete || targets.length === 0) {
        return undefined;
      }

      return new Set(targets.map((target) => this._quotaManager.getLinkKey(target)));
    } catch (error: unknown) {
      console.warn('SyncEngineLevel: Failed to resolve current quota link keys for health; falling back to all quota blocks', error);
      return undefined;
    }
  }

  private getDurableLinkIdentityKey(link: ReplicationLinkState): string {
    return buildDurableLinkIdentityKey(link.tenantDid, link.projectionId, link.authorizationEpoch);
  }

  // ---------------------------------------------------------------------------
  // Sync targets
  // ---------------------------------------------------------------------------

  /** Return the cached or freshly planned canonical targets for every registration. */
  private getSyncTargets(): Promise<SyncTarget[]> {
    return this._targetPlanner.getTargets({
      beforeCache: (targets, generation): Promise<void> =>
        this.pruneQuotaBlocksForCurrentTargets(targets, generation),
    });
  }

}
