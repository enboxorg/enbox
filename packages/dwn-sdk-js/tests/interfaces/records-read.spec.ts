import { DateSort } from '../../src/types/records-types.js';
import dexProtocolDefinition from '../vectors/protocol-definitions/dex.json' with { type: 'json' };
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/index.js';
import { RecordsRead } from '../../src/interfaces/records-read.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { Time } from '../../src/utils/time.js';
import { describe, expect, it } from 'bun:test';

describe('RecordsRead', () => {
  describe('create()', () => {
    it('should use `messageTimestamp` as is if given', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const currentTime = Time.getCurrentTimestamp();
      const recordsRead = await RecordsRead.create({
        filter: {
          recordId: 'anything',
        },
        signer           : Jws.createSigner(alice),
        messageTimestamp : currentTime
      });

      expect(recordsRead.message.descriptor.messageTimestamp).toBe(currentTime);
    });

    it('should include permissionGrantId in the descriptor when provided', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const grantId = 'grant-abc-123';

      const recordsRead = await RecordsRead.create({
        filter            : { recordId: 'anything' },
        signer            : Jws.createSigner(alice),
        permissionGrantId : grantId,
      });

      expect(recordsRead.message.descriptor.permissionGrantId).toBe(grantId);
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
      const recordsQuery = await RecordsRead.create(options);

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
      const recordsQuery = await RecordsRead.create(options);

      const message = recordsQuery.message;

      expect(message.descriptor.filter!.schema).toBe('http://example.com');
    });

    it('should include dateSort in the descriptor when provided', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const recordsRead = await RecordsRead.create({
        filter   : { recordId: 'anything' },
        signer   : Jws.createSigner(alice),
        dateSort : DateSort.CreatedDescending,
      });

      expect(recordsRead.message.descriptor.dateSort).toBe(DateSort.CreatedDescending);
    });

    it('should not include dateSort in the descriptor when not provided', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const recordsRead = await RecordsRead.create({
        filter : { recordId: 'anything' },
        signer : Jws.createSigner(alice),
      });

      expect(recordsRead.message.descriptor.dateSort).toBeUndefined();
    });

    it('should throw if published is set to false and dateSort is PublishedAscending', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const createPromise = RecordsRead.create({
        filter   : { schema: 'anySchema', published: false },
        signer   : Jws.createSigner(alice),
        dateSort : DateSort.PublishedAscending,
      });

      await expect(createPromise).rejects.toThrow(DwnErrorCode.RecordsReadCreateFilterPublishedSortInvalid);
    });

    it('should throw if published is set to false and dateSort is PublishedDescending', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const createPromise = RecordsRead.create({
        filter   : { schema: 'anySchema', published: false },
        signer   : Jws.createSigner(alice),
        dateSort : DateSort.PublishedDescending,
      });

      await expect(createPromise).rejects.toThrow(DwnErrorCode.RecordsReadCreateFilterPublishedSortInvalid);
    });
  });

  describe('parse()', () => {
    it('should throw if published is set to false and dateSort is PublishedAscending', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const recordsRead = await RecordsRead.create({
        filter : { schema: 'anySchema', published: false },
        signer : Jws.createSigner(alice),
      });

      // manually inject invalid dateSort to bypass create() validation
      recordsRead.message.descriptor.dateSort = DateSort.PublishedAscending;

      const parsePromise = RecordsRead.parse(recordsRead.message);
      await expect(parsePromise).rejects.toThrow(DwnErrorCode.RecordsReadParseFilterPublishedSortInvalid);
    });

    it('should throw if published is set to false and dateSort is PublishedDescending', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const recordsRead = await RecordsRead.create({
        filter : { schema: 'anySchema', published: false },
        signer : Jws.createSigner(alice),
      });

      // manually inject invalid dateSort to bypass create() validation
      recordsRead.message.descriptor.dateSort = DateSort.PublishedDescending;

      const parsePromise = RecordsRead.parse(recordsRead.message);
      await expect(parsePromise).rejects.toThrow(DwnErrorCode.RecordsReadParseFilterPublishedSortInvalid);
    });
  });
});
