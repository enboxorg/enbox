import type { AbstractLevel } from 'abstract-level';
import type { GenericMessage, MessageEvent, MessagesSubscribeReply, MessagesSyncReply, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import ms from 'ms';

import { Level } from 'level';
import { hashToHex, initDefaultHashes, Message } from '@enbox/dwn-sdk-js';

import type { PermissionsApi } from './types/permissions.js';
import type { StartSyncParams, SyncConnectivityState, SyncEngine, SyncIdentityOptions, SyncMode } from './types/sync.js';
import type { Web5Agent, Web5PlatformAgent } from './types/agent.js';

import { AgentPermissionsApi } from './permissions-api.js';
import { DwnInterface } from './types/dwn.js';
import { isRecordsWrite } from './utils.js';
import { topologicalSort } from './sync-topological-sort.js';
import { pullMessages, pushMessages } from './sync-messages.js';

export type SyncEngineLevelParams = {
  agent?: Web5PlatformAgent;
  dataPath?: string;
  db?: AbstractLevel<string | Buffer | Uint8Array>;
};

/**
 * Maximum bit prefix depth before falling back to leaf enumeration.
 * At depth 16, each subtree covers ~1/65536 of the key space, which is a good
 * balance between round-trip count and leaf-set size.
 */
const MAX_DIFF_DEPTH = 16;

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

export class SyncEngineLevel implements SyncEngine {
  /**
   * Holds the instance of a `Web5PlatformAgent` that represents the current execution context for
   * the `SyncEngineLevel`. This agent is used to interact with other Web5 agent components. It's
   * vital to ensure this instance is set to correctly contextualize operations within the broader
   * Web5 Agent framework.
   */
  private _agent?: Web5PlatformAgent;

  /**
   * An instance of the `AgentPermissionsApi` that is used to interact with permissions grants used during sync
   */
  private _permissionsApi: PermissionsApi;

  private _db: AbstractLevel<string | Buffer | Uint8Array>;
  private _syncIntervalId?: ReturnType<typeof setInterval>;
  private _syncLock = false;

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

  /** Active live pull subscriptions (remote -> local via MessagesSubscribe). */
  private _liveSubscriptions: LiveSubscription[] = [];

  /** Active local EventLog subscriptions for push-on-write (local -> remote). */
  private _localSubscriptions: LocalSubscription[] = [];

  /** Connectivity state derived from subscription health. */
  private _connectivityState: SyncConnectivityState = 'unknown';

  /** Debounce timer for batched push-on-write. */
  private _pushDebounceTimer?: ReturnType<typeof setTimeout>;

  /** Pending message CIDs to push, accumulated during the debounce window. */
  private _pendingPushCids: Map<string, { did: string; dwnUrl: string; delegateDid?: string; protocol?: string; cids: string[] }> = new Map();

  /** Count of consecutive SMT sync failures (for backoff in poll mode). */
  private _consecutiveFailures = 0;

  /** Maximum consecutive failures before entering backoff. */
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;

  /** Backoff multiplier for consecutive failures (caps at 4x the configured interval). */
  private static readonly MAX_BACKOFF_MULTIPLIER = 4;

  constructor({ agent, dataPath, db }: SyncEngineLevelParams) {
    this._agent = agent;
    this._permissionsApi = new AgentPermissionsApi({ agent: agent as Web5Agent });
    this._db = (db) ? db : new Level<string, string>(dataPath ?? 'DATA/AGENT/SYNC_STORE');
  }

  /**
   * Retrieves the `Web5PlatformAgent` execution context.
   *
   * @returns The `Web5PlatformAgent` instance that represents the current execution context.
   * @throws Will throw an error if the `agent` instance property is undefined.
   */
  get agent(): Web5PlatformAgent {
    if (this._agent === undefined) {
      throw new Error('SyncEngineLevel: Unable to determine agent execution context.');
    }

    return this._agent;
  }

  set agent(agent: Web5PlatformAgent) {
    this._agent = agent;
    this._permissionsApi = new AgentPermissionsApi({ agent: agent as Web5Agent });
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

          // Phase 2: Walk the tree to find differing subtrees.
          const diff = await this.walkTreeDiff({
            did, dwnUrl, delegateDid, protocol,
          });

          // Phase 3: Pull missing messages (remote has, local doesn't).
          if (!direction || direction === 'pull') {
            if (diff.onlyRemote.length > 0) {
              await this.pullMessages({ did, dwnUrl, delegateDid, protocol, messageCids: diff.onlyRemote });
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

    // Step 2: Open live subscriptions for each sync target.
    const syncTargets = await this.getSyncTargets();
    for (const target of syncTargets) {
      try {
        await this.openLivePullSubscription(target);
        await this.openLocalPushSubscription(target);
      } catch (error: any) {
        console.error(`SyncEngineLevel: Failed to open live subscription for ${target.did} -> ${target.dwnUrl}`, error);
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
   * Tears down all live subscriptions and push listeners.
   */
  private async teardownLiveSync(): Promise<void> {
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

    // Resolve the cursor from the last session (if any).
    const cursorKey = this.buildCursorKey(did, dwnUrl, protocol);
    const cursor = await this.getCursor(cursorKey);

    // Build the MessagesSubscribe filters.
    const filters = protocol ? [{ protocol }] : [];

    // Look up permission grant for MessagesSubscribe if using a delegate.
    let permissionGrantId: string | undefined;
    if (delegateDid) {
      try {
        const grant = await this._permissionsApi.getPermissionForRequest({
          connectedDid : did,
          messageType  : DwnInterface.MessagesSubscribe,
          delegateDid,
          protocol,
          cached       : true
        });
        permissionGrantId = grant.grant.id;
      } catch {
        // Fall back to trying MessagesRead which is a unified scope.
        try {
          const grant = await this._permissionsApi.getPermissionForRequest({
            connectedDid : did,
            messageType  : DwnInterface.MessagesRead,
            delegateDid,
            protocol,
            cached       : true
          });
          permissionGrantId = grant.grant.id;
        } catch (error: any) {
          console.error('SyncEngineLevel: Could not find permission grant for live pull subscription', error);
          return;
        }
      }
    }

    // Define the subscription handler that processes incoming events.
    const subscriptionHandler = async (subMessage: SubscriptionMessage): Promise<void> => {
      if (subMessage.type === 'eose') {
        // End-of-stored-events — catch-up complete, persist cursor.
        await this.setCursor(cursorKey, subMessage.cursor);
        this._connectivityState = 'online';
        return;
      }

      if (subMessage.type === 'event') {
        const event: MessageEvent = subMessage.event;
        try {
          // Process the message locally.
          const dataStream = this.extractDataStream(event);
          await this.agent.dwn.node.processMessage(did, event.message, { dataStream });
        } catch (error: any) {
          console.error(`SyncEngineLevel: Error processing live-pull event for ${did}`, error);
        }

        // Persist cursor for resume on reconnect.
        await this.setCursor(cursorKey, subMessage.cursor);
      }
    };

    // Send the subscription request through the agent's DWN API.
    const response = await this.agent.dwn.sendRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.MessagesSubscribe,
      granteeDid    : delegateDid,
      messageParams : {
        filters,
        cursor,
        permissionGrantId,
      },
      subscriptionHandler: subscriptionHandler as any,
    });

    const reply = response.reply as MessagesSubscribeReply;
    if (reply.status.code !== 200 || !reply.subscription) {
      console.error(`SyncEngineLevel: MessagesSubscribe failed for ${did} -> ${dwnUrl}: ${reply.status.code} ${reply.status.detail}`);
      return;
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
  }): Promise<void> {
    const { did, delegateDid, dwnUrl, protocol } = target;

    // Build filters scoped to the protocol (if any).
    const filters = protocol ? [{ protocol }] : [];

    // Look up permission grant for local subscription.
    let permissionGrantId: string | undefined;
    if (delegateDid) {
      try {
        const grant = await this._permissionsApi.getPermissionForRequest({
          connectedDid : did,
          messageType  : DwnInterface.MessagesRead,
          delegateDid,
          protocol,
          cached       : true,
        });
        permissionGrantId = grant.grant.id;
      } catch {
        // No grant available — skip push-on-write for this target.
        return;
      }
    }

    // Subscribe to the local DWN's EventLog.
    const subscriptionHandler = (subMessage: SubscriptionMessage): void => {
      if (subMessage.type !== 'event') {
        return;
      }

      // Accumulate the message CID for a debounced push.
      const targetKey = this.buildCursorKey(did, dwnUrl, protocol);
      const cid = this.tryGetCidSync(subMessage.event.message);
      if (cid === undefined) {
        return;
      }

      let pending = this._pendingPushCids.get(targetKey);
      if (!pending) {
        pending = { did, dwnUrl, delegateDid, protocol, cids: [] };
        this._pendingPushCids.set(targetKey, pending);
      }
      pending.cids.push(cid);

      // Debounce the push.
      if (this._pushDebounceTimer) {
        clearTimeout(this._pushDebounceTimer);
      }
      this._pushDebounceTimer = setTimeout((): void => {
        void this.flushPendingPushes();
      }, PUSH_DEBOUNCE_MS);
    };

    // Process the local subscription request.
    const response = await this.agent.dwn.processRequest({
      author              : did,
      target              : did,
      messageType         : DwnInterface.MessagesSubscribe,
      granteeDid          : delegateDid,
      messageParams       : { filters, permissionGrantId },
      subscriptionHandler : subscriptionHandler as any,
    });

    const reply = response.reply as MessagesSubscribeReply;
    if (reply.status.code !== 200 || !reply.subscription) {
      console.error(`SyncEngineLevel: Local MessagesSubscribe failed for ${did}: ${reply.status.code} ${reply.status.detail}`);
      return;
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

    const entries = [...this._pendingPushCids.entries()];
    this._pendingPushCids.clear();

    for (const [, pending] of entries) {
      const { did, dwnUrl, delegateDid, protocol, cids } = pending;
      if (cids.length === 0) {
        continue;
      }

      try {
        await pushMessages({
          did, dwnUrl, delegateDid, protocol,
          messageCids    : cids,
          agent          : this.agent,
          permissionsApi : this._permissionsApi,
        });
      } catch (error: any) {
        console.error(`SyncEngineLevel: Push-on-write failed for ${did} -> ${dwnUrl}`, error);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cursor persistence
  // ---------------------------------------------------------------------------

  private buildCursorKey(did: string, dwnUrl: string, protocol?: string): string {
    const base = `${did}${CURSOR_SEPARATOR}${dwnUrl}`;
    return protocol ? `${base}${CURSOR_SEPARATOR}${protocol}` : base;
  }

  private async getCursor(key: string): Promise<string | undefined> {
    const cursors = this._db.sublevel('syncCursors');
    try {
      return await cursors.get(key);
    } catch (error) {
      const e = error as { code: string };
      if (e.code === 'LEVEL_NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }

  private async setCursor(key: string, cursor: string): Promise<void> {
    const cursors = this._db.sublevel('syncCursors');
    await cursors.put(key, cursor);
  }

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------

  /**
   * Extracts a ReadableStream from a MessageEvent if it contains a RecordsWrite with data.
   */
  private extractDataStream(event: MessageEvent): ReadableStream<Uint8Array> | undefined {
    if (isRecordsWrite(event) && (event as any).data) {
      return (event as any).data;
    }
    return undefined;
  }

  /**
   * Synchronously attempts to get a message CID. Returns undefined on failure.
   * This is used in the synchronous EventLog callback; the actual CID computation
   * is fast for already-constructed messages.
   */
  private tryGetCidSync(message: GenericMessage): string | undefined {
    // Message.getCid is async but very fast (SHA-256 of the descriptor).
    // We fire-and-forget into a microtask and store the result.
    // For the debounced push, the CID will be resolved by the time we flush.
    let cid: string | undefined;
    void Message.getCid(message).then((result): void => { cid = result; });
    // Since this is a microtask, it may not resolve immediately.
    // Use the descriptor's CID field if available as a synchronous fallback.
    return cid ?? (message as any).messageCid ?? undefined;
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

  // ---------------------------------------------------------------------------
  // SMT Root Comparison
  // ---------------------------------------------------------------------------

  /**
   * Get the SMT root hash from the local DWN via a MessagesSync 'root' action.
   * Returns a hex-encoded root hash string.
   */
  private async getLocalRoot(did: string, delegateDid?: string, protocol?: string): Promise<string> {
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
  // Tree Diff — walk the SMT to find divergent leaf sets
  // ---------------------------------------------------------------------------

  /**
   * Walks the local and remote SMTs in parallel, recursing into subtrees whose
   * hashes differ, until reaching `MAX_DIFF_DEPTH` where leaves are enumerated.
   *
   * Returns the sets of messageCids that exist only locally or only remotely.
   */
  private async walkTreeDiff({ did, dwnUrl, delegateDid, protocol }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
  }): Promise<{ onlyLocal: string[]; onlyRemote: string[] }> {
    const onlyLocal: string[] = [];
    const onlyRemote: string[] = [];

    // Hoist permission grant lookup — resolved once and reused for all subtree/leaf requests.
    const permissionGrantId = await this.getSyncPermissionGrantId(did, delegateDid, protocol);

    const walk = async (prefix: string): Promise<void> => {
      // Get subtree hashes for this prefix from local and remote.
      const [localHash, remoteHash] = await Promise.all([
        this.getLocalSubtreeHash(did, prefix, delegateDid, protocol, permissionGrantId),
        this.getRemoteSubtreeHash(did, dwnUrl, prefix, delegateDid, protocol, permissionGrantId),
      ]);

      // If hashes match, this subtree is identical — skip.
      if (localHash === remoteHash) {
        return;
      }

      // Short-circuit: if one side is the default (empty-subtree) hash, all entries
      // on the other side are unique.  Enumerate leaves directly instead of recursing
      // further into the tree — this avoids an exponential walk when one DWN has
      // entries that the other lacks entirely in this subtree.
      const emptyHash = await this.getDefaultHashHex(prefix.length);
      if (remoteHash === emptyHash && localHash !== emptyHash) {
        const localLeaves = await this.getLocalLeaves(did, prefix, delegateDid, protocol, permissionGrantId);
        onlyLocal.push(...localLeaves);
        return;
      }
      if (localHash === emptyHash && remoteHash !== emptyHash) {
        const remoteLeaves = await this.getRemoteLeaves(did, dwnUrl, prefix, delegateDid, protocol, permissionGrantId);
        onlyRemote.push(...remoteLeaves);
        return;
      }

      // If we've reached the maximum diff depth, enumerate leaves.
      if (prefix.length >= MAX_DIFF_DEPTH) {
        const [localLeaves, remoteLeaves] = await Promise.all([
          this.getLocalLeaves(did, prefix, delegateDid, protocol, permissionGrantId),
          this.getRemoteLeaves(did, dwnUrl, prefix, delegateDid, protocol, permissionGrantId),
        ]);

        const localSet = new Set(localLeaves);
        const remoteSet = new Set(remoteLeaves);

        for (const cid of localLeaves) {
          if (!remoteSet.has(cid)) {
            onlyLocal.push(cid);
          }
        }
        for (const cid of remoteLeaves) {
          if (!localSet.has(cid)) {
            onlyRemote.push(cid);
          }
        }
        return;
      }

      // Recurse into left (0) and right (1) children in parallel.
      await Promise.all([
        walk(prefix + '0'),
        walk(prefix + '1'),
      ]);
    };

    await walk('');
    return { onlyLocal, onlyRemote };
  }

  private async getLocalSubtreeHash(
    did: string, prefix: string, delegateDid?: string, protocol?: string, permissionGrantId?: string
  ): Promise<string> {
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

  private async getRemoteSubtreeHash(
    did: string, dwnUrl: string, prefix: string, delegateDid?: string, protocol?: string, permissionGrantId?: string
  ): Promise<string> {
    const syncMessage = await this.agent.dwn.processRequest({
      store         : false,
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

    const reply = await this.agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : did,
      message   : syncMessage.message,
    }) as MessagesSyncReply;

    return reply.hash ?? '';
  }

  private async getLocalLeaves(
    did: string, prefix: string, delegateDid?: string, protocol?: string, permissionGrantId?: string
  ): Promise<string[]> {
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

  private async getRemoteLeaves(
    did: string, dwnUrl: string, prefix: string, delegateDid?: string, protocol?: string, permissionGrantId?: string
  ): Promise<string[]> {
    const syncMessage = await this.agent.dwn.processRequest({
      store         : false,
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

    const reply = await this.agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : did,
      message   : syncMessage.message,
    }) as MessagesSyncReply;

    return reply.entries ?? [];
  }

  // ---------------------------------------------------------------------------
  // Pull / Push — delegates to standalone functions in sync-messages.ts
  // ---------------------------------------------------------------------------

  /**
   * Fetches missing messages from the remote DWN and processes them locally
   * in dependency order (topological sort).
   */
  private async pullMessages({ did, dwnUrl, delegateDid, protocol, messageCids }: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    protocol?: string;
    messageCids: string[];
  }): Promise<void> {
    return pullMessages({
      did, dwnUrl, delegateDid, protocol, messageCids,
      agent          : this.agent,
      permissionsApi : this._permissionsApi,
    });
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
  }): Promise<void> {
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
      } catch {
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

    try {
      const messagesSyncGrant = await this._permissionsApi.getPermissionForRequest({
        connectedDid : did,
        messageType  : DwnInterface.MessagesSync,
        delegateDid,
        protocol,
        cached       : true
      });
      return messagesSyncGrant.grant.id;
    } catch (error: any) {
      console.error('SyncEngineLevel: Error fetching MessagesSync permission grant for delegate DID', error);
      return undefined;
    }
  }
}
