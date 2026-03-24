import type { AbstractLevel } from 'abstract-level';

import type { DwnSubscriptionHandler, ResubscribeFactory } from '@enbox/dwn-clients';
import type { GenericMessage, MessageEvent, MessagesSubscribeReply, MessagesSyncDiffEntry, MessagesSyncReply, ProgressToken, StateIndex, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import ms from 'ms';

import { Level } from 'level';
import { Encoder, hashToHex, initDefaultHashes, Message } from '@enbox/dwn-sdk-js';

import type { ClosureEvaluationContext } from './sync-closure-types.js';
import type { PermissionsApi } from './types/permissions.js';
import type { EnboxAgent, EnboxPlatformAgent } from './types/agent.js';
import type { PushResult, ReplicationLinkState, StartSyncParams, SyncConnectivityState, SyncEngine, SyncIdentityOptions, SyncMode } from './types/sync.js';

import { createClosureContext } from './sync-closure-types.js';
import { evaluateClosure } from './sync-closure-resolver.js';
import { MAX_PENDING_TOKENS } from './types/sync.js';
import { ReplicationLedger } from './sync-replication-ledger.js';

import { AgentPermissionsApi } from './permissions-api.js';
import { DwnInterface } from './types/dwn.js';
import { isRecordsWrite } from './utils.js';
import { topologicalSort } from './sync-topological-sort.js';
import { fetchRemoteMessages, pullMessages, pushMessages } from './sync-messages.js';

export type SyncEngineLevelParams = {
  agent?: EnboxPlatformAgent;
  dataPath?: string;
  db?: AbstractLevel<string | Buffer | Uint8Array>;
};

/**
 * Maximum bit prefix depth for the per-node tree walk (legacy fallback).
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
/**
 * Key for the subscription cursor sublevel. Cursors are keyed by
 * `{did}^{dwnUrl}[^{protocol}]` and store an opaque EventLog cursor string.
 */
const CURSOR_SEPARATOR = '^';

/**
 * Debounce window for push-on-write. When the local EventLog emits events,
 * we batch them and push after this delay to avoid a push per individual write.
 */
const PUSH_DEBOUNCE_MS = 250;

/** Tracks a live subscription to a remote DWN for one sync target. */
type LiveSubscription = {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  protocol?: string;
  close: () => Promise<void>;
};

/** Tracks a local EventLog subscription for push-on-write. */
type LocalSubscription = {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  protocol?: string;
  close: () => Promise<void>;
};

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

  private _db: AbstractLevel<string | Buffer | Uint8Array>;
  private _syncIntervalId?: ReturnType<typeof setInterval>;
  private _syncLock = false;

  /**
   * Durable replication ledger — persists per-link checkpoint state.
   * Used by live sync to track pull/push progression independently per link.
   * Poll-mode sync still uses the legacy `getCursor`/`setCursor` path.
   * Lazily initialized on first use to avoid sublevel() calls on mock dbs.
   */
  private _ledger?: ReplicationLedger;

  /**
   * In-memory cache of active links, keyed by `{did}^{dwnUrl}^{protocol}`.
   * Populated from the ledger on `startLiveSync`, used by subscription handlers
   * to avoid async ledger lookups on every event.
   */
  private _activeLinks: Map<string, ReplicationLinkState> = new Map();

  /**
   * Per-link in-memory delivery-order tracking for the pull path. Keyed by
   * the same link key as `_activeLinks`. Not persisted — on crash, replay
   * restarts from `contiguousAppliedToken` and idempotent apply handles
   * re-delivered events.
   */
  private _linkRuntimes: Map<string, LinkRuntimeState> = new Map();

  /**
   * Hex-encoded default hashes for empty subtrees at each depth, keyed by depth.
   * Lazily initialized on first use. Used by `walkTreeDiff` to detect empty subtrees
   * and short-circuit the recursive walk instead of descending all the way to MAX_DIFF_DEPTH.
   */
  private _defaultHashHex?: Map<number, string>;

  // ---------------------------------------------------------------------------
  // Live sync state
  // ---------------------------------------------------------------------------

  /** Current sync mode, set by `startSync`. */
  private _syncMode: SyncMode = 'poll';

  /**
   * Monotonic session generation counter. Incremented on every teardown.
   * Async operations (repair, retry timers) capture the generation at start
   * and bail if it has changed — this prevents stale work from mutating
   * state after teardown or mode switch.
   */
  private _syncGeneration = 0;

  /** Active live pull subscriptions (remote -> local via MessagesSubscribe). */
  private _liveSubscriptions: LiveSubscription[] = [];

  /** Active local EventLog subscriptions for push-on-write (local -> remote). */
  private _localSubscriptions: LocalSubscription[] = [];

  /** Connectivity state derived from subscription health. */
  private _connectivityState: SyncConnectivityState = 'unknown';

  /** Debounce timer for batched push-on-write. */
  private _pushDebounceTimer?: ReturnType<typeof setTimeout>;

  /** Entry in the pending push queue — a message CID with its local EventLog token. */
  private _pendingPushCids: Map<string, {
    did: string; dwnUrl: string; delegateDid?: string; protocol?: string;
    entries: { cid: string; localToken?: ProgressToken }[];
  }> = new Map();

  /**
   * CIDs recently received via pull subscription, keyed by `cid|dwnUrl` to
   * scope suppression per remote endpoint. A message pulled from Provider A
   * is only suppressed for push back to Provider A — it still fans out to
   * Provider B and C. TTL: 60 seconds. Cap: 10,000 entries.
   */
  private _recentlyPulledCids: Map<string, number> = new Map();

  /** TTL for echo-loop suppression entries (60 seconds). */
  private static readonly ECHO_SUPPRESS_TTL_MS = 60_000;

  /**
   * Per-tenant closure evaluation contexts for the current live sync session.
   * Caches ProtocolsConfigure and grant lookups across events for the same
   * tenant. Keyed by tenantDid to prevent cross-tenant cache pollution.
   */
  private _closureContexts: Map<string, ClosureEvaluationContext> = new Map();

  /** Maximum entries in the echo-loop suppression cache. */
  private static readonly ECHO_SUPPRESS_MAX_ENTRIES = 10_000;

  /** Count of consecutive SMT sync failures (for backoff in poll mode). */
  private _consecutiveFailures = 0;

  /** Maximum consecutive failures before entering backoff. */
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;

  /** Backoff multiplier for consecutive failures (caps at 4x the configured interval). */
  private static readonly MAX_BACKOFF_MULTIPLIER = 4;

  constructor({ agent, dataPath, db }: SyncEngineLevelParams) {
    this._agent = agent;
    this._permissionsApi = new AgentPermissionsApi({ agent: agent as EnboxAgent });
    this._db = (db) ? db : new Level<string, string>(dataPath ?? 'DATA/AGENT/SYNC_STORE');
  }

  /** Lazy accessor for the replication ledger. */
  private get ledger(): ReplicationLedger {
    if (!this._ledger) {
      this._ledger = new ReplicationLedger(this._db);
    }
    return this._ledger;
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
    this._permissionsApi = new AgentPermissionsApi({ agent: agent as EnboxAgent });
  }

  get connectivityState(): SyncConnectivityState {
    return this._connectivityState;
  }

  public async clear(): Promise<void> {
    await this._permissionsApi.clear();
    await this._db.clear();
  }

  public async close(): Promise<void> {
    await this._db.close();
  }

  public async registerIdentity({ did, options }: { did: string; options?: SyncIdentityOptions }): Promise<void> {
    const registeredIdentities = this._db.sublevel('registeredIdentities');

    const existing = await this.getIdentityOptions(did);
    if (existing) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is already registered.`);
    }

    // if no options are provided, we default to no delegateDid and all protocols (empty array)
    options ??= { protocols: [] };

    await registeredIdentities.put(did, JSON.stringify(options));
  }

  public async unregisterIdentity(did: string): Promise<void> {
    const registeredIdentities = this._db.sublevel('registeredIdentities');
    const existing = await this.getIdentityOptions(did);
    if (!existing) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
    }

    await registeredIdentities.del(did);
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
    const registeredIdentities = this._db.sublevel('registeredIdentities');
    const existingOptions = await this.getIdentityOptions(did);
    if (!existingOptions) {
      throw new Error(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
    }

    await registeredIdentities.put(did, JSON.stringify(options));
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
      // Iterate over all registered identities and their DWN endpoints.
      const syncTargets = await this.getSyncTargets();
      const errored = new Set<string>();
      let hadFailure = false;

      for (const target of syncTargets) {
        const { did, delegateDid, dwnUrl, protocol } = target;

        if (errored.has(dwnUrl)) {
          continue;
        }

        try {
          // Phase 1: Compare SMT roots between local and remote.
          const localRoot = await this.getLocalRoot(did, delegateDid, protocol);
          const remoteRoot = await this.getRemoteRoot(did, dwnUrl, delegateDid, protocol);

          if (localRoot === remoteRoot) {
            // Trees are identical — nothing to sync for this target.
            continue;
          }

          // Phase 2: Compute the diff in a single round-trip using the
          // batched 'diff' action.  This replaces the per-node tree walk
          // that previously required dozens of HTTP requests.
          const diff = await this.diffWithRemote({
            did, dwnUrl, delegateDid, protocol,
          });

          // Phase 3: Pull missing messages (remote has, local doesn't).
          // The diff response may include inline message data — use it
          // directly instead of re-fetching via individual MessagesRead calls.
          if (!direction || direction === 'pull') {
            if (diff.onlyRemote.length > 0) {
              // Separate entries into three categories:
              // 1. Fully prefetched: have message + inline data (or no data needed)
              // 2. Need data fetch: have message but missing data for RecordsWrite
              // 3. Need full fetch: no message at all
              const prefetched: (MessagesSyncDiffEntry & { message: GenericMessage })[] = [];
              const needsFetchCids: string[] = [];

              for (const entry of diff.onlyRemote) {
                if (!entry.message) {
                  // No message at all — need full fetch.
                  needsFetchCids.push(entry.messageCid);
                } else if (
                  entry.message.descriptor.interface === 'Records' &&
                  entry.message.descriptor.method === 'Write' &&
                  (entry.message.descriptor as any).dataCid &&
                  !entry.encodedData
                ) {
                  // RecordsWrite with data but data wasn't inlined (too large).
                  // Need to fetch individually to get the data stream.
                  needsFetchCids.push(entry.messageCid);
                } else {
                  // Fully prefetched (message + data or no data needed).
                  prefetched.push(entry as MessagesSyncDiffEntry & { message: GenericMessage });
                }
              }
              await this.pullMessages({
                did, dwnUrl, delegateDid, protocol,
                messageCids: needsFetchCids,
                prefetched,
              });
            }
          }

          // Phase 4: Push missing messages (local has, remote doesn't).
          if (!direction || direction === 'push') {
            if (diff.onlyLocal.length > 0) {
              await this.pushMessages({ did, dwnUrl, delegateDid, protocol, messageCids: diff.onlyLocal });
            }
          }
        } catch (error: any) {
          // Skip this DWN endpoint for remaining targets and log the real cause.
          errored.add(dwnUrl);
          hadFailure = true;
          console.error(`SyncEngineLevel: Error syncing ${did} with ${dwnUrl}`, error);
        }
      }

      // Track consecutive failures for backoff in poll mode.
      if (hadFailure) {
        this._consecutiveFailures++;
        if (this._connectivityState === 'online') {
          this._connectivityState = 'offline';
        }
      } else {
        this._consecutiveFailures = 0;
        if (syncTargets.length > 0) {
          this._connectivityState = 'online';
        }
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
   */
  public async stopSync(timeout: number = 2000): Promise<void> {
    let elapsedTimeout = 0;

    while (this._syncLock) {
      if (elapsedTimeout >= timeout) {
        throw new Error(`SyncEngineLevel: Existing sync operation did not complete within ${timeout} milliseconds.`);
      }

      elapsedTimeout += 100;
      await new Promise((resolve): void => { setTimeout(resolve, timeout < 100 ? timeout : 100); });
    }

    if (this._syncIntervalId) {
      clearInterval(this._syncIntervalId);
      this._syncIntervalId = undefined;
    }

    await this.teardownLiveSync();
  }

  // ---------------------------------------------------------------------------
  // Poll-mode sync (legacy)
  // ---------------------------------------------------------------------------

  private async startPollSync(intervalMilliseconds: number): Promise<void> {
    const intervalSync = async (): Promise<void> => {
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
    // Step 1: Initial SMT catch-up.
    try {
      await this.sync();
    } catch (error) {
      console.error('SyncEngineLevel: Error during initial live-sync catch-up', error);
    }

    // Step 2: Initialize replication links and open live subscriptions.
    const syncTargets = await this.getSyncTargets();
    for (const target of syncTargets) {
      let link: ReplicationLinkState | undefined;
      try {
        // Get or create the link in the durable ledger.
        link = await this.ledger.getOrCreateLink({
          tenantDid      : target.did,
          remoteEndpoint : target.dwnUrl,
          scope          : { kind: 'full' },
          delegateDid    : target.delegateDid,
          protocol       : target.protocol,
        });

        // Cache the link for fast access by subscription handlers.
        const linkKey = this.buildCursorKey(target.did, target.dwnUrl, target.protocol);
        this._activeLinks.set(linkKey, link);

        // Open subscriptions — only transition to live if both succeed.
        // If pull succeeds but push fails, close the pull subscription to
        // avoid a resource leak with inconsistent state.
        await this.openLivePullSubscription(target);
        try {
          await this.openLocalPushSubscription(target);
        } catch (pushError) {
          // Close the already-opened pull subscription.
          const pullSub = this._liveSubscriptions.find(
            s => s.did === target.did && s.dwnUrl === target.dwnUrl && s.protocol === target.protocol
          );
          if (pullSub) {
            try { await pullSub.close(); } catch { /* best effort */ }
            this._liveSubscriptions = this._liveSubscriptions.filter(s => s !== pullSub);
          }
          throw pushError;
        }

        await this.ledger.setStatus(link!, 'live');
      } catch (error: any) {
        const linkKey = this.buildCursorKey(target.did, target.dwnUrl, target.protocol);

        // Detect ProgressGap (410) — the cursor is stale, link needs SMT repair.
        if ((error as any).isProgressGap && link) {
          console.warn(`SyncEngineLevel: ProgressGap detected for ${target.did} -> ${target.dwnUrl}, initiating repair`);
          const gapInfo = (error as any).gapInfo;
          await this.transitionToRepairing(linkKey, link, {
            resumeToken: gapInfo?.latestAvailable,
          });
          continue;
        }

        console.error(`SyncEngineLevel: Failed to open live subscription for ${target.did} -> ${target.dwnUrl}`, error);

        // Clean up in-memory state for the failed link so it doesn't appear
        // active to later code. The durable link remains at 'initializing'.
        this._activeLinks.delete(linkKey);
        this._linkRuntimes.delete(linkKey);

        // Recompute connectivity — if no live subscriptions remain, reset to unknown.
        if (this._liveSubscriptions.length === 0) {
          this._connectivityState = 'unknown';
        }
      }
    }

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
      if (!entry || !entry.committed) { break; }

      // This ordinal is committed — advance the durable checkpoint.
      ReplicationLedger.commitContiguousToken(link.pull, entry.token);
      ReplicationLedger.setReceivedToken(link.pull, entry.token);
      rt.inflight.delete(rt.nextCommitOrdinal);
      rt.nextCommitOrdinal++;
      drained++;
    }

    return drained;
  }

  // ---------------------------------------------------------------------------
  // Per-link repair and degraded-poll orchestration (Phase 2)
  // ---------------------------------------------------------------------------

  /** Maximum consecutive repair attempts before falling back to degraded_poll. */
  private static readonly MAX_REPAIR_ATTEMPTS = 3;

  /** Per-link degraded-poll interval timers. */
  private _degradedPollTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  /** Per-link repair attempt counters. */
  private _repairAttempts: Map<string, number> = new Map();

  /** Per-link active repair promises — prevents concurrent repair for the same link. */
  private _activeRepairs: Map<string, Promise<void>> = new Map();

  /** Per-link retry timers for failed repairs below max attempts. */
  private _repairRetryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Backoff schedule for repair retries (milliseconds). */
  private static readonly REPAIR_BACKOFF_MS = [1_000, 3_000, 10_000];

  /**
   * Per-link repair context — stores ProgressGap metadata for use during
   * repair. The `resumeToken` (from `gapInfo.latestAvailable`) is used as
   * the post-repair checkpoint so the reopened subscription replays from
   * a valid boundary instead of starting live-only.
   */
  private _repairContext: Map<string, { resumeToken?: ProgressToken }> = new Map();

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
    await this.ledger.setStatus(link, 'repairing');

    if (options?.resumeToken) {
      this._repairContext.set(linkKey, { resumeToken: options.resumeToken });
    }

    // Clear runtime ordinals immediately — stale state must not linger
    // across repair attempts.
    const rt = this._linkRuntimes.get(linkKey);
    if (rt) {
      rt.inflight.clear();
      rt.nextCommitOrdinal = rt.nextDeliveryOrdinal;
    }

    // Kick off repair with retry scheduling on failure.
    void this.repairLink(linkKey).catch(() => {
      this.scheduleRepairRetry(linkKey);
    });
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

    const timerGeneration = this._syncGeneration;
    const timer = setTimeout(async (): Promise<void> => {
      this._repairRetryTimers.delete(linkKey);

      // Bail if teardown occurred since this timer was scheduled.
      if (this._syncGeneration !== timerGeneration) { return; }

      // Verify link still exists and is still repairing.
      const currentLink = this._activeLinks.get(linkKey);
      if (!currentLink || currentLink.status !== 'repairing') { return; }

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
    const generation = this._syncGeneration;

    const { tenantDid: did, remoteEndpoint: dwnUrl, delegateDid, protocol } = link;
    const attempts = (this._repairAttempts.get(linkKey) ?? 0) + 1;
    this._repairAttempts.set(linkKey, attempts);

    // Step 1: Close existing subscriptions FIRST to stop old events from
    // mutating local state while repair runs.
    await this.closeLinkSubscriptions(link);
    if (this._syncGeneration !== generation) { return; } // Teardown occurred.

    // Step 2: Clear runtime ordinals immediately — stale state must not
    // persist across repair attempts (successful or failed).
    const rt = this.getOrCreateRuntime(linkKey);
    rt.inflight.clear();
    rt.nextDeliveryOrdinal = 0;
    rt.nextCommitOrdinal = 0;

    try {
      // Step 3: Run SMT reconciliation for this link.
      const localRoot = await this.getLocalRoot(did, delegateDid, protocol);
      if (this._syncGeneration !== generation) { return; }
      const remoteRoot = await this.getRemoteRoot(did, dwnUrl, delegateDid, protocol);
      if (this._syncGeneration !== generation) { return; }

      if (localRoot !== remoteRoot) {
        const diff = await this.diffWithRemote({ did, dwnUrl, delegateDid, protocol });
        if (this._syncGeneration !== generation) { return; }

        if (diff.onlyRemote.length > 0) {
          const prefetched: (MessagesSyncDiffEntry & { message: GenericMessage })[] = [];
          const needsFetchCids: string[] = [];
          for (const entry of diff.onlyRemote) {
            if (!entry.message || (entry.message.descriptor.interface === 'Records' &&
                entry.message.descriptor.method === 'Write' &&
                (entry.message.descriptor as any).dataCid && !entry.encodedData)) {
              needsFetchCids.push(entry.messageCid);
            } else {
              prefetched.push(entry as MessagesSyncDiffEntry & { message: GenericMessage });
            }
          }
          await this.pullMessages({ did, dwnUrl, delegateDid, protocol, messageCids: needsFetchCids, prefetched });
          if (this._syncGeneration !== generation) { return; }
        }

        if (diff.onlyLocal.length > 0) {
          await this.pushMessages({ did, dwnUrl, delegateDid, protocol, messageCids: diff.onlyLocal });
          if (this._syncGeneration !== generation) { return; }
        }
      }

      // Step 4: Determine the post-repair resume token.
      // - If repair was triggered by ProgressGap, use the stored resumeToken
      //   (from gapInfo.latestAvailable) so the reopened subscription replays
      //   from a valid boundary, closing the race window between SMT and resubscribe.
      // - Otherwise, use the existing contiguousAppliedToken if still valid.
      // - Push checkpoint is NOT reset during repair: push frontier tracks what
      //   the local EventLog has delivered to the remote. SMT repair handles
      //   pull-side convergence; push-side convergence is handled by the diff's
      //   onlyLocal push. The push checkpoint remains the local authority.
      const repairCtx = this._repairContext.get(linkKey);
      const resumeToken = repairCtx?.resumeToken ?? link.pull.contiguousAppliedToken;
      ReplicationLedger.resetCheckpoint(link.pull, resumeToken);
      await this.ledger.saveLink(link);
      if (this._syncGeneration !== generation) { return; }

      // Step 5: Reopen subscriptions with the repaired checkpoints.
      const target = { did, dwnUrl, delegateDid, protocol };
      await this.openLivePullSubscription(target);
      if (this._syncGeneration !== generation) { return; }
      try {
        await this.openLocalPushSubscription({
          ...target,
          pushCursor: link.push.contiguousAppliedToken,
        });
      } catch (pushError) {
        const pullSub = this._liveSubscriptions.find(
          s => s.did === did && s.dwnUrl === dwnUrl && s.protocol === protocol
        );
        if (pullSub) {
          try { await pullSub.close(); } catch { /* best effort */ }
          this._liveSubscriptions = this._liveSubscriptions.filter(s => s !== pullSub);
        }
        throw pushError;
      }
      if (this._syncGeneration !== generation) { return; }

      // Step 6: Clean up repair context and transition to live.
      this._repairContext.delete(linkKey);
      this._repairAttempts.delete(linkKey);
      const retryTimer = this._repairRetryTimers.get(linkKey);
      if (retryTimer) { clearTimeout(retryTimer); this._repairRetryTimers.delete(linkKey); }
      await this.ledger.setStatus(link, 'live');

    } catch (error: any) {
      // If teardown occurred during repair, don't retry or enter degraded_poll.
      if (this._syncGeneration !== generation) { return; }

      console.error(`SyncEngineLevel: Repair failed for ${did} -> ${dwnUrl} (attempt ${attempts})`, error);

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
    const { tenantDid: did, remoteEndpoint: dwnUrl, protocol } = link;

    // Close pull subscription.
    const pullSub = this._liveSubscriptions.find(
      s => s.did === did && s.dwnUrl === dwnUrl && s.protocol === protocol
    );
    if (pullSub) {
      try { await pullSub.close(); } catch { /* best effort */ }
      this._liveSubscriptions = this._liveSubscriptions.filter(s => s !== pullSub);
    }

    // Close local push subscription.
    const pushSub = this._localSubscriptions.find(
      s => s.did === did && s.dwnUrl === dwnUrl && s.protocol === protocol
    );
    if (pushSub) {
      try { await pushSub.close(); } catch { /* best effort */ }
      this._localSubscriptions = this._localSubscriptions.filter(s => s !== pushSub);
    }
  }

  /**
   * Transition a link to `degraded_poll` and start a per-link polling timer.
   * The timer runs SMT reconciliation at a reduced frequency (30s with jitter)
   * and attempts to re-establish live subscriptions after each successful repair.
   */
  private async enterDegradedPoll(linkKey: string): Promise<void> {
    const link = this._activeLinks.get(linkKey);
    if (!link) { return; }

    await this.ledger.setStatus(link, 'degraded_poll');
    this._repairAttempts.delete(linkKey);

    // Clear any existing timer for this link.
    const existing = this._degradedPollTimers.get(linkKey);
    if (existing) { clearInterval(existing); }

    // Schedule per-link polling with jitter (15-30 seconds).
    const baseInterval = 15_000;
    const jitter = Math.floor(Math.random() * 15_000);
    const interval = baseInterval + jitter;

    const pollGeneration = this._syncGeneration;
    const timer = setInterval(async (): Promise<void> => {
      // Bail if teardown occurred since this timer was created.
      if (this._syncGeneration !== pollGeneration) {
        clearInterval(timer);
        this._degradedPollTimers.delete(linkKey);
        return;
      }

      // If the link was transitioned out of degraded_poll externally (e.g.,
      // by teardown or manual intervention), stop polling.
      if (link.status !== 'degraded_poll') {
        clearInterval(timer);
        this._degradedPollTimers.delete(linkKey);
        return;
      }

      try {
        // Attempt repair. Reset attempt counter so repairLink doesn't
        // immediately re-enter degraded_poll on failure.
        this._repairAttempts.set(linkKey, 0);
        await this.ledger.setStatus(link, 'repairing');
        await this.repairLink(linkKey);

        // If repairLink succeeded, link is now 'live' — stop polling.
        if ((link.status as string) === 'live') {
          clearInterval(timer);
          this._degradedPollTimers.delete(linkKey);
        }
      } catch {
        // Repair failed — restore degraded_poll status so the timer continues.
        // This is critical: repairLink sets status to 'repairing' internally,
        // and if we don't restore degraded_poll, the next tick would see
        // status !== 'degraded_poll' and stop the timer permanently.
        await this.ledger.setStatus(link, 'degraded_poll');
      }
    }, interval);

    this._degradedPollTimers.set(linkKey, timer);
  }

  /**
   * Tears down all live subscriptions and push listeners.
   */
  private async teardownLiveSync(): Promise<void> {
    // Increment generation to invalidate all in-flight async operations
    // (repairs, retry timers, degraded-poll ticks). Any async work that
    // captured the previous generation will bail on its next checkpoint.
    this._syncGeneration++;

    // Clear the push debounce timer.
    if (this._pushDebounceTimer) {
      clearTimeout(this._pushDebounceTimer);
      this._pushDebounceTimer = undefined;
    }

    // Flush any pending push CIDs.
    this._pendingPushCids.clear();

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

    // Clear closure evaluation contexts.
    this._closureContexts.clear();

    // Clear the in-memory link and runtime state.
    this._activeLinks.clear();
    this._linkRuntimes.clear();
  }

  // ---------------------------------------------------------------------------
  // Live pull: MessagesSubscribe to remote DWN
  // ---------------------------------------------------------------------------

  /**
   * Opens a MessagesSubscribe WebSocket subscription to a remote DWN.
   * Incoming events are processed locally as they arrive.
   */
  private async openLivePullSubscription(target: {
    did: string; dwnUrl: string; delegateDid?: string; protocol?: string;
  }): Promise<void> {
    const { did, delegateDid, dwnUrl, protocol } = target;

    // Resolve the cursor from the link's pull checkpoint (preferred) or legacy storage.
    const cursorKey = this.buildCursorKey(did, dwnUrl, protocol);
    const link = this._activeLinks.get(cursorKey);
    const cursor = link?.pull.contiguousAppliedToken ?? await this.getCursor(cursorKey);

    // Build the MessagesSubscribe filters.
    const filters = protocol ? [{ protocol }] : [];

    // Look up permission grant for MessagesSubscribe if using a delegate.
    // The unified scope matching in AgentPermissionsApi accepts a
    // Messages.Read grant for MessagesSubscribe requests, so a single
    // lookup is sufficient.
    let permissionGrantId: string | undefined;
    if (delegateDid) {
      const grant = await this._permissionsApi.getPermissionForRequest({
        connectedDid : did,
        messageType  : DwnInterface.MessagesSubscribe,
        delegateDid,
        protocol,
        cached       : true
      });
      permissionGrantId = grant.grant.id;
    }

    // Define the subscription handler that processes incoming events.
    // NOTE: The WebSocket client fires handlers without awaiting (fire-and-forget),
    // so multiple handlers can be in-flight concurrently. The ordinal tracker
    // ensures the checkpoint advances only when all earlier deliveries are committed.
    const subscriptionHandler = async (subMessage: SubscriptionMessage): Promise<void> => {
      if (subMessage.type === 'eose') {
        // End-of-stored-events — catch-up complete.
        if (link) {
          // Guard: if the link transitioned to repairing while catch-up events
          // were being processed, skip all mutations — repair owns the state now.
          if (link.status !== 'live' && link.status !== 'initializing') {
            return;
          }

          if (!ReplicationLedger.validateTokenDomain(link.pull, subMessage.cursor)) {
            console.warn(`SyncEngineLevel: Token domain mismatch on EOSE for ${did} -> ${dwnUrl}, transitioning to repairing`);
            await this.transitionToRepairing(cursorKey, link);
            return;
          }
          ReplicationLedger.setReceivedToken(link.pull, subMessage.cursor);
          // Drain committed entries. Do NOT unconditionally advance to the
          // EOSE cursor — earlier stored events may still be in-flight
          // (handlers are fire-and-forget). The checkpoint advances only as
          // far as the contiguous drain reaches.
          this.drainCommittedPull(cursorKey);
          await this.ledger.saveLink(link);
        } else {
          await this.setCursor(cursorKey, subMessage.cursor);
        }
        // Transport is reachable — set connectivity to online.
        this._connectivityState = 'online';
        return;
      }

      if (subMessage.type === 'event') {
        const event: MessageEvent = subMessage.event;

        // Guard: if the link is not live (e.g., repairing, degraded_poll, paused),
        // skip all processing. Old subscription handlers may still fire after the
        // link transitions — these events should be ignored entirely, not just
        // skipped at the checkpoint level.
        if (link && link.status !== 'live' && link.status !== 'initializing') {
          return;
        }

        // Domain validation: reject tokens from a different stream/epoch.
        if (link && !ReplicationLedger.validateTokenDomain(link.pull, subMessage.cursor)) {
          console.warn(`SyncEngineLevel: Token domain mismatch for ${did} -> ${dwnUrl}, transitioning to repairing`);
          await this.transitionToRepairing(cursorKey, link);
          return;
        }

        // Assign a delivery ordinal BEFORE async processing begins.
        // This captures the delivery order even if processing completes out of order.
        const rt = link ? this.getOrCreateRuntime(cursorKey) : undefined;
        const ordinal = rt ? rt.nextDeliveryOrdinal++ : -1;
        if (rt) {
          rt.inflight.set(ordinal, { ordinal, token: subMessage.cursor, committed: false });
        }

        try {
          // Extract inline data from the event (available for records <= 30 KB).
          let dataStream = this.extractDataStream(event);

          // For large RecordsWrite messages (no inline data), fetch the data
          // from the remote DWN via MessagesRead before storing locally.
          if (!dataStream && isRecordsWrite(event) && (event.message.descriptor as any).dataCid) {
            const messageCid = await Message.getCid(event.message);
            const fetched = await fetchRemoteMessages({
              did, dwnUrl, delegateDid, protocol,
              messageCids    : [messageCid],
              agent          : this.agent,
              permissionsApi : this._permissionsApi,
            });
            if (fetched.length > 0 && fetched[0].dataStream) {
              dataStream = fetched[0].dataStream;
            }
          }

          await this.agent.dwn.processRawMessage(did, event.message, { dataStream });

          // Closure validation for scoped subset sync (Phase 3).
          // For protocol-scoped links, verify that all hard dependencies for
          // this operation are locally present before considering it committed.
          // Full-tenant scope bypasses this entirely (returns complete with 0 queries).
          if (link && link.scope.kind === 'protocol') {
            const messageStore = this.agent.dwn.node.storage.messageStore;
            let closureCtx = this._closureContexts.get(did);
            if (!closureCtx) {
              closureCtx = createClosureContext(did);
              this._closureContexts.set(did, closureCtx);
            }

            const closureResult = await evaluateClosure(
              event.message, messageStore, link.scope, closureCtx
            );

            if (!closureResult.complete) {
              console.warn(
                `SyncEngineLevel: Closure incomplete for ${did} -> ${dwnUrl}: ` +
                `${closureResult.failure!.code} — ${closureResult.failure!.detail}`
              );
              await this.transitionToRepairing(cursorKey, link);
              return;
            }
          }

          // NOTE: Squash local side-effect for scoped subset sync is deferred.
          // When a subset consumer applies a squash record, it should locally
          // purge older siblings — but this requires careful alignment with the
          // DWN SDK's performRecordsSquash / purgeRecordMessages internals.
          // For now, processRawMessage handles squash via the DWN's built-in
          // resumable task system. If the local DWN processes the squash write,
          // it will trigger its own squash task. Subset-specific squash side-
          // effects (where the consumer has records the source purged) are
          // reconciled by SMT integrity checks.

          // Track this CID for echo-loop suppression, scoped to the source endpoint.
          const pulledCid = await Message.getCid(event.message);
          this._recentlyPulledCids.set(`${pulledCid}|${dwnUrl}`, Date.now() + SyncEngineLevel.ECHO_SUPPRESS_TTL_MS);
          this.evictExpiredEchoEntries();

          // Mark this ordinal as committed and drain the checkpoint.
          // Guard: if the link transitioned to repairing while this handler was
          // in-flight (e.g., an earlier ordinal's handler failed concurrently),
          // skip all state mutations — the repair process owns progression now.
          if (link && rt && link.status === 'live') {
            const entry = rt.inflight.get(ordinal);
            if (entry) { entry.committed = true; }

            ReplicationLedger.setReceivedToken(link.pull, subMessage.cursor);
            const drained = this.drainCommittedPull(cursorKey);
            if (drained > 0) {
              await this.ledger.saveLink(link);
            }

            // Overflow: too many in-flight ordinals without draining.
            if (rt.inflight.size > MAX_PENDING_TOKENS) {
              console.warn(`SyncEngineLevel: Pull in-flight overflow for ${did} -> ${dwnUrl}, transitioning to repairing`);
              await this.transitionToRepairing(cursorKey, link);
            }
          } else if (!link) {
            // Legacy path: no link available, use simple cursor persistence.
            await this.setCursor(cursorKey, subMessage.cursor);
          }
        } catch (error: any) {
          console.error(`SyncEngineLevel: Error processing live-pull event for ${did}`, error);
          // A failed processRawMessage means local state is incomplete.
          // Transition to repairing immediately — do NOT advance the checkpoint
          // past this failure or let later ordinals commit past it. SMT
          // reconciliation will discover and fill the gap.
          if (link) {
            await this.transitionToRepairing(cursorKey, link);
          }
        }
      }
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
      messageParams : { filters, cursor, permissionGrantId },
    };

    const { message } = await this.agent.dwn.processRequest(subscribeRequest);
    if (!message) {
      throw new Error(`SyncEngineLevel: Failed to construct MessagesSubscribe for ${dwnUrl}`);
    }

    // Build a resubscribe factory so the WebSocket client can resume with
    // a fresh cursor-stamped message after reconnection.
    const resubscribeFactory: ResubscribeFactory = async (resumeCursor?: ProgressToken) => {
      // On reconnect, use the latest durable checkpoint position if available.
      const effectiveCursor = resumeCursor ?? link?.pull.contiguousAppliedToken ?? cursor;
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

    this._liveSubscriptions.push({
      did,
      dwnUrl,
      delegateDid,
      protocol,
      close: async (): Promise<void> => { await reply.subscription!.close(); },
    });

    this._connectivityState = 'online';
  }

  // ---------------------------------------------------------------------------
  // Live push: local EventLog subscription for immediate push
  // ---------------------------------------------------------------------------

  /**
   * Subscribes to the local DWN's EventLog so that writes by the user are
   * immediately pushed to the remote DWN instead of waiting for the next poll.
   */
  private async openLocalPushSubscription(target: {
    did: string; dwnUrl: string; delegateDid?: string; protocol?: string;
    pushCursor?: ProgressToken;
  }): Promise<void> {
    const { did, delegateDid, dwnUrl, protocol } = target;

    // Build filters scoped to the protocol (if any).
    const filters = protocol ? [{ protocol }] : [];

    // Look up permission grant for local subscription.
    let permissionGrantId: string | undefined;
    if (delegateDid) {
      const grant = await this._permissionsApi.getPermissionForRequest({
        connectedDid : did,
        messageType  : DwnInterface.MessagesSubscribe,
        delegateDid,
        protocol,
        cached       : true,
      });
      permissionGrantId = grant.grant.id;
    }

    // Subscribe to the local DWN's EventLog.
    const subscriptionHandler = async (subMessage: SubscriptionMessage): Promise<void> => {
      if (subMessage.type !== 'event') {
        return;
      }

      // Accumulate the message CID for a debounced push.
      const targetKey = this.buildCursorKey(did, dwnUrl, protocol);
      const cid = await Message.getCid(subMessage.event.message);
      if (cid === undefined) {
        return;
      }

      // Echo-loop suppression: skip CIDs that were recently pulled from this
      // specific remote. A message pulled from Provider A is only suppressed
      // for push to A — it still fans out to Provider B and C.
      if (this.isRecentlyPulled(cid, dwnUrl)) {
        return;
      }

      let pending = this._pendingPushCids.get(targetKey);
      if (!pending) {
        pending = { did, dwnUrl, delegateDid, protocol, entries: [] };
        this._pendingPushCids.set(targetKey, pending);
      }
      pending.entries.push({ cid, localToken: subMessage.cursor });

      // Debounce the push.
      if (this._pushDebounceTimer) {
        clearTimeout(this._pushDebounceTimer);
      }
      this._pushDebounceTimer = setTimeout((): void => {
        void this.flushPendingPushes();
      }, PUSH_DEBOUNCE_MS);
    };

    // Process the local subscription request.
    // When a push cursor is provided (e.g., after repair), the local subscription
    // replays events from that position, closing the race window where local
    // writes during repair would otherwise be missed by push-on-write.
    const response = await this.agent.dwn.processRequest({
      author              : did,
      target              : did,
      messageType         : DwnInterface.MessagesSubscribe,
      granteeDid          : delegateDid,
      messageParams       : { filters, permissionGrantId, cursor: target.pushCursor },
      subscriptionHandler : subscriptionHandler as any,
    });

    const reply = response.reply as MessagesSubscribeReply;
    if (reply.status.code !== 200 || !reply.subscription) {
      throw new Error(`SyncEngineLevel: Local MessagesSubscribe failed for ${did}: ${reply.status.code} ${reply.status.detail}`);
    }

    this._localSubscriptions.push({
      did,
      dwnUrl,
      delegateDid,
      protocol,
      close: async (): Promise<void> => { await reply.subscription!.close(); },
    });
  }

  /**
   * Flushes accumulated push CIDs to remote DWNs.
   */
  private async flushPendingPushes(): Promise<void> {
    this._pushDebounceTimer = undefined;

    const batches = [...this._pendingPushCids.entries()];
    this._pendingPushCids.clear();

    // Push to all endpoints in parallel — each target is independent.
    await Promise.all(batches.map(async ([targetKey, pending]) => {
      const { did, dwnUrl, delegateDid, protocol, entries: pushEntries } = pending;
      if (pushEntries.length === 0) {
        return;
      }

      const cids = pushEntries.map(e => e.cid);

      try {
        const result = await pushMessages({
          did, dwnUrl, delegateDid, protocol,
          messageCids    : cids,
          agent          : this.agent,
          permissionsApi : this._permissionsApi,
        });

        // Advance the push checkpoint for successfully pushed entries.
        // Push is sequential (single batch, in-order processing) so we can
        // commit directly without ordinal tracking — there's no concurrent
        // completion to reorder.
        const link = this._activeLinks.get(targetKey);
        if (link) {
          const succeededSet = new Set(result.succeeded);
          // Track highest contiguous success: if a CID fails, we stop advancing.
          let hitFailure = false;
          for (const entry of pushEntries) {
            if (hitFailure) { break; }
            if (succeededSet.has(entry.cid) && entry.localToken) {
              if (!ReplicationLedger.validateTokenDomain(link.push, entry.localToken)) {
                console.warn(`SyncEngineLevel: Push checkpoint domain mismatch for ${did} -> ${dwnUrl}, transitioning to repairing`);
                await this.transitionToRepairing(targetKey, link);
                break;
              }
              ReplicationLedger.setReceivedToken(link.push, entry.localToken);
              ReplicationLedger.commitContiguousToken(link.push, entry.localToken);
            } else {
              // This CID failed or had no token — stop advancing.
              hitFailure = true;
            }
          }
          await this.ledger.saveLink(link);
        }

        // Re-queue failed entries so they are retried on the next debounce
        // cycle (or picked up by the SMT integrity check).
        if (result.failed.length > 0) {
          console.error(`SyncEngineLevel: Push-on-write failed for ${did} -> ${dwnUrl}: ${result.failed.length} of ${cids.length} messages failed`);
          const failedSet = new Set(result.failed);
          const failedEntries = pushEntries.filter(e => failedSet.has(e.cid));
          let requeued = this._pendingPushCids.get(targetKey);
          if (!requeued) {
            requeued = { did, dwnUrl, delegateDid, protocol, entries: [] };
            this._pendingPushCids.set(targetKey, requeued);
          }
          requeued.entries.push(...failedEntries);

          // Schedule a retry after a short delay.
          if (!this._pushDebounceTimer) {
            this._pushDebounceTimer = setTimeout((): void => {
              void this.flushPendingPushes();
            }, PUSH_DEBOUNCE_MS * 4); // Back off: 1 second instead of 250ms.
          }
        }
      } catch (error: any) {
        // Truly unexpected error (not per-message failure). Re-queue entire
        // batch so entries aren't silently dropped from the debounce queue.
        console.error(`SyncEngineLevel: Push-on-write failed for ${did} -> ${dwnUrl}`, error);
        let requeued = this._pendingPushCids.get(targetKey);
        if (!requeued) {
          requeued = { did, dwnUrl, delegateDid, protocol, entries: [] };
          this._pendingPushCids.set(targetKey, requeued);
        }
        requeued.entries.push(...pushEntries);

        if (!this._pushDebounceTimer) {
          this._pushDebounceTimer = setTimeout((): void => {
            void this.flushPendingPushes();
          }, PUSH_DEBOUNCE_MS * 4);
        }
      }
    }));
  }

  // ---------------------------------------------------------------------------
  // Cursor persistence
  // ---------------------------------------------------------------------------

  private buildCursorKey(did: string, dwnUrl: string, protocol?: string): string {
    const base = `${did}${CURSOR_SEPARATOR}${dwnUrl}`;
    return protocol ? `${base}${CURSOR_SEPARATOR}${protocol}` : base;
  }

  /**
   * Retrieves a stored progress token. Handles migration from old string cursors:
   * if the stored value is a bare string (pre-ProgressToken format), it is treated
   * as absent — the sync engine will do a full SMT reconciliation on first startup
   * after upgrade, which is correct and safe.
   */
  private async getCursor(key: string): Promise<ProgressToken | undefined> {
    const cursors = this._db.sublevel('syncCursors');
    try {
      const raw = await cursors.get(key);
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' &&
            typeof parsed.streamId === 'string' &&
            typeof parsed.epoch === 'string' &&
            typeof parsed.position === 'string' &&
            typeof parsed.messageCid === 'string') {
          return parsed as ProgressToken;
        }
      } catch {
        // Not valid JSON (old string cursor) — treat as absent.
      }
      return undefined;
    } catch (error) {
      const e = error as { code: string };
      if (e.code === 'LEVEL_NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }

  private async setCursor(key: string, cursor: ProgressToken): Promise<void> {
    const cursors = this._db.sublevel('syncCursors');
    await cursors.put(key, JSON.stringify(cursor));
  }

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------

  /**
   * Extracts a ReadableStream from a MessageEvent if it contains a
   * RecordsWrite with data — either as an inline `encodedData` field
   * (for records <= 30 KB) or as a pre-existing data stream.
   */
  private extractDataStream(event: MessageEvent): ReadableStream<Uint8Array> | undefined {
    if (!isRecordsWrite(event)) {
      return undefined;
    }

    // Check for inline base64url-encoded data (small records from EventLog).
    const encodedData = (event.message as any).encodedData as string | undefined;
    if (encodedData) {
      const bytes = Encoder.base64UrlToBytes(encodedData);
      return new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(bytes);
          controller.close();
        }
      });
    }

    // Check for a pre-existing data stream (e.g. from a direct message read).
    if ((event as any).data) {
      return (event as any).data;
    }

    return undefined;
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
  private async getLocalRoot(did: string, delegateDid?: string, protocol?: string): Promise<string> {
    const si = this.stateIndex;
    if (si) {
      const rootHash = protocol !== undefined
        ? await si.getProtocolRoot(did, protocol)
        : await si.getRoot(did);
      return hashToHex(rootHash);
    }

    // Remote mode fallback: go through processRequest → RPC.
    const permissionGrantId = await this.getSyncPermissionGrantId(did, delegateDid, protocol);
    const response = await this.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action: 'root',
        protocol,
        permissionGrantId
      }
    });
    const reply = response.reply as MessagesSyncReply;
    return reply.root ?? '';
  }

  /**
   * Get the SMT root hash from a remote DWN via a MessagesSync 'root' action.
   * Returns a hex-encoded root hash string.
   */
  private async getRemoteRoot(did: string, dwnUrl: string, delegateDid?: string, protocol?: string): Promise<string> {
    const permissionGrantId = await this.getSyncPermissionGrantId(did, delegateDid, protocol);

    const syncMessage = await this.agent.dwn.processRequest({
      store         : false,
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action: 'root',
        protocol,
        permissionGrantId
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
  private async diffWithRemote({ did, dwnUrl, delegateDid, protocol }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
  }): Promise<{ onlyRemote: MessagesSyncDiffEntry[]; onlyLocal: string[] }> {
    // Step 1: Collect local subtree hashes at BATCHED_DIFF_DEPTH directly from StateIndex.
    const localHashes = await this.collectLocalSubtreeHashes(did, protocol, BATCHED_DIFF_DEPTH);

    // Step 2: Send a single 'diff' request to the remote with our hashes.
    const permissionGrantId = await this.getSyncPermissionGrantId(did, delegateDid, protocol);

    const syncMessage = await this.agent.dwn.processRequest({
      store         : false,
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action : 'diff',
        protocol,
        hashes : localHashes,
        depth  : BATCHED_DIFF_DEPTH,
        permissionGrantId,
      }
    });

    const reply = await this.agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : did,
      message   : syncMessage.message,
    }) as MessagesSyncReply;

    if (reply.status.code !== 200) {
      throw new Error(`SyncEngineLevel: diff failed with ${reply.status.code}: ${reply.status.detail}`);
    }

    // Step 3: Enumerate local leaves for prefixes the remote reported as onlyLocal.
    // Reuse the same grant ID from step 2 (avoids redundant lookup).
    const permissionGrantIdForLeaves = permissionGrantId;
    const onlyLocalCids: string[] = [];
    for (const prefix of reply.onlyLocal ?? []) {
      const leaves = await this.getLocalLeaves(did, prefix, delegateDid, protocol, permissionGrantIdForLeaves);
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
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const defaultHash = await this.getDefaultHashHex(depth);
    const si = this.stateIndex;

    const walk = async (prefix: string, currentDepth: number): Promise<void> => {
      let hexHash: string;

      if (si) {
        // Fast path: direct StateIndex access (local mode).
        const bitPath = SyncEngineLevel.parseBitPrefix(prefix);
        const hash = protocol !== undefined
          ? await si.getProtocolSubtreeHash(did, protocol, bitPath)
          : await si.getSubtreeHash(did, bitPath);
        hexHash = hashToHex(hash);
      } else {
        // Remote mode fallback.
        hexHash = await this.getLocalSubtreeHash(did, prefix, undefined, protocol);
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
    did: string, prefix: string, delegateDid?: string, protocol?: string, permissionGrantId?: string
  ): Promise<string> {
    const si = this.stateIndex;
    if (si) {
      const bitPath = SyncEngineLevel.parseBitPrefix(prefix);
      const hash = protocol !== undefined
        ? await si.getProtocolSubtreeHash(did, protocol, bitPath)
        : await si.getSubtreeHash(did, bitPath);
      return hashToHex(hash);
    }

    // Remote mode fallback.
    const response = await this.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action: 'subtree',
        prefix,
        protocol,
        permissionGrantId
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
    did: string, prefix: string, delegateDid?: string, protocol?: string, permissionGrantId?: string
  ): Promise<string[]> {
    const si = this.stateIndex;
    if (si) {
      const bitPath = SyncEngineLevel.parseBitPrefix(prefix);
      return protocol !== undefined
        ? await si.getProtocolLeaves(did, protocol, bitPath)
        : await si.getLeaves(did, bitPath);
    }

    // Remote mode fallback.
    const response = await this.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSync,
      granteeDid    : delegateDid,
      messageParams : {
        action: 'leaves',
        prefix,
        protocol,
        permissionGrantId
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
  private async pullMessages({ did, dwnUrl, delegateDid, protocol, messageCids, prefetched }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    messageCids: string[];
    prefetched?: MessagesSyncDiffEntry[];
  }): Promise<void> {
    return pullMessages({
      did, dwnUrl, delegateDid, protocol, messageCids, prefetched,
      agent          : this.agent,
      permissionsApi : this._permissionsApi,
    });
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
  private async pushMessages({ did, dwnUrl, delegateDid, protocol, messageCids }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    messageCids: string[];
  }): Promise<PushResult> {
    return pushMessages({
      did, dwnUrl, delegateDid, protocol, messageCids,
      agent          : this.agent,
      permissionsApi : this._permissionsApi,
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

  /**
   * Returns the list of sync targets: (did, dwnUrl, delegateDid?, protocol?) tuples.
   */
  private async getSyncTargets(): Promise<{
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
  }[]> {
    const targets: { did: string; dwnUrl: string; delegateDid?: string; protocol?: string }[] = [];

    for await (const [did, options] of this._db.sublevel('registeredIdentities').iterator()) {
      let parsed: SyncIdentityOptions;
      try {
        parsed = JSON.parse(options) as SyncIdentityOptions;
      } catch (error: unknown) {
        console.warn(`SyncEngineLevel: Corrupt sync options for ${did}, falling back to global sync:`, error);
        parsed = { protocols: [] };
      }
      const { protocols, delegateDid } = parsed;

      const dwnEndpointUrls = await this.agent.dwn.getDwnEndpointUrlsForTarget(did);
      if (dwnEndpointUrls.length === 0) {
        continue;
      }

      for (const dwnUrl of dwnEndpointUrls) {
        if (protocols.length === 0) {
          // Sync all protocols (global tree).
          targets.push({ did, delegateDid, dwnUrl });
        } else {
          for (const protocol of protocols) {
            targets.push({ did, delegateDid, dwnUrl, protocol });
          }
        }
      }
    }

    return targets;
  }

  /**
   * Gets the permission grant ID for MessagesSync if a delegateDid is provided.
   * Returns undefined if no delegate is in use (owner access).
   */
  private async getSyncPermissionGrantId(did: string, delegateDid?: string, protocol?: string): Promise<string | undefined> {
    if (!delegateDid) {
      return undefined;
    }

    const messagesSyncGrant = await this._permissionsApi.getPermissionForRequest({
      connectedDid : did,
      messageType  : DwnInterface.MessagesSync,
      delegateDid,
      protocol,
      cached       : true
    });
    return messagesSyncGrant.grant.id;
  }
}
