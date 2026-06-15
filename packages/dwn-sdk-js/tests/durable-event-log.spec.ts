import type { GenerateRecordsWriteOutput, Persona } from './utils/test-data-generator.js';
import type { RecordsWriteMessage, SubscriptionMessage } from '../src/index.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { DurableEventLog } from '../src/event-stream/durable-event-log.js';
import { EventEmitterWakePublisher } from '../src/event-stream/event-emitter-wake-publisher.js';
import { Message } from '../src/core/message.js';
import { MessageStoreLevel } from '../src/store/message-store-level.js';
import { Poller } from './utils/poller.js';
import { TestDataGenerator } from './utils/test-data-generator.js';

type StoredRecord = GenerateRecordsWriteOutput & {
  messageCid: string;
  position: string;
};

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
});
