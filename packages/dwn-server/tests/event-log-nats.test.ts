import type { JetStreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';
import type { KeyValues, MessageEvent, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import { createConnection } from 'net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { connect } from '@nats-io/transport-node';
import { jetstreamManager } from '@nats-io/jetstream';

import NatsEventLog from '../src/plugins/event-log-nats.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';

/**
 * Quick TCP connectivity check. Returns `true` if the NATS port is reachable.
 * Used to skip the entire test suite when NATS is not available (e.g. CI
 * without a NATS container).
 */
async function isNatsReachable(): Promise<boolean> {
  const url = new URL(NATS_URL.replace('nats://', 'http://'));
  const host = url.hostname;
  const port = Number(url.port) || 4222;
  return new Promise((resolve) => {
    const socket = createConnection({ host, port }, (): void => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', (): void => {
      resolve(false);
    });
    socket.setTimeout(2_000, (): void => {
      socket.destroy();
      resolve(false);
    });
  });
}

let natsAvailable = false;

/**
 * Wrapper around `it()` that skips the test body when NATS is unreachable.
 * Tests show as "pass" (no-op) rather than "fail" when infrastructure is absent.
 */
function natsIt(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!natsAvailable) {
      return;
    }
    await fn();
  });
}

/** Single stream name for the entire test run. */
const STREAM_NAME = `TEST_EVENTS_${Date.now()}`;

function createEvent(message: Record<string, unknown> = { id: 'test' }): MessageEvent {
  return { message: message as MessageEvent['message'] };
}

function createIndexes(overrides: Record<string, string | number | boolean> = {}): KeyValues {
  return {
    interface : 'Records',
    method    : 'Write',
    ...overrides,
  };
}

/** Auto-incrementing message CID generator for tests. */
let cidCounter = 0;
function cid(): string {
  return `bafy-nats-test-${++cidCounter}`;
}

/**
 * Collect subscription messages into an array, returning a promise that
 * resolves when `count` messages have been received (or times out).
 */
function collectMessages(
  count: number,
  timeoutMs = 5_000,
): { messages: SubscriptionMessage[]; promise: Promise<SubscriptionMessage[]>; listener: (msg: SubscriptionMessage) => void } {
  const messages: SubscriptionMessage[] = [];
  let resolve: (value: SubscriptionMessage[]) => void;
  let reject: (reason: Error) => void;
  const promise = new Promise<SubscriptionMessage[]>((res, rej) => {
    resolve = res; reject = rej;
  });

  const timer = setTimeout((): void => {
    reject(new Error(`collectMessages timed out after ${timeoutMs}ms — received ${messages.length}/${count}`));
  }, timeoutMs);

  const listener = (msg: SubscriptionMessage): void => {
    messages.push(msg);
    if (messages.length >= count) {
      clearTimeout(timer);
      resolve(messages);
    }
  };

  return { messages, promise, listener };
}

/**
 * Wait for a predicate to become true, polling every `intervalMs`.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 3_000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NatsEventLog', () => {
  let eventLog: NatsEventLog;

  /** Direct NATS connection for administrative cleanup. */
  let adminNc: NatsConnection;
  let adminJsm: JetStreamManager;

  beforeAll(async () => {
    // Pre-flight check: determine NATS availability before setting up.
    natsAvailable = await isNatsReachable();
    if (!natsAvailable) {
      console.log(`NATS is not reachable at ${NATS_URL} — skipping NatsEventLog tests.`);
      return;
    }

    // Set env vars for the plugin constructor.
    process.env.NATS_URL = NATS_URL;
    process.env.NATS_STREAM_NAME = STREAM_NAME;
    process.env.NATS_STREAM_REPLICAS = '1';

    // Admin connection for stream purge between tests.
    adminNc = await connect({ servers: [NATS_URL] });
    adminJsm = await jetstreamManager(adminNc);

    // Clean up any leftover streams from previous test runs to avoid
    // "subjects overlap with an existing stream" errors.
    const streams = adminJsm.streams.list();
    for await (const stream of streams) {
      try {
        await adminJsm.streams.delete(stream.config.name);
      } catch {
        // Ignore deletion errors.
      }
    }

    eventLog = new NatsEventLog();
    await eventLog.open();
  });

  beforeEach(async () => {
    if (!natsAvailable) {
      return;
    }

    // Purge all messages from the stream between tests for isolation.
    // This is much faster and safer than deleting/recreating the stream.
    try {
      await adminJsm.streams.purge(STREAM_NAME);
    } catch {
      // Stream may not exist yet on first test.
    }
  });

  afterAll(async () => {
    if (!natsAvailable) {
      return;
    }

    await eventLog.close();

    // Clean up the test stream entirely.
    try {
      await adminJsm.streams.delete(STREAM_NAME);
    } catch {
      // May not exist.
    }

    await adminNc.drain();
  });

  // ---- Lifecycle -----------------------------------------------------------

  describe('lifecycle', () => {
    natsIt('should open and close without error', async () => {
      // Use the same stream name to avoid subject overlap.
      const log = new NatsEventLog();
      await log.open();
      await log.close();
    });

    natsIt('should be idempotent on repeated open() calls', async () => {
      await eventLog.open();
      await eventLog.open();
      // Should not throw or create duplicate connections.
    });

    natsIt('should throw when used before open()', async () => {
      // Temporarily set a different stream name to avoid #ensureStream side effects.
      const origStream = process.env.NATS_STREAM_NAME;
      process.env.NATS_STREAM_NAME = `UNUSED_${Date.now()}`;
      const log = new NatsEventLog();
      process.env.NATS_STREAM_NAME = origStream;

      await expect(log.emit('did:test:tenant', createEvent(), createIndexes(), cid())).rejects.toThrow('not open');
    });
  });

  // ---- emit ----------------------------------------------------------------

  describe('emit', () => {
    natsIt('should emit an event and return a ProgressToken', async () => {
      const token = await eventLog.emit('did:test:alice', createEvent(), createIndexes(), cid());
      expect(token).toBeDefined();
      expect(typeof token).toBe('object');
      expect(token!.streamId).toBeDefined();
      expect(token!.epoch).toBeDefined();
      expect(Number(token!.position)).toBeGreaterThan(0);
    });

    natsIt('should return monotonically increasing positions', async () => {
      const c1 = await eventLog.emit('did:test:alice', createEvent(), createIndexes(), cid());
      const c2 = await eventLog.emit('did:test:alice', createEvent(), createIndexes(), cid());
      const c3 = await eventLog.emit('did:test:alice', createEvent(), createIndexes(), cid());

      expect(Number(c1!.position)).toBeLessThan(Number(c2!.position));
      expect(Number(c2!.position)).toBeLessThan(Number(c3!.position));
    });
  });

  // ---- read ----------------------------------------------------------------

  describe('read', () => {
    natsIt('should return an empty result when no events exist', async () => {
      const result = await eventLog.read('did:test:empty');
      expect(result.events).toHaveLength(0);
      expect(result.cursor).toBeUndefined();
    });

    natsIt('should return undefined replay bounds when no tenant events exist', async () => {
      const bounds = await eventLog.getReplayBounds('did:test:empty-bounds');
      expect(bounds).toBeUndefined();
    });

    natsIt('should return all events for a tenant', async () => {
      const tenant = 'did:test:reader';
      await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes(), cid());
      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes(), cid());
      await eventLog.emit(tenant, createEvent({ id: '3' }), createIndexes(), cid());

      const result = await eventLog.read(tenant);
      expect(result.events).toHaveLength(3);
      expect(result.cursor).toBeDefined();
    });

    natsIt('should resume from a cursor (exclusive)', async () => {
      const tenant = 'did:test:cursor';
      const c1 = await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes(), cid());
      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes(), cid());
      await eventLog.emit(tenant, createEvent({ id: '3' }), createIndexes(), cid());

      const result = await eventLog.read(tenant, { cursor: c1 });
      expect(result.events).toHaveLength(2);
      // Verify events are after c1.
      for (const entry of result.events) {
        expect(Number(entry.seq)).toBeGreaterThan(Number(c1!.position));
      }
    });

    natsIt('should reject a cursor whose position is beyond the tenant head', async () => {
      const tenant = 'did:test:cursor-too-new';
      const c1 = await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes(), cid());
      const futureCursor = { ...c1!, position: String(Number(c1!.position) + 1) };

      await expect(eventLog.read(tenant, { cursor: futureCursor })).rejects.toThrow('token_too_new');
    });

    natsIt('should reject a cursor whose message CID does not match its position', async () => {
      const tenant = 'did:test:cursor-message-mismatch';
      const c1 = await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes(), cid());
      const mismatchedCursor = { ...c1!, messageCid: cid() };

      await expect(eventLog.read(tenant, { cursor: mismatchedCursor })).rejects.toThrow('message_mismatch');
    });

    natsIt('should respect the limit parameter', async () => {
      const tenant = 'did:test:limit';
      await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes(), cid());
      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes(), cid());
      await eventLog.emit(tenant, createEvent({ id: '3' }), createIndexes(), cid());

      const result = await eventLog.read(tenant, { limit: 2 });
      expect(result.events).toHaveLength(2);
    });

    natsIt('should not deliver events or advance the cursor when limit is zero', async () => {
      const tenant = 'did:test:limit-zero';
      const firstCursor = await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes(), cid());
      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes(), cid());

      const withoutCursor = await eventLog.read(tenant, { limit: 0 });
      expect(withoutCursor.events).toHaveLength(0);
      expect(withoutCursor.cursor).toBeUndefined();
      expect(withoutCursor.drained).toBe(false);

      const withCursor = await eventLog.read(tenant, { cursor: firstCursor, limit: 0 });
      expect(withCursor.events).toHaveLength(0);
      expect(withCursor.cursor).toBe(firstCursor);
      expect(withCursor.drained).toBe(false);
    });

    natsIt('should filter events (OR semantics across filters)', async () => {
      const tenant = 'did:test:filter';
      await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes({ method: 'Write' }), cid());
      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes({ method: 'Delete' }), cid());
      await eventLog.emit(tenant, createEvent({ id: '3' }), createIndexes({ method: 'Query' }), cid());

      const result = await eventLog.read(tenant, {
        filters: [{ method: 'Delete' }, { method: 'Query' }],
      });
      expect(result.events).toHaveLength(2);
    });

    natsIt('should advance to a high-water cursor when filters skip tail events', async () => {
      const tenant = 'did:test:filter-high-water';
      await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes({ method: 'Write' }), cid());
      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes({ method: 'Delete' }), cid());
      const tailCursor = await eventLog.emit(tenant, createEvent({ id: '3' }), createIndexes({ method: 'Query' }), cid());

      const result = await eventLog.read(tenant, {
        filters: [{ method: 'Write' }],
      });

      expect(result.events).toHaveLength(1);
      expect(result.cursor!.position).toBe(tailCursor!.position);
      expect(result.cursor!.messageCid).toBeUndefined();
      expect(result.drained).toBe(true);
    });

    natsIt('should return input cursor when no new events exist', async () => {
      const tenant = 'did:test:no-new';
      const c1 = await eventLog.emit(tenant, createEvent(), createIndexes(), cid());

      const result = await eventLog.read(tenant, { cursor: c1 });
      expect(result.events).toHaveLength(0);
      expect(result.cursor).toBe(c1);
    });
  });

  // ---- subscribe -----------------------------------------------------------

  describe('subscribe', () => {
    natsIt('should receive live events (no cursor)', async () => {
      const tenant = 'did:test:live-sub';
      const { promise, listener } = collectMessages(3);

      const subscription = await eventLog.subscribe(tenant, 'sub-live', listener);

      // Emit events after subscribing.
      await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes(), cid());
      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes(), cid());
      await eventLog.emit(tenant, createEvent({ id: '3' }), createIndexes(), cid());

      const msgs = await promise;
      expect(msgs).toHaveLength(3);
      for (const msg of msgs) {
        expect(msg.type).toBe('event');
      }

      await subscription.close();
    });

    natsIt('should catch up from cursor and deliver EOSE', async () => {
      const tenant = 'did:test:catchup';

      // Emit events before subscribing.
      const c1 = await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes(), cid());
      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes(), cid());
      await eventLog.emit(tenant, createEvent({ id: '3' }), createIndexes(), cid());

      // Subscribe from cursor c1 — should get events 2, 3 then EOSE.
      // That's 2 events + 1 EOSE = 3 messages.
      const { promise, listener } = collectMessages(3);

      const subscription = await eventLog.subscribe(tenant, 'sub-catchup', listener, { cursor: c1 });

      const msgs = await promise;
      // First two should be events.
      expect(msgs[0].type).toBe('event');
      expect(msgs[1].type).toBe('event');
      // Last should be EOSE.
      expect(msgs[2].type).toBe('eose');

      await subscription.close();
    });

    natsIt('should deliver EOSE when no stored events exist after cursor', async () => {
      const tenant = 'did:test:eose-empty';
      const c1 = await eventLog.emit(tenant, createEvent(), createIndexes(), cid());

      // Subscribe from the last cursor — nothing new to catch up on.
      const messages: SubscriptionMessage[] = [];
      const subscription = await eventLog.subscribe(
        tenant,
        'sub-eose-empty',
        (msg: SubscriptionMessage): void => {
          messages.push(msg);
        },
        { cursor: c1 },
      );

      // Wait for the EOSE to arrive (async via setTimeout).
      await waitUntil((): boolean => messages.some((m) => m.type === 'eose'));

      const eose = messages.find((m) => m.type === 'eose')!;
      expect(eose.type).toBe('eose');
      expect(eose.cursor).toBe(c1);

      await subscription.close();
    });

    natsIt('should filter subscription events', async () => {
      const tenant = 'did:test:sub-filter';
      const messages: SubscriptionMessage[] = [];
      const subscription = await eventLog.subscribe(
        tenant,
        'sub-filter',
        (msg: SubscriptionMessage): void => {
          messages.push(msg);
        },
        { filters: [{ method: 'Delete' }] },
      );

      // Emit events — only the Delete one should be delivered.
      await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes({ method: 'Write' }), cid());
      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes({ method: 'Delete' }), cid());
      await eventLog.emit(tenant, createEvent({ id: '3' }), createIndexes({ method: 'Query' }), cid());

      await waitUntil((): boolean => messages.length >= 1);

      // Give a little extra time to make sure no extra events leak through.
      await new Promise((r) => setTimeout(r, 200));

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('event');

      await subscription.close();
    });

    natsIt('should stop receiving events after close', async () => {
      const tenant = 'did:test:sub-close';
      const messages: SubscriptionMessage[] = [];
      const subscription = await eventLog.subscribe(
        tenant,
        'sub-close',
        (msg: SubscriptionMessage): void => {
          messages.push(msg);
        },
      );

      await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes(), cid());
      await waitUntil((): boolean => messages.length >= 1);

      await subscription.close();
      const countAfterClose = messages.length;

      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes(), cid());
      // Wait briefly to confirm no new messages arrive.
      await new Promise((r) => setTimeout(r, 300));

      expect(messages.length).toBe(countAfterClose);
    });
  });

  // ---- trim ----------------------------------------------------------------

  describe('trim', () => {
    natsIt('should trim events by sequence number', async () => {
      const tenant = 'did:test:trim-seq';
      await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes(), cid());
      const c2 = await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes(), cid());
      await eventLog.emit(tenant, createEvent({ id: '3' }), createIndexes(), cid());

      // Trim events with seq < c2 (should remove event 1).
      await eventLog.trim(tenant, Number(c2!.position));

      const result = await eventLog.read(tenant);
      // After purging seq < c2, only events at seq >= c2 remain.
      for (const entry of result.events) {
        expect(Number(entry.seq)).toBeGreaterThanOrEqual(Number(c2!.position));
      }
    });

    natsIt('should trim events by timestamp (full purge fallback)', async () => {
      const tenant = 'did:test:trim-ts';
      await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes(), cid());
      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes(), cid());

      // Timestamp-based trim does a full purge of the tenant subject.
      await eventLog.trim(tenant, new Date().toISOString());

      const result = await eventLog.read(tenant);
      expect(result.events).toHaveLength(0);
    });
  });

  // ---- multi-tenant isolation ----------------------------------------------

  describe('multi-tenant isolation', () => {
    natsIt('should isolate events between tenants', async () => {
      const alice = 'did:test:alice-iso';
      const bob = 'did:test:bob-iso';

      await eventLog.emit(alice, createEvent({ id: 'a1' }), createIndexes(), cid());
      await eventLog.emit(alice, createEvent({ id: 'a2' }), createIndexes(), cid());
      await eventLog.emit(bob, createEvent({ id: 'b1' }), createIndexes(), cid());

      const aliceResult = await eventLog.read(alice);
      const bobResult = await eventLog.read(bob);

      expect(aliceResult.events).toHaveLength(2);
      expect(bobResult.events).toHaveLength(1);
    });

    natsIt('should compute replay bounds from the tenant subject, not the whole stream', async () => {
      const alice = 'did:test:alice-bounds';
      const bob = 'did:test:bob-bounds';
      const aliceFirstCid = cid();
      const aliceSecondCid = cid();

      const aliceFirst = await eventLog.emit(alice, createEvent({ id: 'a1' }), createIndexes(), aliceFirstCid);
      await eventLog.emit(bob, createEvent({ id: 'b1' }), createIndexes(), cid());
      const aliceSecond = await eventLog.emit(alice, createEvent({ id: 'a2' }), createIndexes(), aliceSecondCid);
      await eventLog.emit(bob, createEvent({ id: 'b2' }), createIndexes(), cid());

      const bounds = await eventLog.getReplayBounds(alice);

      expect(bounds!.oldest.position).toBe(aliceFirst!.position);
      expect(bounds!.oldest.messageCid).toBe(aliceFirstCid);
      expect(bounds!.latest.position).toBe(aliceSecond!.position);
      expect(bounds!.latest.messageCid).toBe(aliceSecondCid);
    });

    natsIt('should report zero-limit reads as drained when only another tenant advanced the stream', async () => {
      const alice = 'did:test:alice-limit-zero-iso';
      const bob = 'did:test:bob-limit-zero-iso';
      const aliceCursor = await eventLog.emit(alice, createEvent({ id: 'a1' }), createIndexes(), cid());
      await eventLog.emit(bob, createEvent({ id: 'b1' }), createIndexes(), cid());

      const result = await eventLog.read(alice, { cursor: aliceCursor, limit: 0 });

      expect(result.events).toHaveLength(0);
      expect(result.cursor).toBe(aliceCursor);
      expect(result.drained).toBe(true);
    });

    natsIt('should not deliver events from one tenant to another tenant subscription', async () => {
      const alice = 'did:test:alice-sub-iso';
      const bob = 'did:test:bob-sub-iso';

      const aliceMessages: SubscriptionMessage[] = [];
      const aliceSub = await eventLog.subscribe(
        alice,
        'sub-alice-iso',
        (msg: SubscriptionMessage): void => {
          aliceMessages.push(msg);
        },
      );

      // Emit to both tenants — alice's subscription should only get alice's event.
      await eventLog.emit(alice, createEvent({ id: 'a1' }), createIndexes(), cid());
      await eventLog.emit(bob, createEvent({ id: 'b1' }), createIndexes(), cid());

      await waitUntil((): boolean => aliceMessages.length >= 1);
      await new Promise((r) => setTimeout(r, 200));

      expect(aliceMessages).toHaveLength(1);
      expect(aliceMessages[0].type).toBe('event');

      await aliceSub.close();
    });
  });

  // ---- filter matching (unit-level) ----------------------------------------

  describe('filter matching', () => {
    natsIt('should match with EqualFilter', async () => {
      const tenant = 'did:test:filter-eq';
      await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes({ protocol: 'http://proto.xyz' }), cid());
      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes({ protocol: 'http://other.xyz' }), cid());

      const result = await eventLog.read(tenant, {
        filters: [{ protocol: 'http://proto.xyz' }],
      });
      expect(result.events).toHaveLength(1);
    });

    natsIt('should match with OneOfFilter (array)', async () => {
      const tenant = 'did:test:filter-oneof';
      await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes({ method: 'Write' }), cid());
      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes({ method: 'Delete' }), cid());
      await eventLog.emit(tenant, createEvent({ id: '3' }), createIndexes({ method: 'Query' }), cid());

      const result = await eventLog.read(tenant, {
        filters: [{ method: ['Write', 'Query'] }],
      });
      expect(result.events).toHaveLength(2);
    });

    natsIt('should match with RangeFilter', async () => {
      const tenant = 'did:test:filter-range';
      await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes({ dateCreated: '2024-01-01' }), cid());
      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes({ dateCreated: '2024-06-15' }), cid());
      await eventLog.emit(tenant, createEvent({ id: '3' }), createIndexes({ dateCreated: '2025-01-01' }), cid());

      const result = await eventLog.read(tenant, {
        filters: [{ dateCreated: { gte: '2024-06-01', lt: '2025-01-01' } }],
      });
      expect(result.events).toHaveLength(1);
    });

    natsIt('should return all events when no filters are provided', async () => {
      const tenant = 'did:test:filter-none';
      await eventLog.emit(tenant, createEvent({ id: '1' }), createIndexes(), cid());
      await eventLog.emit(tenant, createEvent({ id: '2' }), createIndexes(), cid());

      const result = await eventLog.read(tenant);
      expect(result.events).toHaveLength(2);
    });
  });

  // ---- DID subject encoding ------------------------------------------------

  describe('DID subject encoding', () => {
    natsIt('should handle DIDs with dots correctly', async () => {
      // did:dht contains dots in the method-specific identifier.
      const tenant = 'did:dht:abc123.def456';
      const cursor = await eventLog.emit(tenant, createEvent(), createIndexes(), cid());
      expect(cursor).toBeDefined();

      const result = await eventLog.read(tenant);
      expect(result.events).toHaveLength(1);
    });
  });
});
