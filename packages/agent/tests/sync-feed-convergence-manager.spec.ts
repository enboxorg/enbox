import type { SinonStub } from 'sinon';

import type { SyncDurableFeedReconcileResult } from '../src/sync-durable-feed-reconciler.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';
import type { DeadLetterEntry, ReplicationLinkState, SyncScope } from '../src/types/sync.js';
import type {
  SyncFeedConvergenceLinkContext,
  SyncFeedConvergenceManagerOperations,
} from '../src/sync-feed-convergence-manager.js';

import sinon from 'sinon';

import { describe, expect, it } from 'bun:test';

import { SyncFeedConvergenceManager } from '../src/sync-feed-convergence-manager.js';

type FeedConvergenceOperationStubs = {
  [Operation in keyof SyncFeedConvergenceManagerOperations]: SinonStub;
};

type FeedConvergenceFixture = {
  manager: SyncFeedConvergenceManager;
  operations: FeedConvergenceOperationStubs;
};

const ALICE = 'did:example:alice';
const BOB = 'did:example:bob';
const REMOTE = 'https://dwn.example';

function target({
  did = ALICE,
  dwnUrl = REMOTE,
  projectionId = 'projection',
  scope = { kind: 'full' },
}: {
  did?: string;
  dwnUrl?: string;
  projectionId?: string;
  scope?: SyncScope;
} = {}): SyncTarget {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    did,
    dwnUrl,
    projectionId,
    scope,
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

function divergence(
  localFingerprint = 'local-fingerprint',
  remoteFingerprint = 'remote-fingerprint',
): SyncDurableFeedReconcileResult {
  return {
    converged          : false,
    hasActionableDiffs : true,
    localFingerprint,
    pushFailures       : [],
    remoteFingerprint,
  };
}

function deadLetter(
  messageCid: string,
  overrides: Partial<DeadLetterEntry> = {},
): DeadLetterEntry {
  return {
    errorDetail    : 'admission failed',
    failedAt       : '2026-01-01T00:00:00.000Z',
    messageCid,
    remoteEndpoint : REMOTE,
    tenantDid      : ALICE,
    ...overrides,
  };
}

function createFixture({
  activeLink,
  ledgerLink,
  maxAttempts,
  syncTarget = target(),
}: {
  activeLink?: ReplicationLinkState;
  ledgerLink?: ReplicationLinkState;
  maxAttempts?: number;
  syncTarget?: SyncTarget;
} = {}): FeedConvergenceFixture {
  const storedLink = ledgerLink ?? linkFor(syncTarget);
  const operations: FeedConvergenceOperationStubs = {
    getActiveLink           : sinon.stub().returns(activeLink ?? storedLink),
    getDeadLettersForTenant : sinon.stub().resolves([]),
    getLink                 : sinon.stub().resolves(storedLink),
    getLinkKey              : sinon.stub().callsFake((value: SyncTarget) => linkKey(value)),
    getNextQuotaProbeAt     : sinon.stub().resolves(undefined),
    isDivergenceExplained   : sinon.stub().resolves(false),
    isLinkKeyForTenant      : sinon.stub().callsFake(
      (value: string, tenantDid: string) => value.startsWith(`${tenantDid}^`),
    ),
    resetCheckpoints      : sinon.stub().resolves(),
    scheduleLinkReconcile : sinon.stub(),
    scheduleQuotaProbe    : sinon.stub(),
    transitionToPaused    : sinon.stub().resolves(),
  };

  return {
    manager: new SyncFeedConvergenceManager({ maxAttempts, operations }),
    operations,
  };
}

describe('SyncFeedConvergenceManager', () => {
  it('accepts quota-explained divergence, clears its failure history, and schedules the next live probe', async () => {
    const syncTarget = target();
    const context = contextFor(syncTarget);
    const { manager, operations } = createFixture({ activeLink: context.link, syncTarget });
    operations.isDivergenceExplained.onCall(0).resolves(false);
    operations.isDivergenceExplained.onCall(1).resolves(false);
    operations.isDivergenceExplained.onCall(2).resolves(true);
    operations.isDivergenceExplained.onCall(3).resolves(false);
    operations.getNextQuotaProbeAt.resolves('2026-01-01T00:01:00.000Z');

    expect(await manager.handleVerifiedDivergence(syncTarget, divergence(), context)).toBe(false);
    expect(await manager.handleVerifiedDivergence(syncTarget, divergence(), context)).toBe(false);
    expect(await manager.handleVerifiedDivergence(syncTarget, divergence(), context)).toBe(true);
    expect(await manager.handleVerifiedDivergence(syncTarget, divergence(), context)).toBe(false);

    expect(operations.transitionToPaused.notCalled).toBe(true);
    expect(operations.resetCheckpoints.callCount).toBe(3);
    expect(operations.scheduleQuotaProbe.calledOnceWithExactly(
      context.linkKey,
      context.link,
      '2026-01-01T00:01:00.000Z',
    )).toBe(true);
    expect(operations.getLink.notCalled).toBe(true);
  });

  it('does not schedule a quota probe without a next deadline or a live active link', async () => {
    const syncTarget = target();
    const initializingLink = linkFor(syncTarget, 'initializing');
    const context = contextFor(syncTarget, initializingLink);
    const { manager, operations } = createFixture({ activeLink: initializingLink, syncTarget });
    operations.isDivergenceExplained.resolves(true);

    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);
    operations.getNextQuotaProbeAt.resolves('2026-01-01T00:01:00.000Z');
    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);

    expect(operations.getActiveLink.calledOnceWithExactly(context.linkKey)).toBe(true);
    expect(operations.scheduleQuotaProbe.notCalled).toBe(true);
  });

  it('uses only relevant, deduplicated admission dead letters in the repeated-failure signature', async () => {
    const syncTarget = target({
      scope: { kind: 'protocolSet', protocols: ['https://protocol.example/covered'] },
    });
    const context = contextFor(syncTarget);
    const { manager, operations } = createFixture({ activeLink: context.link, syncTarget });
    const relevantA = deadLetter('cid-a');
    const relevantB = deadLetter('cid-b', { protocol: 'https://protocol.example/covered' });
    const relevantC = deadLetter('cid-c', { protocol: 'https://protocol.example/covered' });
    const irrelevant = (suffix: string): DeadLetterEntry[] => [
      deadLetter(`wrong-remote-${suffix}`, { remoteEndpoint: 'https://other.example' }),
      deadLetter(`wrong-protocol-${suffix}`, { protocol: 'https://protocol.example/sibling' }),
    ];
    operations.getDeadLettersForTenant.onCall(0).resolves([
      relevantB,
      relevantA,
      relevantB,
      ...irrelevant('first'),
    ]);
    operations.getDeadLettersForTenant.onCall(1).resolves([
      ...irrelevant('second'),
      relevantA,
      relevantB,
    ]);
    operations.getDeadLettersForTenant.onCall(2).resolves([
      relevantC,
      relevantB,
      relevantA,
      ...irrelevant('third'),
    ]);
    operations.getDeadLettersForTenant.onCall(3).resolves([
      ...irrelevant('fourth'),
      relevantA,
      relevantC,
      relevantB,
    ]);
    operations.getDeadLettersForTenant.onCall(4).resolves([
      relevantB,
      relevantC,
      relevantA,
      relevantC,
      ...irrelevant('fifth'),
    ]);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await manager.handleVerifiedDivergence(syncTarget, divergence(), context);
    }

    expect(operations.resetCheckpoints.callCount).toBe(4);
    expect(operations.scheduleLinkReconcile.callCount).toBe(4);
    expect(operations.transitionToPaused.calledOnceWithExactly(context.linkKey, context.link)).toBe(true);
  });

  it('resets the attempt count when either feed fingerprint changes', async () => {
    const syncTarget = target();
    const context = contextFor(syncTarget);
    const { manager, operations } = createFixture({ activeLink: context.link, syncTarget });

    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);
    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);
    await manager.handleVerifiedDivergence(syncTarget, divergence('new-local', 'new-remote'), context);
    await manager.handleVerifiedDivergence(syncTarget, divergence('new-local', 'new-remote'), context);
    await manager.handleVerifiedDivergence(syncTarget, divergence('new-local', 'new-remote'), context);

    expect(operations.resetCheckpoints.callCount).toBe(4);
    expect(operations.transitionToPaused.calledOnceWithExactly(context.linkKey, context.link)).toBe(true);
  });

  it('includes protocol-tagged admission failures in a full-scope signature', async () => {
    const syncTarget = target();
    const context = contextFor(syncTarget);
    const { manager, operations } = createFixture({ activeLink: context.link, maxAttempts: 2, syncTarget });
    operations.getDeadLettersForTenant.onFirstCall().resolves([
      deadLetter('cid-a', { protocol: 'https://protocol.example/first' }),
    ]);
    operations.getDeadLettersForTenant.onSecondCall().resolves([
      deadLetter('cid-b', { protocol: 'https://protocol.example/second' }),
    ]);
    operations.getDeadLettersForTenant.onThirdCall().resolves([
      deadLetter('cid-b', { protocol: 'https://protocol.example/second' }),
    ]);

    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);
    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);
    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);

    expect(operations.resetCheckpoints.calledTwice).toBe(true);
    expect(operations.transitionToPaused.calledOnceWithExactly(context.linkKey, context.link)).toBe(true);
  });

  it('copies durable checkpoints into a replacement active link before resetting or pausing it', async () => {
    const syncTarget = target();
    const ledgerLink = linkFor(syncTarget);
    const activeLink = linkFor(syncTarget);
    ledgerLink.pull = { contiguousAppliedToken: { epoch: 'epoch', position: '1', streamId: 'pull' } };
    ledgerLink.push = { contiguousAppliedToken: { epoch: 'epoch', position: '2', streamId: 'push' } };
    const context = contextFor(syncTarget, ledgerLink);
    const { manager, operations } = createFixture({ activeLink, ledgerLink, syncTarget });

    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);
    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);
    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);

    expect(activeLink.pull).toBe(ledgerLink.pull);
    expect(activeLink.push).toBe(ledgerLink.push);
    expect(operations.resetCheckpoints.calledTwice).toBe(true);
    expect(operations.resetCheckpoints.alwaysCalledWithExactly(activeLink)).toBe(true);
    expect(operations.scheduleLinkReconcile.calledTwice).toBe(true);
    expect(operations.scheduleLinkReconcile.alwaysCalledWithExactly(
      context.linkKey,
      activeLink,
      'feed-fingerprint-mismatch',
      0,
    )).toBe(true);
    expect(operations.transitionToPaused.calledOnceWithExactly(context.linkKey, activeLink)).toBe(true);
  });

  it('resets a controller-less durable link without scheduling live reconciliation', async () => {
    const syncTarget = target();
    const ledgerLink = linkFor(syncTarget, 'initializing');
    const context = contextFor(syncTarget, ledgerLink);
    const { manager, operations } = createFixture({ ledgerLink, syncTarget });
    operations.getActiveLink.returns(undefined);

    await manager.handleVerifiedDivergence(syncTarget, divergence(), context);

    expect(operations.resetCheckpoints.calledOnceWithExactly(ledgerLink)).toBe(true);
    expect(operations.scheduleLinkReconcile.notCalled).toBe(true);
  });

  it('resolves a link only when clear is called without an existing context', async () => {
    const syncTarget = target();
    const context = contextFor(syncTarget);
    const { manager, operations } = createFixture({ ledgerLink: context.link, syncTarget });

    await manager.clear(syncTarget, context);
    expect(operations.getLink.notCalled).toBe(true);

    await manager.clear(syncTarget);
    expect(operations.getLink.calledOnceWithExactly(syncTarget)).toBe(true);
    expect(operations.getLinkKey.calledOnceWithExactly(syncTarget, context.link)).toBe(true);
  });

  it('clears repeated failures by link, tenant, or all links without touching unrelated tenants', async () => {
    const aliceA = target({ projectionId: 'alice-a' });
    const aliceB = target({ projectionId: 'alice-b' });
    const bob = target({ did: BOB, projectionId: 'bob' });
    const aliceAContext = contextFor(aliceA);
    const aliceBContext = contextFor(aliceB);
    const bobContext = contextFor(bob);
    const { manager, operations } = createFixture({ maxAttempts: 2 });
    operations.getActiveLink.returns(undefined);

    await manager.handleVerifiedDivergence(aliceA, divergence(), aliceAContext);
    await manager.handleVerifiedDivergence(aliceB, divergence(), aliceBContext);
    await manager.handleVerifiedDivergence(bob, divergence(), bobContext);
    manager.clearLink(aliceAContext.linkKey);

    await manager.handleVerifiedDivergence(aliceA, divergence(), aliceAContext);
    expect(operations.transitionToPaused.notCalled).toBe(true);

    manager.clearTenant(ALICE);

    await manager.handleVerifiedDivergence(aliceB, divergence(), aliceBContext);
    await manager.handleVerifiedDivergence(bob, divergence(), bobContext);

    expect(operations.transitionToPaused.calledOnceWithExactly(bobContext.linkKey, bobContext.link)).toBe(true);

    manager.clearAll();
    await manager.handleVerifiedDivergence(bob, divergence(), bobContext);

    expect(operations.transitionToPaused.calledOnce).toBe(true);
    expect(operations.isLinkKeyForTenant.calledWithExactly(bobContext.linkKey, ALICE)).toBe(true);
  });
});
