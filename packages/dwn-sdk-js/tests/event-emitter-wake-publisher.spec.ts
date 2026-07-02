import { describe, expect, it } from 'bun:test';

import { EventEmitterWakePublisher } from '../src/event-stream/event-emitter-wake-publisher.js';

describe('EventEmitterWakePublisher', () => {
  it('should publish wakes to subscribers', () => {
    const publisher = new EventEmitterWakePublisher();
    const wakes: unknown[] = [];

    publisher.subscribe((wake): void => { wakes.push(wake); });
    publisher.publish({ tenant: 'did:test:alice', seq: '1' });

    expect(wakes).toEqual([{ tenant: 'did:test:alice', seq: '1' }]);
  });

  it('should unsubscribe listeners', () => {
    const publisher = new EventEmitterWakePublisher();
    let calls = 0;

    const unsubscribe = publisher.subscribe((): void => { calls++; });
    unsubscribe();
    publisher.publish({ tenant: 'did:test:alice', seq: '1' });

    expect(calls).toBe(0);
  });

  it('should clear listeners', () => {
    const publisher = new EventEmitterWakePublisher();
    let calls = 0;

    publisher.subscribe((): void => { calls++; });
    publisher.clear();
    publisher.publish({ tenant: 'did:test:alice', seq: '1' });

    expect(calls).toBe(0);
  });

  it('should isolate listener failures', () => {
    const publisher = new EventEmitterWakePublisher();
    let calls = 0;

    publisher.subscribe((): void => { throw new Error('listener failed'); });
    publisher.subscribe((): void => { calls++; });

    expect((): void => {
      publisher.publish({ tenant: 'did:test:alice', seq: '1' });
    }).not.toThrow();
    expect(calls).toBe(1);
  });

  it('should publish to the current listener snapshot', () => {
    const publisher = new EventEmitterWakePublisher();
    const calls: string[] = [];
    let unsubscribeSecond = (): void => {};

    publisher.subscribe((): void => {
      calls.push('first');
      unsubscribeSecond();
    });
    unsubscribeSecond = publisher.subscribe((): void => { calls.push('second'); });

    publisher.publish({ tenant: 'did:test:alice', seq: '1' });
    publisher.publish({ tenant: 'did:test:alice', seq: '2' });

    expect(calls).toEqual(['first', 'second', 'first']);
  });
});
