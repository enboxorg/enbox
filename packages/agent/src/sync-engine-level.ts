import type { AbstractLevel } from 'abstract-level';

import type { DwnSubscriptionHandler, DwnSubscriptionMessage, ResubscribeFactory } from '@enbox/dwn-clients';
import type { GenericMessage, MessagesFilter, MessagesQueryReply, MessagesQueryReplyEntry, MessagesSubscribeReply, RecordsQueryReply, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import { RateLimitError } from '@enbox/dwn-clients';
import { DwnInterfaceName, DwnMethodName, Encoder, Message } from '@enbox/dwn-sdk-js';
import { parseDurationInMilliseconds, sleep } from '@enbox/common';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { SyncDeadLetterStore } from './sync-dead-letter-store.js';
import type { SyncEndpointStore } from './sync-endpoint-store.js';
import type { SyncFreshEntry } from './sync-admit-closure.js';
import type { SyncIdentityStore } from './sync-identity-store.js';
import type { SyncIdentityTaskRunner } from './sync-lifecycle-coordinator.js';
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
  SyncEventScope,
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
import type { SyncQuotaBlockEntry, SyncQuotaPushResultOutcome } from './sync-quota-manager.js';
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
import { SyncQuotaManager } from './sync-quota-manager.js';
import { SyncQuotaStoreLevel } from './sync-quota-store-level.js';
import { SyncReplicationLinkStoreLevel } from './sync-replication-link-store-level.js';
import { SyncRunCoordinator } from './sync-run-coordinator.js';
import { SyncRuntime } from './sync-runtime.js';
import { SyncScopeClosureValidator } from './sync-scope-closure-validator.js';
import { SyncStatusReporter } from './sync-status-reporter.js';
import { SyncTargetPlanner } from './sync-target-planner.js';
import { buildDurableLinkIdentityKey, buildLinkKey, LINK_KEY_SEPARATOR } from './sync-link-key.js';
import { computeProjectionId, isTerminalPushFailure, lexicographicalCompare, singleProtocolForSyncScope, syncEventScope, syncScopeFromProtocols } from './types/sync.js';
import { fetchRemoteMessages, getLocalMessage, isInitialWriteForRecord, pushMessageEntries, pushMessages, queryLocalMessageFeed, queryRemoteMessageFeed, recordIdForRecordsMessage, syncMessageDescriptor } from './sync-messages.js';
import { getMessagesPermissionGrantsForScope, permissionGrantIdsFromEntries, SyncProtocolRootPermissionGrantMissingError, toMessagesPermissionGrantIds } from './sync-permission-grants.js';
import { isTerminalSyncAuthorizationFailure, SyncRunCancelledError } from './sync-runtime-errors.js';
import { isValidProgressToken, SyncCheckpoint } from './sync-checkpoint.js';
import { normalizeDwnEndpoint, SyncTargetResolver } from './sync-target-resolver.js';

export type SyncEngineLevelParams = {
  agent?: EnboxPlatformAgent;
  dataPath?: string;
  db?: AbstractLevel<string | Buffer | Uint8Array>;
};

type LinkSyncTarget = SyncTarget & { linkKey: string };

type LivePullWakeContext = {
  controller: SyncLinkController;
  did: string;
  dwnUrl: string;
  eventScope: SyncEventScope;
  isStale: () => boolean;
  link: ReplicationLinkState;
  linkKey: string;
};

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
  private readonly _quotaManager: SyncQuotaManager;
  private readonly _runCoordinator: SyncRunCoordinator;

  /**
   * Timer owner for the current runtime. Replaced by `startSync`
   * after the previous runtime's work settles; disposed by every runtime
   * transition, which cancels all owned timers.
   */
  private _runtime = new SyncRuntime();
  private readonly _scopeClosureValidator: SyncScopeClosureValidator;
  private readonly _statusReporter: SyncStatusReporter;
  private readonly _targetPlanner: SyncTargetPlanner;
  private _targetResolver?: SyncTargetResolver;

  /**
   * Durable replication-link store for pull/push checkpoints and link status.
   * Used by live sync, one-shot reconciliation, drain, superseded-link
   * pruning, and health reporting. Lazily initialized on first use to avoid
   * sublevel calls on mock databases.
   */
  private _replicationLinkStore?: SyncReplicationLinkStore;

  /** Active link lifetimes and their backend-neutral ephemeral state. */
  private readonly _linkControllers: Map<string, SyncLinkController> = new Map();

  // ---------------------------------------------------------------------------
  // Engine-lifetime state (survives every start/stop cycle)
  // ---------------------------------------------------------------------------

  /**
   * The queued follow-up run shared by `sync()` callers that arrived while
   * the exclusive lock was held. Cleared the moment the follow-up acquires
   * the lock, so later callers start a fresh cycle. See {@link joinPendingSyncRun}.
   */
  private _pendingSyncRun?: PendingSyncRun;

  /**
   * Storage-location discriminator folded into cross-context lock names, so
   * engines over different `dataPath`s never contend on each other's locks.
   * Keys off `dataPath` like the wake channel does, but with its own
   * fallback: engines constructed with an injected `db` and no `dataPath`
   * all use the `'default'` namespace. Acceptable because that path is
   * single-process (tests, embedded hosts), not a cross-context origin.
   */
  private readonly _lockNamespace: string;

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
    this._lockNamespace = dataPath ?? 'default';
    this._db = db ?? new Level<string, string>(dataPath ?? 'DATA/AGENT/SYNC_STORE');

    // Durable stores. Every collaborator below reads through one of these,
    // so they must exist first.
    this._deadLetterStore = new SyncDeadLetterStoreLevel(this._db);
    this._deferredPullStore = new SyncDeferredPullStoreLevel(this._db);
    this._endpointStore = new SyncEndpointStoreLevel(this._db);
    this._identityStore = new SyncIdentityStoreLevel(this._db);

    // Collaborators. Each is handed an `operations` adapter of arrow
    // functions that resolve `this.…` at CALL time, not here — which is why
    // this list does not have to be in dependency order. The drain
    // coordinator names the feed-convergence manager, and the link-recovery
    // coordinator names engine-owned subscription operations, all of which are
    // constructed further down. Keep the adapters lazy and that stays true.
    this._connectivityManager = new SyncConnectivityManager();
    this._drainCoordinator = this.createDrainCoordinator();
    this._runCoordinator = this.createRunCoordinator();
    this._scopeClosureValidator = this.createScopeClosureValidator();
    this._quotaManager = this.createQuotaManager();
    this._feedConvergenceManager = this.createFeedConvergenceManager();
    this._durableFeedReconciler = this.createDurableFeedReconciler();
    this._targetPlanner = this.createTargetPlanner();
    this._statusReporter = this.createStatusReporter();
    this._linkRecoveryCoordinator = this.createLinkRecoveryCoordinator();
  }

  /** Wire SyncDrainCoordinator to this engine. */
  private createDrainCoordinator(): SyncDrainCoordinator {
    return new SyncDrainCoordinator({
      identityStore : this._identityStore,
      operations    : {
        buildTargetsForEndpoint: (did, remoteEndpoint, options): Promise<SyncTarget[]> =>
          this.targetResolver.buildTargetsForEndpoint(did, remoteEndpoint, options),
        clearFeedConvergenceFailure: (target): Promise<void> =>
          this._feedConvergenceManager.clear(target),
        getLink                      : (target): Promise<ReplicationLinkState> => this.getOrCreateReplicationLink(target),
        getQuotaBlockCount           : async (target): Promise<number> => (await this.getQuotaBlocksForTarget(target)).length,
        getTopologyGeneration        : (): number => this._targetPlanner.topologyGeneration,
        handleVerifiedFeedDivergence : (target, result): Promise<boolean> =>
          this._feedConvergenceManager.handleVerifiedDivergence(target, result),
        prepareLiveTarget : (target): Promise<void> => this.prepareDrainLiveTarget(target),
        reconcileTarget   : (target, options, shouldContinue): Promise<SyncReconcileResult> =>
          this.reconcileTarget(target, options, shouldContinue),
        recordConnectivityFailure : (): void => { this._connectivityManager.recordFailure(); },
        recordConnectivitySuccess : (): void => { this._connectivityManager.recordSuccess(); },
        recordPushFailures        : async (target, failures): Promise<void> => {
          await this.recordTerminalPushFailures(target, failures);
        },
        registerEndpoint: (remoteEndpoint): Promise<void> =>
          this.registerSupplementalDwnEndpoint(remoteEndpoint),
        verifyConvergence: (target, shouldContinue): Promise<SyncReconcileResult> =>
          this.verifyFeedConvergence(target, shouldContinue),
      },
    });
  }

  /** Wire SyncRunCoordinator to this engine. */
  private createRunCoordinator(): SyncRunCoordinator {
    return new SyncRunCoordinator({
      operations: {
        clearFeedConvergenceFailure: (target): Promise<void> =>
          this._feedConvergenceManager.clear(target),
        getTargets                   : (): Promise<SyncTarget[]> => this.getSyncTargets(),
        handleVerifiedFeedDivergence : async (target, result): Promise<void> => {
          await this._feedConvergenceManager.handleVerifiedDivergence(target, result);
        },
        probeFeedConvergence: (target): Promise<SyncReconcileResult> =>
          this.probeFeedConvergence(target),
        reconcileTarget: (target, direction, verifyConvergence): Promise<SyncReconcileResult> =>
          this.reconcileTarget(target, { direction, verifyConvergence }),
        recordConnectivityFailure : (): void => { this._connectivityManager.recordFailure(); },
        recordConnectivitySuccess : (): void => { this._connectivityManager.recordSuccess(); },
        recordPushFailures        : (target, failures): Promise<number> =>
          this.recordTerminalPushFailures(target, failures),
        reportError: (message, error): void => { console.error(message, error); },
      },
    });
  }

  /** Wire SyncScopeClosureValidator to this engine. */
  private createScopeClosureValidator(): SyncScopeClosureValidator {
    return new SyncScopeClosureValidator({
      operations: {
        queryProtocolHistory: (query): Promise<SyncScopeProtocolHistoryPage> =>
          this.queryScopeProtocolHistory(query),
        resolvePermissionGrantIds: (query): Promise<SyncScopeClosureGrantResolution> =>
          this.resolveScopeClosurePermissionGrantIds(query),
      },
    });
  }

  /** Wire SyncQuotaManager to this engine. */
  private createQuotaManager(): SyncQuotaManager {
    return new SyncQuotaManager({
      store      : new SyncQuotaStoreLevel(this._db),
      operations : {
        clearDeadLetterForTenant: (target, messageCid): Promise<void> =>
          this.clearDeadLetterForTenant(target.did, messageCid, target.dwnUrl),
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
  }

  /** Wire SyncFeedConvergenceManager to this engine. */
  private createFeedConvergenceManager(): SyncFeedConvergenceManager {
    return new SyncFeedConvergenceManager({
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
        isLinkKeyForTenant         : (linkKey, tenantDid): boolean => this.isLinkKeyForDid(linkKey, tenantDid),
        resetCheckpoints           : (link): Promise<void> => this.replicationLinkStore.resetCheckpoints(link),
        scheduleLinkReconcileByKey : (linkKey, link, reason, delayMs): void => {
          this.scheduleLinkReconcileByKey(linkKey, link, reason, delayMs);
        },
        scheduleQuotaProbe: (linkKey, link, nextProbeAt): void => {
          this.scheduleQuotaProbeForActiveLink(linkKey, link, nextProbeAt);
        },
        transitionToPaused: (linkKey, link): Promise<void> => this.transitionToPaused(linkKey, link),
      },
    });
  }

  /** Wire SyncDurableFeedReconciler to this engine. */
  private createDurableFeedReconciler(): SyncDurableFeedReconciler {
    return new SyncDurableFeedReconciler({
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
      getQuotaBlockCids: async (target): Promise<string[]> =>
        (await this.getQuotaBlocksForTarget(target)).map(({ messageCid }) => messageCid),
      commitCheckpoint: (link, direction): Promise<void> =>
        this.commitReconciledCheckpoint(link, direction),
      probeQuotaBlocks: (target, force, forceProbeCids, shouldContinue): Promise<void> =>
        this.probeQuotaBlocksForTarget(target, force, forceProbeCids, shouldContinue),
      pushLocalPage: (target, entries, shouldContinue): Promise<FeedPagePushResult> =>
        this.pushLocalFeedPage(target, entries, shouldContinue),
      queryFeed       : (query): Promise<MessagesQueryReply> => this.queryDurableFeed(query),
      resetCheckpoint : (link, direction): Promise<void> => this.replicationLinkStore.resetCheckpoint(link, direction),
    });
  }

  /** Wire SyncTargetPlanner to this engine. */
  private createTargetPlanner(): SyncTargetPlanner {
    return new SyncTargetPlanner({
      getTargetResolver : (): SyncTargetResolver => this.targetResolver,
      identityStore     : this._identityStore,
      warn              : (message, error): void => { console.warn(message, error); },
    });
  }

  /** Wire SyncStatusReporter to this engine. */
  private createStatusReporter(): SyncStatusReporter {
    return new SyncStatusReporter({
      operations: {
        getConnectivityState       : (): SyncConnectivityState => this.connectivityState,
        getCurrentLinkIdentityKeys : (): Promise<Set<string> | undefined> => this.getCurrentDurableLinkIdentityKeys(),
        getCurrentQuotaLinkKeys    : (): Promise<Set<string> | undefined> => this.getCurrentQuotaLinkKeys(),
        getDeadLetters             : (): Promise<DeadLetterEntry[]> => this._deadLetterStore.getAll(),
        getLinks                   : (): Promise<ReplicationLinkState[]> => this.replicationLinkStore.getAllLinks(),
        getQuotaBlocks             : (): Promise<SyncQuotaBlockState[]> => this._quotaManager.getAllBlockStates(),
      },
    });
  }

  /** Wire SyncLinkRecoveryCoordinator to this engine. */
  private createLinkRecoveryCoordinator(): SyncLinkRecoveryCoordinator {
    return new SyncLinkRecoveryCoordinator({
      operations: {
        captureIdentityTaskRunner: (tenantDid): SyncIdentityTaskRunner =>
          this._lifecycle.captureIdentityTaskRunner(tenantDid),
        clearConvergence : (linkKey): void => { this._feedConvergenceManager.clearLink(linkKey); },
        emitEvent        : (event): void => { this.emitEvent(event); },
        getController    : (linkKey): SyncLinkController | undefined => this.getLinkController(linkKey),
        getRuntime       : (): SyncRuntimeHandle => this._runtime,
        handleDivergence : (target, result, context): Promise<boolean> =>
          this._feedConvergenceManager.handleVerifiedDivergence(target, result, context),
        openPullSubscription: (target, controller): Promise<boolean> =>
          this.openLivePullSubscription(target, controller),
        openPushSubscription: (target, controller): Promise<boolean> =>
          this.openLocalPushSubscription(target, controller),
        reconcileTarget: (controller, target, options, shouldContinue, bypassDirectionQueues): Promise<SyncReconcileResult> =>
          this.reconcileOwnedTarget(
            controller,
            target,
            options,
            shouldContinue,
            bypassDirectionQueues !== true,
          ),
        reportError : (message, error): void => { console.error(message, error); },
        setStatus   : (link, status): Promise<void> => this.replicationLinkStore.setStatus(link, status),
        warn        : (message): void => { console.warn(message); },
      },
    });
  }


  /** Lazy accessor for the durable replication-link store. */
  private get replicationLinkStore(): SyncReplicationLinkStore {
    this._replicationLinkStore ??= new SyncReplicationLinkStoreLevel(this._db, this._lockNamespace);
    return this._replicationLinkStore;
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
    await this.replicationLinkStore.clear();
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
   * Advance the target planner's topology generation and drop its cached
   * plan, so the next `getSyncTargets()` re-resolves. Every call site that
   * mutates sync configuration routes through here — agent swap, identity
   * register/update/unregister, supplemental endpoint registration, and
   * every runtime transition. Cache-reuse gating itself lives in
   * {@link SyncTargetPlanner}, not on this class.
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
    this._runtime.cancelTimer(SyncEngineLevel.linkInitRetryTimerKey(linkKey));

    const existing = this._linkControllers.get(linkKey);
    if (existing?.link === link && existing.isActive) {
      return existing;
    }

    if (existing !== undefined) {
      // Closing starts synchronously; the controller absorbs transport close
      // errors while the replacement lifetime is installed.
      void existing.dispose();
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

    // Removal is synchronous for callback invalidation; subscription closure
    // is best effort and cannot reject from the controller.
    void controller.dispose();
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

  private emitDeliveryApplied(
    target: Pick<SyncTarget, 'did' | 'dwnUrl' | 'scope'>,
    messageCid: string,
    message: GenericMessage,
  ): void {
    this.emitEvent({
      type           : 'delivery:applied',
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      ...syncEventScope(target.scope),
      messageCid,
      descriptor     : syncMessageDescriptor(message),
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
   * Installing a fresh disposed runtime invalidates work that queued against
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
      this.installDisposedRuntime();
      this._lifecycle.releaseSync();
    }
  }

  /**
   * Replace the current runtime with a fresh, already-disposed one. Every
   * transition installs a new runtime object, so a fence captured under ANY
   * earlier runtime — including one captured while the engine was already
   * stopped — observes the transition as an identity change.
   */
  private installDisposedRuntime(): void {
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
    if (this._runtime.live) {
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
    if (this._runtime.live) {
      await this.removeIdentityFromLiveSync(did);
    }

    // A pending rate-limit init retry may exist even without an active link
    // (the 429 path drops the controller before arming the retry, so the
    // hot-remove above can be skipped entirely). Its captured target is now
    // unregistered — cancel it unconditionally.
    this.cancelLinkInitRetriesForDid(did);

    // Tenant-scoped deletion runs first; the identity marker is deleted LAST
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
    // states alike as a prior live runtime that must be stopped. The normal
    // identity stop pauses task intake before settling, then cancels
    // any retry re-armed by work that was already in flight.
    const identityTaskGroup = this._lifecycle.getIdentityTaskGroup(did);
    const hadPriorLiveRuntime = hadPendingLinkInitRetry ||
      identityTaskGroup.size > 0 ||
      this.hasActiveLinksForDid(did);
    const rebuildLiveLinks = this._runtime.live && hadPriorLiveRuntime;
    if (hadPriorLiveRuntime) {
      await this.removeIdentityFromLiveSync(did);
    }

    // Scope/delegate changes define different replication links. A block from
    // the previous authorization must not suppress the replacement link's
    // first delivery attempt. Clear only after old link work has drained so it
    // cannot recreate stale state after the quota state is cleared.
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
      // Detach the join point: callers arriving from here on queue a fresh
      // follow-up. `merged` stays the live object this run reads below — the
      // detach is what stops later joiners from mutating it mid-run.
      if (this._pendingSyncRun === followUp) {
        this._pendingSyncRun = undefined;
      }
      try {
        // A runtime transition (startSync/stopSync/clear/close) invalidated
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
    if (!this._runtime.live) {
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

  public startSync(params: StartSyncParams = {}): Promise<void> {
    return this._lifecycle.runTransition(async (): Promise<void> => {
      await this.startSyncRuntime(params);
    });
  }

  private async startSyncRuntime(params: StartSyncParams): Promise<void> {
    // An invalid interval rejects here, before any runtime is torn down. The
    // parsed value is clamped: the floor prevents a tight settle-check loop
    // ('0s' would tick every macrotask), and the ceiling stays within the
    // 32-bit native timer range (an overflowing delay silently clamps to
    // ~1ms — also a tight loop).
    const intervalMilliseconds = Math.min(
      Math.max(parseDurationInMilliseconds(params.interval ?? '5m'), SyncEngineLevel.MIN_SYNC_INTERVAL_MS),
      SyncEngineLevel.MAX_SYNC_INTERVAL_MS,
    );

    const hadLiveRuntime = this.hasLiveSyncRuntime();
    this.prepareForSyncRuntimeTransition();
    if (hadLiveRuntime) {
      await this.stopLiveSync();
    }
    if (this._lifecycle.isSyncInProgress) {
      await this.waitForSyncCompletion();
    }
    if (this._lifecycle.backgroundTaskCount > 0) {
      await this.waitForBackgroundTasks();
    }
    this._lifecycle.clearIdentityTaskGroups();
    this._lifecycle.resumeTaskIntake();

    // The previous runtime was disposed by the transition above; install a
    // fresh live runtime only after its predecessor's work has fully settled.
    this._runtime = new SyncRuntime(true);

    await this.startLiveSync(intervalMilliseconds);
  }

  /**
   * stopSync invalidates scheduled work and closes live subscriptions, then
   * waits for current lock-owning and background sync operations to finish.
   *
   * @param timeout - Maximum milliseconds to wait for in-progress sync work
   *   to finish. Non-finite values (`NaN`, `Infinity`) are
   *   coerced to the default to avoid a tight busy-wait loop or never-exit
   *   condition.
   */
  public stopSync(timeout: number = 2000): Promise<void> {
    return this._lifecycle.runTransition(async (): Promise<void> => {
      await this.stopSyncRuntime(timeout);
    });
  }

  private hasLiveSyncRuntime(): boolean {
    return this._runtime.live ||
      this._linkControllers.size > 0 ||
      this._runtime.hasTimers(SyncEngineLevel.isLinkInitRetryTimerKey) ||
      this.hasActiveSubscriptions;
  }

  private prepareForSyncRuntimeTransition(): void {
    // Drop the queued follow-up join point: the blocked run wakes later, its
    // transition fence trips, and it cancels without running.
    this._pendingSyncRun = undefined;
    this._lifecycle.pauseTaskIntake();
    this._runtime.dispose();
    this.installDisposedRuntime();
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
    await this.stopLiveSync();
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
  // Live sync
  // ---------------------------------------------------------------------------

  /** Runtime-owned timer key for the periodic durable feed settle check. */
  private static readonly SETTLE_CHECK_TIMER = 'syncInterval';

  /** Settle-check cadence floor — prevents a tight reconciliation loop. */
  private static readonly MIN_SYNC_INTERVAL_MS = 1_000;

  /** Settle-check cadence ceiling — the 32-bit native timer maximum. */
  private static readonly MAX_SYNC_INTERVAL_MS = 2 ** 31 - 1;

  /** Wrap a scheduled operation so each tick runs as supervised background work. */
  private supervisedTick(operation: () => Promise<void>): () => void {
    return (): void => {
      void this._lifecycle.runBackgroundTask(operation);
    };
  }

  /**
   * Starts live sync:
   * 1. Opens the remote and local durable subscriptions for each link.
   * 2. Establishes a paired checkpoint baseline from subscription snapshots
   *    or durable reconciliation.
   * 3. Releases ordered reconciliation from both durable checkpoints.
   * 4. Schedules an infrequent probe-first settle check at `interval`.
   */
  private async startLiveSync(intervalMilliseconds: number): Promise<void> {
    const runtime = this._runtime;

    // Startup work is best-effort and the settle check is its recovery
    // mechanism: each settle pass probes feed convergence, reconciles only
    // mismatches, and re-initializes targets without an active controller. The
    // timer is armed in the finally below, so it is guaranteed even when
    // DID endpoint discovery throws — but only after startup settles, so a
    // short interval cannot start a second reconciliation wave while
    // subscriptions are still opening. (armInterval no-ops on a disposed
    // runtime, covering stopSync racing startup.)
    try {
      // Initialize replication links and open live subscriptions. Every link
      // compares the two subscription snapshots: equal inventories establish
      // both heads atomically, while a mismatch reconciles from the durable
      // checkpoints.
      // Each target's link initialization is independent — process
      // concurrently; a transient discovery failure must not reject
      // startSync or strand the runtime.
      const syncTargets = await this.getSyncTargets();
      await Promise.allSettled(syncTargets.map(t => this.initializeLinkTarget(t)));
    } catch (error) {
      console.error('SyncEngineLevel: Live-sync startup planning failed; the settle check retries link initialization', error);
    } finally {
      // Schedule the periodic durable feed settle check.
      const settleCheck = async (): Promise<void> => this.runSettleCheck(runtime);
      runtime.armInterval(SyncEngineLevel.SETTLE_CHECK_TIMER, this.supervisedTick(settleCheck), intervalMilliseconds);
    }
  }

  /**
   * One settle pass: compare exact feed fingerprints, reconcile only
   * mismatches, then re-initialize orphaned live links. Both phases run under
   * the exclusive sync lock, so identity mutations cannot complete in the
   * middle of either phase.
   */
  private async runSettleCheck(runtime: SyncRuntime): Promise<void> {
    if (runtime.disposed || this._lifecycle.isSyncInProgress) {
      return;
    }

    if (!this._lifecycle.tryAcquireSync()) {
      return;
    }
    try {
      await this._runCoordinator.settle();
    } catch (error: unknown) {
      console.error('SyncEngineLevel: Error during durable feed settle check', error);
    } finally {
      this._lifecycle.releaseSync();
    }

    // A transition disposed this runtime while the sync ran — its disposal
    // owns every link now.
    if (runtime.disposed) {
      return;
    }

    await this.reinitializeOrphanedLinkTargets(runtime);
  }

  /**
   * Re-initialize live links for ORPHANED targets only: no active
   * controller (live, repairing, and paused links all keep one — the
   * owned-link guard in {@link initializeLinkTarget} returns those
   * untouched) and no pending rate-limit init retry (the Retry-After ladder
   * owns that link; re-attempting here would hammer a rate-limiting DWN and
   * cancel the legitimate retry). Startup planning that failed at discovery
   * and hot-adds whose discovery was transiently unavailable land here.
   *
   * Runs under its own hold of the exclusive sync lock — the same lock
   * every identity mutation wraps its work in — so an unregister or scope
   * change can never complete mid-initialization and have its outcome
   * resurrected by the stale attempt. The target plan is read INSIDE the
   * hold, so a mutation that landed between the settle phases is fully
   * reflected before any link work starts. A busy lock skips the phase
   * entirely (the next settle tick retries), preserving the settle pass's
   * skip-when-busy semantics.
   *
   * The lock is NOT reentrant — `acquireSync` spins on `tryAcquireSync` —
   * so nothing in the awaited graph below may take it. That holds
   * structurally today: `SyncLifecycleCoordinator` is engine-private, and
   * the only lifecycle surface link initialization reaches is background
   * task intake. Keep it that way; an awaited `acquireSync` under this
   * hold would self-deadlock rather than merely queue.
   */
  private async reinitializeOrphanedLinkTargets(runtime: SyncRuntime): Promise<void> {
    if (!this._lifecycle.tryAcquireSync()) {
      return;
    }
    try {
      if (runtime.disposed) {
        return;
      }
      const syncTargets = await this.getSyncTargets();
      // Re-check after the plan await: a transition that disposed this runtime
      // owns every link now, and its disposal already installed a
      // replacement. Returning here also establishes `this._runtime ===
      // runtime` for the rest of the phase — a live runtime cannot be swapped
      // out from under a lock holder — which lets the retry-timer check below
      // read the current runtime.
      if (runtime.disposed) {
        return;
      }
      const orphanedTargets = syncTargets.filter(target => !this.hasPendingLinkInitRetryForTarget(target));
      await Promise.allSettled(orphanedTargets.map(t => this.initializeLinkTarget(t)));
    } catch (error) {
      console.error('SyncEngineLevel: Error during settle-check link re-initialization', error);
    } finally {
      this._lifecycle.releaseSync();
    }
  }

  /**
   * Whether a pending rate-limit init retry owns this target's link. Exact
   * timer-key matching is sound: the replication-link store derives
   * `projectionId` with the same `computeProjectionId` the target resolver
   * uses (superseded-link pruning already relies on that equality), and the
   * authorization epoch passes through verbatim.
   *
   * A pending retry never hides an active link: the 429 path drops the
   * controller before arming the timer, and {@link activateLink} clears the
   * timer whenever a link is activated through any other path.
   */
  private hasPendingLinkInitRetryForTarget(target: SyncTarget): boolean {
    const timerKey = SyncEngineLevel.linkInitRetryTimerKey(
      buildLinkKey(target.did, target.dwnUrl, target.projectionId, target.authorizationEpoch),
    );
    return this._runtime.hasTimers((key: string): boolean => key === timerKey);
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

  // ---------------------------------------------------------------------------
  // Stop live sync
  // ---------------------------------------------------------------------------

  private async stopLiveSync(): Promise<void> {
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

    // Clear pending rate-limit link-init retries. The runtime is
    // normally already disposed here; the explicit clear keeps this stop
    // correct for any caller that runs it against a live runtime.
    this._runtime.cancelTimers(SyncEngineLevel.isLinkInitRetryTimerKey);

    this._echoSuppressor.clear();

  }

  // ---------------------------------------------------------------------------
  // Per-target link initialization
  // (startup, hot-add, drain handoff, settle-check re-init, rate-limit retry)
  // ---------------------------------------------------------------------------

  /**
   * Initialize a single replication link target: create or resume the durable
   * link, open pull + push subscriptions, and transition the link to `'live'`.
   */
  private async initializeLinkTarget(target: SyncTarget): Promise<LinkInitializationResult> {
    const runtime = this._runtime;
    let link: ReplicationLinkState | undefined;
    let controller: SyncLinkController | undefined;
    try {
      link = await this.getOrCreateReplicationLink(target);
      if (runtime.disposed) {
        return { status: LinkInitializationStatus.Failed };
      }
      const linkKey = this.getReplicationLinkKey(target, link);

      // Idempotence: an ACTIVE controller for this key means live, repair,
      // or pause ownership already exists. The settle-check re-init and the
      // rate-limit retry may both request initialization for a link that
      // another path already owns — returning its current state here keeps
      // those requests from clobbering a mid-repair link or resurrecting a
      // paused one.
      const ownedController = this.getLinkController(linkKey);
      if (ownedController?.isActive) {
        return this.createActiveLinkInitializationResult(ownedController.link);
      }

      controller = this.activateLink(linkKey, link);
      return await this.initializeActivatedLinkTarget(target, linkKey, link, controller);
    } catch (error: any) {
      if (runtime.disposed) {
        return { status: LinkInitializationStatus.Failed };
      }
      return this.handleInitializeLinkTargetError(target, link, controller, error);
    }
  }

  /** Open subscriptions and establish the reconciliation baseline for one newly activated link. */
  private async initializeActivatedLinkTarget(
    target: SyncTarget,
    linkKey: string,
    link: ReplicationLinkState,
    controller: SyncLinkController,
  ): Promise<LinkInitializationResult> {
    if (link.status === 'paused') {
      return this.activeLinkInitializationResultIfOwned(controller, link);
    }

    const openReplicationGeneration = controller.replicationGeneration;
    const subscriptionResult = await this.openLinkSubscriptions(
      { ...target, linkKey },
      controller,
      openReplicationGeneration,
    );
    if (subscriptionResult === LinkSubscriptionOpenResult.Inactive || !controller.isActive) {
      return this.interruptedLinkInitializationResult(controller, link);
    }
    if (subscriptionResult === LinkSubscriptionOpenResult.ReadyForLive) {
      return this.establishActivatedLinkBaseline(target, link, controller, openReplicationGeneration);
    }
    return this.activeLinkInitializationResultIfOwned(controller, link);
  }

  /** Preserve a pause or repair that took ownership while subscriptions were opening. */
  private interruptedLinkInitializationResult(
    controller: SyncLinkController,
    link: ReplicationLinkState,
  ): LinkInitializationResult {
    // Reporting Failed for an owned transition would drop the link from the
    // identity's keep-set and let pruning delete a fail-safe pause's record.
    const status = controller.link.status;
    if (controller.isActive && (status === 'paused' || status === 'repairing')) {
      return this.createActiveLinkInitializationResult(link);
    }
    return { status: LinkInitializationStatus.Failed };
  }

  /** Establish the initial baseline, surface its effects, and release reconciliation. */
  private async establishActivatedLinkBaseline(
    target: SyncTarget,
    link: ReplicationLinkState,
    controller: SyncLinkController,
    openReplicationGeneration: number,
  ): Promise<LinkInitializationResult> {
    const baseline = await this.establishLinkBaseline(target, controller, openReplicationGeneration);
    if ((baseline?.pushFailures?.length ?? 0) > 0) {
      controller.requestPass('push');
    }
    await this.markLinkLive(target, controller, openReplicationGeneration);
    return this.activeLinkInitializationResultIfOwned(controller, link);
  }

  private activeLinkInitializationResultIfOwned(
    controller: SyncLinkController,
    link: ReplicationLinkState,
  ): LinkInitializationResult {
    return controller.isActive
      ? this.createActiveLinkInitializationResult(link)
      : { status: LinkInitializationStatus.Failed };
  }

  private async getOrCreateReplicationLink(target: SyncTarget): Promise<ReplicationLinkState> {
    const linkKey = buildLinkKey(target.did, target.dwnUrl, target.projectionId, target.authorizationEpoch);
    const activeLink = this.getLinkController(linkKey);
    if (activeLink?.isActive === true) {
      return activeLink.link;
    }

    const link = await this.replicationLinkStore.getOrCreateLink({
      tenantDid          : target.did,
      remoteEndpoint     : target.dwnUrl,
      scope              : target.scope,
      authorization      : target.authorization,
      authorizationEpoch : target.authorizationEpoch,
      delegateDid        : target.delegateDid,
    });

    // Initialization can install the active owner while the store read is in
    // flight. Prefer that exact object so no caller starts mutating a detached
    // copy after a controller has taken ownership of the link.
    const activatedLink = this.getLinkController(linkKey);
    return activatedLink?.isActive === true ? activatedLink.link : link;
  }

  private getReplicationLinkKey(target: SyncTarget, link: ReplicationLinkState): string {
    return buildLinkKey(target.did, target.dwnUrl, link.projectionId, link.authorizationEpoch);
  }

  private async openLinkSubscriptions(
    target: LinkSyncTarget,
    controller: SyncLinkController,
    openReplicationGeneration: number,
  ): Promise<LinkSubscriptionOpenResult> {
    // Retirement is owned by this opening attempt: once a pause or repair has
    // bumped the replication generation, the transition owns closure and the
    // fenced attach kept this attempt from installing anything. Closing the
    // entire controller here would close the replacement replication generation's pair.
    const closeOwnAttempt = async (): Promise<void> => {
      if (controller.replicationGeneration === openReplicationGeneration) {
        await controller.closeSubscriptions();
      }
    };

    const pullOpened = await this.openLivePullSubscription(target, controller, openReplicationGeneration);
    if (pullOpened === false || !controller.isActive) {
      await closeOwnAttempt();
      return LinkSubscriptionOpenResult.Inactive;
    }
    if (controller.link.status === 'repairing') {
      await controller.closeLiveSubscription();
      return LinkSubscriptionOpenResult.Repairing;
    }
    // One replication generation owns the whole pair: a pause (or any reset) landing
    // between the two halves must stop the attempt here — opening the local
    // half under a newer replication generation would install a subscription
    // the transition's closure can never have seen.
    if (controller.replicationGeneration !== openReplicationGeneration || controller.link.status === 'paused') {
      await closeOwnAttempt();
      return LinkSubscriptionOpenResult.Inactive;
    }

    try {
      const pushOpened = await this.openLocalPushSubscription(target, controller, openReplicationGeneration);
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

  /**
   * Establish the durable checkpoint pair before subscription wakes may run.
   * Equal snapshots prove that neither feed owes historical transfer;
   * otherwise one direct reconciliation establishes both baselines. Events
   * after either snapshot leave a pending pass for the readiness release.
   */
  private async establishLinkBaseline(
    target: SyncTarget,
    controller: SyncLinkController,
    expectedReplicationGeneration: number,
  ): Promise<SyncReconcileResult | undefined> {
    const { link } = controller;
    const isCurrent = (): boolean =>
      !this._runtime.disposed && controller.isReplicationGenerationCurrent(expectedReplicationGeneration);
    const pullSnapshot = controller.pullSnapshot;
    const pushSnapshot = controller.pushSnapshot;
    if (
      pullSnapshot?.fingerprint !== undefined &&
      pullSnapshot.fingerprint === pushSnapshot?.fingerprint &&
      pullSnapshot.head !== undefined &&
      pushSnapshot.head !== undefined &&
      isValidProgressToken(pullSnapshot.head) &&
      isValidProgressToken(pushSnapshot.head)
    ) {
      if (!isCurrent()) {
        return { aborted: true };
      }
      SyncCheckpoint.commitContiguousToken(link.pull, pullSnapshot.head);
      SyncCheckpoint.commitContiguousToken(link.push, pushSnapshot.head);
      await this.replicationLinkStore.persistCheckpoints(link);
      if (!isCurrent()) {
        return { aborted: true };
      }
      this.emitCheckpointAdvance(link, 'pull');
      this.emitCheckpointAdvance(link, 'push');
      return { converged: true };
    }

    return this._durableFeedReconciler.reconcile(target, link, undefined, isCurrent);
  }

  private async markLinkLive(
    target: SyncTarget,
    controller: SyncLinkController,
    expectedReplicationGeneration: number,
  ): Promise<void> {
    const { link } = controller;
    // A pause or repair takeover during subscription opening owns the link's
    // phase now — completing initialization must not override it.
    if (!controller.isActive || link.status === 'paused' || link.status === 'repairing') { return; }
    if (controller.replicationGeneration !== expectedReplicationGeneration) { return; }
    const previousStatus = link.status;
    await this.replicationLinkStore.setStatus(link, 'live');
    if (
      !controller.isReplicationGenerationCurrent(expectedReplicationGeneration) ||
      link.status !== 'live'
    ) {
      return;
    }
    this.emitEvent({
      type           : 'link:status-change',
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      ...syncEventScope(target.scope),
      from           : previousStatus,
      to             : 'live'
    });
    controller.markReplicationReady();
    if (controller.isPassRequested('pull')) {
      const runIdentityTask = this._lifecycle.captureIdentityTaskRunner(link.tenantDid);
      void runIdentityTask(() => this._linkRecoveryCoordinator.pull(controller));
    }
    if (controller.isPassRequested('push')) {
      const runIdentityTask = this._lifecycle.captureIdentityTaskRunner(link.tenantDid);
      void runIdentityTask(() => this._linkRecoveryCoordinator.push(controller));
    }
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
      this.retireFailedLinkAttempt(linkKey, controller);
      this.scheduleLinkInitRetry(target, linkKey, retryAfterSec * 1000);
      return { status: LinkInitializationStatus.Failed };
    }

    console.error(`SyncEngineLevel: Failed to open live subscription for ${target.did} -> ${target.dwnUrl}`, error);
    if (link) {
      this.retireFailedLinkAttempt(this.getReplicationLinkKey(target, link), controller);
    }
    // The ONLY error class that escapes this method: rethrow so
    // initializeLinkTargetWithRetry can run the DHT-propagation backoff
    // ladder. Callers without that wrapper absorb it via Promise.allSettled.
    // Everything else is already reported and reduced to Failed — remove
    // this rethrow and the retry ladder silently stops working.
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

  private retireFailedLinkAttempt(linkKey: string, controller?: SyncLinkController): void {
    this.removeLinkController(linkKey, controller);

    // With no subscriptions left there is no signal either way — 'unknown',
    // not 'offline', so one failed open does not report the network as down.
    if (!this.hasActiveSubscriptions) {
      this._connectivityManager.setState('unknown');
    }
  }

  /** Runtime-owned key prefix for pending rate-limit link-init retries. */
  private static readonly LINK_INIT_RETRY_TIMER_PREFIX = 'linkInitRetry:';

  private static linkInitRetryTimerKey(linkKey: string): string {
    return `${SyncEngineLevel.LINK_INIT_RETRY_TIMER_PREFIX}${linkKey}`;
  }

  private static isLinkInitRetryTimerKey(timerKey: string): boolean {
    return timerKey.startsWith(SyncEngineLevel.LINK_INIT_RETRY_TIMER_PREFIX);
  }

  /** Whether a runtime-owned timer key is a pending init retry for the given DID's links. */
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
    this._runtime.cancelTimers((timerKey: string): boolean => this.isLinkInitRetryTimerKeyForDid(timerKey, did));
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
   * timer is runtime-owned: a transition disposes it, and a firing the
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
    const runtime = this._runtime;
    try {
      return await this.initializeLinkTarget(target);
    } catch (error: any) {
      if (!this.isDidResolutionFailure(error)) { throw error; }

      for (const delay of SyncEngineLevel.DID_RESOLUTION_RETRY_BACKOFF_MS) {
        // A runtime transition during an attempt or the backoff disposed of
        // whatever this initialization would have joined; a retry now would
        // re-activate a link controller and reopen subscriptions behind the
        // disposed runtime. Checked on both sides of the sleep so a transition during
        // the previous attempt skips the backoff wait entirely.
        if (runtime.disposed) {
          return { status: LinkInitializationStatus.Failed };
        }
        await sleep(delay);
        if (runtime.disposed) {
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
   * segments with {@link LINK_KEY_SEPARATOR}, which cannot appear in a DID.
   * Matching must use exactly that delimiter: underscores ARE valid DID
   * characters, so a looser prefix match would let one DID claim the keys of
   * another DID that merely extends it (e.g. `…alice` vs `…alice_extra`).
   */
  private isLinkKeyForDid(key: string, did: string): boolean {
    return key.startsWith(did + LINK_KEY_SEPARATOR);
  }

  /** Check whether this DID has any active links. */
  private hasActiveLinksForDid(did: string): boolean {
    for (const controller of this._linkControllers.values()) {
      if (controller.link.tenantDid === did) { return true; }
    }
    return false;
  }

  /**
   * Hot-add a single identity to the active live sync session.
   *
   * @returns The durable link identity keys that initialized successfully —
   *   the keep-set for {@link pruneSupersededDurableLinksForIdentity}. EMPTY
   *   when target planning failed, so callers MUST treat empty as "do not
   *   prune": pruning against an empty keep-set deletes every durable link
   *   for the identity. Both call sites enforce that with a `size > 0` guard.
   */
  private async addIdentityToLiveSync(did: string, options: SyncIdentityOptions): Promise<Set<string>> {
    // Target planning is best-effort: DID endpoint discovery can be
    // transiently unavailable, and a registration that has already persisted
    // must not reject over it — the settle check re-initializes links for
    // targets left without an active controller.
    const targets: SyncTarget[] = [];
    try {
      const dwnEndpointUrls = await this.targetResolver.getEndpointUrls(did);
      for (const dwnUrl of dwnEndpointUrls) {
        targets.push(...await this.targetResolver.buildTargetsForEndpoint(did, dwnUrl, options));
      }
    } catch (error) {
      console.error(`SyncEngineLevel: Live-sync hot-add planning failed for ${did}; the settle check retries link initialization`, error);
      return new Set();
    }
    if (targets.length === 0) { return new Set(); }

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
    this.cancelIdentityTimers(did);
    await taskGroup.settle();

    // A running task may have armed a follow-up timer before observing the
    // paused group. Cancel that timer before discarding the link state.
    this.cancelIdentityTimers(did);
    this.discardIdentityLinkState(did);

    this._lifecycle.deleteIdentityTaskGroup(did, taskGroup);
  }

  private cancelIdentityTimers(did: string): void {
    for (const controller of this._linkControllers.values()) {
      if (controller.link.tenantDid === did) {
        controller.cancelRepairRetryTimer();
        controller.cancelReconcileTimer();
      }
    }
    this.cancelLinkInitRetriesForDid(did);
  }

  private discardIdentityLinkState(did: string): void {
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

  /**
   * DESTRUCTIVE: delete every durable link for `did` whose identity key is
   * NOT in `currentIdentityKeys`. An empty keep-set therefore deletes them
   * all — which is exactly what `doUnregisterIdentity` wants (it passes
   * `new Set()`), and exactly what a failed hot-add must avoid. See
   * {@link addIdentityToLiveSync} for the empty-set contract.
   */
  private async pruneSupersededDurableLinksForIdentity(did: string, currentIdentityKeys: Set<string>): Promise<void> {
    const links = await this.replicationLinkStore.getLinksForTenant(did);
    await Promise.all(links.map(async link => {
      if (currentIdentityKeys.has(this.getDurableLinkIdentityKey(link))) {
        return;
      }
      await this.replicationLinkStore.deleteLink(link.tenantDid, link.remoteEndpoint, link.projectionId, link.authorizationEpoch);
    }));
  }

  // ---------------------------------------------------------------------------
  // Live pull: MessagesSubscribe to remote DWN
  // ---------------------------------------------------------------------------

  /**
   * Opens a MessagesSubscribe WebSocket subscription to a remote DWN.
   * Incoming events only wake durable pull reconciliation.
   */
  private async openLivePullSubscription(
    target: LinkSyncTarget,
    controller: SyncLinkController,
    expectedReplicationGeneration?: number,
  ): Promise<boolean> {
    if (!controller.isActive || controller.linkKey !== target.linkKey) { return false; }
    // Pin the replication generation before the first await. Use the caller's
    // pair replication generation when opening both halves; otherwise use the
    // current one. A repair or pause that resets it while this open is in flight
    // supersedes the subscription, which must not be installed.
    const subscriptionReplicationGeneration = expectedReplicationGeneration ?? controller.replicationGeneration;
    return this.runReplicationGenerationFencedOpen(controller, subscriptionReplicationGeneration, (): Promise<boolean> =>
      this.openLivePullSubscriptionAttempt(target, controller, subscriptionReplicationGeneration));
  }

  /**
   * Run one subscription-opening attempt pinned to a replication generation. A
   * rejection belonging to a superseded attempt retires that attempt; it is
   * not the link's failure and must not reach initialization error handling,
   * which could repair or retire the current replication generation's
   * controller. Current-replication-generation failures propagate unchanged.
   */
  private async runReplicationGenerationFencedOpen(
    controller: SyncLinkController,
    subscriptionReplicationGeneration: number,
    attempt: () => Promise<boolean>,
  ): Promise<boolean> {
    try {
      return await attempt();
    } catch (error: unknown) {
      if (!controller.isReplicationGenerationCurrent(subscriptionReplicationGeneration)) {
        return false;
      }
      throw error;
    }
  }

  private async openLivePullSubscriptionAttempt(
    target: LinkSyncTarget,
    controller: SyncLinkController,
    subscriptionReplicationGeneration: number,
  ): Promise<boolean> {
    const { did, delegateDid, dwnUrl } = target;
    const eventScope = syncEventScope(target.scope);

    const linkKey = target.linkKey;
    const { link } = controller;

    const filters = target.scope.kind === 'protocolSet'
      ? target.scope.protocols.map(protocol => ({ protocol }))
      : [];

    const runtime = this._runtime;

    // Capture the controller lifetime so remove+re-add invalidates callbacks
    // even when the replacement uses the same durable link key, and the pull
    // replication generation so callbacks from a subscription superseded by a
    // repair reset cannot request durable work after recovery.
    const isStale = (): boolean => runtime.disposed || !controller.isReplicationGenerationCurrent(subscriptionReplicationGeneration);
    const pullContext: LivePullWakeContext = {
      did,
      dwnUrl,
      eventScope,
      controller,
      linkKey,
      link,
      isStale,
    };
    const runIdentityTask = this._lifecycle.captureIdentityTaskRunner(did);

    const subscriptionHandler = (subMessage: DwnSubscriptionMessage): Promise<void> =>
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
      messageParams : { filters, permissionGrantIds: toMessagesPermissionGrantIds(target.permissionGrantIds) },
    };

    const { message } = await this.agent.dwn.processRequest(subscribeRequest);
    if (!controller.isReplicationGenerationCurrent(subscriptionReplicationGeneration)) { return false; }
    if (!message) {
      throw new Error(`SyncEngineLevel: Failed to construct MessagesSubscribe for ${dwnUrl}`);
    }

    // Re-establish at the live head instead of replaying subscription events.
    // The `reconnected` lifecycle signal requests durable pull and push passes,
    // which recover the disconnected interval from persisted checkpoints.
    const resubscribeFactory: ResubscribeFactory = async () => {
      const { message: resumeMsg } = await this.agent.dwn.processRequest(subscribeRequest);
      if (!resumeMsg) {
        throw new Error(`SyncEngineLevel: Failed to construct resume MessagesSubscribe for ${dwnUrl}`);
      }
      return resumeMsg;
    };

    // The RPC client routes subscription requests to the WebSocket transport
    // itself — the endpoint URL is passed as configured.
    const reply = await this.agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid    : did,
      message,
      subscription : {
        handler: subscriptionHandler as DwnSubscriptionHandler,
        resubscribeFactory,
      },
    }) as MessagesSubscribeReply;
    if (reply.status.code !== 200 || !reply.subscription) {
      throw new Error(`SyncEngineLevel: MessagesSubscribe failed for ${did} -> ${dwnUrl}: ${reply.status.code} ${reply.status.detail}`);
    }

    const close = async (): Promise<void> => { await reply.subscription!.close(); };
    if (!controller.setLiveSubscription(
      { close },
      subscriptionReplicationGeneration,
      { fingerprint: reply.fingerprint, head: reply.head },
    )) {
      try {
        await close();
      } catch {
        // Best-effort close of a subscription opened for a stale lifetime.
      }
      return false;
    }

    this.setLivePullConnectivity(pullContext, 'online');

    return true;
  }

  /** Treat remote subscription messages as lifecycle signals or durable-feed wakes. */
  private async handleLivePullMessage(
    context: LivePullWakeContext,
    message: DwnSubscriptionMessage,
  ): Promise<void> {
    if (context.isStale()) {
      return;
    }

    if (message.type === 'disconnected' || message.type === 'reconnecting') {
      this.setLivePullConnectivity(context, 'offline');
      return;
    }
    if (message.type === 'reconnected') {
      this.setLivePullConnectivity(context, 'online');
      await this.requestDurableReconnectPasses(context);
      return;
    }
    if (message.type === 'error') {
      await this.handleLivePullError(context, message.error.code);
      return;
    }
    if (message.type !== 'event') {
      return;
    }

    context.controller.requestPass('pull');
    if (!context.controller.isReplicationReady || context.isStale()) {
      return;
    }

    // A subscription event is only a wake hint. Hand the durable pass to
    // lifecycle supervision and return so transport acknowledgement is not
    // coupled to a potentially multi-page catch-up. stopSync() still waits
    // for the supervised pass before closing storage.
    const runIdentityTask = this._lifecycle.captureIdentityTaskRunner(context.did);
    void runIdentityTask(() => this._linkRecoveryCoordinator.pull(context.controller));
  }

  /** A reconnect closes both disconnected-interval gaps without a full convergence probe. */
  private async requestDurableReconnectPasses(context: LivePullWakeContext): Promise<void> {
    const { controller } = context;
    controller.requestPass('pull');
    controller.requestPass('push');
    if (!controller.isReplicationReady || context.isStale()) {
      return;
    }

    await Promise.all([
      this._linkRecoveryCoordinator.pull(controller),
      this._linkRecoveryCoordinator.push(controller),
    ]);
  }

  private async handleLivePullError(context: LivePullWakeContext, errorCode: string): Promise<void> {
    if (isTerminalSyncAuthorizationFailure(errorCode)) {
      console.warn(
        `SyncEngineLevel: sync authorization for ${context.did} -> ${context.dwnUrl} was revoked or expired — ` +
        'pausing link (reconnect to resume).',
      );
      if (!context.isStale()) {
        await this.transitionToPaused(context.linkKey, context.link);
      }
      return;
    }

    console.warn(`SyncEngineLevel: subscription error for ${context.did} -> ${context.dwnUrl}: ${errorCode}`);
    if (!context.isStale()) {
      await this._linkRecoveryCoordinator.transitionToRepairing(context.controller);
    }
  }

  private setLivePullConnectivity(
    context: LivePullWakeContext,
    connectivity: SyncConnectivityState,
  ): void {
    if (context.isStale()) {
      return;
    }

    const previous = context.link.connectivity;
    context.link.connectivity = connectivity;
    if (previous !== connectivity) {
      this.emitEvent({
        type           : 'link:connectivity-change',
        tenantDid      : context.did,
        remoteEndpoint : context.dwnUrl,
        ...context.eventScope,
        from           : previous,
        to             : connectivity,
      });
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

  /** Persist and announce one reconciler page's ordered checkpoint advance. */
  private async commitReconciledCheckpoint(
    link: ReplicationLinkState,
    direction: SyncDirection,
  ): Promise<void> {
    await this.replicationLinkStore.persistCheckpoint(link, direction);
    this.emitCheckpointAdvance(link, direction);
  }

  // ---------------------------------------------------------------------------
  // Durable push wake: a local EventLog subscription requests a feed pass
  // ---------------------------------------------------------------------------

  /**
   * Subscribes to the local DWN's EventLog so that writes by the user are
   * immediately pushed to the remote DWN instead of waiting for the next
   * settle check.
   */
  private async openLocalPushSubscription(
    target: LinkSyncTarget,
    controller: SyncLinkController,
    expectedReplicationGeneration?: number,
  ): Promise<boolean> {
    if (!controller.isActive || controller.linkKey !== target.linkKey) { return false; }
    // Same replication-generation ownership as the pull side: a pause or repair that
    // lands while the local subscribe is pending supersedes this attempt.
    const subscriptionReplicationGeneration = expectedReplicationGeneration ?? controller.replicationGeneration;
    return this.runReplicationGenerationFencedOpen(controller, subscriptionReplicationGeneration, (): Promise<boolean> =>
      this.openLocalPushSubscriptionAttempt(target, controller, subscriptionReplicationGeneration));
  }

  private async openLocalPushSubscriptionAttempt(
    target: LinkSyncTarget,
    controller: SyncLinkController,
    subscriptionReplicationGeneration: number,
  ): Promise<boolean> {
    const { did, delegateDid } = target;

    const filters = target.scope.kind === 'protocolSet'
      ? target.scope.protocols.map(protocol => ({ protocol }))
      : [];

    const runtime = this._runtime;

    const isPushStale = (): boolean =>
      runtime.disposed || !controller.isReplicationGenerationCurrent(subscriptionReplicationGeneration);
    const runIdentityTask = this._lifecycle.captureIdentityTaskRunner(did);

    // Subscribe to the local DWN's EventLog.
    const subscriptionHandler = (subMessage: SubscriptionMessage): Promise<void> =>
      runIdentityTask(() => this.handleLocalPushMessage(controller, isPushStale, subMessage));

    // Subscribe at the live head. Paired snapshots establish startup progress;
    // later callbacks only request coalesced durable push passes.
    const response = await this.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSubscribe,
      granteeDid    : delegateDid,
      messageParams : {
        filters,
        permissionGrantIds: toMessagesPermissionGrantIds(target.permissionGrantIds),
      },
      subscriptionHandler: subscriptionHandler as any,
    });

    const reply = response.reply as MessagesSubscribeReply;
    if (reply.status.code !== 200 || !reply.subscription) {
      throw new Error(`SyncEngineLevel: Local MessagesSubscribe failed for ${did}: ${reply.status.code} ${reply.status.detail}`);
    }

    const close = async (): Promise<void> => { await reply.subscription!.close(); };
    if (!controller.setLocalSubscription(
      { close },
      subscriptionReplicationGeneration,
      { fingerprint: reply.fingerprint, head: reply.head },
    )) {
      try {
        await close();
      } catch {
        // Best-effort close of a subscription opened for a stale lifetime.
      }
      return false;
    }
    return true;
  }

  /** Coalesce one local feed event into the session's durable push lane. */
  private async handleLocalPushMessage(
    controller: SyncLinkController,
    isStale: () => boolean,
    message: SubscriptionMessage,
  ): Promise<void> {
    if (isStale() || message.type !== 'event') {
      return;
    }

    controller.requestPass('push');
    if (!controller.isReplicationReady) {
      return;
    }
    await this._linkRecoveryCoordinator.push(controller);
  }

  private scheduleQuotaProbeForActiveLink(
    linkKey: string,
    link: ReplicationLinkState,
    nextProbeAt: string,
  ): void {
    const parsed = Date.parse(nextProbeAt);
    const delayMs = Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : 0;
    this.scheduleLinkReconcileByKey(linkKey, link, 'push-quota-probe', delayMs);
  }

  /**
   * Dead-letter every TERMINAL failure in `failures` and clear its quota
   * block.
   *
   * @returns The number of RETRYABLE failures — the ones deliberately left
   *   untouched for a later pass. Note the asymmetry: this method acts on
   *   terminal failures and reports on the others.
   */
  private async recordTerminalPushFailures(
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

  private scheduleLinkReconcileByKey(linkKey: string, link: ReplicationLinkState, reason: string, delayMs?: number): void {
    // Link-addressed callers (feed convergence, quota manager, push quota
    // probes) can reach here for links that have no active controller: a
    // one-shot sync() or drain reconciles durable links without a live
    // runtime, and even under live sync the controller can be removed
    // across a caller's await (hot-remove, pause, a rate-limited init
    // retry). Resolving to a matching active controller keeps those
    // requests no-ops, while the recovery coordinator itself is
    // controller-addressed.
    const controller = this.getMatchingLinkController(linkKey, link);
    if (controller === undefined) {
      return;
    }
    this._linkRecoveryCoordinator.scheduleLinkReconcileByKey(controller, reason, delayMs);
  }

  private async reconcileTarget(
    target: SyncTarget,
    options?: SyncReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    const link = await this.getOrCreateReplicationLink(target);
    const linkKey = buildLinkKey(target.did, target.dwnUrl, target.projectionId, target.authorizationEpoch);
    const controller = this.getLinkController(linkKey);
    if (controller?.isActive !== true) {
      return this._durableFeedReconciler.reconcile(target, link, options, shouldContinue);
    }

    const result = await controller.enqueue(
      (): Promise<SyncReconcileResult> => this.reconcileOwnedTarget(controller, target, options, shouldContinue),
      'reconcile',
    );
    return result ?? { aborted: true };
  }

  /** Reconcile a link whose caller already owns the controller mailbox. */
  private async reconcileOwnedTarget(
    controller: SyncLinkController,
    target: SyncTarget,
    options?: SyncReconcileOptions,
    shouldContinue?: () => boolean,
    useDirectionQueues = true,
  ): Promise<SyncReconcileResult> {
    if (!controller.isActive) {
      return { aborted: true };
    }
    if (controller.link.status === 'paused') {
      return { paused: true };
    }
    if (useDirectionQueues &&
        (controller.link.status !== 'live' || !controller.isReplicationReady)) {
      // Initialization and repair already own the authoritative reconciliation
      // that establishes this replication generation's reconciliation boundary.
      // Administrative sync work must not wait on it while holding the controller
      // mailbox, because the owning repair may be queued behind this turn.
      return { aborted: true };
    }

    const replicationGeneration = controller.replicationGeneration;
    const isCurrent = (): boolean =>
      controller.isReplicationGenerationCurrent(replicationGeneration) && (shouldContinue?.() ?? true);
    const reconcile = (): Promise<SyncReconcileResult> =>
      this._durableFeedReconciler.reconcile(target, controller.link, options, isCurrent);
    if (!useDirectionQueues) {
      return reconcile();
    }

    if (options?.direction !== undefined) {
      return await controller.enqueueDirection(options.direction, reconcile) ?? { aborted: true };
    }

    const result = await controller.enqueueDirection('pull', async (): Promise<SyncReconcileResult> =>
      await controller.enqueueDirection('push', reconcile) ?? { aborted: true }
    );
    return result ?? { aborted: true };
  }

  private verifyFeedConvergence(
    target: SyncTarget,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    return this._durableFeedReconciler.verifyConvergence(target, shouldContinue);
  }

  /** Probe one active session without racing either direction reconciliation queue. */
  private async probeFeedConvergence(target: SyncTarget): Promise<SyncReconcileResult> {
    await this.getOrCreateReplicationLink(target);
    const linkKey = buildLinkKey(target.did, target.dwnUrl, target.projectionId, target.authorizationEpoch);
    const controller = this.getLinkController(linkKey);
    if (controller?.isActive !== true) {
      return this.verifyFeedConvergence(target);
    }
    if (controller.link.status === 'paused') {
      return { paused: true };
    }

    const result = await controller.enqueue(async (): Promise<SyncReconcileResult> => {
      // Re-check after this mailbox turn starts. A pre-mailbox status claim can
      // become stale while earlier work runs, and administrative probes must
      // never park on readiness while holding the mailbox needed by repair.
      if (!controller.isActive) {
        return { aborted: true };
      }
      if (controller.link.status === 'paused') {
        return { paused: true };
      }
      if (controller.link.status !== 'live' || !controller.isReplicationReady) {
        return { aborted: true };
      }

      const replicationGeneration = controller.replicationGeneration;
      const isCurrent = (): boolean => controller.isReplicationGenerationCurrent(replicationGeneration);
      const probe = (): Promise<SyncReconcileResult> => this.verifyFeedConvergence(target, isCurrent);
      const queued = await controller.enqueueDirection('pull', async (): Promise<SyncReconcileResult> =>
        await controller.enqueueDirection('push', probe) ?? { aborted: true }
      );
      return queued ?? { aborted: true };
    }, 'reconcile');
    return result ?? { aborted: true };
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
    const outcome = await this.applyPushResult(target, result, { source: 'permission-grant' });
    return {
      kind               : 'processed',
      failures           : [...outcome.retryableFailures, ...outcome.terminalFailures],
      hasActionableDiffs : result.succeeded.length > 0,
      quotaBlocked       : outcome.quotaBlocked,
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
    if (await this.hasDeadLetter(target.did, target.dwnUrl, entry.messageCid)) {
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
    const outcome = await this.applyPushResult(target, attributedResult, {
      protocol : entry.protocol,
      source   : 'feed',
    });

    if (attributedResult.failed.length === 0) {
      return { kind: 'pushed' };
    }

    if (outcome.retryableFailures.length === 0) {
      return { kind: 'skipped' };
    }

    return { kind: 'failed', failures: outcome.retryableFailures };
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

  /**
   * Admit one page of remote feed entries, in feed order.
   *
   * A deferred entry STOPS the page: its dependencies are not local yet, and
   * later entries in feed order may depend on it, so the caller holds the
   * checkpoint at that CID and the next pass retries. The one exception is a
   * deferred entry that has aged past
   * {@link DEFERRED_PULL_DEAD_LETTER_AFTER_MS}: it is dead-lettered and the
   * page continues, so a single permanently unresolvable message cannot
   * wedge the link forever.
   */
  private async admitRemoteFeedPage(
    target: SyncTarget,
    entries: MessagesQueryReplyEntry[],
    shouldContinue?: () => boolean,
  ): Promise<FeedPageAdmissionResult> {
    const admittedCids: string[] = [];
    let hasActionableDiffs = false;

    for (const entry of entries) {
      if (await this.hasDeadLetter(target.did, target.dwnUrl, entry.messageCid)) {
        continue;
      }

      const outcome = await this.admitRemoteFeedEntry(target, entry, shouldContinue);
      if (outcome.kind === 'aborted') {
        return { kind: 'aborted' };
      }

      if (outcome.kind === 'deferred') {
        if (!await this.tryRetireDeferredPull(target, entry, outcome.detail)) {
          return { kind: 'deferred', admittedCids, detail: outcome.detail, hasActionableDiffs, messageCid: entry.messageCid };
        }
        hasActionableDiffs = true;
        continue;
      }
      if (outcome.kind === 'echo') {
        continue;
      }

      hasActionableDiffs = true;
      if (outcome.kind === 'admitted') {
        admittedCids.push(...outcome.appliedCids);
        await this.trackRemoteFeedAppliedCids(outcome.appliedCids, target);
        for (const freshEntry of outcome.freshEntries) {
          this.emitDeliveryApplied(target, freshEntry.messageCid, freshEntry.message);
        }
      }
    }

    return { kind: 'processed', admittedCids, hasActionableDiffs };
  }

  private async trackRemoteFeedAppliedCids(messageCids: string[], target: SyncTarget): Promise<void> {
    for (const cid of messageCids) {
      this._echoSuppressor.trackPulled(target.did, cid, target.dwnUrl);
      await this.runDeferredPullLifecycle(target.did, async (): Promise<void> => {
        await this.clearDeferredPull(target.did, target.dwnUrl, cid);
        await this.clearDeadLetterForTenant(target.did, cid, target.dwnUrl);
      });
      // A pull admission only proves that the signed message exists remotely.
      // The remote may retain a RecordsWrite CID as dataless ancestry, while
      // the local admission reports Duplicate because it already has the full
      // record. Only a push acknowledgement can prove that the remote has the
      // payload and clear an exact-CID quota block.
      await this.resolveQuotaBlocksSupersededByAcknowledgement(target, cid);
    }
  }

  /**
   * Retire a deferred pull entry if it can no longer make progress.
   *
   * @returns `true` when the caller should SKIP this entry and continue the
   *   page — either because it aged past
   *   {@link DEFERRED_PULL_DEAD_LETTER_AFTER_MS} and was dead-lettered, or
   *   because the tenant was unregistered underneath us (in which case
   *   nothing is dead-lettered and the deferred work is simply abandoned).
   *   `false` means the entry is still within its retry window and the page
   *   must stop on it.
   */
  private async tryRetireDeferredPull(
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
    return runWithCrossContextLock(`enbox:sync-identity:${this._lockNamespace}:${did}`, operation);
  }

  /**
   * Serialize the deferred/dead-letter lifecycle per tenant across contexts.
   * Every participant — admission-state deletion, expiry promotion, and unregister's
   * tenant sweep — runs its read-decide-write section under this lock, which
   * is the single mechanism making those sections atomic with each other.
   */
  private async runDeferredPullLifecycle<T>(
    tenantDid: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return runWithCrossContextLock(`enbox:sync-deferred-pull:${this._lockNamespace}:${tenantDid}`, operation);
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

  private applyPushResult(
    target: SyncTarget,
    result: PushResult,
    options?: { protocol?: string; source?: SyncQuotaBlockSource },
  ): Promise<SyncQuotaPushResultOutcome> {
    return this._quotaManager.applyPushResult(target, result, options);
  }

  private probeQuotaBlocksForTarget(
    target: SyncTarget,
    force = false,
    forceProbeCids?: Set<string>,
    shouldContinue?: () => boolean,
  ): Promise<void> {
    // The quota manager fences its awaits with the `shouldContinue` it is
    // given; compose a transition fence in so probes abort on startSync/
    // stopSync/clear/close — including for one-shot callers running without
    // a live runtime, which have no other staleness signal.
    const transitionFence = this.captureTransitionFence();
    const composed = shouldContinue === undefined
      ? transitionFence
      : (): boolean => transitionFence() && shouldContinue();
    return this._quotaManager.probeBlocksForTarget(target, force, forceProbeCids, composed);
  }

  /**
   * Capture a predicate that reports whether the runtime is STILL the one
   * observed at capture: `true` means no transition has happened and the
   * captured work may proceed; `false` means `startSync`, `stopSync`,
   * `clear`, or `close` has since run and the work is stale. Valid from any
   * state — an active runtime trips when it is disposed, and an
   * already-disposed runtime trips when a new runtime replaces it.
   */
  private captureTransitionFence(): () => boolean {
    const runtime = this._runtime;
    const disposedAtCapture = runtime.disposed;
    return (): boolean => this._runtime === runtime && runtime.disposed === disposedAtCapture;
  }

  private clearQuotaBlocksForTenant(tenantDid: string): Promise<void> {
    return this._quotaManager.clearTenant(tenantDid);
  }

  private pruneQuotaBlocksForCurrentTargets(targets: SyncTarget[], expectedTopologyGeneration: number): Promise<void> {
    return this._quotaManager.pruneStaleLinkBlocks(
      targets,
      (): boolean => this._targetPlanner.topologyGeneration === expectedTopologyGeneration,
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
    return this._quotaManager.reconcileAndExplainFeedDivergence(target, result);
  }

  private async admitRemoteFeedEntry(
    target: SyncTarget,
    entry: MessagesQueryReplyEntry,
    shouldContinue?: () => boolean,
  ): Promise<
    | { kind: 'aborted' }
    | { kind: 'admitted'; appliedCids: string[]; freshEntries: SyncFreshEntry[] }
    | { kind: 'dead-lettered' }
    | { kind: 'deferred'; detail?: string }
    | { kind: 'echo' }
  > {
    if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
      return { kind: 'aborted' };
    }

    if (await this.hasDurableLocalPullEcho(target, entry)) {
      return { kind: 'echo' };
    }

    const prefetched = await this.syncEntriesFromFeedEntry(target, entry);
    const outcome = await admitClosure(entry.messageCid, {
      did                : target.did,
      dwnUrl             : target.dwnUrl,
      delegateDid        : target.delegateDid,
      permissionGrantIds : target.permissionGrantIds,
      scope              : target.scope,
      agent              : this.agent,
      onBeforeApply      : (messageCid): void => {
        this._echoSuppressor.trackPulled(target.did, messageCid, target.dwnUrl);
      },
      permissionsApi: this._permissionsApi,
      prefetched,
      shouldContinue,
    });

    if (outcome.kind === 'admitted') {
      return { kind: 'admitted', appliedCids: outcome.appliedCids, freshEntries: outcome.freshEntries };
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

  /**
   * Verify a recent-push hint against durable local state before skipping its
   * remote echo. The in-memory hint narrows the check but is never checkpoint
   * evidence by itself. A latest RecordsWrite also needs its local stored data;
   * retaining only a dataless message is not equivalent to the remote record.
   */
  private async hasDurableLocalPullEcho(
    target: SyncTarget,
    entry: MessagesQueryReplyEntry,
  ): Promise<boolean> {
    if (!this._echoSuppressor.hasRecentlyPushed(target.did, entry.messageCid, target.dwnUrl)) {
      return false;
    }

    const local = await this.getLocalMessageForTarget(target, entry.messageCid);
    if (local === undefined) {
      return false;
    }

    const hasStoredData = local.dataStream !== undefined;
    await local.dataStream?.cancel();
    return entry.isLatestBaseState !== true ||
      !SyncEngineLevel.recordsWriteRequiresRemoteData(local.message) ||
      hasStoredData;
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
      // Suppress only the expected storage-close race — any other error surfaces.
      if (!SyncEngineLevel.isDatabaseNotOpenError(error)) {
        throw error;
      }
    }
  }

  private async hasDeadLetter(
    tenantDid: string,
    remoteEndpoint: string,
    messageCid: string,
  ): Promise<boolean> {
    const entry = await this._deadLetterStore.get(tenantDid, messageCid, remoteEndpoint);
    return entry?.tenantDid === tenantDid;
  }

  public async getDeadLetters(tenantDid?: string): Promise<DeadLetterEntry[]> {
    const entries = (await this._deadLetterStore.getAll())
      .filter((entry): boolean => !tenantDid || entry.tenantDid === tenantDid);
    // Deterministic ordering: newest first so apps see the most recent failures.
    entries.sort((a, b) => lexicographicalCompare(b.failedAt, a.failedAt));
    return entries;
  }

  /** Clear the exact dead letter resolved by an internal tenant sync outcome. */
  private async clearDeadLetterForTenant(tenantDid: string, messageCid: string, remoteEndpoint: string): Promise<void> {
    try {
      await this._deadLetterStore.deleteExact(tenantDid, messageCid, remoteEndpoint);
    } catch (error) {
      // A late live callback may race orderly storage closure.
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

  public async clearDeadLetter(messageCid: string, remoteEndpoint?: string): Promise<boolean> {
    // The durable key includes tenant, but this API intentionally clears by
    // message CID and optional remote regardless of tenant, matching the
    // previous public contract.
    const deleted = await this._deadLetterStore.deleteForMessage(messageCid, remoteEndpoint);
    return deleted > 0;
  }

  public async clearAllDeadLetters(tenantDid?: string): Promise<void> {
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
      const topologyGeneration = this._targetPlanner.topologyGeneration;
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
        this._targetPlanner.topologyGeneration !== topologyGeneration
      ) {
        return;
      }

      // Reconcile this exact projection/authorization link before forcing any
      // remaining direct probes. A later delete/update can therefore replay a
      // retained dataless ancestor as its dependency instead of exposing that
      // ancestor as standalone remote state.
      await this.reconcileTarget(
        target,
        { direction: 'push', forceQuotaProbe: true },
        (): boolean =>
          transitionFence() &&
          this._targetPlanner.topologyGeneration === topologyGeneration,
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

  /**
   * Return the cached or freshly planned canonical targets for every
   * registration. NOT a pure read: on a cache miss the fresh plan also
   * prunes quota blocks for targets that no longer exist, via the planner's
   * `beforeCache` hook.
   */
  private getSyncTargets(): Promise<SyncTarget[]> {
    return this._targetPlanner.getTargets({
      beforeCache: (targets, topologyGeneration): Promise<void> =>
        this.pruneQuotaBlocksForCurrentTargets(targets, topologyGeneration),
    });
  }

}
