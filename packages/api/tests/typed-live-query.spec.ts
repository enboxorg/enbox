import { describe, expect, it } from 'bun:test';

import { TypedLiveQuery } from '../src/typed-live-query.js';

/**
 * Creates a minimal mock Record for testing TypedLiveQuery record wrapping.
 */
function createMockRecord(id: string): any {
  return {
    id,
    data: { json: async (): Promise<any> => ({ id }) },
  };
}

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

    it('should forward terminal error event', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery(mock);
      const error = {
        code   : 'MessagesSubscribeDeliveryAuthorizationFailed',
        detail : 'subscription grant is no longer valid',
      };
      let received: typeof error | undefined;

      typed.on('error', (event) => { received = event as typeof error; });

      mock._emit('error', error);

      expect(received).toEqual(error);
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

    it('should return unsubscribe function for reconnected event', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery(mock);

      let callCount = 0;
      const unsub = typed.on('reconnected', () => { callCount++; });

      mock._emit('reconnected');
      expect(callCount).toBe(1);

      unsub();
      mock._emit('reconnected');
      expect(callCount).toBe(1);
    });

    it('should return unsubscribe function for eose event', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery(mock);

      let callCount = 0;
      const unsub = typed.on('eose', () => { callCount++; });

      mock._emit('eose');
      expect(callCount).toBe(1);

      unsub();
      mock._emit('eose');
      expect(callCount).toBe(1);
    });

    it('should return unsubscribe function for reconnecting event', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery(mock);

      let callCount = 0;
      const unsub = typed.on('reconnecting', () => { callCount++; });

      mock._emit('reconnecting', { attempt: 1 });
      expect(callCount).toBe(1);

      unsub();
      mock._emit('reconnecting', { attempt: 2 });
      expect(callCount).toBe(1);
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

  describe('records', () => {
    it('should wrap underlying records as TypedRecord instances', () => {
      const mockRecords = [createMockRecord('rec-1'), createMockRecord('rec-2')];
      const mock = createMockLiveQuery({ records: mockRecords });
      const typed = new TypedLiveQuery<{ id: string }>(mock);

      const records = typed.records;
      expect(records).toHaveLength(2);
      // TypedRecord wraps the underlying Record; the original record is accessible.
      expect(records[0]).toBeDefined();
      expect(records[1]).toBeDefined();
    });

    it('should cache typed records on subsequent accesses', () => {
      const mockRecords = [createMockRecord('rec-1')];
      const mock = createMockLiveQuery({ records: mockRecords });
      const typed = new TypedLiveQuery<{ id: string }>(mock);

      const first = typed.records;
      const second = typed.records;
      expect(first).toBe(second); // Same array reference.
    });

    it('should return empty array when no records', () => {
      const mock = createMockLiveQuery({ records: [] });
      const typed = new TypedLiveQuery<{ id: string }>(mock);

      expect(typed.records).toHaveLength(0);
    });
  });

  describe('cursor', () => {
    it('should delegate to underlying LiveQuery cursor', () => {
      const mockCursor = { messageCid: 'cid-abc', value: '2024-01-01' };
      const mock = createMockLiveQuery({ cursor: mockCursor });
      const typed = new TypedLiveQuery(mock);

      expect(typed.cursor).toBe(mockCursor);
    });

    it('should return undefined when no cursor', () => {
      const mock = createMockLiveQuery({ cursor: undefined });
      const typed = new TypedLiveQuery(mock);

      expect(typed.cursor).toBeUndefined();
    });
  });

  describe('rawLiveQuery', () => {
    it('should return the underlying LiveQuery instance', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery(mock);

      expect(typed.rawLiveQuery).toBe(mock);
    });
  });

  describe('record change events', () => {
    it('should wrap change event records as TypedRecord', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery<{ id: string }>(mock);

      let receivedChange: any;
      typed.on('change', (change) => { receivedChange = change; });

      const mockRecord = createMockRecord('change-rec');
      mock._emit('change', { type: 'create', record: mockRecord });

      expect(receivedChange).toBeDefined();
      expect(receivedChange.type).toBe('create');
      // The record should be wrapped in a TypedRecord.
      expect(receivedChange.record).toBeDefined();
    });

    it('should wrap create event records as TypedRecord', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery<{ id: string }>(mock);

      let receivedRecord: any;
      typed.on('create', (record) => { receivedRecord = record; });

      const mockRecord = createMockRecord('create-rec');
      mock._emit('create', mockRecord);

      expect(receivedRecord).toBeDefined();
    });

    it('should wrap update event records as TypedRecord', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery<{ id: string }>(mock);

      let receivedRecord: any;
      typed.on('update', (record) => { receivedRecord = record; });

      const mockRecord = createMockRecord('update-rec');
      mock._emit('update', mockRecord);

      expect(receivedRecord).toBeDefined();
    });

    it('should wrap delete event records as TypedRecord', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery<{ id: string }>(mock);

      let receivedRecord: any;
      typed.on('delete', (record) => { receivedRecord = record; });

      const mockRecord = createMockRecord('delete-rec');
      mock._emit('delete', mockRecord);

      expect(receivedRecord).toBeDefined();
    });

    it('should return unsubscribe function for change event', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery<{ id: string }>(mock);

      let callCount = 0;
      const unsub = typed.on('change', () => { callCount++; });

      mock._emit('change', { type: 'create', record: createMockRecord('r') });
      expect(callCount).toBe(1);

      unsub();
      mock._emit('change', { type: 'create', record: createMockRecord('r') });
      expect(callCount).toBe(1);
    });

    it('should return unsubscribe function for create event', () => {
      const mock = createMockLiveQuery();
      const typed = new TypedLiveQuery<{ id: string }>(mock);

      let callCount = 0;
      const unsub = typed.on('create', () => { callCount++; });

      mock._emit('create', createMockRecord('r'));
      expect(callCount).toBe(1);

      unsub();
      mock._emit('create', createMockRecord('r'));
      expect(callCount).toBe(1);
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
