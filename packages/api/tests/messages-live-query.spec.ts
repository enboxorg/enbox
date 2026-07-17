import type { DwnMessageSubscription } from '@enbox/agent';
import type { MessageChange } from '../src/messages-live-query.js';

import { describe, expect, it } from 'bun:test';

import { MessagesLiveQuery } from '../src/messages-live-query.js';

function change(recordId: string): MessageChange {
  const message = {
    descriptor: {
      interface : 'Records',
      method    : 'Write',
    },
    recordId,
  } as unknown as MessageChange['message'];
  return {
    message,
    descriptor : { interface: 'Records', method: 'Write', recordId },
    messageCid : `cid-${recordId}`,
    cursor     : { streamId: 'stream', epoch: 'epoch', position: recordId },
  };
}

function trackedSubscription(): { subscription: DwnMessageSubscription; closes: () => number } {
  let closeCount = 0;
  const subscription = {
    id    : 'test-subscription',
    close : async (): Promise<void> => { closeCount++; },
  } as unknown as DwnMessageSubscription;
  return { subscription, closes: () => closeCount };
}

describe('MessagesLiveQuery', () => {
  it('should buffer pre-listener events and flush them in order one microtask after the first on()', async () => {
    const query = new MessagesLiveQuery();

    // The local cursor replay fires before any caller code can listen.
    query.handleEvent(change('1'));
    query.handleEvent(change('2'));
    query.handleLifecycleEvent('eose');

    const order: string[] = [];
    query.on('event', (delivered): void => { order.push(`event:${delivered.descriptor.recordId}`); });
    query.on('eose', (): void => { order.push('eose'); });

    // Handlers attached in the same synchronous block all see the backlog.
    expect(order).toEqual([]);
    await Promise.resolve();
    expect(order).toEqual(['event:1', 'event:2', 'eose']);

    // Post-flush events dispatch immediately.
    query.handleEvent(change('3'));
    expect(order).toEqual(['event:1', 'event:2', 'eose', 'event:3']);
  });

  it('should track connection state through transport lifecycle events', async () => {
    const query = new MessagesLiveQuery();
    const seen: Array<string | number> = [];
    query.on('disconnected', (): void => { seen.push('disconnected'); });
    query.on('reconnecting', ({ attempt }): void => { seen.push(attempt); });
    query.on('reconnected', (): void => { seen.push('reconnected'); });
    await Promise.resolve(); // drain the (empty) pre-listener buffer

    expect(query.isConnected).toBe(true);

    query.handleLifecycleEvent('disconnected');
    expect(query.isConnected).toBe(false);

    query.handleLifecycleEvent('reconnecting', { attempt: 2 });
    query.handleLifecycleEvent('reconnected');
    expect(query.isConnected).toBe(true);

    expect(seen).toEqual(['disconnected', 2, 'reconnected']);
  });

  it('should dispatch terminal errors and go silent after close', async () => {
    const { subscription, closes } = trackedSubscription();
    const query = new MessagesLiveQuery();
    query.attachSubscription(subscription);

    const seen: string[] = [];
    query.on('event', (delivered): void => { seen.push(`event:${delivered.descriptor.recordId}`); });
    query.on('error', (error): void => { seen.push(`error:${error.code}`); });
    await Promise.resolve();

    query.handleError({ code: 'GrantAuthorizationGrantRevoked', detail: 'revoked' });
    expect(query.isConnected).toBe(false);
    expect(seen).toEqual(['error:GrantAuthorizationGrantRevoked']);

    await query.close();
    expect(closes()).toBe(1);

    // Closed queries drop everything and close() stays idempotent.
    query.handleEvent(change('late'));
    query.handleLifecycleEvent('eose');
    query.handleError({ code: 'Late', detail: 'late' });
    await query.close();

    expect(seen).toEqual(['error:GrantAuthorizationGrantRevoked']);
    expect(closes()).toBe(1);
  });
});
