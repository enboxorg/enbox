import { Jws } from '../../src/index.js';
import { RecordsDelete } from '../../src/interfaces/records-delete.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { Time } from '../../src/utils/time.js';
import { describe, expect, it } from 'bun:test';

describe('RecordsDelete', () => {
  describe('create()', () => {
    it('should use `messageTimestamp` as is if given', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const currentTime = Time.getCurrentTimestamp();
      const recordsDelete = await RecordsDelete.create({
        recordId         : 'anything',
        signer           : Jws.createSigner(alice),
        messageTimestamp : currentTime
      });

      expect(recordsDelete.message.descriptor.messageTimestamp).toBe(currentTime);
    });

    it('should auto-fill `messageTimestamp` if not given', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const recordsDelete = await RecordsDelete.create({
        recordId : 'anything',
        signer   : Jws.createSigner(alice)
      });

      expect(recordsDelete.message.descriptor.messageTimestamp).toBeDefined();
    });

    it('should include permissionGrantId in indexes when provided', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const permissionGrantId = await TestDataGenerator.randomCborSha256Cid();
      const { recordsWrite } = await TestDataGenerator.generateRecordsWrite({ author: alice });

      const recordsDelete = await RecordsDelete.create({
        recordId          : recordsWrite.message.recordId,
        signer            : Jws.createSigner(alice),
        permissionGrantId : permissionGrantId,
      });

      const indexes = recordsDelete.constructIndexes(recordsWrite.message);
      expect(indexes.permissionGrantId).toBe(permissionGrantId);
    });
  });
});
