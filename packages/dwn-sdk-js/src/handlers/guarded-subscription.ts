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

  const closeSubscription = async (): Promise<void> => {
    if (closeRequested) {
      return;
    }
    closeRequested = true;
    await subscription?.close().catch((): void => {});
  };

  const deliver = async (message: SubscriptionMessage): Promise<void> => {
    if (closeRequested) {
      return;
    }
    if (message.type !== 'event') {
      await input.listener(message);
      return;
    }

    let terminalError: SubscriptionMessage | undefined;
    const fail = (code: DwnErrorCode, detail: string): void => {
      if (closeRequested || terminalError !== undefined) {
        return;
      }
      terminalError = { type: 'error', cursor: message.cursor, error: { code, detail } };
    };
    const projected = await input.processEvent(message, fail);
    if (terminalError !== undefined) {
      await closeSubscription();
      await input.listener(terminalError);
      return;
    }
    if (projected !== undefined) {
      await input.listener(projected);
    }
  };

  return {
    listener: (message): Promise<void> => {
      deliveryQueue = deliveryQueue.then(() => deliver(message)).catch(closeSubscription);
      return deliveryQueue;
    },
    setSubscription: async (eventSubscription): Promise<void> => {
      subscription = eventSubscription;
      if (closeRequested) {
        await eventSubscription.close();
      }
    },
  };
}
