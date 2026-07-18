import type { GenericMessage, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';
import { SubscriptionHandlerTerminalError, WebSocketDwnRpcClient } from '@enbox/dwn-clients';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { ProcessDwnRequest } from '../src/types/dwn.js';

import { DwnInterface } from '../src/types/dwn.js';
import {
  MAX_PENDING_SUBSCRIPTION_DECRYPTS,
  maybeWrapSubscriptionHandlerForDecryption,
} from '../src/dwn-encryption.js';

/** A full progress token as servers emit on every cursor-bearing message. */
function tokenOf(index: number): { streamId: string; epoch: string; position: string; messageCid: string } {
  return { streamId: 'stream-1', epoch: 'epoch-1', position: String(index + 1), messageCid: `cid-${index}` };
}

/** A plain (non-encrypted) subscription event; decryption is skipped but delivery still serializes. */
function plainEvent(index: number): SubscriptionMessage {
  return {
    type   : 'event',
    cursor : tokenOf(index),
    event  : {
      message: {
        descriptor: { interface: 'Records', method: 'Delete' },
      },
    },
  } as unknown as SubscriptionMessage;
}

function wrap(handler: (message: SubscriptionMessage) => void | Promise<void>): (message: SubscriptionMessage) => Promise<void> {
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

/** Waits until `condition` holds, failing the test after `timeoutMs`. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor: condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

  it('gates the completion promise on asynchronous consumer processing', async () => {
    const delivered: SubscriptionMessage[] = [];
    let releaseConsumer!: () => void;
    const consumerGate = new Promise<void>((resolve) => { releaseConsumer = resolve; });
    const listener = wrap(async (message) => {
      await consumerGate;
      delivered.push(message);
    });

    let completed = false;
    const completion = listener(plainEvent(1)).then((): void => { completed = true; });

    // Give the queue a chance to run: the consumer is invoked but must not
    // be considered complete until its promise settles.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toBe(false);
    expect(delivered).toHaveLength(0);

    releaseConsumer();
    await completion;
    expect(delivered).toHaveLength(1);
  });

  it('terminates losslessly when the pending bound is exceeded', async () => {
    const delivered: SubscriptionMessage[] = [];
    const listener = wrap((message) => delivered.push(message));

    // Enqueue synchronously: completions land in microtasks that cannot run
    // during this loop, so the pending count climbs to the bound exactly.
    const flood = MAX_PENDING_SUBSCRIPTION_DECRYPTS + 40;
    const completions: Array<Promise<void>> = [];
    for (let i = 0; i < flood; i += 1) {
      completions.push(listener(plainEvent(i)));
    }
    const settled = await Promise.allSettled(completions);

    // Every event up to the bound delivered, in order.
    const events = delivered.filter((message) => message.type === 'event');
    expect(events).toHaveLength(MAX_PENDING_SUBSCRIPTION_DECRYPTS);
    expect(
      events.map((message) => ('cursor' in message ? message.cursor : undefined)),
    ).toEqual(
      Array.from({ length: MAX_PENDING_SUBSCRIPTION_DECRYPTS }, (_, i) => tokenOf(i)),
    );

    // Queued events completed; the overflowing event and every later one
    // rejected with the transport-terminal signal so no transport acks them.
    for (let i = 0; i < flood; i += 1) {
      const outcome = settled[i];
      if (i < MAX_PENDING_SUBSCRIPTION_DECRYPTS) {
        expect(outcome.status).toBe('fulfilled');
      } else {
        expect(outcome.status).toBe('rejected');
        expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(SubscriptionHandlerTerminalError);
      }
    }

    // Exactly ONE terminal error follows the drained deliveries, carrying the
    // cursor of the LAST DELIVERED event — resubscribing after it replays the
    // dropped events. Over-bound events are dropped, never silently skipped.
    const errors = delivered.filter((message) => message.type === 'error');
    expect(errors).toHaveLength(1);
    const [error] = errors;
    if (error.type !== 'error') {throw new Error('unreachable');}
    expect(error.error.code).toBe('SubscriptionDecryptBackpressureExceeded');
    expect(error.cursor).toEqual(tokenOf(MAX_PENDING_SUBSCRIPTION_DECRYPTS - 1) as never);
    expect(delivered.at(-1)).toBe(error);

    // The wrapper stays terminal: later events keep rejecting, undelivered.
    await expect(listener(plainEvent(9999))).rejects.toBeInstanceOf(SubscriptionHandlerTerminalError);
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

describe('maybeWrapSubscriptionHandlerForDecryption — composed WebSocket transport behavior', () => {
  it('closes the tracked subscription on overflow and never acks dropped events', async () => {
    // Compose the REAL decrypting wrapper with the REAL WebSocket client
    // subscription path over a stubbed socket, and verify the transport-level
    // consequences of an overflow end to end: acks stop at the last delivered
    // event, the tracked subscription closes, and the reconnect cursor never
    // advances past an undelivered event.
    const delivered: SubscriptionMessage[] = [];
    const wrappedHandler = wrap((message) => delivered.push(message));

    const sentAcks: Array<{ cursor: { messageCid: string } }> = [];
    let serverCloseCalls = 0;
    let capturedListener: ((response: { result?: unknown; error?: unknown }) => void) | undefined;

    const subscriptionId = 'composed-sub';
    const fakeSocket = {
      subscribe: async (
        _request: unknown,
        listener: (response: { result?: unknown; error?: unknown }) => void,
      ): Promise<unknown> => {
        capturedListener = listener;
        return {
          response: {
            result: {
              reply: {
                status       : { code: 200, detail: 'OK' },
                subscription : { id: subscriptionId, close: async (): Promise<void> => {} },
              },
            },
          },
          close: async (): Promise<void> => { serverCloseCalls += 1; },
        };
      },
      send: (request: { method: string; params?: { cursor?: { messageCid: string } } }): void => {
        if (request.method === 'rpc.ack' && request.params?.cursor) {
          sentAcks.push({ cursor: request.params.cursor });
        }
      },
    };

    const connection = {
      socket        : fakeSocket,
      subscriptions : new Map(),
      url           : 'wss://composed.example/',
    };

    const reply = await (WebSocketDwnRpcClient as unknown as {
      subscriptionRequest(
        connection: unknown,
        target: string,
        message: GenericMessage,
        handler: unknown,
      ): Promise<{ status: { code: number } }>;
    }).subscriptionRequest(
      connection,
      'did:example:alice',
      {} as GenericMessage,
      wrappedHandler,
    );

    expect(reply.status.code).toBe(200);
    expect(connection.subscriptions.size).toBe(1);
    if (capturedListener === undefined) {throw new Error('listener not captured');}

    // Flood synchronously past the decrypt bound, exactly as a server draining
    // a large window would deliver into a stalled decrypt queue.
    const flood = MAX_PENDING_SUBSCRIPTION_DECRYPTS + 40;
    for (let i = 0; i < flood; i += 1) {
      capturedListener({ result: { subscription: plainEvent(i) } });
    }

    // Drain: every queued event delivers, then the synthetic terminal error.
    await waitFor((): boolean => delivered.some((message) => message.type === 'error'));
    // The terminal ack turn runs after the error surfaces; wait for the close.
    await waitFor((): boolean => connection.subscriptions.size === 0);

    // Delivered: exactly the queued events, then the terminal error.
    const events = delivered.filter((message) => message.type === 'event');
    expect(events).toHaveLength(MAX_PENDING_SUBSCRIPTION_DECRYPTS);

    // Acked: exactly the delivered events — nothing at or past the overflow.
    expect(sentAcks).toHaveLength(MAX_PENDING_SUBSCRIPTION_DECRYPTS);
    expect(sentAcks.at(-1)?.cursor).toEqual(tokenOf(MAX_PENDING_SUBSCRIPTION_DECRYPTS - 1));

    // The tracked subscription closed out through the server-side close.
    expect(serverCloseCalls).toBe(1);

    // The synthetic error carries the last DELIVERED cursor so a consumer
    // resubscription replays the dropped tail.
    const [error] = delivered.filter((message) => message.type === 'error');
    if (error.type !== 'error') {throw new Error('unreachable');}
    expect(error.cursor).toEqual(tokenOf(MAX_PENDING_SUBSCRIPTION_DECRYPTS - 1) as never);

    // Late events after the terminal close are ignored entirely: not
    // delivered, not acked.
    capturedListener({ result: { subscription: plainEvent(99_999) } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(delivered.filter((message) => message.type === 'event')).toHaveLength(MAX_PENDING_SUBSCRIPTION_DECRYPTS);
    expect(sentAcks).toHaveLength(MAX_PENDING_SUBSCRIPTION_DECRYPTS);
  });

  it('acks after asynchronous consumer completion and tracks the delivered cursor', async () => {
    let releaseConsumer!: () => void;
    const consumerGate = new Promise<void>((resolve) => { releaseConsumer = resolve; });
    const delivered: SubscriptionMessage[] = [];
    const wrappedHandler = wrap(async (message) => {
      await consumerGate;
      delivered.push(message);
    });

    const sentAcks: Array<{ cursor: { messageCid: string } }> = [];
    let capturedListener: ((response: { result?: unknown; error?: unknown }) => void) | undefined;
    const fakeSocket = {
      subscribe: async (
        _request: unknown,
        listener: (response: { result?: unknown; error?: unknown }) => void,
      ): Promise<unknown> => {
        capturedListener = listener;
        return {
          response: {
            result: {
              reply: {
                status       : { code: 200, detail: 'OK' },
                subscription : { id: 'async-sub', close: async (): Promise<void> => {} },
              },
            },
          },
          close: async (): Promise<void> => {},
        };
      },
      send: (request: { method: string; params?: { cursor?: { messageCid: string } } }): void => {
        if (request.method === 'rpc.ack' && request.params?.cursor) {
          sentAcks.push({ cursor: request.params.cursor });
        }
      },
    };
    const connection = { socket: fakeSocket, subscriptions: new Map(), url: 'wss://async.example/' };

    await (WebSocketDwnRpcClient as unknown as {
      subscriptionRequest(
        connection: unknown,
        target: string,
        message: GenericMessage,
        handler: unknown,
      ): Promise<unknown>;
    }).subscriptionRequest(connection, 'did:example:alice', {} as GenericMessage, wrappedHandler);
    if (capturedListener === undefined) {throw new Error('listener not captured');}

    capturedListener({ result: { subscription: plainEvent(7) } });

    // The consumer has not completed — no ack, no reconnect-cursor movement.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sentAcks).toHaveLength(0);
    const tracked = [...connection.subscriptions.values()][0] as { lastCursor?: unknown };
    expect(tracked.lastCursor).toBeUndefined();

    releaseConsumer();
    await waitFor((): boolean => sentAcks.length === 1);
    expect(sentAcks[0].cursor).toEqual(tokenOf(7));
    expect(tracked.lastCursor).toEqual(tokenOf(7));
  });
});
