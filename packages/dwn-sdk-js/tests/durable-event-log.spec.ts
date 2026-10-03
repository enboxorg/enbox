import type { DurableEventLogStore } from '../src/event-stream/durable-event-log.js';
import type { Filter } from '../src/types/query-types.js';
import type { GenericMessage } from '../src/types/message-types.js';
import type {
  EventLogEntry,
  EventLogReadOptions,
  EventLogReadResult,
  EventSubscription,
  ProgressGapInfo,
  ProgressToken,
  Wake,
} from '../src/types/subscriptions.js';
import type { GenerateRecordsWriteOutput, Persona } from './utils/test-data-generator.js';
import type { RecordsWriteMessage, SubscriptionMessage } from '../src/index.js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { BroadcastChannelWakePublisher } from '../src/event-stream/broadcast-channel-wake-publisher.js';
import { DurableEventLog } from '../src/event-stream/durable-event-log.js';
import { Encoder } from '../src/utils/encoder.js';
import { EventEmitterWakePublisher } from '../src/event-stream/event-emitter-wake-publisher.js';
import { Message } from '../src/core/message.js';
import { MessageStoreLevel } from '../src/store/message-store-level.js';
import { Poller } from './utils/poller.js';
import { Replication } from '../src/utils/replication.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { DwnError, DwnErrorCode } from '../src/core/dwn-error.js';

type StoredRecord = GenerateRecordsWriteOutput & {
  messageCid: string;
  position: string;
};

type DeliveryGate = {
  promise: Promise<void>;
  resolve: () => void;
};

function createDeliveryGate(): DeliveryGate {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise): void => { resolve = resolvePromise; });
  return { promise, resolve };
}

class ScriptedFeedStore implements DurableEventLogStore {
  private readonly epochValue: string = crypto.randomUUID();
  private wakeDuringNextRead?: EventLogEntry;
  public throwGapOnNextRead: boolean = false;
  public readCount: number = 0;

  public constructor(
    private readonly tenant: string,
    private readonly entries: EventLogEntry[],
    private readonly wakePublisher: EventEmitterWakePublisher,
  ) {}

  public append(entry: EventLogEntry): void {
    this.entries.push(entry);
    this.entries.sort((left, right): number => Number(BigInt(ScriptedFeedStore.getPosition(left)) - BigInt(ScriptedFeedStore.getPosition(right))));
  }

  public publishWakeDuringNextRead(entry: EventLogEntry): void {
    this.wakeDuringNextRead = entry;
  }

  public async epoch(): Promise<string> {
    return this.epochValue;
  }

  public async fingerprint(_tenant: string, _scopes: string[]): Promise<string> {
    return Replication.fingerprintToHex(Replication.emptyFingerprint());
  }

  public async query(_tenant: string, _filters: Filter[]): Promise<{ messages: GenericMessage[] }> {
    return { messages: [] };
  }

  public async logBounds(tenant: string): Promise<{ oldest: ProgressToken; latest: ProgressToken } | undefined> {
    this.assertTenant(tenant);
    if (this.entries.length === 0) {
      return undefined;
    }

    const oldestEntry = this.entries[0];
    const latestEntry = this.entries[this.entries.length - 1];
    return {
      oldest : await this.createToken(ScriptedFeedStore.getPosition(oldestEntry), oldestEntry.messageCid),
      latest : await this.createToken(ScriptedFeedStore.getPosition(latestEntry), latestEntry.messageCid),
    };
  }

  public async logRead(tenant: string, options: EventLogReadOptions = {}): Promise<EventLogReadResult> {
    this.readCount++;
    this.assertTenant(tenant);
    await this.validateCursor(options.cursor);

    if (this.throwGapOnNextRead) {
      this.throwGapOnNextRead = false;
      await this.throwProgressGap(options.cursor);
    }

    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    const cursorPosition = options.cursor === undefined ? 0n : BigInt(options.cursor.position);
    const headPosition = this.getHeadPosition();
    if (limit <= 0) {
      return { events: [], cursor: options.cursor, drained: cursorPosition >= headPosition };
    }

    if (this.wakeDuringNextRead !== undefined) {
      const entry = this.wakeDuringNextRead;
      this.wakeDuringNextRead = undefined;
      this.append(entry);
      this.wakePublisher.publish({ tenant: this.tenant, seq: ScriptedFeedStore.getPosition(entry) });
    }

    const events = this.entries
      .filter(entry => BigInt(ScriptedFeedStore.getPosition(entry)) > cursorPosition)
      .slice(0, limit);
    const lastEvent = events.at(-1);
    const resultCursor = lastEvent === undefined
      ? options.cursor
      : await this.createToken(ScriptedFeedStore.getPosition(lastEvent), lastEvent.messageCid);
    const drained = BigInt(resultCursor?.position ?? options.cursor?.position ?? '0') >= this.getHeadPosition();

    return { events, cursor: resultCursor, drained };
  }

  public async createToken(position: string, messageCid?: string): Promise<ProgressToken> {
    const token: ProgressToken = {
      streamId : await Replication.deriveStreamId(this.tenant),
      epoch    : this.epochValue,
      position,
    };

    if (messageCid !== undefined) {
      token.messageCid = messageCid;
    }

    return token;
  }

  private assertTenant(tenant: string): void {
    if (tenant !== this.tenant) {
      throw new Error(`unexpected tenant ${tenant}`);
    }
  }

  private async validateCursor(cursor: ProgressToken | undefined): Promise<void> {
    if (cursor === undefined) {
      return;
    }

    const invalidStream = cursor.streamId !== await Replication.deriveStreamId(this.tenant);
    const invalidEpoch = cursor.epoch !== this.epochValue;
    const invalidPosition = BigInt(cursor.position) > this.getHeadPosition();
    if (invalidStream || invalidEpoch || invalidPosition) {
      await this.throwProgressGap(cursor);
    }
  }

  private async throwProgressGap(cursor: ProgressToken | undefined): Promise<never> {
    const fallbackCursor = cursor ?? await this.createToken('0');
    const bounds = await this.logBounds(this.tenant);
    const gapInfo: ProgressGapInfo = {
      requested       : fallbackCursor,
      oldestAvailable : bounds?.oldest ?? fallbackCursor,
      latestAvailable : bounds?.latest ?? fallbackCursor,
      reason          : 'token_too_old',
    };
    const error = new DwnError(DwnErrorCode.EventLogProgressGap, 'progress token gap: token_too_old');
    (error as DwnError & { gapInfo?: ProgressGapInfo }).gapInfo = gapInfo;
    throw error;
  }

  private getHeadPosition(): bigint {
    const latestEntry = this.entries.at(-1);
    return latestEntry === undefined ? 0n : BigInt(ScriptedFeedStore.getPosition(latestEntry));
  }

  private static getPosition(entry: EventLogEntry): string {
    return entry.position ?? entry.seq;
  }
}

describe('DurableEventLog', () => {
  let messageStore: MessageStoreLevel;
  let eventLog: DurableEventLog;
  let wakePublisher: EventEmitterWakePublisher;

  beforeAll(async () => {
    wakePublisher = new EventEmitterWakePublisher();
    messageStore = new MessageStoreLevel({
      location: 'TEST-MESSAGESTORE-DURABLE-EVENT-LOG',
      wakePublisher,
    });
    await messageStore.open();
  });

  beforeEach(async () => {
    await eventLog?.close();
    await messageStore.clear();
    wakePublisher.clear();
    eventLog = new DurableEventLog(messageStore, wakePublisher, { idleRedrainIntervalMs: 0 });
    await eventLog.open();
  });

  afterAll(async () => {
    await eventLog.close();
    await messageStore.close();
  });

  it('should read durable log entries with high-water cursors', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const first = await storeRecord(alice);
    const second = await storeRecord(alice);

    const result = await eventLog.read(alice.did);

    expect(result.events.map(entry => entry.messageCid)).toEqual([first.messageCid, second.messageCid]);
    expect(result.events.map(entry => entry.position)).toEqual(['1', '2']);
    expect(result.events[0].encodedData).toBe((first.message as RecordsWriteMessage & { encodedData?: string }).encodedData);
    expect((result.events[0].event.message as RecordsWriteMessage & { encodedData?: string }).encodedData).toBeUndefined();
    expect(result.cursor!.position).toBe('2');
    expect(result.drained).toBe(true);
  });

  it('should replay from a cursor, send EOSE, then drain live wakes', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const first = await storeRecord(alice);
    const bounds = await eventLog.getReplayBounds(alice.did);
    const received: SubscriptionMessage[] = [];

    const subscription = await eventLog.subscribe(alice.did, 'subscription-1', (message): void => {
      received.push(message);
    }, { cursor: bounds!.oldest });

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(expect.objectContaining({
      type       : 'event',
      seq        : '1',
      messageCid : first.messageCid,
    }));
    expect(received[0].cursor.position).toBe('1');
    expect(received[0].cursor.streamId).toBe(bounds!.latest.streamId);
    expect(received[0].cursor.epoch).toBe(bounds!.latest.epoch);
    expect(received[1]).toEqual(expect.objectContaining({ type: 'eose' }));
    expect(received[1].cursor.position).toBe('1');

    const second = await storeRecord(alice);
    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received.filter(message => message.type === 'event')).toHaveLength(2);
    });

    const liveEvent = received[2];
    expect(liveEvent).toEqual(expect.objectContaining({
      type       : 'event',
      seq        : '2',
      messageCid : second.messageCid,
    }));
    expect(liveEvent.cursor.position).toBe('2');

    await subscription.close();
  });

  it('should finish each replay listener before the next event, EOSE, and live delivery', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await storeRecord(alice);
    await storeRecord(alice);
    const bounds = await eventLog.getReplayBounds(alice.did);
    const blocked = createDeliveryGate();
    const started = createDeliveryGate();
    const liveDelivered = createDeliveryGate();
    const received: string[] = [];
    let opened = false;
    const opening = eventLog.subscribe(alice.did, 'ordered-replay', async (message): Promise<void> => {
      received.push(`${message.type}:${message.cursor.position}:start`);
      if (message.type === 'event' && message.cursor.position === '1') {
        started.resolve();
        await blocked.promise;
      }
      received.push(`${message.type}:${message.cursor.position}:done`);
      if (message.type === 'event' && message.cursor.position === '3') {
        liveDelivered.resolve();
      }
    }, { cursor: bounds!.oldest }).then((subscription): EventSubscription => {
      opened = true;
      return subscription;
    });

    try {
      await started.promise;
      // A committed write and its wake must complete while the replay listener is blocked.
      await storeRecord(alice);
      expect(received).toEqual(['event:1:start']);
      expect(opened).toBe(false);
      blocked.resolve();
      await opening;
      await liveDelivered.promise;
      expect(received).toEqual([
        'event:1:start', 'event:1:done',
        'event:2:start', 'event:2:done',
        'eose:2:start', 'eose:2:done',
        'event:3:start', 'event:3:done',
      ]);
    } finally {
      blocked.resolve();
      await (await opening).close();
    }
  });

  it('should finish an async EOSE listener before opening and draining accumulated wakes', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await storeRecord(alice);
    const bounds = await eventLog.getReplayBounds(alice.did);
    const blocked = createDeliveryGate();
    const started = createDeliveryGate();
    const liveDelivered = createDeliveryGate();
    const received: string[] = [];
    let opened = false;
    const opening = eventLog.subscribe(alice.did, 'blocked-eose', async (message): Promise<void> => {
      received.push(`${message.type}:${message.cursor.position}:start`);
      if (message.type === 'eose') {
        started.resolve();
        await blocked.promise;
      }
      received.push(`${message.type}:${message.cursor.position}:done`);
      if (message.type === 'event' && message.cursor.position === '2') {
        liveDelivered.resolve();
      }
    }, { cursor: bounds!.oldest }).then((subscription): EventSubscription => {
      opened = true;
      return subscription;
    });

    try {
      await started.promise;
      await storeRecord(alice);
      expect(received).toEqual(['event:1:start', 'event:1:done', 'eose:1:start']);
      expect(opened).toBe(false);
      blocked.resolve();
      await opening;
      await liveDelivered.promise;
      expect(received).toEqual([
        'event:1:start', 'event:1:done', 'eose:1:start', 'eose:1:done', 'event:2:start', 'event:2:done',
      ]);
    } finally {
      blocked.resolve();
      await (await opening).close();
    }
  });

  it('should keep writes and other subscriptions progressing while a listener is blocked', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const blocked = createDeliveryGate();
    const started = createDeliveryGate();
    const slowDelivered = createDeliveryGate();
    const fastDelivered = createDeliveryGate();
    const slowReceived: string[] = [];
    const fastReceived: string[] = [];
    const slow = await eventLog.subscribe(alice.did, 'slow-listener', async (message): Promise<void> => {
      slowReceived.push(message.cursor.position);
      if (message.cursor.position === '1') {
        started.resolve();
        await blocked.promise;
      } else {
        slowDelivered.resolve();
      }
    });
    const fast = await eventLog.subscribe(alice.did, 'fast-listener', (message): void => {
      fastReceived.push(message.cursor.position);
      if (message.cursor.position === '2') {
        fastDelivered.resolve();
      }
    });

    try {
      await storeRecord(alice);
      await started.promise;
      await storeRecord(alice);
      // Coalesced wakes must not start concurrent delivery to the blocked subscription.
      for (let index = 0; index < 100; index++) {
        wakePublisher.publish({ tenant: alice.did, seq: '2' });
      }
      await fastDelivered.promise;
      expect(slowReceived).toEqual(['1']);
      expect(fastReceived).toEqual(['1', '2']);
      blocked.resolve();
      await slowDelivered.promise;
      expect(slowReceived).toEqual(['1', '2']);
    } finally {
      blocked.resolve();
      await slow.close();
      await fast.close();
    }
  });

  for (const failingType of ['event', 'eose'] as const) {
    it(`should reject and remove a cursor subscription when its ${failingType} listener rejects`, async (): Promise<void> => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const localWakePublisher = new EventEmitterWakePublisher();
      const entry = await createLogEntry(alice, '1');
      const scriptedStore = new ScriptedFeedStore(alice.did, [entry], localWakePublisher);
      const scriptedLog = new DurableEventLog(scriptedStore, localWakePublisher, { idleRedrainIntervalMs: 0 });
      const failure = new Error('replay listener failed');

      await scriptedLog.open();
      try {
        await expect(scriptedLog.subscribe(alice.did, 'rejected-replay', async (message): Promise<void> => {
          if (message.type === failingType) {
            await Promise.resolve();
            throw failure;
          }
        }, { cursor: await scriptedStore.createToken('0') })).rejects.toBe(failure);
        const readCount = scriptedStore.readCount;
        localWakePublisher.publish({ tenant: alice.did, seq: '1' });
        expect(scriptedStore.readCount).toBe(readCount);
      } finally {
        await scriptedLog.close();
      }
    });
  }

  it('should report a rejected live listener and retry from its unadvanced cursor', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const localWakePublisher = new EventEmitterWakePublisher();
    const first = await createLogEntry(alice, '1');
    const second = await createLogEntry(alice, '2');
    const third = await createLogEntry(alice, '3');
    const scriptedStore = new ScriptedFeedStore(alice.did, [first], localWakePublisher);
    const reported = createDeliveryGate();
    const completed = createDeliveryGate();
    const errors: unknown[] = [];
    const attempted: string[] = [];
    const failure = new Error('live listener failed');
    const scriptedLog = new DurableEventLog(scriptedStore, localWakePublisher, {
      idleRedrainIntervalMs : 0,
      errorHandler          : (error): void => { errors.push(error); reported.resolve(); },
    });

    await scriptedLog.open();
    try {
      await scriptedLog.subscribe(alice.did, 'rejected-live', async (message): Promise<void> => {
        attempted.push(message.cursor.position);
        if (attempted.length === 1) {
          await Promise.resolve();
          throw failure;
        }
        if (message.cursor.position === '3') {
          completed.resolve();
        }
      });
      scriptedStore.append(second);
      scriptedStore.append(third);
      localWakePublisher.publish({ tenant: alice.did, seq: '3' });
      await reported.promise;
      expect(errors).toEqual([failure]);
      expect(attempted).toEqual(['2']);
      localWakePublisher.publish({ tenant: alice.did, seq: '3' });
      await completed.promise;
      expect(attempted).toEqual(['2', '2', '3']);
    } finally {
      await scriptedLog.close();
    }
  });

  for (const phase of ['event', 'eose'] as const) {
    it(`should abort pending ${phase} delivery without waiting for its listener`, async (): Promise<void> => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const localWakePublisher = new EventEmitterWakePublisher();
      const store = new ScriptedFeedStore(alice.did, [await createLogEntry(alice, '1')], localWakePublisher);
      const errors: unknown[] = [];
      const log = new DurableEventLog(store, localWakePublisher, {
        idleRedrainIntervalMs : 0,
        errorHandler          : (error): void => { errors.push(error); },
      });
      const started = createDeliveryGate();
      const blocked = createDeliveryGate();
      const finished = createDeliveryGate();
      const controller = new AbortController();
      const reason = new Error('subscription cancelled');
      const received: string[] = [];
      await log.open();
      const opening = log.subscribe(alice.did, 'abort-pending-replay', async (message): Promise<void> => {
        received.push(message.type);
        if (message.type === phase) {
          started.resolve();
          try {
            await blocked.promise;
            throw new Error('listener rejected after cancellation');
          } finally {
            finished.resolve();
          }
        }
      }, { cursor: await store.createToken('0'), signal: controller.signal });

      try {
        await started.promise;
        controller.abort(reason);
        await expect(opening).rejects.toBe(reason);
        const readCount = store.readCount;
        localWakePublisher.publish({ tenant: alice.did, seq: '1' });
        expect(store.readCount).toBe(readCount);
        blocked.resolve();
        await finished.promise;
        expect(received).toEqual(phase === 'event' ? ['event'] : ['event', 'eose']);
        expect(errors).toEqual([]);
      } finally {
        blocked.resolve();
        await opening.catch((): void => {});
        await log.close();
      }
    });
  }

  it('should reject a pre-aborted subscription without reading or registering it', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const localWakePublisher = new EventEmitterWakePublisher();
    const store = new ScriptedFeedStore(alice.did, [], localWakePublisher);
    const log = new DurableEventLog(store, localWakePublisher, { idleRedrainIntervalMs: 0 });
    const controller = new AbortController();
    const reason = new Error('cancelled before open');
    controller.abort(reason);
    await log.open();
    try {
      await expect(log.subscribe(alice.did, 'pre-aborted', (): void => {}, { signal: controller.signal })).rejects.toBe(reason);
      localWakePublisher.publish({ tenant: alice.did, seq: '1' });
      expect(store.readCount).toBe(0);
    } finally {
      await log.close();
    }
  });

  it('should abort initialization while bounds are still loading', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const localWakePublisher = new EventEmitterWakePublisher();
    const store = new ScriptedFeedStore(alice.did, [], localWakePublisher);
    const log = new DurableEventLog(store, localWakePublisher, { idleRedrainIntervalMs: 0 });
    const started = createDeliveryGate();
    const blocked = createDeliveryGate();
    const bounds = sinon.stub(store, 'logBounds').callsFake(async (): Promise<undefined> => {
      started.resolve();
      await blocked.promise;
      return undefined;
    });
    const controller = new AbortController();
    const reason = new Error('cancelled during open');
    await log.open();
    const opening = log.subscribe(alice.did, 'abort-init', (): void => {}, { signal: controller.signal });
    try {
      await started.promise;
      controller.abort(reason);
      await expect(opening).rejects.toBe(reason);
      blocked.resolve();
      localWakePublisher.publish({ tenant: alice.did, seq: '1' });
      expect(store.readCount).toBe(0);
    } finally {
      blocked.resolve();
      bounds.restore();
      await opening.catch((): void => {});
      await log.close();
    }
  });

  it('should reject initialization superseded by a close and reopen', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const localWakePublisher = new EventEmitterWakePublisher();
    const store = new ScriptedFeedStore(alice.did, [], localWakePublisher);
    const log = new DurableEventLog(store, localWakePublisher, { idleRedrainIntervalMs: 0 });
    const started = createDeliveryGate();
    const blocked = createDeliveryGate();
    const bounds = sinon.stub(store, 'logBounds').callsFake(async (): Promise<undefined> => {
      started.resolve();
      await blocked.promise;
      return undefined;
    });
    await log.open();
    const opening = log.subscribe(alice.did, 'stale-init', (): void => {});
    try {
      await started.promise;
      await log.close();
      await log.open();
      blocked.resolve();
      await expect(opening).rejects.toThrow(DwnErrorCode.EventLogNotOpenError);
      localWakePublisher.publish({ tenant: alice.did, seq: '1' });
      expect(store.readCount).toBe(0);
    } finally {
      blocked.resolve();
      bounds.restore();
      await opening.catch((): void => {});
      await log.close();
    }
  });

  it('should close an aborted live subscription without reporting cancellation as a drain error', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const started = createDeliveryGate();
    const blocked = createDeliveryGate();
    const finished = createDeliveryGate();
    const errors: unknown[] = [];
    const received: string[] = [];
    const controller = new AbortController();
    const log = new DurableEventLog(messageStore, wakePublisher, {
      idleRedrainIntervalMs : 0,
      errorHandler          : (error): void => { errors.push(error); },
    });
    await log.open();
    await log.subscribe(alice.did, 'abort-live', async (message): Promise<void> => {
      received.push(message.cursor.position);
      started.resolve();
      try {
        await blocked.promise;
        throw new Error('late live rejection');
      } finally {
        finished.resolve();
      }
    }, { signal: controller.signal });
    try {
      await storeRecord(alice);
      await started.promise;
      controller.abort();
      await storeRecord(alice);
      blocked.resolve();
      await finished.promise;
      expect(received).toEqual(['1']);
      expect(errors).toEqual([]);
    } finally {
      blocked.resolve();
      await log.close();
    }
  });

  it('should retain a wake received while an async listener fails and retry without another wake', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const localWakePublisher = new EventEmitterWakePublisher();
    const store = new ScriptedFeedStore(alice.did, [await createLogEntry(alice, '1')], localWakePublisher);
    const started = createDeliveryGate();
    const blocked = createDeliveryGate();
    const completed = createDeliveryGate();
    const errors: unknown[] = [];
    const attempted: string[] = [];
    const failure = new Error('transient listener failure');
    const log = new DurableEventLog(store, localWakePublisher, {
      idleRedrainIntervalMs : 0,
      errorHandler          : (error): void => { errors.push(error); },
    });
    await log.open();
    await log.subscribe(alice.did, 'queued-wake-on-error', async (message): Promise<void> => {
      attempted.push(message.cursor.position);
      if (attempted.length === 1) {
        started.resolve();
        await blocked.promise;
        throw failure;
      }
      if (message.cursor.position === '3') {
        completed.resolve();
      }
    });
    try {
      store.append(await createLogEntry(alice, '2'));
      localWakePublisher.publish({ tenant: alice.did, seq: '2' });
      await started.promise;
      store.append(await createLogEntry(alice, '3'));
      localWakePublisher.publish({ tenant: alice.did, seq: '3' });
      blocked.resolve();
      await completed.promise;
      expect(attempted).toEqual(['2', '2', '3']);
      expect(errors).toEqual([failure]);
    } finally {
      blocked.resolve();
      await log.close();
    }
  });

  it('should pace repeated failures when each failed listener produces another wake', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const localWakePublisher = new EventEmitterWakePublisher();
    const store = new ScriptedFeedStore(alice.did, [await createLogEntry(alice, '1')], localWakePublisher);
    const started = createDeliveryGate();
    let attempts = 0;
    const log = new DurableEventLog(store, localWakePublisher, { idleRedrainIntervalMs: 0, errorHandler: (): void => {} });
    await log.open();
    await log.subscribe(alice.did, 'poison-event', async (): Promise<void> => {
      attempts++;
      started.resolve();
      localWakePublisher.publish({ tenant: alice.did, seq: '2' });
      throw new Error('persistent listener failure');
    });
    try {
      store.append(await createLogEntry(alice, '2'));
      localWakePublisher.publish({ tenant: alice.did, seq: '2' });
      await started.promise;
      await new Promise<void>((resolve): void => { setTimeout(resolve, 250); });
      expect(attempts).toBeGreaterThanOrEqual(1);
      expect(attempts).toBeLessThanOrEqual(3);
      await log.close();
      const attemptsAfterClose = attempts;
      await new Promise<void>((resolve): void => { setTimeout(resolve, 120); });
      expect(attempts).toBe(attemptsAfterClose);
    } finally {
      await log.close();
    }
  });

  it('should preserve a replacement subscription when an older handle closes or aborts', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const oldController = new AbortController();
    const completed = createDeliveryGate();
    const oldReceived: SubscriptionMessage[] = [];
    const newReceived: SubscriptionMessage[] = [];
    const old = await eventLog.subscribe(alice.did, 'same-message-cid', (message): void => { oldReceived.push(message); }, {
      signal: oldController.signal,
    });
    const current = await eventLog.subscribe(alice.did, 'same-message-cid', (message): void => {
      newReceived.push(message);
      completed.resolve();
    });
    try {
      oldController.abort();
      await old.close();
      await storeRecord(alice);
      await completed.promise;
      expect(oldReceived).toEqual([]);
      expect(newReceived).toHaveLength(1);
    } finally {
      await old.close();
      await current.close();
    }
  });

  it('should keep a subscription closed when the event log closes during async EOSE delivery', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const localWakePublisher = new EventEmitterWakePublisher();
    const scriptedStore = new ScriptedFeedStore(alice.did, [await createLogEntry(alice, '1')], localWakePublisher);
    const scriptedLog = new DurableEventLog(scriptedStore, localWakePublisher, { idleRedrainIntervalMs: 0 });
    const blocked = createDeliveryGate();
    const started = createDeliveryGate();
    const received: string[] = [];
    await scriptedLog.open();
    const opening = scriptedLog.subscribe(alice.did, 'close-during-eose', async (message): Promise<void> => {
      received.push(message.type);
      if (message.type === 'eose') {
        started.resolve();
        await blocked.promise;
      }
    }, { cursor: await scriptedStore.createToken('0') });

    try {
      await started.promise;
      const readCount = scriptedStore.readCount;
      localWakePublisher.publish({ tenant: alice.did, seq: '2' });
      await scriptedLog.close();
      blocked.resolve();
      await opening;
      expect(scriptedStore.readCount).toBe(readCount);
      expect(received).toEqual(['event', 'eose']);
    } finally {
      blocked.resolve();
      await (await opening).close();
      await scriptedLog.close();
    }
  });

  it('should let an async live listener await its own close and stop the rest of the page', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const localWakePublisher = new EventEmitterWakePublisher();
    const first = await createLogEntry(alice, '1');
    const second = await createLogEntry(alice, '2');
    const third = await createLogEntry(alice, '3');
    const scriptedStore = new ScriptedFeedStore(alice.did, [first], localWakePublisher);
    const scriptedLog = new DurableEventLog(scriptedStore, localWakePublisher, { idleRedrainIntervalMs: 0 });
    const closed = createDeliveryGate();
    const received: string[] = [];
    await scriptedLog.open();
    const subscription = await scriptedLog.subscribe(alice.did, 'await-own-close', async (message): Promise<void> => {
      received.push(message.cursor.position);
      await subscription.close();
      closed.resolve();
    });

    try {
      scriptedStore.append(second);
      scriptedStore.append(third);
      localWakePublisher.publish({ tenant: alice.did, seq: '3' });
      await closed.promise;
      localWakePublisher.publish({ tenant: alice.did, seq: '3' });
      expect(received).toEqual(['2']);
    } finally {
      await scriptedLog.close();
    }
  });

  for (const asynchronous of [false, true]) {
    it(`should report a ${asynchronous ? 'rejected' : 'throwing'} progress-gap listener after closing`, async (): Promise<void> => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const localWakePublisher = new EventEmitterWakePublisher();
      const scriptedStore = new ScriptedFeedStore(alice.did, [await createLogEntry(alice, '1')], localWakePublisher);
      const failure = new Error('gap notification failed');
      const reported = createDeliveryGate();
      const errors: unknown[] = [];
      const scriptedLog = new DurableEventLog(scriptedStore, localWakePublisher, {
        idleRedrainIntervalMs : 0,
        errorHandler          : (error): void => { errors.push(error); reported.resolve(); },
      });
      await scriptedLog.open();
      try {
        await scriptedLog.subscribe(alice.did, 'rejected-gap', (message): void | Promise<void> => {
          expect(message.type).toBe('error');
          const readCount = scriptedStore.readCount;
          localWakePublisher.publish({ tenant: alice.did, seq: '1' });
          expect(scriptedStore.readCount).toBe(readCount);
          if (asynchronous) {
            return Promise.reject(failure);
          }
          throw failure;
        });
        scriptedStore.throwGapOnNextRead = true;
        localWakePublisher.publish({ tenant: alice.did, seq: '1' });
        await reported.promise;
        expect(errors).toEqual([failure]);
        const readCount = scriptedStore.readCount;
        localWakePublisher.publish({ tenant: alice.did, seq: '1' });
        expect(scriptedStore.readCount).toBe(readCount);
      } finally {
        await scriptedLog.close();
      }
    });
  }

  it('should push a completed same-CID row at its new position', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const record = await TestDataGenerator.generateRecordsWrite({ author: alice });
    const message = { ...record.message } as RecordsWriteMessage & { encodedData?: string };
    const encodedData = Encoder.bytesToBase64Url(record.dataBytes!);
    delete message.encodedData;

    const messageCid = await Message.getCid(message);
    const indexes = await record.recordsWrite.constructIndexes(true);
    const initialPut = await messageStore.put(alice.did, message, {
      ...indexes,
      isLatestBaseState: false,
    });
    const received: SubscriptionMessage[] = [];
    const subscription = await eventLog.subscribe(alice.did, 'completion-move', (event): void => {
      received.push(event);
    }, { cursor: initialPut.position! });

    expect(received).toEqual([expect.objectContaining({ type: 'eose' })]);
    const completion = await messageStore.completeData(alice.did, messageCid, indexes, encodedData);
    expect(completion).toEqual(expect.objectContaining({ status: 'completed' }));

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received.filter(({ type }) => type === 'event')).toHaveLength(1);
    });
    const completionEvent = received.find(({ type }) => type === 'event');
    expect(completionEvent).toEqual(expect.objectContaining({
      type : 'event',
      seq  : '2',
      messageCid,
      encodedData,
    }));
    if (completionEvent?.type !== 'event' || completion.status !== 'completed') {
      throw new Error('expected completion event');
    }
    expect(completionEvent.cursor.position).toBe(completion.position?.position);
    expect((completionEvent.event.message as RecordsWriteMessage & { encodedData?: string }).encodedData).toBeUndefined();

    await subscription.close();
  });

  it('should drain a wake mirrored from a sibling context over a BroadcastChannel', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();

    // Two event logs over one store, wired to SEPARATE channel-bridged
    // publishers — the two-tab shape: context A commits, context B must
    // observe via the channel alone (idle re-drain is disabled).
    const contextA = new BroadcastChannelWakePublisher('bcwp-durable-event-log');
    const contextB = new BroadcastChannelWakePublisher('bcwp-durable-event-log');
    const sharedStore = new MessageStoreLevel({
      location      : 'TEST-MESSAGESTORE-BCWP-EVENT-LOG',
      wakePublisher : contextA,
    });
    await sharedStore.open();
    const contextBLog = new DurableEventLog(sharedStore, contextB, { idleRedrainIntervalMs: 0 });
    await contextBLog.open();

    try {
      const received: SubscriptionMessage[] = [];
      const subscription = await contextBLog.subscribe(alice.did, 'cross-context-wake', (message): void => {
        received.push(message);
      });

      const record = await TestDataGenerator.generateRecordsWrite({ author: alice });
      const indexes = await record.recordsWrite.constructIndexes(true);
      await sharedStore.put(alice.did, record.message, indexes);

      const messageCid = await Message.getCid(record.message);
      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(received.some(message => message.type === 'event' && message.messageCid === messageCid)).toBe(true);
      });

      await subscription.close();
    } finally {
      await sharedStore.clear();
      await contextBLog.close();
      await sharedStore.close();
      contextA.close();
      contextB.close();
    }
  });

  it('should gate wake-driven live delivery until after EOSE at the frozen catch-up cursor', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const localWakePublisher = new EventEmitterWakePublisher();
    const firstEntry = await createLogEntry(alice, '1');
    const secondEntry = await createLogEntry(alice, '2');
    const scriptedStore = new ScriptedFeedStore(alice.did, [firstEntry], localWakePublisher);
    const scriptedLog = new DurableEventLog(scriptedStore, localWakePublisher, { idleRedrainIntervalMs: 0 });
    const received: SubscriptionMessage[] = [];

    await scriptedLog.open();
    scriptedStore.publishWakeDuringNextRead(secondEntry);
    await scriptedLog.subscribe(alice.did, 'wake-during-catch-up', (message): void => {
      received.push(message);
    }, { cursor: await scriptedStore.createToken('0') });

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received.map(message => message.type)).toEqual(['event', 'eose', 'event']);
    });

    expect(received[0].cursor.position).toBe('1');
    expect(received[1].cursor.position).toBe('1');
    expect(received[2].cursor.position).toBe('2');
    await scriptedLog.close();
  });

  it('should emit a subscription error and close after a wake-driven progress gap', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const localWakePublisher = new EventEmitterWakePublisher();
    const firstEntry = await createLogEntry(alice, '1');
    const secondEntry = await createLogEntry(alice, '2');
    const scriptedStore = new ScriptedFeedStore(alice.did, [firstEntry], localWakePublisher);
    const scriptedLog = new DurableEventLog(scriptedStore, localWakePublisher, { idleRedrainIntervalMs: 0 });
    const received: SubscriptionMessage[] = [];

    await scriptedLog.open();
    await scriptedLog.subscribe(alice.did, 'gap-after-subscribe', (message): void => {
      received.push(message);
    });

    scriptedStore.throwGapOnNextRead = true;
    localWakePublisher.publish({ tenant: alice.did, seq: '2' });

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('error');
    });

    expect(received[0].cursor.position).toBe('1');
    if (received[0].type !== 'error') {
      throw new Error('expected subscription error');
    }
    expect(received[0].error.code).toBe('ProgressGap');

    scriptedStore.append(secondEntry);
    localWakePublisher.publish({ tenant: alice.did, seq: '2' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);
    await scriptedLog.close();
  });

  it('should ignore wakes for tenants without a matching subscription', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const bob = await TestDataGenerator.generateDidKeyPersona();
    const localWakePublisher = new EventEmitterWakePublisher();
    const firstEntry = await createLogEntry(alice, '1');
    const secondEntry = await createLogEntry(alice, '2');
    const scriptedStore = new ScriptedFeedStore(alice.did, [firstEntry], localWakePublisher);
    const scriptedLog = new DurableEventLog(scriptedStore, localWakePublisher, { idleRedrainIntervalMs: 0 });
    const received: SubscriptionMessage[] = [];

    await scriptedLog.open();
    await scriptedLog.subscribe(alice.did, 'cross-tenant-wake', (message): void => {
      received.push(message);
    });

    scriptedStore.append(secondEntry);
    localWakePublisher.publish({ tenant: bob.did, seq: '2' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(received).toHaveLength(0);

    localWakePublisher.publish({ tenant: alice.did, seq: '2' });
    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toEqual(expect.objectContaining({
      type : 'event',
      seq  : '2',
    }));

    await scriptedLog.close();
  });

  it('should stop delivering the current page after a subscription closes', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const localWakePublisher = new EventEmitterWakePublisher();
    const firstEntry = await createLogEntry(alice, '1');
    const secondEntry = await createLogEntry(alice, '2');
    const thirdEntry = await createLogEntry(alice, '3');
    const scriptedStore = new ScriptedFeedStore(alice.did, [firstEntry], localWakePublisher);
    const scriptedLog = new DurableEventLog(scriptedStore, localWakePublisher, { idleRedrainIntervalMs: 0 });
    const received: SubscriptionMessage[] = [];

    await scriptedLog.open();
    const subscription = await scriptedLog.subscribe(alice.did, 'close-during-drain', (message): void => {
      if (message.type !== 'event') {
        return;
      }

      received.push(message);
      void subscription.close();
    });

    scriptedStore.append(secondEntry);
    scriptedStore.append(thirdEntry);
    localWakePublisher.publish({ tenant: alice.did, seq: '3' });

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received).toHaveLength(1);
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);
    expect(received[0].cursor.position).toBe('2');
    await scriptedLog.close();
  });

  for (const mode of ['live', 'replay'] as const) {
    it(`should retain the ${mode} page epoch when its first listener resets storage`, async (): Promise<void> => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      await storeRecord(alice);
      if (mode === 'replay') {
        await storeRecord(alice);
      }
      const bounds = await eventLog.getReplayBounds(alice.did);
      const notified = createDeliveryGate();
      const received: SubscriptionMessage[] = [];
      const resetPosition = mode === 'live' ? '2' : '1';
      let reset = false;
      const subscription = await eventLog.subscribe(alice.did, `reset-${mode}-page`, async (message): Promise<void> => {
        received.push(message);
        if (message.type === 'event' && message.cursor.position === resetPosition && !reset) {
          reset = true;
          await messageStore.clear();
          await storeRecord(alice);
        }
        if (message.type === 'error') {
          notified.resolve();
        }
      }, mode === 'replay' ? { cursor: bounds!.oldest } : {});

      try {
        if (mode === 'live') {
          // Coalesced post-commit wakes make both rows belong to one captured page.
          const heldWakes: Wake[] = [];
          const publication = sinon.stub(wakePublisher, 'publish').callsFake((wake): void => { heldWakes.push(wake); });
          try {
            await storeRecord(alice);
            await storeRecord(alice);
          } finally {
            publication.restore();
          }
          wakePublisher.publish(heldWakes.at(-1)!);
        }
        await notified.promise;
        expect(await messageStore.epoch()).not.toBe(bounds!.latest.epoch);
        const events = received.filter((message) => message.type === 'event');
        expect(events.map((message) => message.cursor.position)).toEqual(mode === 'live' ? ['2', '3'] : ['1', '2']);
        expect(events.every((message) => message.cursor.epoch === bounds!.latest.epoch)).toBe(true);
        expect(received.at(-1)).toEqual(expect.objectContaining({ type: 'error', error: expect.objectContaining({ code: 'ProgressGap' }) }));
        const eose = received.find((message) => message.type === 'eose');
        if (mode === 'replay') {
          expect(eose?.cursor.epoch).toBe(bounds!.latest.epoch);
        } else {
          expect(eose).toBeUndefined();
        }
      } finally {
        await subscription.close();
      }
    });
  }

  it('should emit a gap before delivering rows if storage resets during the read', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await storeRecord(alice);
    const notified = createDeliveryGate();
    const received: SubscriptionMessage[] = [];
    const subscription = await eventLog.subscribe(alice.did, 'reset-during-read', (message): void => {
      received.push(message);
      notified.resolve();
    });
    const heldWakes: Wake[] = [];
    const publication = sinon.stub(wakePublisher, 'publish').callsFake((wake): void => { heldWakes.push(wake); });
    try {
      await storeRecord(alice);
    } finally {
      publication.restore();
    }
    // Model a concurrent reset after rows are scanned, before the store captures its result token.
    const tokenStore = messageStore as unknown as {
      buildToken(tenant: string, position: bigint, messageCid?: string): Promise<ProgressToken>;
    };
    const originalBuildToken = tokenStore.buildToken.bind(tokenStore);
    let reset = false;
    const token = sinon.stub(tokenStore, 'buildToken').callsFake(async (tenant, position, messageCid): Promise<ProgressToken> => {
      if (!reset && position === 2n) {
        reset = true;
        await messageStore.clear();
        await storeRecord(alice);
      }
      return originalBuildToken(tenant, position, messageCid);
    });
    try {
      wakePublisher.publish(heldWakes.at(-1)!);
      await notified.promise;
      expect(reset).toBe(true);
      expect(received).toEqual([expect.objectContaining({ type: 'error', error: expect.objectContaining({ code: 'ProgressGap' }) })]);
    } finally {
      token.restore();
      await subscription.close();
    }
  });

  it('should reject a page from a different stream before delivering its events', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const localWakePublisher = new EventEmitterWakePublisher();
    const store = new ScriptedFeedStore(alice.did, [await createLogEntry(alice, '1')], localWakePublisher);
    const log = new DurableEventLog(store, localWakePublisher, { idleRedrainIntervalMs: 0 });
    const originalRead = store.logRead.bind(store);
    const read = sinon.stub(store, 'logRead').callsFake(async (tenant, options): Promise<EventLogReadResult> => {
      const result = await originalRead(tenant, options);
      return { ...result, cursor: { ...result.cursor!, streamId: 'different-stream' } };
    });
    const notified = createDeliveryGate();
    const received: SubscriptionMessage[] = [];
    await log.open();
    try {
      await log.subscribe(alice.did, 'wrong-stream-page', (message): void => { received.push(message); notified.resolve(); });
      store.append(await createLogEntry(alice, '2'));
      localWakePublisher.publish({ tenant: alice.did, seq: '2' });
      await notified.promise;
      expect(received).toEqual([expect.objectContaining({ type: 'error', error: expect.objectContaining({ code: 'ProgressGap' }) })]);
    } finally {
      read.restore();
      await log.close();
    }
  });

  it('should close for a changed store epoch while retaining the tenant stream identity', async (): Promise<void> => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await storeRecord(alice);
    const beforeReset = await eventLog.getReplayBounds(alice.did);
    const notified = createDeliveryGate();
    const received: SubscriptionMessage[] = [];
    const subscription = await eventLog.subscribe(alice.did, 'reset-epoch', (message): void => {
      received.push(message);
      notified.resolve();
    });

    try {
      await messageStore.clear();
      await storeRecord(alice);
      await notified.promise;
      const afterReset = await eventLog.getReplayBounds(alice.did);
      expect(afterReset!.latest.streamId).toBe(beforeReset!.latest.streamId);
      expect(afterReset!.latest.epoch).not.toBe(beforeReset!.latest.epoch);
      expect(received).toEqual([expect.objectContaining({
        type   : 'error',
        cursor : beforeReset!.latest,
        error  : expect.objectContaining({ code: 'ProgressGap' }),
      })]);
    } finally {
      await subscription.close();
    }
  });

  it('should attach initial writes to non-initial RecordsWrite events', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const initial = await TestDataGenerator.generateRecordsWrite({ author: alice });
    const update = await TestDataGenerator.generateFromRecordsWrite({
      author        : alice,
      existingWrite : initial.recordsWrite,
    });

    await messageStore.put(alice.did, initial.message, await initial.recordsWrite.constructIndexes(false));
    const updatePut = await messageStore.put(alice.did, update.message, await update.recordsWrite.constructIndexes(true));

    const result = await eventLog.read(alice.did);
    const updateEntry = result.events.find(entry => entry.messageCid === updatePut.position!.messageCid);

    expect(updateEntry).toBeDefined();
    expect(updateEntry!.event.initialWrite).toBeDefined();
    expect(updateEntry!.event.initialWrite!.recordId).toBe(initial.message.recordId);
  });

  it('should attach initial writes to RecordsDelete events', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const initial = await TestDataGenerator.generateRecordsWrite({ author: alice });
    const recordsDelete = await TestDataGenerator.generateRecordsDelete({
      author   : alice,
      recordId : initial.message.recordId,
    });

    await messageStore.put(alice.did, initial.message, await initial.recordsWrite.constructIndexes(false));
    const deletePut = await messageStore.put(
      alice.did,
      recordsDelete.message,
      recordsDelete.recordsDelete.constructIndexes(initial.message, initial.message),
    );

    const result = await eventLog.read(alice.did);
    const deleteEntry = result.events.find(entry => entry.messageCid === deletePut.position!.messageCid);

    expect(deleteEntry).toBeDefined();
    expect(deleteEntry!.event.initialWrite).toBeDefined();
    expect(deleteEntry!.event.initialWrite!.recordId).toBe(initial.message.recordId);
  });

  it('should leave events readable when the initial write is no longer queryable', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const localWakePublisher = new EventEmitterWakePublisher();
    const initial = await TestDataGenerator.generateRecordsWrite({ author: alice });
    const update = await TestDataGenerator.generateFromRecordsWrite({
      author        : alice,
      existingWrite : initial.recordsWrite,
    });
    const indexes = await update.recordsWrite.constructIndexes(true);
    const scriptedStore = new ScriptedFeedStore(alice.did, [{
      seq        : '1',
      position   : '1',
      event      : { message: update.message },
      indexes,
      messageCid : await Message.getCid(update.message),
    }], localWakePublisher);
    const scriptedLog = new DurableEventLog(scriptedStore, localWakePublisher, { idleRedrainIntervalMs: 0 });

    await scriptedLog.open();
    const result = await scriptedLog.read(alice.did);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].event.message).toEqual(update.message);
    expect(result.events[0].event.initialWrite).toBeUndefined();
    await scriptedLog.close();
  });

  async function storeRecord(author: Persona): Promise<StoredRecord> {
    const record = await TestDataGenerator.generateRecordsWrite({ author });
    const indexes = await record.recordsWrite.constructIndexes(true);
    const putResult = await messageStore.put(author.did, record.message, indexes);

    return {
      ...record,
      messageCid : await Message.getCid(record.message),
      position   : putResult.position!.position,
    };
  }

  async function createLogEntry(author: Persona, position: string): Promise<EventLogEntry> {
    const record = await TestDataGenerator.generateRecordsWrite({ author });
    const indexes = await record.recordsWrite.constructIndexes(true);

    return {
      seq        : position,
      position,
      event      : { message: record.message },
      indexes,
      messageCid : await Message.getCid(record.message),
    };
  }
});
