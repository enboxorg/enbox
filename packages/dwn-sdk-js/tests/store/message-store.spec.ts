import type { PaginationCursor } from '../../src/types/query-types.js';
import type { RecordsWriteMessage } from '../../src/types/records-types.js';
import type { KeyValues, MessageStore } from '../../src/index.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { lexicographicalCompare } from '../../src/utils/string.js';
import { Message } from '../../src/core/message.js';
import { SortDirection } from '../../src/types/query-types.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestStores } from '../test-stores.js';

let messageStore: MessageStore;

export function testMessageStore(): void {
  describe('Generic MessageStore Test Suite', () => {
    describe('put', function () {

      // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
      // so that different test suites can reuse the same backend store for testing
      beforeAll(async () => {
        const stores = TestStores.get();
        messageStore = stores.messageStore;
        await messageStore.open();
      });

      beforeEach(async () => {
        await messageStore.clear(); // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
      });

      afterAll(async () => {
        await messageStore.close();
      });

      it('should accept the same message twice (idempotent put)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { message } = await TestDataGenerator.generateRecordsWrite();
        const { messageTimestamp } = message.descriptor;

        // First put — should succeed.
        await messageStore.put(alice.did, message, { messageTimestamp });

        // Second put of the exact same message — should be a no-op.
        // This can happen when sync or protocol.send() re-delivers a
        // message the DWN already has (race between CID check and insert).
        await messageStore.put(alice.did, message, { messageTimestamp });

        // Verify the message is stored exactly once.
        const cid = await Message.getCid(message);
        const stored = await messageStore.get(alice.did, cid);
        expect(stored).toBeDefined();
      });

      it('stores messages as cbor/sha256 encoded blocks with CID as key', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await TestDataGenerator.generateRecordsWrite();
        const { messageTimestamp } = message.descriptor;

        await messageStore.put(alice.did, message, { messageTimestamp });

        const expectedCid = await Message.getCid(message);

        const jsonMessage = (await messageStore.get(alice.did, expectedCid))!;
        const resultCid = await Message.getCid(jsonMessage);

        expect(resultCid).toBe(expectedCid);
      });

      it('should not mutate the caller message when storing inline encodedData', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await TestDataGenerator.generateRecordsWrite();
        const messageWithInlineData = { ...message, encodedData: 'c29tZSBkYXRh' } as RecordsWriteMessage & { encodedData: string };
        const { messageTimestamp } = message.descriptor;

        await messageStore.put(alice.did, messageWithInlineData, { messageTimestamp });

        expect(messageWithInlineData.encodedData).toBe('c29tZSBkYXRh');

        const expectedCid = await Message.getCid(message);
        const storedMessage = await messageStore.get(alice.did, expectedCid) as RecordsWriteMessage & { encodedData?: string };
        expect(storedMessage.encodedData).toBe('c29tZSBkYXRh');
      });

      // https://github.com/enboxorg/enbox/issues/170
      it('#170 - should be able to update (delete and insert new) indexes to an existing message', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await TestDataGenerator.generateRecordsWrite();
        const { messageTimestamp } = message.descriptor;

        // inserting the message indicating it is the latest base state
        await messageStore.put(alice.did, message, { isLatestBaseState: true, messageTimestamp });

        const { messages: results1 } = await messageStore.query(alice.did, [{ isLatestBaseState: true }]);
        expect(results1.length).toBe(1);

        const { messages: results2 } = await messageStore.query(alice.did, [{ isLatestBaseState: false }]);
        expect(results2.length).toBe(0);

        // deleting the existing indexes and replacing it indicating it is no longer the latest base state
        const cid = await Message.getCid(message);
        await messageStore.delete(alice.did, cid);
        await messageStore.put(alice.did, message, { isLatestBaseState: false, messageTimestamp });

        const { messages: results3 } = await messageStore.query(alice.did, [{ isLatestBaseState: true }]);
        expect(results3.length).toBe(0);

        const { messages: results4 } = await messageStore.query(alice.did, [{ isLatestBaseState: false }]);
        expect(results4.length).toBe(1);
      });

      it('should update indexes in place and clear stale index columns', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const oldSchema = 'https://schema.org/OldIndex';
        const newSchema = 'https://schema.org/NewIndex';
        const { message, recordsWrite } = await TestDataGenerator.generateRecordsWrite({ schema: oldSchema });
        const messageCid = await Message.getCid(message);
        const initialIndexes: KeyValues = {
          ...await recordsWrite.constructIndexes(true),
          attester: 'did:example:attester',
        };
        const replacementIndexes: KeyValues = {
          ...initialIndexes,
          isLatestBaseState : false,
          schema            : newSchema,
        };
        delete replacementIndexes.attester;

        await messageStore.put(alice.did, message, initialIndexes);
        expect((await messageStore.query(alice.did, [{ attester: 'did:example:attester' }])).messages.length).toBe(1);
        await messageStore.updateIndexes(alice.did, messageCid, replacementIndexes);

        expect((await messageStore.query(alice.did, [{ schema: oldSchema }])).messages.length).toBe(0);
        expect((await messageStore.query(alice.did, [{ schema: newSchema }])).messages.length).toBe(1);
        expect((await messageStore.query(alice.did, [{ attester: 'did:example:attester' }])).messages.length).toBe(0);
        expect((await messageStore.query(alice.did, [{ isLatestBaseState: true }])).messages.length).toBe(0);
        expect((await messageStore.query(alice.did, [{ isLatestBaseState: false }])).messages.length).toBe(1);
        expect(await messageStore.get(alice.did, messageCid)).toBeDefined();
      });

      it('should replace a same-CID message payload and reject CID mismatches', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const oldSchema = 'https://schema.org/OldPayload';
        const newSchema = 'https://schema.org/NewPayload';
        const { message, recordsWrite } = await TestDataGenerator.generateRecordsWrite({ schema: oldSchema });
        const messageCid = await Message.getCid(message);
        const messageWithInlineData = { ...message, encodedData: 'c29tZSBkYXRh' } as RecordsWriteMessage & { encodedData: string };
        const retainedIndexes = await recordsWrite.constructIndexes(false);
        const replacementIndexes: KeyValues = {
          ...retainedIndexes,
          schema: newSchema,
        };

        await messageStore.put(alice.did, messageWithInlineData, await recordsWrite.constructIndexes(true));
        await messageStore.updateMessageAndIndexes(alice.did, messageCid, message, replacementIndexes);

        const storedMessage = await messageStore.get(alice.did, messageCid) as RecordsWriteMessage & { encodedData?: string };
        expect(storedMessage.encodedData).toBeUndefined();
        expect((await messageStore.query(alice.did, [{ schema: oldSchema }])).messages.length).toBe(0);
        expect((await messageStore.query(alice.did, [{ schema: newSchema }])).messages.length).toBe(1);

        const { message: otherMessage } = await TestDataGenerator.generateRecordsWrite({ schema: newSchema });
        await expect(messageStore.updateMessageAndIndexes(alice.did, messageCid, otherMessage, replacementIndexes))
          .rejects.toThrow(DwnErrorCode.MessageStoreUpdateMessageAndIndexesCidMismatch);
      });

      it('should complete dataless rows once and reject repeated inline completion', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const oldSchema = 'https://schema.org/Dataless';
        const newSchema = 'https://schema.org/Completed';
        const { message, recordsWrite } = await TestDataGenerator.generateRecordsWrite({ schema: oldSchema });
        const messageCid = await Message.getCid(message);
        const latestIndexes = await recordsWrite.constructIndexes(true);
        const replacementIndexes: KeyValues = {
          ...latestIndexes,
          schema: newSchema,
        };

        await messageStore.put(alice.did, message, await recordsWrite.constructIndexes(false));
        await messageStore.completeData(alice.did, messageCid, replacementIndexes, 'aGVsbG8');

        const storedMessage = await messageStore.get(alice.did, messageCid) as RecordsWriteMessage & { encodedData?: string };
        expect(storedMessage.encodedData).toBe('aGVsbG8');
        expect((await messageStore.query(alice.did, [{ schema: oldSchema }])).messages.length).toBe(0);
        expect((await messageStore.query(alice.did, [{ schema: newSchema }])).messages.length).toBe(1);

        await expect(messageStore.completeData(alice.did, messageCid, replacementIndexes, 'aGVsbG8'))
          .rejects.toThrow(DwnErrorCode.MessageStoreCompleteDataAlreadyStamped);
      });

      it('should index properties with characters beyond just letters and digits', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const schema = 'http://my-awesome-schema/awesomeness_schema';
        const { message } = await TestDataGenerator.generateRecordsWrite({ schema });
        const { messageTimestamp } = message.descriptor;

        await messageStore.put(alice.did, message, { schema, messageTimestamp });

        const { messages: results } = await messageStore.query(alice.did, [{ schema }]);
        expect((results[0] as RecordsWriteMessage).descriptor.schema).toBe(schema);
      });

      it('should not store anything if aborted beforehand', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await TestDataGenerator.generateRecordsWrite();
        const { messageTimestamp } = message.descriptor;

        const controller = new AbortController();
        controller.signal.throwIfAborted = (): void => { }; // simulate aborting happening async
        controller.abort('reason');

        try {
          await messageStore.put(alice.did, message, { messageTimestamp }, { signal: controller.signal });
        } catch (e) {
          expect(e).toBe('reason');
        }

        const expectedCid = await Message.getCid(message);

        const jsonMessage = await messageStore.get(alice.did, expectedCid);
        expect(jsonMessage).toBe(undefined);
      });

      it('should not index anything if aborted during', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const schema = 'http://my-awesome-schema/awesomeness_schema#awesome-1?id=awesome_1';
        const { message } = await TestDataGenerator.generateRecordsWrite({ schema });
        const { messageTimestamp } = message.descriptor;

        const controller = new AbortController();
        queueMicrotask(() => {
          controller.abort('reason');
        });

        try {
          await messageStore.put(alice.did, message, { schema, messageTimestamp }, { signal: controller.signal });
        } catch (e) {
          expect(e).toBe('reason');
        }

        // index should not return the message
        const { messages: results } = await messageStore.query(alice.did, [{ schema }]);
        expect(results.length).toBe(0);

        // check that message doesn't exist
        const messageCid = await Message.getCid(message);
        const fetchedMessage = await messageStore.get(alice.did, messageCid);
        expect(fetchedMessage).toBeUndefined();
      });

      it('should not store anything if aborted beforehand', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await TestDataGenerator.generateRecordsWrite();
        const { messageTimestamp } = message.descriptor;

        const controller = new AbortController();
        controller.signal.throwIfAborted = (): void => { }; // simulate aborting happening async
        controller.abort('reason');

        try {
          await messageStore.put(alice.did, message, { messageTimestamp }, { signal: controller.signal });
        } catch (e) {
          expect(e).toBe('reason');
        }

        const expectedCid = await Message.getCid(message);

        const jsonMessage = await messageStore.get(alice.did, expectedCid);
        expect(jsonMessage).toBe(undefined);
      });

      it('should not delete if aborted', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await TestDataGenerator.generateRecordsWrite();
        const { messageTimestamp } = message.descriptor;
        await messageStore.put(alice.did, message, { isLatestBaseState: true, messageTimestamp });

        const messageCid = await Message.getCid(message);
        const resultsAlice1 = await messageStore.get(alice.did, messageCid);
        expect((resultsAlice1 as RecordsWriteMessage).recordId).toBe((message as RecordsWriteMessage).recordId);

        const controller = new AbortController();
        controller.signal.throwIfAborted = (): void => { }; // simulate aborting happening async
        controller.abort('reason');

        // aborted delete
        const deletePromise = messageStore.delete(alice.did, messageCid, { signal: controller.signal });
        await expect(deletePromise).rejects.toThrow('reason');
      });

      it('should not delete the message of another tenant', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await TestDataGenerator.generateRecordsWrite();
        const { messageTimestamp } = message.descriptor;
        await messageStore.put(alice.did, message, { isLatestBaseState: true, messageTimestamp });
        await messageStore.put(bob.did, message, { isLatestBaseState: true, messageTimestamp });

        const messageCid = await Message.getCid(message);
        const resultsAlice1 = await messageStore.get(alice.did, messageCid);
        expect((resultsAlice1 as RecordsWriteMessage).recordId).toBe((message as RecordsWriteMessage).recordId);
        const resultsBob1 = await messageStore.get(bob.did, messageCid);
        expect((resultsBob1 as RecordsWriteMessage).recordId).toBe((message as RecordsWriteMessage).recordId);

        // bob deletes message
        await messageStore.delete(bob.did, messageCid);
        const resultsBob2 = await messageStore.get(bob.did, messageCid);
        expect(resultsBob2).toBeUndefined();

        //expect alice to retain the message
        const resultsAlice2 = await messageStore.get(alice.did, messageCid);
        expect((resultsAlice2 as RecordsWriteMessage).recordId).toBe((message as RecordsWriteMessage).recordId);
      });

      it('should not clear the MessageStore index of another tenant', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await TestDataGenerator.generateRecordsWrite();
        const { messageTimestamp } = message.descriptor;

        await messageStore.put(alice.did, message, { isLatestBaseState: true, messageTimestamp });
        await messageStore.put(bob.did, message, { isLatestBaseState: true, messageTimestamp });

        const messageCid = await Message.getCid(message);
        const resultsAlice1 = await messageStore.query(alice.did, [{ isLatestBaseState: true }]);
        expect(resultsAlice1.messages.length).toBe(1);
        const resultsBob1 = await messageStore.query(bob.did, [{ isLatestBaseState: true }]);
        expect(resultsBob1.messages.length).toBe(1);

        // bob deletes message
        await messageStore.delete(bob.did, messageCid);
        const resultsBob2 = await messageStore.query(bob.did, [{ isLatestBaseState: true }]);
        expect(resultsBob2.messages.length).toBe(0);

        //expect alice to retain the message
        const resultsAlice2 = await messageStore.query(alice.did, [{ isLatestBaseState: true }]);
        expect(resultsAlice2.messages.length).toBe(1);
      });
    });

    describe('sort and pagination', () => {

      // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
      // so that different test suites can reuse the same backend store for testing
      beforeAll(async () => {
        const stores = TestStores.get();
        messageStore = stores.messageStore;
        await messageStore.open();
      });

      beforeEach(async () => {
        await messageStore.clear(); // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
      });

      afterAll(async () => {
        await messageStore.close();
      });

      describe('sorting', () => {
        it('should sort on messageTimestamp Ascending if no sort is specified', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();

          const messages = await Promise.all(Array(10).fill({}).map((_) => TestDataGenerator.generateRecordsWrite({
            messageTimestamp: TestDataGenerator.randomTimestamp()
          })));
          for (const message of messages) {
            await messageStore.put(alice.did, message.message, await message.recordsWrite.constructIndexes(true));
          }

          const { messages: messageQuery } = await messageStore.query(alice.did, [{}]);
          expect(messageQuery.length).toBe(messages.length);

          const sortedRecords = messages.sort((a,b) =>
            lexicographicalCompare(a.message.descriptor.messageTimestamp, b.message.descriptor.messageTimestamp));
          for (let i = 0; i < sortedRecords.length; i++) {
            expect(sortedRecords[i].message.descriptor.messageTimestamp).toBe(messageQuery[i].descriptor.messageTimestamp);
          }
        });

        it('should sort on messageTimestamp Ascending', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();

          const messages = await Promise.all(Array(10).fill({}).map((_) => TestDataGenerator.generateRecordsWrite({
            messageTimestamp: TestDataGenerator.randomTimestamp()
          })));
          for (const message of messages) {
            await messageStore.put(alice.did, message.message, await message.recordsWrite.constructIndexes(true));
          }
          const { messages: messageQuery } = await messageStore.query(alice.did, [{}], { messageTimestamp: SortDirection.Ascending });
          expect(messageQuery.length).toBe(messages.length);

          const sortedRecords = messages.sort((a,b) =>
            lexicographicalCompare(a.message.descriptor.messageTimestamp, b.message.descriptor.messageTimestamp));
          for (let i = 0; i < messages.length; i++) {
            expect(sortedRecords[i].message.descriptor.messageTimestamp).toBe(messageQuery[i].descriptor.messageTimestamp);
          }
        });

        it('should sort on dateCreated Ascending', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const messages = await Promise.all(Array(10).fill({}).map((_) => TestDataGenerator.generateRecordsWrite({
            dateCreated: TestDataGenerator.randomTimestamp(),
          })));
          for (const message of messages) {
            await messageStore.put(alice.did, message.message, await message.recordsWrite.constructIndexes(true));
          }

          const { messages: messageQuery } = await messageStore.query(alice.did, [{}], { dateCreated: SortDirection.Ascending });
          expect(messageQuery.length).toBe(messages.length);

          const sortedRecords = messages.sort((a,b) =>
            lexicographicalCompare(a.message.descriptor.dateCreated, b.message.descriptor.dateCreated));

          for (let i = 0; i < messages.length; i++) {
            expect(await Message.getCid(sortedRecords[i].message)).toBe(await Message.getCid(messageQuery[i]));
          }
        });

        it('should sort on dateCreated Descending', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const messages = await Promise.all(Array(10).fill({}).map((_) => TestDataGenerator.generateRecordsWrite({
            dateCreated: TestDataGenerator.randomTimestamp(),
          })));
          for (const message of messages) {
            await messageStore.put(alice.did, message.message, await message.recordsWrite.constructIndexes(true));
          }

          const { messages: messageQuery } = await messageStore.query(alice.did, [{}], { dateCreated: SortDirection.Descending });
          expect(messageQuery.length).toBe(messages.length);

          const sortedRecords = messages.sort((a,b) =>
            lexicographicalCompare(b.message.descriptor.dateCreated, a.message.descriptor.dateCreated));

          for (let i = 0; i < messages.length; i++) {
            expect(await Message.getCid(sortedRecords[i].message)).toBe(await Message.getCid(messageQuery[i]));
          }
        });

        it('should sort on datePublished Ascending', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const messages = await Promise.all(Array(10).fill({}).map((_) => TestDataGenerator.generateRecordsWrite({
            published     : true,
            datePublished : TestDataGenerator.randomTimestamp()
          })));
          for (const message of messages) {
            await messageStore.put(alice.did, message.message, await message.recordsWrite.constructIndexes(true));
          }

          const { messages: messageQuery } = await messageStore.query(alice.did, [{}], { datePublished: SortDirection.Ascending });
          expect(messageQuery.length).toBe(messages.length);

          const sortedRecords = messages.sort((a,b) =>
            lexicographicalCompare(a.message.descriptor.datePublished!, b.message.descriptor.datePublished!));

          for (let i = 0; i < messages.length; i++) {
            expect(await Message.getCid(sortedRecords[i].message)).toBe(await Message.getCid(messageQuery[i]));
          }
        });

        it('should sort on datePublished Descending', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const messages = await Promise.all(Array(10).fill({}).map((_) => TestDataGenerator.generateRecordsWrite({
            published     : true,
            datePublished : TestDataGenerator.randomTimestamp()
          })));
          for (const message of messages) {
            await messageStore.put(alice.did, message.message, await message.recordsWrite.constructIndexes(true));
          }

          const { messages: messageQuery } = await messageStore.query(alice.did, [{}], { datePublished: SortDirection.Descending });
          expect(messageQuery.length).toBe(messages.length);

          const sortedRecords = messages.sort((a,b) =>
            lexicographicalCompare(b.message.descriptor.datePublished!, a.message.descriptor.datePublished!));

          for (let i = 0; i < messages.length; i++) {
            expect(await Message.getCid(sortedRecords[i].message)).toBe(await Message.getCid(messageQuery[i]));
          }
        });
      });

      describe('pagination', () => {
        it('should return all records if no limit is specified', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const messages = await Promise.all(Array(10).fill({}).map((_) => TestDataGenerator.generateRecordsWrite({
            messageTimestamp: TestDataGenerator.randomTimestamp()
          })));
          for (const message of messages) {
            await messageStore.put(alice.did, message.message, await message.recordsWrite.constructIndexes(true));
          }

          const { messages: limitQuery } = await messageStore.query(alice.did, [{}]);
          expect(limitQuery.length).toBe(messages.length);
        });

        it('should limit records', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const messages = await Promise.all(Array(10).fill({}).map((_) => TestDataGenerator.generateRecordsWrite({
            messageTimestamp: TestDataGenerator.randomTimestamp()
          })));
          for (const message of messages) {
            await messageStore.put(alice.did, message.message, await message.recordsWrite.constructIndexes(true));
          }

          const sortedRecords = messages.sort((a,b) =>
            lexicographicalCompare(a.message.descriptor.messageTimestamp, b.message.descriptor.messageTimestamp));

          const limit = 5;

          const { messages: limitQuery } = await messageStore.query(alice.did, [{}], {}, { limit });
          expect(limitQuery.length).toBe(limit);
          for (let i = 0; i < limitQuery.length; i++) {
            expect(await Message.getCid(sortedRecords[i].message)).toBe(await Message.getCid(limitQuery[i]));
          }
        });

        it('should only return a cursor if there are additional results', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const messages = await Promise.all(Array(10).fill({}).map((_) => TestDataGenerator.generateRecordsWrite({
            messageTimestamp: TestDataGenerator.randomTimestamp()
          })));
          for (const message of messages) {
            await messageStore.put(alice.did, message.message, await message.recordsWrite.constructIndexes(true));
          }

          // get all of the records
          const allRecords = await messageStore.query(alice.did, [{}], {}, { limit: 10 });
          expect(allRecords.cursor).toBeUndefined();

          // get only partial records
          const partialRecords = await messageStore.query(alice.did, [{}], {}, { limit: 5 });
          expect(partialRecords.cursor).toBeDefined();
        });

        it('should return all records from the cursor onwards when no limit is provided', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const messages = await Promise.all(Array(13).fill({}).map((_) => TestDataGenerator.generateRecordsWrite({
            messageTimestamp: TestDataGenerator.randomTimestamp()
          })));
          for (const message of messages) {
            await messageStore.put(alice.did, message.message, await message.recordsWrite.constructIndexes(true));
          }

          const sortedRecords = messages.sort((a,b) =>
            lexicographicalCompare(a.message.descriptor.messageTimestamp, b.message.descriptor.messageTimestamp));

          // we make an initial request to get one record and a cursor.
          const { cursor } = await messageStore.query(alice.did, [{}], {}, { limit: 1 });

          const { messages: limitQuery } = await messageStore.query(alice.did, [{}], {}, { cursor });
          expect(limitQuery.length).toBe(sortedRecords.slice(1).length);
          for (let i = 0; i < limitQuery.length; i++) {
            const offsetIndex = i + 1; // offset for the initial request item
            expect(await Message.getCid(sortedRecords[offsetIndex].message)).toBe(await Message.getCid(limitQuery[i]));
          }
        });

        it('should limit records when a cursor and limit are provided', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const messages = await Promise.all(Array(10).fill({}).map((_) => TestDataGenerator.generateRecordsWrite({
            messageTimestamp: TestDataGenerator.randomTimestamp()
          })));
          for (const message of messages) {
            await messageStore.put(alice.did, message.message, await message.recordsWrite.constructIndexes(true));
          }

          const sortedRecords = messages.sort((a,b) =>
            lexicographicalCompare(a.message.descriptor.messageTimestamp, b.message.descriptor.messageTimestamp));

          // we make an initial request to get one record and a cursor.
          const { cursor } = await messageStore.query(alice.did, [{}], {}, { limit: 1 });

          const limit = 3;
          const { messages: limitQuery } = await messageStore.query(alice.did, [{}], {}, { cursor, limit });
          expect(limitQuery.length).toBe(limit);
          for (let i = 0; i < limitQuery.length; i++) {
            const offsetIndex = i + 1; // offset for the initial request item
            expect(await Message.getCid(sortedRecords[offsetIndex].message)).toBe(await Message.getCid(limitQuery[i]));
          }
        });

        it('should paginate through all of the records', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const messages = await Promise.all(Array(23).fill({}).map((_) => TestDataGenerator.generateRecordsWrite({
            messageTimestamp: TestDataGenerator.randomTimestamp()
          })));
          for (const message of messages) {
            await messageStore.put(alice.did, message.message, await message.recordsWrite.constructIndexes(true));
          }

          const limit = 6;
          const results = [];
          let cursor: PaginationCursor | undefined;
          while (true) {
            const { messages: limitQuery, cursor: queryCursor } = await messageStore.query(alice.did, [{}], {}, { cursor, limit });
            expect(limitQuery.length).toBeLessThanOrEqual(limit);
            results.push(...limitQuery);
            cursor = queryCursor;
            if (cursor === undefined) {
              break;
            }
          }
          expect(results.length).toBe(messages.length);
          const messageMessageIds = await Promise.all(messages.map(m => Message.getCid(m.message)));
          const resultMessageIds = await Promise.all(results.map(m => Message.getCid(m)));
          for (const recordId of messageMessageIds) {
            expect(resultMessageIds.includes(recordId)).toBe(true);
          }
        });
      });
    });

    describe('count', () => {
      beforeAll(async () => {
        const stores = TestStores.get();
        messageStore = stores.messageStore;
        await messageStore.open();
      });

      beforeEach(async () => {
        await messageStore.clear();
      });

      afterAll(async () => {
        await messageStore.close();
      });

      it('should return 0 when no messages match', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const count = await messageStore.count(alice.did, [{ schema: 'nonexistent' }]);
        expect(count).toBe(0);
      });

      it('should count all matching messages', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const schema = 'https://schema.org/CountTest';
        for (let i = 0; i < 10; i++) {
          const { message, recordsWrite } = await TestDataGenerator.generateRecordsWrite({ schema });
          await messageStore.put(alice.did, message, await recordsWrite.constructIndexes(true));
        }

        // also insert messages with a different schema
        for (let i = 0; i < 5; i++) {
          const { message, recordsWrite } = await TestDataGenerator.generateRecordsWrite({ schema: 'https://schema.org/Other' });
          await messageStore.put(alice.did, message, await recordsWrite.constructIndexes(true));
        }

        const count = await messageStore.count(alice.did, [{ schema }]);
        expect(count).toBe(10);
      });

      it('should count all messages when filter is empty', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        for (let i = 0; i < 7; i++) {
          const { message, recordsWrite } = await TestDataGenerator.generateRecordsWrite();
          await messageStore.put(alice.did, message, await recordsWrite.constructIndexes(true));
        }

        const count = await messageStore.count(alice.did, [{}]);
        expect(count).toBe(7);
      });

      it('should not count messages from another tenant', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const schema = 'https://schema.org/TenantTest';

        for (let i = 0; i < 3; i++) {
          const { message, recordsWrite } = await TestDataGenerator.generateRecordsWrite({ schema });
          await messageStore.put(alice.did, message, await recordsWrite.constructIndexes(true));
        }
        for (let i = 0; i < 5; i++) {
          const { message, recordsWrite } = await TestDataGenerator.generateRecordsWrite({ schema });
          await messageStore.put(bob.did, message, await recordsWrite.constructIndexes(true));
        }

        const aliceCount = await messageStore.count(alice.did, [{ schema }]);
        expect(aliceCount).toBe(3);

        const bobCount = await messageStore.count(bob.did, [{ schema }]);
        expect(bobCount).toBe(5);
      });

      it('should count with OR (multi-filter) queries', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const schema1 = 'https://schema.org/Type1';
        const schema2 = 'https://schema.org/Type2';

        for (let i = 0; i < 4; i++) {
          const { message, recordsWrite } = await TestDataGenerator.generateRecordsWrite({ schema: schema1 });
          await messageStore.put(alice.did, message, await recordsWrite.constructIndexes(true));
        }
        for (let i = 0; i < 3; i++) {
          const { message, recordsWrite } = await TestDataGenerator.generateRecordsWrite({ schema: schema2 });
          await messageStore.put(alice.did, message, await recordsWrite.constructIndexes(true));
        }

        const count = await messageStore.count(alice.did, [{ schema: schema1 }, { schema: schema2 }]);
        expect(count).toBe(7);
      });
    });
  });
}
