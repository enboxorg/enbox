import type { ProgressToken } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import type { ReplicationLinkState } from '../src/types/sync.js';

import { SyncLinkController } from '../src/sync-link-controller.js';

function createLink(): ReplicationLinkState {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    connectivity       : 'unknown',
    projectionId       : 'projection-id',
    pull               : {},
    push               : {},
    remoteEndpoint     : 'https://dwn.example.com',
    scope              : { kind: 'full' },
    status             : 'live',
    tenantDid          : 'did:example:alice',
  };
}

function token(position: number): ProgressToken {
  return {
    epoch      : 'epoch',
    messageCid : `cid-${position}`,
    position   : String(position),
    streamId   : 'stream',
  };
}

describe('SyncLinkController', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should own and close both link subscriptions even when one close fails', async () => {
    const controller = new SyncLinkController('link-key', createLink());
    const closeLive = sinon.stub().rejects(new Error('already closed'));
    const closeLocal = sinon.stub().resolves();
    controller.setLiveSubscription({ close: closeLive }, controller.replicationGeneration, { head: token(1) });
    controller.setLocalSubscription({ close: closeLocal }, controller.replicationGeneration, { head: token(2) });

    await controller.closeSubscriptions();

    expect(closeLive.calledOnce).toBe(true);
    expect(closeLocal.calledOnce).toBe(true);
    expect(controller.hasLiveSubscription).toBe(false);
    expect(controller.hasLocalSubscription).toBe(false);
    expect(controller.pullSnapshot).toBeUndefined();
    expect(controller.pushSnapshot).toBeUndefined();
  });

  it('should capture replication-generation-pinned feed snapshots and clear them on reset', async () => {
    const controller = new SyncLinkController('link-key', createLink());
    const replicationGeneration = controller.replicationGeneration;
    const pullHead = token(3);
    const pushHead = token(4);

    expect(controller.setLiveSubscription(
      { close: async (): Promise<void> => {} },
      replicationGeneration,
      { fingerprint: 'pull-fingerprint', head: pullHead },
    )).toBe(true);
    expect(controller.setLocalSubscription(
      { close: async (): Promise<void> => {} },
      replicationGeneration,
      { fingerprint: 'push-fingerprint', head: pushHead },
    )).toBe(true);

    pullHead.position = '99';
    pushHead.position = '99';
    expect(controller.pullSnapshot).toEqual({ fingerprint: 'pull-fingerprint', head: token(3) });
    expect(controller.pushSnapshot).toEqual({ fingerprint: 'push-fingerprint', head: token(4) });

    controller.markReplicationReady();
    controller.resetReplicationGeneration();

    expect(controller.replicationGeneration).toBe(replicationGeneration + 1);
    expect(controller.isReplicationReady).toBe(false);
    expect(controller.pullSnapshot).toBeUndefined();
    expect(controller.pushSnapshot).toBeUndefined();
    await controller.closeSubscriptions();
    expect(controller.setLiveSubscription(
      { close: async (): Promise<void> => {} },
      replicationGeneration,
      { head: token(5) },
    )).toBe(false);
  });

  it('should restore pull currentness only for the current generation with no trailing wake', () => {
    const controller = new SyncLinkController('link-key', createLink());
    const replicationGeneration = controller.replicationGeneration;

    expect(controller.isPullCurrent).toBe(false);
    expect(controller.markPullCurrent(replicationGeneration)).toBe(true);
    expect(controller.isPullCurrent).toBe(true);
    expect(controller.markPullPending()).toBe(true);
    expect(controller.isPullCurrent).toBe(false);

    controller.executor.request('pull');
    expect(controller.markPullCurrent(replicationGeneration)).toBe(false);
    controller.executor.consumePending('pull');
    expect(controller.markPullCurrent(replicationGeneration)).toBe(true);

    expect(controller.beginRetirement()).toBe(true);
    expect(controller.isActive).toBe(true);
    expect(controller.isPullCurrent).toBe(false);
    expect(controller.markPullCurrent(replicationGeneration)).toBe(false);
    expect(controller.setLocalSubscription({ close: async (): Promise<void> => {} })).toBe(false);

    controller.resetReplicationGeneration();
    expect(controller.isPullCurrent).toBe(false);
    expect(controller.markPullCurrent(replicationGeneration)).toBe(false);
  });

  it('should reject duplicate or post-deactivation subscription ownership', async () => {
    const controller = new SyncLinkController('link-key', createLink());
    const closeOwned = sinon.stub().resolves();

    expect(controller.setLiveSubscription({ close: closeOwned })).toBe(true);
    expect(controller.setLiveSubscription({ close: sinon.stub().resolves() })).toBe(false);

    controller.deactivate();
    expect(controller.setLocalSubscription({ close: sinon.stub().resolves() })).toBe(false);

    await controller.closeSubscriptions();
    expect(closeOwned.calledOnce).toBe(true);
  });

  it('should invalidate execution and clear repair attempts on deactivation', () => {
    const controller = new SyncLinkController('link-key', createLink());
    controller.incrementRepairAttempts();
    controller.markReplicationReady();
    controller.executor.request('pull');

    controller.deactivate();

    expect(controller.isActive).toBe(false);
    expect(controller.isReplicationReady).toBe(false);
    expect(controller.repairAttempts).toBe(0);
    expect(controller.executor.hasPendingWork).toBe(false);
  });
});
