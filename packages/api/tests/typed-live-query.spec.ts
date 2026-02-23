import { describe, expect, it } from 'bun:test';

import { TypedLiveQuery } from '../src/typed-live-query.js';

/**
 * Creates a minimal mock LiveQuery for testing TypedLiveQuery delegation.
 */
function createMockLiveQuery(overrides?: Partial<any>): any {
  const listeners = new Map<string, Function[]>();
  return {
    records     : [],
    cursor      : undefined,
    isConnected : true,

    on(event: string, handler: Function): () => void {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event)!.push(handler);
      return (): void => {
        const handlers = listeners.get(event);
        if (handlers) {
          const idx = handlers.indexOf(handler);
          if (idx >= 0) { handlers.splice(idx, 1); }
        }
      };
    },

    close: async (): Promise<void> => {},

    // Test helper: simulate an event.
    _emit(event: string, ...args: any[]): void {
      for (const handler of (listeners.get(event) ?? [])) {
        handler(...args);
      }
    },

    ...overrides,
  };
}

describe('TypedLiveQuery', () => {
  describe('lifecycle events', () => {
    it('should forward disconnected event', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery(mock);

      let disconnectedCalled = false;
      typed.on('disconnected', () => { disconnectedCalled = true; });

      mock._emit('disconnected');
      expect(disconnectedCalled).toBe(true);
    });

    it('should forward reconnected event', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery(mock);

      let reconnectedCalled = false;
      typed.on('reconnected', () => { reconnectedCalled = true; });

      mock._emit('reconnected');
      expect(reconnectedCalled).toBe(true);
    });

    it('should forward reconnecting event with attempt number', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery(mock);

      let receivedDetail: { attempt: number } | undefined;
      typed.on('reconnecting', (detail) => { receivedDetail = detail; });

      mock._emit('reconnecting', { attempt: 3 });
      expect(receivedDetail).toBeDefined();
      expect(receivedDetail!.attempt).toBe(3);
    });

    it('should forward eose event', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery(mock);

      let eoseCalled = false;
      typed.on('eose', () => { eoseCalled = true; });

      mock._emit('eose');
      expect(eoseCalled).toBe(true);
    });

    it('should return unsubscribe function for lifecycle events', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery(mock);

      let callCount = 0;
      const unsub = typed.on('disconnected', () => { callCount++; });

      mock._emit('disconnected');
      expect(callCount).toBe(1);

      unsub();
      mock._emit('disconnected');
      expect(callCount).toBe(1); // Should not increment after unsub.
    });
  });

  describe('isConnected', () => {
    it('should delegate to underlying LiveQuery', () => {
      const mock = createMockLiveQuery({ isConnected: true });
      const typed = new TypedLiveQuery(mock);
      expect(typed.isConnected).toBe(true);
    });

    it('should reflect disconnected state', () => {
      const mock = createMockLiveQuery({ isConnected: false });
      const typed = new TypedLiveQuery(mock);
      expect(typed.isConnected).toBe(false);
    });
  });

  describe('close', () => {
    it('should delegate to underlying LiveQuery', async () => {
      let closed = false;
      const mock = createMockLiveQuery({
        close: async (): Promise<void> => { closed = true; },
      });
      const typed = new TypedLiveQuery(mock);

      await typed.close();
      expect(closed).toBe(true);
    });
  });
});
