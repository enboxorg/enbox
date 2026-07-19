import type { AbstractLevel } from 'abstract-level';

import type { DwnSubscriptionHandler, ResubscribeFactory } from '@enbox/dwn-clients';
import type { GenericMessage, MessagesFilter, MessagesQueryReply, MessagesQueryReplyEntry, MessagesSubscribeReply, ProgressToken, RecordsQueryReply, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import { RateLimitError } from '@enbox/dwn-clients';
import { DwnInterfaceName, DwnMethodName, Encoder, Message } from '@enbox/dwn-sdk-js';
import { parseDurationInMilliseconds, sleep } from '@enbox/common';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { SyncDeadLetterStore } from './sync-dead-letter-store.js';
import type { SyncEndpointStore } from './sync-endpoint-store.js';
import type { SyncIdentityStore } from './sync-identity-store.js';
import type { SyncIdentityTaskRunner } from './sync-lifecycle-coordinator.js';
import type { SyncLivePullContext } from './sync-live-pull-processor.js';
import type { SyncMessageEntry } from './sync-messages.js';
import type { SyncReplicationLinkStore } from './sync-replication-link-store.js';
import type { SyncRuntimeHandle } from './sync-runtime.js';
import type {
  DeadLetterEntry,
  PushFailure,
  PushResult,
  RemoteSyncStatus,
  ReplicationLinkSnapshot,
  ReplicationLinkState,
  StartSyncParams,
  SyncConnectivityState,
  SyncDirection,
  SyncDrainOptions,
  SyncDrainResult,
  SyncEngine,
  SyncEvent,
  SyncEventListener,
  SyncHealthSummary,
  SyncIdentityOptions,
  SyncRunOptions,
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
import { DwnInterface } from './types/dwn.js';
import { isValidProgressToken } from './sync-checkpoint.js';
import { runWithCrossContextLock } from './sync-cross-context-lock.js';
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
import { SyncLinkRecoveryCoordinator } from './sync-link-recovery-coordinator.js';
import { SyncLivePullProcessor } from './sync-live-pull-processor.js';
import { SyncLivePushCoordinator } from './sync-live-push-coordinator.js';
import { SyncQuotaManager } from './sync-quota-manager.js';
import { SyncQuotaStoreLevel } from './sync-quota-store-level.js';
import { SyncReplicationLinkStoreLevel } from './sync-replication-link-store-level.js';
import { SyncRunCancelledError } from './sync-runtime-errors.js';
import { SyncRunCoordinator } from './sync-run-coordinator.js';
import { SyncRuntime } from './sync-runtime.js';
import { SyncScopeClosureValidator } from './sync-scope-closure-validator.js';
import { SyncStatusReporter } from './sync-status-reporter.js';
import { SyncTargetPlanner } from './sync-target-planner.js';
import { buildDurableLinkIdentityKey, buildLinkId, LINK_ID_SEPARATOR } from './sync-link-id.js';
import { computeProjectionId, isTerminalPushFailure, lexicographicalCompare, singleProtocolForSyncScope, syncEventScope, syncScopeFromProtocols } from './types/sync.js';
import { fetchRemoteMessages, getLocalMessage, isInitialWriteForRecord, pushMessageEntries, pushMessages, queryLocalMessageFeed, queryRemoteMessageFeed, recordIdForRecordsMessage } from './sync-messages.js';
import { getMessagesPermissionGrantsForScope, permissionGrantIdsFromEntries, SyncProtocolRootPermissionGrantMissingError, toMessagesPermissionGrantIds } from './sync-permission-grants.js';
import { normalizeDwnEndpoint, SyncTargetResolver } from './sync-target-resolver.js';

export type SyncEngineLevelParams = {
  agent?: EnboxPlatformAgent;
  dataPath?: string;
  db?: AbstractLevel<string | Buffer | Uint8Array>;
};

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

/** Accumulated shape of every `sync()` request joined into one queued follow-up run. */
type MergedSyncRunRequest = {
  direction?: SyncDirection;
  /** Joiners disagreed on direction — the follow-up runs both. */
  directionConflict: boolean;
  did?: string;
  /** Any joiner was unscoped (or scopes disagreed) — the follow-up runs unscoped. */
  unscoped: boolean;
  verifyConvergence: boolean;
};

/** The single queued follow-up `sync()` run that coalesced callers share. */
type PendingSyncRun = {
  merged: MergedSyncRunRequest;
  /** Transition fence captured at queue time — a runtime transition invalidates the run. */
  fence: () => boolean;
  promise: Promise<void>;
};

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
  private readonly _linkRecoveryCoordinator: SyncLinkRecoveryCoordinator;
  private readonly _livePullProcessor: SyncLivePullProcessor;
  private readonly _livePushCoordinator: SyncLivePushCoordinator;
  private readonly _quotaManager: SyncQuotaManager;
  private readonly _runCoordinator: SyncRunCoordinator;

  /**
   * Ownership scope for the current runtime generation's timers. Replaced on
   * every `startSync` after the previous generation's work has settled;
   * disposed by every runtime transition, which cancels all owned timers.
   */
  private _runtime = new SyncRuntime();
  private readonly _scopeClosureValidator: SyncScopeClosureValidator;
  private readonly _statusReporter: SyncStatusReporter;
  private readonly _targetPlanner: SyncTargetPlanner;
  private _targetResolver?: SyncTargetResolver;

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


  /**
   * The queued follow-up run shared by `sync()` callers that arrived while
   * the exclusive lock was held. Cleared the moment the follow-up acquires
   * the lock, so later callers start a fresh cycle. See {@link joinPendingSyncRun}.
   */
  private _pendingSyncRun?: PendingSyncRun;

  /**
   * Storage-instance discriminator folded into cross-context lock names, so
   * engines over DIFFERENT stores on one origin or in one process never
   * contend on each other's locks. Mirrors the wake-channel naming.
   */
  private readonly _lockScope: string;

  /** Registered event listeners for observability. */
  private readonly _eventListeners: Set<SyncEventListener> = new Set();

  /** In-flight Retry-now target reconciliations, keyed by complete replication link. */
  private readonly _quotaRetryInFlight: Map<string, Promise<void>> = new Map();

  /** Serializes public Retry-now operations with each other before they acquire the sync lock. */
  private _retryRemoteQueue: Promise<void> = Promise.resolve();

  /** Backoff schedule for recently published did:dht records. */
  private static readonly DID_RESOLUTION_RETRY_BACKOFF_MS = [2000, 4000, 8000];

  constructor({ agent, dataPath, db }: SyncEngineLevelParams) {
    this._lockScope = dataPath ?? 'default';
    this._agent = agent;
    this._permissionsApi = new AgentPermissionsApi({ agent });
    this._db = db ?? new Level<string, string>(dataPath ?? 'DATA/AGENT/SYNC_STORE');
    this._deadLetterStore = new SyncDeadLetterStoreLevel(this._db);
    this._deferredPullStore = new SyncDeferredPullStoreLevel(this._db);
    this._connectivityManager = new SyncConnectivityManager({
      operations: {
        getRuntimeScope        : (): SyncRuntime => this._runtime,
        markActiveLinksOffline : (): void => { this.markActiveLinksOffline(); },
        runBackgroundTask      : (operation): Promise<void> => this._lifecycle.runBackgroundTask(operation),
        // sync() widens a queued follow-up to an unscoped convergence check if
        // scoped or full sync work already owns the exclusive lifecycle lock.
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
    this._livePullProcessor = new SyncLivePullProcessor({
      echoSuppressor : this._echoSuppressor,
      operations     : {
        emitCheckpointAdvance : (link): void => { this.emitCheckpointAdvance(link, 'pull'); },
        emitEvent             : (event): void => { this.emitEvent(event); },
        getAgent              : (): EnboxPlatformAgent => this.agent,
        getPermissionsApi     : (): PermissionsApi => this._permissionsApi,
        persistCheckpoint     : (link): Promise<void> => this.ledger.persistCheckpoint(link, 'pull'),
        recordDeadLetter      : (entry): Promise<void> => this.recordDeadLetter(entry),
        reportError           : (message, error): void => { console.error(message, error); },
        scheduleReconcile     : (controller, reason): void => {
          this._linkRecoveryCoordinator.scheduleLinkReconcile(controller, reason);
        },
        trackAppliedCids: (messageCids, target): Promise<void> =>
          this.trackRemoteFeedAppliedCids(messageCids, target),
        transitionToPaused    : (linkKey, link): Promise<void> => this.transitionToPaused(linkKey, link),
        transitionToRepairing : (controller): Promise<void> =>
          this._linkRecoveryCoordinator.transitionToRepairing(controller),
        warn: (message): void => { console.warn(message); },
      },
    });
    this._livePushCoordinator = new SyncLivePushCoordinator({
      echoSuppressor : this._echoSuppressor,
      operations     : {
        captureIdentityTaskRunner: (tenantDid): SyncIdentityTaskRunner =>
          this._lifecycle.captureIdentityTaskRunner(tenantDid),
        clearQuotaBlock: (tenantDid, linkKey, messageCid): Promise<boolean> =>
          this.clearQuotaBlockByLinkKey(tenantDid, linkKey, messageCid),
        getController     : (linkKey): SyncLinkController | undefined => this.getLinkController(linkKey),
        pushMessages      : (request): Promise<PushResult> => this.pushMessages(request),
        recordDeadLetter  : (entry): Promise<void> => this.recordDeadLetter(entry),
        reportError       : (message, error): void => { console.error(message, error); },
        scheduleReconcile : (linkKey, link, reason, delayMs): void => {
          this.scheduleLinkReconcile(linkKey, link, reason, delayMs);
        },
        transitionPushResult: (target, result, options): Promise<SyncQuotaPushResultTransition> =>
          this.transitionPushResult(target, result, options),
      },
    });
    this._linkRecoveryCoordinator = new SyncLinkRecoveryCoordinator({
      operations: {
        captureIdentityTaskRunner: (tenantDid): SyncIdentityTaskRunner =>
          this._lifecycle.captureIdentityTaskRunner(tenantDid),
        clearConvergence : (linkKey): void => { this._feedConvergenceManager.clearLink(linkKey); },
        emitEvent        : (event): void => { this.emitEvent(event); },
        getController    : (linkKey): SyncLinkController | undefined => this.getLinkController(linkKey),
        getRuntimeScope  : (): SyncRuntimeHandle => this._runtime,
        handleDivergence : (target, result, context): Promise<boolean> =>
          this._feedConvergenceManager.handleVerifiedDivergence(target, result, context),
        handlePushFailures: (controller, failures): Promise<void> =>
          this._livePushCoordinator.handleReconcileFailures(controller, failures),
        openPullSubscription: (target, controller): Promise<boolean> =>
          this.openLivePullSubscription(target, controller),
        openPushSubscription: (target, controller): Promise<boolean> =>
          this.openLocalPushSubscription(target, controller),
        reconcileTarget: (target, options, shouldContinue): Promise<SyncReconcileResult> =>
          this.syncTargetWithDurableFeeds(target, options, shouldContinue),
        reportError         : (message, error): void => { console.error(message, error); },
        resetPullCheckpoint : (link, resumeToken): Promise<void> =>
          this.ledger.resetCheckpoint(link, 'pull', resumeToken),
        setStatus : (link, status): Promise<void> => this.ledger.setStatus(link, status),
        warn      : (message): void => { console.warn(message); },
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
    // A link activated through another path (e.g. drain) supersedes any
    // pending rate-limit init retry for the same key.
    this._runtime.clearTimer(SyncEngineLevel.linkInitRetryTimerKey(linkKey));

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
      await this.runDestructivePhase(async (): Promise<void> => {
        await this._permissionsApi.clear();
        await this.clearSyncDb();
      });
    });
  }

  public close(): Promise<void> {
    return this._lifecycle.runTransition(async (): Promise<void> => {
      await this.stopSyncRuntime();
      await this.runDestructivePhase(async (): Promise<void> => {
        await this._db.close();
      });
    });
  }

  /**
   * Runs a destructive lifecycle phase while holding the exclusive sync lock.
   * `stopSyncRuntime` only waits for the lock to free — it never holds it —
   * so without this a `sync()`, `drainTo()`, or `retryRemoteNow()` admitted
   * after that wait could interleave with the wipe or the closed database and
   * resurrect sync state that `clear()` guarantees is gone.
   *
   * Installing a fresh disposed scope invalidates work that queued against
   * the lock while the phase ran: those callers raced the destruction rather
   * than following it, so their transition fences trip and they cancel
   * through the engine's stale-work convention instead of running against
   * wiped state or failing on closed storage. The queued join point itself
   * is left in place — joiners arriving mid-destruction must share that
   * cancellation, not start a fresh run.
   */
  private async runDestructivePhase(operation: () => Promise<void>): Promise<void> {
    await this._lifecycle.acquireSync();
    try {
      await operation();
    } finally {
      this.installDisposedRuntimeScope();
      this._lifecycle.releaseSync();
    }
  }

  /**
   * Replace the current scope with a fresh, already-disposed one. Every
   * transition installs a new scope object, so a fence captured under ANY
   * earlier scope — including one captured while the engine was already
   * stopped — observes the transition as an identity change.
   */
  private installDisposedRuntimeScope(): void {
    const replacement = new SyncRuntime();
    replacement.dispose();
    this._runtime = replacement;
  }

  public registerIdentity(params: { did: string; options: SyncIdentityOptions }): Promise<void> {
    return this.runExclusiveIdentityMutation(params.did, (): Promise<void> => this.doRegisterIdentity(params));
  }

  /**
   * Every identity mutation layers the engine-local exclusive sync lock
   * around the cross-context per-DID lifecycle lock. Composing both here
   * makes the layering structurally unforgettable for future mutation sites.
   */
  private runExclusiveIdentityMutation(did: string, operation: () => Promise<void>): Promise<void> {
    return this._lifecycle.runIdentityMutation(async (): Promise<void> => {
      await this.runIdentityLifecycle(did, operation);
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
    if (this._runtime.mode === 'live') {
      const currentIdentityKeys = await this.addIdentityToLiveSync(did, options);
      if (currentIdentityKeys.size > 0) {
        await this.pruneSupersededDurableLinksForIdentity(did, currentIdentityKeys);
      }
    } else {
      await this.tryPruneSupersededDurableLinksForRegisteredIdentity(did, options);
    }
  }

  public unregisterIdentity(did: string): Promise<void> {
    return this.runExclusiveIdentityMutation(did, (): Promise<void> => this.doUnregisterIdentity(did));
  }

  private async doUnregisterIdentity(did: string): Promise<void> {
    const existing = await this.getIdentityOptions(did);
    if (!existing) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
    }

    // If live sync is active, hot-remove subscriptions for this identity.
    if (this._runtime.mode === 'live') {
      await this.removeIdentityFromLiveSync(did);
    }

    // A pending rate-limit init retry may exist even without an active link
    // (the 429 path drops the controller before arming the retry, so the
    // hot-remove above can be skipped entirely). Its captured target is now
    // unregistered — cancel it unconditionally.
    this.cancelLinkInitRetriesForDid(did);

    // Tenant-scoped cleanup runs first; the identity marker is deleted LAST
    // as the durable commit point. A failure at any earlier step — including
    // durable-link pruning — leaves the registration intact so the caller can
    // simply retry the unregister. Pruning must precede the marker deletion:
    // a paused link surviving an unregister shares its durable identity key
    // with a same-scope re-registration, so supersession pruning would retain
    // it and silently disable live replication.
    await this.clearQuotaBlocksForTenant(did);
    await this.pruneSupersededDurableLinksForIdentity(did, new Set());
    await this.runDeferredPullLifecycle(did, async (): Promise<void> => {
      await this._deferredPullStore.deleteForTenant(did);
      await this._identityStore.delete(did);
    });
    this.invalidateSyncTargetsCache();
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
    return this.runExclusiveIdentityMutation(params.did, (): Promise<void> => this.doUpdateIdentityOptions(params));
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

    // A pending rate-limit init retry captured the PREVIOUS options' target
    // (old scope, old authorization epoch). Remember that it represented an
    // active live-sync attempt before cancelling it: the replacement options
    // still need their own live links even though the rate-limited link has no
    // controller yet. The runtime's ownership-token check neutralizes a timer
    // firing that was queued but had not started before this cancellation.
    const hadPendingLinkInitRetry = this.hasLinkInitRetriesForDid(did);
    this.cancelLinkInitRetriesForDid(did);

    // A retry that fired earlier may already be RUNNING as an identity task.
    // It is invisible to timer cancellation. Treat armed, running, and active
    // states alike as a prior live runtime that must be torn down. The normal
    // identity teardown pauses task admission before settling, then cancels
    // any retry re-armed by work that was already in flight.
    const identityTaskGroup = this._lifecycle.getIdentityTaskGroup(did);
    const hadPriorLiveRuntime = hadPendingLinkInitRetry ||
      identityTaskGroup.size > 0 ||
      this.hasActiveLinksForDid(did);
    const rebuildLiveLinks = this._runtime.mode === 'live' && hadPriorLiveRuntime;
    if (hadPriorLiveRuntime) {
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
    if (options?.did !== undefined && await this._identityStore.get(options.did) === undefined) {
      throw new Error(`SyncEngineLevel: Identity with DID ${options.did} is not registered.`);
    }

    if (this._lifecycle.tryAcquireSync()) {
      try {
        await this._runCoordinator.run(direction, options);
      } finally {
        this._lifecycle.releaseSync();
      }
      return;
    }

    return this.joinPendingSyncRun(direction, options);
  }

  /**
   * Coalesces a `sync()` call that arrived while the exclusive lock was held.
   * All such callers share ONE queued follow-up run that starts after the
   * in-flight operation releases the lock; their requests are merged so the
   * follow-up covers every joiner (differing directions widen to both,
   * differing identity scopes widen to unscoped, convergence verification
   * ORs). A caller joining after the follow-up has started gets a fresh one.
   *
   * Fairness note: `releaseSync()` wakes every `acquireSync()` waiter, so an
   * identity mutation or retry can take the lock ahead of the queued
   * follow-up. Progress is guaranteed (the follow-up re-waits), joiners just
   * observe the extra latency.
   */
  private joinPendingSyncRun(direction?: SyncDirection, options?: SyncRunOptions): Promise<void> {
    const pending = this._pendingSyncRun;
    if (pending !== undefined) {
      SyncEngineLevel.mergeSyncRunRequest(pending.merged, direction, options);
      return pending.promise;
    }

    const merged: MergedSyncRunRequest = {
      direction         : direction,
      directionConflict : false,
      did               : options?.did,
      unscoped          : options?.did === undefined,
      verifyConvergence : options?.verifyConvergence === true,
    };

    // The placeholder promise is replaced synchronously below, before any
    // caller can observe it.
    const followUp: PendingSyncRun = {
      merged,
      fence   : this.captureTransitionFence(),
      promise : Promise.resolve(),
    };
    followUp.promise = (async (): Promise<void> => {
      await this._lifecycle.acquireSync();
      // Snapshot and detach: joiners from here on start a new follow-up.
      if (this._pendingSyncRun === followUp) {
        this._pendingSyncRun = undefined;
      }
      try {
        // A runtime transition (stopSync/clear/close/mode switch) invalidated
        // this queued run while it waited for the lock. Reject rather than
        // resolve: a resolved sync() must always mean a run covering the
        // request completed (callers like recovery read state right after).
        if (!followUp.fence()) {
          throw new SyncRunCancelledError(
            'SyncEngineLevel: queued sync run was cancelled by an engine runtime transition.',
          );
        }
        await this._runCoordinator.run(
          merged.directionConflict ? undefined : merged.direction,
          {
            ...(merged.unscoped || merged.did === undefined ? {} : { did: merged.did }),
            ...(merged.verifyConvergence ? { verifyConvergence: true } : {}),
          },
        );
      } finally {
        this._lifecycle.releaseSync();
      }
    })();
    this._pendingSyncRun = followUp;
    return followUp.promise;
  }

  private static mergeSyncRunRequest(
    merged: MergedSyncRunRequest,
    direction?: SyncDirection,
    options?: SyncRunOptions,
  ): void {
    if (merged.direction !== direction) {
      merged.directionConflict = true;
    }
    if (options?.did === undefined) {
      merged.unscoped = true;
    } else if (merged.did !== undefined && merged.did !== options.did) {
      merged.unscoped = true;
    } else {
      merged.did = options.did;
    }
    if (options?.verifyConvergence === true) {
      merged.verifyConvergence = true;
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
    if (this._runtime.mode !== 'live') {
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

  // ---------------------------------------------------------------------------
  // startSync / stopSync
  // ---------------------------------------------------------------------------

  public startSync(params: StartSyncParams): Promise<void> {
    return this._lifecycle.runTransition(async (): Promise<void> => {
      await this.startSyncRuntime(params);
    });
  }

  private async startSyncRuntime(params: StartSyncParams): Promise<void> {
    const mode = params.mode;
    if (mode !== 'live' && mode !== 'poll') {
      throw new Error(`SyncEngineLevel: startSync requires mode 'live' or 'poll'.`);
    }

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

    // The previous generation's scope was disposed by the transition above;
    // the new generation gets a fresh scope — carrying its mode — once its
    // predecessor's work has fully settled.
    this._runtime = new SyncRuntime(mode);

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
    return this._runtime.mode === 'live' ||
      this._linkControllers.size > 0 ||
      this._runtime.hasTimers(SyncEngineLevel.isLinkInitRetryTimerKey) ||
      this.hasActiveSubscriptions;
  }

  private prepareForSyncRuntimeTransition(): void {
    // Drop the queued follow-up join point: the blocked run wakes later, its
    // transition fence trips, and it cancels without running.
    this._pendingSyncRun = undefined;
    this._lifecycle.pauseTaskAdmission();
    this._runtime.dispose();
    this.installDisposedRuntimeScope();
    this.invalidateSyncTargetsCache();
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

  /** Runtime-scope timer key for the poll interval / live settle check. */
  private static readonly SYNC_INTERVAL_TIMER = 'syncInterval';

  private async startPollSync(intervalMilliseconds: number): Promise<void> {
    const runtime = this._runtime;
    const intervalSync = async (): Promise<void> => {
      if (runtime.disposed) { return; }
      if (this._lifecycle.isSyncInProgress) {
        return;
      }

      runtime.clearTimer(SyncEngineLevel.SYNC_INTERVAL_TIMER);

      try {
        await this.sync(undefined, { verifyConvergence: true });
      } catch (error) {
        // A queued run cancelled by teardown is expected, not an error.
        if (!(error instanceof SyncRunCancelledError)) {
          console.error('SyncEngineLevel: Error during sync operation', error);
        }
      }

      const effectiveInterval = this._connectivityManager.getPollInterval(intervalMilliseconds);

      // Failure backoff re-arms with a widened interval; a concurrent tick
      // that already re-armed wins. A disposed runtime refuses the arm.
      runtime.armIntervalIfAbsent(
        SyncEngineLevel.SYNC_INTERVAL_TIMER,
        this.supervisedTick(intervalSync),
        effectiveInterval,
      );
    };

    runtime.armInterval(SyncEngineLevel.SYNC_INTERVAL_TIMER, this.supervisedTick(intervalSync), intervalMilliseconds);

    // Initiate an immediate sync.
    if (!this._lifecycle.isSyncInProgress) {
      try {
        await this.sync(undefined, { verifyConvergence: true });
      } catch (error) {
        // A queued run cancelled by teardown is expected, not an error.
        if (!(error instanceof SyncRunCancelledError)) {
          console.error('SyncEngineLevel: Error during initial poll sync', error);
        }
      }
    }
  }

  /** Wrap a scheduled operation so each tick runs as supervised background work. */
  private supervisedTick(operation: () => Promise<void>): () => void {
    return (): void => {
      void this._lifecycle.runBackgroundTask(operation);
    };
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
    const runtime = this._runtime;

    // Step 0: Register browser connectivity listeners for instant recovery
    // on network switch, sleep/wake, or tab foregrounding. No-op in Node.
    this._connectivityManager.start();

    // Step 1: Initial durable feed catch-up.
    try {
      await this.sync();
    } catch (error) {
      // A queued run cancelled by teardown is expected, not an error.
      if (!(error instanceof SyncRunCancelledError)) {
        console.error('SyncEngineLevel: Error during initial live-sync catch-up', error);
      }
    }

    // Step 2: Initialize replication links and open live subscriptions.
    // Each target's link initialization is independent — process concurrently.
    const syncTargets = await this.getSyncTargets();
    await Promise.allSettled(syncTargets.map(t => this.initializeLinkTarget(t)));

    // Step 3: Schedule infrequent durable feed settle check.
    const integrityCheck = async (): Promise<void> => this.runLiveIntegrityCheck(runtime);

    runtime.armInterval(SyncEngineLevel.SYNC_INTERVAL_TIMER, this.supervisedTick(integrityCheck), intervalMilliseconds);
  }

  private async runLiveIntegrityCheck(runtime: SyncRuntime): Promise<void> {
    if (runtime.disposed || this._lifecycle.isSyncInProgress) {
      return;
    }

    try {
      await this.sync(undefined, { verifyConvergence: true });
    } catch (error) {
      // A queued run cancelled by teardown is expected, not an error.
      if (!(error instanceof SyncRunCancelledError)) {
        console.error('SyncEngineLevel: Error during durable feed settle check', error);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Per-link repair orchestration
  // ---------------------------------------------------------------------------

  /** Maximum age for a repeatedly deferred pull entry before it is dead-lettered and skipped. */
  private static readonly DEFERRED_PULL_DEAD_LETTER_AFTER_MS = 24 * 60 * 60 * 1000;

  private transitionToPaused(
    linkKey: string,
    link: ReplicationLinkState,
  ): Promise<void> {
    return this._linkRecoveryCoordinator.transitionToPaused(linkKey, link);
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

    // Clear pending rate-limit link-init retries. The runtime scope is
    // normally already disposed here; the explicit clear keeps this teardown
    // correct for any caller that runs it against a live scope.
    this._runtime.clearTimers(SyncEngineLevel.isLinkInitRetryTimerKey);

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
    const runtimeScope = this._runtime;
    let link: ReplicationLinkState | undefined;
    let controller: SyncLinkController | undefined;
    try {
      link = await this.getOrCreateReplicationLink(target);
      if (runtimeScope.disposed) {
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

      const openGeneration = controller.pullEpoch;
      const subscriptionResult = await this.openLinkSubscriptions({ ...target, linkKey }, controller, openGeneration);
      if (subscriptionResult === LinkSubscriptionOpenResult.Inactive || !controller.isActive) {
        // A pause or repair takeover superseded the opening attempt. The
        // durable link now belongs to that transition: reporting Failed
        // here would drop it from the identity's keep-set and let the
        // superseded-link prune delete a fail-safe pause's record.
        if (controller.isActive && (controller.link.status === 'paused' || controller.link.status === 'repairing')) {
          return this.createActiveLinkInitializationResult(link);
        }
        return { status: LinkInitializationStatus.Failed };
      }
      if (subscriptionResult === LinkSubscriptionOpenResult.ReadyForLive) {
        await this.markLinkLive(target, controller, openGeneration);
        if (!controller.isActive) {
          return { status: LinkInitializationStatus.Failed };
        }
      }
      return this.createActiveLinkInitializationResult(link);
    } catch (error: any) {
      if (runtimeScope.disposed) {
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
    openGeneration: number,
  ): Promise<LinkSubscriptionOpenResult> {
    // Cleanup is owned by this opening attempt: once a pause or repair has
    // bumped the generation, the transition owns teardown and the fenced
    // attach kept this attempt from installing anything — a controller-wide
    // close here would tear down the replacement generation's pair.
    const closeOwnAttempt = async (): Promise<void> => {
      if (controller.pullEpoch === openGeneration) {
        await controller.closeSubscriptions();
      }
    };

    const pullOpened = await this.openLivePullSubscription(target, controller, openGeneration);
    if (pullOpened === false || !controller.isActive) {
      await closeOwnAttempt();
      return LinkSubscriptionOpenResult.Inactive;
    }
    if (controller.link.status === 'repairing') {
      await controller.closeLiveSubscription();
      return LinkSubscriptionOpenResult.Repairing;
    }
    // One generation owns the whole pair: a pause (or any reset) landing
    // between the two halves must stop the attempt here — opening the local
    // half under a newer generation would install a subscription the
    // transition's teardown can never have seen.
    if (controller.pullEpoch !== openGeneration || controller.link.status === 'paused') {
      await closeOwnAttempt();
      return LinkSubscriptionOpenResult.Inactive;
    }

    try {
      const pushOpened = await this.openLocalPushSubscription(target, controller, openGeneration);
      if (pushOpened === false || !controller.isActive) {
        await closeOwnAttempt();
        return LinkSubscriptionOpenResult.Inactive;
      }
    } catch (error) {
      await closeOwnAttempt();
      throw error;
    }
    return LinkSubscriptionOpenResult.ReadyForLive;
  }

  private async markLinkLive(
    target: SyncTarget,
    controller: SyncLinkController,
    expectedGeneration: number,
  ): Promise<void> {
    const { link } = controller;
    // A pause or repair takeover during subscription opening owns the link's
    // phase now — completing initialization must not override it.
    if (!controller.isActive || link.status === 'paused' || link.status === 'repairing') { return; }
    if (controller.pullEpoch !== expectedGeneration) { return; }
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
      console.warn(`SyncEngineLevel: ProgressGap detected for ${target.did} -> ${target.dwnUrl}, initiating repair`);
      this.emitEvent({
        type           : 'gap:detected',
        tenantDid      : target.did,
        remoteEndpoint : target.dwnUrl,
        ...syncEventScope(target.scope),
        reason         : 'ProgressGap'
      });
      if (controller !== undefined) {
        await this._linkRecoveryCoordinator.transitionToRepairing(controller, {
          resumeToken: error.gapInfo?.latestAvailable,
        });
      }
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

  /** Runtime-scope key prefix for pending rate-limit link-init retries. */
  private static readonly LINK_INIT_RETRY_TIMER_PREFIX = 'linkInitRetry:';

  private static linkInitRetryTimerKey(linkKey: string): string {
    return `${SyncEngineLevel.LINK_INIT_RETRY_TIMER_PREFIX}${linkKey}`;
  }

  private static isLinkInitRetryTimerKey(timerKey: string): boolean {
    return timerKey.startsWith(SyncEngineLevel.LINK_INIT_RETRY_TIMER_PREFIX);
  }

  /** Whether a runtime-scope timer key is a pending init retry for the given DID's links. */
  private isLinkInitRetryTimerKeyForDid(timerKey: string, did: string): boolean {
    return SyncEngineLevel.isLinkInitRetryTimerKey(timerKey) &&
      this.isLinkKeyForDid(timerKey.slice(SyncEngineLevel.LINK_INIT_RETRY_TIMER_PREFIX.length), did);
  }

  /** Whether an identity has any armed rate-limit link-initialization retry. */
  private hasLinkInitRetriesForDid(did: string): boolean {
    return this._runtime.hasTimers(
      (timerKey: string): boolean => this.isLinkInitRetryTimerKeyForDid(timerKey, did),
    );
  }

  /** Cancel pending rate-limit init retries whose captured targets belong to an identity. */
  private cancelLinkInitRetriesForDid(did: string): void {
    this._runtime.clearTimers((timerKey: string): boolean => this.isLinkInitRetryTimerKeyForDid(timerKey, did));
  }

  private isRateLimitError(error: unknown): error is RateLimitError {
    return error instanceof RateLimitError;
  }

  /**
   * Re-attempt live-subscription initialization for a rate-limited link after
   * the server-provided Retry-After window. Coalesces repeated requests for the
   * same link so a burst of 429s schedules a single pending retry (arming
   * replaces any pending timer for the key). A repeated rate limit on the
   * retry reschedules again via {@link handleInitializeLinkTargetError}. The
   * timer is runtime-scope-owned: a transition disposes it, and a firing the
   * event loop queued before that never starts.
   */
  private scheduleLinkInitRetry(target: SyncTarget, linkKey: string, delayMs: number): void {
    const taskGroup = this._lifecycle.getIdentityTaskGroup(target.did);
    this._runtime.armTimeout(SyncEngineLevel.linkInitRetryTimerKey(linkKey), (): void => {
      void this._lifecycle.runIdentityTask(taskGroup, async (): Promise<void> => {
        try {
          await this.initializeLinkTarget(target);
        } catch {
          // Errors are handled inside initializeLinkTarget's catch block,
          // which reschedules another retry on a repeat rate limit.
        }
      });
    }, delayMs);
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
    const runtimeScope = this._runtime;
    try {
      return await this.initializeLinkTarget(target);
    } catch (error: any) {
      if (!this.isDidResolutionFailure(error)) { throw error; }

      for (const delay of SyncEngineLevel.DID_RESOLUTION_RETRY_BACKOFF_MS) {
        // A runtime transition during an attempt or the backoff tore down
        // whatever this initialization would have joined; a retry now would
        // re-activate a link controller and reopen subscriptions behind that
        // teardown. Checked on both sides of the sleep so a transition during
        // the previous attempt skips the backoff wait entirely.
        if (runtimeScope.disposed) {
          return { status: LinkInitializationStatus.Failed };
        }
        await sleep(delay);
        if (runtimeScope.disposed) {
          return { status: LinkInitializationStatus.Failed };
        }
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

  /**
   * Check whether a link key belongs to a given DID. Link keys always join
   * segments with {@link LINK_ID_SEPARATOR}, which cannot appear in a DID.
   * Matching must use exactly that delimiter: underscores ARE valid DID
   * characters, so a looser prefix match would let one DID claim the keys of
   * another DID that merely extends it (e.g. `…alice` vs `…alice_extra`).
   */
  private isLinkKeyForDid(key: string, did: string): boolean {
    return key.startsWith(did + LINK_ID_SEPARATOR);
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
    this.cancelLinkInitRetriesForDid(did);
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
    expectedGeneration?: number,
  ): Promise<boolean> {
    if (!controller.isActive || controller.linkKey !== target.linkKey) { return false; }
    // Pin the pull generation before the first await — the caller's pair
    // generation when opening both halves, else the current one: a repair
    // or pause that resets the pull runtime while this open is in flight
    // supersedes the subscription being built, and it must not be installed.
    const subscriptionPullEpoch = expectedGeneration ?? controller.pullEpoch;
    return this.runGenerationFencedOpen(controller, subscriptionPullEpoch, (): Promise<boolean> =>
      this.openLivePullSubscriptionAttempt(target, controller, subscriptionPullEpoch));
  }

  /**
   * Run one subscription-opening attempt pinned to a pull generation. A
   * rejection belonging to a superseded attempt is that attempt's teardown,
   * not the link's failure — it must not reach initialization error
   * handling, which could repair or clean up the current generation's
   * controller. Current-generation failures propagate unchanged.
   */
  private async runGenerationFencedOpen(
    controller: SyncLinkController,
    subscriptionPullEpoch: number,
    attempt: () => Promise<boolean>,
  ): Promise<boolean> {
    try {
      return await attempt();
    } catch (error: unknown) {
      if (!controller.isPullEpochCurrent(subscriptionPullEpoch)) {
        return false;
      }
      throw error;
    }
  }

  private async openLivePullSubscriptionAttempt(
    target: LinkSyncTarget,
    controller: SyncLinkController,
    subscriptionPullEpoch: number,
  ): Promise<boolean> {
    const { did, delegateDid, dwnUrl } = target;
    const eventScope = syncEventScope(target.scope);

    const cursorKey = target.linkKey;
    const { link } = controller;
    const cursor = await this.getInitialPullCursor({ did, dwnUrl, link });
    if (!controller.isPullEpochCurrent(subscriptionPullEpoch) || controller.linkKey !== cursorKey) { return false; }

    const filters = target.scope.kind === 'protocolSet'
      ? target.scope.protocols.map(protocol => ({ protocol }))
      : [];

    const runtimeScope = this._runtime;

    // Define the subscription handler that processes incoming events.
    // NOTE: The WebSocket client fires handlers without awaiting (fire-and-forget),
    // so multiple handlers can be in-flight concurrently. The ordinal tracker
    // ensures the checkpoint advances only when all earlier deliveries are committed.
    // Capture the controller lifetime so remove+re-add invalidates callbacks
    // even when the replacement uses the same durable link key, and the pull
    // generation so callbacks from a subscription superseded by a repair reset
    // cannot touch checkpoints or trigger repairs after the link recovers.
    const isStale = (): boolean => runtimeScope.disposed || !controller.isPullEpochCurrent(subscriptionPullEpoch);
    const pullContext: SyncLivePullContext = {
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
    const runIdentityTask = this._lifecycle.captureIdentityTaskRunner(did);

    const subscriptionHandler = (subMessage: SubscriptionMessage): Promise<void> =>
      runIdentityTask(() => this.handleLivePullMessage(pullContext, subMessage));

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
    if (!controller.isPullEpochCurrent(subscriptionPullEpoch)) { return false; }
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
      if (effectiveCursor && !isValidProgressToken(effectiveCursor)) {
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
    // No stale-reply handling here: a superseded 200 is refused by the
    // generation-fenced attach below (and closed by its refusal path), and
    // a superseded 410 or error throw is converted to `false` by the
    // generation-fenced wrapper.
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
    if (!controller.setLiveSubscription({ close }, subscriptionPullEpoch)) {
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
    if (!cursor || isValidProgressToken(cursor)) {
      return cursor;
    }

    // Guard against corrupted tokens with empty fields — these would fail
    // MessagesSubscribe JSON schema validation (minLength: 1). Discard and
    // start from the beginning rather than crash the subscription.
    console.warn(`SyncEngineLevel: Discarding stored cursor with empty field(s) for ${did} -> ${dwnUrl}`);
    await this.ledger.resetCheckpoint(link, 'pull');
    return undefined;
  }

  /** Thin transport boundary retained for lifecycle task tracking and tests. */
  private handleLivePullMessage(
    context: SyncLivePullContext,
    subMessage: SubscriptionMessage,
  ): Promise<void> {
    return this._livePullProcessor.handleMessage(context, subMessage);
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
    expectedGeneration?: number,
  ): Promise<boolean> {
    if (!controller.isActive || controller.linkKey !== target.linkKey) { return false; }
    // Same generation ownership as the pull side: a pause or repair that
    // lands while the local subscribe is pending supersedes this attempt.
    const subscriptionPullEpoch = expectedGeneration ?? controller.pullEpoch;
    return this.runGenerationFencedOpen(controller, subscriptionPullEpoch, (): Promise<boolean> =>
      this.openLocalPushSubscriptionAttempt(target, controller, subscriptionPullEpoch));
  }

  private async openLocalPushSubscriptionAttempt(
    target: LinkSyncTarget,
    controller: SyncLinkController,
    subscriptionPullEpoch: number,
  ): Promise<boolean> {
    const { did, delegateDid } = target;

    const filters = target.scope.kind === 'protocolSet'
      ? target.scope.protocols.map(protocol => ({ protocol }))
      : [];

    const runtimeScope = this._runtime;

    const isPushStale = (): boolean =>
      runtimeScope.disposed || !controller.isPullEpochCurrent(subscriptionPullEpoch);
    const runIdentityTask = this._lifecycle.captureIdentityTaskRunner(did);

    // Subscribe to the local DWN's EventLog.
    const subscriptionHandler = (subMessage: SubscriptionMessage): Promise<void> =>
      runIdentityTask(() => this._livePushCoordinator.handleEvent(
        target,
        controller,
        isPushStale,
        runIdentityTask,
        subMessage,
      ));

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
    if (!controller.setLocalSubscription({ close }, subscriptionPullEpoch)) {
      try {
        await close();
      } catch {
        // Best-effort cleanup of a subscription opened for a stale lifetime.
      }
      return false;
    }
    return true;
  }

  private scheduleQuotaProbeForActiveLink(
    linkKey: string,
    link: ReplicationLinkState,
    nextProbeAt: string,
  ): void {
    this._livePushCoordinator.scheduleQuotaProbe(linkKey, link, nextProbeAt);
  }

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
      errorCode      : failure.kind ?? 'Invalid',
      errorDetail    : failure.detail ?? 'push rejected during sync reconciliation',
    });
  }

  private scheduleLinkReconcile(linkKey: string, link: ReplicationLinkState, reason: string, delayMs?: number): void {
    // Link-addressed callers (feed convergence, quota manager, push quota
    // probes) can run in poll mode where no controller exists; resolving to
    // a matching active controller here keeps those requests no-ops exactly
    // as before, while the recovery coordinator itself is controller-addressed.
    const controller = this.getMatchingLinkController(linkKey, link);
    if (controller === undefined) {
      return;
    }
    this._linkRecoveryCoordinator.scheduleLinkReconcile(controller, reason, delayMs);
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
    for (const { state } of dataBlocks) {
      const blockedCid = state.blockedCid;
      if (blockedCid === entry.messageCid || initialCids.includes(blockedCid)) { continue; }
      const local = await this.getLocalMessageForTarget(target, blockedCid);
      if (
        local !== undefined &&
        local.dataStream === undefined &&
        isInitialWriteForRecord(local.message, recordId)
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
    const fromEntry = recordIdForRecordsMessage(entry.message);
    if (fromEntry !== undefined) { return fromEntry; }

    const local = await this.getLocalMessageForTarget(target, entry.messageCid);
    return recordIdForRecordsMessage(local?.message);
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
      await this.runDeferredPullLifecycle(target.did, async (): Promise<void> => {
        await this.clearDeferredPull(target.did, target.dwnUrl, cid);
        await this.clearFailedMessageForTenant(target.did, cid, target.dwnUrl);
      });
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
    return this.runDeferredPullLifecycle(target.did, async (): Promise<boolean> => {
      // Stale work fence: after an unregister commits (inside this same
      // per-tenant lock), deferred work for the tenant must yield rather
      // than re-create retry state or dead letters.
      if (await this.getIdentityOptions(target.did) === undefined) {
        return true;
      }

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
        errorCode      : 'Deferred',
        errorDetail    : detail ?? 'pull admission deferred beyond retry window',
      });
      await this.clearDeferredPull(target.did, target.dwnUrl, entry.messageCid);
      return true;
    });
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

  /**
   * Serialize identity lifecycle mutations (register, update, unregister)
   * across every context sharing this storage, so one context's unregister
   * cannot interleave with another's re-registration and prune its fresh
   * durable links.
   *
   * Lock order: this lock is OUTERMOST. The per-tenant deferred-pull lock
   * may be taken inside it (unregister does), never the reverse.
   */
  private async runIdentityLifecycle<T>(did: string, operation: () => Promise<T>): Promise<T> {
    return runWithCrossContextLock(`enbox:sync-identity:${this._lockScope}:${did}`, operation);
  }

  /**
   * Serialize the deferred/dead-letter lifecycle per tenant across contexts.
   * Every participant — admission cleanup, expiry promotion, and unregister's
   * tenant sweep — runs its read-decide-write section under this lock, which
   * is the single mechanism making those sections atomic with each other.
   */
  private async runDeferredPullLifecycle<T>(
    tenantDid: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return runWithCrossContextLock(`enbox:sync-deferred-pull:${this._lockScope}:${tenantDid}`, operation);
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
    // The quota manager fences its awaits with the shouldContinue it is
    // given; compose a transition fence in so probes abort on start/stop/
    // clear/close exactly as the old internal engine-generation reads did —
    // including for one-shot callers running without a live runtime.
    const transitionFence = this.captureTransitionFence();
    const composed = shouldContinue === undefined
      ? transitionFence
      : (): boolean => transitionFence() && shouldContinue();
    return this._quotaManager.probeBlocksForTarget(target, force, forceProbeCids, composed);
  }

  /**
   * Capture a fence that reports whether a runtime transition (start, stop,
   * clear, close, mode switch) has happened since capture. Valid from any
   * state: an active scope trips the fence when it is disposed, and an
   * already-disposed scope trips it when a new runtime replaces it.
   */
  private captureTransitionFence(): () => boolean {
    const runtime = this._runtime;
    const disposedAtCapture = runtime.disposed;
    return (): boolean => this._runtime === runtime && runtime.disposed === disposedAtCapture;
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
    delete message.encodedData;
    const syncEntry: SyncMessageEntry = {
      message,
      isLatestBaseState: entry.isLatestBaseState,
    };
    const encodedData = entry.encodedData;
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
    remoteEndpoint : string;
    protocol? : string;
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
    return entry?.tenantDid === tenantDid;
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

  public async getReplicationLinks(tenantDid?: string): Promise<ReplicationLinkSnapshot[]> {
    return this._statusReporter.getReplicationLinks(tenantDid);
  }

  public async retryRemoteNow(tenantDid: string, remoteEndpoint: string): Promise<void> {
    const transitionFence = this.captureTransitionFence();
    const retry = this._retryRemoteQueue.then(async (): Promise<void> => {
      await this.doRetryRemoteNow(tenantDid, remoteEndpoint, transitionFence);
    });
    this._retryRemoteQueue = retry.catch((): void => {
      // Keep the queue usable after surfacing the original operation failure.
    });
    await retry;
  }

  private async doRetryRemoteNow(tenantDid: string, remoteEndpoint: string, transitionFence: () => boolean): Promise<void> {
    // A normal sync/drain already owns the feed checkpoints. Let that operation
    // finish, then preserve the explicit retry request rather than racing its
    // checkpoint writes or silently dropping a UI Retry-now action.
    await this._lifecycle.acquireSync();

    try {
      if (!transitionFence()) {
        return;
      }
      const topologyGeneration = this._targetPlanner.generation;
      const targets = (await this.getSyncTargets()).filter(
        (target) => target.did === tenantDid && target.dwnUrl === remoteEndpoint,
      );

      await Promise.all(targets.map(async (target) => {
        await this.retryQuotaBlocksForTarget(target, transitionFence, topologyGeneration);
      }));
    } finally {
      this._lifecycle.releaseSync();
    }
  }

  private async retryQuotaBlocksForTarget(
    target: SyncTarget,
    transitionFence: () => boolean,
    topologyGeneration: number,
  ): Promise<void> {
    const key = this._quotaManager.getLinkKey(target);
    const existing = this._quotaRetryInFlight.get(key);
    if (existing !== undefined) {
      await existing;
      return;
    }

    const retry = (async (): Promise<void> => {
      const blocks = await this.getQuotaBlocksForTarget(target);
      if (
        blocks.length === 0 ||
        !transitionFence() ||
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
          transitionFence() &&
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
