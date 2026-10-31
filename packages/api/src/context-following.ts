import type { ContextFollowIntent } from './shared-context-protocol.js';
import type { ContextFollowTarget } from './typed-enbox.js';
import type { ExpandableRecordView } from './record-view.js';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { SavedContextFollow } from './context-view.js';
import type { FollowedSyncSource, SyncEngine, SyncEvent } from '@enbox/agent';

import { ContextRetiredError } from './context-errors.js';
import { protocolContextKey } from './shared-context-protocol.js';
import { FilterUtility, resolveProtocolContextRoles } from '@enbox/dwn-sdk-js';
import { FollowedSourceNotReadyError, followedSyncSourceActiveEqual, syncEventCoversProtocol } from '@enbox/agent';

/** One decoded immutable decision in the recipient's private following journal. */
export type ContextFollowRecord = Readonly<{
  id: string;
  timestamp: string;
  value: ContextFollowIntent;
}>;

/** Coordinates and the exact protocol context root selected by contexts.follow(). */
type FollowRequest = ContextFollowTarget & Readonly<{
  path: string;
}>;
type FollowSync = Pick<SyncEngine, 'followSource' | 'getFollowedSource' | 'listFollowedSources' | 'deleteFollowedSource'>;

/** @internal Native records supply persistence; the sync engine verifies remote authority. */
export type ContextFollowingOptions = {
  actorDid: string;
  append(intent: ContextFollowIntent, after?: string): Promise<ContextFollowRecord>;
  definition: ProtocolDefinition;
  openView(signal: AbortSignal): Promise<ExpandableRecordView<ContextFollowRecord>>;
  read(): Promise<readonly ContextFollowRecord[]>;
  signal?: AbortSignal;
  sync: FollowSync;
};

type Observation = {
  /** Last attempted record ID per context, including failures; relevant recovery events clear these. */
  attemptedRecordIds: Map<string, string>;
  controller: AbortController;
  draining?: Promise<void>;
  listeners: Set<FollowingObserver>;
  opening: Promise<void>;
  requested: boolean;
  view?: ExpandableRecordView<ContextFollowRecord>;
};

type FollowingObserver = Readonly<{
  onChange?(): void;
  onError(error: Error): void;
  signal?: AbortSignal;
}>;

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

  /** Project saved choices in key order, independently of whether this device can verify their owners. */
  public getSavedFollows(): readonly SavedContextFollow[] {
    return [...this._latestIntentRecords].flatMap(([key, { value }]): SavedContextFollow[] => value.following
      ? [{ key, id: value.contextId, ownerDid: value.ownerDid, path: value.path }] : [])
      .sort((left, right): number => {
        if (left.key < right.key) { return -1; }
        return left.key > right.key ? 1 : 0;
      });
  }

  /** Verify an explicit follow, then persist the user's decision before returning success. */
  public follow(request: FollowRequest): Promise<FollowedSyncSource> {
    const key = protocolContextKey(request.ownerDid, request.id);
    return this.serializeContextOperation(key, async (): Promise<FollowedSyncSource> => {
      const roles = this.resolveContextRoles(request.path, request.id);
      const initialDecision = (await this.readLatestIntents()).get(key);
      const acceptedBeforeFollow = await this._options.sync.listFollowedSources();
      const source = await this.verifyAndAcceptContext(request, roles);
      const wroteDecision = await this.saveFollowUnlessNewerForget(request, initialDecision)
        .catch((error: unknown): Promise<never> => this.rollbackFailedFollow(source, acceptedBeforeFollow, error));

      if (wroteDecision) {
        // Include decisions received during the write; read failures here must not undo saved access.
        await this.readLatestIntents();
      }
      await this.rejectFollowIfForgotten(request);
      return source;
    });
  }

  /** Save the user's forget choice even when no local acceptance or reachable owner exists. */
  public forgetContext(target: ContextFollowTarget): Promise<void> {
    const key = protocolContextKey(target.ownerDid, target.id);
    return this.serializeContextOperation(key, async (): Promise<void> => {
      const previous = (await this.readLatestIntents()).get(key);
      await this.saveForgetDecision(target, previous);
    });
  }

  /**
   * Forget through an exact live handle. Leave must first withdraw that handle's
   * owner role; a stale handle cannot alter a newer acceptance or saved choice.
   */
  public forget(source: FollowedSyncSource, withdrawRole?: () => Promise<void>): Promise<void> {
    const target = { id: source.contextId, ownerDid: source.sourceDid };
    const key = protocolContextKey(target.ownerDid, target.id);
    return this.serializeContextOperation(key, async (): Promise<void> => {
      const current = await this._options.sync.getFollowedSource(source.id);
      this.assertActive();
      if (current === undefined || !followedSyncSourceActiveEqual(current, source)) {
        if (withdrawRole !== undefined) { throw new ContextRetiredError(source.contextId); }
        return;
      }
      const previous = (await this.readLatestIntents()).get(key);
      if (withdrawRole !== undefined) {
        await withdrawRole();
        await this.readLatestIntents();
      } else {
        const active = await this._options.sync.getFollowedSource(source.id);
        this.assertActive();
        if (active === undefined || !followedSyncSourceActiveEqual(active, source)) { return; }
      }
      // A newer observed choice wins even when the acceptance itself is unchanged.
      const received = this._latestIntentRecords.get(key);
      if (!sameRecord(previous, received)) {
        if (received?.value.following === false) {
          await this.removeForgottenAcceptances(received);
        }
        return;
      }
      await this.saveForgetDecision(target, previous);
    });
  }

  /** Restore currently known intent once; owner unavailability never removes that intent. */
  public async restore(): Promise<void> {
    await this.readLatestIntents();
    await Promise.all([...this._latestIntentRecords.keys()].map((key): Promise<void> =>
      this.serializeContextOperation(key, (): Promise<void> => this.restoreContext(key))));
  }

  /** Retry only choices covered by a relevant session or owner recovery event. */
  public retryAfterSync(event: SyncEvent): void {
    switch (event.type) {
      case 'pull:currentness-change':
        // Owner role links can toggle currentness during ordinary settle probes.
        if (event.tenantDid !== this._options.actorDid || !event.to) { return; }
        break;
      case 'link:connectivity-change':
        if (event.to !== 'online') { return; }
        break;
      case 'reconcile:completed':
        break;
      default:
        return;
    }
    if (!syncEventCoversProtocol(event, this._options.definition.protocol)) { return; }
    const observation = this._observation;
    if (observation === undefined || !this.isObserving(observation)) { return; }
    if (event.tenantDid === this._options.actorDid) {
      observation.attemptedRecordIds.clear();
      void this.requestReconciliation(observation);
      return;
    }
    let matched = false;
    for (const [key, record] of this._latestIntentRecords) {
      if (record.value.ownerDid === event.tenantDid
        && (event.contextId === undefined || FilterUtility.matchesSubtree(event.contextId, record.value.contextId))) {
        observation.attemptedRecordIds.delete(key);
        matched = true;
      }
    }
    if (matched) { void this.requestReconciliation(observation); }
  }

  /** Read the local journal and retain its shared view without waiting for remote owners. */
  public async observe(observer: FollowingObserver): Promise<{ close(): Promise<void> }> {
    const { signal } = observer;
    this.assertActive();
    signal?.throwIfAborted();
    const observation = this._observation ?? this.openObservation();
    const listener = { ...observer };
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

  /** Save a forget once, then retire access only while that choice still wins. */
  private async saveForgetDecision(target: ContextFollowTarget, previous: ContextFollowRecord | undefined): Promise<void> {
    const key = protocolContextKey(target.ownerDid, target.id);
    // A repeated forget only needs cleanup; a newer follow received meanwhile must remain authoritative.
    if (previous?.value.following !== false && this._latestIntentRecords.get(key)?.value.following !== false) {
      this.rememberLatestIntents([await this._options.append({
        contextId : target.id,
        following : false,
        ownerDid  : target.ownerDid,
      }, previous?.timestamp)]);
    }
    const latest = (await this.readLatestIntents()).get(key);
    if (latest?.value.following === false) {
      await this.removeForgottenAcceptances(latest);
    }
  }

  /** Verify current owner-hosted membership and establish or reuse this device's acceptance. */
  private verifyAndAcceptContext(request: FollowRequest, roles: readonly [string, ...string[]]): Promise<FollowedSyncSource> {
    this.assertActive();
    return this._options.sync.followSource({
      actorDid  : this._options.actorDid,
      contextId : request.id,
      protocol  : this._options.definition.protocol,
      roles     : [...roles],
      sourceDid : request.ownerDid,
    });
  }

  /** Skip an equivalent choice or newer forget; return whether this call appended a follow decision. */
  private async saveFollowUnlessNewerForget(
    request: FollowRequest,
    initialDecision: ContextFollowRecord | undefined,
  ): Promise<boolean> {
    const key = protocolContextKey(request.ownerDid, request.id);
    const latest = (await this.readLatestIntents()).get(key);
    if (latest?.value.following === true && latest.value.path === request.path) {
      return false;
    }
    // An older forget can be reversed by this follow; a forget received since it began wins.
    if (!sameRecord(initialDecision, latest) && latest?.value.following === false) {
      return false;
    }
    const written = await this._options.append({
      contextId : request.id,
      following : true,
      path      : request.path,
      ownerDid  : request.ownerDid,
    }, latest?.timestamp);
    this.rememberLatestIntents([written]);
    return true;
  }

  /** Undo only a new, unsaved acceptance, then rethrow the failure that prevented saving. */
  private async rollbackFailedFollow(
    source: FollowedSyncSource,
    acceptedBeforeFollow: readonly FollowedSyncSource[],
    error: unknown,
  ): Promise<never> {
    // After this facade ends, its replacement may already be using the same acceptance.
    if (!this._options.signal?.aborted
      && !acceptedBeforeFollow.some((previous): boolean => followedSyncSourceActiveEqual(previous, source))) {
      try {
        await this._options.sync.deleteFollowedSource(source);
        // Reverify the current saved policy after rollback; never reinstall captured authority.
        this._observation?.attemptedRecordIds.delete(protocolContextKey(source.sourceDid, source.contextId));
      } catch (retireError: unknown) {
        throw new AggregateError([error, retireError], 'ContextFollowing: unable to complete or retire the new acceptance.');
      }
    }
    throw error;
  }

  /** A saved forget retires access; positive discovery choices never revoke verified authority. */
  private async rejectFollowIfForgotten(request: FollowRequest): Promise<void> {
    const latest = this._latestIntentRecords.get(protocolContextKey(request.ownerDid, request.id));
    if (latest?.value.following === false) {
      await this.removeForgottenAcceptances(latest);
      throw new ContextRetiredError(request.id);
    }
  }

  private openObservation(): Observation {
    const observation: Observation = {
      attemptedRecordIds : new Map(),
      controller         : new AbortController(),
      listeners          : new Set(),
      opening            : Promise.resolve(),
      requested          : false,
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
      view.subscribe((): void => { void this.requestReconciliation(observation); });
      await this.requestReconciliation(observation);
    });
    return observation;
  }

  private async closeObservation(observation: Observation): Promise<void> {
    if (this._observation === observation) {
      this._observation = undefined;
    }
    observation.controller.abort();
    await observation.opening.catch((): void => {});
    await observation.view?.close();
  }

  /** Serialize journal reads and report failures to observers; initial hydration also awaits the result. */
  private requestReconciliation(observation: Observation): Promise<void> {
    // Opening requests the initial pass after assigning the view, even if sync wakes arrived earlier.
    if (!this.isObserving(observation) || observation.view === undefined) {
      return Promise.resolve();
    }
    observation.requested = true;
    if (observation.draining !== undefined) {
      return observation.draining;
    }
    const task = this.reconcileObservation(observation);
    observation.draining = task;
    const finish = (): void => {
      observation.draining = undefined;
      if (observation.requested) {
        void this.requestReconciliation(observation);
      }
    };
    void task.then(finish, (error: unknown): void => {
      this.report(observation, error);
      finish();
    });
    return task;
  }

  private async reconcileObservation(observation: Observation): Promise<void> {
    const view = observation.view!;
    observation.requested = false;
    await view.ready({ signal: observation.controller.signal });
    while (this.isObserving(observation) && view.getSnapshot().hasMore) {
      await view.loadMore(); // NOSONAR: S9382 - each expansion determines whether another page is needed.
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
      if (observation.attemptedRecordIds.get(key) === record.id || this._pendingOperations.has(key)) {
        continue;
      }
      observation.attemptedRecordIds.set(key, record.id);
      void this.serializeContextOperation(key, async (): Promise<void> => {
        if (this.isObserving(observation)) {
          await this.restoreContext(key);
        }
      }).catch((error: unknown): void => { this.report(observation, error); });
    }
  }

  private async restoreContext(key: string): Promise<void> {
    const current = this._latestIntentRecords.get(key)!;
    const intent = current.value;
    if (!intent.following) {
      await this.removeForgottenAcceptances(current);
      return;
    }
    let roles: readonly [string, ...string[]];
    try {
      roles = this.resolveContextRoles(intent.path, intent.contextId);
    } catch (error: unknown) {
      // Keep an unsupported saved target without replaying an older choice or revoking existing access.
      if (error instanceof TypeError) { return; }
      throw error;
    }
    const sources = await this.listAcceptedContextSources(intent);
    if (!sources.some((source): boolean => sameRoles(source.roles, roles))) {
      await this.verifyAndAcceptContext({
        path     : intent.path,
        id       : intent.contextId,
        ownerDid : intent.ownerDid,
      }, roles).then(
        () => this.readLatestIntents(),
        (error: unknown): void => {
          this.assertActive();
          if (!(error instanceof FollowedSourceNotReadyError)) {
            console.warn('[@enbox/api] Unable to restore a saved context; the follow choice is retained.', error);
          }
        },
      );
    }
    // Reusing access or failing verification can also yield to a newer observed forget.
    const latest = this._latestIntentRecords.get(key);
    if (latest?.value.following === false) {
      await this.removeForgottenAcceptances(latest);
    }
  }

  /** Exact deletion can lose a race to role recovery; finish the current forget without cancelling newer intent. */
  private async removeForgottenAcceptances(record: ContextFollowRecord): Promise<void> {
    const key = protocolContextKey(record.value.ownerDid, record.value.contextId);
    let sources = await this.listAcceptedContextSources(record.value);
    while (sources.length > 0 && this._latestIntentRecords.get(key)?.value.following === false) {
      await Promise.all(sources.map((source): Promise<void> => this._options.sync.deleteFollowedSource(source)));
      await this.readLatestIntents();
      if (this._latestIntentRecords.get(key)?.value.following !== false) { return; }
      sources = await this.listAcceptedContextSources(record.value); // NOSONAR: S9382 - reread after deletion and the latest decision.
    }
  }

  private async listAcceptedContextSources(intent: ContextFollowIntent): Promise<FollowedSyncSource[]> {
    const sources = await this._options.sync.listFollowedSources();
    this.assertActive();
    return sources.filter((source): boolean =>
      source.actorDid === this._options.actorDid && source.protocol === this._options.definition.protocol
      && source.sourceDid === intent.ownerDid && source.contextId === intent.contextId);
  }

  /** Missing records are not a forget; only newer immutable decisions replace known intent. */
  private rememberLatestIntents(records: readonly ContextFollowRecord[]): void {
    let changed = false;
    for (const record of records) {
      const key = protocolContextKey(record.value.ownerDid, record.value.contextId);
      const previous = this._latestIntentRecords.get(key);
      if (previous === undefined || record.timestamp > previous.timestamp
        || (record.timestamp === previous.timestamp && record.id > previous.id)) {
        this._latestIntentRecords.set(key, record);
        changed = true;
      }
    }
    if (changed && this._observation !== undefined) {
      this.notifyObservers(this._observation, (listener): void => { listener.onChange?.(); });
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

  /** Use the exact root's authored read order; owner-hosted records determine the available role. */
  private resolveContextRoles(path: string, contextId: string): readonly [string, ...string[]] {
    if (path.split('/').length !== contextId.split('/').length) {
      throw new TypeError(`ContextFollowing: context ID does not identify a '${path}' root.`);
    }
    const roles = resolveProtocolContextRoles(this._options.definition, path);
    if (roles.length === 0) {
      throw new TypeError(`ContextFollowing: '${path}' is not a shared context root.`);
    }
    return roles as readonly [string, ...string[]];
  }

  /** Serialize one context's operations while allowing unrelated contexts to proceed independently. */
  private serializeContextOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
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
          && observation.attemptedRecordIds.get(key) !== this._latestIntentRecords.get(key)?.id) {
          void this.requestReconciliation(observation);
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
    return this._observation === observation && !this._options.signal?.aborted;
  }

  private report(observation: Observation, error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.notifyObservers(observation, (listener): void => { listener.onError(failure); });
  }

  private notifyObservers(observation: Observation, notify: (listener: FollowingObserver) => void): void {
    if (this.isObserving(observation)) {
      // Subscription changes during delivery apply to the next notification.
      const listeners = [...observation.listeners];
      for (const listener of listeners) {
        try {
          notify(listener);
        } catch {
          // One consumer must not prevent other leases from receiving the notification.
        }
      }
    }
  }
}

function sameRecord(left: ContextFollowRecord | undefined, right: ContextFollowRecord | undefined): boolean {
  return left?.id === right?.id;
}

function sameRoles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((role, index): boolean => role === right[index]);
}
