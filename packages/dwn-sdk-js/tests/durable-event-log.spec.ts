import type { DurableEventLogStore } from '../src/event-stream/durable-event-log.js';
import type { Filter } from '../src/types/query-types.js';
import type { GenericMessage } from '../src/types/message-types.js';
import type { EventLogEntry, EventLogReadOptions, EventLogReadResult, ProgressGapInfo, ProgressToken } from '../src/types/subscriptions.js';
import type { GenerateRecordsWriteOutput, Persona } from './utils/test-data-generator.js';
import type { RecordsWriteMessage, SubscriptionMessage } from '../src/index.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { DurableEventLog } from '../src/event-stream/durable-event-log.js';
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

class ScriptedFeedStore implements DurableEventLogStore {
  private readonly epochValue: string = crypto.randomUUID();
  private wakeDuringNextRead?: EventLogEntry;
  public throwGapOnNextRead: boolean = false;

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

  it('should emit redelivery events at the redelivery cursor position', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const record = await TestDataGenerator.generateRecordsWrite({ author: alice });
    const message = { ...record.message } as RecordsWriteMessage & { encodedData?: string };
    delete message.encodedData;

    const messageCid = await Message.getCid(message);
    const indexes = await record.recordsWrite.constructIndexes(true);
    const initialPut = await messageStore.put(alice.did, message, { ...indexes, isLatestBaseState: false });
    const completion = await messageStore.completeData(
      alice.did,
      messageCid,
      indexes,
      (record.message as RecordsWriteMessage & { encodedData?: string }).encodedData
    );
    expect(completion.position!.position).toBe('2');

    const received: SubscriptionMessage[] = [];
    await eventLog.subscribe(alice.did, 'redelivery-subscription', (message): void => {
      received.push(message);
    }, { cursor: initialPut.position! });

    expect(received[0]).toEqual(expect.objectContaining({
      type : 'event',
      seq  : '1',
      messageCid,
    }));
    const redeliveryEvent = received[0];
    expect(redeliveryEvent.type).toBe('event');
    if (redeliveryEvent.type !== 'event') {
      throw new Error('expected a redelivery event');
    }
    expect(redeliveryEvent.encodedData).toBe((record.message as RecordsWriteMessage & { encodedData?: string }).encodedData);
    expect((redeliveryEvent.event.message as RecordsWriteMessage & { encodedData?: string }).encodedData).toBeUndefined();
    expect(redeliveryEvent.cursor.position).toBe('2');
    expect(received[1]).toEqual(expect.objectContaining({ type: 'eose' }));
    expect(received[1].cursor.position).toBe('2');
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
