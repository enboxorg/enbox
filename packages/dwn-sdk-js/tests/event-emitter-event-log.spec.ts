import type { SubscriptionMessage } from '../src/types/subscriptions.js';

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { EventEmitterEventLog } from '../src/event-stream/event-emitter-event-log.js';

describe('EventEmitterEventLog', () => {
  let eventLog: EventEmitterEventLog;

  beforeEach(async () => {
    eventLog = new EventEmitterEventLog();
    await eventLog.open();
  });

  afterAll(async () => {
    await eventLog.close();
  });

  describe('emit()', () => {
    it('should return opaque cursor strings', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const cursor1 = await eventLog.emit(tenant, event, { key: 'val1' });
      const cursor2 = await eventLog.emit(tenant, event, { key: 'val2' });
      const cursor3 = await eventLog.emit(tenant, event, { key: 'val3' });

      // Cursors are strings and should be different for each event.
      expect(typeof cursor1).toBe('string');
      expect(typeof cursor2).toBe('string');
      expect(cursor1).not.toBe(cursor2);
      expect(cursor2).not.toBe(cursor3);
    });

    it('should maintain independent cursors per tenant', async () => {
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const cursorAlice = await eventLog.emit('did:example:alice', event, {});
      const cursorBob = await eventLog.emit('did:example:bob', event, {});

      // Both are valid cursor strings (first event for each tenant).
      expect(typeof cursorAlice).toBe('string');
      expect(typeof cursorBob).toBe('string');
      expect(cursorAlice.length).toBeGreaterThan(0);
      expect(cursorBob.length).toBeGreaterThan(0);
    });

    it('should return empty string when EventLog is closed', async () => {
      await eventLog.close();

      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };
      const cursor = await eventLog.emit('did:example:alice', event, {});

      expect(cursor).toBe('');

      // reopen for afterAll cleanup
      await eventLog.open();
    });
  });

  describe('read()', () => {
    it('should read all events for a tenant when no cursor is provided', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, { schema: 'http://a' });
      await eventLog.emit(tenant, event, { schema: 'http://b' });

      const result = await eventLog.read(tenant);
      expect(result.events.length).toBe(2);
      expect(result.cursor).toBeDefined();
    });

    it('should read events after a cursor', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, { schema: 'http://a' });
      const cursor2 = await eventLog.emit(tenant, event, { schema: 'http://b' });
      await eventLog.emit(tenant, event, { schema: 'http://c' });

      // Read after cursor2 — should only get the third event.
      const result = await eventLog.read(tenant, { cursor: cursor2 });
      expect(result.events.length).toBe(1);
      expect(result.cursor).toBeDefined();
    });

    it('should apply filters during read', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, { schema: 'http://match' });
      await eventLog.emit(tenant, event, { schema: 'http://other' });
      await eventLog.emit(tenant, event, { schema: 'http://match' });

      const result = await eventLog.read(tenant, { filters: [{ schema: 'http://match' }] });
      expect(result.events.length).toBe(2);
    });

    it('should return undefined cursor for unknown tenant', async () => {
      const result = await eventLog.read('did:example:unknown');
      expect(result.events.length).toBe(0);
      expect(result.cursor).toBeUndefined();
    });

    it('should return the input cursor when no new events match', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const lastCursor = await eventLog.emit(tenant, event, {});

      // Read after the last event — nothing new.
      const result = await eventLog.read(tenant, { cursor: lastCursor });
      expect(result.events.length).toBe(0);
      expect(result.cursor).toBe(lastCursor);
    });

    it('should respect the limit option', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, {});
      await eventLog.emit(tenant, event, {});
      await eventLog.emit(tenant, event, {});

      const result = await eventLog.read(tenant, { limit: 2 });
      expect(result.events.length).toBe(2);
      expect(result.cursor).toBeDefined();
    });
  });

  describe('subscribe() — live only (no cursor)', () => {
    it('should deliver live events to subscriber with cursor strings', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); });

      await eventLog.emit(tenant, event, {});
      await eventLog.emit(tenant, event, {});

      expect(received.length).toBe(2);
      expect(received[0].type).toBe('event');
      expect(received[1].type).toBe('event');
      if (received[0].type === 'event') {
        expect(typeof received[0].cursor).toBe('string');
        expect(received[0].cursor.length).toBeGreaterThan(0);
      }
    });

    it('should NOT deliver EOSE when no cursor is provided', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit some events before subscribing.
      await eventLog.emit(tenant, event, {});

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); });

      // Emit after subscribing.
      await eventLog.emit(tenant, event, {});

      // Should only have the live event, no EOSE.
      expect(received.length).toBe(1);
      expect(received[0].type).toBe('event');
    });

    it('should filter live events', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, {
        filters: [{ schema: 'http://match' }],
      });

      await eventLog.emit(tenant, event, { schema: 'http://match' });
      await eventLog.emit(tenant, event, { schema: 'http://other' });
      await eventLog.emit(tenant, event, { schema: 'http://match' });

      expect(received.length).toBe(2);
    });

    it('should stop delivering events after close', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const received: SubscriptionMessage[] = [];
      const sub = await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); });

      await eventLog.emit(tenant, event, {});
      expect(received.length).toBe(1);

      await sub.close();

      await eventLog.emit(tenant, event, {});
      expect(received.length).toBe(1); // no new events after close
    });
  });

  describe('subscribe() — cursor mode (catch-up + EOSE + live)', () => {
    it('should replay stored events after cursor and deliver EOSE', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit 3 events, capture the first cursor.
      const cursor1 = await eventLog.emit(tenant, event, { idx: '1' });
      await eventLog.emit(tenant, event, { idx: '2' });
      await eventLog.emit(tenant, event, { idx: '3' });

      // Subscribe with cursor from first event — should replay events 2 and 3.
      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, { cursor: cursor1 });

      // Should receive 2 catch-up events + EOSE.
      expect(received.length).toBe(3);
      expect(received[0].type).toBe('event');
      expect(received[1].type).toBe('event');
      expect(received[2].type).toBe('eose');

      // Cursors should be opaque strings, each different.
      if (received[0].type === 'event' && received[1].type === 'event') {
        expect(received[0].cursor).not.toBe(received[1].cursor);
      }
    });

    it('should deliver EOSE echoing the input cursor when already caught up', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit events and capture last cursor.
      await eventLog.emit(tenant, event, {});
      const lastCursor = await eventLog.emit(tenant, event, {});

      // Subscribe with the last cursor — already caught up, no stored events to replay.
      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, { cursor: lastCursor });

      // Should just get EOSE echoing the input cursor.
      expect(received.length).toBe(1);
      expect(received[0].type).toBe('eose');
      if (received[0].type === 'eose') { expect(received[0].cursor).toBe(lastCursor); }
    });

    it('should continue delivering live events after EOSE', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit 1 event and capture its cursor.
      const cursor1 = await eventLog.emit(tenant, event, { idx: '1' });

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, { cursor: cursor1 });

      // Already caught up — should have just EOSE.
      expect(received.length).toBe(1);
      expect(received[0].type).toBe('eose');

      // Now emit a live event.
      await eventLog.emit(tenant, event, { idx: '2' });

      // Should now have the live event appended.
      expect(received.length).toBe(2);
      expect(received[1].type).toBe('event');
      if (received[1].type === 'event') {
        expect(typeof received[1].cursor).toBe('string');
      }
    });

    it('should apply filters to both catch-up and live events', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit events with different schemas, capture cursor before the batch.
      const cursorBefore = await eventLog.emit(tenant, event, { schema: 'http://before' });
      await eventLog.emit(tenant, event, { schema: 'http://match' });
      await eventLog.emit(tenant, event, { schema: 'http://other' });
      await eventLog.emit(tenant, event, { schema: 'http://match' });

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, {
        cursor  : cursorBefore,
        filters : [{ schema: 'http://match' }],
      });

      // Catch-up: 2 matching events + EOSE. (Event with 'http://other' filtered out.)
      expect(received.length).toBe(3);
      expect(received[0].type).toBe('event');
      expect(received[1].type).toBe('event');
      expect(received[2].type).toBe('eose');

      // Emit live events — only matching ones should arrive.
      await eventLog.emit(tenant, event, { schema: 'http://other' });
      await eventLog.emit(tenant, event, { schema: 'http://match' });

      expect(received.length).toBe(4); // +1 matching live event
    });

    it('should deduplicate live events that arrived during catch-up', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit 2 events, capture cursor before them.
      const cursorBefore = await eventLog.emit(tenant, event, { idx: '0' });
      await eventLog.emit(tenant, event, { idx: '1' });
      await eventLog.emit(tenant, event, { idx: '2' });

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, { cursor: cursorBefore });

      // 2 catch-up events + EOSE.
      expect(received.length).toBe(3);

      // Verify no duplicate cursors.
      const eventCursors = received.filter(m => m.type === 'event').map(m => m.cursor);
      const uniqueCursors = new Set(eventCursors);
      expect(uniqueCursors.size).toBe(eventCursors.length);
    });

    it('should isolate subscriptions between tenants in cursor mode', async () => {
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit for alice, capture first cursor.
      const aliceCursor1 = await eventLog.emit('did:example:alice', event, {});
      await eventLog.emit('did:example:alice', event, {});

      // Emit for bob.
      await eventLog.emit('did:example:bob', event, {});

      // Subscribe to alice with cursor — should only get alice's second event.
      const aliceReceived: SubscriptionMessage[] = [];
      await eventLog.subscribe('did:example:alice', 'sub-alice', (msg) => { aliceReceived.push(msg); }, { cursor: aliceCursor1 });

      // Should only get alice's 1 catch-up event + EOSE.
      expect(aliceReceived.length).toBe(2);
      expect(aliceReceived[0].type).toBe('event');
      expect(aliceReceived[1].type).toBe('eose');
    });
  });

  describe('trim()', () => {
    it('should trim events by sequence number', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, {});
      await eventLog.emit(tenant, event, {});
      await eventLog.emit(tenant, event, {});

      await eventLog.trim(tenant, 3); // trim events with seq < 3

      const result = await eventLog.read(tenant);
      expect(result.events.length).toBe(1);
      expect(result.events[0].seq).toBe(3);
    });

    it('should trim events by ISO-8601 timestamp', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const oldTime = '2020-01-01T00:00:00.000000Z';
      const newTime = '2025-01-01T00:00:00.000000Z';

      await eventLog.emit(tenant, event, { messageTimestamp: oldTime });
      await eventLog.emit(tenant, event, { messageTimestamp: newTime });

      await eventLog.trim(tenant, '2023-01-01T00:00:00.000000Z');

      const result = await eventLog.read(tenant);
      expect(result.events.length).toBe(1);
    });
  });

  describe('maxEventsPerTenant eviction', () => {
    it('should evict oldest events when limit is exceeded', async () => {
      const smallLog = new EventEmitterEventLog({ maxEventsPerTenant: 3 });
      await smallLog.open();

      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await smallLog.emit(tenant, event, { idx: '1' });
      await smallLog.emit(tenant, event, { idx: '2' });
      await smallLog.emit(tenant, event, { idx: '3' });
      await smallLog.emit(tenant, event, { idx: '4' }); // should evict seq=1

      const result = await smallLog.read(tenant);
      expect(result.events.length).toBe(3);
      expect(result.events[0].seq).toBe(2); // seq=1 was evicted
      expect(result.events[2].seq).toBe(4);

      await smallLog.close();
    });
  });
});
