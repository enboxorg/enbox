import type { Wake } from '../src/types/subscriptions.js';

import { describe, expect, it } from 'bun:test';

import { BroadcastChannelWakePublisher } from '../src/event-stream/broadcast-channel-wake-publisher.js';

/** Wait until `predicate` holds or `timeoutMs` elapses (channel delivery is async). */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return true;
}

describe('BroadcastChannelWakePublisher', () => {
  it('should deliver wakes to in-process subscribers synchronously', () => {
    const publisher = new BroadcastChannelWakePublisher('bcwp-local');
    const wakes: Wake[] = [];

    publisher.subscribe((wake): void => { wakes.push(wake); });
    publisher.publish({ tenant: 'did:test:alice', seq: '1' });

    expect(wakes).toEqual([{ tenant: 'did:test:alice', seq: '1' }]);
    publisher.close();
  });

  it('should mirror wakes to another context on the same channel without echoing back', async () => {
    const contextA = new BroadcastChannelWakePublisher('bcwp-shared');
    const contextB = new BroadcastChannelWakePublisher('bcwp-shared');
    const wakesOnA: Wake[] = [];
    const wakesOnB: Wake[] = [];

    contextA.subscribe((wake): void => { wakesOnA.push(wake); });
    contextB.subscribe((wake): void => { wakesOnB.push(wake); });

    contextA.publish({ tenant: 'did:test:alice', seq: '7' });

    expect(await waitFor(() => wakesOnB.length === 1)).toBe(true);
    expect(wakesOnB).toEqual([{ tenant: 'did:test:alice', seq: '7' }]);

    // The publishing context saw exactly its one direct delivery — the
    // channel mirror must not loop the wake back to it.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(wakesOnA).toEqual([{ tenant: 'did:test:alice', seq: '7' }]);

    contextA.close();
    contextB.close();
  });

  it('should not cross-wake distinct channel names', async () => {
    const storeOne = new BroadcastChannelWakePublisher('bcwp-store-one');
    const storeTwo = new BroadcastChannelWakePublisher('bcwp-store-two');
    const wakesOnTwo: Wake[] = [];

    storeTwo.subscribe((wake): void => { wakesOnTwo.push(wake); });
    storeOne.publish({ tenant: 'did:test:alice', seq: '1' });

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(wakesOnTwo).toEqual([]);

    storeOne.close();
    storeTwo.close();
  });

  it('should ignore non-wake traffic on the channel', async () => {
    const foreign = new BroadcastChannel('bcwp-mixed');
    const publisher = new BroadcastChannelWakePublisher('bcwp-mixed');
    const wakes: Wake[] = [];

    publisher.subscribe((wake): void => { wakes.push(wake); });
    foreign.postMessage({ unrelated: true });
    foreign.postMessage('not a wake');

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(wakes).toEqual([]);

    foreign.close();
    publisher.close();
  });

  it('should keep delivering in-process after close', () => {
    const publisher = new BroadcastChannelWakePublisher('bcwp-closed');
    const wakes: Wake[] = [];

    publisher.subscribe((wake): void => { wakes.push(wake); });
    publisher.close();

    expect((): void => {
      publisher.publish({ tenant: 'did:test:alice', seq: '1' });
    }).not.toThrow();
    expect(wakes).toEqual([{ tenant: 'did:test:alice', seq: '1' }]);
  });
});
