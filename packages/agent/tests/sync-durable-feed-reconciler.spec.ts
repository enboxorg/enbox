import type { SinonStub, SinonStubbedInstance } from 'sinon';

import type { MessagesQueryReply, MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';

import type { SyncQuotaBlockEntry } from '../src/sync-quota-manager.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';
import type { ReplicationLinkState, SyncDirection } from '../src/types/sync.js';

import sinon from 'sinon';

import { describe, expect, it } from 'bun:test';

import type { SyncDurableFeedQuery, SyncDurableFeedReconcilerOperations } from '../src/sync-durable-feed-reconciler.js';

import { SyncCheckpoint } from '../src/sync-checkpoint.js';
import { SyncDurableFeedReconciler } from '../src/sync-durable-feed-reconciler.js';
import { SyncQuotaManager } from '../src/sync-quota-manager.js';

type StubbedReconcilerOperations = {
  [Method in keyof SyncDurableFeedReconcilerOperations]: SinonStub;
};

type ReconcilerFixture = {
  link: ReplicationLinkState;
  operations: StubbedReconcilerOperations;
  queryFeed: SinonStub;
  quotaManager: SinonStubbedInstance<SyncQuotaManager>;
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

function quotaBlockEntry(messageCid: string, syncTarget = target()): SyncQuotaBlockEntry {
  return {
    messageCid,
    state: {
      attempts           : 1,
      authorizationEpoch : syncTarget.authorizationEpoch,
      blockedCid         : messageCid,
      firstBlockedAt     : '2026-01-01T00:00:00.000Z',
      lastBlockedAt      : '2026-01-01T00:00:00.000Z',
      linkKey            : `${syncTarget.did}^${syncTarget.dwnUrl}^${syncTarget.projectionId}^${syncTarget.authorizationEpoch}`,
      messageCid,
      nextProbeAt        : '2026-01-01T00:01:00.000Z',
      projectionId       : syncTarget.projectionId,
      remoteEndpoint     : syncTarget.dwnUrl,
      source             : 'feed',
      tenantDid          : syncTarget.did,
    },
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
  const resetCheckpoint = sinon.stub().callsFake(async (
    storedLink: ReplicationLinkState,
    direction: SyncDirection,
    baseline?: ProgressToken,
  ): Promise<void> => {
    SyncCheckpoint.reset(storedLink[direction], baseline);
  });
  const queryFeed = sinon.stub().callsFake(async ({ source }: SyncDurableFeedQuery): Promise<MessagesQueryReply> =>
    reply({ fingerprint: `${source}-fingerprint` })
  );
  const quotaManager = sinon.createStubInstance(SyncQuotaManager);
  quotaManager.clearResolvedOmissionsForTarget.resolves();
  quotaManager.getActiveBlocksForTarget.resolves([]);
  const operations: StubbedReconcilerOperations = {
    admitRemotePage                 : sinon.stub().resolves({ kind: 'processed', admittedCids: [] }),
    bootstrapRemotePermissionGrants : sinon.stub().resolves({ kind: 'processed', failures: [], quotaBlocked: false }),
    commitCheckpoint                : sinon.stub().resolves(),
    probeQuotaBlocks                : sinon.stub().resolves(),
    pushLocalPage                   : sinon.stub().resolves({ kind: 'processed' }),
    queryFeed,
    resetCheckpoint,
  } satisfies SyncDurableFeedReconcilerOperations;

  return {
    link,
    operations,
    queryFeed,
    quotaManager,
    reconciler: new SyncDurableFeedReconciler({ operations, quotaManager }),
    resetCheckpoint,
  };
}

describe('SyncDurableFeedReconciler', () => {
  it('should serialize the same link while allowing a different link to reconcile', async () => {
    const { reconciler } = createReconciler();
    const targetA = target('https://a.example');
    const targetB = target('https://b.example', 'projection-b');
    const linkA = linkFor(targetA);
    const linkB = linkFor(targetB);
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

    const firstA = reconciler.reconcile(targetA, linkA);
    await firstAEntered;
    const secondA = reconciler.reconcile(targetA, linkA);
    const firstB = reconciler.reconcile(targetB, linkB);

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
    const { link, reconciler } = createReconciler();
    const pull = sinon.stub(reconciler, 'pull');
    pull.onFirstCall().rejects(new Error('first run failed'));
    pull.onSecondCall().resolves({ pullDrained: true, remoteFingerprint: 'recovered' });
    sinon.stub(reconciler, 'push').resolves({});

    const failed = reconciler.reconcile(target(), link);
    const recovered = reconciler.reconcile(target(), link);

    await expect(failed).rejects.toThrow('first run failed');
    expect(await recovered).toMatchObject({ pullDrained: true, remoteFingerprint: 'recovered' });
    expect(pull.callCount).toBe(2);
  });

  it('should order pull, push, and verification while merging their observable outcomes', async () => {
    const { link, reconciler } = createReconciler();
    const calls: string[] = [];
    const pull = sinon.stub(reconciler, 'pull').callsFake(async () => {
      calls.push('pull');
      return { pullDrained: true, remoteFingerprint: 'before' };
    });
    const push = sinon.stub(reconciler, 'push').callsFake(async () => {
      calls.push('push');
      return { localFingerprint: 'before', pushFailures: [] };
    });
    sinon.stub(reconciler, 'verifyConvergence').callsFake(async () => {
      calls.push('verify');
      return { converged: true, localFingerprint: 'after', remoteFingerprint: 'after', pushFailures: [] };
    });

    const result = await reconciler.reconcile(target(), link, { verifyConvergence: true });

    expect(calls).toEqual(['pull', 'push', 'verify']);
    expect(pull.firstCall.args[1]).toBe(link);
    expect(push.firstCall.args[1]).toBe(link);
    expect(result).toMatchObject({
      converged         : true,
      localFingerprint  : 'after',
      pullDrained       : true,
      pushFailures      : [],
      remoteFingerprint : 'after',
    });
  });

  it('should report a paused link as paused rather than converged', async () => {
    const { reconciler, link } = createReconciler();
    link.status = 'paused';
    const pull = sinon.stub(reconciler, 'pull').resolves({});
    const push = sinon.stub(reconciler, 'push').resolves({});
    const verify = sinon.stub(reconciler, 'verifyConvergence').resolves({});

    const result = await reconciler.reconcile(target(), link, { verifyConvergence: true });

    // Nothing ran, so nothing was compared. Convergence must be ABSENT —
    // reporting `converged: true` here would let a post-repair verification
    // emit reconcile:completed for a link it never checked.
    expect(result.paused).toBe(true);
    expect(result.converged).toBeUndefined();
    expect(pull.called).toBe(false);
    expect(push.called).toBe(false);
    expect(verify.called).toBe(false);
  });

  it('should abort between phases without starting push or verification', async () => {
    const { link, reconciler } = createReconciler();
    let active = true;
    sinon.stub(reconciler, 'pull').callsFake(async () => {
      active = false;
      return { pullDrained: true };
    });
    const push = sinon.stub(reconciler, 'push').resolves({});
    const verify = sinon.stub(reconciler, 'verifyConvergence').resolves({ converged: true });

    const result = await reconciler.reconcile(target(), link, { verifyConvergence: true }, () => active);

    expect(result).toMatchObject({ aborted: true, converged: true, pullDrained: true });
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
      kind         : 'processed' as const,
      admittedCids : entries.map(({ messageCid }) => messageCid),
    }));

    const result = await fixture.reconciler.pull(target(), fixture.link);

    expect(result).toEqual({
      pullDrained       : true,
      remoteFingerprint : 'page-2',
    });
    expect(fixture.link.pull.contiguousAppliedToken).toEqual(token(3));
    expect(fixture.operations.commitCheckpoint.callCount).toBe(2);
    expect(fixture.operations.commitCheckpoint.firstCall.args).toEqual([fixture.link, 'pull']);
    expect(fixture.operations.commitCheckpoint.secondCall.args).toEqual([fixture.link, 'pull']);
  });

  it('should commit a drained no-change pull page even when its checkpoint position repeats', async () => {
    const fixture = createReconciler();
    fixture.link.pull.contiguousAppliedToken = token(7);
    fixture.queryFeed.resolves(reply({ cursor: token(7), drained: true, entries: [] }));

    const result = await fixture.reconciler.pull(target(), fixture.link);

    expect(result).toMatchObject({ pullDrained: true });
    expect(fixture.operations.commitCheckpoint.calledOnceWithExactly(fixture.link, 'pull')).toBe(true);
  });

  it('should report an authoritatively empty pull as drained without inventing a checkpoint', async () => {
    const fixture = createReconciler();

    const result = await fixture.reconciler.pull(target(), fixture.link);

    expect(result).toMatchObject({ pullDrained: true });
    expect(fixture.link.pull.contiguousAppliedToken).toBeUndefined();
    expect(fixture.operations.commitCheckpoint.notCalled).toBe(true);
  });

  it('should not report a drained pull when a later page is deferred', async () => {
    const fixture = createReconciler();
    fixture.link.pull.contiguousAppliedToken = token(1);
    fixture.queryFeed.onFirstCall().resolves(reply({
      cursor  : token(2),
      drained : false,
      entries : [{ messageCid: 'applied' }],
    }));
    fixture.queryFeed.onSecondCall().resolves(reply({
      cursor  : token(3),
      entries : [{ messageCid: 'deferred' }],
    }));
    fixture.operations.admitRemotePage.onFirstCall().resolves({
      kind         : 'processed',
      admittedCids : ['applied'],
    });
    fixture.operations.admitRemotePage.onSecondCall().resolves({
      kind         : 'deferred',
      admittedCids : [],
      messageCid   : 'deferred',
    });

    const result = await fixture.reconciler.pull(target(), fixture.link);

    expect(result.deferredPull).toEqual({ messageCid: 'deferred' });
    expect(result.pullDrained).toBeUndefined();
    expect(fixture.operations.commitCheckpoint.calledOnceWithExactly(fixture.link, 'pull')).toBe(true);
  });

  it('should admit a 1,000-entry pull catch-up in ordered durable pages without loss', async () => {
    const fixture = createReconciler();
    const entryCount = 1_000;
    const pageSize = 100;
    const expectedCids = Array.from({ length: entryCount }, (_, index): string => `remote-${index + 1}`);
    const admittedCids: string[] = [];
    const operations: string[] = [];
    fixture.link.pull.contiguousAppliedToken = token(0);
    fixture.queryFeed.callsFake(async ({ cursor, limit, source }: SyncDurableFeedQuery): Promise<MessagesQueryReply> => {
      const start = Number(cursor?.position ?? 0);
      const end = Math.min(start + pageSize, entryCount);
      operations.push(`query:${end}`);
      expect(limit).toBe(pageSize);
      expect(source).toBe('remote');
      return reply({
        cursor      : token(end),
        drained     : end === entryCount,
        entries     : expectedCids.slice(start, end).map(messageCid => ({ messageCid })),
        fingerprint : `fingerprint-${end}`,
      });
    });
    fixture.operations.admitRemotePage.callsFake(async (_target, entries) => {
      const pageCids = entries.map(({ messageCid }) => messageCid);
      admittedCids.push(...pageCids);
      operations.push(`admit:${pageCids.at(-1)?.slice('remote-'.length)}`);
      return {
        kind         : 'processed' as const,
        admittedCids : pageCids,
      };
    });
    fixture.operations.commitCheckpoint.callsFake(async (storedLink, direction) => {
      expect(direction).toBe('pull');
      operations.push(`commit:${storedLink.pull.contiguousAppliedToken?.position}`);
    });

    const result = await fixture.reconciler.pull(target(), fixture.link);

    expect(result).toEqual({
      pullDrained       : true,
      remoteFingerprint : 'fingerprint-1000',
    });
    expect(admittedCids).toEqual(expectedCids);
    expect(new Set(admittedCids).size).toBe(entryCount);
    expect(fixture.link.pull.contiguousAppliedToken).toEqual(token(entryCount));
    expect(fixture.queryFeed.callCount).toBe(entryCount / pageSize);
    expect(fixture.operations.admitRemotePage.callCount).toBe(entryCount / pageSize);
    expect(fixture.operations.commitCheckpoint.callCount).toBe(entryCount / pageSize);
    expect(operations).toEqual(Array.from(
      { length: entryCount / pageSize },
      (_, index): string[] => {
        const position = (index + 1) * pageSize;
        return [`query:${position}`, `admit:${position}`, `commit:${position}`];
      },
    ).flat());
  });

  it('should not re-admit a dependency applied by an earlier inventory-diff page', async () => {
    const fixture = createReconciler();
    fixture.queryFeed.callsFake(async ({ cursor, source }: SyncDurableFeedQuery): Promise<MessagesQueryReply> => {
      if (source === 'local') {
        return reply({ entries: [{ messageCid: 'local-existing' }] });
      }
      if (cursor === undefined) {
        return reply({
          cursor  : token(1),
          drained : false,
          entries : [{ messageCid: 'root' }],
        });
      }
      return reply({
        cursor  : token(2),
        entries : [{ messageCid: 'later-dependency' }],
      });
    });
    fixture.operations.admitRemotePage.onFirstCall().resolves({
      kind         : 'processed',
      admittedCids : ['root', 'later-dependency'],
    });
    fixture.operations.admitRemotePage.onSecondCall().resolves({
      kind         : 'processed',
      admittedCids : [],
    });

    const result = await fixture.reconciler.pull(target(), fixture.link);

    expect(result).toEqual({
      pullDrained       : true,
      remoteFingerprint : 'fingerprint',
    });
    expect(fixture.operations.admitRemotePage.callCount).toBe(2);
    expect(fixture.operations.admitRemotePage.firstCall.args[1]).toEqual([{ messageCid: 'root' }]);
    expect(fixture.operations.admitRemotePage.secondCall.args[1]).toEqual([]);
    expect(fixture.link.pull.contiguousAppliedToken).toEqual(token(2));
  });

  it('should reject a non-advancing cursor before persisting or emitting progress', async () => {
    const fixture = createReconciler();
    fixture.link.pull.contiguousAppliedToken = token(1);
    fixture.queryFeed.resolves(reply({ cursor: token(1), drained: false }));

    await expect(fixture.reconciler.pull(target(), fixture.link)).rejects.toThrow(
      'SyncDurableFeedReconciler: pull MessagesQuery cursor did not advance',
    );
    expect(fixture.operations.commitCheckpoint.called).toBe(false);
  });

  it('should reset invalid persisted checkpoints before either direction sends a query', async () => {
    for (const direction of ['pull', 'push'] as const) {
      const fixture = createReconciler();
      fixture.link[direction].contiguousAppliedToken = { ...token(1), streamId: '' };

      await fixture.reconciler[direction](target(), fixture.link);

      expect(fixture.resetCheckpoint.calledOnceWithExactly(fixture.link, direction)).toBe(true);
      expect(fixture.resetCheckpoint.calledBefore(fixture.queryFeed.firstCall)).toBe(true);
      expect(fixture.link[direction].contiguousAppliedToken).toBeUndefined();
      expect(fixture.queryFeed.getCalls().every(({ args }) => args[0].cursor === undefined)).toBe(true);
    }
  });

  it('should not reset an invalid checkpoint after its replication generation is cancelled', async () => {
    const fixture = createReconciler();
    fixture.link.pull.contiguousAppliedToken = { ...token(1), streamId: '' };

    expect(await fixture.reconciler.pull(target(), fixture.link, undefined, (): boolean => false)).toEqual({
      aborted: true,
    });
    expect(fixture.resetCheckpoint.notCalled).toBe(true);
    expect(fixture.queryFeed.notCalled).toBe(true);
  });

  it('should report a deferred pull without advancing the page checkpoint', async () => {
    const fixture = createReconciler();
    fixture.link.pull.contiguousAppliedToken = token(1);
    fixture.queryFeed.resolves(reply({
      cursor  : token(2),
      entries : [{ messageCid: 'applied' }, { messageCid: 'deferred' }],
    }));
    fixture.operations.admitRemotePage.resolves({
      kind         : 'deferred',
      admittedCids : ['applied'],
      detail       : 'dependency missing',
      messageCid   : 'deferred',
    });

    const result = await fixture.reconciler.pull(target(), fixture.link);

    expect(result).toEqual({
      deferredPull: { messageCid: 'deferred', detail: 'dependency missing' },
    });
    expect(fixture.operations.commitCheckpoint.called).toBe(false);
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
    fixture.operations.pushLocalPage.resolves({ kind: 'processed' });

    const result = await fixture.reconciler.push(target(), fixture.link);

    expect(fixture.resetCheckpoint.calledOnceWith(fixture.link, 'push')).toBe(true);
    expect(fixture.operations.pushLocalPage.calledOnce).toBe(true);
    expect(fixture.operations.pushLocalPage.firstCall.args[1]).toEqual([{ messageCid: 'local-only' }]);
    expect(fixture.link.push.contiguousAppliedToken).toEqual(token(2));
    expect(fixture.operations.probeQuotaBlocks.calledOnce).toBe(true);
    expect(result).toEqual({
      localFingerprint : 'local-final',
      pushFailures     : [],
    });
  });

  it('should source an exact force-probe CID snapshot from the quota manager', async () => {
    const fixture = createReconciler();
    const syncTarget = target();
    fixture.quotaManager.getActiveBlocksForTarget.resolves([
      quotaBlockEntry('blocked-a', syncTarget),
      quotaBlockEntry('blocked-b', syncTarget),
    ]);

    await fixture.reconciler.push(syncTarget, fixture.link, { forceQuotaProbe: true });

    expect(fixture.quotaManager.getActiveBlocksForTarget.calledOnceWithExactly(syncTarget)).toBe(true);
    expect(fixture.operations.probeQuotaBlocks.calledOnce).toBe(true);
    expect(fixture.operations.probeQuotaBlocks.firstCall.args).toEqual([
      syncTarget,
      true,
      new Set(['blocked-a', 'blocked-b']),
      undefined,
    ]);
  });

  it('should clear resolved quota omissions only after exact fingerprint equality', async () => {
    const fixture = createReconciler();
    fixture.queryFeed.onFirstCall().resolves(reply({ fingerprint: 'same' }));
    fixture.queryFeed.onSecondCall().resolves(reply({ fingerprint: 'same' }));

    expect(await fixture.reconciler.verifyConvergence(target())).toMatchObject({ converged: true });
    expect(fixture.quotaManager.clearResolvedOmissionsForTarget.calledOnce).toBe(true);

    fixture.quotaManager.clearResolvedOmissionsForTarget.resetHistory();
    fixture.queryFeed.reset();
    fixture.queryFeed.onFirstCall().resolves(reply({ fingerprint: 'local' }));
    fixture.queryFeed.onSecondCall().resolves(reply({ fingerprint: 'remote' }));

    expect(await fixture.reconciler.verifyConvergence(target())).toMatchObject({ converged: false });
    expect(fixture.quotaManager.clearResolvedOmissionsForTarget.called).toBe(false);
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

      const result = await fixture.reconciler.reconcile(target(), fixture.link, { verifyConvergence: true });

      expect(probeCalls(fixture)).toHaveLength(2);
      expect(result).toMatchObject({
        converged         : false,
        localFingerprint  : 'A',
        remoteFingerprint : 'B',
      });
      expect(fixture.quotaManager.clearResolvedOmissionsForTarget.called).toBe(false);
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

      const result = await fixture.reconciler.reconcile(target(), fixture.link, { verifyConvergence: true });

      expect(probeCalls(fixture)).toHaveLength(2);
      expect(result).toMatchObject({
        converged         : false,
        localFingerprint  : 'B',
        remoteFingerprint : 'A',
      });
      expect(fixture.quotaManager.clearResolvedOmissionsForTarget.called).toBe(false);
    });

    it('should observe remote movement after a processed push', async () => {
      const fixture = createReconciler();
      fixture.link.pull.contiguousAppliedToken = token(1);
      fixture.link.push.contiguousAppliedToken = token(1);
      fixture.queryFeed.callsFake(async ({ limit, source }: SyncDurableFeedQuery): Promise<MessagesQueryReply> => {
        if (limit === 1) {
          // By verification time both feeds have moved to the same
          // post-push head.
          return reply({ cursor: token(3), fingerprint: 'B' });
        }
        if (source === 'local') {
          return reply({ cursor: token(2), entries: [{ messageCid: 'root' }], fingerprint: 'A' });
        }
        return reply({ cursor: token(1), fingerprint: 'A' });
      });
      fixture.operations.pushLocalPage.resolves({ kind: 'processed' });

      const result = await fixture.reconciler.reconcile(target(), fixture.link, { verifyConvergence: true });

      expect(fixture.operations.pushLocalPage.calledOnce).toBe(true);
      expect(fixture.operations.pushLocalPage.firstCall.args[1]).toEqual([{ messageCid: 'root' }]);
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
