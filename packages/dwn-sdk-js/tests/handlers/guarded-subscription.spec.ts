import type { EventSubscription, SubscriptionEvent } from '../../src/types/subscriptions.js';

import { describe, expect, it } from 'bun:test';

import { createGuardedSubscriptionHandler } from '../../src/handlers/guarded-subscription.js';

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
});
