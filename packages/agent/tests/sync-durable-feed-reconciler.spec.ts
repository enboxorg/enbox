import type { SinonStub } from 'sinon';

import type { MessagesQueryReply, MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';

import type { SyncReplicationLinkStore } from '../src/sync-replication-link-store.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';
import type { ReplicationLinkState, SyncDirection } from '../src/types/sync.js';

import sinon from 'sinon';

import { describe, expect, it } from 'bun:test';

import type { SyncDurableFeedQuery, SyncDurableFeedReconcilerOperations } from '../src/sync-durable-feed-reconciler.js';

import { SyncCheckpoint } from '../src/sync-checkpoint.js';
import { SyncDurableFeedReconciler } from '../src/sync-durable-feed-reconciler.js';

type StubbedReconcilerOperations = {
  [Method in keyof SyncDurableFeedReconcilerOperations]: SinonStub;
};

type ReconcilerFixture = {
  link: ReplicationLinkState;
  operations: StubbedReconcilerOperations;
  persistCheckpoint: SinonStub;
  queryFeed: SinonStub;
  reconciler: SyncDurableFeedReconciler;
  resetCheckpoint: SinonStub;
};

function token(position: number, messageCid = `cid-${position}`): ProgressToken {
  return { streamId: 'stream-1', epoch: 'epoch-1', position: String(position), messageCid };
}

function target(dwnUrl = 'https://dwn.example', projectionId = 'projection-1'): SyncTarget {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    did                : 'did:example:alice',
    dwnUrl,
    projectionId,
    scope              : { kind: 'full' },
  };
}

function linkFor(syncTarget: SyncTarget): ReplicationLinkState {
  return {
    authorization      : syncTarget.authorization,
    authorizationEpoch : syncTarget.authorizationEpoch,
    connectivity       : 'unknown',
    projectionId       : syncTarget.projectionId,
    pull               : {},
    push               : {},
    remoteEndpoint     : syncTarget.dwnUrl,
    scope              : syncTarget.scope,
    status             : 'live',
    tenantDid          : syncTarget.did,
  };
}

function reply({
  cursor,
  drained = true,
  entries = [],
  fingerprint = 'fingerprint',
  status = 200,
}: {
  cursor?: ProgressToken;
  drained?: boolean;
  entries?: MessagesQueryReplyEntry[];
  fingerprint?: string;
  status?: number;
} = {}): MessagesQueryReply {
  return {
    cursor,
    drained,
    entries,
    fingerprint,
    status: { code: status, detail: status === 200 ? 'OK' : 'Progress Gap' },
  } as MessagesQueryReply;
}

function createReconciler(syncTarget = target()): ReconcilerFixture {
  const link = linkFor(syncTarget);
  const persistCheckpoint = sinon.stub().resolves();
  const resetCheckpoint = sinon.stub().callsFake(async (
    storedLink: ReplicationLinkState,
    direction: SyncDirection,
    baseline?: ProgressToken,
  ): Promise<void> => {
    SyncCheckpoint.reset(storedLink[direction], baseline);
  });
  const linkStore = {
    clear             : sinon.stub().resolves(),
    deleteLink        : sinon.stub().resolves(),
    getAllLinks       : sinon.stub().resolves([]),
    getLinksForTenant : sinon.stub().resolves([]),
    getOrCreateLink   : sinon.stub().resolves(link),
    persistCheckpoint,
    resetCheckpoint,
    resetCheckpoints  : sinon.stub().resolves(),
    setStatus         : sinon.stub().resolves(),
  } satisfies SyncReplicationLinkStore;

  const queryFeed = sinon.stub().callsFake(async ({ source }: SyncDurableFeedQuery): Promise<MessagesQueryReply> =>
    reply({ fingerprint: `${source}-fingerprint` })
  );
  const operations: StubbedReconcilerOperations = {
    admitRemotePage                 : sinon.stub().resolves({ kind: 'processed', admittedCids: [], hasActionableDiffs: false }),
    bootstrapRemotePermissionGrants : sinon.stub().resolves({ kind: 'processed', failures: [], hasActionableDiffs: false, quotaBlocked: false }),
    clearResolvedQuotaOmissions     : sinon.stub().resolves(),
    getReplicationLinkStore         : sinon.stub().returns(linkStore),
    getOrCreateLink                 : sinon.stub().resolves(link),
    getQuotaBlockCids               : sinon.stub().resolves([]),
    onCheckpointAdvanced            : sinon.stub(),
    onReconcileApplied              : sinon.stub(),
    probeQuotaBlocks                : sinon.stub().resolves(),
    pushLocalPage                   : sinon.stub().resolves({ kind: 'processed', hasActionableDiffs: false }),
    queryFeed,
  } satisfies SyncDurableFeedReconcilerOperations;

  return {
    link,
    operations,
    persistCheckpoint,
    queryFeed,
    reconciler: new SyncDurableFeedReconciler(operations),
    resetCheckpoint,
  };
}

describe('SyncDurableFeedReconciler', () => {
  it('should serialize the same link while allowing a different link to reconcile', async () => {
    const { reconciler } = createReconciler();
    const releases: Array<() => void> = [];
    const activeByRemote = new Map<string, number>();
    const maxActiveByRemote = new Map<string, number>();
    let totalActive = 0;
    let maxTotalActive = 0;
    let resolveFirstA!: () => void;
    let resolveSecondA!: () => void;
    let resolveFirstB!: () => void;
    const firstAEntered = new Promise<void>(resolve => { resolveFirstA = resolve; });
    const secondAEntered = new Promise<void>(resolve => { resolveSecondA = resolve; });
    const firstBEntered = new Promise<void>(resolve => { resolveFirstB = resolve; });

    sinon.stub(reconciler, 'pull').callsFake(async (runTarget: SyncTarget): Promise<Record<string, never>> => {
      const active = (activeByRemote.get(runTarget.dwnUrl) ?? 0) + 1;
      activeByRemote.set(runTarget.dwnUrl, active);
      maxActiveByRemote.set(runTarget.dwnUrl, Math.max(maxActiveByRemote.get(runTarget.dwnUrl) ?? 0, active));
      totalActive++;
      maxTotalActive = Math.max(maxTotalActive, totalActive);

      if (runTarget.dwnUrl === 'https://a.example') {
        if (activeByRemote.has(`${runTarget.dwnUrl}:entered`)) {
          resolveSecondA();
        } else {
          activeByRemote.set(`${runTarget.dwnUrl}:entered`, 1);
          resolveFirstA();
        }
      } else {
        resolveFirstB();
      }

      await new Promise<void>(resolve => { releases.push(resolve); });
      activeByRemote.set(runTarget.dwnUrl, active - 1);
      totalActive--;
      return {};
    });
    sinon.stub(reconciler, 'push').resolves({});

    const firstA = reconciler.reconcile(target('https://a.example'));
    await firstAEntered;
    const secondA = reconciler.reconcile(target('https://a.example'));
    const firstB = reconciler.reconcile(target('https://b.example', 'projection-b'));

    try {
      await firstBEntered;
      expect(maxActiveByRemote.get('https://a.example')).toBe(1);
      expect(maxActiveByRemote.get('https://b.example')).toBe(1);
      expect(maxTotalActive).toBe(2);

      releases.shift()?.();
      await secondAEntered;
      expect(maxActiveByRemote.get('https://a.example')).toBe(1);

      for (const release of releases.splice(0)) {
        release();
      }
      await Promise.all([firstA, secondA, firstB]);
      expect((reconciler as any)._runs.size).toBe(0);
    } finally {
      for (const release of releases.splice(0)) {
        release();
      }
    }
  });

  it('should recover the per-link queue after a failed predecessor', async () => {
    const { reconciler } = createReconciler();
    const pull = sinon.stub(reconciler, 'pull');
    pull.onFirstCall().rejects(new Error('first run failed'));
    pull.onSecondCall().resolves({ admittedCids: ['recovered'] });
    sinon.stub(reconciler, 'push').resolves({});

    const failed = reconciler.reconcile(target());
    const recovered = reconciler.reconcile(target());

    await expect(failed).rejects.toThrow('first run failed');
    expect(await recovered).toMatchObject({ admittedCids: ['recovered'] });
    expect(pull.callCount).toBe(2);
  });

  it('should order pull, push, and verification while merging their outcomes', async () => {
    const { reconciler } = createReconciler();
    const calls: string[] = [];
    sinon.stub(reconciler, 'pull').callsFake(async () => {
      calls.push('pull');
      return { admittedCids: ['remote-cid'], hasActionableDiffs: true, remoteFingerprint: 'before' };
    });
    sinon.stub(reconciler, 'push').callsFake(async () => {
      calls.push('push');
      return { hasActionableDiffs: true, localFingerprint: 'before', pushFailures: [] };
    });
    sinon.stub(reconciler, 'verifyConvergence').callsFake(async () => {
      calls.push('verify');
      return { converged: true, localFingerprint: 'after', remoteFingerprint: 'after', pushFailures: [] };
    });

    const result = await reconciler.reconcile(target(), { verifyConvergence: true });

    expect(calls).toEqual(['pull', 'push', 'verify']);
    expect(result).toMatchObject({
      admittedCids       : ['remote-cid'],
      converged          : true,
      hasActionableDiffs : true,
      localFingerprint   : 'after',
      pushFailures       : [],
      remoteFingerprint  : 'after',
    });
  });

  it('should abort between phases without starting push or verification', async () => {
    const { reconciler } = createReconciler();
    let active = true;
    sinon.stub(reconciler, 'pull').callsFake(async () => {
      active = false;
      return { admittedCids: ['applied'] };
    });
    const push = sinon.stub(reconciler, 'push').resolves({});
    const verify = sinon.stub(reconciler, 'verifyConvergence').resolves({ converged: true });

    const result = await reconciler.reconcile(target(), { verifyConvergence: true }, () => active);

    expect(result).toMatchObject({ aborted: true, admittedCids: ['applied'], converged: true });
    expect(push.called).toBe(false);
    expect(verify.called).toBe(false);
  });

  it('should page pull entries and persist each validated checkpoint before reporting it', async () => {
    const fixture = createReconciler();
    fixture.link.pull.contiguousAppliedToken = token(1);
    fixture.queryFeed.onFirstCall().resolves(reply({
      cursor      : token(2),
      drained     : false,
      entries     : [{ messageCid: 'remote-2' }],
      fingerprint : 'page-1',
    }));
    fixture.queryFeed.onSecondCall().resolves(reply({
      cursor      : token(3),
      entries     : [{ messageCid: 'remote-3' }],
      fingerprint : 'page-2',
    }));
    fixture.operations.admitRemotePage.callsFake(async (_target, entries) => ({
      kind               : 'processed' as const,
      admittedCids       : entries.map(({ messageCid }) => messageCid),
      hasActionableDiffs : entries.length > 0,
    }));

    const result = await fixture.reconciler.pull(target());

    expect(result).toEqual({
      admittedCids       : ['remote-2', 'remote-3'],
      hasActionableDiffs : true,
      remoteFingerprint  : 'page-2',
    });
    expect(fixture.persistCheckpoint.callCount).toBe(2);
    expect(fixture.link.pull.contiguousAppliedToken).toEqual(token(3));
    expect(fixture.operations.onCheckpointAdvanced.callCount).toBe(2);
    expect(fixture.persistCheckpoint.calledBefore(fixture.operations.onCheckpointAdvanced)).toBe(true);
  });

  it('should reject a non-advancing cursor before persisting or emitting progress', async () => {
    const fixture = createReconciler();
    fixture.link.pull.contiguousAppliedToken = token(1);
    fixture.queryFeed.resolves(reply({ cursor: token(1), drained: false }));

    await expect(fixture.reconciler.pull(target())).rejects.toThrow(
      'SyncDurableFeedReconciler: pull MessagesQuery cursor did not advance',
    );
    expect(fixture.persistCheckpoint.called).toBe(false);
    expect(fixture.operations.onCheckpointAdvanced.called).toBe(false);
  });

  it('should report partial pull admission before surfacing a deferred dependency', async () => {
    const fixture = createReconciler();
    fixture.link.pull.contiguousAppliedToken = token(1);
    fixture.queryFeed.resolves(reply({
      cursor  : token(2),
      entries : [{ messageCid: 'applied' }, { messageCid: 'deferred' }],
    }));
    fixture.operations.admitRemotePage.resolves({
      kind               : 'deferred',
      admittedCids       : ['applied'],
      detail             : 'dependency missing',
      hasActionableDiffs : true,
      messageCid         : 'deferred',
    });

    await expect(fixture.reconciler.pull(target())).rejects.toThrow(
      'SyncDurableFeedReconciler: pull deferred for deferred: dependency missing',
    );
    expect(fixture.operations.onReconcileApplied.calledOnceWith(target(), ['applied'])).toBe(true);
    expect(fixture.persistCheckpoint.called).toBe(false);
  });

  it('should recover a push progress gap through an inventory diff', async () => {
    const fixture = createReconciler();
    fixture.link.push.contiguousAppliedToken = token(5);
    fixture.queryFeed.onCall(0).resolves(reply({ status: 410 }));
    fixture.queryFeed.onCall(1).resolves(reply({
      cursor  : token(1),
      entries : [],
    }));
    fixture.queryFeed.onCall(2).resolves(reply({
      cursor      : token(2),
      entries     : [{ messageCid: 'local-only' }],
      fingerprint : 'local-final',
    }));
    fixture.operations.pushLocalPage.resolves({ kind: 'processed', hasActionableDiffs: true });

    const result = await fixture.reconciler.push(target());

    expect(fixture.resetCheckpoint.calledOnceWith(fixture.link, 'push')).toBe(true);
    expect(fixture.operations.pushLocalPage.calledOnce).toBe(true);
    expect(fixture.operations.pushLocalPage.firstCall.args[1]).toEqual([{ messageCid: 'local-only' }]);
    expect(fixture.link.push.contiguousAppliedToken).toEqual(token(2));
    expect(fixture.operations.probeQuotaBlocks.calledOnce).toBe(true);
    expect(result).toEqual({
      hasActionableDiffs : true,
      localFingerprint   : 'local-final',
      pushFailures       : [],
    });
  });

  it('should clear resolved quota omissions only after exact fingerprint equality', async () => {
    const fixture = createReconciler();
    fixture.queryFeed.onFirstCall().resolves(reply({ fingerprint: 'same' }));
    fixture.queryFeed.onSecondCall().resolves(reply({ fingerprint: 'same' }));

    expect(await fixture.reconciler.verifyConvergence(target())).toMatchObject({ converged: true });
    expect(fixture.operations.clearResolvedQuotaOmissions.calledOnce).toBe(true);

    fixture.operations.clearResolvedQuotaOmissions.resetHistory();
    fixture.queryFeed.reset();
    fixture.queryFeed.onFirstCall().resolves(reply({ fingerprint: 'local' }));
    fixture.queryFeed.onSecondCall().resolves(reply({ fingerprint: 'remote' }));

    expect(await fixture.reconciler.verifyConvergence(target())).toMatchObject({ converged: false });
    expect(fixture.operations.clearResolvedQuotaOmissions.called).toBe(false);
  });

  // Convergence verification is a LATER observation than the pull and push
  // phases, deliberately: writers other than this device — another device,
  // a server-side actor, or this run's own partially-applied pushes — can
  // move either feed while a reconciliation is in flight. The verdict, and
  // the state-clearing side effects hanging off it, must come from fresh
  // probes of both feeds, never from fingerprints cached earlier in the run.
  describe('convergence verification freshness contract', () => {
    function probeCalls(fixture: ReconcilerFixture, source?: 'local' | 'remote'): SyncDurableFeedQuery[] {
      return fixture.queryFeed.getCalls()
        .map(({ args }) => args[0] as SyncDurableFeedQuery)
        .filter((query) => query.limit === 1 && (source === undefined || query.source === source));
    }

    it('should observe a remote write that lands between the pull and verification', async () => {
      const fixture = createReconciler();
      fixture.link.pull.contiguousAppliedToken = token(1);
      fixture.link.push.contiguousAppliedToken = token(1);
      fixture.queryFeed.callsFake(async ({ limit, source }: SyncDurableFeedQuery): Promise<MessagesQueryReply> => {
        if (limit === 1) {
          // By verification time another writer moved the remote feed.
          return reply({ cursor: token(source === 'remote' ? 2 : 1), fingerprint: source === 'remote' ? 'B' : 'A' });
        }
        return reply({ cursor: token(1), fingerprint: 'A' });
      });

      const result = await fixture.reconciler.reconcile(target(), { verifyConvergence: true });

      expect(probeCalls(fixture)).toHaveLength(2);
      expect(result).toMatchObject({
        converged         : false,
        localFingerprint  : 'A',
        remoteFingerprint : 'B',
      });
      expect(fixture.operations.clearResolvedQuotaOmissions.called).toBe(false);
    });

    it('should observe a local write that lands after the push-phase local sample', async () => {
      const fixture = createReconciler();
      fixture.link.pull.contiguousAppliedToken = token(1);
      fixture.link.push.contiguousAppliedToken = token(1);
      fixture.queryFeed.callsFake(async ({ limit, source }: SyncDurableFeedQuery): Promise<MessagesQueryReply> => {
        if (limit === 1) {
          // A local write landed after the push phase sampled the local feed.
          return reply({ cursor: token(source === 'local' ? 2 : 1), fingerprint: source === 'local' ? 'B' : 'A' });
        }
        return reply({ cursor: token(1), fingerprint: 'A' });
      });

      const result = await fixture.reconciler.reconcile(target(), { verifyConvergence: true });

      expect(probeCalls(fixture)).toHaveLength(2);
      expect(result).toMatchObject({
        converged         : false,
        localFingerprint  : 'B',
        remoteFingerprint : 'A',
      });
      expect(fixture.operations.clearResolvedQuotaOmissions.called).toBe(false);
    });

    it('should observe remote movement from a mixed push that reports no actionable diffs', async () => {
      const fixture = createReconciler();
      fixture.link.pull.contiguousAppliedToken = token(1);
      fixture.link.push.contiguousAppliedToken = token(1);
      fixture.queryFeed.callsFake(async ({ limit, source }: SyncDurableFeedQuery): Promise<MessagesQueryReply> => {
        if (limit === 1) {
          // The staged dependency applied remotely even though the root was
          // rejected — both feeds now fingerprint at the post-write value.
          return reply({ cursor: token(3), fingerprint: 'B' });
        }
        if (source === 'local') {
          return reply({ cursor: token(2), entries: [{ messageCid: 'root' }], fingerprint: 'A' });
        }
        return reply({ cursor: token(1), fingerprint: 'A' });
      });
      // A mixed push outcome: the root entry was terminally rejected (skipped,
      // no actionable diffs) while its staged quota-blocked dependency was
      // applied — the remote feed changed despite the quiet aggregate result.
      fixture.operations.pushLocalPage.resolves({ kind: 'processed', hasActionableDiffs: false });

      const result = await fixture.reconciler.reconcile(target(), { verifyConvergence: true });

      expect(probeCalls(fixture, 'remote')).toHaveLength(1);
      // The verdict reflects the post-push remote state, not the pull-time
      // snapshot ('A') a fingerprint-reuse shortcut would have compared.
      expect(result).toMatchObject({
        converged         : true,
        localFingerprint  : 'B',
        remoteFingerprint : 'B',
      });
    });
  });
});
