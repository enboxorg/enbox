import type { SinonStub } from 'sinon';

import type { GenericMessage, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import type { ReplicationLinkState, SyncScope } from '../src/types/sync.js';
import type {
  SyncLivePushCoordinatorOperations,
  SyncLivePushTarget,
} from '../src/sync-live-push-coordinator.js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, Message } from '@enbox/dwn-sdk-js';

import { SyncEchoSuppressor } from '../src/sync-echo-suppressor.js';
import { SyncLinkController } from '../src/sync-link-controller.js';
import { SyncLivePushCoordinator } from '../src/sync-live-push-coordinator.js';

type PushOperationStubs = {
  [Operation in keyof SyncLivePushCoordinatorOperations]: SinonStub;
};

type PushFixture = {
  controllers: Map<string, SyncLinkController>;
  coordinator: SyncLivePushCoordinator;
  echoSuppressor: SyncEchoSuppressor;
  operations: PushOperationStubs;
  taskRunner: SinonStub;
};

const DID = 'did:example:alice';
const REMOTE = 'https://dwn.example';
const LINK_KEY = `${DID}^${REMOTE}^projection^owner-epoch`;

function link(scope: SyncScope = { kind: 'full' }): ReplicationLinkState {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    connectivity       : 'online',
    projectionId       : 'projection',
    pull               : {},
    push               : {},
    remoteEndpoint     : REMOTE,
    scope,
    status             : 'live',
    tenantDid          : DID,
  };
}

function target(scope: SyncScope = { kind: 'full' }): SyncLivePushTarget {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    did                : DID,
    dwnUrl             : REMOTE,
    linkKey            : LINK_KEY,
    projectionId       : 'projection',
    scope,
  };
}

function protocolMessage(protocol = 'https://protocol.example/covered'): GenericMessage {
  return {
    descriptor: {
      definition       : { protocol },
      interface        : DwnInterfaceName.Protocols,
      messageTimestamp : '2026-07-17T00:00:00.000000Z',
      method           : DwnMethodName.Configure,
    },
  } as GenericMessage;
}

function event(message: GenericMessage = protocolMessage()): Extract<SubscriptionMessage, { type: 'event' }> {
  return {
    cursor : { epoch: 'epoch', position: '1', streamId: 'stream' },
    event  : { message },
    type   : 'event',
  } as Extract<SubscriptionMessage, { type: 'event' }>;
}

function createFixture(options: {
  debounceMs?: number;
  deferredReconcileDelayMs?: number;
  retryBackoffMs?: readonly number[];
} = {}): PushFixture {
  const controllers = new Map<string, SyncLinkController>();
  const taskRunner = sinon.stub().callsFake(async (operation: () => Promise<void>) => operation());
  const operations: PushOperationStubs = {
    captureIdentityTaskRunner : sinon.stub().returns(taskRunner),
    clearQuotaBlock           : sinon.stub().resolves(false),
    getController             : sinon.stub().callsFake((linkKey: string) => controllers.get(linkKey)),
    pushMessages              : sinon.stub().callsFake(async ({ messageCids }) => ({ failed: [], succeeded: messageCids })),
    recordDeadLetter          : sinon.stub().resolves(),
    reportError               : sinon.stub(),
    scheduleReconcile         : sinon.stub(),
    transitionPushResult      : sinon.stub().resolves({
      quotaBlocked      : false,
      retryableFailures : [],
      terminalFailures  : [],
    }),
  };
  const echoSuppressor = new SyncEchoSuppressor();
  const coordinator = new SyncLivePushCoordinator({
    ...options,
    echoSuppressor,
    operations,
  });
  return { controllers, coordinator, echoSuppressor, operations, taskRunner };
}

function activate(fixture: PushFixture, state = link()): SyncLinkController {
  const controller = new SyncLinkController(LINK_KEY, state);
  fixture.controllers.set(LINK_KEY, controller);
  return controller;
}

async function waitForLastTask(taskRunner: SinonStub): Promise<void> {
  await taskRunner.lastCall?.returnValue;
}

describe('SyncLivePushCoordinator', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('filters stale, non-event, out-of-scope, and pulled-echo deliveries and reconciles unknown scope', async () => {
    const fixture = createFixture();
    const scope = { kind: 'protocolSet' as const, protocols: ['https://protocol.example/covered'] as [string] };
    const controller = activate(fixture, link(scope));

    await fixture.coordinator.handleEvent(target(scope), controller, () => true, fixture.taskRunner, event());
    await fixture.coordinator.handleEvent(target(scope), controller, () => false, fixture.taskRunner, {
      type   : 'eose',
      cursor : { epoch: 'epoch', position: '1', streamId: 'stream' },
    });
    await fixture.coordinator.handleEvent(
      target(scope),
      controller,
      () => false,
      fixture.taskRunner,
      event(protocolMessage('https://protocol.example/outside')),
    );

    const unknown = {
      descriptor: {
        interface        : DwnInterfaceName.Records,
        messageTimestamp : '2026-07-17T00:00:00.000000Z',
        method           : DwnMethodName.Delete,
        recordId         : 'record-id',
      },
    } as GenericMessage;
    await fixture.coordinator.handleEvent(target(scope), controller, () => false, fixture.taskRunner, event(unknown));

    const echoed = protocolMessage();
    const echoedCid = await Message.getCid(echoed);
    fixture.echoSuppressor.trackPulled(DID, echoedCid, REMOTE);
    await fixture.coordinator.handleEvent(target(scope), controller, () => false, fixture.taskRunner, event(echoed));

    expect(fixture.operations.scheduleReconcile.calledOnceWithExactly(
      LINK_KEY,
      controller.link,
      'push-scope-unclassified',
    )).toBe(true);
    expect(controller.pushRuntime).toBeUndefined();
    expect(fixture.taskRunner.called).toBe(false);
  });

  it('immediately flushes the first event and folds the result against the complete link target', async () => {
    const fixture = createFixture();
    const controller = activate(fixture);
    const message = protocolMessage();
    const cid = await Message.getCid(message);

    await fixture.coordinator.handleEvent(target(), controller, () => false, fixture.taskRunner, event(message));
    await waitForLastTask(fixture.taskRunner);

    expect(fixture.operations.pushMessages.calledOnceWithExactly({
      delegateDid        : undefined,
      did                : DID,
      dwnUrl             : REMOTE,
      messageCids        : [cid],
      permissionGrantIds : undefined,
    })).toBe(true);
    expect(fixture.operations.transitionPushResult.calledOnce).toBe(true);
    expect(fixture.operations.transitionPushResult.firstCall.args).toEqual([
      expect.objectContaining({
        authorizationEpoch : 'owner-epoch',
        did                : DID,
        dwnUrl             : REMOTE,
        projectionId       : 'projection',
      }),
      { failed: [], succeeded: [cid] },
      { protocol: undefined, source: 'feed' },
    ]);
    expect(controller.pushRuntime).toBeUndefined();
  });

  it('debounces entries that arrive during an in-flight push and drains them in a second supervised batch', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture({ debounceMs: 100 });
    const controller = activate(fixture);
    const releaseFirst = deferred<void>();
    const firstStarted = deferred<void>();
    fixture.operations.pushMessages.onFirstCall().callsFake(async ({ messageCids }) => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return { failed: [], succeeded: messageCids };
    });

    const first = protocolMessage('https://protocol.example/first');
    const second = protocolMessage('https://protocol.example/second');
    await fixture.coordinator.handleEvent(target(), controller, () => false, fixture.taskRunner, event(first));
    await firstStarted.promise;
    await fixture.coordinator.handleEvent(target(), controller, () => false, fixture.taskRunner, event(second));

    expect(fixture.taskRunner.callCount).toBe(1);
    releaseFirst.resolve();
    await waitForLastTask(fixture.taskRunner);
    expect(fixture.operations.captureIdentityTaskRunner.calledOnceWithExactly(DID)).toBe(true);
    fixture.operations.captureIdentityTaskRunner.resetHistory();
    expect(controller.pushRuntime?.timer).toBeDefined();

    await clock.tickAsync(100);
    await waitForLastTask(fixture.taskRunner);

    expect(fixture.operations.captureIdentityTaskRunner.notCalled).toBe(true);
    expect(fixture.operations.pushMessages.callCount).toBe(2);
    expect(fixture.operations.pushMessages.secondCall.args[0].messageCids).toEqual([
      await Message.getCid(second),
    ]);
    expect(controller.pushRuntime).toBeUndefined();
  });

  it('drops an in-flight result after the controller lifetime ends', async () => {
    const fixture = createFixture();
    const controller = activate(fixture);
    const pushStarted = deferred<void>();
    const releasePush = deferred<void>();
    fixture.operations.pushMessages.callsFake(async ({ messageCids }) => {
      pushStarted.resolve();
      await releasePush.promise;
      return { failed: [], succeeded: messageCids };
    });

    await fixture.coordinator.handleEvent(target(), controller, () => false, fixture.taskRunner, event());
    await pushStarted.promise;
    controller.deactivate();
    releasePush.resolve();
    await waitForLastTask(fixture.taskRunner);

    expect(fixture.operations.transitionPushResult.called).toBe(false);
    expect(fixture.operations.scheduleReconcile.called).toBe(false);
    expect(fixture.operations.reportError.called).toBe(false);
  });

  it('retries only retryable failures and schedules a quota probe from the folded result', async () => {
    const clock = sinon.useFakeTimers({ now: Date.parse('2026-07-17T00:00:00.000Z') });
    const fixture = createFixture({ retryBackoffMs: [0, 250, 1000] });
    const controller = activate(fixture);
    const first = protocolMessage('https://protocol.example/first');
    const second = protocolMessage('https://protocol.example/second');
    const firstCid = await Message.getCid(first);
    const secondCid = await Message.getCid(second);
    fixture.taskRunner.resetBehavior();
    fixture.taskRunner.resolves();
    fixture.operations.transitionPushResult.onFirstCall().resolves({
      nextQuotaProbeAt  : '2026-07-17T00:00:30.000Z',
      quotaBlocked      : false,
      retryableFailures : [{ cid: secondCid, detail: 'retry' }],
      terminalFailures  : [],
    });

    await fixture.coordinator.handleEvent(target(), controller, () => false, fixture.taskRunner, event(first));
    await fixture.coordinator.handleEvent(target(), controller, () => false, fixture.taskRunner, event(second));
    await fixture.coordinator.flushLink(LINK_KEY, controller);

    expect(fixture.operations.scheduleReconcile.calledWithExactly(
      LINK_KEY,
      controller.link,
      'push-quota-probe',
      30_000,
    )).toBe(true);
    expect(controller.pushRuntime?.retryCount).toBe(1);
    fixture.taskRunner.resetBehavior();
    fixture.taskRunner.callsFake(async (operation: () => Promise<void>) => operation());
    await clock.tickAsync(250);
    await waitForLastTask(fixture.taskRunner);

    expect(fixture.operations.pushMessages.lastCall.args[0].messageCids).toEqual([secondCid]);
    expect(fixture.operations.pushMessages.firstCall.args[0].messageCids).toContain(firstCid);
  });

  it('reports transport failures and retries the original batch', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture({ retryBackoffMs: [0, 10] });
    const controller = activate(fixture);
    fixture.operations.pushMessages.onFirstCall().rejects(new Error('offline'));

    await fixture.coordinator.handleEvent(target(), controller, () => false, fixture.taskRunner, event());
    await waitForLastTask(fixture.taskRunner);

    expect(fixture.operations.reportError.calledOnce).toBe(true);
    expect(controller.pushRuntime?.retryCount).toBe(1);
    await clock.tickAsync(10);
    await waitForLastTask(fixture.taskRunner);
    expect(fixture.operations.pushMessages.calledTwice).toBe(true);
  });

  it('serializes a reconcile requeue behind an in-flight transport batch', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture({ retryBackoffMs: [0, 10, 20] });
    const controller = activate(fixture);
    const runtime = controller.getOrCreatePushRuntime({ did: DID, dwnUrl: REMOTE });
    runtime.entries.push({ cid: 'in-flight-cid' });
    const pushStarted = deferred<void>();
    const releasePush = deferred<void>();
    fixture.operations.pushMessages.callsFake(async () => {
      pushStarted.resolve();
      await releasePush.promise;
      throw new Error('offline');
    });

    const flushing = fixture.coordinator.flushLink(LINK_KEY, controller);
    await pushStarted.promise;

    // The mailbox holds the reconcile requeue outside the in-flight flush:
    // it queues behind the transport batch instead of interleaving with it.
    let reconcileCompleted = false;
    const reconcile = fixture.coordinator.handleReconcileFailures(controller, [{
      cid    : 'reconcile-cid',
      detail : 'retry after the batch',
    }]).then((): void => { reconcileCompleted = true; });
    await Promise.resolve();
    expect(reconcileCompleted).toBe(false);

    releasePush.resolve();
    await flushing;
    await reconcile;

    // Serialized order: the failed batch requeues its own entry first, then
    // the reconcile requeue appends; the retry count reflects one transport
    // failure, not a double count.
    expect(runtime.retryCount).toBe(1);
    expect(runtime.entries.map(({ cid }) => cid)).toEqual(['in-flight-cid', 'reconcile-cid']);
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('dead-letters terminal failures, clears their quota rows, and requests durable reconciliation', async () => {
    const fixture = createFixture();
    const controller = activate(fixture);
    const failure = {
      cid      : 'terminal-cid',
      detail   : 'invalid signature',
      kind     : 'Invalid' as const,
      terminal : true,
    };

    await fixture.coordinator.handleReconcileFailures(controller, [failure]);

    expect(fixture.operations.clearQuotaBlock.calledOnceWithExactly(DID, LINK_KEY, failure.cid)).toBe(true);
    expect(fixture.operations.recordDeadLetter.firstCall.args[0]).toEqual(expect.objectContaining({
      category       : 'admit-failed',
      errorCode      : 'Invalid',
      errorDetail    : failure.detail,
      messageCid     : failure.cid,
      remoteEndpoint : REMOTE,
      tenantDid      : DID,
    }));
    expect(fixture.operations.scheduleReconcile.calledOnceWithExactly(
      LINK_KEY,
      controller.link,
      'push-terminal',
    )).toBe(true);
    expect(controller.pushRuntime).toBeUndefined();
  });

  it('defers non-converging failures and hands exhausted generic retries to reconciliation', async () => {
    const fixture = createFixture({ deferredReconcileDelayMs: 45_000, retryBackoffMs: [0] });
    const controller = activate(fixture);

    await fixture.coordinator.handleReconcileFailures(controller, [{
      cid    : 'incomplete-cid',
      kind   : 'Incomplete',
      detail : 'missing dependency',
    }]);
    expect(fixture.operations.scheduleReconcile.calledOnceWithExactly(
      LINK_KEY,
      controller.link,
      'push-incomplete',
      45_000,
    )).toBe(true);

    fixture.operations.scheduleReconcile.resetHistory();
    await fixture.coordinator.requeue(controller, {
      did        : DID,
      dwnUrl     : REMOTE,
      entries    : [{ cid: 'retry-cid', lastFailure: { cid: 'retry-cid', detail: 'temporary' } }],
      retryCount : 1,
    });
    expect(fixture.operations.scheduleReconcile.calledOnceWithExactly(
      LINK_KEY,
      controller.link,
      'push-retry-exhausted',
    )).toBe(true);
    expect(controller.pushRuntime).toBeUndefined();
  });

  it('rejects reconcile failures and flushes captured for a stale or replacement controller', async () => {
    const fixture = createFixture();
    const originalLink = link();
    const original = activate(fixture, originalLink);
    // A replaced controller is deactivated by activateLink in production;
    // its reconcile failures and flushes must not reach the replacement.
    original.deactivate();
    const replacement = new SyncLinkController(LINK_KEY, link());
    fixture.controllers.set(LINK_KEY, replacement);
    original.getOrCreatePushRuntime({ did: DID, dwnUrl: REMOTE }).entries.push({ cid: 'old-cid' });

    await fixture.coordinator.handleReconcileFailures(original, [{ cid: 'failure' }]);
    await fixture.coordinator.flushLink(LINK_KEY, original);

    expect(fixture.operations.pushMessages.called).toBe(false);
    expect(replacement.pushRuntime).toBeUndefined();
  });

  it('cancels a scheduled retry when the controller is deactivated', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture({ retryBackoffMs: [0, 10] });
    const controller = activate(fixture);

    await fixture.coordinator.requeue(controller, {
      did        : DID,
      dwnUrl     : REMOTE,
      entries    : [{ cid: 'retry-cid' }],
      retryCount : 1,
    });
    expect(fixture.operations.captureIdentityTaskRunner.calledOnceWithExactly(DID)).toBe(true);
    fixture.operations.captureIdentityTaskRunner.resetHistory();
    expect(controller.pushRuntime?.timer).toBeDefined();
    controller.deactivate();
    await clock.tickAsync(10);

    expect(fixture.operations.captureIdentityTaskRunner.notCalled).toBe(true);
    expect(fixture.taskRunner.called).toBe(false);
    expect(fixture.operations.pushMessages.called).toBe(false);
  });
});

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve(value?: Value): void;
  } {
  let resolve!: (value?: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
