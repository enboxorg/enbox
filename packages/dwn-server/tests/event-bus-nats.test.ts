import type { SubscriptionMessage, Wake } from '@enbox/dwn-sdk-js';

import { createConnection } from 'net';
import { Kysely } from 'kysely';
import NatsEventBus from '../src/plugins/event-bus-nats.js';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Cid, DurableEventLog, TestDataGenerator } from '@enbox/dwn-sdk-js';
import {
  createBunSqliteDatabase,
  MessageStoreSql,
  runDwnStoreMigrations,
  SqliteDialect,
} from '@enbox/dwn-sql-store';

const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const SUBJECT_PREFIX = `dwn.test.wakes.${Date.now()}`;

let natsAvailable = false;

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

function natsIt(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!natsAvailable) {
      return;
    }

    await fn();
  });
}

function collectWakes(count: number, timeoutMs = 5_000): {
  listener: (wake: Wake) => void;
  promise: Promise<Wake[]>;
  wakes: Wake[];
} {
  const wakes: Wake[] = [];
  let resolve!: (value: Wake[]) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Wake[]>((res, rej): void => {
    resolve = res;
    reject = rej;
  });

  const timer = setTimeout((): void => {
    reject(new Error(`collectWakes timed out after ${timeoutMs}ms — received ${wakes.length}/${count}`));
  }, timeoutMs);

  const listener = (wake: Wake): void => {
    wakes.push(wake);
    if (wakes.length >= count) {
      clearTimeout(timer);
      resolve(wakes);
    }
  };

  return { listener, promise, wakes };
}

function collectMessages(count: number, timeoutMs = 5_000): {
  listener: (message: SubscriptionMessage) => void;
  messages: SubscriptionMessage[];
  promise: Promise<SubscriptionMessage[]>;
} {
  const messages: SubscriptionMessage[] = [];
  let resolve!: (value: SubscriptionMessage[]) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<SubscriptionMessage[]>((res, rej): void => {
    resolve = res;
    reject = rej;
  });

  const timer = setTimeout((): void => {
    reject(new Error(`collectMessages timed out after ${timeoutMs}ms — received ${messages.length}/${count}`));
  }, timeoutMs);

  const listener = (message: SubscriptionMessage): void => {
    messages.push(message);
    if (messages.length >= count) {
      clearTimeout(timer);
      resolve(messages);
    }
  };

  return { listener, messages, promise };
}

describe('NatsEventBus', () => {
  beforeAll(async () => {
    natsAvailable = await isNatsReachable();
    if (!natsAvailable) {
      console.log(`NATS is not reachable at ${NATS_URL} — skipping NatsEventBus tests.`);
      return;
    }

    process.env.NATS_URL = NATS_URL;
    process.env.NATS_WAKE_SUBJECT_PREFIX = SUBJECT_PREFIX;
  });

  afterAll(() => {
    delete process.env.NATS_WAKE_SUBJECT_PREFIX;
  });

  natsIt('should publish wakes between bus instances', async () => {
    const publisher = new NatsEventBus();
    const subscriber = new NatsEventBus();
    await Promise.all([publisher.open(), subscriber.open()]);

    try {
      const collected = collectWakes(1);
      const unsubscribe = subscriber.subscribe(collected.listener);
      publisher.publish({ tenant: 'did:test:alice', seq: '42' });

      const wakes = await collected.promise;
      unsubscribe();
      expect(wakes).toEqual([{ tenant: 'did:test:alice', seq: '42' }]);
    } finally {
      await Promise.all([publisher.close(), subscriber.close()]);
    }
  });

  natsIt('should wake a durable event log on another bus instance to drain the shared store', async () => {
    const sharedDb = createBunSqliteDatabase(':memory:');
    const dialect = new SqliteDialect({ database: async (): Promise<typeof sharedDb> => sharedDb });
    const migrationDb = new Kysely<Record<string, unknown>>({ dialect });
    await runDwnStoreMigrations(migrationDb, dialect);

    const publishingBus = new NatsEventBus();
    const subscribingBus = new NatsEventBus();
    await Promise.all([publishingBus.open(), subscribingBus.open()]);

    const publishingStore = new MessageStoreSql(dialect, publishingBus);
    const subscribingStore = new MessageStoreSql(dialect, subscribingBus);
    const eventLog = new DurableEventLog(subscribingStore, subscribingBus, { idleRedrainIntervalMs: 0 });

    await Promise.all([publishingStore.open(), subscribingStore.open(), eventLog.open()]);

    try {
      const { author, message, recordsWrite } = await TestDataGenerator.generateRecordsWrite();
      const indexes = await recordsWrite.constructIndexes(true);
      const messageCid = await Cid.computeCid(message);
      const collected = collectMessages(1);
      const subscription = await eventLog.subscribe(author.did, 'sub', collected.listener);

      await publishingStore.put(author.did, message, indexes);

      const messages = await collected.promise;
      await subscription.close();

      expect(messages[0].type).toBe('event');
      if (messages[0].type === 'event') {
        expect(messages[0].messageCid).toBe(messageCid);
        expect(messages[0].seq).toBe('1');
        expect(messages[0].cursor.position).toBe('1');
      }
    } finally {
      await eventLog.close();
      await Promise.all([publishingStore.close(), subscribingStore.close()]);
      await Promise.all([publishingBus.close(), subscribingBus.close()]);
    }
  });
});
