import type { EventSubscription, SubscriptionEvent, SubscriptionMessage } from '../../src/types/subscriptions.js';

import { describe, expect, it } from 'bun:test';

import { createGuardedSubscriptionHandler } from '../../src/handlers/guarded-subscription.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';

const timestamp = '2026-08-03T00:00:00.000000Z';

function subscriptionEvent(position: string): SubscriptionEvent {
  return {
    type   : 'event',
    cursor : {
      streamId : 'stream',
      epoch    : 'epoch',
      position,
    },
    event: {
      message: {
        descriptor: {
          interface        : 'Records',
          method           : 'Write',
          messageTimestamp : timestamp,
        },
      },
    },
  };
}

describe('createGuardedSubscriptionHandler', () => {
  it('should close once and suppress queued events after an async listener rejects', async () => {
    let closeCount = 0;
    let listenerCount = 0;
    let processCount = 0;
    let releaseListener!: () => void;
    let signalListenerStarted!: () => void;
    const listenerBlocked = new Promise<void>((resolve) => { releaseListener = resolve; });
    const listenerStarted = new Promise<void>((resolve) => { signalListenerStarted = resolve; });
    const subscription: EventSubscription = {
      id    : 'subscription',
      close : async (): Promise<void> => { closeCount++; },
    };
    const guarded = createGuardedSubscriptionHandler({
      listener: async (): Promise<void> => {
        listenerCount++;
        signalListenerStarted();
        await listenerBlocked;
        throw new Error('listener failed');
      },
      processEvent: async (event): Promise<SubscriptionEvent> => {
        processCount++;
        return event;
      },
    });
    await guarded.setSubscription(subscription);

    const firstDelivery = guarded.listener(subscriptionEvent('1'));
    const secondDelivery = guarded.listener(subscriptionEvent('2'));
    await listenerStarted;
    expect(listenerCount).toBe(1);
    releaseListener();
    await Promise.all([firstDelivery, secondDelivery]);

    expect(listenerCount).toBe(1);
    expect(processCount).toBe(1);
    expect(closeCount).toBe(1);
  });

  it('should close a subscription installed after an async catch-up listener rejects', async () => {
    let closeCount = 0;
    const guarded = createGuardedSubscriptionHandler({
      listener: async (): Promise<void> => {
        throw new Error('listener failed');
      },
      processEvent: async (event): Promise<SubscriptionEvent> => event,
    });

    await guarded.listener(subscriptionEvent('1'));
    await guarded.setSubscription({
      id    : 'subscription',
      close : async (): Promise<void> => { closeCount++; },
    });

    expect(closeCount).toBe(1);
  });

  it('should deliver a terminal projection error without waiting for subscription close', async () => {
    let closeCount = 0;
    let processCount = 0;
    let releaseClose!: () => void;
    const closeBlocked = new Promise<void>((resolve) => { releaseClose = resolve; });
    const delivered: SubscriptionMessage[] = [];
    const guarded = createGuardedSubscriptionHandler({
      listener     : async (message): Promise<void> => { delivered.push(message); },
      processEvent : async (_event, fail): Promise<undefined> => {
        processCount++;
        fail(DwnErrorCode.MessagesSubscribeDeliveryFailed, 'terminal delivery failure');
        return undefined;
      },
    });
    await guarded.setSubscription({
      id    : 'subscription',
      close : async (): Promise<void> => {
        closeCount++;
        await closeBlocked;
      },
    });

    let firstSettled = false;
    let secondSettled = false;
    const firstDelivery = Promise.resolve(guarded.listener(subscriptionEvent('1')))
      .then((): void => { firstSettled = true; });
    const secondDelivery = Promise.resolve(guarded.listener(subscriptionEvent('2')))
      .then((): void => { secondSettled = true; });

    try {
      for (let turn = 0; turn < 10 && (!firstSettled || !secondSettled); turn++) {
        await Promise.resolve();
      }

      expect(delivered).toEqual([{
        type   : 'error',
        cursor : subscriptionEvent('1').cursor,
        error  : {
          code   : DwnErrorCode.MessagesSubscribeDeliveryFailed,
          detail : 'terminal delivery failure',
        },
      }]);
      expect(firstSettled).toBe(true);
      expect(secondSettled).toBe(true);
      expect(processCount).toBe(1);
      expect(closeCount).toBe(1);
    } finally {
      releaseClose();
      await Promise.all([firstDelivery, secondDelivery]);
    }
  });
});
