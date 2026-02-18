import type { MessagesReadMessage } from '../../src/index.js';

import { Message } from '../../src/core/message.js';
import { MessagesRead } from '../../src/index.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { describe, expect, it } from 'bun:test';
import { DwnErrorCode, Jws } from '../../src/index.js';

describe('MessagesRead Message', () => {
  describe('create', () => {
    it('creates a MessagesRead message', async () => {
      const { author, message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      const messageTimestamp = TestDataGenerator.randomTimestamp();

      const messagesRead = await MessagesRead.create({
        signer     : await Jws.createSigner(author),
        messageCid : messageCid,
        messageTimestamp,
      });

      expect(messagesRead.message.authorization).toBeDefined();
      expect(messagesRead.message.descriptor).toBeDefined();
      expect(messagesRead.message.descriptor.messageCid).toBe(messageCid);
      expect(messagesRead.message.descriptor.messageTimestamp).toBe(messageTimestamp);
    });

    it('includes permissionGrantId in the descriptor when provided', async () => {
      const { author, message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      const grantId = 'grant-xyz-456';

      const messagesRead = await MessagesRead.create({
        signer            : await Jws.createSigner(author),
        messageCid,
        permissionGrantId : grantId,
      });

      expect((messagesRead.message as MessagesReadMessage).descriptor.permissionGrantId).toBe(grantId);
    });

    it('does not include permissionGrantId in the descriptor when not provided', async () => {
      const { author, message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);

      const messagesRead = await MessagesRead.create({
        signer: await Jws.createSigner(author),
        messageCid,
      });

      expect((messagesRead.message as MessagesReadMessage).descriptor.permissionGrantId).toBeUndefined();
    });

    it('throws an error if an invalid CID is provided', async () => {
      const alice = await TestDataGenerator.generatePersona();

      try {
        await MessagesRead.create({
          signer     : await Jws.createSigner(alice),
          messageCid : 'abcd'
        });

        throw new Error('Expected an error to be thrown');
      } catch (e: any) {
        expect(e.message).toContain(DwnErrorCode.MessagesReadInvalidCid);
      }
    });
  });

  describe('parse', () => {
    it('parses a message into a MessagesRead instance', async () => {
      const { author, message } = await TestDataGenerator.generateRecordsWrite();
      let messageCid = await Message.getCid(message);

      const messagesRead = await MessagesRead.create({
        signer     : await Jws.createSigner(author),
        messageCid : messageCid
      });

      const parsed = await MessagesRead.parse(messagesRead.message);
      expect(parsed).toBeInstanceOf(MessagesRead);

      const expectedMessageCid = await Message.getCid(messagesRead.message);
      messageCid = await Message.getCid(parsed.message);

      expect(messageCid).toBe(expectedMessageCid);
    });

    it('throws an exception if messageCids contains an invalid cid', async () => {
      const { author, message: recordsWriteMessage } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(recordsWriteMessage);

      const messagesRead = await MessagesRead.create({
        signer     : await Jws.createSigner(author),
        messageCid : messageCid
      });

      const message = messagesRead.toJSON() as MessagesReadMessage;
      message.descriptor.messageCid = 'abcd';

      try {
        await MessagesRead.parse(message);

        throw new Error('Expected an error to be thrown');
      } catch (e: any) {
        expect(e.message).toContain('is not a valid CID');
      }
    });
  });
});
