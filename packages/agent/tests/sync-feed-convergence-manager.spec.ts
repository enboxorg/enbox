import type { SinonStub, SinonStubbedInstance } from 'sinon';

import type { ReplicationLinkState } from '../src/types/sync.js';
import type { SyncDurableFeedReconcileResult } from '../src/sync-durable-feed-reconciler.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';
import type {
  SyncFeedConvergenceLinkContext,
  SyncFeedConvergenceManagerOperations,
} from '../src/sync-feed-convergence-manager.js';

import sinon from 'sinon';

import { describe, expect, it } from 'bun:test';

import { SyncFeedConvergenceManager } from '../src/sync-feed-convergence-manager.js';
import { SyncQuotaManager } from '../src/sync-quota-manager.js';

type FeedConvergenceOperationStubs = {
  [Operation in keyof SyncFeedConvergenceManagerOperations]: SinonStub;
};

type FeedConvergenceFixture = {
  manager: SyncFeedConvergenceManager;
  operations: FeedConvergenceOperationStubs;
  quotaManager: SinonStubbedInstance<SyncQuotaManager>;
};

const ALICE = 'did:example:alice';
const REMOTE = 'https://dwn.example';

function target(): SyncTarget {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    did                : ALICE,
    dwnUrl             : REMOTE,
    projectionId       : 'projection',
    scope              : { kind: 'full' },
  };
}

function linkFor(syncTarget: SyncTarget, status: ReplicationLinkState['status'] = 'live'): ReplicationLinkState {
  return {
    authorization      : syncTarget.authorization,
    authorizationEpoch : syncTarget.authorizationEpoch,
    connectivity       : 'online',
    projectionId       : syncTarget.projectionId,
    pull               : {},
    push               : {},
    remoteEndpoint     : syncTarget.dwnUrl,
    scope              : syncTarget.scope,
    status,
    tenantDid          : syncTarget.did,
  };
}

function linkKey(syncTarget: SyncTarget): string {
  return `${syncTarget.did}^${syncTarget.dwnUrl}^${syncTarget.projectionId}^${syncTarget.authorizationEpoch}`;
}

function contextFor(syncTarget: SyncTarget, link = linkFor(syncTarget)): SyncFeedConvergenceLinkContext {
  return { link, linkKey: linkKey(syncTarget) };
}

function divergence(): SyncDurableFeedReconcileResult {
  return {
    converged         : false,
    localFingerprint  : 'local-fingerprint',
    pushFailures      : [],
    remoteFingerprint : 'remote-fingerprint',
  };
}

function createFixture({
  activeLink,
  storedLink,
  syncTarget = target(),
}: {
  activeLink?: ReplicationLinkState;
  storedLink?: ReplicationLinkState;
  syncTarget?: SyncTarget;
} = {}): FeedConvergenceFixture {
  storedLink ??= linkFor(syncTarget);
  const quotaManager = sinon.createStubInstance(SyncQuotaManager);
  quotaManager.getNextProbeAtForTarget.resolves(undefined);
  quotaManager.reconcileAndExplainFeedDivergence.resolves(false);
  const operations: FeedConvergenceOperationStubs = {
    getActiveLink      : sinon.stub().returns(activeLink ?? storedLink),
    getLink            : sinon.stub().resolves(storedLink),
    getLinkKey         : sinon.stub().callsFake((value: SyncTarget) => linkKey(value)),
    isLinkKeyForTenant : sinon.stub().callsFake(
      (value: string, tenantDid: string) => value.startsWith(`${tenantDid}^`),
    ),
    resetCheckpoints      : sinon.stub().resolves(),
    scheduleLinkWorkByKey : sinon.stub(),
    scheduleQuotaProbe    : sinon.stub(),
  };

  return {
    manager: new SyncFeedConvergenceManager({ operations, quotaManager }),
    operations,
    quotaManager,
  };
}

describe('SyncFeedConvergenceManager', () => {
  it('accepts a quota-explained divergence and schedules its existing Retry-After owner', async () => {
    const syncTarget = target();
    const context = contextFor(syncTarget);
    const { manager, operations, quotaManager } = createFixture({ activeLink: context.link, syncTarget });
    quotaManager.reconcileAndExplainFeedDivergence.resolves(true);
    quotaManager.getNextProbeAtForTarget.resolves('2026-01-01T00:01:00.000Z');

    expect(await manager.handleVerifiedDivergence(syncTarget, divergence(), context)).toBe(true);

    expect(operations.resetCheckpoints.notCalled).toBe(true);
    expect(operations.scheduleLinkWorkByKey.notCalled).toBe(true);
    expect(operations.scheduleQuotaProbe.calledOnceWithExactly(
      context.linkKey,
      context.link,
      '2026-01-01T00:01:00.000Z',
    )).toBe(true);
  });

  it('does not schedule a quota probe without a deadline or a live active link', async () => {
    const syncTarget = target();
    const initializingLink = linkFor(syncTarget, 'initializing');
    const context = contextFor(syncTarget, initializingLink);
    const { manager, operations, quotaManager } = createFixture({ activeLink: initializingLink, syncTarget });
    quotaManager.reconcileAndExplainFeedDivergence.resolves(true);

    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);
    quotaManager.getNextProbeAtForTarget.resolves('2026-01-01T00:01:00.000Z');
    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);

    expect(operations.scheduleQuotaProbe.notCalled).toBe(true);
  });

  it('coalesces an identical mismatch into one ordinary active-link rescan', async () => {
    const syncTarget = target();
    const activeLink = linkFor(syncTarget);
    activeLink.pull.contiguousAppliedToken = { epoch: 'epoch', position: '1', streamId: 'pull' };
    activeLink.push.contiguousAppliedToken = { epoch: 'epoch', position: '2', streamId: 'push' };
    const pullCheckpoint = activeLink.pull;
    const pushCheckpoint = activeLink.push;
    const context = contextFor(syncTarget, activeLink);
    const { manager, operations } = createFixture({ activeLink, storedLink: activeLink, syncTarget });

    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);
    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);
    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);

    expect(activeLink.pull).toBe(pullCheckpoint);
    expect(activeLink.push).toBe(pushCheckpoint);
    expect(operations.resetCheckpoints.calledOnce).toBe(true);
    expect(operations.resetCheckpoints.alwaysCalledWithExactly(activeLink)).toBe(true);
    expect(operations.scheduleLinkWorkByKey.calledOnce).toBe(true);
    expect(operations.scheduleLinkWorkByKey.alwaysCalledWithExactly(
      context.linkKey,
      activeLink,
      ['pull', 'push'],
      0,
    )).toBe(true);

    await manager.clear(syncTarget, context);
    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);
    expect(operations.resetCheckpoints.calledTwice).toBe(true);
    expect(operations.scheduleLinkWorkByKey.calledTwice).toBe(true);
  });

  it('resets a controller-less durable link without creating a runtime retry path', async () => {
    const syncTarget = target();
    const storedLink = linkFor(syncTarget, 'initializing');
    const context = contextFor(syncTarget, storedLink);
    const { manager, operations } = createFixture({ storedLink, syncTarget });
    operations.getActiveLink.returns(undefined);

    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);

    expect(operations.resetCheckpoints.calledOnceWithExactly(storedLink)).toBe(true);
    expect(operations.scheduleLinkWorkByKey.notCalled).toBe(true);
  });

  it('resolves durable link context only when the caller does not already have it', async () => {
    const syncTarget = target();
    const context = contextFor(syncTarget);
    const { manager, operations } = createFixture({ storedLink: context.link, syncTarget });

    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);
    expect(operations.getLink.notCalled).toBe(true);

    await manager.handleVerifiedDivergence(syncTarget, divergence());
    expect(operations.getLink.calledOnceWithExactly(syncTarget)).toBe(true);
    expect(operations.getLinkKey.calledOnceWithExactly(syncTarget, context.link)).toBe(true);
  });
});
