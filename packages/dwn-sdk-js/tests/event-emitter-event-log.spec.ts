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
    it('should assign monotonically increasing sequence numbers per tenant', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const seq1 = await eventLog.emit(tenant, event, { key: 'val1' });
      const seq2 = await eventLog.emit(tenant, event, { key: 'val2' });
      const seq3 = await eventLog.emit(tenant, event, { key: 'val3' });

      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(seq3).toBe(3);
    });

    it('should maintain independent sequence counters per tenant', async () => {
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const seqAlice = await eventLog.emit('did:example:alice', event, {});
      const seqBob = await eventLog.emit('did:example:bob', event, {});

      expect(seqAlice).toBe(1);
      expect(seqBob).toBe(1);
    });

    it('should return -1 when EventLog is closed', async () => {
      await eventLog.close();

      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };
      const seq = await eventLog.emit('did:example:alice', event, {});

      expect(seq).toBe(-1);

      // reopen for afterAll cleanup
      await eventLog.open();
    });
  });

  describe('read()', () => {
    it('should read all events for a tenant', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, { schema: 'http://a' });
      await eventLog.emit(tenant, event, { schema: 'http://b' });

      const result = await eventLog.read(tenant);
      expect(result.events.length).toBe(2);
      expect(result.events[0].seq).toBe(1);
      expect(result.events[1].seq).toBe(2);
      expect(result.cursor).toBe(2);
    });

    it('should read events after a cursor', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, { schema: 'http://a' });
      await eventLog.emit(tenant, event, { schema: 'http://b' });
      await eventLog.emit(tenant, event, { schema: 'http://c' });

      const result = await eventLog.read(tenant, { cursor: 2 });
      expect(result.events.length).toBe(1);
      expect(result.events[0].seq).toBe(3);
      expect(result.cursor).toBe(3);
    });

    it('should apply filters during read', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, { schema: 'http://match' });
      await eventLog.emit(tenant, event, { schema: 'http://other' });
      await eventLog.emit(tenant, event, { schema: 'http://match' });

      const result = await eventLog.read(tenant, { filters: [{ schema: 'http://match' }] });
      expect(result.events.length).toBe(2);
      expect(result.events[0].seq).toBe(1);
      expect(result.events[1].seq).toBe(3);
    });

    it('should return empty result for unknown tenant', async () => {
      const result = await eventLog.read('did:example:unknown');
      expect(result.events.length).toBe(0);
      expect(result.cursor).toBe(-1);
    });

    it('should respect the limit option', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, {});
      await eventLog.emit(tenant, event, {});
      await eventLog.emit(tenant, event, {});

      const result = await eventLog.read(tenant, { limit: 2 });
      expect(result.events.length).toBe(2);
      expect(result.cursor).toBe(2);
    });
  });

  describe('subscribe() — live only (no cursor)', () => {
    it('should deliver live events to subscriber', async () => {
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
        expect(received[0].seq).toBe(1);
      }
      if (received[1].type === 'event') {
        expect(received[1].seq).toBe(2);
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
    it('should replay stored events from cursor and deliver EOSE', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit 3 events before subscribing.
      await eventLog.emit(tenant, event, { idx: '1' });
      await eventLog.emit(tenant, event, { idx: '2' });
      await eventLog.emit(tenant, event, { idx: '3' });

      // Subscribe with cursor=0 to replay all.
      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, { cursor: 0 });

      // Should receive 3 catch-up events + EOSE.
      expect(received.length).toBe(4);
      expect(received[0].type).toBe('event');
      expect(received[1].type).toBe('event');
      expect(received[2].type).toBe('event');
      expect(received[3].type).toBe('eose');

      if (received[0].type === 'event') { expect(received[0].seq).toBe(1); }
      if (received[1].type === 'event') { expect(received[1].seq).toBe(2); }
      if (received[2].type === 'event') { expect(received[2].seq).toBe(3); }
      if (received[3].type === 'eose') { expect(received[3].seq).toBe(3); }
    });

    it('should replay only events after the given cursor', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, {});
      await eventLog.emit(tenant, event, {});
      await eventLog.emit(tenant, event, {});

      // Subscribe with cursor=2 — should only replay event with seq=3.
      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, { cursor: 2 });

      expect(received.length).toBe(2); // 1 event + EOSE
      expect(received[0].type).toBe('event');
      expect(received[1].type).toBe('eose');

      if (received[0].type === 'event') { expect(received[0].seq).toBe(3); }
      if (received[1].type === 'eose') { expect(received[1].seq).toBe(3); }
    });

    it('should deliver EOSE with the cursor value when no stored events match', async () => {
      const tenant = 'did:example:alice';

      // No events emitted. Subscribe with cursor=0.
      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, { cursor: 0 });

      // Should just get EOSE. The seq is the `read()` result cursor, which is
      // the original cursor value (0) when no events were returned.
      expect(received.length).toBe(1);
      expect(received[0].type).toBe('eose');
      if (received[0].type === 'eose') { expect(received[0].seq).toBe(0); }
    });

    it('should continue delivering live events after EOSE', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit 1 event before subscribing.
      await eventLog.emit(tenant, event, { idx: '1' });

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, { cursor: 0 });

      // Should have: 1 catch-up event + EOSE.
      expect(received.length).toBe(2);
      expect(received[0].type).toBe('event');
      expect(received[1].type).toBe('eose');

      // Now emit a live event.
      await eventLog.emit(tenant, event, { idx: '2' });

      // Should now have the live event appended.
      expect(received.length).toBe(3);
      expect(received[2].type).toBe('event');
      if (received[2].type === 'event') { expect(received[2].seq).toBe(2); }
    });

    it('should apply filters to both catch-up and live events', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit events with different schemas.
      await eventLog.emit(tenant, event, { schema: 'http://match' });
      await eventLog.emit(tenant, event, { schema: 'http://other' });
      await eventLog.emit(tenant, event, { schema: 'http://match' });

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, {
        cursor  : 0,
        filters : [{ schema: 'http://match' }],
      });

      // Catch-up: 2 matching events + EOSE. (Event at seq=2 filtered out.)
      expect(received.length).toBe(3);
      expect(received[0].type).toBe('event');
      expect(received[1].type).toBe('event');
      expect(received[2].type).toBe('eose');

      if (received[0].type === 'event') { expect(received[0].seq).toBe(1); }
      if (received[1].type === 'event') { expect(received[1].seq).toBe(3); }

      // Emit live events — only matching ones should arrive.
      await eventLog.emit(tenant, event, { schema: 'http://other' });
      await eventLog.emit(tenant, event, { schema: 'http://match' });

      expect(received.length).toBe(4); // +1 matching live event
      if (received[3].type === 'event') { expect(received[3].seq).toBe(5); }
    });

    it('should deduplicate live events that arrived during catch-up', async () => {
      // This test verifies the buffering + dedup behavior.
      // We need to simulate a live event arriving while stored events are being read.
      // Since EventEmitterEventLog.subscribe is synchronous in-memory, the only way
      // to get overlap is if emit() is called between registering the mitt handler and
      // the read() call completing. In the current sync implementation, this can't
      // naturally happen, so we verify the invariant that no duplicate seq appears.

      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit 2 events.
      await eventLog.emit(tenant, event, { idx: '1' });
      await eventLog.emit(tenant, event, { idx: '2' });

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, { cursor: 0 });

      // 2 catch-up events + EOSE.
      expect(received.length).toBe(3);

      // Verify no duplicate seqs.
      const eventSeqs = received.filter(m => m.type === 'event').map(m => m.seq);
      const uniqueSeqs = new Set(eventSeqs);
      expect(uniqueSeqs.size).toBe(eventSeqs.length);
    });

    it('should isolate subscriptions between tenants in cursor mode', async () => {
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit for alice.
      await eventLog.emit('did:example:alice', event, {});
      await eventLog.emit('did:example:alice', event, {});

      // Emit for bob.
      await eventLog.emit('did:example:bob', event, {});

      // Subscribe to alice with cursor.
      const aliceReceived: SubscriptionMessage[] = [];
      await eventLog.subscribe('did:example:alice', 'sub-alice', (msg) => { aliceReceived.push(msg); }, { cursor: 0 });

      // Should only get alice's 2 events + EOSE.
      expect(aliceReceived.length).toBe(3);
      expect(aliceReceived[0].type).toBe('event');
      expect(aliceReceived[1].type).toBe('event');
      expect(aliceReceived[2].type).toBe('eose');
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
