import type { SyncEngine, SyncEvent, SyncEventListener } from '../src/types/sync.js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { deferred as createDeferred } from './utils/deferred.js';
import {
  AudienceKeyDeliveryCoordinator,
  AudienceKeyDeliveryReplicaNotCurrentError,
} from '../src/audience-key-delivery-coordinator.js';

describe('AudienceKeyDeliveryCoordinator', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('wakes registered protocols for startup and matching sync events until the session ends', async () => {
    const controller = new AbortController();
    const sync = syncEvents();
    const run = sinon.stub();
    const releaseFinalRun = createDeferred<boolean>();
    run.onFirstCall().rejects(new AudienceKeyDeliveryReplicaNotCurrentError());
    run.onSecondCall().rejects(new AudienceKeyDeliveryReplicaNotCurrentError());
    run.onThirdCall().rejects(new AudienceKeyDeliveryReplicaNotCurrentError());
    run.onCall(5).returns(releaseFinalRun.promise);
    run.resolves(false);
    const coordinator = new AudienceKeyDeliveryCoordinator({
      protocol  : 'https://example.com/chat',
      rolePaths : new Set(['thread/participant']),
      run,
      signal    : controller.signal,
      sync      : sync.engine,
      targetDid : 'did:example:alice',
    });

    await coordinator.whenIdle();
    expect(run.callCount).toBe(1);
    expect(run.firstCall.args[0]).toBe(true);

    sync.emit(pullCurrentEvent({ tenantDid: 'did:example:other' }));
    sync.emit(pullCurrentEvent({ protocol: 'https://example.com/other' }));
    sync.emit(deliveryEvent('thread/message'));
    sync.emit({ type: 'identity:registration-change', tenantDid: 'did:example:other' });
    await coordinator.whenIdle();
    expect(run.callCount).toBe(1);

    sync.emit({
      type      : 'identity:registration-change',
      tenantDid : 'did:example:alice',
      options   : { protocols: ['https://example.com/other'] },
    });
    await coordinator.whenIdle();
    expect(run.callCount).toBe(2);
    expect(run.secondCall.args[0]).toBe(true);

    sync.emit(pullCurrentEvent({ protocol: 'https://example.com/chat' }));
    await coordinator.whenIdle();
    expect(run.callCount).toBe(3);
    expect(run.thirdCall.args[0]).toBe(true);

    sync.emit(statusLiveEvent());
    await coordinator.whenIdle();
    expect(run.callCount).toBe(4);
    expect(run.getCall(3).args[0]).toBe(true);

    sync.emit(deliveryEvent('thread/message'));
    sync.emit(pullCurrentEvent({ protocol: 'https://example.com/chat' }));
    await coordinator.whenIdle();
    expect(run.callCount).toBe(4);

    sync.emit(deliveryEvent('thread/participant'));
    await coordinator.whenIdle();
    expect(run.callCount).toBe(5);
    expect(run.getCall(4).args[0]).toBe(false);

    sync.emit(connectivityEvent());
    await Promise.resolve();
    expect(run.callCount).toBe(6);
    expect(run.lastCall.args[0]).toBe(true);

    controller.abort();
    sync.emit(pullCurrentEvent({ protocol: 'https://example.com/chat' }));
    releaseFinalRun.resolve(false);
    await coordinator.whenIdle();
    expect(run.callCount).toBe(6);
    expect(sync.listenerCount()).toBe(0);
  });

  it('does not mistake an ordinary failure for a replica-currentness wait', async () => {
    const controller = new AbortController();
    const sync = syncEvents();
    const release = createDeferred();
    const run = sinon.stub();
    run.onFirstCall().callsFake(async (): Promise<boolean> => {
      await release.promise;
      throw new Error('malformed role record');
    });
    run.resolves(false);
    const coordinator = new AudienceKeyDeliveryCoordinator({
      protocol    : 'https://example.com/chat',
      retryDelays : [],
      rolePaths   : new Set(['thread/participant']),
      run,
      signal      : controller.signal,
      sync        : sync.engine,
      targetDid   : 'did:example:alice',
    });

    await Promise.resolve();
    sync.emit(pullCurrentEvent());
    sync.emit(statusLiveEvent());
    release.resolve();
    await coordinator.whenIdle();

    sync.emit(pullCurrentEvent());
    sync.emit(statusLiveEvent());
    await coordinator.whenIdle();
    expect(run.callCount).toBe(1);

    sync.emit(deliveryEvent('thread/participant'));
    await coordinator.whenIdle();
    expect(run.callCount).toBe(2);
    controller.abort();
  });

  it('bounds transient retries and restarts the budget for a newly observed failure', async () => {
    const clock = sinon.useFakeTimers();
    const run = sinon.stub().resolves(true);
    const coordinator = new AudienceKeyDeliveryCoordinator({
      protocol    : 'https://example.com/chat',
      retryDelays : [0, 0],
      rolePaths   : new Set(['thread/participant']),
      run,
      signal      : new AbortController().signal,
      sync        : syncEvents().engine,
      targetDid   : 'did:example:alice',
    });

    await clock.runAllAsync();
    expect(run.callCount).toBe(3);

    expect(run.getCalls().map(call => call.args[0])).toEqual([true, false, false]);

    coordinator.retry();
    await clock.runAllAsync();
    expect(run.callCount).toBe(5);
    expect(run.getCalls().slice(3).map(call => call.args[0])).toEqual([false, false]);
    coordinator.close();
    await coordinator.whenIdle();
  });
});

function pullCurrentEvent(overrides: Partial<Extract<SyncEvent, { type: 'pull:currentness-change' }>> = {}): SyncEvent {
  return {
    type           : 'pull:currentness-change',
    tenantDid      : 'did:example:alice',
    remoteEndpoint : 'https://dwn.example.com',
    from           : false,
    to             : true,
    ...overrides,
  };
}

function connectivityEvent(): SyncEvent {
  return {
    type           : 'link:connectivity-change',
    tenantDid      : 'did:example:alice',
    remoteEndpoint : 'https://dwn.example.com',
    protocol       : 'https://example.com/chat',
    from           : 'offline',
    to             : 'online',
  };
}

function statusLiveEvent(): SyncEvent {
  return {
    type           : 'link:status-change',
    tenantDid      : 'did:example:alice',
    remoteEndpoint : 'https://dwn.example.com',
    protocol       : 'https://example.com/chat',
    from           : 'initializing',
    to             : 'live',
  };
}

function deliveryEvent(protocolPath: string): SyncEvent {
  return {
    type           : 'delivery:applied',
    tenantDid      : 'did:example:alice',
    remoteEndpoint : 'https://dwn.example.com',
    messageCid     : crypto.randomUUID(),
    descriptor     : {
      interface : 'Records',
      method    : 'Write',
      protocol  : 'https://example.com/chat',
      protocolPath,
    },
  };
}

function syncEvents(): { emit(event: SyncEvent): void; engine: SyncEngine; listenerCount(): number } {
  const listeners = new Set<SyncEventListener>();
  return {
    emit(event): void {
      for (const listener of listeners) {
        listener(event);
      }
    },
    engine: {
      on(listener: SyncEventListener): () => void {
        listeners.add(listener);
        return (): void => { listeners.delete(listener); };
      },
    } as SyncEngine,
    listenerCount: (): number => listeners.size,
  };
}
