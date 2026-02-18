import dexProtocolDefinition from '../vectors/protocol-definitions/dex.json' with { type: 'json' };
import { Jws } from '../../src/utils/jws.js';
import { RecordsSubscribe } from '../../src/interfaces/records-subscribe.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { Time } from '../../src/utils/time.js';
import { describe, expect, it } from 'bun:test';

describe('RecordsSubscribe', () => {
  describe('create()', () => {
    it('should not allow published to be set to false with a datePublished filter also set', async () => {
      // test control
      const randomDate = TestDataGenerator.randomTimestamp();
      const recordQueryControl = TestDataGenerator.generateRecordsQuery({
        filter: { datePublished: { from: randomDate, }, published: true }
      });

      await expect(recordQueryControl).resolves.toBeDefined();

      const recordQueryRejected = TestDataGenerator.generateRecordsQuery({
        filter: { datePublished: { from: randomDate }, published: false }
      });
      await expect(recordQueryRejected).rejects.toThrow('descriptor/filter/published: must be equal to one of the allowed values');
    });

    it('should use `messageTimestamp` as is if given', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const currentTime = Time.getCurrentTimestamp();
      const recordsQuery = await RecordsSubscribe.create({
        filter           : { schema: 'anything' },
        messageTimestamp : currentTime,
        signer           : Jws.createSigner(alice),
      });

      expect(recordsQuery.message.descriptor.messageTimestamp).toBe(currentTime);
    });

    it('should auto-normalize protocol URL', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const options = {
        recipient  : alice.did,
        data       : TestDataGenerator.randomBytes(10),
        dataFormat : 'application/json',
        signer     : Jws.createSigner(alice),
        filter     : { protocol: 'example.com/' },
        definition : dexProtocolDefinition
      };
      const recordsQuery = await RecordsSubscribe.create(options);

      const message = recordsQuery.message;

      expect(message.descriptor.filter!.protocol).toBe('http://example.com');
    });

    it('should auto-normalize schema URL', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const options = {
        recipient  : alice.did,
        data       : TestDataGenerator.randomBytes(10),
        dataFormat : 'application/json',
        signer     : Jws.createSigner(alice),
        filter     : { schema: 'example.com/' },
        definition : dexProtocolDefinition
      };
      const recordsQuery = await RecordsSubscribe.create(options);

      const message = recordsQuery.message;

      expect(message.descriptor.filter!.schema).toBe('http://example.com');
    });
  });
});
