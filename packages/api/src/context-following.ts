import type { ContextFollowIntent } from './context-follows.js';
import type { ExpandableRecordView } from './record-view.js';
import type { FollowedSyncSource, SyncEngine } from '@enbox/agent';

import { ContextRetiredError } from './context-errors.js';
import { followedSyncSourceActiveEqual } from '@enbox/agent';

/** One decoded immutable decision in the recipient's private following journal. */
export type ContextFollowRecord = Readonly<{
  id: string;
  timestamp: string;
  value: ContextFollowIntent;
}>;

/** Coordinates and the role-group selection already defaulted by contexts.follow(). */
type FollowRequest = Readonly<{
  /** Key in the protocol's roleGroups map, such as 'default'; its value lists candidate role paths in preference order. */
  group: string;
  id: string;
  ownerDid: string;
}>;
type FollowSync = Pick<SyncEngine, 'followSource' | 'getFollowedSource' | 'listFollowedSources' | 'deleteFollowedSource'>;

/** @internal Native records supply persistence; the sync engine verifies remote authority. */
export type ContextFollowingOptions = {
  actorDid: string;
  append(intent: ContextFollowIntent, after?: string): Promise<ContextFollowRecord>;
  openView(signal: AbortSignal): Promise<ExpandableRecordView<ContextFollowRecord>>;
  protocol: string;
  read(): Promise<readonly ContextFollowRecord[]>;
  roleGroups: Readonly<Record<string, readonly [string, ...string[]]>>;
  signal?: AbortSignal;
  sync: FollowSync;
};

type Observation = {
  /** Last attempted intent per context, including failures; retry() clears these. */
  attempts: Map<string, ContextFollowRecord>;
  controller: AbortController;
  draining: boolean;
  listeners: Set<(error: Error) => void>;
  opening: Promise<void>;
  requested: boolean;
  unsubscribe?: () => void;
  view?: ExpandableRecordView<ContextFollowRecord>;
};

/**
 * @internal Apply saved follow choices to this device's accepted contexts.
 * Saved intent records the user's choice; the sync engine independently verifies access.
 */
export class ContextFollowing {
  private readonly _options: ContextFollowingOptions;
  /** Completion of the last operation queued for each owner/context pair. */
  private readonly _pendingOperations = new Map<string, Promise<unknown>>();
  /** Newest known decision per context, ordered by signed timestamp and then record ID. */
  private readonly _latestIntentRecords = new Map<string, ContextFollowRecord>();
  private _observation?: Observation;

  public constructor(options: ContextFollowingOptions) {
    this._options = options;
  }

  /** Verify an explicit follow, then persist the user's decision before returning success. */
  public follow(request: FollowRequest): Promise<FollowedSyncSource> {
    const key = contextKey(request.ownerDid, request.id);
    return this.enqueue(key, async (): Promise<FollowedSyncSource> => {
      const before = (await this.readLatestIntents()).get(key);
      const priorSources = await this._options.sync.listFollowedSources();
      this.assertActive();
      const source = await this._options.sync.followSource({
        actorDid  : this._options.actorDid,
        contextId : request.id,
        protocol  : this._options.protocol,
        roles     : [...this.getRolePaths(request.group)],
        sourceDid : request.ownerDid,
      });
      let persisted = false;
      try {
        const latest = (await this.readLatestIntents()).get(key);
        if (latest?.value.following === true && latest.value.group === request.group) {
          return source;
        }
        // A forget received during verification wins over this in-flight follow.
        if (sameRecord(before, latest) || latest?.value.following !== false) {
          const written = await this._options.append({
            contextId : request.id,
            following : true,
            group     : request.group,
            ownerDid  : request.ownerDid,
          }, latest?.timestamp);
          persisted = true;
          this.rememberLatestIntents([written]);
          // A decision received while the write was pending can still supersede it.
          await this.readLatestIntents();
        }
      } catch (error: unknown) {
        // A replacement facade may already reuse an acceptance issued before this one ended.
        if (!persisted && !this._options.signal?.aborted
          && !priorSources.some((prior): boolean => followedSyncSourceActiveEqual(prior, source))) {
          try {
            await this._options.sync.deleteFollowedSource(source);
          } catch (retireError: unknown) {
            throw new AggregateError([error, retireError], 'ContextFollowing: unable to complete or retire the new acceptance.');
          }
        }
        throw error;
      }
      const committed = this._latestIntentRecords.get(key);
      if (committed?.value.following === false) {
        await this.applyForget(committed);
        throw new ContextRetiredError(request.id);
      }
      return source;
    });
  }

  /**
   * Persist an explicit forget only for the current exact acceptance. An optional
   * owner-role withdrawal must succeed first; its own sync event may retire the source.
   */
  public forget(source: FollowedSyncSource, beforeForget?: () => Promise<void>): Promise<void> {
    const key = contextKey(source.sourceDid, source.contextId);
    return this.enqueue(key, async (): Promise<void> => {
      const current = await this._options.sync.getFollowedSource(source.id);
      this.assertActive();
      if (current === undefined || !followedSyncSourceActiveEqual(current, source)) {
        return;
      }
      const before = (await this.readLatestIntents()).get(key);
      const group = before?.value.group ?? Object.entries(this._options.roleGroups)
        .find(([, roles]): boolean => sameRoles(roles, source.roles))?.[0];
      if (group === undefined) {
        throw new TypeError('ContextFollowing: the accepted source has no declared role group.');
      }
      if (beforeForget !== undefined) {
        await beforeForget();
        // Leave withdraws the owner's role; respect decisions received during that operation.
        const received = (await this.readLatestIntents()).get(key);
        if (!sameRecord(before, received)) {
          if (received?.value.following === false) {
            await this.applyForget(received);
          }
          return;
        }
      } else {
        const active = await this._options.sync.getFollowedSource(source.id);
        this.assertActive();
        if (active === undefined || !followedSyncSourceActiveEqual(active, source)) { return; }
      }
      this.rememberLatestIntents([await this._options.append({
        contextId : source.contextId,
        following : false,
        group,
        ownerDid  : source.sourceDid,
      }, before?.timestamp)]);
      const latest = (await this.readLatestIntents()).get(key);
      if (latest?.value.following === false) {
        await this.applyForget(latest);
      }
    });
  }

  /** Restore currently known intent once; owner unavailability never removes that intent. */
  public async restore(): Promise<void> {
    await this.readLatestIntents();
    await Promise.all([...this._latestIntentRecords.keys()].map((key): Promise<void> =>
      this.enqueue(key, (): Promise<void> => this.restoreContext(key))));
  }

  /** Retry retained intent when the owning protocol's existing sync lifecycle recovers. */
  public retry(): void {
    const observation = this._observation;
    if (observation !== undefined && this.isObserving(observation)) {
      observation.attempts.clear();
      this.requestReconciliation(observation);
    }
  }

  /** Retain one shared native journal view without waiting for remote owners to respond. */
  public async observe(onError: (error: Error) => void, signal?: AbortSignal): Promise<{ close(): Promise<void> }> {
    this.assertActive();
    signal?.throwIfAborted();
    const observation = this._observation ?? this.openObservation();
    const listener = (error: Error): void => onError(error);
    observation.listeners.add(listener);
    let closed: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closed !== undefined) {
        return closed;
      }
      signal?.removeEventListener('abort', abort);
      observation.listeners.delete(listener);
      // Each caller owns one lease; only the final release closes the shared native view.
      closed = observation.listeners.size === 0 ? this.closeObservation(observation) : Promise.resolve();
      return closed;
    };
    const abort = (): void => { void close().catch((): void => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await observation.opening;
      this.assertActive();
      signal?.throwIfAborted();
      return { close };
    } catch (error: unknown) {
      await close();
      throw error;
    }
  }

  private openObservation(): Observation {
    const observation: Observation = {
      attempts   : new Map(),
      controller : new AbortController(),
      draining   : false,
      listeners  : new Set(),
      opening    : Promise.resolve(),
      requested  : false,
    };
    this._observation = observation;
    const signal = this._options.signal === undefined ? observation.controller.signal
      : AbortSignal.any([observation.controller.signal, this._options.signal]);
    observation.opening = Promise.resolve().then(async (): Promise<void> => {
      const view = await this._options.openView(signal);
      if (!this.isObserving(observation)) {
        await view.close();
        return;
      }
      observation.view = view;
      observation.unsubscribe = view.subscribe((): void => { this.requestReconciliation(observation); });
      this.requestReconciliation(observation);
    });
    return observation;
  }

  private async closeObservation(observation: Observation): Promise<void> {
    if (this._observation === observation) {
      this._observation = undefined;
    }
    observation.controller.abort();
    observation.unsubscribe?.();
    await observation.opening.catch((): void => {});
    await observation.view?.close();
  }

  /** Drain native pagination before scheduling independent per-context restoration. */
  private requestReconciliation(observation: Observation): void {
    // Opening requests the initial pass after assigning the view, even if sync wakes arrived earlier.
    if (!this.isObserving(observation) || observation.view === undefined) {
      return;
    }
    observation.requested = true;
    if (observation.draining) {
      return;
    }
    observation.draining = true;
    void this.reconcileObservation(observation).catch((error: unknown): void => {
      this.report(observation, error);
    }).finally((): void => {
      observation.draining = false;
      if (observation.requested && this.isObserving(observation)) {
        this.requestReconciliation(observation);
      }
    });
  }

  private async reconcileObservation(observation: Observation): Promise<void> {
    const view = observation.view!;
    while (observation.requested && this.isObserving(observation)) {
      observation.requested = false;
      await view.ready({ signal: observation.controller.signal });
      while (this.isObserving(observation) && view.getSnapshot().hasMore) {
        await view.loadMore();
      }
      if (!this.isObserving(observation)) {
        return;
      }
      const state = view.getSnapshot();
      if (state.status === 'error') {
        throw state.error;
      }
      this.rememberLatestIntents(state.records);
      for (const [key, record] of this._latestIntentRecords) {
        // Queue completion resumes a retry once; sync wakes must not pile up owner lookups.
        if (sameRecord(observation.attempts.get(key), record) || this._pendingOperations.has(key)) {
          continue;
        }
        observation.attempts.set(key, record);
        void this.enqueue(key, async (): Promise<void> => {
          if (this.isObserving(observation)) {
            await this.restoreContext(key);
          }
        }).catch((error: unknown): void => { this.report(observation, error); });
      }
    }
  }

  private async restoreContext(key: string): Promise<void> {
    const current = this._latestIntentRecords.get(key)!;
    const intent = current.value;
    if (!intent.following) {
      await this.applyForget(current);
      return;
    }
    const roles = this._options.roleGroups[intent.group];
    if (roles === undefined) { return; }
    const sources = await this.listSources(intent);
    if (sources.some((source): boolean => sameRoles(source.roles, roles))) {
      return;
    }
    let accepted: FollowedSyncSource;
    try {
      accepted = await this._options.sync.followSource({
        actorDid  : this._options.actorDid,
        contextId : intent.contextId,
        protocol  : this._options.protocol,
        roles     : [...roles],
        sourceDid : intent.ownerDid,
      });
    } catch {
      this.assertActive();
      return;
    }
    const latest = (await this.readLatestIntents()).get(key);
    // Another device can write the same choice; a newer record alone does not invalidate access.
    if (latest?.value.following === false) {
      await this.applyForget(latest);
    } else if (latest?.value.group !== intent.group) {
      await this._options.sync.deleteFollowedSource(accepted);
    }
  }

  /** Exact deletion can lose a race to role recovery; finish the current forget without cancelling newer intent. */
  private async applyForget(record: ContextFollowRecord): Promise<void> {
    const key = contextKey(record.value.ownerDid, record.value.contextId);
    let sources = await this.listSources(record.value);
    while (sources.length > 0 && this._latestIntentRecords.get(key)?.value.following === false) {
      await Promise.all(sources.map((source): Promise<void> => this._options.sync.deleteFollowedSource(source)));
      await this.readLatestIntents();
      if (this._latestIntentRecords.get(key)?.value.following !== false) { return; }
      sources = await this.listSources(record.value);
    }
  }

  private async listSources(intent: ContextFollowIntent): Promise<FollowedSyncSource[]> {
    const sources = await this._options.sync.listFollowedSources();
    this.assertActive();
    return sources.filter((source): boolean =>
      source.actorDid === this._options.actorDid && source.protocol === this._options.protocol
      && source.sourceDid === intent.ownerDid && source.contextId === intent.contextId);
  }

  /** Missing records are not a forget; only newer immutable decisions replace known intent. */
  private rememberLatestIntents(records: readonly ContextFollowRecord[]): void {
    for (const record of records) {
      const key = contextKey(record.value.ownerDid, record.value.contextId);
      const previous = this._latestIntentRecords.get(key);
      if (previous === undefined || record.timestamp > previous.timestamp
        || (record.timestamp === previous.timestamp && record.id > previous.id)) {
        this._latestIntentRecords.set(key, record);
      }
    }
  }

  /** Merge a local journal read and return the current decisions for immediate selection. */
  private async readLatestIntents(): Promise<ReadonlyMap<string, ContextFollowRecord>> {
    this.assertActive();
    const records = await this._options.read();
    this.assertActive();
    this.rememberLatestIntents(records);
    return this._latestIntentRecords;
  }

  /** Select the declared role paths; current owner-hosted records determine the actual role. */
  private getRolePaths(group: string): readonly [string, ...string[]] {
    const roles = this._options.roleGroups[group];
    if (roles === undefined) {
      throw new TypeError(`ContextFollowing: unknown role group '${group}'.`);
    }
    return roles;
  }

  /** Serialize one context's operations while allowing unrelated contexts to proceed independently. */
  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    // A failed operation must not prevent the next follow, forget, or restoration attempt.
    const task = (this._pendingOperations.get(key) ?? Promise.resolve()).catch((): void => {}).then((): Promise<T> => {
      this.assertActive();
      return operation();
    });
    this._pendingOperations.set(key, task);
    const release = (): void => {
      if (this._pendingOperations.get(key) === task) {
        this._pendingOperations.delete(key);
        const observation = this._observation;
        if (observation !== undefined
          && !sameRecord(observation.attempts.get(key), this._latestIntentRecords.get(key))) {
          this.requestReconciliation(observation);
        }
      }
    };
    void task.then(release, release);
    return task;
  }

  private assertActive(): void {
    this._options.signal?.throwIfAborted();
  }

  private isObserving(observation: Observation): boolean {
    return this._observation === observation && !observation.controller.signal.aborted && !this._options.signal?.aborted;
  }

  private report(observation: Observation, error: unknown): void {
    if (this.isObserving(observation)) {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const listener of observation.listeners) { listener(failure); }
    }
  }
}

function contextKey(ownerDid: string, contextId: string): string {
  return JSON.stringify([ownerDid, contextId]);
}

function sameRecord(left: ContextFollowRecord | undefined, right: ContextFollowRecord | undefined): boolean {
  return left?.id === right?.id && left?.timestamp === right?.timestamp;
}

function sameRoles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((role, index): boolean => role === right[index]);
}
