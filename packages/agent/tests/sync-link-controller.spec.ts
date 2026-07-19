import type { ProgressToken } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import type { ReplicationLinkState } from '../src/types/sync.js';

import { SyncLinkController } from '../src/sync-link-controller.js';

type SyncLinkTimer = Parameters<SyncLinkController['setRepairRetryTimer']>[0];

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

  it('should commit concurrently delivered pull events only in delivery order', () => {
    const link = createLink();
    const controller = new SyncLinkController('link-key', link);
    const first = controller.startPullDelivery(token(1));
    const second = controller.startPullDelivery(token(2));

    expect(controller.commitPullDelivery(second)).toBe(0);
    expect(link.pull.contiguousAppliedToken).toBeUndefined();
    expect(controller.pullInflightCount).toBe(2);

    expect(controller.commitPullDelivery(first)).toBe(2);
    expect(link.pull.contiguousAppliedToken).toEqual(token(2));
    expect(controller.pullInflightCount).toBe(0);
  });

  it('should discard interrupted pull deliveries without blocking later work', () => {
    const link = createLink();
    const controller = new SyncLinkController('link-key', link);
    controller.startPullDelivery(token(1));

    controller.clearPullInflight();
    const next = controller.startPullDelivery(token(2));

    expect(next.ordinal).toBe(1);
    expect(controller.commitPullDelivery(next)).toBe(1);
    expect(link.pull.contiguousAppliedToken).toEqual(token(2));
  });

  it('should restart pull delivery ordering when the runtime is reset', () => {
    const link = createLink();
    const controller = new SyncLinkController('link-key', link);
    controller.startPullDelivery(token(1));
    controller.startPullDelivery(token(2));

    controller.resetPullRuntime();
    const next = controller.startPullDelivery(token(3));

    expect(next.ordinal).toBe(0);
    expect(controller.pullInflightCount).toBe(1);
    expect(controller.commitPullDelivery(next)).toBe(1);
    expect(link.pull.contiguousAppliedToken).toEqual(token(3));
  });

  it('should ignore commits carrying a superseded pull-generation ticket', () => {
    const link = createLink();
    const controller = new SyncLinkController('link-key', link);
    const stale = controller.startPullDelivery(token(9));

    controller.resetPullRuntime();
    const fresh = controller.startPullDelivery(token(2));

    // The stale ticket's ordinal collides with the fresh delivery's ordinal
    // in the new generation; its commit must not mark the fresh delivery
    // committed or move either checkpoint token.
    expect(controller.commitPullDelivery(stale)).toBe(0);
    expect(link.pull.contiguousAppliedToken).toBeUndefined();

    expect(controller.commitPullDelivery(fresh)).toBe(1);
    expect(link.pull.contiguousAppliedToken).toEqual(token(2));
  });

  it('should ignore commits abandoned by clearPullInflight', () => {
    const link = createLink();
    const controller = new SyncLinkController('link-key', link);
    const abandoned = controller.startPullDelivery(token(1));

    controller.clearPullInflight();

    expect(controller.commitPullDelivery(abandoned)).toBe(0);
    expect(link.pull.contiguousAppliedToken).toBeUndefined();
  });

  it('should not let an old push batch clear or consume a replacement queue', () => {
    const controller = new SyncLinkController('link-key', createLink());
    const first = controller.getOrCreatePushRuntime({
      did    : 'did:example:alice',
      dwnUrl : 'https://dwn.example.com',
    });
    const firstTimer = setTimeout(() => {}, 60_000);
    controller.setPushTimer(first, firstTimer);
    controller.clearPushRuntime(first);
    const replacement = controller.getOrCreatePushRuntime({
      did    : 'did:example:alice',
      dwnUrl : 'https://dwn.example.com',
    });
    const replacementTimer = setTimeout(() => {}, 60_000);
    controller.setPushTimer(replacement, replacementTimer);

    controller.clearPushRuntime(first);

    expect(controller.pushRuntime).toBe(replacement);
    expect(controller.consumePushTimer(first, firstTimer)).toBe(false);
    expect(controller.pushRuntime?.timer).toBe(replacementTimer);

    controller.clearPushRuntime(replacement);
  });

  it('should reject and cancel push timers for stale or inactive runtimes', async () => {
    const clock = sinon.useFakeTimers();
    const controller = new SyncLinkController('link-key', createLink());
    const fired = sinon.stub();
    const stale = controller.getOrCreatePushRuntime({
      did    : 'did:example:alice',
      dwnUrl : 'https://dwn.example.com',
    });
    controller.clearPushRuntime(stale);
    const current = controller.getOrCreatePushRuntime({
      did    : 'did:example:alice',
      dwnUrl : 'https://dwn.example.com',
    });

    const staleTimer = setTimeout(fired, 10) as unknown as SyncLinkTimer;
    expect(controller.setPushTimer(stale, staleTimer)).toBe(false);

    controller.deactivate();
    const inactiveTimer = setTimeout(fired, 10) as unknown as SyncLinkTimer;
    expect(controller.setPushTimer(current, inactiveTimer)).toBe(false);

    await clock.tickAsync(10);

    expect(fired.called).toBe(false);
  });

  it('should own and close both link subscriptions even when one close fails', async () => {
    const controller = new SyncLinkController('link-key', createLink());
    const closeLive = sinon.stub().rejects(new Error('already closed'));
    const closeLocal = sinon.stub().resolves();
    controller.setLiveSubscription({ close: closeLive });
    controller.setLocalSubscription({ close: closeLocal });

    await controller.closeSubscriptions();

    expect(closeLive.calledOnce).toBe(true);
    expect(closeLocal.calledOnce).toBe(true);
    expect(controller.hasLiveSubscription).toBe(false);
    expect(controller.hasLocalSubscription).toBe(false);
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
    const pushRuntime = controller.getOrCreatePushRuntime({
      did    : 'did:example:alice',
      dwnUrl : 'https://dwn.example.com',
    });
    const pushTimer = setTimeout(fired, 10) as unknown as SyncLinkTimer;
    const repairTimer = setTimeout(fired, 10) as unknown as SyncLinkTimer;
    const reconcileTimer = setTimeout(fired, 10) as unknown as SyncLinkTimer;
    controller.setPushTimer(pushRuntime, pushTimer);
    controller.setRepairRetryTimer(repairTimer);
    controller.setReconcileTimer(reconcileTimer, Date.now() + 10);
    controller.incrementRepairAttempts();
    controller.setRepairResumeToken(token(1));

    controller.deactivate();
    await clock.tickAsync(10);

    expect(controller.isActive).toBe(false);
    expect(controller.pushRuntime).toBeUndefined();
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
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve; });

    const flush = controller.enqueue(async (): Promise<void> => { await flushGate; }, 'flush');
    const repair = controller.enqueue(async (): Promise<void> => {}, 'repair');

    expect(controller.mailboxBusy('flush')).toBe(true);
    expect(controller.mailboxBusy('repair')).toBe(true);
    expect(controller.mailboxBusy('reconcile')).toBe(false);

    releaseFlush();
    await Promise.all([flush, repair]);

    expect(controller.mailboxBusy('flush')).toBe(false);
    expect(controller.mailboxBusy('repair')).toBe(false);
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
    expect(controller.mailboxBusy('repair')).toBe(false);
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
