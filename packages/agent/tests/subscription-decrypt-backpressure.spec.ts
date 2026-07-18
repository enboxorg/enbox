import type { SubscriptionMessage } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { ProcessDwnRequest } from '../src/types/dwn.js';

import { DwnInterface } from '../src/types/dwn.js';
import {
  MAX_PENDING_SUBSCRIPTION_DECRYPTS,
  maybeWrapSubscriptionHandlerForDecryption,
} from '../src/dwn-encryption.js';

/** A plain (non-encrypted) subscription event; decryption is skipped but delivery still serializes. */
function plainEvent(index: number): SubscriptionMessage {
  return {
    type   : 'event',
    cursor : { messageCid: `cid-${index}` },
    event  : {
      message: {
        descriptor: { interface: 'Records', method: 'Delete' },
      },
    },
  } as unknown as SubscriptionMessage;
}

function wrap(handler: (message: SubscriptionMessage) => void): (message: SubscriptionMessage) => Promise<void> {
  const request = {
    messageType         : DwnInterface.RecordsSubscribe,
    author              : 'did:example:alice',
    target              : 'did:example:alice',
    encryption          : true,
    subscriptionHandler : handler,
    messageParams       : {},
  } as unknown as ProcessDwnRequest<DwnInterface.RecordsSubscribe>;
  const wrapped = maybeWrapSubscriptionHandlerForDecryption(
    request,
    {} as EnboxPlatformAgent,
  );
  return wrapped as unknown as (message: SubscriptionMessage) => Promise<void>;
}

describe('maybeWrapSubscriptionHandlerForDecryption — backpressure', () => {
  it('returns a per-event completion promise that resolves after delivery (the ack gate)', async () => {
    const delivered: SubscriptionMessage[] = [];
    const listener = wrap((message) => delivered.push(message));

    const completion = listener(plainEvent(1));
    expect(delivered).toHaveLength(0); // delivery is asynchronous
    await completion;
    expect(delivered).toHaveLength(1);
  });

  it('terminates the subscription with a synthetic error when the pending bound is exceeded', async () => {
    const delivered: SubscriptionMessage[] = [];
    const listener = wrap((message) => delivered.push(message));

    // Enqueue synchronously: completions land in microtasks that cannot run
    // during this loop, so the pending count climbs to the bound exactly.
    const flood = MAX_PENDING_SUBSCRIPTION_DECRYPTS + 40;
    const completions: Array<Promise<void>> = [];
    for (let i = 0; i < flood; i += 1) {
      completions.push(listener(plainEvent(i)));
    }
    await Promise.all(completions);

    // Every event up to the bound delivered, in order.
    const events = delivered.filter((message) => message.type === 'event');
    expect(events).toHaveLength(MAX_PENDING_SUBSCRIPTION_DECRYPTS);
    expect(
      events.map((message) => ('cursor' in message ? message.cursor : undefined)),
    ).toEqual(
      Array.from({ length: MAX_PENDING_SUBSCRIPTION_DECRYPTS }, (_, i) => ({ messageCid: `cid-${i}` })),
    );

    // Exactly ONE terminal error follows, carrying the backpressure code and
    // the last observed cursor; over-bound events are dropped, not delivered.
    const errors = delivered.filter((message) => message.type === 'error');
    expect(errors).toHaveLength(1);
    const [error] = errors;
    if (error.type !== 'error') {throw new Error('unreachable');}
    expect(error.error.code).toBe('SubscriptionDecryptBackpressureExceeded');
    expect(delivered.at(-1)).toBe(error);

    // The wrapper stays terminal: later events are ignored entirely.
    await listener(plainEvent(9999));
    expect(delivered.at(-1)).toBe(error);
  });

  it('preserves strict arrival order across interleaved enqueues', async () => {
    const order: string[] = [];
    const listener = wrap((message) => {
      if ('cursor' in message && message.cursor) {
        order.push((message.cursor as { messageCid: string }).messageCid);
      }
    });

    await Promise.all([listener(plainEvent(1)), listener(plainEvent(2)), listener(plainEvent(3))]);
    expect(order).toEqual(['cid-1', 'cid-2', 'cid-3']);
  });
});
