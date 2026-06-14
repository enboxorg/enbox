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

  /** Helper to generate unique messageCids for testing. */
  function cid(n: number): string {
    return `bafy-test-cid-${n}`;
  }

  describe('emit()', () => {
    it('should return ProgressToken objects', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const token1 = await eventLog.emit(tenant, event, { key: 'val1' }, cid(1));
      const token2 = await eventLog.emit(tenant, event, { key: 'val2' }, cid(2));
      const token3 = await eventLog.emit(tenant, event, { key: 'val3' }, cid(3));

      // Tokens are ProgressToken objects and should be different for each event.
      expect(token1).toBeDefined();
      expect(token2).toBeDefined();
      expect(typeof token1!.streamId).toBe('string');
      expect(typeof token1!.epoch).toBe('string');
      expect(typeof token1!.position).toBe('string');
      expect(typeof token1!.messageCid).toBe('string');
      expect(token1!.messageCid).toBe(cid(1));
      expect(token1!.position).not.toBe(token2!.position);
      expect(token2!.position).not.toBe(token3!.position);
    });

    it('should maintain independent positions per tenant', async () => {
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const tokenAlice = await eventLog.emit('did:example:alice', event, {}, cid(1));
      const tokenBob = await eventLog.emit('did:example:bob', event, {}, cid(2));

      // Both are valid tokens (first event for each tenant).
      expect(tokenAlice).toBeDefined();
      expect(tokenBob).toBeDefined();
      // Same position (1) but different streamIds.
      expect(tokenAlice!.position).toBe(tokenBob!.position);
      expect(tokenAlice!.streamId).not.toBe(tokenBob!.streamId);
    });

    it('should return undefined when EventLog is closed', async () => {
      await eventLog.close();

      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };
      const token = await eventLog.emit('did:example:alice', event, {}, cid(1));

      expect(token).toBeUndefined();

      // reopen for afterAll cleanup
      await eventLog.open();
    });
  });

  describe('read()', () => {
    it('should read all events for a tenant when no cursor is provided', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, { schema: 'http://a' }, cid(1));
      await eventLog.emit(tenant, event, { schema: 'http://b' }, cid(2));

      const result = await eventLog.read(tenant);
      expect(result.events.length).toBe(2);
      expect(result.cursor).toBeDefined();
      expect(result.cursor!.position).toBe('2');
    });

    it('should read events after a cursor', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, { schema: 'http://a' }, cid(1));
      const cursor2 = await eventLog.emit(tenant, event, { schema: 'http://b' }, cid(2));
      await eventLog.emit(tenant, event, { schema: 'http://c' }, cid(3));

      // Read after cursor2 — should only get the third event.
      const result = await eventLog.read(tenant, { cursor: cursor2! });
      expect(result.events.length).toBe(1);
      expect(result.cursor).toBeDefined();
      expect(result.cursor!.position).toBe('3');
    });

    it('should apply filters during read', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, { schema: 'http://match' }, cid(1));
      await eventLog.emit(tenant, event, { schema: 'http://other' }, cid(2));
      await eventLog.emit(tenant, event, { schema: 'http://match' }, cid(3));

      const result = await eventLog.read(tenant, { filters: [{ schema: 'http://match' }] });
      expect(result.events.length).toBe(2);
    });

    it('should advance to a high-water cursor when filters skip tail events', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, { schema: 'http://match' }, cid(1));
      await eventLog.emit(tenant, event, { schema: 'http://other' }, cid(2));

      const result = await eventLog.read(tenant, { filters: [{ schema: 'http://match' }] });
      expect(result.events.length).toBe(1);
      expect(result.cursor?.position).toBe('2');
      expect(result.cursor?.messageCid).toBeUndefined();
      expect(result.drained).toBe(true);
    });

    it('should return undefined cursor for unknown tenant', async () => {
      const result = await eventLog.read('did:example:unknown');
      expect(result.events.length).toBe(0);
      expect(result.cursor).toBeUndefined();
    });

    it('should return the input cursor when no new events match', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const lastCursor = await eventLog.emit(tenant, event, {}, cid(1));

      // Read after the last event — nothing new.
      const result = await eventLog.read(tenant, { cursor: lastCursor! });
      expect(result.events.length).toBe(0);
      expect(result.cursor?.position).toBe(lastCursor!.position);
      expect(result.cursor?.messageCid).toBeUndefined();
    });

    it('should respect the limit option', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, {}, cid(1));
      await eventLog.emit(tenant, event, {}, cid(2));
      await eventLog.emit(tenant, event, {}, cid(3));

      const result = await eventLog.read(tenant, { limit: 2 });
      expect(result.events.length).toBe(2);
      expect(result.cursor).toBeDefined();
    });

    it('should not deliver events or advance the cursor when limit is zero', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const firstCursor = await eventLog.emit(tenant, event, {}, cid(1));
      await eventLog.emit(tenant, event, {}, cid(2));

      const withoutCursor = await eventLog.read(tenant, { limit: 0 });
      expect(withoutCursor.events.length).toBe(0);
      expect(withoutCursor.cursor).toBeUndefined();
      expect(withoutCursor.drained).toBe(false);

      const withCursor = await eventLog.read(tenant, { cursor: firstCursor!, limit: 0 });
      expect(withCursor.events.length).toBe(0);
      expect(withCursor.cursor).toBe(firstCursor);
      expect(withCursor.drained).toBe(false);
    });
  });

  describe('subscribe() — live only (no cursor)', () => {
    it('should deliver live events to subscriber with ProgressTokens', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); });

      await eventLog.emit(tenant, event, {}, cid(1));
      await eventLog.emit(tenant, event, {}, cid(2));

      // Allow async token construction to settle.
      await new Promise((r) => setTimeout(r, 10));

      expect(received.length).toBe(2);
      expect(received[0].type).toBe('event');
      expect(received[1].type).toBe('event');
      if (received[0].type === 'event') {
        expect(typeof received[0].cursor).toBe('object');
        expect(received[0].cursor.streamId.length).toBeGreaterThan(0);
      }
    });

    it('should NOT deliver EOSE when no cursor is provided', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit some events before subscribing.
      await eventLog.emit(tenant, event, {}, cid(1));

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); });

      // Emit after subscribing.
      await eventLog.emit(tenant, event, {}, cid(2));

      // Allow async token construction to settle.
      await new Promise((r) => setTimeout(r, 10));

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

      await eventLog.emit(tenant, event, { schema: 'http://match' }, cid(1));
      await eventLog.emit(tenant, event, { schema: 'http://other' }, cid(2));
      await eventLog.emit(tenant, event, { schema: 'http://match' }, cid(3));

      // Allow async token construction to settle.
      await new Promise((r) => setTimeout(r, 10));

      expect(received.length).toBe(2);
    });

    it('should stop delivering events after close', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const received: SubscriptionMessage[] = [];
      const sub = await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); });

      await eventLog.emit(tenant, event, {}, cid(1));
      await new Promise((r) => setTimeout(r, 10));
      expect(received.length).toBe(1);

      await sub.close();

      await eventLog.emit(tenant, event, {}, cid(2));
      await new Promise((r) => setTimeout(r, 10));
      expect(received.length).toBe(1); // no new events after close
    });
  });

  describe('subscribe() — cursor mode (catch-up + EOSE + live)', () => {
    it('should replay stored events after cursor and deliver EOSE', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit 3 events, capture the first cursor.
      const cursor1 = await eventLog.emit(tenant, event, { idx: '1' }, cid(1));
      await eventLog.emit(tenant, event, { idx: '2' }, cid(2));
      await eventLog.emit(tenant, event, { idx: '3' }, cid(3));

      // Subscribe with cursor from first event — should replay events 2 and 3.
      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, { cursor: cursor1! });

      // Should receive 2 catch-up events + EOSE.
      expect(received.length).toBe(3);
      expect(received[0].type).toBe('event');
      expect(received[1].type).toBe('event');
      expect(received[2].type).toBe('eose');

      // Tokens should be different between events.
      if (received[0].type === 'event' && received[1].type === 'event') {
        expect(received[0].cursor.position).not.toBe(received[1].cursor.position);
      }
    });

    it('should deliver EOSE echoing the input cursor when already caught up', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit events and capture last cursor.
      await eventLog.emit(tenant, event, {}, cid(1));
      const lastCursor = await eventLog.emit(tenant, event, {}, cid(2));

      // Subscribe with the last cursor — already caught up, no stored events to replay.
      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, { cursor: lastCursor! });

      // Should just get EOSE echoing the input cursor.
      expect(received.length).toBe(1);
      expect(received[0].type).toBe('eose');
      if (received[0].type === 'eose') {
        expect(received[0].cursor.position).toBe(lastCursor!.position);
        expect(received[0].cursor.messageCid).toBeUndefined();
      }
    });

    it('should continue delivering live events after EOSE', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit 1 event and capture its cursor.
      const cursor1 = await eventLog.emit(tenant, event, { idx: '1' }, cid(1));

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, { cursor: cursor1! });

      // Already caught up — should have just EOSE.
      expect(received.length).toBe(1);
      expect(received[0].type).toBe('eose');

      // Now emit a live event.
      await eventLog.emit(tenant, event, { idx: '2' }, cid(2));

      // Allow async token construction to settle.
      await new Promise((r) => setTimeout(r, 10));

      // Should now have the live event appended.
      expect(received.length).toBe(2);
      expect(received[1].type).toBe('event');
      if (received[1].type === 'event') {
        expect(typeof received[1].cursor).toBe('object');
      }
    });

    it('should apply filters to both catch-up and live events', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit events with different schemas, capture cursor before the batch.
      const cursorBefore = await eventLog.emit(tenant, event, { schema: 'http://before' }, cid(0));
      await eventLog.emit(tenant, event, { schema: 'http://match' }, cid(1));
      await eventLog.emit(tenant, event, { schema: 'http://other' }, cid(2));
      await eventLog.emit(tenant, event, { schema: 'http://match' }, cid(3));

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, {
        cursor  : cursorBefore!,
        filters : [{ schema: 'http://match' }],
      });

      // Catch-up: 2 matching events + EOSE. (Event with 'http://other' filtered out.)
      expect(received.length).toBe(3);
      expect(received[0].type).toBe('event');
      expect(received[1].type).toBe('event');
      expect(received[2].type).toBe('eose');

      // Emit live events — only matching ones should arrive.
      await eventLog.emit(tenant, event, { schema: 'http://other' }, cid(4));
      await eventLog.emit(tenant, event, { schema: 'http://match' }, cid(5));

      // Allow async token construction to settle.
      await new Promise((r) => setTimeout(r, 10));

      expect(received.length).toBe(4); // +1 matching live event
    });

    it('should deduplicate live events that arrived during catch-up', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit 2 events, capture cursor before them.
      const cursorBefore = await eventLog.emit(tenant, event, { idx: '0' }, cid(0));
      await eventLog.emit(tenant, event, { idx: '1' }, cid(1));
      await eventLog.emit(tenant, event, { idx: '2' }, cid(2));

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-1', (msg) => { received.push(msg); }, { cursor: cursorBefore! });

      // 2 catch-up events + EOSE.
      expect(received.length).toBe(3);

      // Verify no duplicate positions.
      const eventPositions = received
        .filter((m): m is SubscriptionMessage & { type: 'event' } => m.type === 'event')
        .map(m => m.cursor.position);
      const uniquePositions = new Set(eventPositions);
      expect(uniquePositions.size).toBe(eventPositions.length);
    });

    it('should isolate subscriptions between tenants in cursor mode', async () => {
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit for alice, capture first cursor.
      const aliceCursor1 = await eventLog.emit('did:example:alice', event, {}, cid(1));
      await eventLog.emit('did:example:alice', event, {}, cid(2));

      // Emit for bob.
      await eventLog.emit('did:example:bob', event, {}, cid(3));

      // Subscribe to alice with cursor — should only get alice's second event.
      const aliceReceived: SubscriptionMessage[] = [];
      await eventLog.subscribe('did:example:alice', 'sub-alice', (msg) => { aliceReceived.push(msg); }, { cursor: aliceCursor1! });

      // Should only get alice's 1 catch-up event + EOSE.
      expect(aliceReceived.length).toBe(2);
      expect(aliceReceived[0].type).toBe('event');
      expect(aliceReceived[1].type).toBe('eose');
    });
  });

  describe('getReplayBounds()', () => {
    it('should return undefined for a tenant with no events', async () => {
      const result = await eventLog.getReplayBounds('did:example:nobody');
      expect(result).toBeUndefined();
    });

    it('should return oldest and latest tokens', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, {}, cid(1));
      await eventLog.emit(tenant, event, {}, cid(2));
      await eventLog.emit(tenant, event, {}, cid(3));

      const bounds = await eventLog.getReplayBounds(tenant);
      expect(bounds).toBeDefined();
      expect(bounds!.oldest.position).toBe('1');
      expect(bounds!.oldest.messageCid).toBe(cid(1));
      expect(bounds!.latest.position).toBe('3');
      expect(bounds!.latest.messageCid).toBe(cid(3));
    });

    it('should reflect trimmed state', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, {}, cid(1));
      await eventLog.emit(tenant, event, {}, cid(2));
      await eventLog.emit(tenant, event, {}, cid(3));

      await eventLog.trim(tenant, 3); // trim seq < 3

      const bounds = await eventLog.getReplayBounds(tenant);
      expect(bounds).toBeDefined();
      expect(bounds!.oldest.position).toBe('3');
      expect(bounds!.latest.position).toBe('3');
    });
  });

  describe('ProgressGap detection', () => {
    it('should throw EventLogProgressGap with reason epoch_mismatch when epoch differs', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const token = await eventLog.emit(tenant, event, {}, cid(1));

      // Create a token with a different epoch.
      const staleToken = { ...token!, epoch: 'stale-epoch-from-previous-process' };

      await expect(eventLog.read(tenant, { cursor: staleToken }))
        .rejects.toThrow('epoch_mismatch');
    });

    it('should throw EventLogProgressGap with reason stream_mismatch when streamId differs', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const token = await eventLog.emit(tenant, event, {}, cid(1));

      // Create a token with a wrong streamId.
      const badToken = { ...token!, streamId: 'wrong-stream-id' };

      await expect(eventLog.read(tenant, { cursor: badToken }))
        .rejects.toThrow('stream_mismatch');
    });

    it('should throw EventLogProgressGap with reason token_too_new when position is beyond the head', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const token = await eventLog.emit(tenant, event, {}, cid(1));
      const futureToken = { ...token!, position: '2' };

      await expect(eventLog.read(tenant, { cursor: futureToken }))
        .rejects.toThrow('token_too_new');
    });

    it('should throw EventLogProgressGap with reason message_mismatch when cursor message CID differs', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const token = await eventLog.emit(tenant, event, {}, cid(1));
      const mismatchedToken = { ...token!, messageCid: cid(2) };

      await expect(eventLog.read(tenant, { cursor: mismatchedToken }))
        .rejects.toThrow('message_mismatch');
    });

    it('should resume from a cursor whose exact event was trimmed', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const firstToken = await eventLog.emit(tenant, event, {}, cid(1));
      const secondToken = await eventLog.emit(tenant, event, {}, cid(2));
      await eventLog.trim(tenant, Number(secondToken!.position));

      const result = await eventLog.read(tenant, { cursor: firstToken! });

      expect(result.events.map((entry) => entry.seq)).toEqual([secondToken!.position]);
      expect(result.events.map((entry) => entry.messageCid)).toEqual([cid(2)]);
      expect(result.drained).toBe(true);
    });

    it('should throw EventLogProgressGap with reason token_too_old when position is evicted', async () => {
      const smallLog = new EventEmitterEventLog({ maxEventsPerTenant: 2 });
      await smallLog.open();

      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit 4 events with maxEventsPerTenant=2 — seqs 1 and 2 evicted, only [3,4] remain.
      const firstToken = await smallLog.emit(tenant, event, {}, cid(1));
      await smallLog.emit(tenant, event, {}, cid(2));
      await smallLog.emit(tenant, event, {}, cid(3));
      await smallLog.emit(tenant, event, {}, cid(4));

      // firstToken has position='1', oldest is now seq=3.
      // Cursor 1 means "give me events after seq 1" — but seq 2 is gone. That's a gap.
      await expect(smallLog.read(tenant, { cursor: firstToken! }))
        .rejects.toThrow('token_too_old');

      await smallLog.close();
    });

    it('should include ProgressGapInfo metadata on the thrown error', async () => {
      const smallLog = new EventEmitterEventLog({ maxEventsPerTenant: 2 });
      await smallLog.open();

      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const firstToken = await smallLog.emit(tenant, event, {}, cid(1));
      await smallLog.emit(tenant, event, {}, cid(2));
      await smallLog.emit(tenant, event, {}, cid(3));
      await smallLog.emit(tenant, event, {}, cid(4)); // now only [3,4] remain

      try {
        await smallLog.read(tenant, { cursor: firstToken! });
        throw new Error('expected error');
      } catch (error: any) {
        expect(error.code).toBe('EventLogProgressGap');
        expect(error.gapInfo).toBeDefined();
        expect(error.gapInfo.requested).toEqual(firstToken);
        expect(error.gapInfo.oldestAvailable.position).toBe('3');
        expect(error.gapInfo.latestAvailable.position).toBe('4');
        expect(error.gapInfo.reason).toBe('token_too_old');
      }

      await smallLog.close();
    });

    it('should throw on subscribe() with stale cursor', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const token = await eventLog.emit(tenant, event, {}, cid(1));
      const staleToken = { ...token!, epoch: 'old-epoch' };

      await expect(
        eventLog.subscribe(tenant, 'sub-1', () => {}, { cursor: staleToken })
      ).rejects.toThrow('epoch_mismatch');
    });

    it('should accept a valid cursor without throwing', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const token1 = await eventLog.emit(tenant, event, {}, cid(1));
      await eventLog.emit(tenant, event, {}, cid(2));

      // Read with a valid cursor — should succeed without throwing.
      const result = await eventLog.read(tenant, { cursor: token1! });
      expect(result.events.length).toBe(1);
      expect(result.cursor!.position).toBe('2');
    });
  });

  describe('trim()', () => {
    it('should trim events by sequence number', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      await eventLog.emit(tenant, event, {}, cid(1));
      await eventLog.emit(tenant, event, {}, cid(2));
      await eventLog.emit(tenant, event, {}, cid(3));

      await eventLog.trim(tenant, 3); // trim events with seq < 3

      const result = await eventLog.read(tenant);
      expect(result.events.length).toBe(1);
      expect(result.events[0].seq).toBe('3');
    });

    it('should trim events by ISO-8601 timestamp', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const oldTime = '2020-01-01T00:00:00.000000Z';
      const newTime = '2025-01-01T00:00:00.000000Z';

      await eventLog.emit(tenant, event, { messageTimestamp: oldTime }, cid(1));
      await eventLog.emit(tenant, event, { messageTimestamp: newTime }, cid(2));

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

      await smallLog.emit(tenant, event, { idx: '1' }, cid(1));
      await smallLog.emit(tenant, event, { idx: '2' }, cid(2));
      await smallLog.emit(tenant, event, { idx: '3' }, cid(3));
      await smallLog.emit(tenant, event, { idx: '4' }, cid(4)); // should evict seq=1

      const result = await smallLog.read(tenant);
      expect(result.events.length).toBe(3);
      expect(result.events[0].seq).toBe('2'); // seq=1 was evicted
      expect(result.events[2].seq).toBe('4');

      await smallLog.close();
    });
  });

  describe('messageCid propagation', () => {
    it('should carry non-empty messageCid in live subscription tokens', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-cid', (msg) => { received.push(msg); });

      // Emit events — the live handler should receive tokens with the original messageCid.
      await eventLog.emit(tenant, event, {}, cid(1));
      await eventLog.emit(tenant, event, {}, cid(2));

      // Allow microtasks (tokenFromPayload is async).
      await new Promise((r) => setTimeout(r, 20));

      const events = received.filter((m): m is SubscriptionMessage & { type: 'event' } => m.type === 'event');
      expect(events.length).toBe(2);
      expect(events[0].cursor.messageCid).toBe(cid(1));
      expect(events[1].cursor.messageCid).toBe(cid(2));
    });

    it('should carry non-empty messageCid in catch-up subscription tokens', async () => {
      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Emit some events to create a cursor.
      const cursor1 = await eventLog.emit(tenant, event, {}, cid(1));
      await eventLog.emit(tenant, event, {}, cid(2));
      await eventLog.emit(tenant, event, {}, cid(3));

      // Subscribe with cursor — should get catch-up events with valid messageCids.
      const received: SubscriptionMessage[] = [];
      await eventLog.subscribe(tenant, 'sub-catchup-cid', (msg) => { received.push(msg); }, { cursor: cursor1! });

      const events = received.filter((m): m is SubscriptionMessage & { type: 'event' } => m.type === 'event');
      expect(events.length).toBe(2); // cid(2) and cid(3)
      expect(events[0].cursor.messageCid).toBe(cid(2));
      expect(events[1].cursor.messageCid).toBe(cid(3));

      // EOSE should carry the last replayed cursor when catch-up delivered events.
      const eose = received.find(m => m.type === 'eose');
      expect(eose).toBeDefined();
      expect(eose!.cursor.messageCid).toBeTruthy();
    });

    it('should never produce empty messageCid even under eviction pressure', async () => {
      // Use a very small log to maximize eviction.
      const smallLog = new EventEmitterEventLog({ maxEventsPerTenant: 3 });
      await smallLog.open();

      const tenant = 'did:example:alice';
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } as any };

      // Fill the log to capacity.
      const cursor0 = await smallLog.emit(tenant, event, {}, cid(1));
      await smallLog.emit(tenant, event, {}, cid(2));
      await smallLog.emit(tenant, event, {}, cid(3));

      // Subscribe with cursor from the first event.
      const received: SubscriptionMessage[] = [];
      await smallLog.subscribe(tenant, 'sub-eviction', (msg) => { received.push(msg); }, { cursor: cursor0! });

      // Emit more events (triggers eviction of oldest entries).
      await smallLog.emit(tenant, event, {}, cid(4));
      await smallLog.emit(tenant, event, {}, cid(5));

      await new Promise((r) => setTimeout(r, 20));

      // Every event token should have a non-empty messageCid.
      for (const msg of received) {
        if (msg.type === 'event') {
          expect(msg.cursor.messageCid?.length ?? 0).toBeGreaterThan(0);
        }
      }

      await smallLog.close();
    });
  });
});
