import type { ProgressToken } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import type { ReplicationLinkState } from '../src/types/sync.js';

import { SyncLinkController } from '../src/sync-link-controller.js';

type SyncLinkTimer = Parameters<SyncLinkController['setRepairRetryTimer']>[0];

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

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

  describe('direction queues', () => {
    it('should hold admitted work behind the replication readiness barrier', async () => {
      const controller = new SyncLinkController('link-key', createLink());
      let ran = false;

      const result = controller.enqueueDirection('pull', async (): Promise<string> => {
        ran = true;
        return 'ready';
      });
      await Promise.resolve();

      expect(controller.isReplicationReady).toBe(false);
      expect(controller.getPendingDirectionCount('pull')).toBe(1);
      expect(ran).toBe(false);

      controller.markReplicationReady();

      expect(await result).toBe('ready');
      expect(controller.isReplicationReady).toBe(true);
      expect(controller.getPendingDirectionCount('pull')).toBe(0);
    });

    it('should run each direction FIFO and count running plus queued work', async () => {
      const controller = new SyncLinkController('link-key', createLink());
      const firstGate = deferred<void>();
      const firstStarted = deferred<void>();
      const order: string[] = [];
      controller.markReplicationReady();

      const first = controller.enqueueDirection('pull', async (): Promise<string> => {
        firstStarted.resolve();
        await firstGate.promise;
        order.push('first');
        return 'first-result';
      });
      const second = controller.enqueueDirection('pull', async (): Promise<string> => {
        order.push('second');
        return 'second-result';
      });
      await firstStarted.promise;

      expect(controller.getPendingDirectionCount('pull')).toBe(2);
      expect(order).toEqual([]);

      firstGate.resolve();
      expect(await Promise.all([first, second])).toEqual(['first-result', 'second-result']);
      expect(order).toEqual(['first', 'second']);
      expect(controller.getPendingDirectionCount('pull')).toBe(0);
    });

    it('should drain pull and push independently', async () => {
      const controller = new SyncLinkController('link-key', createLink());
      const pullGate = deferred<void>();
      const pullStarted = deferred<void>();
      controller.markReplicationReady();

      const pull = controller.enqueueDirection('pull', async (): Promise<void> => {
        pullStarted.resolve();
        await pullGate.promise;
      });
      await pullStarted.promise;

      const push = controller.enqueueDirection('push', async (): Promise<string> => 'pushed');
      expect(await push).toBe('pushed');
      expect(controller.getPendingDirectionCount('pull')).toBe(1);
      expect(controller.getPendingDirectionCount('push')).toBe(0);

      pullGate.resolve();
      await pull;
    });

    it('should synchronously fence queued work and replace readiness on replication generation reset', async () => {
      const controller = new SyncLinkController('link-key', createLink());
      const initialGeneration = controller.replicationGeneration;
      let staleRan = false;
      let freshRan = false;
      const stale = controller.enqueueDirection('push', async (): Promise<void> => { staleRan = true; });

      controller.resetReplicationGeneration();

      expect(controller.replicationGeneration).toBe(initialGeneration + 1);
      expect(await stale).toBeUndefined();
      expect(staleRan).toBe(false);
      expect(controller.isReplicationReady).toBe(false);
      expect(controller.getPendingDirectionCount('push')).toBe(0);

      const fresh = controller.enqueueDirection('push', async (): Promise<void> => { freshRan = true; });
      await Promise.resolve();
      expect(freshRan).toBe(false);

      controller.markReplicationReady();
      await fresh;
      expect(freshRan).toBe(true);
    });

    it('should fence a stale running completion without blocking the replacement queue', async () => {
      const controller = new SyncLinkController('link-key', createLink());
      const oldGate = deferred<void>();
      const oldStarted = deferred<void>();
      let queuedRan = false;
      controller.markReplicationReady();

      const running = controller.enqueueDirection('pull', async (): Promise<string> => {
        oldStarted.resolve();
        await oldGate.promise;
        return 'stale-result';
      });
      const queued = controller.enqueueDirection('pull', async (): Promise<void> => { queuedRan = true; });
      await oldStarted.promise;

      controller.resetReplicationGeneration();
      let supersededSettled = false;
      const superseded = controller.waitForSupersededDirectionWork().then((): void => {
        supersededSettled = true;
      });

      expect(await queued).toBeUndefined();
      expect(queuedRan).toBe(false);
      expect(controller.getPendingDirectionCount('pull')).toBe(0);
      expect(supersededSettled).toBe(false);

      controller.markReplicationReady();
      expect(await controller.enqueueDirection('pull', async (): Promise<string> => 'fresh-result')).toBe('fresh-result');

      oldGate.resolve();
      expect(await running).toBeUndefined();
      await superseded;
      expect(supersededSettled).toBe(true);
      expect(controller.getPendingDirectionCount('pull')).toBe(0);
    });

    it('should release readiness waiters without running them on deactivation', async () => {
      const controller = new SyncLinkController('link-key', createLink());
      let ran = false;
      const pending = controller.enqueueDirection('pull', async (): Promise<void> => { ran = true; });

      controller.deactivate();

      expect(await pending).toBeUndefined();
      expect(ran).toBe(false);
      expect(controller.isReplicationReady).toBe(false);
      expect(await controller.enqueueDirection('pull', async (): Promise<void> => { ran = true; })).toBeUndefined();
    });

    it('should surface a current rejection without poisoning its direction queue', async () => {
      const controller = new SyncLinkController('link-key', createLink());
      controller.markReplicationReady();

      const failed = controller.enqueueDirection('push', async (): Promise<never> => {
        throw new Error('push failed');
      });
      const continued = controller.enqueueDirection('push', async (): Promise<string> => 'continued');

      await expect(failed).rejects.toThrow('push failed');
      expect(await continued).toBe('continued');
    });
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

    // Captured state is insulated from a caller mutating its reply object.
    pullHead.position = '99';
    pushHead.position = '99';
    expect(controller.pullSnapshot).toEqual({ fingerprint: 'pull-fingerprint', head: token(3) });
    expect(controller.pushSnapshot).toEqual({ fingerprint: 'push-fingerprint', head: token(4) });

    controller.resetReplicationGeneration();

    expect(controller.pullSnapshot).toBeUndefined();
    expect(controller.pushSnapshot).toBeUndefined();
    await controller.closeSubscriptions();
    expect(controller.setLiveSubscription(
      { close: async (): Promise<void> => {} },
      replicationGeneration,
      { head: token(5) },
    )).toBe(false);
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

  it('should consume only the currently owned repair and reconcile timers', () => {
    const controller = new SyncLinkController('link-key', createLink());
    const firstRepair = setTimeout(() => {}, 60_000);
    const currentRepair = setTimeout(() => {}, 60_000);
    const firstReconcile = setTimeout(() => {}, 60_000);
    const currentReconcile = setTimeout(() => {}, 60_000);

    controller.setRepairRetryTimer(firstRepair);
    controller.setRepairRetryTimer(currentRepair);
    controller.setReconcileTimer(firstReconcile, 1);
    controller.setReconcileTimer(currentReconcile, 2);

    expect(controller.consumeRepairRetryTimer(firstRepair)).toBe(false);
    expect(controller.repairRetryTimer).toBe(currentRepair);
    expect(controller.consumeReconcileTimer(firstReconcile)).toBe(false);
    expect(controller.reconcileTimer).toBe(currentReconcile);

    expect(controller.consumeRepairRetryTimer(currentRepair)).toBe(true);
    expect(controller.consumeReconcileTimer(currentReconcile)).toBe(true);
    expect(controller.repairRetryTimer).toBeUndefined();
    expect(controller.reconcileTimer).toBeUndefined();

    clearTimeout(currentRepair);
    clearTimeout(currentReconcile);
  });

  it('should invalidate callbacks and cancel every queued timer on deactivation', async () => {
    const clock = sinon.useFakeTimers();
    const controller = new SyncLinkController('link-key', createLink());
    const fired = sinon.stub();
    const repairTimer = setTimeout(fired, 10) as unknown as SyncLinkTimer;
    const reconcileTimer = setTimeout(fired, 10) as unknown as SyncLinkTimer;
    controller.setRepairRetryTimer(repairTimer);
    controller.setReconcileTimer(reconcileTimer, Date.now() + 10);
    controller.incrementRepairAttempts();
    controller.setRepairResumeToken(token(1));

    controller.deactivate();
    await clock.tickAsync(10);

    expect(controller.isActive).toBe(false);
    expect(controller.repairRetryTimer).toBeUndefined();
    expect(controller.reconcileTimer).toBeUndefined();
    expect(controller.repairAttempts).toBe(0);
    expect(controller.repairResumeToken).toBeUndefined();
    expect(fired.called).toBe(false);
  });
});

describe('SyncLinkController mailbox', () => {
  const LINK_KEY = 'did:example:alice^https://dwn.example.com^projection-id^owner-epoch';

  it('should serialize enqueued operations in FIFO order', async () => {
    const controller = new SyncLinkController(LINK_KEY, createLink());
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = controller.enqueue(async (): Promise<void> => {
      await firstGate;
      order.push('first');
    });
    const second = controller.enqueue(async (): Promise<void> => {
      order.push('second');
    });

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['first', 'second']);
  });

  it('should refuse work enqueued after deactivation while letting in-flight work finish', async () => {
    const controller = new SyncLinkController(LINK_KEY, createLink());
    let releaseInflight!: () => void;
    const inflightGate = new Promise<void>((resolve) => { releaseInflight = resolve; });
    let signalStarted!: () => void;
    const inflightStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    let inflightRan = false;
    let lateRan = false;

    const inflight = controller.enqueue(async (): Promise<void> => {
      signalStarted();
      await inflightGate;
      inflightRan = true;
    });
    // Deactivate only once the operation is genuinely in flight.
    await inflightStarted;
    controller.deactivate();
    const late = controller.enqueue(async (): Promise<void> => { lateRan = true; });

    releaseInflight();
    await inflight;
    expect(await late).toBeUndefined();

    expect(inflightRan).toBe(true);
    expect(lateRan).toBe(false);
  });

  it('should skip operations queued before deactivation that had not started', async () => {
    const controller = new SyncLinkController(LINK_KEY, createLink());
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let queuedRan = false;

    const first = controller.enqueue(async (): Promise<void> => { await firstGate; });
    const queued = controller.enqueue(async (): Promise<void> => { queuedRan = true; });

    controller.deactivate();
    releaseFirst();
    await first;
    expect(await queued).toBeUndefined();
    expect(queuedRan).toBe(false);
  });

  it('should track lane business for queued and running operations independently', async () => {
    const controller = new SyncLinkController(LINK_KEY, createLink());
    let releasePush!: () => void;
    const pushGate = new Promise<void>((resolve) => { releasePush = resolve; });

    const push = controller.enqueue(async (): Promise<void> => { await pushGate; }, 'push');
    const repair = controller.enqueue(async (): Promise<void> => {}, 'repair');

    expect(controller.isMailboxBusy('push')).toBe(true);
    expect(controller.isMailboxBusy('repair')).toBe(true);
    expect(controller.isMailboxBusy('reconcile')).toBe(false);

    releasePush();
    await Promise.all([push, repair]);

    expect(controller.isMailboxBusy('push')).toBe(false);
    expect(controller.isMailboxBusy('repair')).toBe(false);
  });

  it('should coalesce shared operations per lane and release the handle on settlement', async () => {
    const controller = new SyncLinkController(LINK_KEY, createLink());
    let releaseRepair!: () => void;
    const repairGate = new Promise<void>((resolve) => { releaseRepair = resolve; });
    let repairRuns = 0;
    let reconcileRuns = 0;
    let joinedRan = false;

    const repair = controller.enqueueShared('repair', async (): Promise<void> => {
      repairRuns++;
      await repairGate;
    });
    const joined = controller.enqueueShared('repair', async (): Promise<void> => { joinedRan = true; });
    const reconcile = controller.enqueueShared('reconcile', async (): Promise<void> => { reconcileRuns++; });

    expect(joined).toBe(repair);
    releaseRepair();
    await Promise.all([repair, reconcile]);

    expect(repairRuns).toBe(1);
    expect(joinedRan).toBe(false);
    expect(reconcileRuns).toBe(1);

    await controller.enqueueShared('repair', async (): Promise<void> => { repairRuns++; });
    expect(repairRuns).toBe(2);
  });

  it('should release a shared handle whose operation rejected', async () => {
    const controller = new SyncLinkController(LINK_KEY, createLink());
    let retried = false;

    const failing = controller.enqueueShared('repair', async (): Promise<void> => {
      throw new Error('repair failed');
    });
    await expect(failing).rejects.toThrow('repair failed');

    await controller.enqueueShared('repair', async (): Promise<void> => { retried = true; });
    expect(retried).toBe(true);
    expect(controller.isMailboxBusy('repair')).toBe(false);
  });

  it('should surface a rejection to its caller without poisoning the queue', async () => {
    const controller = new SyncLinkController(LINK_KEY, createLink());
    let secondRan = false;

    const first = controller.enqueue(async (): Promise<never> => {
      throw new Error('operation failed');
    });
    const second = controller.enqueue(async (): Promise<void> => { secondRan = true; });

    await expect(first).rejects.toThrow('operation failed');
    await second;

    expect(secondRan).toBe(true);
  });

});
