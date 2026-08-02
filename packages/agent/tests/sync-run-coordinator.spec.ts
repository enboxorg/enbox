import type { SinonStub, SinonStubbedInstance } from 'sinon';

import type { SyncDurableFeedReconcileResult } from '../src/sync-durable-feed-reconciler.js';
import type { SyncRunCoordinatorOperations } from '../src/sync-run-coordinator.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import sinon from 'sinon';

import { describe, expect, it } from 'bun:test';

import { SyncConnectivityManager } from '../src/sync-connectivity-manager.js';
import { SyncFeedConvergenceManager } from '../src/sync-feed-convergence-manager.js';
import { SyncRunCoordinator } from '../src/sync-run-coordinator.js';

import { deferred } from './utils/deferred.js';

type RunFixtureOperations = {
  [Operation in keyof SyncRunCoordinatorOperations]: SinonStub;
};

type RunFixture = {
  connectivityManager: SinonStubbedInstance<SyncConnectivityManager>;
  coordinator: SyncRunCoordinator;
  feedConvergenceManager: SinonStubbedInstance<SyncFeedConvergenceManager>;
  operations: RunFixtureOperations;
};

function ownerTarget(did: string, dwnUrl: string): SyncTarget {
  return {
    did,
    dwnUrl,
    scope              : { kind: 'full' },
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    projectionId       : `projection-${did}`,
  };
}

function roleTarget(actorDid: string, sourceDid = 'did:example:owner'): SyncTarget {
  return {
    ...ownerTarget(sourceDid, 'https://owner.example'),
    authorization: {
      kind         : 'role',
      actorDid,
      protocolRole : 'notebook/member',
      roleRecordId : `role-${actorDid}`,
    },
    scope: {
      kind          : 'context',
      contextId     : 'notebook-a',
      protocol      : 'https://example.com/notebooks',
      protocolPaths : ['notebook'],
    },
  };
}

function reconciled(converged = true): SyncDurableFeedReconcileResult {
  return {
    converged,
    localFingerprint  : converged ? 'fingerprint' : 'local-fingerprint',
    pushFailures      : [],
    remoteFingerprint : converged ? 'fingerprint' : 'remote-fingerprint',
  };
}

function createFixture(targets: SyncTarget[] = [
  ownerTarget('did:example:alice', 'https://a.example'),
]): RunFixture {
  const connectivityManager = sinon.createStubInstance(SyncConnectivityManager);
  const feedConvergenceManager = sinon.createStubInstance(SyncFeedConvergenceManager);
  feedConvergenceManager.clear.resolves();
  feedConvergenceManager.handleVerifiedDivergence.resolves(false);
  const operations = {
    getTargets           : sinon.stub().resolves(targets),
    probeFeedConvergence : sinon.stub().resolves(reconciled()),
    reconcileTarget      : sinon.stub().resolves(reconciled()),
    recordPushFailures   : sinon.stub().resolves(0),
    reportError          : sinon.stub(),
  } satisfies SyncRunCoordinatorOperations;

  return {
    connectivityManager,
    coordinator: new SyncRunCoordinator({ connectivityManager, feedConvergenceManager, operations }),
    feedConvergenceManager,
    operations,
  };
}

describe('SyncRunCoordinator', () => {
  it('leaves connectivity unchanged when the current target plan is empty', async () => {
    const { connectivityManager, coordinator, operations } = createFixture([]);

    await coordinator.run();

    expect(operations.reconcileTarget.notCalled).toBe(true);
    expect(connectivityManager.recordSuccess.notCalled).toBe(true);
    expect(connectivityManager.recordFailure.notCalled).toBe(true);
  });

  it('reconciles only the scoped identity when options.did is provided', async () => {
    const alice = ownerTarget('did:example:alice', 'https://a.example');
    const aliceSecondEndpoint = ownerTarget('did:example:alice', 'https://b.example');
    const bob = ownerTarget('did:example:bob', 'https://a.example');
    const { coordinator, operations } = createFixture([alice, aliceSecondEndpoint, bob]);

    await coordinator.run('pull', { did: 'did:example:alice' });

    const reconciledTargets = operations.reconcileTarget.getCalls().map(call => call.args[0] as SyncTarget);
    expect(reconciledTargets.map(target => target.did)).toEqual([
      'did:example:alice',
      'did:example:alice',
    ]);
    expect(reconciledTargets.map(target => target.dwnUrl).sort()).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('includes foreign targets authorized by the scoped identity', async () => {
    const alice = roleTarget('did:example:alice');
    const bob = roleTarget('did:example:bob');
    const { coordinator, operations } = createFixture([alice, bob]);

    await coordinator.run('pull', { did: 'did:example:alice' });

    expect(operations.reconcileTarget.calledOnceWithExactly(alice, 'pull', undefined)).toBe(true);
  });

  it('does not select another actor role target by its foreign owner DID', async () => {
    const aliceDid = 'did:example:alice';
    const aliceOwned = ownerTarget(aliceDid, 'https://alice.example');
    const aliceRole = roleTarget(aliceDid);
    const bobRoleOnAlice = roleTarget('did:example:bob', aliceDid);
    const { coordinator, operations } = createFixture([aliceOwned, aliceRole, bobRoleOnAlice]);

    await coordinator.run('pull', { did: aliceDid });

    expect(operations.reconcileTarget.calledWith(aliceOwned)).toBe(true);
    expect(operations.reconcileTarget.calledWith(aliceRole)).toBe(true);
    expect(operations.reconcileTarget.calledWith(bobRoleOnAlice)).toBe(false);
  });

  it('no-ops a scoped run whose identity matches no targets', async () => {
    const { coordinator, operations } = createFixture([
      ownerTarget('did:example:alice', 'https://a.example'),
    ]);

    await coordinator.run(undefined, { did: 'did:example:carol' });

    expect(operations.reconcileTarget.notCalled).toBe(true);
  });

  it('runs endpoints concurrently while keeping targets within each endpoint sequential', async () => {
    const alice = ownerTarget('did:example:alice', 'https://a.example');
    const bob = ownerTarget('did:example:bob', 'https://a.example');
    const carol = ownerTarget('did:example:carol', 'https://b.example');
    const firstEndpoint = deferred<SyncDurableFeedReconcileResult>();
    const secondEndpoint = deferred<SyncDurableFeedReconcileResult>();
    const endpointsStarted = deferred<void>();
    const started: string[] = [];
    const { connectivityManager, coordinator, operations } = createFixture([alice, bob, carol]);
    operations.reconcileTarget.callsFake(async (target: SyncTarget): Promise<SyncDurableFeedReconcileResult> => {
      started.push(target.did);
      if (started.length === 2) {
        endpointsStarted.resolve();
      }
      if (target === alice) {
        return firstEndpoint.promise;
      }
      if (target === carol) {
        return secondEndpoint.promise;
      }
      return reconciled();
    });

    const run = coordinator.run('push', { verifyConvergence: false });
    await endpointsStarted.promise;

    expect(started).toEqual(['did:example:alice', 'did:example:carol']);
    secondEndpoint.resolve(reconciled());
    expect(started).not.toContain('did:example:bob');

    firstEndpoint.resolve(reconciled());
    await run;

    expect(started).toEqual([
      'did:example:alice',
      'did:example:carol',
      'did:example:bob',
    ]);
    expect(operations.reconcileTarget.alwaysCalledWith(
      sinon.match.object,
      'push',
      false,
    )).toBe(true);
    expect(connectivityManager.recordSuccess.calledOnce).toBe(true);
  });

  it('skips the rest of one failed endpoint while allowing another endpoint to succeed', async () => {
    const alice = ownerTarget('did:example:alice', 'https://a.example');
    const bob = ownerTarget('did:example:bob', 'https://a.example');
    const carol = ownerTarget('did:example:carol', 'https://b.example');
    const failure = new Error('remote unavailable');
    const { connectivityManager, coordinator, operations } = createFixture([alice, bob, carol]);
    operations.reconcileTarget.callsFake(async (target: SyncTarget): Promise<SyncDurableFeedReconcileResult> => {
      if (target === alice) {
        throw failure;
      }
      return reconciled();
    });

    await expect(coordinator.run()).rejects.toThrow(
      'SyncRunCoordinator: Sync operation failed for 1 remote endpoint(s): https://a.example',
    );

    expect(operations.reconcileTarget.calledWith(bob)).toBe(false);
    expect(operations.reconcileTarget.calledWith(carol)).toBe(true);
    expect(operations.reportError.calledOnceWithExactly(
      'SyncRunCoordinator: Error syncing did:example:alice with https://a.example',
      failure,
    )).toBe(true);
    expect(connectivityManager.recordSuccess.calledOnce).toBe(true);
    expect(connectivityManager.recordFailure.notCalled).toBe(true);
  });

  it('records connectivity failure and reports every normally failed endpoint', async () => {
    const alice = ownerTarget('did:example:alice', 'https://a.example');
    const bob = ownerTarget('did:example:bob', 'https://b.example');
    const { connectivityManager, coordinator, operations } = createFixture([alice, bob]);
    operations.reconcileTarget.rejects(new Error('offline'));

    await expect(coordinator.run()).rejects.toThrow(
      'SyncRunCoordinator: Sync operation failed for 2 remote endpoint(s): https://a.example, https://b.example',
    );

    expect(operations.reportError.callCount).toBe(2);
    expect(connectivityManager.recordFailure.calledOnce).toBe(true);
    expect(connectivityManager.recordSuccess.notCalled).toBe(true);
  });

  it('counts an unexpectedly rejected endpoint group without claiming a known URL', async () => {
    const { connectivityManager, coordinator, operations } = createFixture();
    operations.reconcileTarget.rejects(new Error('offline'));
    operations.reportError.throws(new Error('logger failed'));

    await expect(coordinator.run()).rejects.toThrow(
      'SyncRunCoordinator: Sync operation failed for 1 remote endpoint(s).',
    );

    expect(connectivityManager.recordFailure.calledOnce).toBe(true);
  });

  it('records terminal push failures without requiring verification', async () => {
    const pushFailures = [{ cid: 'terminal-cid', terminal: true }];
    const { coordinator, feedConvergenceManager, operations } = createFixture();
    operations.reconcileTarget.resolves({
      converged: false,
      pushFailures,
    });

    await coordinator.run('pull');

    expect(operations.recordPushFailures.calledOnceWithExactly(
      sinon.match.object,
      pushFailures,
    )).toBe(true);
    expect(feedConvergenceManager.handleVerifiedDivergence.notCalled).toBe(true);
    expect(feedConvergenceManager.clear.notCalled).toBe(true);
  });

  it('reports retryable push failures with coordinator-owned diagnostics', async () => {
    const pushFailures = [{ cid: 'retryable-cid' }];
    const { coordinator, feedConvergenceManager, operations } = createFixture();
    operations.reconcileTarget.resolves({ converged: true, pushFailures });
    operations.recordPushFailures.resolves(2);

    await expect(coordinator.run()).rejects.toThrow(
      'SyncRunCoordinator: Sync operation failed for 1 remote endpoint(s): https://a.example',
    );

    const reportedError = operations.reportError.firstCall.args[1];
    expect(reportedError).toBeInstanceOf(Error);
    expect(reportedError.message).toBe(
      'SyncRunCoordinator: reconciliation push failed for 2 retryable message(s).',
    );
    expect(feedConvergenceManager.handleVerifiedDivergence.notCalled).toBe(true);
    expect(feedConvergenceManager.clear.notCalled).toBe(true);
  });

  it('records divergent and recovered convergence state only when verification is requested', async () => {
    const alice = ownerTarget('did:example:alice', 'https://a.example');
    const bob = ownerTarget('did:example:bob', 'https://a.example');
    const { coordinator, feedConvergenceManager, operations } = createFixture([alice, bob]);
    operations.reconcileTarget.callsFake(async (target: SyncTarget): Promise<SyncDurableFeedReconcileResult> =>
      reconciled(target === bob)
    );

    await coordinator.run(undefined, { verifyConvergence: true });

    expect(feedConvergenceManager.handleVerifiedDivergence.calledOnceWithExactly(
      alice,
      sinon.match({ converged: false }),
    )).toBe(true);
    expect(feedConvergenceManager.clear.calledOnceWithExactly(bob)).toBe(true);
    expect(operations.reconcileTarget.alwaysCalledWith(
      sinon.match.object,
      undefined,
      true,
    )).toBe(true);
  });

  it('settles a converged target with a fingerprint probe and no reconciliation', async () => {
    const target = ownerTarget('did:example:alice', 'https://a.example');
    const { connectivityManager, coordinator, feedConvergenceManager, operations } = createFixture([target]);

    await coordinator.settle();

    expect(operations.probeFeedConvergence.calledOnceWithExactly(target)).toBe(true);
    expect(operations.reconcileTarget.notCalled).toBe(true);
    expect(feedConvergenceManager.clear.calledOnceWithExactly(target)).toBe(true);
    expect(connectivityManager.recordSuccess.calledOnce).toBe(true);
  });

  it('leaves connectivity unchanged when every settle target is paused or superseded', async () => {
    const alice = ownerTarget('did:example:alice', 'https://a.example');
    const bob = ownerTarget('did:example:bob', 'https://b.example');
    const { connectivityManager, coordinator, feedConvergenceManager, operations } = createFixture([alice, bob]);
    operations.probeFeedConvergence.callsFake(
      async (target: SyncTarget): Promise<SyncDurableFeedReconcileResult> =>
        target === alice ? { paused: true } : { aborted: true },
    );

    await coordinator.settle();

    expect(operations.reconcileTarget.notCalled).toBe(true);
    expect(feedConvergenceManager.clear.notCalled).toBe(true);
    expect(connectivityManager.recordSuccess.notCalled).toBe(true);
    expect(connectivityManager.recordFailure.notCalled).toBe(true);
  });

  it('settles a fingerprint mismatch with one verified reconciliation', async () => {
    const target = ownerTarget('did:example:alice', 'https://a.example');
    const { coordinator, feedConvergenceManager, operations } = createFixture([target]);
    operations.probeFeedConvergence.resolves(reconciled(false));

    await coordinator.settle();

    expect(operations.reconcileTarget.calledOnceWithExactly(target, undefined, true)).toBe(true);
    expect(feedConvergenceManager.clear.calledOnceWithExactly(target)).toBe(true);
  });

  it('contains a settle probe error to its endpoint group', async () => {
    const alice = ownerTarget('did:example:alice', 'https://a.example');
    const bob = ownerTarget('did:example:bob', 'https://a.example');
    const carol = ownerTarget('did:example:carol', 'https://b.example');
    const failure = new Error('probe unavailable');
    const { connectivityManager, coordinator, operations } = createFixture([alice, bob, carol]);
    operations.probeFeedConvergence.callsFake(
      async (target: SyncTarget): Promise<SyncDurableFeedReconcileResult> => {
        if (target === alice) {
          throw failure;
        }
        return reconciled();
      },
    );

    await expect(coordinator.settle()).rejects.toThrow(
      'SyncRunCoordinator: Sync operation failed for 1 remote endpoint(s): https://a.example',
    );

    expect(operations.probeFeedConvergence.calledWith(bob)).toBe(false);
    expect(operations.probeFeedConvergence.calledWith(carol)).toBe(true);
    expect(operations.reportError.calledOnceWithExactly(
      'SyncRunCoordinator: Error syncing did:example:alice with https://a.example',
      failure,
    )).toBe(true);
    expect(connectivityManager.recordSuccess.calledOnce).toBe(true);
    expect(connectivityManager.recordFailure.notCalled).toBe(true);
  });

  it('records connectivity failure when every settle endpoint probe fails', async () => {
    const alice = ownerTarget('did:example:alice', 'https://a.example');
    const bob = ownerTarget('did:example:bob', 'https://b.example');
    const { connectivityManager, coordinator, operations } = createFixture([alice, bob]);
    operations.probeFeedConvergence.rejects(new Error('offline'));

    await expect(coordinator.settle()).rejects.toThrow(
      'SyncRunCoordinator: Sync operation failed for 2 remote endpoint(s): https://a.example, https://b.example',
    );

    expect(operations.reportError.callCount).toBe(2);
    expect(connectivityManager.recordFailure.calledOnce).toBe(true);
    expect(connectivityManager.recordSuccess.notCalled).toBe(true);
  });

  it('settles endpoint groups concurrently and targets within each group sequentially', async () => {
    const alice = ownerTarget('did:example:alice', 'https://a.example');
    const bob = ownerTarget('did:example:bob', 'https://a.example');
    const carol = ownerTarget('did:example:carol', 'https://b.example');
    const firstEndpoint = deferred<SyncDurableFeedReconcileResult>();
    const secondEndpoint = deferred<SyncDurableFeedReconcileResult>();
    const endpointsStarted = deferred<void>();
    const started: string[] = [];
    const { coordinator, operations } = createFixture([alice, bob, carol]);
    operations.probeFeedConvergence.callsFake(
      async (target: SyncTarget): Promise<SyncDurableFeedReconcileResult> => {
        started.push(target.did);
        if (started.length === 2) {
          endpointsStarted.resolve();
        }
        if (target === alice) {
          return firstEndpoint.promise;
        }
        if (target === carol) {
          return secondEndpoint.promise;
        }
        return reconciled();
      },
    );

    const settle = coordinator.settle();
    await endpointsStarted.promise;

    expect(started).toEqual(['did:example:alice', 'did:example:carol']);
    secondEndpoint.resolve(reconciled());
    expect(started).not.toContain('did:example:bob');

    firstEndpoint.resolve(reconciled());
    await settle;

    expect(started).toEqual([
      'did:example:alice',
      'did:example:carol',
      'did:example:bob',
    ]);
  });

  it('applies divergence policy after a mismatched settle probe', async () => {
    const target = ownerTarget('did:example:alice', 'https://a.example');
    const divergent = reconciled(false);
    const { coordinator, feedConvergenceManager, operations } = createFixture([target]);
    operations.probeFeedConvergence.resolves(reconciled(false));
    operations.reconcileTarget.resolves(divergent);

    await coordinator.settle();

    expect(feedConvergenceManager.handleVerifiedDivergence.calledOnceWithExactly(target, divergent)).toBe(true);
    expect(feedConvergenceManager.clear.notCalled).toBe(true);
  });

  it('applies retryable push-failure policy after a mismatched settle probe', async () => {
    const target = ownerTarget('did:example:alice', 'https://a.example');
    const pushFailures = [{ cid: 'retryable-cid' }];
    const { coordinator, feedConvergenceManager, operations } = createFixture([target]);
    operations.probeFeedConvergence.resolves(reconciled(false));
    operations.reconcileTarget.resolves({ converged: false, pushFailures });
    operations.recordPushFailures.resolves(1);

    await expect(coordinator.settle()).rejects.toThrow(
      'SyncRunCoordinator: Sync operation failed for 1 remote endpoint(s): https://a.example',
    );

    expect(operations.recordPushFailures.calledOnceWithExactly(target, pushFailures)).toBe(true);
    const reportedError = operations.reportError.firstCall.args[1];
    expect(reportedError).toBeInstanceOf(Error);
    expect(reportedError.message).toBe(
      'SyncRunCoordinator: reconciliation push failed for 1 retryable message(s).',
    );
    expect(feedConvergenceManager.handleVerifiedDivergence.notCalled).toBe(true);
  });

  it('propagates target-planning failures before changing connectivity', async () => {
    const planningError = new Error('target planning failed');
    const { connectivityManager, coordinator, operations } = createFixture();
    operations.getTargets.rejects(planningError);

    await expect(coordinator.run()).rejects.toBe(planningError);

    expect(operations.reconcileTarget.notCalled).toBe(true);
    expect(connectivityManager.recordSuccess.notCalled).toBe(true);
    expect(connectivityManager.recordFailure.notCalled).toBe(true);
  });
});
