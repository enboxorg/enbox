import { describe, expect, test } from 'bun:test';

import { AuthEventEmitter } from '../src/events.js';

describe('AuthEventEmitter', () => {
  test('on() subscribes and receives events', () => {
    const emitter = new AuthEventEmitter();
    const received: Array<{ previous: string; current: string }> = [];

    emitter.on('state-change', (payload) => {
      received.push(payload);
    });

    emitter.emit('state-change', { previous: 'uninitialized', current: 'locked' });
    emitter.emit('state-change', { previous: 'locked', current: 'connected' });

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ previous: 'uninitialized', current: 'locked' });
    expect(received[1]).toEqual({ previous: 'locked', current: 'connected' });
  });

  test('on() returns an unsubscribe function', () => {
    const emitter = new AuthEventEmitter();
    let callCount = 0;

    const unsub = emitter.on('vault-locked', () => {
      callCount++;
    });

    emitter.emit('vault-locked', {});
    expect(callCount).toBe(1);

    unsub();

    emitter.emit('vault-locked', {});
    expect(callCount).toBe(1); // not called again
  });

  test('multiple listeners for the same event', () => {
    const emitter = new AuthEventEmitter();
    const calls: string[] = [];

    emitter.on('session-start', () => calls.push('a'));
    emitter.on('session-start', () => calls.push('b'));

    const signal = new AbortController().signal;
    emitter.emit('session-start', {
      session: {
        did      : 'did:example:test',
        identity : { didUri: 'did:example:test', name: 'Test' },
        signal,
      },
    });

    expect(calls).toEqual(['a', 'b']);
  });

  test('different events are independent', () => {
    const emitter = new AuthEventEmitter();
    let lockCount = 0;
    let unlockCount = 0;

    emitter.on('vault-locked', () => lockCount++);
    emitter.on('vault-unlocked', () => unlockCount++);

    emitter.emit('vault-locked', {});
    emitter.emit('vault-locked', {});
    emitter.emit('vault-unlocked', {});

    expect(lockCount).toBe(2);
    expect(unlockCount).toBe(1);
  });

  test('handler errors do not break other handlers', () => {
    const emitter = new AuthEventEmitter();
    const calls: string[] = [];

    emitter.on('vault-unlocked', () => {
      throw new Error('handler error');
    });
    emitter.on('vault-unlocked', () => calls.push('after-error'));

    // Should not throw
    emitter.emit('vault-unlocked', {});
    expect(calls).toEqual(['after-error']);
  });

  test('removeAllListeners() clears everything', () => {
    const emitter = new AuthEventEmitter();
    let called = false;

    emitter.on('state-change', () => { called = true; });
    emitter.removeAllListeners();

    emitter.emit('state-change', { previous: 'locked', current: 'unlocked' });
    expect(called).toBe(false);
  });

  test('emitting with no listeners is a no-op', () => {
    const emitter = new AuthEventEmitter();
    // Should not throw
    emitter.emit('vault-locked', {});
  });
});
