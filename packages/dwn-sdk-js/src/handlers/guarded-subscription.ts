import type { DwnErrorCode } from '../core/dwn-error.js';
import type { EventSubscription, SubscriptionEvent, SubscriptionListener, SubscriptionMessage } from '../types/subscriptions.js';

export type GuardedSubscriptionHandler = {
  listener: SubscriptionListener;
  setSubscription(subscription: EventSubscription): Promise<void>;
};

/** Serializes subscription projection and closes exactly once after a terminal delivery failure. */
export function createGuardedSubscriptionHandler(input: {
  listener: SubscriptionListener;
  processEvent(
    event: SubscriptionEvent,
    fail: (code: DwnErrorCode, detail: string) => void,
  ): Promise<SubscriptionEvent | undefined>;
}): GuardedSubscriptionHandler {
  let subscription: EventSubscription | undefined;
  let closeRequested = false;
  let deliveryQueue: Promise<void> = Promise.resolve();

  const closeSubscription = (): void => {
    if (closeRequested) {
      return;
    }
    closeRequested = true;
    Promise.resolve(subscription?.close()).catch(() => {});
  };

  const deliver = async (message: SubscriptionMessage): Promise<void> => {
    if (closeRequested) {
      return;
    }
    if (message.type !== 'event') {
      input.listener(message);
      return;
    }

    const fail = (code: DwnErrorCode, detail: string): void => {
      if (closeRequested) {
        return;
      }
      closeSubscription();
      input.listener({ type: 'error', cursor: message.cursor, error: { code, detail } });
    };
    const projected = await input.processEvent(message, fail);
    if (!closeRequested && projected !== undefined) {
      input.listener(projected);
    }
  };

  return {
    listener: (message): void => {
      deliveryQueue = deliveryQueue.then(() => deliver(message)).catch(() => {});
    },
    setSubscription: async (eventSubscription): Promise<void> => {
      subscription = eventSubscription;
      if (closeRequested) {
        await eventSubscription.close();
      }
    },
  };
}
