import { MessagesSubscribe } from '../../src/interfaces/messages-subscribe.js';
import { DwnErrorCode, DwnInterfaceName, DwnMethodName, Jws, TestDataGenerator, Time } from '../../src/index.js';

import { describe, expect, it } from 'bun:test';

describe('MessagesSubscribe', () => {
  describe('create()', () => {
    it('should be able to create and authorize MessagesSubscribe', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const timestamp = Time.getCurrentTimestamp();
      const messagesSubscribe = await MessagesSubscribe.create({
        signer           : Jws.createSigner(alice),
        messageTimestamp : timestamp,
      });

      const message = messagesSubscribe.message;
      expect(message.descriptor.interface).toEqual(DwnInterfaceName.Messages);
      expect(message.descriptor.method).toEqual(DwnMethodName.Subscribe);
      expect(message.authorization).toBeDefined();
      expect(message.descriptor.messageTimestamp).toBe(timestamp);
    });

    it('should reject a filter with exact and prefix protocol paths', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      await expect(MessagesSubscribe.create({
        signer  : Jws.createSigner(alice),
        filters : [{
          protocol           : 'http://example.com/protocol',
          protocolPath       : 'post/attachment',
          protocolPathPrefix : 'post',
        }],
      })).rejects.toThrow(DwnErrorCode.SchemaValidatorFailure);
    });
  });
});
