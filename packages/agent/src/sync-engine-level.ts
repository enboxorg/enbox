import type { AbstractLevel } from 'abstract-level';

import type { DwnSubscriptionHandler, DwnSubscriptionMessage, ResubscribeFactory } from '@enbox/dwn-clients';
import type { GenericMessage, MessagesQueryReply, MessagesQueryReplyEntry, MessagesSubscribeReply, RecordsDeleteMessage, RecordsQueryReply, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { CryptoUtils } from '@enbox/crypto';
import { Level } from 'level';
import { RateLimitError } from '@enbox/dwn-clients';
import { BroadcastChannelWakePublisher, DwnErrorCode, DwnInterfaceName, DwnMethodName, Encoder, Message, Records, resolveProtocolRoleContextScope } from '@enbox/dwn-sdk-js';
import { parseDurationInMilliseconds, runWithCrossContextLock, sleep } from '@enbox/common';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { SyncDeadLetterStore } from './sync-dead-letter-store.js';
import type { SyncEndpointStore } from './sync-endpoint-store.js';
import type { SyncFreshEntry } from './sync-admit-closure.js';
import type { SyncIdentityStore } from './sync-identity-store.js';
import type { SyncMessageEntry } from './sync-messages.js';
import type { SyncReplicationLinkStore } from './sync-replication-link-store.js';
import type { SyncStatusLink } from './sync-status-reporter.js';
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
  SyncLifecycleOptions,
  SyncRunOptions,
} from './types/sync.js';
import type {
  SyncDurableFeedPageAdmissionResult as FeedPageAdmissionResult,
  SyncDurableFeedPagePushResult as FeedPushResult,
  SyncDurableFeedPermissionGrantBootstrapResult as PermissionGrantBootstrapResult,
  SyncDurableFeedQuery,
  SyncDurableFeedReconcileOptions as SyncReconcileOptions,
  SyncDurableFeedReconcileResult as SyncReconcileResult,
} from './sync-durable-feed-reconciler.js';
import type { FollowedSyncSource, FollowedSyncSourceInput, FollowedSyncSourceStore } from './followed-sync-source.js';
import type { SyncDeferredPullState, SyncDeferredPullStore } from './sync-deferred-pull-store.js';
import type { SyncEndpointDiscovery, SyncTarget } from './sync-target-resolver.js';
import type { SyncIdentityTaskRunner, SyncLifecycleDeadline } from './sync-lifecycle-coordinator.js';
import type {
  SyncScopeClosureGrantQuery,
  SyncScopeClosureGrantResolution,
  SyncScopeProtocolHistoryPage,
  SyncScopeProtocolHistoryQuery,
} from './sync-scope-closure-validator.js';

import { AgentPermissionsApi } from './permissions-api.js';

import { admitClosure } from './sync-admit-closure.js';
import { DwnInterface } from './types/dwn.js';
import { FollowedSyncSourceStoreLevel } from './followed-sync-source-store-level.js';
import { SyncConnectivityManager } from './sync-connectivity-manager.js';
import { SyncDeadLetterStoreLevel } from './sync-dead-letter-store-level.js';
import { SyncDeferredPullStoreLevel } from './sync-deferred-pull-store-level.js';
import { SyncDrainCoordinator } from './sync-drain-coordinator.js';
import { SyncDurableFeedReconciler } from './sync-durable-feed-reconciler.js';
import { SyncEchoSuppressor } from './sync-echo-suppressor.js';
import { SyncEndpointStoreLevel } from './sync-endpoint-store-level.js';
import { SyncFeedConvergenceManager } from './sync-feed-convergence-manager.js';
import { SyncIdentityStoreLevel } from './sync-identity-store-level.js';
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
import { buildCurrentLinkIdentityKey, buildDurableLinkIdentityKey, buildLinkKey, LINK_KEY_SEPARATOR } from './sync-link-key.js';
import { computeProjectionId, isTerminalPushFailure, lexicographicalCompare, messageFeedFiltersForSyncScope, singleProtocolForSyncScope, syncEventScope, syncScopeFromProtocols } from './types/sync.js';
import { createSyncLifecycleDeadline, remainingSyncLifecycleTimeout, SyncLifecycleCoordinator } from './sync-lifecycle-coordinator.js';
import { fetchRemoteMessages, getLocalMessage, isInitialWriteForRecord, pushMessageEntries, pushMessages, queryLocalMessageFeed, queryRemoteMessageFeed, recordIdForRecordsMessage, syncMessageDescriptor, SyncPullAbortedError } from './sync-messages.js';
import { FollowedSourceNotReadyError, FollowedSourceRoleAbsentError, readFollowedRoleState, readRoleReplicationSupport, type RoleReplicationSupportBatch, RoleReplicationSupportError } from './sync-role-replication-support.js';
import { followedSyncSourceActiveEqual, followedSyncSourcePolicyEqual, followedSyncSourceRoleRecordEqual, normalizeFollowedSyncSource, normalizeFollowedSyncSourceInput, resolveFollowedSyncRoleRoot } from './followed-sync-source.js';
import { getMessagesPermissionGrantsForScope, permissionGrantIdsFromEntries, SyncProtocolRootPermissionGrantMissingError, toMessagesPermissionGrantIds } from './sync-permission-grants.js';
import { isTerminalSyncAuthorizationFailure, syncErrorMessage, SyncRunCancelledError } from './sync-runtime-errors.js';
import { isValidProgressToken, SyncCheckpoint } from './sync-checkpoint.js';
import { normalizeDwnEndpoint, syncTargetFromLink, SyncTargetResolver } from './sync-target-resolver.js';

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

class FollowedSourceRoleRecordMismatchError extends Error {
  public constructor(expected: string, actual: string | undefined) {
    super(`SyncEngineLevel: followed role record changed from ${expected} to ${actual ?? 'none'}.`);
    this.name = 'FollowedSourceRoleRecordMismatchError';
  }
}

class RoleFeedAdmissionError extends Error {
  public constructor(messageCid: string) {
    super(`SyncEngineLevel: role feed message ${messageCid} could not be admitted; the replica cannot become current.`);
    this.name = 'RoleFeedAdmissionError';
  }
}

type LinkInitializationResult =
  | { status: LinkInitializationStatus.Active; durableLinkIdentityKey: string }
  | { status: LinkInitializationStatus.Failed };

type FollowedEndpointResolution =
  | {
    kind: 'active';
    batch: RoleReplicationSupportBatch;
    dwnUrl: string;
    protocolPaths: [string, ...string[]];
    role: string;
  }
  | { kind: 'absent'; dwnUrl: string }
  | { kind: 'unknown'; dwnUrl: string; error: unknown };

type FollowedSourceResolution =
  | { kind: 'active'; batch: RoleReplicationSupportBatch; dwnUrl: string; dwnUrls: string[]; source: FollowedSyncSource }
  | { kind: 'absent'; dwnUrls: string[] }
  | { kind: 'unknown'; error: Error };

type PreparedFollowedSourceTombstone = { sourceDid: string; tombstone: RecordsDeleteMessage };

type PreparedFollowedSource = {
  resolution: FollowedSourceResolution;
  tombstones: PreparedFollowedSourceTombstone[];
};

type FollowedSourceChangeEvent = Extract<SyncEvent, { type: 'followed-context:change' }>;

type FollowedContextKey = Pick<FollowedSyncSource, 'actorDid' | 'contextId' | 'protocol' | 'sourceDid'>;

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
  private readonly _followedSourceStore: FollowedSyncSourceStore;
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

  /** Active replication-session controllers; their keyed scheduling lives in `_runtime`. */
  private readonly _linkControllers: Map<string, SyncLinkController> = new Map();

  /**
   * Subscription closes that outlived a lifecycle deadline, grouped by tenant.
   * Retaining them lets a later stop or identity mutation wait for the original
   * transport cleanup instead of mistaking an already-detached controller for
   * a fully closed subscription.
   */
  private readonly _pendingSubscriptionCloses: Map<string, Set<Promise<void>>> = new Map();

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

  /** One coalesced followed-context maintenance pass for the current live runtime. */
  private _followedSourceReconciliation?: Promise<void>;
  private _followedSourceReconciliationPending = false;

  /** Last catalog state applied to this engine's events and replication sessions. */
  private readonly _followedSourceSnapshot: Map<string, FollowedSyncSource> = new Map();
  private _followedSourceSnapshotInitialized = false;

  /** Cross-context durable-catalog wake, present for path-addressed stores. */
  private readonly _followedSourceWakePublisher?: BroadcastChannelWakePublisher;

  /** Serializes public Retry-now operations with each other before they acquire the sync lock. */
  private _retryRemoteQueue: Promise<void> = Promise.resolve();

  /**
   * Backoff schedule for transient link-init 401s that clear on their own: a
   * recently published did:dht record still propagating, or a newly created
   * identity the remote DWN has not finished registering as a tenant.
   */
  private static readonly TRANSIENT_INIT_RETRY_BACKOFF_MS = [2000, 4000, 8000];

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
    this._followedSourceStore = new FollowedSyncSourceStoreLevel(this._db);
    this._identityStore = new SyncIdentityStoreLevel(this._db);

    // Collaborators. Policy managers precede their direct consumers. The
    // remaining cross-collaborator operations resolve `this.…` only when
    // invoked, so constructing quota before the durable-feed reconciler and
    // convergence before link recovery does not eagerly traverse either
    // dependency cycle.
    this._connectivityManager = new SyncConnectivityManager();
    this._quotaManager = this.createQuotaManager();
    this._feedConvergenceManager = this.createFeedConvergenceManager();
    this._drainCoordinator = this.createDrainCoordinator();
    this._runCoordinator = this.createRunCoordinator();
    this._scopeClosureValidator = this.createScopeClosureValidator();
    this._durableFeedReconciler = this.createDurableFeedReconciler();
    this._targetPlanner = this.createTargetPlanner();
    this._statusReporter = this.createStatusReporter();
    this._linkRecoveryCoordinator = this.createLinkRecoveryCoordinator();

    if (dataPath !== undefined) {
      this._followedSourceWakePublisher = new BroadcastChannelWakePublisher(
        `enbox:sync-followed-source:${this._lockNamespace}`,
      );
      this._followedSourceWakePublisher.subscribe(
        (): void => { this.scheduleFollowedSourceReconciliation(); },
      );
    }
  }

  /** Wire SyncDrainCoordinator to this engine. */
  private createDrainCoordinator(): SyncDrainCoordinator {
    return new SyncDrainCoordinator({
      connectivityManager    : this._connectivityManager,
      feedConvergenceManager : this._feedConvergenceManager,
      identityStore          : this._identityStore,
      quotaManager           : this._quotaManager,
      operations             : {
        buildTargetsForEndpoint: (did, remoteEndpoint, options): Promise<SyncTarget[]> =>
          this.targetResolver.buildTargetsForEndpoint(did, remoteEndpoint, options),
        getLink               : (target): Promise<ReplicationLinkState> => this.getOrCreateReplicationLink(target),
        getTopologyGeneration : (): number => this._targetPlanner.topologyGeneration,
        prepareLiveTarget     : (target): Promise<void> => this.prepareDrainLiveTarget(target),
        reconcileTarget       : (target, options, shouldContinue): Promise<SyncReconcileResult> =>
          this.reconcileTarget(target, options, shouldContinue),
        recordPushFailures: async (target, failures): Promise<void> => {
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
      connectivityManager    : this._connectivityManager,
      feedConvergenceManager : this._feedConvergenceManager,
      operations             : {
        getTargets           : (): Promise<SyncTarget[]> => this.getSyncTargets(),
        probeFeedConvergence : (target): Promise<SyncReconcileResult> =>
          this.probeFeedConvergence(target),
        reconcileTarget: (target, direction, verifyConvergence): Promise<SyncReconcileResult> =>
          this.reconcileTarget(target, { direction, verifyConvergence }),
        recordPushFailures: (target, failures): Promise<number> =>
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
        collectFeedCids: (target, source): Promise<Set<string> | undefined> =>
          this._durableFeedReconciler.collectFeedCids(target, source),
        getLocalMessage: (target, messageCid): Promise<SyncMessageEntry | undefined> =>
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
          this.recordTerminalPushFailure(target, failure),
      },
    });
  }

  /** Wire SyncFeedConvergenceManager to this engine. */
  private createFeedConvergenceManager(): SyncFeedConvergenceManager {
    return new SyncFeedConvergenceManager({
      quotaManager : this._quotaManager,
      operations   : {
        getActiveLink           : (linkKey): ReplicationLinkState | undefined => this.getActiveLink(linkKey),
        getDeadLettersForTenant : (tenantDid): Promise<DeadLetterEntry[]> =>
          this._deadLetterStore.getForTenant(tenantDid),
        getLink                    : (target): Promise<ReplicationLinkState> => this.getOrCreateReplicationLink(target),
        getLinkKey                 : (target, link): string => this.getReplicationLinkKey(target, link),
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
      quotaManager : this._quotaManager,
      operations   : {
        admitRemotePage: (target, entries, shouldContinue): Promise<FeedPageAdmissionResult> =>
          this.admitRemoteFeedPage(target, entries, shouldContinue),
        bootstrapRemotePermissionGrants: (
          target,
          shouldContinue,
          forceQuotaProbe,
        ): Promise<PermissionGrantBootstrapResult> =>
          this.bootstrapRemotePermissionGrants(target, shouldContinue, forceQuotaProbe),
        commitCheckpoint: (link, direction): Promise<void> =>
          this.commitReconciledCheckpoint(link, direction),
        probeQuotaBlocks: (target, force, forceProbeCids, shouldContinue): Promise<void> =>
          this.probeQuotaBlocksForTarget(target, force, forceProbeCids, shouldContinue),
        pushLocalPage: (target, entries, shouldContinue): Promise<FeedPushResult> =>
          this.pushLocalFeedPage(target, entries, shouldContinue),
        queryFeed       : (query): Promise<MessagesQueryReply> => this.queryDurableFeed(query),
        resetCheckpoint : (link, direction): Promise<void> => this.replicationLinkStore.resetCheckpoint(link, direction),
      },
    });
  }

  /** Wire SyncTargetPlanner to this engine. */
  private createTargetPlanner(): SyncTargetPlanner {
    return new SyncTargetPlanner({
      getTargetResolver : (): SyncTargetResolver => this.targetResolver,
      identityStore     : this._identityStore,
      sourceStore       : this._followedSourceStore,
      warn              : (message, error): void => { console.warn(message, error); },
    });
  }

  /** Wire SyncStatusReporter to this engine. */
  private createStatusReporter(): SyncStatusReporter {
    return new SyncStatusReporter({
      quotaManager : this._quotaManager,
      operations   : {
        getConnectivityState       : (): SyncConnectivityState => this.connectivityState,
        getCurrentLinkIdentityKeys : (): Promise<Set<string> | undefined> => this.getCurrentLinkIdentityKeys(),
        getCurrentQuotaLinkKeys    : (): Promise<Set<string> | undefined> => this.getCurrentQuotaLinkKeys(),
        getDeadLetters             : (): Promise<DeadLetterEntry[]> => this._deadLetterStore.getAll(),
        getLinks                   : (): Promise<SyncStatusLink[]> => this.getLinksForStatusReporting(),
      },
    });
  }

  /**
   * Overlay ephemeral replication-session state onto fresh durable link rows.
   *
   * Checkpoints stay store-sourced so an in-flight persist cannot expose
   * progress as durable prematurely. Status and connectivity instead come
   * from the active controller, which is authoritative for the current
   * runtime. A resumed durable `live` row remains `initializing` until the
   * replacement replication generation establishes its baseline.
   */
  private async getLinksForStatusReporting(): Promise<SyncStatusLink[]> {
    const links = await this.replicationLinkStore.getAllLinks();
    return links.map((link): SyncStatusLink => {
      const linkKey = buildLinkKey(
        link.tenantDid,
        link.remoteEndpoint,
        link.projectionId,
        link.authorizationEpoch,
      );
      const controller = this.getLinkController(linkKey);
      if (controller?.isActive !== true) {
        return { ...link, connectivity: 'unknown', isPullCurrent: false };
      }

      const activeLink = controller.link;
      const status = activeLink.status === 'live' && !controller.isReplicationReady
        ? 'initializing'
        : activeLink.status;
      return {
        ...link,
        connectivity  : activeLink.connectivity,
        isPullCurrent : controller.isPullCurrent,
        status,
      };
    });
  }

  /** Wire SyncLinkRecoveryCoordinator to this engine. */
  private createLinkRecoveryCoordinator(): SyncLinkRecoveryCoordinator {
    return new SyncLinkRecoveryCoordinator({
      feedConvergenceManager : this._feedConvergenceManager,
      operations             : {
        captureIdentityTaskRunner: (tenantDid): SyncIdentityTaskRunner =>
          this._lifecycle.captureIdentityTaskRunner(tenantDid),
        emitEvent            : (event): void => { this.emitEvent(event); },
        getController        : (linkKey): SyncLinkController | undefined => this.getLinkController(linkKey),
        getRuntime           : (): SyncRuntime => this._runtime,
        markPullPending      : (controller): void => { this.markPullPending(controller); },
        openPullSubscription : (target, controller): Promise<boolean> =>
          this.openLivePullSubscription(target, controller),
        openPushSubscription: (target, controller): Promise<boolean> =>
          this.openLocalPushSubscription(target, controller),
        reconcileTarget: (controller, target, options, shouldContinue): Promise<SyncReconcileResult> =>
          this.reconcileOwnedTarget(controller, target, options, shouldContinue),
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

  get isLiveSyncRunning(): boolean {
    return this._runtime.live;
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
      this.deactivateLinkController(existing);
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
    this.deactivateLinkController(controller);
    void controller.dispose();
    this._linkControllers.delete(linkKey);
  }

  /** Fence pull currentness and every callback before deactivating an active link owner. */
  private deactivateLinkController(controller: SyncLinkController): void {
    this.beginLinkControllerDeactivation(controller);
    this._linkRecoveryCoordinator.cancelScheduledWork(controller);
    controller.deactivate();
  }

  /** Fence new link ownership while allowing already-running durable work to drain. */
  private beginLinkControllerDeactivation(controller: SyncLinkController): void {
    if (controller.beginDeactivation()) {
      this.emitPullCurrentnessChange(controller, true, false);
    }
  }

  public on(listener: SyncEventListener): () => void {
    this._eventListeners.add(listener);
    return (): void => { this._eventListeners.delete(listener); };
  }

  /** Emit a sync event to all registered listeners. */
  private emitEvent(event: SyncEvent): void {
    for (const listener of Array.from(this._eventListeners)) {
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

  public async clear(options: SyncLifecycleOptions = {}): Promise<void> {
    const deadline = SyncEngineLevel.createLifecycleDeadline(options);
    await this._lifecycle.runTransition(async (activeDeadline): Promise<void> => {
      await this.stopSyncRuntime(activeDeadline);
      await this.runDestructivePhase(async (): Promise<void> => {
        const followedSources = await this.readFollowedSources();
        await this._permissionsApi.clear();
        await this.clearSyncDb();
        this._followedSourceSnapshot.clear();
        this._followedSourceSnapshotInitialized = true;
        this.invalidateSyncTargetsCache();
        for (const source of followedSources) {
          this.emitFollowedSourceChange(source, undefined);
        }
      }, activeDeadline);
    }, deadline);
  }

  public async close(options: SyncLifecycleOptions = {}): Promise<void> {
    const deadline = SyncEngineLevel.createLifecycleDeadline(options);
    await this._lifecycle.runTransition(async (activeDeadline): Promise<void> => {
      await this.stopSyncRuntime(activeDeadline);
      this.closeFollowedSourceWakePublisher();
      await this.runDestructivePhase(async (): Promise<void> => {
        await this._db.close();
      }, activeDeadline);
    }, deadline);
  }

  /** Stop cross-context catalog wakes before closing their shared store. */
  private closeFollowedSourceWakePublisher(): void {
    this._followedSourceWakePublisher?.clear();
    this._followedSourceWakePublisher?.close();
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
  private async runDestructivePhase(
    operation: () => Promise<void>,
    deadline?: SyncLifecycleDeadline,
  ): Promise<void> {
    if (deadline === undefined) {
      await this._lifecycle.acquireSync();
    } else if (!await this._lifecycle.acquireSyncBefore(deadline)) {
      throw new Error(
        `SyncEngineLevel: Existing sync operation did not complete within ${deadline.timeout} milliseconds.`,
      );
    }
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

  public registerIdentity(
    params: { did: string; options: SyncIdentityOptions },
    lifecycleOptions: SyncLifecycleOptions = {},
  ): Promise<void> {
    return this.runExclusiveIdentityMutation(
      params.did,
      (deadline): Promise<void> => this.doRegisterIdentity(params, deadline),
      lifecycleOptions,
    );
  }

  /**
   * Every identity mutation layers the engine-local exclusive sync lock
   * around the cross-context per-DID lifecycle lock. Composing both here
   * makes the layering structurally unforgettable for future mutation sites.
   */
  private async runExclusiveIdentityMutation(
    did: string,
    operation: (deadline?: SyncLifecycleDeadline) => Promise<void>,
    lifecycleOptions: SyncLifecycleOptions,
  ): Promise<void> {
    const deadline = SyncEngineLevel.createLifecycleDeadline(lifecycleOptions);
    await this._lifecycle.runIdentityMutation(async (activeDeadline): Promise<void> => {
      await this.runIdentityLifecycle(did, operation, activeDeadline);
    }, deadline);
  }

  private async doRegisterIdentity(
    { did, options }: { did: string; options: SyncIdentityOptions },
    deadline?: SyncLifecycleDeadline,
  ): Promise<void> {
    this._scopeClosureValidator.validateOptions(options);

    const existing = await this.waitForLifecycleBarrier(
      this.getIdentityOptions(did),
      deadline,
      'Identity registration preparation did not complete',
    );
    if (existing) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is already registered.`);
    }

    await this.waitForLifecycleBarrier(
      this._scopeClosureValidator.validateClosure(did, options),
      deadline,
      'Identity registration preparation did not complete',
    );
    await this._identityStore.set(did, options);
    this.invalidateSyncTargetsCache();
    await this.refreshRoleLinksForActor(did, options.delegateDid);
    this.emitEvent({ type: 'identity:registration-change', tenantDid: did, options: structuredClone(options) });

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

  public unregisterIdentity(did: string, lifecycleOptions: SyncLifecycleOptions = {}): Promise<void> {
    return this.runExclusiveIdentityMutation(
      did,
      (deadline): Promise<void> => this.doUnregisterIdentity(did, deadline),
      lifecycleOptions,
    );
  }

  private async doUnregisterIdentity(did: string, deadline?: SyncLifecycleDeadline): Promise<void> {
    const existing = await this.waitForLifecycleBarrier(
      this.getIdentityOptions(did),
      deadline,
      'Identity unregistration preparation did not complete',
    );
    if (!existing) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
    }

    // A timed-out stop may leave already-running identity work after the live
    // runtime has been disposed. Drain every surviving form of per-identity
    // ownership before deleting the durable registration.
    const hasPriorLiveRuntime = this._runtime.live ||
      this._lifecycle.hasIdentityTasks(did) ||
      this.hasActiveLinksForDid(did) ||
      this.hasLinkInitRetriesForDid(did);
    if (hasPriorLiveRuntime) {
      await this.removeIdentityFromLiveSync(did, deadline);
    }

    // A pending rate-limit init retry may exist even without an active link
    // (the 429 path drops the controller before arming the retry, so the
    // hot-remove above can be skipped entirely). Its captured target is now
    // unregistered — cancel it unconditionally.
    this.cancelLinkInitRetriesForDid(did);
    await this.pauseRoleLinksForActor(did);

    // Tenant-scoped deletion runs first; the identity marker is deleted LAST
    // as the durable commit point. A failure at any earlier step — including
    // durable-link pruning — leaves the registration intact so the caller can
    // simply retry the unregister. Pruning must precede the marker deletion:
    // a paused link surviving an unregister shares its durable identity key
    // with a same-scope re-registration, so supersession pruning would retain
    // it and silently disable live replication.
    await this._quotaManager.clearTenant(did);
    await this.pruneSupersededDurableLinksForIdentity(did, new Set());
    await this.runDeferredPullLifecycle(did, async (): Promise<void> => {
      await this._deferredPullStore.deleteForTenant(did);
      await this._identityStore.delete(did);
    });
    this.invalidateSyncTargetsCache();
    this.emitEvent({ type: 'identity:registration-change', tenantDid: did });
  }

  public async getIdentityOptions(did: string): Promise<SyncIdentityOptions | undefined> {
    try {
      return await this._identityStore.get(did);
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      throw new Error(`SyncEngineLevel: Error reading level: ${code}.`);
    }
  }

  public updateIdentityOptions(
    params: { did: string, options: SyncIdentityOptions },
    lifecycleOptions: SyncLifecycleOptions = {},
  ): Promise<void> {
    return this.runExclusiveIdentityMutation(
      params.did,
      (deadline): Promise<void> => this.doUpdateIdentityOptions(params, deadline),
      lifecycleOptions,
    );
  }

  private async doUpdateIdentityOptions(
    { did, options }: { did: string, options: SyncIdentityOptions },
    deadline?: SyncLifecycleDeadline,
  ): Promise<void> {
    this._scopeClosureValidator.validateOptions(options);

    const existingOptions = await this.waitForLifecycleBarrier(
      this.getIdentityOptions(did),
      deadline,
      'Identity update preparation did not complete',
    );
    if (!existingOptions) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
    }

    await this.waitForLifecycleBarrier(
      this._scopeClosureValidator.validateClosure(did, options),
      deadline,
      'Identity update preparation did not complete',
    );

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
    const hadPriorLiveRuntime = hadPendingLinkInitRetry ||
      this._lifecycle.hasIdentityTasks(did) ||
      this.hasActiveLinksForDid(did);
    const rebuildLiveLinks = this._runtime.live && hadPriorLiveRuntime;
    if (hadPriorLiveRuntime) {
      await this.removeIdentityFromLiveSync(did, deadline);
    }

    // Scope/delegate changes define different replication links. A block from
    // the previous authorization must not suppress the replacement link's
    // first delivery attempt. Clear only after old link work has drained so it
    // cannot recreate stale state after the quota state is cleared.
    await this._quotaManager.clearTenant(did);

    // Persist the new identity options only after every timeout-bounded
    // preparation barrier has completed. From this commit point onward the
    // update runs to completion and is never abandoned halfway through.
    await this._identityStore.set(did, options);
    this.invalidateSyncTargetsCache();
    await this.refreshRoleLinksForActor(did, options.delegateDid);
    this.emitEvent({ type: 'identity:registration-change', tenantDid: did, options: structuredClone(options) });

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

  /** Rebind stable role links after their actor-to-delegate authorization is refreshed. */
  private async refreshRoleLinksForActor(
    actorDid: string,
    delegateDid?: string,
    followedSourceId?: string,
  ): Promise<void> {
    const targets: SyncTarget[] = [];
    for (const link of await this.replicationLinkStore.getAllLinks()) {
      if (
        link.authorization.kind !== 'role' ||
        link.authorization.actorDid !== actorDid ||
        (followedSourceId !== undefined && link.authorization.roleRecordId !== followedSourceId) ||
        (link.status !== 'paused' && link.delegateDid === delegateDid)
      ) {
        continue;
      }

      const target = { ...syncTargetFromLink(link), delegateDid };
      if (!await this.isFollowedTargetRunnable(target)) {
        continue;
      }

      const linkKey = this.getReplicationLinkKey(target, link);
      this.removeLinkController(linkKey);
      const refreshed = await this.getOrCreateReplicationLink(target);
      if (!await this.isFollowedTargetCurrent(target)) {
        await this.replicationLinkStore.deleteLink(
          refreshed.tenantDid,
          refreshed.remoteEndpoint,
          refreshed.projectionId,
          refreshed.authorizationEpoch,
        );
        continue;
      }
      await this.replicationLinkStore.setStatus(refreshed, 'initializing');
      targets.push(target);
    }

    if (this._runtime.live) {
      await Promise.allSettled(targets.map(target => this.initializeLinkTargetWithRetry(target)));
    }
  }

  /** Park foreign-context links while their actor has no registered execution identity. */
  private async pauseRoleLinksForActor(actorDid: string): Promise<void> {
    for (const link of await this.replicationLinkStore.getAllLinks()) {
      if (link.authorization.kind !== 'role' || link.authorization.actorDid !== actorDid) {
        continue;
      }
      const linkKey = this.getReplicationLinkKey(syncTargetFromLink(link), link);
      this._runtime.cancelTimer(SyncEngineLevel.linkInitRetryTimerKey(linkKey));
      await this._linkRecoveryCoordinator.transitionToPaused(
        linkKey,
        this.getLinkController(linkKey)?.link ?? link,
      );
    }
  }

  public async followSource(input: FollowedSyncSourceInput): Promise<FollowedSyncSource> {
    const normalized = normalizeFollowedSyncSourceInput(input);
    const transitionFence = this.captureTransitionFence();
    const assertTransitionCurrent = (): void => {
      if (!transitionFence()) {
        throw new FollowedSourceNotReadyError('the local sync lifecycle changed while accepting the context');
      }
    };

    for (;;) {
      assertTransitionCurrent();
      const identity = await this._identityStore.get(normalized.actorDid);
      if (identity === undefined) {
        throw new FollowedSourceNotReadyError(`actor '${normalized.actorDid}' is not registered for sync`);
      }
      const previous = (await this.readFollowedSources()).filter(candidate =>
        SyncEngineLevel.sameFollowedContext(candidate, normalized)
      );
      const resolution = await this.resolveFollowedSource(
        normalized,
        identity.delegateDid,
        transitionFence,
        previous,
      );
      assertTransitionCurrent();
      if (resolution.kind === 'absent') {
        throw new FollowedSourceNotReadyError('none of the requested roles is visible on every source endpoint yet');
      }
      if (resolution.kind === 'unknown') {
        throw resolution.error;
      }

      const tombstones = await this.prepareRetiredFollowedSourceTombstones(
        previous,
        resolution.dwnUrls,
        resolution.source.id,
        identity.delegateDid,
        transitionFence,
      );
      assertTransitionCurrent();

      let committed = false;
      await this._lifecycle.runTransition(async (): Promise<void> => {
        assertTransitionCurrent();
        await this._lifecycle.acquireSync();
        try {
          await this.runIdentityLifecycle(normalized.sourceDid, async (): Promise<void> => {
            const currentIdentity = await this._identityStore.get(normalized.actorDid);
            const current = (await this.readFollowedSources()).filter(candidate =>
              SyncEngineLevel.sameFollowedContext(candidate, normalized)
            );
            if (
              currentIdentity === undefined ||
              currentIdentity.delegateDid !== identity.delegateDid ||
              current.length !== previous.length ||
              current.some(candidate => !previous.some(entry => followedSyncSourceActiveEqual(candidate, entry)))
            ) {
              return;
            }
            await this.applyPreparedFollowedSource(resolution, tombstones, transitionFence);
            const replaced = await this.commitFollowedSource(resolution.source);
            for (const previous of replaced) {
              this.deactivateFollowedSourceControllers(previous.id, previous.sourceDid);
            }
            committed = true;
          });
        } finally {
          this._lifecycle.releaseSync();
        }
      });
      assertTransitionCurrent();
      if (!committed) {
        continue;
      }

      this.activateFollowedSource(resolution.source, identity.delegateDid);
      return resolution.source;
    }
  }

  /** Resolve one role only when every advertised endpoint agrees on its exact record. */
  private async resolveFollowedSource(
    input: FollowedSyncSourceInput,
    delegateDid: string | undefined,
    shouldContinue?: () => boolean,
    previousSources: readonly FollowedSyncSource[] = [],
  ): Promise<FollowedSourceResolution> {
    const endpoints = await this.targetResolver.getRemoteEndpointUrls(input.sourceDid);
    if (endpoints.length === 0) {
      return {
        kind  : 'unknown',
        error : new Error(`SyncEngineLevel: Followed source ${input.sourceDid} has no remote DWN endpoint.`),
      };
    }

    const endpointResults = await Promise.all(endpoints.map(dwnUrl =>
      this.resolveFollowedEndpoint(input, delegateDid, dwnUrl, shouldContinue)
    ));
    if (endpointResults.every(result => result.kind === 'absent')) {
      return { kind: 'absent', dwnUrls: endpoints };
    }

    const notReady = endpointResults.find((result): result is Extract<FollowedEndpointResolution, { kind: 'unknown' }> =>
      result.kind === 'unknown' && result.error instanceof FollowedSourceNotReadyError
    );
    if (notReady !== undefined) {
      return { kind: 'unknown', error: notReady.error as FollowedSourceNotReadyError };
    }

    const active = endpointResults.filter(
      (result): result is Extract<FollowedEndpointResolution, { kind: 'active' }> => result.kind === 'active',
    );
    const absent = endpointResults.filter(result => result.kind === 'absent');
    if (active.length > 0 && absent.length > 0 && active.length + absent.length === endpointResults.length) {
      return {
        kind  : 'unknown',
        error : new FollowedSourceNotReadyError('source endpoints disagree on whether the context role is active'),
      };
    }
    const first = active[0];
    if (
      first === undefined ||
      active.length !== endpointResults.length ||
      active.some(result =>
        result.role !== first.role ||
        result.batch.roleRecordId !== first.batch.roleRecordId ||
        result.protocolPaths.length !== first.protocolPaths.length ||
        result.protocolPaths.some((path, index) => path !== first.protocolPaths[index])
      )
    ) {
      const detail = endpointResults.map(result => {
        if (result.kind === 'active') {
          return `${result.dwnUrl}: ${result.role} (${result.batch.roleRecordId})`;
        }
        return result.kind === 'absent'
          ? `${result.dwnUrl}: absent`
          : `${result.dwnUrl}: ${syncErrorMessage(result.error)}`;
      }).join('; ');
      return {
        kind  : 'unknown',
        error : new Error(`SyncEngineLevel: Followed context endpoints do not agree: ${detail}`),
      };
    }

    let source = normalizeFollowedSyncSource({
      acceptanceId  : CryptoUtils.randomUuid(),
      id            : first.batch.roleRecordId,
      ...input,
      protocolPaths : first.protocolPaths,
      protocolRole  : first.role,
    });
    const previous = previousSources.find(candidate => followedSyncSourcePolicyEqual(candidate, source));
    if (previous !== undefined) {
      source = { ...source, acceptanceId: previous.acceptanceId };
    }
    return { kind: 'active', batch: first.batch, dwnUrl: first.dwnUrl, dwnUrls: endpoints, source };
  }

  /** Resolve the current authority and prepare any verified retirement tombstones for local application. */
  private async prepareExistingFollowedSource(
    expected: FollowedSyncSource,
    delegateDid: string | undefined,
    shouldContinue?: () => boolean,
  ): Promise<PreparedFollowedSource> {
    const resolution = await this.resolveFollowedSource({
      actorDid  : expected.actorDid,
      contextId : expected.contextId,
      protocol  : expected.protocol,
      roles     : expected.roles,
      sourceDid : expected.sourceDid,
    }, delegateDid, shouldContinue, [expected]);
    if (resolution.kind === 'unknown') {
      return { resolution, tombstones: [] };
    }
    const activeRoleRecordId = resolution.kind === 'active' ? resolution.source.id : undefined;
    const tombstones = await this.prepareRetiredFollowedSourceTombstones(
      [expected],
      resolution.dwnUrls,
      activeRoleRecordId,
      delegateDid,
      shouldContinue,
    );
    return { resolution, tombstones };
  }

  /** Select the strongest role proven by one endpoint; only verified absence permits fallback. */
  private async resolveFollowedEndpoint(
    input: FollowedSyncSourceInput,
    delegateDid: string | undefined,
    dwnUrl: string,
    shouldContinue?: () => boolean,
  ): Promise<FollowedEndpointResolution> {
    for (const role of input.roles) {
      const { protocolPath } = resolveFollowedSyncRoleRoot(input.contextId, role);
      try {
        const batch = await readRoleReplicationSupport({
          ...input,
          agent          : this.agent,
          delegateDid,
          dwnUrl,
          permissionsApi : this._permissionsApi,
          protocolPath,
          protocolRole   : role,
          shouldContinue,
        });
        const protocolPaths = resolveProtocolRoleContextScope(batch.protocolDefinition, role).readablePaths;
        return { kind: 'active', batch, dwnUrl, protocolPaths, role };
      } catch (error: unknown) {
        if (error instanceof FollowedSourceRoleAbsentError) {
          continue;
        }
        return { kind: 'unknown', dwnUrl, error };
      }
    }
    return { kind: 'absent', dwnUrl };
  }

  /** Admit the agreed role closure before making it the active durable source. */
  private async admitFollowedSource(
    resolution: Extract<FollowedSourceResolution, { kind: 'active' }>,
    shouldContinue?: () => boolean,
  ): Promise<void> {
    const { batch, dwnUrl, source } = resolution;
    const outcome = await admitClosure(batch.rootCid, {
      agent                   : this.agent,
      did                     : source.sourceDid,
      dwnUrl,
      fetchReplicationSupport : async () => batch,
      prefetched              : [...batch.dependencies, batch.root],
      scope                   : {
        kind          : 'context',
        contextId     : source.contextId,
        protocol      : source.protocol,
        protocolPaths : source.protocolPaths,
      },
      shouldContinue,
    });
    if (outcome.kind !== 'admitted') {
      throw new Error(
        outcome.detail ?? (outcome.kind === 'failed' ? outcome.reason : 'incomplete followed-context bootstrap'),
      );
    }
  }

  /** Apply already-verified local state before committing its matching catalog authority. */
  private async applyPreparedFollowedSource(
    resolution: Exclude<FollowedSourceResolution, { kind: 'unknown' }>,
    tombstones: readonly PreparedFollowedSourceTombstone[],
    shouldContinue?: () => boolean,
  ): Promise<void> {
    for (const { sourceDid, tombstone } of tombstones) {
      if (shouldContinue?.() === false) {
        throw new SyncPullAbortedError();
      }
      const outcome = await this.agent.dwn.applyReplicatedMessage(sourceDid, tombstone);
      if (outcome.kind !== 'Applied' && outcome.kind !== 'Duplicate' && outcome.kind !== 'Superseded') {
        throw new Error(
          `SyncEngineLevel: Could not apply retired role deletion locally (${outcome.kind}).`,
        );
      }
    }
    if (resolution.kind === 'active') {
      await this.admitFollowedSource(resolution, shouldContinue);
    }
  }

  /** Commit one followed source without coupling durable truth to link cleanup. */
  private async commitFollowedSource(source: FollowedSyncSource): Promise<FollowedSyncSource[]> {
    const sources = await this.readFollowedSources();
    this.initializeFollowedSourceSnapshot(sources);
    const existing = sources.find(candidate => candidate.id === source.id);
    if (existing !== undefined && !followedSyncSourceRoleRecordEqual(existing, source)) {
      throw new Error(`SyncEngineLevel: Followed source ${source.id} is already registered with different details.`);
    }

    const replaced = sources.filter(entry =>
      entry.id !== source.id && SyncEngineLevel.sameFollowedContext(entry, source)
    );
    if (existing !== undefined && !followedSyncSourceActiveEqual(existing, source)) {
      replaced.push(existing);
    }
    const changed = existing === undefined || !followedSyncSourceActiveEqual(existing, source) || replaced.length > 0;
    if (changed) {
      await this._followedSourceStore.replace(source, replaced.map(previous => previous.id));
      this._followedSourceSnapshot.set(SyncEngineLevel.followedContextKey(source), source);
      this.invalidateSyncTargetsCache();
      this.emitFollowedSourceChange(source, source.id);
    }
    return replaced;
  }

  /** Remove links for followed sources replaced by a durable commit. */
  private async removeFollowedSourceLinksForSources(sources: readonly FollowedSyncSource[]): Promise<void> {
    await Promise.all(sources.map(previous => this.removeFollowedSourceLinks(
      previous.id,
      previous.sourceDid,
    )));
  }

  /** Activate an already-committed source without extending its mutation lock. */
  private activateFollowedSource(
    source: FollowedSyncSource,
    delegateDid: string | undefined,
  ): void {
    if (!this._runtime.live) {
      return;
    }

    const runIdentityTask = this._lifecycle.captureIdentityTaskRunner(source.actorDid);
    void runIdentityTask(async (): Promise<void> => {
      await this.refreshRoleLinksForActor(source.actorDid, delegateDid, source.id);
      const targets = await this.targetResolver.buildTargetsForSource(source, delegateDid);
      await Promise.all(targets.map(target => this.initializeLinkTargetWithRetry(target)));
    });
  }

  public getFollowedSource(id: string): Promise<FollowedSyncSource | undefined> {
    return this._followedSourceStore.get(id);
  }

  public async listFollowedSources(): Promise<FollowedSyncSource[]> {
    const sources = await this.readFollowedSources();
    this.initializeFollowedSourceSnapshot(sources);
    return sources;
  }

  /** Establish a complete baseline before applying point catalog mutations. */
  private initializeFollowedSourceSnapshot(sources: readonly FollowedSyncSource[]): void {
    if (this._followedSourceSnapshotInitialized) {
      return;
    }
    for (const source of sources) {
      this._followedSourceSnapshot.set(SyncEngineLevel.followedContextKey(source), source);
    }
    this._followedSourceSnapshotInitialized = true;
  }

  /** Decode the durable catalog without changing this engine's applied snapshot. */
  private async readFollowedSources(): Promise<FollowedSyncSource[]> {
    const sources: FollowedSyncSource[] = [];
    for (const entry of await this._followedSourceStore.list()) {
      if (entry.status === 'valid') {
        sources.push(entry.source);
      } else {
        console.warn(`SyncEngineLevel: Corrupt followed source ${entry.id}, skipping source:`, entry.error);
      }
    }
    return sources;
  }

  public async deleteFollowedSource(source: FollowedSyncSource): Promise<void> {
    const normalized = normalizeFollowedSyncSource(source);
    await this.runExclusiveIdentityMutation(
      normalized.sourceDid,
      async (): Promise<void> => {
        const current = await this._followedSourceStore.get(normalized.id);
        if (current === undefined || !followedSyncSourceActiveEqual(current, normalized)) {
          return;
        }
        await this.removeFollowedSourceLinksForSources([current]);
        await this.commitFollowedSourceRemoval(current);
      },
      {},
    );
  }

  /** Mark one exact followed source stale and request its active replication sessions to pull. */
  public async markFollowedSourcePullPending(source: FollowedSyncSource): Promise<boolean> {
    const expected = normalizeFollowedSyncSource(source);
    const current = await this._followedSourceStore.get(expected.id);
    if (current === undefined || !followedSyncSourceActiveEqual(current, expected)) {
      return false;
    }

    for (const controller of this._linkControllers.values()) {
      if (!SyncEngineLevel.followedSourceCoversTarget(expected, syncTargetFromLink(controller.link))) {
        continue;
      }
      this.markPullPending(controller);
      controller.executor.request('pull');
      if (controller.isReplicationReady) {
        const runIdentityTask = this._lifecycle.captureIdentityTaskRunner(expected.sourceDid);
        void runIdentityTask(() => this._linkRecoveryCoordinator.resume(controller));
      }
    }
    return true;
  }

  /** Resolve and pull one active followed source from every currently advertised endpoint. */
  public async pullFollowedSource(source: FollowedSyncSource): Promise<boolean> {
    const expected = normalizeFollowedSyncSource(source);
    const transitionFence = this.captureTransitionFence();
    const identity = await this._identityStore.get(expected.actorDid);
    if (identity === undefined) {
      return false;
    }
    const accepted = await this._followedSourceStore.get(expected.id);
    if (accepted === undefined || !followedSyncSourceActiveEqual(accepted, expected)) {
      return false;
    }
    const prepared = await this.prepareExistingFollowedSource(
      expected,
      identity.delegateDid,
      transitionFence,
    );
    const { resolution, tombstones } = prepared;
    if (resolution.kind === 'unknown') {
      throw resolution.error;
    }

    let activate: FollowedSyncSource | undefined;
    let initializeTargets: SyncTarget[] = [];
    let pullDrained = false;
    await this._lifecycle.acquireSync();
    try {
      let currentSource: FollowedSyncSource | undefined;
      await this.runIdentityLifecycle(expected.sourceDid, async (): Promise<void> => {
        const current = await this._followedSourceStore.get(expected.id);
        const currentIdentity = await this._identityStore.get(expected.actorDid);
        if (
          !transitionFence() ||
          current === undefined ||
          !followedSyncSourceActiveEqual(current, expected) ||
          currentIdentity === undefined ||
          currentIdentity.delegateDid !== identity.delegateDid
        ) {
          return;
        }

        await this.applyPreparedFollowedSource(resolution, tombstones, transitionFence);
        if (resolution.kind === 'absent') {
          await this.removeFollowedSourceLinksForSources([current]);
          await this.commitFollowedSourceRemoval(current);
          return;
        }
        if (!followedSyncSourceActiveEqual(current, resolution.source)) {
          await this.removeFollowedSourceLinksForSources([current]);
          await this.commitFollowedSource(resolution.source);
          activate = resolution.source;
        }
        currentSource = resolution.source;
      });
      const resolvedSource = currentSource;
      if (resolvedSource === undefined || resolution.kind !== 'active') {
        return false;
      }

      const isCurrent = async (): Promise<boolean> => {
        const current = await this._followedSourceStore.get(resolvedSource.id);
        const currentIdentity = await this._identityStore.get(resolvedSource.actorDid);
        return transitionFence() &&
          current !== undefined &&
          followedSyncSourceActiveEqual(current, resolvedSource) &&
          currentIdentity !== undefined &&
          currentIdentity.delegateDid === identity.delegateDid;
      };
      if (!await isCurrent()) {
        return false;
      }

      const targets = await this.targetResolver.buildTargetsForSource(
        resolvedSource,
        identity.delegateDid,
        resolution.dwnUrls,
      );
      if (targets.length === 0 || !await isCurrent()) {
        return false;
      }
      if (activate === undefined && this._runtime.live) {
        initializeTargets = targets.filter(target => this.getLinkController(buildLinkKey(
          target.did,
          target.dwnUrl,
          target.projectionId,
          target.authorizationEpoch,
        ))?.isActive !== true);
      }
      const results = await Promise.allSettled(targets.map(target => this.reconcileTarget(
        target,
        { direction: 'pull' },
        transitionFence,
      )));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure !== undefined) {
        throw failure.reason;
      }
      pullDrained = results.every(result => result.status === 'fulfilled' && result.value.pullDrained === true) &&
        await isCurrent() && followedSyncSourceActiveEqual(resolvedSource, expected);
    } finally {
      this._lifecycle.releaseSync();
      if (activate !== undefined) {
        this.activateFollowedSource(activate, identity.delegateDid);
      }
    }
    if (initializeTargets.length > 0) {
      const initialized = await Promise.all(initializeTargets.map(target => this.initializeLinkTargetWithRetry(target)));
      if (initialized.some(result => result.status !== LinkInitializationStatus.Active)) {
        return false;
      }
    }
    return pullDrained;
  }

  private async commitFollowedSourceRemoval(source: FollowedSyncSource): Promise<void> {
    this.initializeFollowedSourceSnapshot(await this.readFollowedSources());
    await this._followedSourceStore.delete(source.id);
    this._followedSourceSnapshot.delete(SyncEngineLevel.followedContextKey(source));
    this.invalidateSyncTargetsCache();
    this.emitFollowedSourceChange(source, undefined);
  }

  private emitFollowedSourceChange(source: FollowedSyncSource, followedSourceId: string | undefined): void {
    const event: FollowedSourceChangeEvent = {
      type                       : 'followed-context:change',
      tenantDid                  : source.sourceDid,
      actorDid                   : source.actorDid,
      protocol                   : source.protocol,
      contextId                  : source.contextId,
      followedSourceAcceptanceId : source.acceptanceId,
      followedSourceId           : followedSourceId,
    };
    this.emitEvent(event);
    this._followedSourceWakePublisher?.publish({ tenant: source.sourceDid, seq: source.acceptanceId });
  }

  private async removeFollowedSourceLinks(id: string, sourceDid: string): Promise<void> {
    const targets = this.deactivateFollowedSourceControllers(id, sourceDid);
    const links = (await this.replicationLinkStore.getLinksForTenant(sourceDid)).filter(link =>
      link.authorization.kind === 'role' && link.authorization.roleRecordId === id
    );
    for (const link of links) {
      targets.set(
        buildLinkKey(link.tenantDid, link.remoteEndpoint, link.projectionId, link.authorizationEpoch),
        syncTargetFromLink(link),
      );
    }
    await Promise.all([...targets.values()].map(target => this.removeFollowedSourceLink(target)));
  }

  private deactivateFollowedSourceControllers(id: string, sourceDid: string): Map<string, SyncTarget> {
    const targets = new Map<string, SyncTarget>();
    for (const [linkKey, controller] of this._linkControllers) {
      if (
        controller.link.tenantDid === sourceDid &&
        controller.link.authorization.kind === 'role' &&
        controller.link.authorization.roleRecordId === id
      ) {
        const target = syncTargetFromLink(controller.link);
        targets.set(linkKey, target);
        this.deactivateFollowedSourceLink(target);
      }
    }
    return targets;
  }

  private async removeFollowedSourceLink(target: SyncTarget): Promise<void> {
    this.deactivateFollowedSourceLink(target);
    await this.replicationLinkStore.deleteLink(
      target.did,
      target.dwnUrl,
      target.projectionId,
      target.authorizationEpoch,
    );
  }

  /** Fence a followed link before any fallible durable cleanup. */
  private deactivateFollowedSourceLink(target: SyncTarget): void {
    const linkKey = buildLinkKey(target.did, target.dwnUrl, target.projectionId, target.authorizationEpoch);
    this.removeLinkController(linkKey);
    this._runtime.cancelTimer(SyncEngineLevel.linkInitRetryTimerKey(linkKey));
    this._feedConvergenceManager.clearLink(linkKey);
  }

  private static sameFollowedContext(
    a: FollowedContextKey,
    b: FollowedContextKey,
  ): boolean {
    return SyncEngineLevel.followedContextKey(a) === SyncEngineLevel.followedContextKey(b);
  }

  private static followedContextKey(source: FollowedContextKey): string {
    return JSON.stringify([source.sourceDid, source.actorDid, source.protocol, source.contextId]);
  }

  /** Apply durable catalog changes to this engine's events and replication sessions. */
  private async refreshFollowedSourceState(): Promise<FollowedSyncSource[]> {
    let sources: FollowedSyncSource[];
    await this._lifecycle.acquireSync();
    try {
      sources = await this.readFollowedSources();
      const current = new Map(sources.map(source => [SyncEngineLevel.followedContextKey(source), source]));
      const changes: Array<{ source: FollowedSyncSource; followedSourceId: string | undefined }> = [];
      for (const key of new Set([...this._followedSourceSnapshot.keys(), ...current.keys()])) {
        const previous = this._followedSourceSnapshot.get(key);
        const next = current.get(key);
        if (previous !== undefined && next !== undefined && followedSyncSourceActiveEqual(previous, next)) {
          continue;
        }
        const source = next ?? previous;
        if (source !== undefined) {
          changes.push({ source, followedSourceId: next?.id });
        }
      }
      this._followedSourceSnapshot.clear();
      for (const [key, source] of current) {
        this._followedSourceSnapshot.set(key, source);
      }
      this._followedSourceSnapshotInitialized = true;
      if (changes.length > 0) {
        this.invalidateSyncTargetsCache();
        for (const change of changes) {
          this.emitFollowedSourceChange(change.source, change.followedSourceId);
        }
      }
    } finally {
      this._lifecycle.releaseSync();
    }
    await this.removeObsoleteFollowedSourceLinks(sources);
    return sources;
  }

  /** Remove durable role links outside the exact accepted source and endpoint set. */
  private async removeObsoleteFollowedSourceLinks(sources: readonly FollowedSyncSource[]): Promise<void> {
    const scannedSources = new Map(sources.map(source => [source.id, source]));
    const scannedEndpoints = new Map<string, Set<string> | undefined>();
    await Promise.all(sources.map(async (source): Promise<void> => {
      try {
        const targets = await this.targetResolver.buildTargetsForSource(source);
        scannedEndpoints.set(source.id, new Set(targets.map(target => target.dwnUrl)));
      } catch {
        scannedEndpoints.set(source.id, undefined);
      }
    }));

    await this._lifecycle.acquireSync();
    try {
      const candidates = new Map<string, { id: string; sourceDid: string; target: SyncTarget }>();
      const collect = (link: ReplicationLinkState): void => {
        if (link.authorization.kind !== 'role') {
          return;
        }
        const target = syncTargetFromLink(link);
        const key = buildLinkKey(link.tenantDid, link.remoteEndpoint, link.projectionId, link.authorizationEpoch);
        candidates.set(key, {
          id        : link.authorization.roleRecordId,
          sourceDid : link.tenantDid,
          target,
        });
      };
      for (const controller of this._linkControllers.values()) {
        collect(controller.link);
      }
      for (const link of await this.replicationLinkStore.getAllLinks()) {
        collect(link);
      }
      await Promise.all([...candidates.values()].map(({ id, sourceDid, target }) =>
        this.runIdentityLifecycle(sourceDid, async (): Promise<void> => {
          const current = await this._followedSourceStore.get(id);
          if (current === undefined || !SyncEngineLevel.followedSourceCoversTarget(current, target)) {
            await this.removeFollowedSourceLink(target);
            return;
          }

          const scanned = scannedSources.get(id);
          if (scanned === undefined || !followedSyncSourceActiveEqual(scanned, current)) {
            return;
          }
          const currentEndpoints = scannedEndpoints.get(id);
          if (currentEndpoints !== undefined && !currentEndpoints.has(target.dwnUrl)) {
            await this.removeFollowedSourceLink(target);
          }
        })
      ));
    } finally {
      this._lifecycle.releaseSync();
    }
  }

  /** Coalesce startup, settle, and paused-link wakes onto one existing runtime task. */
  private scheduleFollowedSourceReconciliation(): void {
    const runtime = this._runtime;
    if (runtime.disposed) {
      return;
    }
    if (this._followedSourceReconciliation !== undefined) {
      this._followedSourceReconciliationPending = true;
      return;
    }

    const task = this._lifecycle.runBackgroundTask(async (): Promise<void> => {
      do {
        this._followedSourceReconciliationPending = false;
        await this.reconcileFollowedSources(runtime);
      } while (!runtime.disposed && this._followedSourceReconciliationPending);
    });
    this._followedSourceReconciliation = task;
    const clear = (): void => {
      if (this._followedSourceReconciliation === task) {
        const rerun = !runtime.disposed && this._followedSourceReconciliationPending;
        this._followedSourceReconciliation = undefined;
        this._followedSourceReconciliationPending = false;
        if (rerun) {
          this.scheduleFollowedSourceReconciliation();
        }
      }
    };
    void task.then(clear, clear);
  }

  /** Re-evaluate each durable role group without adding another retry scheduler. */
  private async reconcileFollowedSources(runtime: SyncRuntime): Promise<void> {
    const sources = await this.refreshFollowedSourceState();
    if (!runtime.live) {
      return;
    }
    for (const source of sources) {
      if (runtime.disposed) {
        return;
      }
      try {
        await this.runFollowedSourceMaintenance(runtime, source);
      } catch (error: unknown) {
        if (!runtime.disposed) {
          console.error(`SyncEngineLevel: Followed context ${source.contextId} reconciliation failed`, error);
        }
      }
    }
  }

  /** Resolve remotely, then make local admission and the durable compare-and-swap exclusive. */
  private async runFollowedSourceMaintenance(
    runtime: SyncRuntime,
    expected: FollowedSyncSource,
  ): Promise<void> {
    if (runtime.disposed) {
      return;
    }
    const identity = await this._identityStore.get(expected.actorDid);
    if (identity === undefined) {
      return;
    }
    const shouldContinue = (): boolean => !runtime.disposed;
    const { resolution, tombstones } = await this.prepareExistingFollowedSource(
      expected,
      identity.delegateDid,
      shouldContinue,
    );
    if (runtime.disposed || resolution.kind === 'unknown') {
      return;
    }

    let activate = false;
    await this._lifecycle.acquireSync();
    try {
      if (runtime.disposed) {
        return;
      }
      await this.runIdentityLifecycle(expected.sourceDid, async (): Promise<void> => {
        const current = await this._followedSourceStore.get(expected.id);
        const latestIdentity = await this._identityStore.get(expected.actorDid);
        if (
          runtime.disposed ||
          current === undefined ||
          !followedSyncSourceActiveEqual(current, expected) ||
          latestIdentity === undefined ||
          latestIdentity.delegateDid !== identity.delegateDid
        ) {
          return;
        }

        await this.applyPreparedFollowedSource(resolution, tombstones, shouldContinue);
        if (resolution.kind === 'absent') {
          await this.removeFollowedSourceLinksForSources([current]);
          await this.commitFollowedSourceRemoval(current);
        } else if (followedSyncSourceActiveEqual(current, resolution.source)) {
          activate = true;
        } else {
          await this.removeFollowedSourceLinksForSources([current]);
          await this.commitFollowedSource(resolution.source);
          activate = true;
        }
      });
    } finally {
      this._lifecycle.releaseSync();
    }
    if (activate && resolution.kind === 'active') {
      this.activateFollowedSource(
        resolution.source,
        identity.delegateDid,
      );
    }
  }

  /** Prove retired roles remotely and retain their signed tombstones for the local commit. */
  private async prepareRetiredFollowedSourceTombstones(
    previousSources: readonly FollowedSyncSource[],
    dwnUrls: readonly string[],
    activeRoleRecordId: string | undefined,
    delegateDid?: string,
    shouldContinue?: () => boolean,
  ): Promise<PreparedFollowedSourceTombstone[]> {
    const prepared = new Map<string, PreparedFollowedSourceTombstone>();
    for (const previous of previousSources) {
      if (previous.id === activeRoleRecordId) {
        continue;
      }
      const states = await Promise.all(dwnUrls.map(dwnUrl => readFollowedRoleState({
        actorDid       : previous.actorDid,
        agent          : this.agent,
        contextId      : previous.contextId,
        delegateDid,
        dwnUrl,
        permissionsApi : this._permissionsApi,
        protocol       : previous.protocol,
        protocolRole   : previous.protocolRole,
        roleRecordId   : previous.id,
        shouldContinue,
        sourceDid      : previous.sourceDid,
      })));
      if (states.some(state => state.kind === 'active')) {
        throw new FollowedSourceNotReadyError(
          `retired role '${previous.protocolRole}' is still active on a source endpoint`,
        );
      }
      const tombstones = new Map<string, RecordsDeleteMessage>();
      for (const state of states) {
        if (state.kind === 'absent') {
          tombstones.set(await Message.getCid(state.tombstone), state.tombstone);
        }
      }
      if (tombstones.size === 0) {
        throw new FollowedSourceNotReadyError(
          `retired role '${previous.protocolRole}' has no verifiable deletion`,
        );
      }
      for (const [cid, tombstone] of tombstones) {
        prepared.set(JSON.stringify([previous.sourceDid, cid]), { sourceDid: previous.sourceDid, tombstone });
      }
    }
    return [...prepared.values()];
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

  public async startSync(params: StartSyncParams = {}): Promise<void> {
    await this._lifecycle.runTransition(async (): Promise<void> => {
      await this.startSyncRuntime(params);
    });
    this.scheduleFollowedSourceReconciliation();
  }

  private async startSyncRuntime(params: StartSyncParams): Promise<void> {
    // An invalid interval rejects here, before any runtime is torn down. The
    // parsed value is clamped: the floor prevents a tight settle-check loop
    // ('0s' would tick every macrotask), and the ceiling stays within the
    // 32-bit native timer range (an overflowing delay silently clamps to
    // ~1ms — also a tight loop).
    const intervalMilliseconds = Math.min(
      Math.max(parseDurationInMilliseconds(params.interval ?? '5m'), SyncEngineLevel.MIN_SYNC_INTERVAL_MS),
      SyncEngineLevel.MAX_TIMER_DELAY_MS,
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
   * stopSync cancels runtime-owned scheduling and closes live subscriptions, then
   * waits for current lock-owning and background sync operations to finish.
   *
   * @param timeout - One shared maximum wait for an earlier lifecycle
   *   transition, subscription closure, and in-progress sync/background work.
   *   Non-finite values (`NaN`, `Infinity`) are
   *   coerced to the default to avoid a tight busy-wait loop or never-exit
   *   condition.
   */
  public stopSync(timeout: number = 2000): Promise<void> {
    const safeTimeout = SyncEngineLevel.coerceStopSyncTimeout(timeout);
    const deadline = createSyncLifecycleDeadline(safeTimeout);
    return this._lifecycle.runTransition(async (activeDeadline): Promise<void> => {
      await this.stopSyncRuntime(activeDeadline);
    }, deadline);
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
   * Preserve `stopSync`'s legacy numeric-argument coercion. The newer
   * `SyncLifecycleOptions` APIs instead reject invalid timeout values before
   * changing runtime or storage state.
   */
  private static coerceStopSyncTimeout(timeout: number): number {
    return Number.isFinite(timeout)
      ? Math.min(Math.max(0, timeout), SyncEngineLevel.MAX_TIMER_DELAY_MS)
      : 2000;
  }

  /** Validate an opt-in lifecycle wait and convert it to one absolute deadline. */
  private static createLifecycleDeadline(options: SyncLifecycleOptions): SyncLifecycleDeadline | undefined {
    const timeout = options.timeout;
    if (timeout === undefined) {
      return undefined;
    }
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > SyncEngineLevel.MAX_TIMER_DELAY_MS) {
      throw new RangeError(
        `SyncEngineLevel: Lifecycle timeout must be between 0 and ${SyncEngineLevel.MAX_TIMER_DELAY_MS} milliseconds.`,
      );
    }
    return createSyncLifecycleDeadline(timeout);
  }

  private async stopSyncRuntime(deadline?: SyncLifecycleDeadline): Promise<void> {
    this.prepareForSyncRuntimeTransition();
    await this.stopLiveSync(deadline);
    const remainingTimeout = deadline === undefined
      ? undefined
      : remainingSyncLifecycleTimeout(deadline);
    const [syncCompletion, backgroundCompletion] = await Promise.allSettled([
      this.waitForSyncCompletion(remainingTimeout, deadline?.timeout),
      this.waitForBackgroundTasks(remainingTimeout, deadline?.timeout),
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

  private async waitForSyncCompletion(timeout?: number, requestedTimeout: number | undefined = timeout): Promise<void> {
    if (!await this._lifecycle.waitForSyncCompletion(timeout)) {
      throw new Error(`SyncEngineLevel: Existing sync operation did not complete within ${requestedTimeout} milliseconds.`);
    }
  }

  private async waitForBackgroundTasks(timeout?: number, requestedTimeout: number | undefined = timeout): Promise<void> {
    if (!await this._lifecycle.waitForBackgroundTasks(timeout)) {
      throw new Error(`SyncEngineLevel: Background sync operations did not complete within ${requestedTimeout} milliseconds.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Live sync
  // ---------------------------------------------------------------------------

  /** Runtime-owned timer key for the periodic durable feed settle check. */
  private static readonly SETTLE_CHECK_TIMER = 'syncInterval';

  /** Settle-check cadence floor — prevents a tight reconciliation loop. */
  private static readonly MIN_SYNC_INTERVAL_MS = 1_000;

  /** The 32-bit native timer ceiling shared by intervals and lifecycle waits. */
  private static readonly MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

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
      await this.listFollowedSources();
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
    this.scheduleFollowedSourceReconciliation();
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

  private async transitionToPaused(
    linkKey: string,
    link: ReplicationLinkState,
    reconcileFollowedSource = true,
  ): Promise<void> {
    const lostEstablishedRole = link.authorization.kind === 'role' &&
      (link.status === 'live' || link.status === 'repairing');
    await this._linkRecoveryCoordinator.transitionToPaused(linkKey, link);
    if (lostEstablishedRole && reconcileFollowedSource) {
      this.scheduleFollowedSourceReconciliation();
    }
  }

  private async pauseRoleLinkForError(
    target: SyncTarget,
    link: ReplicationLinkState,
    error: unknown,
  ): Promise<void> {
    if (link.status === 'paused') {
      return;
    }
    const supportFailure = error instanceof RoleReplicationSupportError;
    if (supportFailure) {
      console.error(
        `SyncEngineLevel: Invalid role replication support for ${target.did} -> ${target.dwnUrl}`,
        error,
      );
    }
    await this.transitionToPaused(this.getReplicationLinkKey(target, link), link, !supportFailure);
  }

  // ---------------------------------------------------------------------------
  // Stop live sync
  // ---------------------------------------------------------------------------

  private async stopLiveSync(deadline?: SyncLifecycleDeadline): Promise<void> {
    // The runtime transition already cancelled runtime-owned scheduling.
    // Invalidate callbacks and clear in-memory ownership before awaiting
    // transport cleanup, so even a stuck close cannot revive the stopped
    // runtime. Remote and local closes then proceed independently in parallel.
    const controllers = [...this._linkControllers.values()];
    for (const controller of controllers) {
      this.deactivateLinkController(controller);
    }
    this._linkControllers.clear();

    this._feedConvergenceManager.clearAll();

    // Clear pending rate-limit link-init retries. The runtime is
    // normally already disposed here; the explicit clear keeps this stop
    // correct for any caller that runs it against a live runtime.
    this._runtime.cancelTimers(SyncEngineLevel.isLinkInitRetryTimerKey);

    this._echoSuppressor.clear();

    this.trackSubscriptionCloses(controllers);
    await this.waitForLifecycleBarrier(
      Promise.all(this.getPendingSubscriptionCloses()),
      deadline,
      'Live subscriptions did not close',
    );
  }

  /** Retain transport-close promises until the underlying subscriptions settle. */
  private trackSubscriptionCloses(controllers: SyncLinkController[]): void {
    for (const controller of controllers) {
      const tenantDid = controller.link.tenantDid;
      const pendingCloses = this._pendingSubscriptionCloses.get(tenantDid) ?? new Set<Promise<void>>();
      this._pendingSubscriptionCloses.set(tenantDid, pendingCloses);

      const close = controller.closeSubscriptions();
      pendingCloses.add(close);
      const forget = (): void => {
        pendingCloses.delete(close);
        if (pendingCloses.size === 0 && this._pendingSubscriptionCloses.get(tenantDid) === pendingCloses) {
          this._pendingSubscriptionCloses.delete(tenantDid);
        }
      };
      void close.then(forget, forget);
    }
  }

  /** Return every retained close, optionally limited to one identity. */
  private getPendingSubscriptionCloses(did?: string): Promise<void>[] {
    if (did !== undefined) {
      return [...(this._pendingSubscriptionCloses.get(did) ?? [])];
    }

    return [...this._pendingSubscriptionCloses.values()].flatMap(pending => [...pending]);
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
      if (!await this.isFollowedTargetRunnable(target)) {
        return { status: LinkInitializationStatus.Failed };
      }
      link = await this.getOrCreateReplicationLink(target);
      if (runtime.disposed) {
        return { status: LinkInitializationStatus.Failed };
      }
      const linkKey = this.getReplicationLinkKey(target, link);
      if (!await this.isFollowedTargetRunnable(target)) {
        await this.replicationLinkStore.deleteLink(
          link.tenantDid,
          link.remoteEndpoint,
          link.projectionId,
          link.authorizationEpoch,
        );
        return { status: LinkInitializationStatus.Failed };
      }

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
      if (!await this.isFollowedTargetRunnable(target)) {
        this.removeLinkController(linkKey, controller);
        await this.replicationLinkStore.deleteLink(
          link.tenantDid,
          link.remoteEndpoint,
          link.projectionId,
          link.authorizationEpoch,
        );
        return { status: LinkInitializationStatus.Failed };
      }
      return await this.initializeActivatedLinkTarget(target, linkKey, link, controller);
    } catch (error: any) {
      if (runtime.disposed) {
        return { status: LinkInitializationStatus.Failed };
      }
      return this.handleInitializeLinkTargetError(target, link, controller, error);
    }
  }

  /** A role target remains schedulable only while its exact source registration exists. */
  private async isFollowedTargetCurrent(target: SyncTarget): Promise<boolean> {
    if (target.authorization.kind !== 'role') {
      return true;
    }
    const source = await this._followedSourceStore.get(target.authorization.roleRecordId);
    return source !== undefined && SyncEngineLevel.followedSourceCoversTarget(source, target);
  }

  private static followedSourceCoversTarget(source: FollowedSyncSource, target: SyncTarget): boolean {
    const { scope } = target;
    return target.authorization.kind === 'role' &&
      scope.kind === 'context' &&
      source.sourceDid === target.did &&
      source.actorDid === target.authorization.actorDid &&
      source.protocol === scope.protocol &&
      source.contextId === scope.contextId &&
      source.protocolRole === target.authorization.protocolRole &&
      source.protocolPaths.length === scope.protocolPaths.length &&
      source.protocolPaths.every((path, index) => path === scope.protocolPaths[index]);
  }

  /** A current role target runs only under its actor's current delegate registration. */
  private async isFollowedTargetRunnable(target: SyncTarget): Promise<boolean> {
    if (target.authorization.kind !== 'role') {
      return true;
    }
    if (!await this.isFollowedTargetCurrent(target)) {
      return false;
    }
    const identity = await this._identityStore.get(target.authorization.actorDid);
    return identity !== undefined && identity.delegateDid === target.delegateDid;
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
      controller.executor.request('push');
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
    if (target.authorization.kind === 'role') {
      return LinkSubscriptionOpenResult.ReadyForLive;
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
   * after either snapshot leave a work mark for executor eligibility.
   */
  private async establishLinkBaseline(
    target: SyncTarget,
    controller: SyncLinkController,
    expectedReplicationGeneration: number,
  ): Promise<SyncReconcileResult | undefined> {
    const { link } = controller;
    const isCurrent = (): boolean =>
      !this._runtime.disposed && controller.isReplicationGenerationCurrent(expectedReplicationGeneration);
    if (target.authorization.kind === 'role') {
      const result = await this.reconcileOwnedTarget(controller, target, undefined, isCurrent);
      if (result.pullDrained === true && isCurrent()) {
        this.markPullCurrent(controller, expectedReplicationGeneration);
      }
      return result;
    }

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
      this.markPullCurrent(controller, expectedReplicationGeneration);
      return { converged: true };
    }

    const result = await this.reconcileDurableTarget(target, link, undefined, isCurrent);
    if (result.pullDrained === true && isCurrent()) {
      this.markPullCurrent(controller, expectedReplicationGeneration);
    }
    return result;
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
    controller.markReplicationReady();
    this.emitEvent({
      type           : 'link:status-change',
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      ...syncEventScope(target.scope),
      from           : previousStatus,
      to             : 'live'
    });
    if (controller.executor.hasPendingWork) {
      const runIdentityTask = this._lifecycle.captureIdentityTaskRunner(link.tenantDid);
      void runIdentityTask(() => this._linkRecoveryCoordinator.resume(controller));
    }
    const nextProbeAt = await this._quotaManager.getNextProbeAtForTarget(target);
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

    if (
      target.authorization.kind === 'role' &&
          SyncEngineLevel.isRoleLinkPauseError(error)
    ) {
      if (link !== undefined) {
        await this.pauseRoleLinkForError(target, link, error);
      }
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

    if (this.isTenantNotRegisteredError(error)) {
      // Transient during identity creation: the remote DWN has not finished
      // registering the newly created tenant, so MessagesSubscribe 401s with
      // 'Not a registered tenant'. It clears within seconds, so log at warn
      // and rethrow to initializeLinkTargetWithRetry's backoff ladder instead
      // of an alarming error and a wait for the periodic settle check. Durable
      // reconciliation still runs via the settle check, so no data is lost
      // while the live subscription is deferred.
      console.warn(
        `SyncEngineLevel: Deferring live subscription for ${target.did} -> ${target.dwnUrl}; ` +
        `remote tenant not registered yet, retrying`,
      );
      if (link) {
        this.retireFailedLinkAttempt(this.getReplicationLinkKey(target, link), controller);
      }
      throw error;
    }

    console.error(`SyncEngineLevel: Failed to open live subscription for ${target.did} -> ${target.dwnUrl}`, error);
    if (link) {
      this.retireFailedLinkAttempt(this.getReplicationLinkKey(target, link), controller);
    }
    // Rethrow so initializeLinkTargetWithRetry can run the transient-401 backoff
    // ladder (the tenant-not-registered case rethrows above). Callers without
    // that wrapper absorb it via Promise.allSettled. Everything else is already
    // reported and reduced to Failed — remove this rethrow and the retry ladder
    // silently stops working for DID propagation.
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
   * Wrapper around {@link initializeLinkTarget} that retries on transient
   * link-init failures — see {@link isTransientInitFailure}. A newly published
   * `did:dht` DID takes a few seconds to propagate through the DHT (during which
   * the remote DWN can't resolve it to verify request signatures, causing a
   * 401), and a newly created identity's remote tenant registration lands a beat
   * after the subscription is first attempted (a `401 Not a registered tenant`).
   * Retrying with exponential backoff lets both settle before giving up; the
   * periodic settle check remains the longer-horizon backstop.
   */
  private async initializeLinkTargetWithRetry(target: SyncTarget): Promise<LinkInitializationResult> {
    const runtime = this._runtime;
    try {
      return await this.initializeLinkTarget(target);
    } catch (error: any) {
      if (!this.isTransientInitFailure(error)) { throw error; }

      for (const delay of SyncEngineLevel.TRANSIENT_INIT_RETRY_BACKOFF_MS) {
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

  /**
   * A newly created identity's remote DWN briefly rejects MessagesSubscribe with
   * `401 Not a registered tenant` until tenant registration lands. Like DID
   * propagation, it clears within seconds.
   */
  private isTenantNotRegisteredError(error: any): boolean {
    const message = error.message ?? '';
    return message.includes('Not a registered tenant');
  }

  /**
   * Transient link-init failures a freshly created identity clears on its own
   * within seconds — the {@link TRANSIENT_INIT_RETRY_BACKOFF_MS} ladder
   * re-attempts rather than waiting for the periodic settle check.
   */
  private isTransientInitFailure(error: any): boolean {
    return this.isDidResolutionFailure(error) || this.isTenantNotRegisteredError(error);
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
  private async removeIdentityFromLiveSync(did: string, deadline?: SyncLifecycleDeadline): Promise<void> {
    const taskGroup = this._lifecycle.getIdentityTaskGroup(did);
    taskGroup.pause();

    const controllers = [...this._linkControllers.values()].filter(controller => controller.link.tenantDid === did);
    // Currentness must fall before transport closure can block, and
    // deactivation prevents an in-flight pull from restoring it while allowing
    // already-running durable work to drain before final deactivation.
    for (const controller of controllers) {
      this.beginLinkControllerDeactivation(controller);
    }
    this.trackSubscriptionCloses(controllers);
    await this.waitForLifecycleBarrier(
      Promise.all(this.getPendingSubscriptionCloses(did)),
      deadline,
      'Live subscriptions did not close',
    );

    // Stop queued work first, but retain its runtime state until callbacks that
    // are already in flight finish using it.
    this.cancelIdentityTimers(did);
    if (deadline === undefined) {
      await taskGroup.settle();
    } else if (!await taskGroup.settle(remainingSyncLifecycleTimeout(deadline))) {
      throw new Error(
        `SyncEngineLevel: Identity sync operations did not complete within ${deadline.timeout} milliseconds.`,
      );
    }

    // A running task may have armed a follow-up timer before observing the
    // paused group. Cancel that timer before discarding the link state.
    this.cancelIdentityTimers(did);
    this.discardIdentityLinkState(did);

    this._lifecycle.deleteIdentityTaskGroup(did, taskGroup);
  }

  /** Wait for pre-mutation lifecycle work without abandoning its rejection. */
  private async waitForLifecycleBarrier<T>(
    operation: Promise<T>,
    deadline: SyncLifecycleDeadline | undefined,
    failure: string,
  ): Promise<T> {
    if (deadline === undefined) {
      return operation;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        (): void => {
          reject(new Error(`SyncEngineLevel: ${failure} within ${deadline.timeout} milliseconds.`));
        },
        remainingSyncLifecycleTimeout(deadline),
      );
    });
    try {
      return await Promise.race([operation, timedOut]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /** Cancel active-session scheduling and pre-session initialization retries for one identity. */
  private cancelIdentityTimers(did: string): void {
    for (const controller of this._linkControllers.values()) {
      if (controller.link.tenantDid === did) {
        this._linkRecoveryCoordinator.cancelScheduledWork(controller);
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
      if (link.authorization.kind === 'role' || currentIdentityKeys.has(this.getDurableLinkIdentityKey(link))) {
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
    const { did, dwnUrl } = target;
    const eventScope = syncEventScope(target.scope);

    const linkKey = target.linkKey;
    const { link } = controller;

    const filters = messageFeedFiltersForSyncScope(target.scope) ?? [];

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
    const createSubscribeRequest = async (): Promise<Parameters<typeof this.agent.dwn.processRequest>[0]> => {
      const currentTarget = await this.targetResolver.withCurrentRoleGrant(target);
      const roleAuthorization = currentTarget.authorization.kind === 'role'
        ? currentTarget.authorization
        : undefined;
      return {
        store         : false as const,
        author        : roleAuthorization?.actorDid ?? did,
        target        : did,
        messageType   : DwnInterface.MessagesSubscribe as const,
        granteeDid    : currentTarget.delegateDid,
        messageParams : {
          filters,
          permissionGrantIds: toMessagesPermissionGrantIds(currentTarget.permissionGrantIds),
          ...(roleAuthorization === undefined ? {} : { protocolRole: roleAuthorization.protocolRole }),
          ...(currentTarget.authorDelegatedGrant === undefined
            ? {}
            : { delegatedGrant: currentTarget.authorDelegatedGrant }),
        },
      };
    };

    const { message } = await this.agent.dwn.processRequest(await createSubscribeRequest());
    if (!controller.isReplicationGenerationCurrent(subscriptionReplicationGeneration)) { return false; }
    if (!message) {
      throw new Error(`SyncEngineLevel: Failed to construct MessagesSubscribe for ${dwnUrl}`);
    }

    // Re-establish at the live head instead of replaying subscription events.
    // The `reconnected` lifecycle signal requests durable pull and push passes,
    // which recover the disconnected interval from persisted checkpoints.
    const resubscribeFactory: ResubscribeFactory = async () => {
      const { message: resumeMsg } = await this.agent.dwn.processRequest(await createSubscribeRequest());
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
    try {
      SyncEngineLevel.assertRoleRecordId(target, reply.roleRecordId);
    } catch (error: unknown) {
      await reply.subscription.close();
      throw error;
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
      this.markPullPending(context.controller);
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

    this.markPullPending(context.controller);
    context.controller.executor.request('pull');
    if (!context.controller.isReplicationReady || context.isStale()) {
      return;
    }

    // A subscription event is only a wake hint. Hand the durable pass to
    // lifecycle supervision and return so transport acknowledgement is not
    // coupled to a potentially multi-page catch-up. stopSync() still waits
    // for the supervised pass before closing storage.
    const runIdentityTask = this._lifecycle.captureIdentityTaskRunner(context.did);
    void runIdentityTask(() => this._linkRecoveryCoordinator.resume(context.controller));
  }

  /** A reconnect closes both disconnected-interval gaps without a full convergence probe. */
  private async requestDurableReconnectPasses(context: LivePullWakeContext): Promise<void> {
    const { controller } = context;
    controller.executor.request('pull');
    if (controller.link.authorization.kind !== 'role') {
      controller.executor.request('push');
    }
    if (!controller.isReplicationReady || context.isStale()) {
      return;
    }

    await this._linkRecoveryCoordinator.resume(controller);
  }

  private async handleLivePullError(context: LivePullWakeContext, errorCode: string): Promise<void> {
    const roleAuthorization = context.link.authorization.kind === 'role'
      ? context.link.authorization
      : undefined;
    if (roleAuthorization !== undefined && SyncEngineLevel.isMissingRoleAuthorization(errorCode)) {
      console.warn(
        `SyncEngineLevel: role authorization for ${context.did} -> ${context.dwnUrl} is no longer active — ` +
        'pausing this endpoint link.',
      );
      if (!context.isStale()) {
        await this.transitionToPaused(context.linkKey, context.link);
      }
      return;
    }
    if (isTerminalSyncAuthorizationFailure(errorCode)) {
      const detail = roleAuthorization === undefined
        ? `sync authorization for ${context.did} -> ${context.dwnUrl} was revoked or expired`
        : `role authorization for ${context.did} -> ${context.dwnUrl} is no longer active`;
      console.warn(`SyncEngineLevel: ${detail} — pausing link (reconnect to resume).`);
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

  /** Publish a replication-session pull-currentness transition. */
  private emitPullCurrentnessChange(
    controller: SyncLinkController,
    from: boolean,
    to: boolean,
  ): void {
    const { link } = controller;
    this.emitEvent({
      type           : 'pull:currentness-change',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...syncEventScope(link.scope),
      from,
      to,
    });
  }

  /** Record that a durable pull pass is required. */
  private markPullPending(controller: SyncLinkController): void {
    if (controller.markPullPending()) {
      this.emitPullCurrentnessChange(controller, true, false);
    }
  }

  /** Publish currentness only when this generation has no trailing pull wake. */
  private markPullCurrent(controller: SyncLinkController, replicationGeneration: number): void {
    if (controller.markPullCurrent(replicationGeneration)) {
      this.emitPullCurrentnessChange(controller, false, true);
    }
  }

  private emitCheckpointAdvance(
    link: ReplicationLinkState,
    direction: SyncDirection,
  ): void {
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

    const filters = messageFeedFiltersForSyncScope(target.scope) ?? [];

    const runtime = this._runtime;

    const isPushStale = (): boolean =>
      runtime.disposed || !controller.isReplicationGenerationCurrent(subscriptionReplicationGeneration);
    const runIdentityTask = this._lifecycle.captureIdentityTaskRunner(did);

    // Subscribe to the local DWN's EventLog.
    const subscriptionHandler = (subMessage: DwnSubscriptionMessage): Promise<void> =>
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

  /** Coalesce one local feed event into the session's durable push work. */
  private async handleLocalPushMessage(
    controller: SyncLinkController,
    isStale: () => boolean,
    message: DwnSubscriptionMessage,
  ): Promise<void> {
    if (isStale()) {
      return;
    }
    if (message.type === 'error') {
      const { code } = message.error;
      if (isTerminalSyncAuthorizationFailure(code)) {
        console.warn(
          `SyncEngineLevel: local sync authorization for ${controller.link.tenantDid} was revoked or expired — ` +
          'pausing link (reconnect to resume).',
        );
        await this.transitionToPaused(controller.linkKey, controller.link);
      } else {
        console.warn(
          `SyncEngineLevel: local push subscription error for ${controller.link.tenantDid}: ${code}`,
        );
        await this._linkRecoveryCoordinator.transitionToRepairing(controller);
      }
      return;
    }
    if (message.type !== 'event' && message.type !== 'reconnected') {
      return;
    }

    controller.executor.request('push');
    if (!controller.isReplicationReady) {
      return;
    }
    await this._linkRecoveryCoordinator.resume(controller);
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

      await this._quotaManager.clearBlock(target, failure.cid);
      await this.recordTerminalPushFailure(target, failure);
    }

    return retryableFailures;
  }

  private recordTerminalPushFailure(target: SyncTarget, failure: PushFailure): Promise<void> {
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
    const effectiveOptions = SyncEngineLevel.reconcileOptionsForTarget(target, options);
    if (effectiveOptions === 'skip') {
      return { aborted: true };
    }
    const link = await this.getOrCreateReplicationLink(target);
    const linkKey = buildLinkKey(target.did, target.dwnUrl, target.projectionId, target.authorizationEpoch);
    const controller = this.getLinkController(linkKey);
    if (controller?.isActive !== true) {
      return this.reconcileDurableTarget(target, link, effectiveOptions, shouldContinue);
    }

    if (controller.link.status === 'paused') {
      return { paused: true };
    }
    if (controller.link.status !== 'live' || !controller.isReplicationReady) {
      return { aborted: true };
    }

    const result = await this._linkRecoveryCoordinator.execute(
      controller,
      (): Promise<SyncReconcileResult> => {
        if (!controller.isActive || controller.link.status !== 'live' || !controller.isReplicationReady) {
          return Promise.resolve({ aborted: true });
        }
        return this.reconcileOwnedTarget(controller, target, effectiveOptions, shouldContinue);
      },
    );
    return result ?? { aborted: true };
  }

  /** Reconcile a link whose caller already owns the controller executor. */
  private async reconcileOwnedTarget(
    controller: SyncLinkController,
    target: SyncTarget,
    options?: SyncReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    const effectiveOptions = SyncEngineLevel.reconcileOptionsForTarget(target, options);
    if (effectiveOptions === 'skip') {
      return { aborted: true };
    }
    if (!controller.isActive) {
      return { aborted: true };
    }
    if (controller.link.status === 'paused') {
      return { paused: true };
    }
    const replicationGeneration = controller.replicationGeneration;
    const isCurrent = (): boolean =>
      controller.isReplicationGenerationCurrent(replicationGeneration) && (shouldContinue?.() ?? true);
    const includesPull = effectiveOptions?.direction !== 'push';
    if (includesPull) {
      this.markPullPending(controller);
    }

    const result = await this.reconcileDurableTarget(target, controller.link, effectiveOptions, isCurrent);
    // A repair reconciles before its cursorless subscriptions reopen. The
    // post-repair gap pass owns currentness because it covers writes between
    // that reconciliation head and transport attachment.
    if (
      includesPull &&
      controller.link.status === 'live' &&
      result.pullDrained === true &&
      isCurrent()
    ) {
      this.markPullCurrent(controller, replicationGeneration);
    }
    return result;
  }

  /** Apply role links' one-way pull policy at each engine reconciliation boundary. */
  private static reconcileOptionsForTarget(
    target: SyncTarget,
    options?: SyncReconcileOptions,
  ): SyncReconcileOptions | 'skip' | undefined {
    if (target.authorization.kind !== 'role') {
      return options;
    }
    return options?.direction === 'push'
      ? 'skip'
      : { ...options, direction: 'pull', verifyConvergence: false };
  }

  /** Run one already-policy-checked durable pass and park terminal role authority failures. */
  private async reconcileDurableTarget(
    target: SyncTarget,
    link: ReplicationLinkState,
    options?: SyncReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    try {
      return await this._durableFeedReconciler.reconcile(target, link, options, shouldContinue);
    } catch (error: unknown) {
      if (
        target.authorization.kind === 'role' &&
        SyncEngineLevel.isRoleLinkPauseError(error)
      ) {
        await this.pauseRoleLinkForError(target, link, error);
      }
      throw error;
    }
  }

  private static isRoleLinkPauseError(error: unknown): boolean {
    if (
      error instanceof FollowedSourceRoleRecordMismatchError ||
      error instanceof RoleFeedAdmissionError ||
      error instanceof RoleReplicationSupportError
    ) {
      return true;
    }
    const detail = syncErrorMessage(error);
    return SyncEngineLevel.isMissingRoleAuthorization(detail) || isTerminalSyncAuthorizationFailure(detail);
  }

  private static isMissingRoleAuthorization(detail: string): boolean {
    return detail.includes(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);
  }

  private verifyFeedConvergence(
    target: SyncTarget,
    shouldContinue?: () => boolean,
  ): Promise<SyncReconcileResult> {
    return this._durableFeedReconciler.verifyConvergence(target, shouldContinue);
  }

  /** Probe one active session through its link executor. */
  private async probeFeedConvergence(target: SyncTarget): Promise<SyncReconcileResult> {
    if (target.authorization.kind === 'role') {
      const result = await this.reconcileTarget(target);
      return result.pullDrained === true ? { ...result, converged: true } : result;
    }
    await this.getOrCreateReplicationLink(target);
    const linkKey = buildLinkKey(target.did, target.dwnUrl, target.projectionId, target.authorizationEpoch);
    const controller = this.getLinkController(linkKey);
    if (controller?.isActive !== true) {
      return this.verifyFeedConvergence(target);
    }
    if (controller.link.status === 'paused') {
      return { paused: true };
    }
    if (controller.link.status !== 'live' || !controller.isReplicationReady) {
      return { aborted: true };
    }

    const result = await this._linkRecoveryCoordinator.execute(controller, async (): Promise<SyncReconcileResult> => {
      // Re-check when this executor turn starts. A pre-executor status claim
      // can become stale while earlier work runs.
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
      return this.verifyFeedConvergence(target, isCurrent);
    });
    return result ?? { aborted: true };
  }

  private async queryDurableFeed({
    cidsOnly,
    cursor,
    limit,
    source,
    target,
  }: SyncDurableFeedQuery): Promise<MessagesQueryReply> {
    const currentTarget = await this.targetResolver.withCurrentRoleGrant(target);
    const roleAuthorization = currentTarget.authorization.kind === 'role'
      ? currentTarget.authorization
      : undefined;
    const params = {
      did                : currentTarget.did,
      authorDid          : roleAuthorization?.actorDid,
      delegateDid        : currentTarget.delegateDid,
      delegatedGrant     : currentTarget.authorDelegatedGrant,
      permissionGrantIds : currentTarget.permissionGrantIds,
      protocolRole       : roleAuthorization?.protocolRole,
      filters            : messageFeedFiltersForSyncScope(currentTarget.scope),
      cursor,
      cidsOnly,
      limit,
      agent              : this.agent,
    };

    const reply = source === 'local'
      ? queryLocalMessageFeed(params)
      : queryRemoteMessageFeed({ ...params, dwnUrl: currentTarget.dwnUrl });
    const result = await reply;
    if (result.status.code === 200) {
      SyncEngineLevel.assertRoleRecordId(currentTarget, result.roleRecordId);
    }
    return result;
  }

  private static assertRoleRecordId(target: SyncTarget, roleRecordId: string | undefined): void {
    if (
      target.authorization.kind === 'role' &&
      roleRecordId !== target.authorization.roleRecordId
    ) {
      throw new FollowedSourceRoleRecordMismatchError(target.authorization.roleRecordId, roleRecordId);
    }
  }

  private async bootstrapRemotePermissionGrants(
    target: SyncTarget,
    shouldContinue?: () => boolean,
    forceQuotaProbe = false,
  ): Promise<PermissionGrantBootstrapResult> {
    if (target.permissionGrantIds === undefined) {
      return { kind: 'processed', failures: [], quotaBlocked: false };
    }

    const grantEntries = await this.localPermissionGrantBootstrapEntries(target, shouldContinue);
    if (grantEntries === undefined) {
      return { kind: 'aborted' };
    }
    if (grantEntries.failures.length > 0 || grantEntries.entries.length === 0) {
      return { kind: 'processed', failures: grantEntries.failures, quotaBlocked: false };
    }

    for (const entry of grantEntries.entries) {
      const messageCid = await Message.getCid(entry.message);
      const state = await this._quotaManager.getState(target, messageCid);
      if (state?.source !== 'permission-grant') { continue; }
      const nextProbeAt = Date.parse(state.nextProbeAt);
      if (!forceQuotaProbe && Number.isFinite(nextProbeAt) && Date.now() < nextProbeAt) {
        return { kind: 'processed', failures: [], quotaBlocked: true };
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
    const outcome = await this._quotaManager.applyPushResult(target, result, { source: 'permission-grant' });
    return {
      kind         : 'processed',
      failures     : [...outcome.retryableFailures, ...outcome.terminalFailures],
      quotaBlocked : outcome.quotaBlocked,
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

  private async pushLocalFeedPage(
    target: SyncTarget,
    entries: MessagesQueryReplyEntry[],
    shouldContinue?: () => boolean,
  ): Promise<FeedPushResult> {
    for (const entry of entries) {
      if (SyncEngineLevel.shouldAbortReconcile(shouldContinue)) {
        return { kind: 'aborted' };
      }

      const result = await this.pushLocalFeedEntry(target, entry, shouldContinue);
      if (result.kind === 'aborted') {
        return { kind: 'aborted' };
      }
      if (result.kind === 'failed') {
        return { kind: 'failed', failures: result.failures };
      }
    }

    return { kind: 'processed' };
  }

  private async pushLocalFeedEntry(
    target: SyncTarget,
    entry: MessagesQueryReplyEntry,
    shouldContinue?: () => boolean,
  ): Promise<FeedPushResult> {
    if (await this.hasDeadLetter(target.did, target.dwnUrl, entry.messageCid)) {
      return { kind: 'processed' };
    }

    // Every durable quota block is skipped in the ordinary feed. Due probes
    // are driven independently at the start of target push, because this feed
    // checkpoint is allowed to advance past the omitted CID.
    if (await this._quotaManager.getState(target, entry.messageCid) !== undefined) {
      return { kind: 'processed' };
    }

    if (this._echoSuppressor.hasRecentlyPulled(target.did, entry.messageCid, target.dwnUrl)) {
      return { kind: 'processed' };
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
    const outcome = await this._quotaManager.applyPushResult(target, attributedResult, {
      protocol : entry.protocol,
      source   : 'feed',
    });

    if (attributedResult.failed.length === 0) {
      return { kind: 'processed' };
    }

    if (outcome.retryableFailures.length === 0) {
      return { kind: 'processed' };
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
    const dataBlocks = (await this._quotaManager.getActiveBlocksForTarget(target))
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
   * page continues for ordinary links, so a single permanently unresolvable
   * message cannot wedge the link forever. Role links retain deferred work
   * because pull drainage is their only currentness proof and the dependency
   * may become available later.
   */
  private async admitRemoteFeedPage(
    target: SyncTarget,
    entries: MessagesQueryReplyEntry[],
    shouldContinue?: () => boolean,
  ): Promise<FeedPageAdmissionResult> {
    const admittedCids: string[] = [];

    for (const entry of entries) {
      if (target.authorization.kind !== 'role' &&
          await this.hasDeadLetter(target.did, target.dwnUrl, entry.messageCid)) {
        continue;
      }

      const outcome = await this.admitRemoteFeedEntry(target, entry, shouldContinue);
      if (outcome.kind === 'aborted') {
        return { kind: 'aborted' };
      }

      if (outcome.kind === 'deferred') {
        if (!await this.tryRetireDeferredPull(target, entry, outcome.detail)) {
          return { kind: 'deferred', admittedCids, detail: outcome.detail, messageCid: entry.messageCid };
        }
        continue;
      }
      if (outcome.kind === 'echo') {
        continue;
      }
      if (outcome.kind === 'dead-lettered') {
        continue;
      }

      if (outcome.kind === 'admitted') {
        admittedCids.push(...outcome.appliedCids);
        await this.trackRemoteFeedAppliedCids(outcome.appliedCids, target);
        for (const freshEntry of outcome.freshEntries) {
          this.emitDeliveryApplied(target, freshEntry.messageCid, freshEntry.message);
        }
      }
    }

    return { kind: 'processed', admittedCids };
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
      await this._quotaManager.resolveBlocksSupersededByAcknowledgement(target, cid);
    }
  }

  /**
   * Retire a deferred pull entry if it can no longer make progress.
   *
   * @returns `true` when the caller should SKIP this entry and continue the
   *   page — either because an ordinary link aged past
   *   {@link DEFERRED_PULL_DEAD_LETTER_AFTER_MS} and was dead-lettered, or
   *   because the tenant was unregistered underneath us (in which case
   *   nothing is dead-lettered and the deferred work is simply abandoned).
   *   `false` means the page must stop on it. Role-feed entries remain
   *   deferred regardless of age because they cannot be skipped safely.
   */
  private async tryRetireDeferredPull(
    target: SyncTarget,
    entry: MessagesQueryReplyEntry,
    detail: string | undefined,
  ): Promise<boolean> {
    return this.runDeferredPullLifecycle(target.did, async (): Promise<boolean> => {
      // Foreign role sources are registered independently from owned/delegated
      // identities. Fence each kind against the registration that owns it.
      const isCurrent = target.authorization.kind === 'role'
        ? await this.isFollowedTargetCurrent(target)
        : await this.getIdentityOptions(target.did) !== undefined;
      if (!isCurrent) {
        return true;
      }

      const state = await this.recordDeferredPull(target, entry.messageCid, detail);
      if (target.authorization.kind === 'role') {
        return false;
      }
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
  private async runIdentityLifecycle<T>(
    did: string,
    operation: (deadline?: SyncLifecycleDeadline) => Promise<T>,
    deadline?: SyncLifecycleDeadline,
  ): Promise<T> {
    const lockName = `enbox:sync-identity:${this._lockNamespace}:${did}`;
    if (deadline === undefined) {
      return runWithCrossContextLock(lockName, (): Promise<T> => operation());
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = (): Error => new Error(
      `SyncEngineLevel: Existing cross-context identity mutation did not complete within ${deadline.timeout} milliseconds.`,
    );
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout((): void => {
        cancelled = true;
        reject(timeoutError());
      }, remainingSyncLifecycleTimeout(deadline));
    });
    const locked = runWithCrossContextLock<T>(
      lockName,
      async (): Promise<T> => {
        if (cancelled) {
          throw timeoutError();
        }
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        return operation(deadline);
      },
    );

    try {
      return await Promise.race([locked, timedOut]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
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

  private getLocalMessageForTarget(target: SyncTarget, messageCid: string): Promise<SyncMessageEntry | undefined> {
    return getLocalMessage({
      author             : target.did,
      delegateDid        : target.delegateDid,
      permissionGrantIds : target.permissionGrantIds,
      messageCid,
      agent              : this.agent,
    });
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

    // A role link only needs the retained current version. Its support closure
    // carries the record's initial write and ancestors, while retained
    // non-latest writes are deliberately dataless.
    if (
      target.authorization.kind === 'role' &&
      entry.isLatestBaseState === false &&
      entry.message !== undefined &&
      Records.isRecordsWrite(entry.message)
    ) {
      return { kind: 'echo' };
    }

    if (await this.hasDurableLocalPullEcho(target, entry)) {
      return { kind: 'echo' };
    }

    const prefetched = await this.syncEntriesFromFeedEntry(target, entry);
    const fetchReplicationSupport = target.authorization.kind === 'role'
      ? (root: SyncMessageEntry): Promise<{ dependencies: SyncMessageEntry[]; root: SyncMessageEntry }> =>
        this.readRoleReplicationSupport(target, root, entry.initialWrite, shouldContinue)
      : undefined;
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
      fetchReplicationSupport,
      shouldContinue,
    });

    if (outcome.kind === 'admitted') {
      return { kind: 'admitted', appliedCids: outcome.appliedCids, freshEntries: outcome.freshEntries };
    }

    if (outcome.kind === 'deferred') {
      return { kind: 'deferred', detail: outcome.detail };
    }

    if (target.authorization.kind === 'role') {
      throw new RoleFeedAdmissionError(entry.messageCid);
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
      if (target.authorization.kind === 'role') {
        throw new Error(`SyncEngineLevel: role feed entry '${entry.messageCid}' did not include its message.`);
      }
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
    const entries: SyncMessageEntry[] = entry.initialWrite === undefined
      ? []
      : [{ message: entry.initialWrite, isLatestBaseState: false }];
    const syncEntry: SyncMessageEntry = {
      message,
      isLatestBaseState: entry.isLatestBaseState,
    };
    const encodedData = entry.encodedData;
    if (encodedData !== undefined) {
      syncEntry.bufferedData = Encoder.base64UrlToBytes(encodedData);
    } else if (
      target.authorization.kind !== 'role' &&
      SyncEngineLevel.recordsWriteRequiresRemoteData(message)
    ) {
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

    entries.push(syncEntry);
    return entries;
  }

  /** Read one missing role root/data/key closure from the same endpoint as its feed. */
  private async readRoleReplicationSupport(
    target: SyncTarget,
    root: SyncMessageEntry,
    initialWrite: RecordsWriteMessage | undefined,
    shouldContinue?: () => boolean,
  ): Promise<{ dependencies: SyncMessageEntry[]; root: SyncMessageEntry }> {
    const role = target.authorization.kind === 'role' ? target.authorization : undefined;
    const scope = target.scope.kind === 'context' ? target.scope : undefined;
    const message = root.message;
    const isWrite = Records.isRecordsWrite(message);
    const isDelete = message.descriptor.interface === DwnInterfaceName.Records &&
      message.descriptor.method === DwnMethodName.Delete;
    if (
      role === undefined ||
      scope === undefined ||
      (!isWrite && !isDelete)
    ) {
      const descriptor = message.descriptor as GenericMessage['descriptor'] & { protocolPath?: string; recordId?: string };
      throw new Error(
        `SyncEngineLevel: role replication support requires a contextual record mutation; received ${descriptor.interface}/${descriptor.method} at '${descriptor.protocolPath ?? 'unknown'}' (${descriptor.recordId ?? 'unknown'}).`,
      );
    }

    const rootRecordId = isWrite
      ? message.recordId
      : (message.descriptor as RecordsDeleteMessage['descriptor']).recordId;
    const contextualWrite = isWrite
      ? message
      : initialWrite;
    if (contextualWrite === undefined || !Records.isRecordsWrite(contextualWrite) ||
      contextualWrite.recordId !== rootRecordId) {
      throw new Error('SyncEngineLevel: role replication support requires the deleted record initial write.');
    }
    const recordsWrite = contextualWrite as GenericMessage & {
      contextId?: string;
      recordId?: string;
      descriptor: GenericMessage['descriptor'] & { protocol?: string; protocolPath?: string };
    };
    const { contextId, recordId } = recordsWrite;
    const { protocol, protocolPath } = recordsWrite.descriptor;
    if (
      contextId === undefined ||
      recordId === undefined ||
      protocol !== scope.protocol ||
      protocolPath === undefined
    ) {
      throw new Error('SyncEngineLevel: role feed root does not identify an exact record in its followed protocol.');
    }

    const batch = await readRoleReplicationSupport({
      actorDid       : role.actorDid,
      agent          : this.agent,
      contextId,
      delegateDid    : target.delegateDid,
      dwnUrl         : target.dwnUrl,
      expectedRoot   : message as RecordsDeleteMessage | RecordsWriteMessage,
      permissionsApi : this._permissionsApi,
      protocol,
      protocolPath,
      protocolRole   : role.protocolRole,
      rootData       : root.bufferedData,
      shouldContinue,
      sourceDid      : target.did,
    });
    SyncEngineLevel.assertRoleRecordId(target, batch.roleRecordId);
    return {
      dependencies : batch.dependencies,
      root         : { ...batch.root, isLatestBaseState: root.isLatestBaseState },
    };
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
      const blocks = await this._quotaManager.getActiveBlocksForTarget(target);
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

  private async getCurrentLinkIdentityKeys(): Promise<Set<string> | undefined> {
    try {
      const identityKeys = new Set<string>();
      await this.addCurrentRegisteredIdentityKeys(identityKeys);
      await this.addCurrentFollowedSourceKeys(identityKeys);
      return identityKeys;
    } catch (error: unknown) {
      console.warn('SyncEngineLevel: Failed to resolve current link identities for health; excluding unproven role links', error);
      return undefined;
    }
  }

  private async addCurrentRegisteredIdentityKeys(identityKeys: Set<string>): Promise<void> {
    for await (const entry of this._identityStore.entries()) {
      if (entry.status === 'corrupt') {
        console.warn(`SyncEngineLevel: Corrupt sync options for ${entry.did}, skipping health target:`, entry.error);
        continue;
      }

      try {
        const scope = syncScopeFromProtocols(entry.options.protocols);
        const resolutions = await this.targetResolver.buildTargetResolutions(entry.did, scope, entry.options);
        for (const resolution of resolutions) {
          const projectionId = await computeProjectionId(entry.did, resolution.scope);
          identityKeys.add(buildDurableLinkIdentityKey(entry.did, projectionId, resolution.authorizationEpoch));
        }
      } catch (error: unknown) {
        console.warn(
          `SyncEngineLevel: Failed to resolve current link identities for ${entry.did}; retaining its durable links`,
          error,
        );
        for (const link of await this.replicationLinkStore.getLinksForTenant(entry.did)) {
          if (link.authorization.kind !== 'role') {
            identityKeys.add(this.getDurableLinkIdentityKey(link));
          }
        }
      }
    }
  }

  private async addCurrentFollowedSourceKeys(identityKeys: Set<string>): Promise<void> {
    for (const entry of await this._followedSourceStore.list()) {
      if (entry.status === 'corrupt') {
        console.warn(`SyncEngineLevel: Corrupt followed source ${entry.id}, skipping health target:`, entry.error);
        continue;
      }
      try {
        for (const target of await this.targetResolver.buildTargetsForSource(entry.source)) {
          identityKeys.add(buildCurrentLinkIdentityKey(
            target.did,
            target.dwnUrl,
            target.projectionId,
            target.authorizationEpoch,
            target.authorization.kind,
          ));
        }
      } catch (error: unknown) {
        console.warn(
          `SyncEngineLevel: Failed to resolve current endpoints for followed source ${entry.source.id}; excluding its role links`,
          error,
        );
      }
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
        this._quotaManager.pruneStaleLinkBlocks(
          targets,
          (): boolean => this._targetPlanner.topologyGeneration === topologyGeneration,
        ),
    });
  }

}
