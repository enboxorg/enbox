import type { MessagesQueryReply, MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';

import type { SyncQuotaManager } from './sync-quota-manager.js';
import type { SyncTarget } from './sync-target-resolver.js';
import type { PushFailure, ReplicationLinkState, SyncDirection } from './types/sync.js';

import { runSerializedByKey } from '@enbox/common';

import { buildLinkKey } from './sync-link-key.js';
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
  /**
   * Tri-state, and callers must treat it as such: `true` means fingerprints
   * were compared and matched, `false` means they were compared and did not,
   * and ABSENT means convergence was never established — the cycle did not
   * verify, or never ran at all (see {@link paused}). Never infer
   * convergence from a missing `false`.
   */
  converged?: boolean;
  localFingerprint?: string;
  /** The pull direction reached the remote-feed head captured by its final query. */
  pullDrained?: true;
  /**
   * The first remote root whose dependencies are not yet available. Its page
   * and checkpoint remain unsettled; a later wake or settle pass retries from
   * the same durable checkpoint.
   */
  deferredPull?: { messageCid: string; detail?: string };
  /**
   * The link was parked, so the cycle returned without reconciling anything.
   * Distinct from converged and from divergent: nothing was compared.
   */
  paused?: boolean;
  pushFailures?: PushFailure[];
  quotaBlocked?: boolean;
  remoteFingerprint?: string;
};

/** Result of applying one remote feed page through engine-owned admission policy. */
export type SyncDurableFeedPageAdmissionResult =
  | { kind: 'aborted' }
  | { kind: 'deferred'; admittedCids: string[]; detail?: string; messageCid: string }
  | { kind: 'processed'; admittedCids: string[] };

/** Result of pushing one local feed page through engine-owned push policy. */
export type SyncDurableFeedPagePushResult =
  | { kind: 'aborted' }
  | { kind: 'failed'; failures: PushFailure[] }
  | { kind: 'processed' };

/** Result of ensuring delegated permission grants exist before a diff push. */
export type SyncDurableFeedPermissionGrantBootstrapResult =
  | { kind: 'aborted' }
  | { kind: 'processed'; failures: PushFailure[]; quotaBlocked: boolean };

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

  /** Persist one page's ordered checkpoint advance. */
  commitCheckpoint(link: ReplicationLinkState, direction: SyncDirection): Promise<void>;

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

  resetCheckpoint(link: ReplicationLinkState, direction: SyncDirection): Promise<void>;
}

export type SyncDurableFeedReconcilerParams = {
  operations: SyncDurableFeedReconcilerOperations;
  quotaManager: SyncQuotaManager;
};

type FeedCursorAdvanceResult =
  | { drained: true }
  | { cursor: ProgressToken; drained: false };

type ProcessPullPageResult =
  | { nextCursor: ProgressToken }
  | { result: SyncDurableFeedReconcileResult };

type ProcessPullPageParams = {
  cursor: ProgressToken | undefined;
  entries: MessagesQueryReplyEntry[];
  knownCids?: Set<string>;
  link: ReplicationLinkState;
  reply: MessagesQueryReply;
  shouldContinue?: () => boolean;
  target: SyncTarget;
};

/**
 * Reconciles one durable local/remote message feed pair.
 *
 * The algorithm owns ordering, pagination, progress-gap recovery, checkpoint
 * progression, and convergence verification. Storage, transport, and
 * admission are supplied through domain operations. Durable quota policy
 * is supplied by `SyncQuotaManager`, independent of the sync-engine backend.
 */
export class SyncDurableFeedReconciler {
  private static readonly PAGE_LIMIT = 100;

  private readonly _operations: SyncDurableFeedReconcilerOperations;
  private readonly _quotaManager: SyncQuotaManager;
  private readonly _runs: Map<string, Promise<void>> = new Map();

  constructor({ operations, quotaManager }: SyncDurableFeedReconcilerParams) {
    this._operations = operations;
    this._quotaManager = quotaManager;
  }

  /**
   * Reconcile one target. Runs serialize per full link identity
   * `(did, dwnUrl, projectionId, authorizationEpoch)` — a different
   * projection or authorization epoch is a different queue and runs
   * concurrently.
   */
  public async reconcile(
    target: SyncTarget,
    link: ReplicationLinkState,
    options?: SyncDurableFeedReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult> {
    const linkKey = buildLinkKey(target.did, target.dwnUrl, target.projectionId, target.authorizationEpoch);
    return runSerializedByKey(this._runs, linkKey, async (): Promise<SyncDurableFeedReconcileResult> => {
      if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
        return { ...SyncDurableFeedReconciler.initialResult(options), aborted: true };
      }
      return this.reconcileTarget(target, link, options, shouldContinue);
    });
  }

  /** Pull every missing remote feed entry and persist contiguous progress. */
  public async pull(
    target: SyncTarget,
    link: ReplicationLinkState,
    options?: SyncDurableFeedReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult> {
    if (options?.direction === 'push') {
      return {};
    }
    if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
      return { aborted: true };
    }

    await this.resetInvalidCheckpoint(link, 'pull');
    return this.pullRemotePages(target, link, shouldContinue);
  }

  /** Push every missing local feed entry and persist contiguous progress. */
  public async push(
    target: SyncTarget,
    link: ReplicationLinkState,
    options?: SyncDurableFeedReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult> {
    if (options?.direction === 'pull') {
      return {};
    }
    if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
      return { aborted: true };
    }

    await this.resetInvalidCheckpoint(link, 'push');
    const forceQuotaProbe = options?.forceQuotaProbe === true;
    const forceProbeCids = forceQuotaProbe
      ? new Set((await this._quotaManager.getActiveBlocksForTarget(target)).map(({ messageCid }) => messageCid))
      : undefined;
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
      await this._quotaManager.clearResolvedOmissionsForTarget(target);
    }
    return { ...result, converged };
  }

  private async reconcileTarget(
    target: SyncTarget,
    link: ReplicationLinkState,
    options?: SyncDurableFeedReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult> {
    if (link.status === 'paused') {
      // Parked: nothing is reconciled and no fingerprints are compared, so
      // convergence is UNKNOWN — report it as such rather than inheriting
      // the optimistic seed. Claiming `converged: true` here let a
      // post-repair verification emit `reconcile:completed` for a link it
      // never checked. Built without options so no `converged` key exists.
      return { ...SyncDurableFeedReconciler.initialResult(), paused: true };
    }

    const result = SyncDurableFeedReconciler.initialResult(options);

    const pullResult = await this.pull(target, link, options, shouldContinue);
    SyncDurableFeedReconciler.mergeResult(result, pullResult, options);
    if (SyncDurableFeedReconciler.shouldStop(result, pullResult)) {
      return result;
    }
    if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
      return { ...result, aborted: true };
    }

    const pushResult = await this.push(target, link, options, shouldContinue);
    SyncDurableFeedReconciler.mergeResult(result, pushResult, options);
    if (SyncDurableFeedReconciler.shouldStop(result, pushResult)) {
      return result;
    }
    if (SyncDurableFeedReconciler.shouldAbort(shouldContinue)) {
      return { ...result, aborted: true };
    }

    // A deferred pull is durable blocked work, not feed divergence. Keep the
    // checkpoint below it and let the next wake or settle pass retry. The push
    // direction above remains independent, but convergence cannot be claimed
    // until the blocked pull page settles.
    if (result.deferredPull !== undefined) {
      delete result.converged;
      return result;
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
      const result = await this.pullRemoteOwnerDiffWhenUseful(target, link, shouldContinue);
      if (result !== undefined) {
        return result;
      }
    }

    let cursor = link.pull.contiguousAppliedToken;
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
        const result = await this.pullRemoteOwnerDiffWhenUseful(target, link, shouldContinue);
        if (result !== undefined) {
          return result;
        }
        continue;
      }

      SyncDurableFeedReconciler.assertQuerySucceeded(reply, target, 'pull');
      const result = await this.processPullPage({
        target,
        cursor,
        entries: reply.entries ?? [],
        link,
        reply,
        shouldContinue,
      });
      if ('result' in result) {
        return result.result;
      }
      cursor = result.nextCursor;
    }
  }

  private async pullRemoteOwnerDiffWhenUseful(
    target: SyncTarget,
    link: ReplicationLinkState,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult | undefined> {
    if (target.authorization.kind === 'role') {
      return undefined;
    }
    return this.pullRemoteDiffWhenUseful(target, link, shouldContinue);
  }

  private async pullRemoteDiffWhenUseful(
    target: SyncTarget,
    link: ReplicationLinkState,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult | undefined> {
    const localCids = await this.collectFeedCids(target, 'local', shouldContinue);
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
      const result = await this.processPullPage({
        target,
        cursor,
        entries   : missingEntries,
        knownCids : localCids,
        link,
        reply,
        shouldContinue,
      });
      if ('result' in result) {
        return result.result;
      }
      cursor = result.nextCursor;
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

      if (pageResult.kind === 'failed') {
        return { pushFailures: pageResult.failures };
      }

      const cursorAdvance = await this.commitPageProgress(link, 'push', cursor, reply, target);
      if (cursorAdvance.drained) {
        return { localFingerprint: reply.fingerprint, pushFailures: [] };
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
      return { pushFailures: [], quotaBlocked: true };
    }
    if (grantBootstrap.failures.length > 0) {
      return { pushFailures: grantBootstrap.failures };
    }

    const remoteCids = await this.collectFeedCids(target, 'remote', shouldContinue);
    if (remoteCids === undefined) {
      return { aborted: true };
    }

    return this.pushLocalDiffPages(target, link, remoteCids, shouldContinue);
  }

  private async pushLocalDiffPages(
    target: SyncTarget,
    link: ReplicationLinkState,
    remoteCids: Set<string>,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult> {
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

      if (pageResult.kind === 'failed') {
        return { pushFailures: pageResult.failures };
      }
      for (const entry of missingEntries) {
        remoteCids.add(entry.messageCid);
      }

      const cursorAdvance = await this.commitPageProgress(link, 'push', cursor, reply, target);
      if (cursorAdvance.drained) {
        return { localFingerprint: reply.fingerprint, pushFailures: [] };
      }
      cursor = cursorAdvance.cursor;
    }
  }

  /** Collect the complete feed inventory from one source, or return undefined if cancelled. */
  public async collectFeedCids(
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

  /** Reset corrupt durable progress before it can enter a DWN query. */
  private async resetInvalidCheckpoint(link: ReplicationLinkState, direction: SyncDirection): Promise<void> {
    const token = link[direction].contiguousAppliedToken;
    if (token !== undefined && !isValidProgressToken(token)) {
      await this._operations.resetCheckpoint(link, direction);
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

  /** Admit one pull page and advance its checkpoint only after it settles. */
  private async processPullPage({
    cursor,
    entries,
    knownCids,
    link,
    reply,
    shouldContinue,
    target,
  }: ProcessPullPageParams): Promise<ProcessPullPageResult> {
    const pageResult = await this._operations.admitRemotePage(target, entries, shouldContinue);
    if (pageResult.kind === 'aborted') {
      return { result: { aborted: true } };
    }

    if (knownCids !== undefined) {
      for (const messageCid of pageResult.admittedCids) {
        knownCids.add(messageCid);
      }
    }

    if (pageResult.kind === 'deferred') {
      return {
        result: {
          deferredPull: {
            detail     : pageResult.detail,
            messageCid : pageResult.messageCid,
          },
        },
      };
    }

    const cursorAdvance = await this.commitPageProgress(link, 'pull', cursor, reply, target);
    if (cursorAdvance.drained) {
      return {
        result: {
          pullDrained       : true,
          remoteFingerprint : reply.fingerprint,
        },
      };
    }
    return { nextCursor: cursorAdvance.cursor };
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
        `SyncDurableFeedReconciler: ${label} for ${target.did} -> ${target.dwnUrl} returned no cursor before drain`,
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
    await this._operations.commitCheckpoint(link, direction);

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

    await this._operations.resetCheckpoint(link, direction);
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
        `SyncDurableFeedReconciler: ${direction} MessagesQuery returned an invalid cursor for ${link.tenantDid} -> ${dwnUrl}`,
      );
    }

    if (!SyncCheckpoint.validateTokenDomain(link[direction], nextCursor)) {
      throw new Error(
        `SyncDurableFeedReconciler: ${direction} MessagesQuery token domain mismatch for ${link.tenantDid} -> ${dwnUrl}`,
      );
    }

    if (previousCursor === undefined) {
      return;
    }

    const comparison = SyncCheckpoint.comparePosition(nextCursor, previousCursor);
    if (comparison < 0 || (comparison === 0 && !drained)) {
      throw new Error(
        `SyncDurableFeedReconciler: ${direction} MessagesQuery cursor did not advance for ${link.tenantDid} -> ${dwnUrl}`,
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
        `SyncDurableFeedReconciler: ${label} failed for ${target.did} -> ${target.dwnUrl}: ` +
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
   * compared fingerprints. Callers that stop before verification must remove
   * or avoid that optimistic seed, as the paused and deferred-pull paths do.
   */
  private static initialResult(options?: SyncDurableFeedReconcileOptions): SyncDurableFeedReconcileResult {
    return {
      ...(options?.verifyConvergence === true ? { converged: true } : {}),
      pushFailures: [],
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
    target.pushFailures?.push(...(source.pushFailures ?? []));
    if (source.deferredPull !== undefined) {
      target.deferredPull = source.deferredPull;
    }
    target.quotaBlocked ||= source.quotaBlocked === true;
    target.localFingerprint = source.localFingerprint ?? target.localFingerprint;
    target.pullDrained ||= source.pullDrained;
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
        `SyncDurableFeedReconciler: ${source} MessagesQuery for ${target.did} -> ${target.dwnUrl} returned no cursor before drain`,
      );
    }

    if (!isValidProgressToken(reply.cursor)) {
      throw new Error(
        `SyncDurableFeedReconciler: ${source} MessagesQuery returned an invalid cursor for ${target.did} -> ${target.dwnUrl}`,
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
