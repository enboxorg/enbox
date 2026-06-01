import type { MessagesReadMessage } from '../../src/types/messages-types.js';

import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Encoder } from '../../src/utils/encoder.js';
import { Jws } from '../../src/utils/jws.js';
import { Message } from '../../src/core/message.js';
import { MessagesRead } from '../../src/interfaces/messages-read.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName } from '../../src/enums/dwn-interface-method.js';

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

    it('includes permissionGrantIds in the descriptor when provided', async () => {
      const { author, message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      const grantId = 'grant-xyz-456';

      const messagesRead = await MessagesRead.create({
        signer             : await Jws.createSigner(author),
        messageCid,
        permissionGrantIds : [grantId],
      });

      expect((messagesRead.message as MessagesReadMessage).descriptor.permissionGrantIds).toEqual([grantId]);
    });

    it('includes canonical permissionGrantIds in the descriptor and signature payload when provided', async () => {
      const { author, message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);

      const messagesRead = await MessagesRead.create({
        signer             : await Jws.createSigner(author),
        messageCid,
        permissionGrantIds : ['grant-b', 'grant-a', 'grant-b'],
      });

      expect(messagesRead.message.descriptor.permissionGrantIds).toEqual(['grant-a', 'grant-b']);
      expect(messagesRead.signaturePayload!.permissionGrantIds).toEqual(['grant-a', 'grant-b']);
    });

    it('rejects empty permissionGrantIds', async () => {
      const { author, message } = await TestDataGenerator.generateRecordsWrite();

      await expect(MessagesRead.create({
        signer             : await Jws.createSigner(author),
        messageCid         : await Message.getCid(message),
        permissionGrantIds : [],
      })).rejects.toThrow(DwnErrorCode.MessagePermissionGrantIdsEmpty);
    });

    it('rejects creating a signature payload with both permission grant invocation fields', async () => {
      const { author, message: recordsWriteMessage } = await TestDataGenerator.generateRecordsWrite();
      const descriptor: MessagesReadMessage['descriptor'] = {
        interface        : DwnInterfaceName.Messages,
        method           : DwnMethodName.Read,
        messageTimestamp : TestDataGenerator.randomTimestamp(),
        messageCid       : await Message.getCid(recordsWriteMessage),
      };

      await expect(Message.createAuthorization({
        descriptor,
        signer             : await Jws.createSigner(author),
        permissionGrantId  : 'grant-a',
        permissionGrantIds : ['grant-a'],
      })).rejects.toThrow(DwnErrorCode.MessagePermissionGrantCreateInvocationAmbiguous);
    });

    it('rejects singular permissionGrantId in the descriptor', async () => {
      const { author, message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      const messagesRead = await MessagesRead.create({
        signer: await Jws.createSigner(author),
        messageCid,
      });
      const messageWithLegacyGrant = structuredClone(messagesRead.message) as any;
      messageWithLegacyGrant.descriptor.permissionGrantId = 'grant-a';

      await expect(MessagesRead.parse(messageWithLegacyGrant)).rejects.toThrow(DwnErrorCode.SchemaValidatorAdditionalPropertyNotAllowed);
    });

    it('does not include permissionGrantIds in the descriptor when not provided', async () => {
      const { author, message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);

      const messagesRead = await MessagesRead.create({
        signer: await Jws.createSigner(author),
        messageCid,
      });

      expect((messagesRead.message as MessagesReadMessage).descriptor.permissionGrantIds).toBeUndefined();
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

    it('rejects non-canonical permissionGrantIds in the descriptor and signature payload', async () => {
      const { author, message: recordsWriteMessage } = await TestDataGenerator.generateRecordsWrite();
      const signer = await Jws.createSigner(author);
      const descriptor: MessagesReadMessage['descriptor'] = {
        interface          : DwnInterfaceName.Messages,
        method             : DwnMethodName.Read,
        messageTimestamp   : TestDataGenerator.randomTimestamp(),
        messageCid         : await Message.getCid(recordsWriteMessage),
        permissionGrantIds : ['grant-b', 'grant-a'],
      };
      const authorization = await Message.createAuthorization({
        descriptor,
        signer,
        permissionGrantIds: ['grant-b', 'grant-a'],
      });

      await expect(MessagesRead.parse({ descriptor, authorization })).rejects.toThrow(DwnErrorCode.MessagePermissionGrantIdsNotCanonical);
    });

    it('rejects mismatched descriptor and signature payload permissionGrantIds', async () => {
      const { author, message: recordsWriteMessage } = await TestDataGenerator.generateRecordsWrite();
      const signer = await Jws.createSigner(author);
      const descriptor: MessagesReadMessage['descriptor'] = {
        interface          : DwnInterfaceName.Messages,
        method             : DwnMethodName.Read,
        messageTimestamp   : TestDataGenerator.randomTimestamp(),
        messageCid         : await Message.getCid(recordsWriteMessage),
        permissionGrantIds : ['grant-a', 'grant-b'],
      };
      const authorization = await Message.createAuthorization({
        descriptor,
        signer,
        permissionGrantIds: ['grant-a'],
      });

      await expect(MessagesRead.parse({ descriptor, authorization }))
        .rejects.toThrow(DwnErrorCode.MessagePermissionGrantIdsDescriptorPayloadMismatch);
    });

    it('rejects parsed signature payloads with both permission grant invocation fields', async () => {
      const { author, message: recordsWriteMessage } = await TestDataGenerator.generateRecordsWrite();
      const descriptor = {
        interface          : DwnInterfaceName.Messages,
        method             : DwnMethodName.Read,
        messageTimestamp   : TestDataGenerator.randomTimestamp(),
        messageCid         : await Message.getCid(recordsWriteMessage),
        permissionGrantId  : 'grant-a',
        permissionGrantIds : ['grant-a'],
      };
      const signature = await Message.createSignature(descriptor, await Jws.createSigner(author));
      const payload = Jws.decodePlainObjectPayload(signature);
      signature.payload = Encoder.bytesToBase64Url(Encoder.objectToBytes({
        ...payload,
        permissionGrantId  : 'grant-a',
        permissionGrantIds : ['grant-a'],
      }));

      await expect(Message.validateSignatureStructure(signature, descriptor as any))
        .rejects.toThrow(DwnErrorCode.MessagePermissionGrantValidateInvocationAmbiguous);
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
