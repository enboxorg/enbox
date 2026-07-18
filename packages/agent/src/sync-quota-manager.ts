import type { GenericMessage } from '@enbox/dwn-sdk-js';

import type { SyncMessageEntry } from './sync-messages.js';
import type { SyncTarget } from './sync-target-resolver.js';
import type { PushAcknowledgement, PushFailure, PushResult, PushSuccessResolution } from './types/sync.js';
import type {
  SyncQuotaBlockSource,
  SyncQuotaBlockState,
  SyncQuotaStore,
} from './sync-quota-store.js';

import { DwnInterfaceName, DwnMethodName, Message } from '@enbox/dwn-sdk-js';

import { buildLinkId } from './sync-link-id.js';
import { isQuotaBlockedPushFailure, isTerminalPushFailure, lexicographicalCompare, protocolsForSyncScope } from './types/sync.js';

/** One quota row paired with the CID used by feed policy. */
export type SyncQuotaBlockEntry = {
  messageCid: string;
  state: SyncQuotaBlockState;
};

/** Folded quota and failure state produced by one push result. */
export type SyncQuotaPushResultTransition = {
  nextQuotaProbeAt?: string;
  quotaBlocked: boolean;
  retryableFailures: PushFailure[];
  terminalFailures: PushFailure[];
};

/** Optional attribution applied while folding a push result. */
export type SyncQuotaPushTransitionOptions = {
  protocol?: string;
  source?: SyncQuotaBlockSource;
};

/** Engine-owned effects required by backend-neutral quota policy. */
export interface SyncQuotaManagerOperations {
  clearFailedMessage(target: SyncTarget, messageCid: string): Promise<void>;

  collectLocalFeedCids(target: SyncTarget): Promise<Set<string> | undefined>;

  collectRemoteFeedCids(target: SyncTarget): Promise<Set<string> | undefined>;

  getLocalMessage(target: SyncTarget, messageCid: string): Promise<SyncMessageEntry | undefined>;

  onQuotaBlocked(target: SyncTarget, messageCid: string, detail: string | undefined, nextProbeAt: string): void;

  onQuotaCleared(target: SyncTarget, messageCid: string, resolution: PushSuccessResolution): void;

  pushEntries(target: SyncTarget, entries: SyncMessageEntry[]): Promise<PushResult>;

  pushMessages(target: SyncTarget, messageCids: string[]): Promise<PushResult>;

  recordTerminalFailure(target: SyncTarget, failure: PushFailure): Promise<void>;
}

export type SyncQuotaManagerParams = {
  operations: SyncQuotaManagerOperations;
  store: SyncQuotaStore;
};

/**
 * Owns durable quota-block lifecycle and retry policy independently of a
 * particular sync-engine storage backend.
 *
 * Transport, feed inventory, dead-letter policy, and event delivery remain
 * injected effects. A Level- or SQLite-backed engine can therefore reuse the
 * same backoff, acknowledgement folding, stale-result guards, and omission
 * accounting with its own `SyncQuotaStore` implementation.
 */
export class SyncQuotaManager {
  /** 30s, 1m, 5m, 15m, then 30m (clamped). */
  private static readonly BLOCK_BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 1_800_000];

  private readonly _operations: SyncQuotaManagerOperations;
  private readonly _probes: Map<string, Promise<void>> = new Map();
  private readonly _store: SyncQuotaStore;

  constructor({ operations, store }: SyncQuotaManagerParams) {
    this._operations = operations;
    this._store = store;
  }

  public clear(): Promise<void> {
    return this._store.clear();
  }

  public clearTenant(tenantDid: string): Promise<void> {
    return this._store.deleteForTenant(tenantDid);
  }

  public getAllStates(): Promise<SyncQuotaBlockState[]> {
    return this._store.getAll();
  }

  public getLinkKey(target: SyncTarget): string {
    return buildLinkId(target.did, target.dwnUrl, target.projectionId, target.authorizationEpoch);
  }

  public getState(target: SyncTarget, messageCid: string): Promise<SyncQuotaBlockState | undefined> {
    return this._store.get(target.did, this.getLinkKey(target), messageCid);
  }

  /** Record a fresh quota block or extend an existing block's backoff. */
  public async recordBlock(
    target: SyncTarget,
    messageCid: string,
    protocol: string | undefined,
    detail: string | undefined,
    source: SyncQuotaBlockSource = 'feed',
    blockedCid = messageCid,
  ): Promise<SyncQuotaBlockState> {
    const previous = await this.getState(target, messageCid);
    // A stale in-flight quota result cannot reactivate an omission that a
    // newer same-record acknowledgement permanently resolved.
    if (previous?.supersededAt !== undefined) {
      return previous;
    }

    const now = Date.now();
    const attempts = (previous?.attempts ?? 0) + 1;
    const delay = SyncQuotaManager.BLOCK_BACKOFF_MS[
      Math.min(attempts - 1, SyncQuotaManager.BLOCK_BACKOFF_MS.length - 1)
    ];
    const state: SyncQuotaBlockState = {
      attempts,
      authorizationEpoch : target.authorizationEpoch,
      blockedCid,
      detail,
      firstBlockedAt     : previous?.firstBlockedAt ?? new Date(now).toISOString(),
      lastBlockedAt      : new Date(now).toISOString(),
      linkKey            : this.getLinkKey(target),
      messageCid,
      nextProbeAt        : new Date(now + delay).toISOString(),
      projectionId       : target.projectionId,
      protocol           : protocol ?? previous?.protocol,
      remoteEndpoint     : target.dwnUrl,
      source,
      tenantDid          : target.did,
    };
    await this._store.put(state);
    return state;
  }

  public clearBlock(target: SyncTarget, messageCid: string): Promise<boolean> {
    return this.clearBlockByLinkKey(target.did, this.getLinkKey(target), messageCid);
  }

  public clearBlockByLinkKey(tenantDid: string, linkKey: string, messageCid: string): Promise<boolean> {
    return this._store.delete(tenantDid, linkKey, messageCid);
  }

  /** Apply push outcomes consistently for feed, live, bootstrap, and direct probes. */
  public async transitionPushResult(
    target: SyncTarget,
    result: PushResult,
    options?: SyncQuotaPushTransitionOptions,
  ): Promise<SyncQuotaPushResultTransition> {
    const transition: SyncQuotaPushResultTransition = {
      quotaBlocked      : false,
      retryableFailures : [],
      terminalFailures  : [],
    };
    const acknowledgementsByCid = new Map<string, PushAcknowledgement>(
      (result.acknowledged ?? []).map((acknowledgement) => [acknowledgement.cid, acknowledgement] as const),
    );
    for (const cid of result.succeeded) {
      if (!acknowledgementsByCid.has(cid)) {
        acknowledgementsByCid.set(cid, { cid, resolution: 'applied' });
      }
    }

    await this.applyPushAcknowledgements(target, acknowledgementsByCid);

    for (const originalFailure of result.failed) {
      if (acknowledgementsByCid.has(originalFailure.cid)) {
        continue;
      }
      const failure: PushFailure = {
        ...originalFailure,
        protocol: originalFailure.protocol ?? options?.protocol,
      };
      await this.applyPushFailureOutcome(target, failure, options?.source, transition);
    }

    return transition;
  }

  /** Re-probe due feed roots independently of the feed checkpoint that advanced past them. */
  public async probeBlocksForTarget(
    target: SyncTarget,
    force = false,
    forceProbeCids?: Set<string>,
    shouldContinue?: () => boolean,
  ): Promise<void> {
    const dueCids: string[] = [];
    for (const { messageCid, state } of await this.getActiveBlocksForTarget(target)) {
      if (state.source === 'permission-grant') { continue; }
      const nextProbeAt = Date.parse(state.nextProbeAt);
      const isForced = force && (forceProbeCids === undefined || forceProbeCids.has(messageCid));
      if (isForced || !Number.isFinite(nextProbeAt) || Date.now() >= nextProbeAt) {
        dueCids.push(messageCid);
      }
    }

    for (const messageCid of dueCids) {
      if (SyncQuotaManager.shouldAbort(shouldContinue)) {
        return;
      }
      await this.probeBlock(
        target,
        messageCid,
        force && (forceProbeCids === undefined || forceProbeCids.has(messageCid)),
        shouldContinue,
      );
    }
  }

  public async pruneForCurrentTargets(
    targets: SyncTarget[],
    isCurrent: () => boolean,
  ): Promise<void> {
    const currentLinkKeys = new Set(targets.map((target) => this.getLinkKey(target)));
    const registeredTenants = new Set(targets.map((target) => target.did));
    const staleStates = (await this._store.getAll()).filter(
      (state) => registeredTenants.has(state.tenantDid) && !currentLinkKeys.has(state.linkKey),
    );
    if (!isCurrent()) {
      return;
    }
    await this._store.deleteMany(staleStates);
  }

  public async getActiveBlocksForTarget(target: SyncTarget): Promise<SyncQuotaBlockEntry[]> {
    return (await this.getStatesForTarget(target))
      .filter(({ state }) => state.supersededAt === undefined);
  }

  /** Includes resolved omissions retained solely for exact feed-divergence accounting. */
  public async getStatesForTarget(target: SyncTarget): Promise<SyncQuotaBlockEntry[]> {
    const linkKey = this.getLinkKey(target);
    const targetProtocols = protocolsForSyncScope(target.scope);
    const states = await this._store.getForTenant(target.did);
    return states
      .filter((state) => state.linkKey === linkKey)
      .filter((state) => targetProtocols === undefined || state.protocol === undefined || targetProtocols.includes(state.protocol))
      .map((state) => ({ messageCid: state.messageCid, state }));
  }

  public async clearResolvedOmissionsForTarget(target: SyncTarget): Promise<void> {
    for (const { messageCid, state } of await this.getStatesForTarget(target)) {
      if (state.supersededAt !== undefined) {
        await this.clearBlock(target, messageCid);
      }
    }
  }

  public async getNextProbeAtForTarget(target: SyncTarget): Promise<string | undefined> {
    let nextFeedProbeAt: string | undefined;
    let grantBundleProbeAt: string | undefined;
    for (const block of await this.getActiveBlocksForTarget(target)) {
      if (block.state.source === 'permission-grant') {
        // A delegated target's grants form one authorization bundle. Wait for
        // every blocked grant so a past-due sibling cannot schedule a busy loop.
        grantBundleProbeAt = SyncQuotaManager.latestTimestamp(grantBundleProbeAt, block.state.nextProbeAt);
      } else {
        nextFeedProbeAt = SyncQuotaManager.earliestTimestamp(nextFeedProbeAt, block.state.nextProbeAt);
      }
    }
    if (grantBundleProbeAt === undefined) { return nextFeedProbeAt; }
    if (nextFeedProbeAt === undefined) { return grantBundleProbeAt; }
    return SyncQuotaManager.earliestTimestamp(nextFeedProbeAt, grantBundleProbeAt);
  }

  /**
   * Return whether every exact feed difference is explained by this link's
   * durable quota omissions, reconciling locally retired rows along the way.
   */
  public async isFeedDivergenceExplained(
    target: SyncTarget,
    result: { quotaBlocked?: boolean },
  ): Promise<boolean> {
    let blocks = await this.getStatesForTarget(target);
    if (blocks.length === 0) { return false; }

    if (result.quotaBlocked === true && blocks.some(({ state }) => state.source === 'permission-grant')) {
      return true;
    }

    const [localCids, remoteCids] = await Promise.all([
      this._operations.collectLocalFeedCids(target),
      this._operations.collectRemoteFeedCids(target),
    ]);
    if (localCids === undefined || remoteCids === undefined) { return false; }

    for (const block of blocks) {
      await this.reconcileBlockAgainstFeed(target, block, localCids, remoteCids);
    }

    blocks = await this.getStatesForTarget(target);
    if (blocks.length === 0) {
      return localCids.size === remoteCids.size &&
        [...localCids].every((cid) => remoteCids.has(cid));
    }
    const omittedCids = SyncQuotaManager.collectOmittedCids(blocks, localCids);
    const localOnly = [...localCids].filter((cid) => !remoteCids.has(cid));
    const remoteOnly = [...remoteCids].filter((cid) => !localCids.has(cid));

    return remoteOnly.length === 0 &&
      localOnly.length > 0 &&
      localOnly.every((cid) => omittedCids.has(cid));
  }

  private async clearBlockWithResolution(
    target: SyncTarget,
    messageCid: string,
    resolution: PushSuccessResolution,
    preserveSupersededOmission = false,
  ): Promise<void> {
    const state = await this.getState(target, messageCid);
    if (
      preserveSupersededOmission &&
      resolution === 'superseded' &&
      state !== undefined &&
      state.source !== 'permission-grant'
    ) {
      await this.markBlockAsSupersededOmission(target, messageCid, state);
      return;
    }
    if (!await this.clearBlock(target, messageCid)) {
      return;
    }
    if (state?.supersededAt !== undefined) {
      return;
    }

    this._operations.onQuotaCleared(target, messageCid, resolution);
  }

  public async resolveBlocksSupersededByAcknowledgement(
    target: SyncTarget,
    acknowledgedCid: string,
  ): Promise<void> {
    const activeBlocks = await this.getActiveBlocksForTarget(target);
    if (activeBlocks.length === 0) { return; }

    const acknowledged = await this._operations.getLocalMessage(target, acknowledgedCid);
    if (acknowledged === undefined) { return; }

    for (const { messageCid, state } of activeBlocks) {
      if (messageCid === acknowledgedCid || state.source === 'permission-grant') { continue; }
      const blockedRoot = await this._operations.getLocalMessage(target, messageCid);
      if (
        blockedRoot === undefined ||
        !await SyncQuotaManager.acknowledgementSupersedesBlockedWrite(
          acknowledged.message,
          blockedRoot.message,
        )
      ) {
        continue;
      }

      await this.markBlockAsSupersededOmission(target, messageCid, state);
    }
  }

  /** Delete-wins supersession plus normal RecordsWrite ordering for one record. */
  private static async acknowledgementSupersedesBlockedWrite(
    acknowledgement: GenericMessage,
    blocked: GenericMessage,
  ): Promise<boolean> {
    const recordId = SyncQuotaManager.recordIdForRecordsMessage(acknowledgement);
    if (recordId === undefined || !SyncQuotaManager.isRecordsWriteForRecord(blocked, recordId)) {
      return false;
    }

    if (acknowledgement.descriptor.method === DwnMethodName.Delete) {
      return true;
    }

    return acknowledgement.descriptor.method === DwnMethodName.Write &&
      !SyncQuotaManager.isInitialWriteForRecord(acknowledgement, recordId) &&
      await Message.isNewer(acknowledgement, blocked);
  }

  private async markBlockAsSupersededOmission(
    target: SyncTarget,
    messageCid: string,
    expected: SyncQuotaBlockState,
  ): Promise<void> {
    const current = await this.getState(target, messageCid);
    if (SyncQuotaManager.blockChangedSince(current, expected) || current === undefined) {
      return;
    }

    await this._store.put({ ...current, supersededAt: new Date().toISOString() });
    this._operations.onQuotaCleared(target, messageCid, 'superseded');
  }

  private async applyPushAcknowledgements(
    target: SyncTarget,
    acknowledgementsByCid: Map<string, PushAcknowledgement>,
  ): Promise<void> {
    const hasActiveBlocks = (await this.getActiveBlocksForTarget(target)).length > 0;
    for (const acknowledgement of acknowledgementsByCid.values()) {
      await this._operations.clearFailedMessage(target, acknowledgement.cid);
      await this.clearBlockWithResolution(
        target,
        acknowledgement.cid,
        acknowledgement.resolution,
        acknowledgement.resolution === 'superseded',
      );
      if (hasActiveBlocks) {
        await this.resolveBlocksSupersededByAcknowledgement(target, acknowledgement.cid);
      }
    }
  }

  private async applyPushFailureOutcome(
    target: SyncTarget,
    failure: PushFailure,
    source: SyncQuotaBlockSource | undefined,
    transition: SyncQuotaPushResultTransition,
  ): Promise<void> {
    if (isQuotaBlockedPushFailure(failure)) {
      const state = await this.recordBlock(
        target,
        failure.cid,
        failure.protocol,
        failure.detail,
        source,
        failure.dependencyCid,
      );
      if (state.supersededAt !== undefined) { return; }
      SyncQuotaManager.markTransitionQuotaBlocked(transition, state);
      this._operations.onQuotaBlocked(target, failure.cid, failure.detail, state.nextProbeAt);
      return;
    }

    const previousBlock = await this.getState(target, failure.cid);
    if (previousBlock?.supersededAt !== undefined) {
      return;
    }
    if (failure.localMissing === true && previousBlock !== undefined) {
      await this.clearBlockWithResolution(target, failure.cid, 'superseded');
      return;
    }

    if (isTerminalPushFailure(failure)) {
      await this.clearBlock(target, failure.cid);
      await this._operations.recordTerminalFailure(target, failure);
      transition.terminalFailures.push(failure);
      return;
    }

    if (previousBlock !== undefined) {
      const state = await this.recordBlock(
        target,
        failure.cid,
        failure.protocol,
        failure.detail ?? previousBlock.detail,
        previousBlock.source,
        previousBlock.blockedCid,
      );
      if (state.supersededAt !== undefined) { return; }
      SyncQuotaManager.markTransitionQuotaBlocked(transition, state);
      return;
    }

    transition.retryableFailures.push(failure);
  }

  private static markTransitionQuotaBlocked(
    transition: SyncQuotaPushResultTransition,
    state: SyncQuotaBlockState,
  ): void {
    transition.quotaBlocked = true;
    transition.nextQuotaProbeAt = SyncQuotaManager.earliestTimestamp(
      transition.nextQuotaProbeAt,
      state.nextProbeAt,
    );
  }

  private async probeBlock(
    target: SyncTarget,
    messageCid: string,
    force: boolean,
    shouldContinue?: () => boolean,
  ): Promise<void> {
    const key = `${target.did}|${messageCid}|${encodeURIComponent(this.getLinkKey(target))}`;
    const existing = this._probes.get(key);
    if (existing !== undefined) {
      await existing;
      return;
    }

    const probe = this.doProbeBlock(target, messageCid, force, shouldContinue).finally((): void => {
      if (this._probes.get(key) === probe) {
        this._probes.delete(key);
      }
    });
    this._probes.set(key, probe);
    await probe;
  }

  private async doProbeBlock(
    target: SyncTarget,
    messageCid: string,
    force: boolean,
    shouldContinue?: () => boolean,
  ): Promise<void> {
    // Staleness across the awaits below is the CALLER's fence: the engine
    // composes a runtime-transition check into every shouldContinue it
    // threads down, so probes abort mid-flight on start/stop/clear exactly
    // as the old internal engine-generation reads did.
    if (SyncQuotaManager.shouldAbort(shouldContinue)) { return; }
    const state = await this.getState(target, messageCid);
    if (state === undefined || state.source === 'permission-grant' || state.supersededAt !== undefined) { return; }
    const nextProbeAt = Date.parse(state.nextProbeAt);
    if (!force && Number.isFinite(nextProbeAt) && Date.now() < nextProbeAt) { return; }

    const localEntry = await this._operations.getLocalMessage(target, messageCid);
    if (SyncQuotaManager.shouldAbort(shouldContinue)) { return; }
    if (localEntry !== undefined && SyncQuotaManager.hasUnmaterializedRecordsWriteData(localEntry)) {
      await this.deferUnmaterializedProbe(target, messageCid, state);
      return;
    }

    const blockedDependencyEntry =
      localEntry !== undefined && state.blockedCid !== undefined && state.blockedCid !== messageCid
        ? await this._operations.getLocalMessage(target, state.blockedCid)
        : undefined;
    if (SyncQuotaManager.shouldAbort(shouldContinue)) { return; }

    const result = localEntry === undefined
      ? await this._operations.pushMessages(target, [messageCid])
      : await this._operations.pushEntries(target, [
        ...(blockedDependencyEntry === undefined ? [] : [blockedDependencyEntry]),
        localEntry,
      ]);
    if (SyncQuotaManager.shouldAbort(shouldContinue)) {
      return;
    }
    const currentState = await this.getState(target, messageCid);
    if (SyncQuotaManager.blockChangedSince(currentState, state)) {
      return;
    }
    await this.transitionPushResult(target, result, { protocol: state.protocol, source: state.source });
  }

  private async deferUnmaterializedProbe(
    target: SyncTarget,
    messageCid: string,
    state: SyncQuotaBlockState,
  ): Promise<void> {
    const currentState = await this.getState(target, messageCid);
    if (SyncQuotaManager.blockChangedSince(currentState, state)) {
      return;
    }

    const delayIndex = Math.min(state.attempts, SyncQuotaManager.BLOCK_BACKOFF_MS.length - 1);
    const nextProbeAt = new Date(Date.now() + SyncQuotaManager.BLOCK_BACKOFF_MS[delayIndex]).toISOString();
    await this._store.put({ ...state, nextProbeAt });
  }

  private async reconcileBlockAgainstFeed(
    target: SyncTarget,
    block: SyncQuotaBlockEntry,
    localCids: Set<string>,
    remoteCids: Set<string>,
  ): Promise<void> {
    const blockedCid = block.state.blockedCid;
    const blockedDependencyIsLocalOnly = blockedCid !== undefined &&
      blockedCid !== block.messageCid &&
      localCids.has(blockedCid) &&
      !remoteCids.has(blockedCid);

    if (block.state.supersededAt !== undefined) {
      const rootIsLocalOnly = localCids.has(block.messageCid) && !remoteCids.has(block.messageCid);
      if (!rootIsLocalOnly && !blockedDependencyIsLocalOnly) {
        await this.clearBlock(target, block.messageCid);
      }
      return;
    }

    if (!localCids.has(block.messageCid) && blockedDependencyIsLocalOnly) {
      await this.markBlockAsSupersededOmission(target, block.messageCid, block.state);
    } else if (!localCids.has(block.messageCid)) {
      await this.clearBlockWithResolution(target, block.messageCid, 'superseded');
    }
  }

  private static collectOmittedCids(
    blocks: SyncQuotaBlockEntry[],
    localCids: Set<string>,
  ): Set<string> {
    const omittedCids = new Set<string>();
    for (const { messageCid, state } of blocks) {
      if (state.source === 'permission-grant') { continue; }
      omittedCids.add(messageCid);
      if (state.blockedCid !== undefined && localCids.has(state.blockedCid)) {
        omittedCids.add(state.blockedCid);
      }
    }
    return omittedCids;
  }

  private static blockChangedSince(
    current: SyncQuotaBlockState | undefined,
    expected: SyncQuotaBlockState,
  ): boolean {
    return current === undefined ||
      current.supersededAt !== undefined ||
      current.attempts !== expected.attempts ||
      current.lastBlockedAt !== expected.lastBlockedAt;
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
    if (!SyncQuotaManager.isRecordsWriteForRecord(message, recordId)) {
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

  private static earliestTimestamp(current: string | undefined, candidate: string): string {
    return current === undefined || lexicographicalCompare(candidate, current) < 0 ? candidate : current;
  }

  private static latestTimestamp(current: string | undefined, candidate: string): string {
    return current === undefined || lexicographicalCompare(candidate, current) > 0 ? candidate : current;
  }

  private static shouldAbort(shouldContinue?: () => boolean): boolean {
    return shouldContinue?.() === false;
  }
}
