import { RecordsDelete } from '../../src/interfaces/records-delete.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { Time } from '../../src/utils/time.js';
import { describe, expect, it } from 'bun:test';
import { Jws, RecordsWrite } from '../../src/index.js';

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

      const indexes = recordsDelete.constructIndexes(recordsWrite.message, recordsWrite.message);
      expect(indexes.permissionGrantId).toBe(permissionGrantId);
    });
  });

  describe('constructIndexes()', () => {
    it(
      'should carry flattened `tag.*` and `published` from the newest pre-delete write while immutable facts come from the initial write',
      async () => {
        const alice = await TestDataGenerator.generatePersona();
        const datePublished = '2025-01-01T00:00:00.000000Z';

        const { recordsWrite: initialWrite } = await TestDataGenerator.generateRecordsWrite({
          author : alice,
          schema : 'http://test-schema',
          tags   : { team: 'red' },
        });

        const updateWrite = await RecordsWrite.createFrom({
          recordsWriteMessage : initialWrite.message,
          published           : true,
          datePublished,
          tags                : { team: 'blue', priority: 1 },
          signer              : Jws.createSigner(alice),
        });

        const recordsDelete = await RecordsDelete.create({
          recordId : initialWrite.message.recordId,
          signer   : Jws.createSigner(alice),
        });

        const indexes = recordsDelete.constructIndexes(initialWrite.message, updateWrite.message);

        // mutable visibility facts come from the newest pre-delete write
        expect(indexes['tag.team']).toBe('blue');
        expect(indexes['tag.priority']).toBe(1);
        expect(indexes.published).toBe(true);
        expect(indexes.datePublished).toBe(datePublished);

        // immutable facts still come from the initial write
        expect(indexes.schema).toBe(initialWrite.message.descriptor.schema!);
        expect(indexes.dateCreated).toBe(initialWrite.message.descriptor.dateCreated);
        expect(indexes.isLatestBaseState).toBe(true);
      }
    );

    it('should index `published` as `false` for a tombstone of an unpublished record', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const { recordsWrite: initialWrite } = await TestDataGenerator.generateRecordsWrite({ author: alice });

      const recordsDelete = await RecordsDelete.create({
        recordId : initialWrite.message.recordId,
        signer   : Jws.createSigner(alice),
      });

      const indexes = recordsDelete.constructIndexes(initialWrite.message, initialWrite.message);

      expect(indexes.published).toBe(false);
      expect(Object.keys(indexes).some((key) => key.startsWith('tag.'))).toBe(false);
    });

    it('should reconstruct replacement tombstone visibility facts from the newest retained write', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const datePublished = '2025-02-01T00:00:00.000000Z';

      const { recordsWrite: initialWrite } = await TestDataGenerator.generateRecordsWrite({
        author : alice,
        tags   : { team: 'red' },
      });

      const updateWrite = await RecordsWrite.createFrom({
        recordsWriteMessage : initialWrite.message,
        published           : true,
        datePublished,
        tags                : { team: 'blue' },
        signer              : Jws.createSigner(alice),
      });

      const pruneDelete = await RecordsDelete.create({
        recordId : initialWrite.message.recordId,
        prune    : true,
        signer   : Jws.createSigner(alice),
      });

      const indexes = pruneDelete.constructIndexes(initialWrite.message, updateWrite.message);

      expect(indexes['tag.team']).toBe('blue');
      expect(indexes.published).toBe(true);
      expect(indexes.datePublished).toBe(datePublished);
    });
  });
});
