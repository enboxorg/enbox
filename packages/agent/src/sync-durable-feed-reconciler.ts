import type { MessagesQueryReply, MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';

import type { SyncReplicationLinkStore } from './sync-replication-link-store.js';
import type { SyncTarget } from './sync-target-resolver.js';
import type { PushFailure, ReplicationLinkState, SyncDirection } from './types/sync.js';

import { buildLinkId } from './sync-link-id.js';
import { isValidProgressToken, SyncCheckpoint } from './sync-checkpoint.js';

/** Options controlling one durable-feed reconciliation cycle. */
export type SyncDurableFeedReconcileOptions = {
  direction?: SyncDirection;
  forceQuotaProbe?: boolean;
  verifyConvergence?: boolean;
};

/** Aggregate outcome from one durable-feed reconciliation cycle. */
export type SyncDurableFeedReconcileResult = {
  aborted?: boolean;
  admittedCids?: string[];
  converged?: boolean;
  hasActionableDiffs?: boolean;
  localFingerprint?: string;
  pushFailures?: PushFailure[];
  quotaBlocked?: boolean;
  remoteFingerprint?: string;
};

/** Result of applying one remote feed page through engine-owned admission policy. */
export type SyncDurableFeedPageAdmissionResult =
  | { kind: 'aborted' }
  | { kind: 'deferred'; admittedCids: string[]; detail?: string; hasActionableDiffs: boolean; messageCid: string }
  | { kind: 'processed'; admittedCids: string[]; hasActionableDiffs: boolean };

/** Result of pushing one local feed page through engine-owned push policy. */
export type SyncDurableFeedPagePushResult =
  | { kind: 'aborted' }
  | { kind: 'failed'; failures: PushFailure[]; hasActionableDiffs: boolean }
  | { kind: 'processed'; hasActionableDiffs: boolean };

/** Result of ensuring delegated permission grants exist before a diff push. */
export type SyncDurableFeedPermissionGrantBootstrapResult =
  | { kind: 'aborted' }
  | { kind: 'processed'; failures: PushFailure[]; hasActionableDiffs: boolean; quotaBlocked: boolean };

/** Query parameters for one local or remote durable-feed page. */
export type SyncDurableFeedQuery = {
  cidsOnly?: boolean;
  cursor?: ProgressToken;
  limit: number;
  source: 'local' | 'remote';
  target: SyncTarget;
};

/** Engine-owned operations required by the backend-neutral feed algorithm. */
export interface SyncDurableFeedReconcilerOperations {
  admitRemotePage(
    target: SyncTarget,
    entries: MessagesQueryReplyEntry[],
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedPageAdmissionResult>;

  bootstrapRemotePermissionGrants(
    target: SyncTarget,
    shouldContinue?: () => boolean,
    forceQuotaProbe?: boolean,
  ): Promise<SyncDurableFeedPermissionGrantBootstrapResult>;

  clearResolvedQuotaOmissions(target: SyncTarget): Promise<void>;

  getLinkStore(): SyncReplicationLinkStore;

  getOrCreateLink(target: SyncTarget): Promise<ReplicationLinkState>;

  getQuotaBlockCids(target: SyncTarget): Promise<string[]>;

  onCheckpointAdvanced(link: ReplicationLinkState, direction: SyncDirection): void;

  onReconcileApplied(target: SyncTarget, messageCids: string[]): void;

  probeQuotaBlocks(
    target: SyncTarget,
    force: boolean,
    forceProbeCids: Set<string> | undefined,
    shouldContinue?: () => boolean,
  ): Promise<void>;

  pushLocalPage(
    target: SyncTarget,
    entries: MessagesQueryReplyEntry[],
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedPagePushResult>;

  queryFeed(query: SyncDurableFeedQuery): Promise<MessagesQueryReply>;
}

type FeedCursorAdvanceResult =
  | { drained: true }
  | { cursor: ProgressToken; drained: false };

type TrackedFeedPageAdmissionResult =
  | { kind: 'aborted' }
  | { kind: 'processed'; hasActionableDiffs: boolean };

/**
 * Reconciles one durable local/remote message feed pair.
 *
 * The algorithm owns ordering, pagination, progress-gap recovery, checkpoint
 * progression, and convergence verification. Storage, transport, admission,
 * and quota policy are supplied through domain operations so the same
 * reconciler can be used by Level- or SQLite-backed sync engines.
 */
export class SyncDurableFeedReconciler {
  private static readonly PAGE_LIMIT = 100;

  private readonly _operations: SyncDurableFeedReconcilerOperations;
  private readonly _runs: Map<string, Promise<void>> = new Map();

  constructor(operations: SyncDurableFeedReconcilerOperations) {
    this._operations = operations;
  }

  /**
   * Reconcile one target. Runs serialize per full link identity
   * `(did, dwnUrl, projectionId, authorizationEpoch)` — a different
   * projection or authorization epoch is a different queue and runs
   * concurrently.
   */
  public async reconcile(
    target: SyncTarget,
    options?: SyncDurableFeedReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult> {
    const linkKey = buildLinkId(target.did, target.dwnUrl, target.projectionId, target.authorizationEpoch);
    const previous = this._runs.get(linkKey) ?? Promise.resolve();
    const run = previous.catch((): void => {
      // A failed predecessor must not poison this link's queue.
    }).then(async (): Promise<SyncDurableFeedReconcileResult> => {
      if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
        return { ...SyncDurableFeedReconciler.initialResult(options), aborted: true };
      }
      return this.reconcileTarget(target, options, shouldContinue);
    });
    const settled = run.then((): void => {}, (): void => {});
    this._runs.set(linkKey, settled);

    try {
      return await run;
    } finally {
      if (this._runs.get(linkKey) === settled) {
        this._runs.delete(linkKey);
      }
    }
  }

  /** Pull every missing remote feed entry and persist contiguous progress. */
  public async pull(
    target: SyncTarget,
    options?: SyncDurableFeedReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult> {
    if (options?.direction === 'push') {
      return {};
    }

    const link = await this._operations.getOrCreateLink(target);
    return this.pullRemotePages(target, link, shouldContinue);
  }

  /** Push every missing local feed entry and persist contiguous progress. */
  public async push(
    target: SyncTarget,
    options?: SyncDurableFeedReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult> {
    if (options?.direction === 'pull') {
      return {};
    }

    const forceQuotaProbe = options?.forceQuotaProbe === true;
    const forceProbeCids = forceQuotaProbe
      ? new Set(await this._operations.getQuotaBlockCids(target))
      : undefined;
    const link = await this._operations.getOrCreateLink(target);
    const result = await this.pushLocalPages(target, link, shouldContinue, forceQuotaProbe);

    // Checkpoint progress intentionally advances past quota-blocked roots. Run
    // independent probes only after later feed state has had a chance to replay
    // retained ancestry for updates and tombstones.
    if (
      result.aborted !== true &&
      result.quotaBlocked !== true &&
      (result.pushFailures?.length ?? 0) === 0
    ) {
      await this._operations.probeQuotaBlocks(target, forceQuotaProbe, forceProbeCids, shouldContinue);
    }

    return result;
  }

  /** Compare exact local and remote feed fingerprints after a reconciliation. */
  public async verifyConvergence(
    target: SyncTarget,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult> {
    if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
      return { aborted: true };
    }

    const [localReply, remoteReply] = await Promise.all([
      this._operations.queryFeed({ cidsOnly: true, limit: 1, source: 'local', target }),
      this._operations.queryFeed({ cidsOnly: true, limit: 1, source: 'remote', target }),
    ]);

    if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
      return { aborted: true };
    }

    SyncDurableFeedReconciler.assertQuerySucceeded(localReply, target, 'push');
    SyncDurableFeedReconciler.assertQuerySucceeded(remoteReply, target, 'pull');

    const result: SyncDurableFeedReconcileResult = {
      localFingerprint  : localReply.fingerprint,
      remoteFingerprint : remoteReply.fingerprint,
      pushFailures      : [],
    };
    const converged = SyncDurableFeedReconciler.fingerprintsConverged(result);
    if (converged) {
      await this._operations.clearResolvedQuotaOmissions(target);
    }
    return { ...result, converged };
  }

  /** Collect the complete local feed inventory, or return undefined if cancelled. */
  public collectLocalCids(target: SyncTarget, shouldContinue?: () => boolean): Promise<Set<string> | undefined> {
    return this.collectCids(target, 'local', shouldContinue);
  }

  /** Collect the complete remote feed inventory, or return undefined if cancelled. */
  public collectRemoteCids(target: SyncTarget, shouldContinue?: () => boolean): Promise<Set<string> | undefined> {
    return this.collectCids(target, 'remote', shouldContinue);
  }

  private async reconcileTarget(
    target: SyncTarget,
    options?: SyncDurableFeedReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult> {
    const result = SyncDurableFeedReconciler.initialResult(options);
    const link = await this._operations.getOrCreateLink(target);
    if (link.status === 'paused') {
      return result;
    }

    const pullResult = await this.pull(target, options, shouldContinue);
    SyncDurableFeedReconciler.mergeResult(result, pullResult, options);
    if (SyncDurableFeedReconciler.shouldStop(result, pullResult)) {
      return result;
    }
    if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
      return { ...result, aborted: true };
    }

    const pushResult = await this.push(target, options, shouldContinue);
    SyncDurableFeedReconciler.mergeResult(result, pushResult, options);
    if (SyncDurableFeedReconciler.shouldStop(result, pushResult)) {
      return result;
    }
    if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
      return { ...result, aborted: true };
    }

    if (options?.verifyConvergence === true) {
      const convergence = await this.verifyConvergence(target, shouldContinue);
      SyncDurableFeedReconciler.mergeResult(result, convergence, options);
    }
    return result;
  }

  private async pullRemotePages(
    target: SyncTarget,
    link: ReplicationLinkState,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult> {
    if (link.pull.contiguousAppliedToken === undefined) {
      const result = await this.pullRemoteDiffWhenUseful(target, link, shouldContinue);
      if (result !== undefined) {
        return result;
      }
    }

    const admittedCids: string[] = [];
    let hasActionableDiffs = false;
    let cursor: ProgressToken | undefined = link.pull.contiguousAppliedToken;
    let resetAfterProgressGap = false;

    while (true) {
      if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
        return { aborted: true };
      }

      const reply = await this._operations.queryFeed({
        cursor,
        limit  : SyncDurableFeedReconciler.PAGE_LIMIT,
        source : 'remote',
        target,
      });

      if (await this.resetAfterProgressGap(reply, link, 'pull', resetAfterProgressGap)) {
        resetAfterProgressGap = true;
        cursor = undefined;
        const result = await this.pullRemoteDiffWhenUseful(target, link, shouldContinue);
        if (result !== undefined) {
          return result;
        }
        continue;
      }

      SyncDurableFeedReconciler.assertQuerySucceeded(reply, target, 'pull');
      const pageResult = await this.admitRemotePageAndTrack({
        target,
        entries: reply.entries ?? [],
        admittedCids,
        shouldContinue,
      });
      if (pageResult.kind === 'aborted') {
        return { aborted: true };
      }

      hasActionableDiffs ||= pageResult.hasActionableDiffs;
      const cursorAdvance = await this.commitPageProgress(link, 'pull', cursor, reply, target);
      if (cursorAdvance.drained) {
        return { admittedCids, hasActionableDiffs, remoteFingerprint: reply.fingerprint };
      }
      cursor = cursorAdvance.cursor;
    }
  }

  private async pullRemoteDiffWhenUseful(
    target: SyncTarget,
    link: ReplicationLinkState,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult | undefined> {
    const localCids = await this.collectLocalCids(target, shouldContinue);
    if (localCids === undefined) {
      return { aborted: true };
    }
    if (localCids.size === 0) {
      return undefined;
    }

    return this.pullRemoteDiffPages(target, link, localCids, shouldContinue);
  }

  private async pullRemoteDiffPages(
    target: SyncTarget,
    link: ReplicationLinkState,
    localCids: Set<string>,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult> {
    const admittedCids: string[] = [];
    let hasActionableDiffs = false;
    let cursor: ProgressToken | undefined;
    let resetAfterProgressGap = false;

    while (true) {
      if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
        return { aborted: true };
      }

      const reply = await this.queryCidsPage(target, 'remote', cursor);
      if (await this.resetAfterProgressGap(reply, link, 'pull', resetAfterProgressGap)) {
        resetAfterProgressGap = true;
        cursor = undefined;
        continue;
      }

      SyncDurableFeedReconciler.assertQuerySucceeded(reply, target, 'pull');
      const missingEntries = SyncDurableFeedReconciler.entriesMissingFrom(localCids, reply.entries ?? []);
      const pageResult = await this.admitRemotePageAndTrack({
        target,
        entries   : missingEntries,
        admittedCids,
        knownCids : localCids,
        shouldContinue,
      });
      if (pageResult.kind === 'aborted') {
        return { aborted: true };
      }

      hasActionableDiffs ||= pageResult.hasActionableDiffs;
      const cursorAdvance = await this.commitPageProgress(link, 'pull', cursor, reply, target);
      if (cursorAdvance.drained) {
        return { admittedCids, hasActionableDiffs, remoteFingerprint: reply.fingerprint };
      }
      cursor = cursorAdvance.cursor;
    }
  }

  private async pushLocalPages(
    target: SyncTarget,
    link: ReplicationLinkState,
    shouldContinue?: () => boolean,
    forceQuotaProbe = false,
  ): Promise<SyncDurableFeedReconcileResult> {
    if (link.push.contiguousAppliedToken === undefined) {
      return this.pushLocalDiffWithRemoteInventory(target, link, shouldContinue, forceQuotaProbe);
    }

    let hasActionableDiffs = false;
    let cursor: ProgressToken | undefined = link.push.contiguousAppliedToken;

    while (true) {
      if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
        return { aborted: true };
      }

      const reply = await this._operations.queryFeed({
        cursor,
        limit  : SyncDurableFeedReconciler.PAGE_LIMIT,
        source : 'local',
        target,
      });

      if (await this.resetAfterProgressGap(reply, link, 'push', false)) {
        return this.pushLocalDiffWithRemoteInventory(target, link, shouldContinue, forceQuotaProbe);
      }

      SyncDurableFeedReconciler.assertQuerySucceeded(reply, target, 'push');
      const pageResult = await this._operations.pushLocalPage(target, reply.entries ?? [], shouldContinue);
      if (pageResult.kind === 'aborted') {
        return { aborted: true };
      }

      hasActionableDiffs ||= pageResult.hasActionableDiffs;
      if (pageResult.kind === 'failed') {
        return { hasActionableDiffs, pushFailures: pageResult.failures };
      }

      const cursorAdvance = await this.commitPageProgress(link, 'push', cursor, reply, target);
      if (cursorAdvance.drained) {
        return { hasActionableDiffs, localFingerprint: reply.fingerprint, pushFailures: [] };
      }
      cursor = cursorAdvance.cursor;
    }
  }

  private async pushLocalDiffWithRemoteInventory(
    target: SyncTarget,
    link: ReplicationLinkState,
    shouldContinue?: () => boolean,
    forceQuotaProbe = false,
  ): Promise<SyncDurableFeedReconcileResult> {
    const grantBootstrap = await this._operations.bootstrapRemotePermissionGrants(
      target,
      shouldContinue,
      forceQuotaProbe,
    );
    if (grantBootstrap.kind === 'aborted') {
      return { aborted: true };
    }
    if (grantBootstrap.quotaBlocked) {
      return { hasActionableDiffs: grantBootstrap.hasActionableDiffs, pushFailures: [], quotaBlocked: true };
    }
    if (grantBootstrap.failures.length > 0) {
      return { hasActionableDiffs: grantBootstrap.hasActionableDiffs, pushFailures: grantBootstrap.failures };
    }

    const remoteCids = await this.collectRemoteCids(target, shouldContinue);
    if (remoteCids === undefined) {
      return { aborted: true };
    }

    const result = await this.pushLocalDiffPages(target, link, remoteCids, shouldContinue);
    if (result.aborted === true) {
      return result;
    }

    return {
      ...result,
      hasActionableDiffs: result.hasActionableDiffs === true || grantBootstrap.hasActionableDiffs,
    };
  }

  private async pushLocalDiffPages(
    target: SyncTarget,
    link: ReplicationLinkState,
    remoteCids: Set<string>,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult> {
    let hasActionableDiffs = false;
    let cursor: ProgressToken | undefined;
    let resetAfterProgressGap = false;

    while (true) {
      if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
        return { aborted: true };
      }

      const reply = await this.queryCidsPage(target, 'local', cursor);
      if (await this.resetAfterProgressGap(reply, link, 'push', resetAfterProgressGap)) {
        resetAfterProgressGap = true;
        cursor = undefined;
        continue;
      }

      SyncDurableFeedReconciler.assertQuerySucceeded(reply, target, 'push');
      const missingEntries = SyncDurableFeedReconciler.entriesMissingFrom(remoteCids, reply.entries ?? []);
      const pageResult = await this._operations.pushLocalPage(target, missingEntries, shouldContinue);
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

      const cursorAdvance = await this.commitPageProgress(link, 'push', cursor, reply, target);
      if (cursorAdvance.drained) {
        return { hasActionableDiffs, localFingerprint: reply.fingerprint, pushFailures: [] };
      }
      cursor = cursorAdvance.cursor;
    }
  }

  private async collectCids(
    target: SyncTarget,
    source: 'local' | 'remote',
    shouldContinue?: () => boolean,
  ): Promise<Set<string> | undefined> {
    const cids = new Set<string>();
    let cursor: ProgressToken | undefined;

    while (true) {
      if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
        return undefined;
      }

      const reply = await this.queryCidsPage(target, source, cursor);
      SyncDurableFeedReconciler.assertQuerySucceeded(reply, target, source === 'local' ? 'push' : 'pull');
      for (const entry of reply.entries ?? []) {
        cids.add(entry.messageCid);
      }

      const advance = SyncDurableFeedReconciler.nextEnumerationCursor(reply, target, source);
      if (advance.drained) {
        return cids;
      }
      cursor = advance.cursor;
    }
  }

  private queryCidsPage(
    target: SyncTarget,
    source: 'local' | 'remote',
    cursor: ProgressToken | undefined,
  ): Promise<MessagesQueryReply> {
    return this._operations.queryFeed({
      cidsOnly : true,
      cursor,
      limit    : SyncDurableFeedReconciler.PAGE_LIMIT,
      source,
      target,
    });
  }

  private async admitRemotePageAndTrack({
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
    const pageResult = await this._operations.admitRemotePage(target, entries, shouldContinue);
    if (pageResult.kind === 'aborted') {
      return { kind: 'aborted' };
    }

    admittedCids.push(...pageResult.admittedCids);
    for (const messageCid of pageResult.admittedCids) {
      knownCids?.add(messageCid);
    }

    if (pageResult.kind === 'deferred') {
      if (admittedCids.length > 0) {
        this._operations.onReconcileApplied(target, admittedCids);
      }
      throw new Error(
        `SyncEngineLevel: pull deferred for ${pageResult.messageCid}: ${pageResult.detail ?? 'dependency unavailable'}`,
      );
    }

    return { kind: 'processed', hasActionableDiffs: pageResult.hasActionableDiffs };
  }

  private async commitPageProgress(
    link: ReplicationLinkState,
    direction: SyncDirection,
    previousCursor: ProgressToken | undefined,
    reply: MessagesQueryReply,
    target: SyncTarget,
  ): Promise<FeedCursorAdvanceResult> {
    const checkpoint = link[direction];
    const drained = reply.drained === true;
    if (reply.cursor === undefined) {
      if (drained) {
        return { drained: true };
      }
      const label = direction === 'push' ? 'local MessagesQuery' : 'MessagesQuery';
      throw new Error(
        `SyncEngineLevel: ${label} for ${target.did} -> ${target.dwnUrl} returned no cursor before drain`,
      );
    }

    SyncDurableFeedReconciler.assertCursorProgress(
      link,
      previousCursor,
      reply.cursor,
      drained,
      target.dwnUrl,
      direction,
    );
    SyncCheckpoint.commitContiguousToken(checkpoint, reply.cursor);
    await this._operations.getLinkStore().persistCheckpoint(link, direction);
    this._operations.onCheckpointAdvanced(link, direction);

    return drained ? { drained: true } : { cursor: reply.cursor, drained: false };
  }

  private async resetAfterProgressGap(
    reply: MessagesQueryReply,
    link: ReplicationLinkState,
    direction: SyncDirection,
    alreadyReset: boolean,
  ): Promise<boolean> {
    // 410 = ProgressGap: the stored token is no longer replayable, so reset
    // the checkpoint and restart from the diff path. Only once per loop —
    // `alreadyReset` makes a remote that keeps reporting gaps fall through
    // to assertQuerySucceeded and surface as an error instead of spinning.
    if (reply.status.code !== 410 || alreadyReset) {
      return false;
    }

    await this._operations.getLinkStore().resetCheckpoint(link, direction);
    return true;
  }

  private static assertCursorProgress(
    link: ReplicationLinkState,
    previousCursor: ProgressToken | undefined,
    nextCursor: ProgressToken,
    drained: boolean,
    dwnUrl: string,
    direction: SyncDirection,
  ): void {
    if (!isValidProgressToken(nextCursor)) {
      throw new Error(
        `SyncEngineLevel: ${direction} MessagesQuery returned an invalid cursor for ${link.tenantDid} -> ${dwnUrl}`,
      );
    }

    if (!SyncCheckpoint.validateTokenDomain(link[direction], nextCursor)) {
      throw new Error(
        `SyncEngineLevel: ${direction} MessagesQuery token domain mismatch for ${link.tenantDid} -> ${dwnUrl}`,
      );
    }

    if (previousCursor === undefined) {
      return;
    }

    const comparison = SyncCheckpoint.comparePosition(nextCursor, previousCursor);
    if (comparison < 0 || (comparison === 0 && !drained)) {
      throw new Error(
        `SyncEngineLevel: ${direction} MessagesQuery cursor did not advance for ${link.tenantDid} -> ${dwnUrl}`,
      );
    }
  }

  private static assertQuerySucceeded(
    reply: MessagesQueryReply,
    target: SyncTarget,
    direction: SyncDirection,
  ): void {
    if (reply.status.code !== 200) {
      const label = direction === 'push' ? 'local MessagesQuery' : 'MessagesQuery';
      throw new Error(
        `SyncEngineLevel: ${label} failed for ${target.did} -> ${target.dwnUrl}: ` +
        `${reply.status.code} ${reply.status.detail}`,
      );
    }
  }

  /**
   * The neutral result a cycle starts from and merges into.
   *
   * `converged` starts OPTIMISTIC when convergence verification is
   * requested: only `mergeResult` ever drives it to `false`. A path that
   * returns this untouched therefore reports convergence without having
   * compared fingerprints — which is what a paused link does deliberately,
   * since it has nothing to reconcile.
   */
  private static initialResult(options?: SyncDurableFeedReconcileOptions): SyncDurableFeedReconcileResult {
    return {
      admittedCids       : [],
      ...(options?.verifyConvergence === true ? { converged: true } : {}),
      hasActionableDiffs : false,
      pushFailures       : [],
    };
  }

  private static entriesMissingFrom(
    knownCids: Set<string>,
    entries: MessagesQueryReplyEntry[],
  ): MessagesQueryReplyEntry[] {
    return entries.filter(entry => !knownCids.has(entry.messageCid));
  }

  private static fingerprintsConverged(result: SyncDurableFeedReconcileResult): boolean {
    if ((result.pushFailures?.length ?? 0) > 0) {
      return false;
    }

    return result.localFingerprint !== undefined &&
      result.remoteFingerprint !== undefined &&
      result.localFingerprint === result.remoteFingerprint;
  }

  private static mergeResult(
    target: SyncDurableFeedReconcileResult,
    source: SyncDurableFeedReconcileResult,
    options?: SyncDurableFeedReconcileOptions,
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

  private static nextEnumerationCursor(
    reply: MessagesQueryReply,
    target: SyncTarget,
    source: 'local' | 'remote',
  ): FeedCursorAdvanceResult {
    const drained = reply.drained === true;
    if (reply.cursor === undefined) {
      if (drained) {
        return { drained: true };
      }
      throw new Error(
        `SyncEngineLevel: ${source} MessagesQuery for ${target.did} -> ${target.dwnUrl} returned no cursor before drain`,
      );
    }

    if (!isValidProgressToken(reply.cursor)) {
      throw new Error(
        `SyncEngineLevel: ${source} MessagesQuery returned an invalid cursor for ${target.did} -> ${target.dwnUrl}`,
      );
    }

    return drained ? { drained: true } : { cursor: reply.cursor, drained: false };
  }

  private static shouldAbort(shouldContinue?: () => boolean): boolean {
    return shouldContinue?.() === false;
  }

  private static shouldStop(
    accumulator: SyncDurableFeedReconcileResult,
    latest: SyncDurableFeedReconcileResult,
  ): boolean {
    return latest.aborted === true ||
      latest.quotaBlocked === true ||
      (accumulator.pushFailures?.length ?? 0) > 0;
  }
}
