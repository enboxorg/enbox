import type { SinonStub } from 'sinon';

import type { ReplicationLinkState } from '../src/types/sync.js';
import type { SyncDrainCoordinatorOperations } from '../src/sync-drain-coordinator.js';
import type { SyncDurableFeedReconcileResult } from '../src/sync-durable-feed-reconciler.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';
import type { SyncIdentityStore, SyncIdentityStoreEntry } from '../src/sync-identity-store.js';

import sinon from 'sinon';

import { describe, expect, it } from 'bun:test';

import { SyncDrainCoordinator } from '../src/sync-drain-coordinator.js';

type DrainFixtureOptions = {
  entries?: SyncIdentityStoreEntry[];
  link?: ReplicationLinkState;
  reconcileResult?: SyncDurableFeedReconcileResult;
  verifyResult?: SyncDurableFeedReconcileResult;
};

type DrainFixtureState = {
  generation: number;
};

type DrainFixtureOperations = {
  [Operation in keyof SyncDrainCoordinatorOperations]: SinonStub;
};

type DrainFixture = {
  coordinator: SyncDrainCoordinator;
  entries: SinonStub;
  operations: DrainFixtureOperations;
  state: DrainFixtureState;
};

function ownerTarget(did = 'did:example:alice', dwnUrl = 'https://dwn.example'): SyncTarget {
  return {
    did,
    dwnUrl,
    scope              : { kind: 'full' },
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    projectionId       : `projection-${did}`,
  };
}

function replicationLink(target = ownerTarget()): ReplicationLinkState {
  return {
    tenantDid          : target.did,
    remoteEndpoint     : target.dwnUrl,
    projectionId       : target.projectionId,
    authorizationEpoch : target.authorizationEpoch,
    scope              : target.scope,
    authorization      : target.authorization,
    status             : 'live',
    pull               : {},
    push               : {
      contiguousAppliedToken: {
        streamId : 'local-stream',
        epoch    : '1',
        position : '7',
      },
    },
    connectivity: 'online',
  };
}

function validEntry(did = 'did:example:alice'): SyncIdentityStoreEntry {
  return { status: 'valid', did, options: { protocols: 'all' } };
}

function createFixture({
  entries: storedEntries = [validEntry()],
  link = replicationLink(),
  reconcileResult = {
    converged         : true,
    localFingerprint  : 'stable-fingerprint',
    pushFailures      : [],
    remoteFingerprint : 'stable-fingerprint',
  },
  verifyResult = {
    converged         : true,
    localFingerprint  : 'stable-fingerprint',
    pushFailures      : [],
    remoteFingerprint : 'stable-fingerprint',
  },
}: DrainFixtureOptions = {}): DrainFixture {
  const state: DrainFixtureState = { generation: 1 };
  const entries = sinon.stub().callsFake((): AsyncIterable<SyncIdentityStoreEntry> => ({
    async *[Symbol.asyncIterator](): AsyncIterator<SyncIdentityStoreEntry> {
      yield* storedEntries;
    },
  }));
  const identityStore = {
    clear  : sinon.stub().resolves(),
    delete : sinon.stub().resolves(),
    entries,
    get    : sinon.stub().resolves(undefined),
    set    : sinon.stub().resolves(),
  } satisfies SyncIdentityStore;
  const operations = {
    buildTargetsForEndpoint: sinon.stub().callsFake(
      async (did: string, remoteEndpoint: string): Promise<SyncTarget[]> => [ownerTarget(did, remoteEndpoint)],
    ),
    clearFeedConvergenceFailure  : sinon.stub().resolves(),
    getLink                      : sinon.stub().resolves(link),
    getQuotaBlockCount           : sinon.stub().resolves(0),
    getTopologyGeneration        : sinon.stub().callsFake((): number => state.generation),
    handleVerifiedFeedDivergence : sinon.stub().resolves(false),
    onReconcileApplied           : sinon.stub(),
    prepareLiveTarget            : sinon.stub().resolves(),
    reconcileTarget              : sinon.stub().resolves(reconcileResult),
    recordConnectivityFailure    : sinon.stub(),
    recordConnectivitySuccess    : sinon.stub(),
    recordPushFailures           : sinon.stub().resolves(),
    registerEndpoint             : sinon.stub().resolves(),
    verifyConvergence            : sinon.stub().resolves(verifyResult),
  } satisfies SyncDrainCoordinatorOperations;

  return {
    coordinator: new SyncDrainCoordinator({ identityStore, operations }),
    entries,
    operations,
    state,
  };
}

describe('SyncDrainCoordinator', () => {
  it('registers the endpoint and reports an empty drain plan without changing connectivity', async () => {
    const { coordinator, operations } = createFixture({ entries: [] });

    const result = await coordinator.drain('https://dwn.example');

    expect(result).toEqual({
      endpoint        : 'https://dwn.example',
      completed       : false,
      cancelled       : false,
      topologyChanged : false,
      targets         : [],
      error           : 'drain plan contained no registered sync targets',
    });
    expect(operations.registerEndpoint.calledOnceWithExactly('https://dwn.example')).toBe(true);
    expect(operations.recordConnectivitySuccess.notCalled).toBe(true);
    expect(operations.recordConnectivityFailure.notCalled).toBe(true);
  });

  it('captures topology only after endpoint registration completes', async () => {
    const { coordinator, operations, state } = createFixture();
    operations.registerEndpoint.callsFake(async (): Promise<void> => {
      state.generation++;
    });

    const result = await coordinator.drain('https://dwn.example');

    expect(result.completed).toBe(true);
    expect(result.topologyChanged).toBe(false);
  });

  it('isolates corrupt identities and target-resolution failures from healthy targets', async () => {
    const protocol = 'https://example.com/protocol';
    const entries: SyncIdentityStoreEntry[] = [
      validEntry('did:example:alice'),
      { status: 'corrupt', did: 'did:example:corrupt', error: new SyntaxError('bad JSON') },
      {
        status  : 'valid',
        did     : 'did:example:bob',
        options : { protocols: [protocol] },
      },
    ];
    const { coordinator, operations } = createFixture({ entries });
    operations.buildTargetsForEndpoint.callsFake(
      async (did: string, remoteEndpoint: string): Promise<SyncTarget[]> => {
        if (did === 'did:example:bob') {
          throw new Error('grant resolution failed');
        }
        return [ownerTarget(did, remoteEndpoint)];
      },
    );

    const result = await coordinator.drain('https://dwn.example');

    expect(result.completed).toBe(false);
    expect(result.targets).toHaveLength(3);
    expect(result.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tenantDid : 'did:example:corrupt',
        completed : false,
        error     : 'corrupt sync options: bad JSON',
      }),
      expect.objectContaining({
        tenantDid : 'did:example:bob',
        scope     : { kind: 'protocolSet', protocols: [protocol] },
        completed : false,
        error     : 'grant resolution failed',
      }),
      expect.objectContaining({
        tenantDid : 'did:example:alice',
        completed : true,
        converged : true,
      }),
    ]));
    expect(operations.recordConnectivitySuccess.calledOnce).toBe(true);
    expect(operations.recordConnectivityFailure.notCalled).toBe(true);
  });

  it('reports a target reconciliation rejection and records a connectivity failure', async () => {
    const { coordinator, operations } = createFixture();
    operations.reconcileTarget.rejects(new Error('remote unavailable'));

    const result = await coordinator.drain('https://dwn.example');

    expect(result.completed).toBe(false);
    expect(result.targets).toEqual([
      expect.objectContaining({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example',
        completed      : false,
        cancelled      : false,
        converged      : false,
        error          : 'remote unavailable',
      }),
    ]);
    expect(operations.recordConnectivityFailure.calledOnce).toBe(true);
    expect(operations.getLink.notCalled).toBe(true);
  });

  it('prepares and drains a target, emits applied CIDs, and returns its durable checkpoint', async () => {
    const reconcileResult = {
      admittedCids      : ['cid-1', 'cid-2'],
      converged         : true,
      localFingerprint  : 'stable-fingerprint',
      pushFailures      : [],
      remoteFingerprint : 'stable-fingerprint',
    };
    const link = replicationLink();
    const { coordinator, operations } = createFixture({ link, reconcileResult });

    const result = await coordinator.drain('https://dwn.example');

    expect(result.completed).toBe(true);
    expect(result.targets[0]).toMatchObject({
      completed         : true,
      cancelled         : false,
      converged         : true,
      localFingerprint  : 'stable-fingerprint',
      remoteFingerprint : 'stable-fingerprint',
      pushCheckpoint    : link.push.contiguousAppliedToken,
    });
    expect(operations.prepareLiveTarget.calledOnce).toBe(true);
    expect(operations.reconcileTarget.calledOnce).toBe(true);
    expect(operations.reconcileTarget.firstCall.args[1]).toEqual({
      forceQuotaProbe   : true,
      verifyConvergence : true,
    });
    expect(operations.onReconcileApplied.calledOnceWithExactly(
      sinon.match.object,
      ['cid-1', 'cid-2'],
    )).toBe(true);
    expect(operations.verifyConvergence.calledOnce).toBe(true);
    expect(operations.clearFeedConvergenceFailure.calledOnce).toBe(true);
    expect(operations.recordConnectivitySuccess.calledOnce).toBe(true);
  });

  it('records push failures and reports incomplete but fingerprint-converged progress', async () => {
    const pushFailures = [{ cid: 'failed-cid' }];
    const { coordinator, operations } = createFixture({
      reconcileResult: {
        converged         : true,
        localFingerprint  : 'fingerprint',
        pushFailures,
        remoteFingerprint : 'fingerprint',
      },
    });

    const result = await coordinator.drain('https://dwn.example');

    expect(result.completed).toBe(false);
    expect(result.targets[0]).toMatchObject({
      completed : false,
      converged : true,
      error     : 'drain push failed for 1 message(s)',
    });
    expect(operations.recordPushFailures.calledOnceWithExactly(sinon.match.object, pushFailures)).toBe(true);
    expect(operations.verifyConvergence.notCalled).toBe(true);
    expect(operations.recordConnectivityFailure.calledOnce).toBe(true);
  });

  it('does not report a paused replication link as completed or converged', async () => {
    const link = replicationLink();
    link.status = 'paused';
    const { coordinator, operations } = createFixture({ link });

    const result = await coordinator.drain('https://dwn.example');

    expect(result.targets[0]).toMatchObject({
      completed : false,
      cancelled : false,
      converged : false,
      error     : 'replication link is paused',
    });
    expect(operations.verifyConvergence.notCalled).toBe(true);
  });

  it('stops cooperatively when cancellation is requested during reconciliation', async () => {
    const controller = new AbortController();
    const { coordinator, operations } = createFixture();
    operations.reconcileTarget.callsFake(async (
      _target,
      _options,
      shouldContinue,
    ): Promise<SyncDurableFeedReconcileResult> => {
      expect(shouldContinue()).toBe(true);
      controller.abort();
      expect(shouldContinue()).toBe(false);
      return { aborted: true, pushFailures: [] };
    });

    const result = await coordinator.drain('https://dwn.example', { signal: controller.signal });

    expect(result).toMatchObject({
      completed       : false,
      cancelled       : true,
      topologyChanged : false,
      error           : 'drain aborted',
    });
    expect(result.targets[0]).toMatchObject({
      completed : false,
      cancelled : true,
      converged : false,
      error     : 'drain aborted',
    });
    expect(operations.verifyConvergence.notCalled).toBe(true);
    expect(operations.handleVerifiedFeedDivergence.notCalled).toBe(true);
    expect(operations.clearFeedConvergenceFailure.notCalled).toBe(true);
    // An interrupted drain says nothing about reachability: it must record
    // neither a connectivity failure (widening poll backoff) nor a success.
    expect(operations.recordConnectivityFailure.notCalled).toBe(true);
    expect(operations.recordConnectivitySuccess.notCalled).toBe(true);
  });

  it('invalidates completion when registrations change during reconciliation', async () => {
    const { coordinator, operations, state } = createFixture();
    operations.reconcileTarget.callsFake(async (
      _target,
      _options,
      shouldContinue,
    ): Promise<SyncDurableFeedReconcileResult> => {
      expect(shouldContinue()).toBe(true);
      state.generation++;
      expect(shouldContinue()).toBe(false);
      return {
        converged         : true,
        localFingerprint  : 'fingerprint',
        pushFailures      : [],
        remoteFingerprint : 'fingerprint',
      };
    });

    const result = await coordinator.drain('https://dwn.example');

    expect(result).toMatchObject({
      completed       : false,
      cancelled       : false,
      topologyChanged : true,
      error           : 'sync registrations changed during drain; retry required',
    });
    expect(result.targets[0]).toMatchObject({
      completed : false,
      cancelled : false,
      converged : false,
      error     : 'sync registrations changed during drain; retry required',
    });
    expect(operations.verifyConvergence.notCalled).toBe(true);
    // A topology-interrupted drain says nothing about reachability: it must
    // record neither a connectivity failure nor a success.
    expect(operations.recordConnectivityFailure.notCalled).toBe(true);
    expect(operations.recordConnectivitySuccess.notCalled).toBe(true);
  });

  it('requires an unchanged feed head before reporting completion', async () => {
    const { coordinator } = createFixture({
      reconcileResult: {
        converged         : true,
        localFingerprint  : 'first-fingerprint',
        pushFailures      : [],
        remoteFingerprint : 'first-fingerprint',
      },
      verifyResult: {
        converged         : true,
        localFingerprint  : 'second-fingerprint',
        pushFailures      : [],
        remoteFingerprint : 'second-fingerprint',
      },
    });

    const result = await coordinator.drain('https://dwn.example');

    expect(result.completed).toBe(false);
    expect(result.targets[0]).toMatchObject({
      completed         : false,
      converged         : false,
      error             : 'feed head changed during drain; retry required',
      localFingerprint  : 'second-fingerprint',
      remoteFingerprint : 'second-fingerprint',
    });
  });

  it('treats fully explained quota omissions as logical convergence when no blocks remain', async () => {
    const { coordinator, operations } = createFixture({
      reconcileResult: {
        converged         : false,
        localFingerprint  : 'local-fingerprint',
        pushFailures      : [],
        remoteFingerprint : 'remote-fingerprint',
      },
    });
    operations.handleVerifiedFeedDivergence.resolves(true);

    const result = await coordinator.drain('https://dwn.example');

    expect(result.completed).toBe(true);
    expect(result.targets[0]).toMatchObject({
      completed : true,
      converged : true,
    });
    expect(operations.handleVerifiedFeedDivergence.calledOnce).toBe(true);
  });

  it('keeps explained divergence incomplete while quota blocks remain but records connectivity success', async () => {
    const { coordinator, operations } = createFixture({
      reconcileResult: {
        converged         : false,
        localFingerprint  : 'local-fingerprint',
        pushFailures      : [],
        remoteFingerprint : 'remote-fingerprint',
      },
    });
    operations.handleVerifiedFeedDivergence.resolves(true);
    operations.getQuotaBlockCount.resolves(1);

    const result = await coordinator.drain('https://dwn.example');

    expect(result.completed).toBe(false);
    expect(result.targets[0]).toMatchObject({
      completed    : false,
      converged    : false,
      quotaBlocked : true,
      error        : 'feed fingerprints did not converge',
    });
    expect(operations.recordConnectivitySuccess.calledOnce).toBe(true);
    expect(operations.recordConnectivityFailure.notCalled).toBe(true);
  });

  it('stops preparing and draining targets after the topology changes', async () => {
    const entries = [validEntry('did:example:alice'), validEntry('did:example:bob')];
    const { coordinator, operations, state } = createFixture({ entries });
    operations.prepareLiveTarget.callsFake(async (): Promise<void> => {
      state.generation++;
    });

    const result = await coordinator.drain('https://dwn.example');

    expect(operations.prepareLiveTarget.calledOnce).toBe(true);
    expect(operations.reconcileTarget.notCalled).toBe(true);
    expect(result.topologyChanged).toBe(true);
    expect(result.targets).toHaveLength(2);
    expect(result.targets.every((target): boolean =>
      target.error === 'sync registrations changed during drain; retry required'
    )).toBe(true);
  });
});
