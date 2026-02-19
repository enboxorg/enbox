import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { DateSort, Jws, Message, TestDataGenerator } from '@enbox/dwn-sdk-js';
import { getPaginationCursor, getRecordAuthor, getRecordMessageCid, getRecordProtocolRole } from '../src/utils.js';

describe('Utils', () => {
  beforeEach(() => {
    mock.restore();
  });

  afterAll(() => {
    mock.restore();
  });

  describe('getPaginationCursor', () => {
    it('should return a PaginationCursor object', async () => {
      // create a RecordWriteMessage object which is published
      const { message } = await TestDataGenerator.generateRecordsWrite({
        published: true,
      });

      const messageCid = await Message.getCid(message);

      // Published Ascending DateSort will get the datePublished as the cursor value
      const datePublishedAscendingCursor = await getPaginationCursor(message, DateSort.PublishedAscending);
      expect(datePublishedAscendingCursor).toEqual({
        value: message.descriptor.datePublished,
        messageCid,
      });

      // Published Descending DateSort will get the datePublished as the cursor value
      const datePublishedDescendingCursor = await getPaginationCursor(message, DateSort.PublishedDescending);
      expect(datePublishedDescendingCursor).toEqual({
        value: message.descriptor.datePublished,
        messageCid,
      });

      // Created Ascending DateSort will get the dateCreated as the cursor value
      const dateCreatedAscendingCursor = await getPaginationCursor(message, DateSort.CreatedAscending);
      expect(dateCreatedAscendingCursor).toEqual({
        value: message.descriptor.dateCreated,
        messageCid,
      });

      // Created Descending DateSort will get the dateCreated as the cursor value
      const dateCreatedDescendingCursor = await getPaginationCursor(message, DateSort.CreatedDescending);
      expect(dateCreatedDescendingCursor).toEqual({
        value: message.descriptor.dateCreated,
        messageCid,
      });
    });

    it('should fail for DateSort with PublishedAscending or PublishedDescending if the record is not published', async () => {
      // create a RecordWriteMessage object which is not published
      const { message } = await TestDataGenerator.generateRecordsWrite();

      // Published Ascending DateSort will get the datePublished as the cursor value
      try {
        await getPaginationCursor(message, DateSort.PublishedAscending);
        throw new Error('Expected getPaginationCursor to throw an error');
      } catch (error: any) {
        expect(error.message).toContain('The dateCreated or datePublished property is missing from the record descriptor.');
      }
    });
  });

  describe('getRecordMessageCid', () => {
    it('should get the CID of a RecordsWriteMessage', async () => {
      // create a RecordWriteMessage object
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);

      const messageCidFromFunction = await getRecordMessageCid(message);
      expect(messageCidFromFunction).toBe(messageCid);
    });
  });

  describe('getRecordAuthor', () => {
    it('should get the author of a RecordsWriteMessage', async () => {
      // create a RecordsWriteMessage object
      const { message: recordsWriteMessage, author: recordsWriteAuthor } = await TestDataGenerator.generateRecordsWrite();

      const writeAuthorFromFunction = getRecordAuthor(recordsWriteMessage);
      expect(writeAuthorFromFunction).toBeDefined();
      expect(writeAuthorFromFunction!).toBe(recordsWriteAuthor.did);

      // create a RecordsDeleteMessage
      const { message: recordsDeleteMessage, author: recordsDeleteAuthor } = await TestDataGenerator.generateRecordsDelete();

      const deleteAuthorFromFunction = getRecordAuthor(recordsDeleteMessage);
      expect(deleteAuthorFromFunction).toBeDefined();
      expect(deleteAuthorFromFunction!).toBe(recordsDeleteAuthor.did);
    });
  });

  describe('getRecordProtocolRole', () => {
    it('gets a protocol role from a RecordsWrite', async () => {
      const recordsWrite = await TestDataGenerator.generateRecordsWrite({ protocolRole: 'some-role' });
      const role = getRecordProtocolRole(recordsWrite.message);
      expect(role).toBe('some-role');
    });

    it('gets a protocol role from a RecordsDelete', async () => {
      const recordsDelete = await TestDataGenerator.generateRecordsDelete({ protocolRole: 'some-role' });
      const role = getRecordProtocolRole(recordsDelete.message);
      expect(role).toBe('some-role');
    });

    it('returns undefined if no role is defined', async () => {
      const recordsWrite = await TestDataGenerator.generateRecordsWrite();
      const writeRole = getRecordProtocolRole(recordsWrite.message);
      expect(writeRole).toBeUndefined();

      const recordsDelete = await TestDataGenerator.generateRecordsDelete();
      const deleteRole = getRecordProtocolRole(recordsDelete.message);
      expect(deleteRole).toBeUndefined();
    });

    it('returns undefined if decodedObject is undefined', async () => {
      spyOn(Jws, 'decodePlainObjectPayload').mockReturnValue(undefined);
      const recordsWrite = await TestDataGenerator.generateRecordsWrite();
      const writeRole = getRecordProtocolRole(recordsWrite.message);
      expect(writeRole).toBeUndefined();
    });
  });
});
