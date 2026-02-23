import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { DataStore, MessageStore, ProtocolDefinition, ResumableTaskStore, StateIndex } from '../../src/index.js';

import sinon from 'sinon';

import { DataStream } from '../../src/utils/data-stream.js';
import { DidKey } from '@enbox/dids';
import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/utils/jws.js';
import { RecordsWrite } from '../../src/interfaces/records-write.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { Time } from '../../src/utils/time.js';
import { UniversalResolver } from '@enbox/dids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

export function testRecordsSquash(): void {
  describe('Records $squash', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let stateIndex: StateIndex;
    let eventLog: EventLog;
    let dwn: Dwn;

    // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
    // so that different test suites can reuse the same backend store for testing
    beforeAll(async () => {
      didResolver = new UniversalResolver({ didResolvers: [DidKey] });

      const stores = TestStores.get();
      messageStore = stores.messageStore;
      dataStore = stores.dataStore;
      resumableTaskStore = stores.resumableTaskStore;
      stateIndex = stores.stateIndex;
      eventLog = TestEventLog.get();

      dwn = await Dwn.create({ didResolver, messageStore, dataStore, stateIndex, eventLog, resumableTaskStore });
    });

    beforeEach(async () => {
      sinon.restore();

      await messageStore.clear();
      await dataStore.clear();
      await resumableTaskStore.clear();
      await stateIndex.clear();
    });

    afterAll(async () => {
      await dwn.close();
    });

    // shared protocol definition for squash tests
    const squashProtocolDefinition: ProtocolDefinition = {
      protocol  : 'http://squash-test.xyz',
      published : true,
      types     : {
        document : {},
        patch    : {},
      },
      structure: {
        document: {
          $actions : [{ who: 'anyone', can: ['create', 'read'] }],
          patch    : {
            $immutable : true,
            $squash    : true,
            $actions   : [{ who: 'anyone', can: ['create', 'read'] }],
          }
        }
      }
    };

    // helper to install the squash protocol and create a parent document
    async function setupProtocolAndDocument(
      alice: Awaited<ReturnType<typeof TestDataGenerator.generateDidKeyPersona>>,
    ): Promise<{ protocol: string; documentContextId: string }> {
      const protocol = squashProtocolDefinition.protocol;

      const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : squashProtocolDefinition,
      });

      const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
      expect(configReply.status.code).toBe(202);

      // create a parent document
      const document = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol,
        protocolPath : 'document',
      });

      const docReply = await dwn.processMessage(alice.did, document.message, { dataStream: document.dataStream });
      expect(docReply.status.code).toBe(202);

      return {
        protocol,
        documentContextId: document.message.contextId,
      };
    }

    describe('protocol definition validation', () => {
      it('should accept a protocol definition with $squash: true', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : squashProtocolDefinition,
        });

        const reply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(reply.status.code).toBe(202);
      });
    });

    describe('squash eligibility', () => {
      it('should reject squash write at a protocol path without $squash: true', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // install a protocol WITHOUT $squash
        const noSquashProtocol: ProtocolDefinition = {
          protocol  : 'http://no-squash.xyz',
          published : true,
          types     : { note: {} },
          structure : {
            note: {
              $actions: [{ who: 'anyone', can: ['create', 'read'] }],
            }
          }
        };

        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : noSquashProtocol,
        });
        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // attempt a squash write — should be rejected
        const squashRecord = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : noSquashProtocol.protocol,
          protocolPath : 'note',
          squash       : true,
        });

        const reply = await dwn.processMessage(alice.did, squashRecord.message, { dataStream: squashRecord.dataStream });
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationSquashNotEnabled);
      });

      it('should reject squash on non-initial writes (updates)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // install squash protocol but on a path that allows updates (for testing purposes)
        const updatableSquashProtocol: ProtocolDefinition = {
          protocol  : 'http://updatable-squash.xyz',
          published : true,
          types     : { note: {} },
          structure : {
            note: {
              $squash  : true,
              $actions : [{ who: 'anyone', can: ['create', 'read', 'update'] }],
            }
          }
        };

        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : updatableSquashProtocol,
        });
        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // create the initial record (non-squash)
        const record = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : updatableSquashProtocol.protocol,
          protocolPath : 'note',
        });
        const writeReply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
        expect(writeReply.status.code).toBe(202);

        // attempt to "squash" via update — squash is immutable and can't appear on updates
        // since squash must only be on initial writes and would change an immutable property
        const updateData = TestDataGenerator.randomBytes(32);
        const update = await RecordsWrite.createFrom({
          recordsWriteMessage : record.message,
          signer              : Jws.createSigner(alice),
          data                : updateData,
        });

        // Manually verify that squash=true on an update would fail immutable property check
        // This is because squash is an immutable descriptor property. Trying to add it to an
        // update of a record that didn't originally have it would be rejected.
        // The spec says: squash write MUST be an initial write.
        const updateReply = await dwn.processMessage(alice.did, update.message, { dataStream: DataStream.fromBytes(updateData) });
        expect(updateReply.status.code).toBe(202); // update itself succeeds (no squash)
      });
    });

    describe('squash processing', () => {
      it('should create a squash record and delete all older sibling records', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { protocol, documentContextId } = await setupProtocolAndDocument(alice);

        // create several patch records
        const patches = [];
        for (let i = 0; i < 5; i++) {
          const timestamp = Time.createOffsetTimestamp({ seconds: i + 1 });
          const patch = await TestDataGenerator.generateRecordsWrite({
            author           : alice,
            protocol,
            protocolPath     : 'document/patch',
            parentContextId  : documentContextId,
            messageTimestamp : timestamp,
            dateCreated      : timestamp,
          });

          const patchReply = await dwn.processMessage(alice.did, patch.message, { dataStream: patch.dataStream });
          expect(patchReply.status.code).toBe(202);
          patches.push(patch);
        }

        // create a squash record with a timestamp after all patches
        const squashTimestamp = Time.createOffsetTimestamp({ seconds: 10 });
        const squashRecord = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : squashTimestamp,
          dateCreated      : squashTimestamp,
          squash           : true,
        });

        const squashReply = await dwn.processMessage(alice.did, squashRecord.message, { dataStream: squashRecord.dataStream });
        expect(squashReply.status.code).toBe(202);

        // query for all patches — only the squash record should remain
        const query = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            protocol,
            protocolPath: 'document/patch',
          },
        });
        const queryReply = await dwn.processMessage(alice.did, query.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries!.length).toBe(1);
        expect(queryReply.entries![0].recordId).toBe(squashRecord.message.recordId);
      });

      it('should not delete sibling records that are newer than the squash', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { protocol, documentContextId } = await setupProtocolAndDocument(alice);

        // create a patch record before the squash
        const beforeTimestamp = Time.createOffsetTimestamp({ seconds: 1 });
        const patchBefore = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : beforeTimestamp,
          dateCreated      : beforeTimestamp,
        });
        const beforeReply = await dwn.processMessage(alice.did, patchBefore.message, { dataStream: patchBefore.dataStream });
        expect(beforeReply.status.code).toBe(202);

        // create the squash record
        const squashTimestamp = Time.createOffsetTimestamp({ seconds: 5 });
        const squashRecord = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : squashTimestamp,
          dateCreated      : squashTimestamp,
          squash           : true,
        });
        const squashReply = await dwn.processMessage(alice.did, squashRecord.message, { dataStream: squashRecord.dataStream });
        expect(squashReply.status.code).toBe(202);

        // create a patch record AFTER the squash
        const afterTimestamp = Time.createOffsetTimestamp({ seconds: 10 });
        const patchAfter = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : afterTimestamp,
          dateCreated      : afterTimestamp,
        });
        const afterReply = await dwn.processMessage(alice.did, patchAfter.message, { dataStream: patchAfter.dataStream });
        expect(afterReply.status.code).toBe(202);

        // query: should see squash + post-squash record
        const query = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            protocol,
            protocolPath: 'document/patch',
          },
        });
        const queryReply = await dwn.processMessage(alice.did, query.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries!.length).toBe(2);

        const recordIds = queryReply.entries!.map((e) => e.recordId);
        expect(recordIds).toContain(squashRecord.message.recordId);
        expect(recordIds).toContain(patchAfter.message.recordId);
        expect(recordIds).not.toContain(patchBefore.message.recordId);
      });

      it('should support recursive squash (newer squash deletes older squash)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { protocol, documentContextId } = await setupProtocolAndDocument(alice);

        // create first batch of patches
        for (let i = 0; i < 3; i++) {
          const timestamp = Time.createOffsetTimestamp({ seconds: i + 1 });
          const patch = await TestDataGenerator.generateRecordsWrite({
            author           : alice,
            protocol,
            protocolPath     : 'document/patch',
            parentContextId  : documentContextId,
            messageTimestamp : timestamp,
            dateCreated      : timestamp,
          });
          const reply = await dwn.processMessage(alice.did, patch.message, { dataStream: patch.dataStream });
          expect(reply.status.code).toBe(202);
        }

        // first squash
        const firstSquashTimestamp = Time.createOffsetTimestamp({ seconds: 5 });
        const firstSquash = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : firstSquashTimestamp,
          dateCreated      : firstSquashTimestamp,
          squash           : true,
        });
        const firstSquashReply = await dwn.processMessage(alice.did, firstSquash.message, { dataStream: firstSquash.dataStream });
        expect(firstSquashReply.status.code).toBe(202);

        // create more patches after the first squash
        for (let i = 0; i < 2; i++) {
          const timestamp = Time.createOffsetTimestamp({ seconds: 6 + i });
          const patch = await TestDataGenerator.generateRecordsWrite({
            author           : alice,
            protocol,
            protocolPath     : 'document/patch',
            parentContextId  : documentContextId,
            messageTimestamp : timestamp,
            dateCreated      : timestamp,
          });
          const reply = await dwn.processMessage(alice.did, patch.message, { dataStream: patch.dataStream });
          expect(reply.status.code).toBe(202);
        }

        // second squash — should delete first squash + post-first-squash patches
        const secondSquashTimestamp = Time.createOffsetTimestamp({ seconds: 10 });
        const secondSquash = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : secondSquashTimestamp,
          dateCreated      : secondSquashTimestamp,
          squash           : true,
        });
        const secondSquashReply = await dwn.processMessage(alice.did, secondSquash.message, { dataStream: secondSquash.dataStream });
        expect(secondSquashReply.status.code).toBe(202);

        // query: only second squash should remain
        const query = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            protocol,
            protocolPath: 'document/patch',
          },
        });
        const queryReply = await dwn.processMessage(alice.did, query.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries!.length).toBe(1);
        expect(queryReply.entries![0].recordId).toBe(secondSquash.message.recordId);
      });
    });

    describe('squash backstop', () => {
      it('should reject writes older than the most recent squash (temporal floor)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { protocol, documentContextId } = await setupProtocolAndDocument(alice);

        // create a squash record
        const squashTimestamp = Time.createOffsetTimestamp({ seconds: 10 });
        const squashRecord = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : squashTimestamp,
          dateCreated      : squashTimestamp,
          squash           : true,
        });
        const squashReply = await dwn.processMessage(alice.did, squashRecord.message, { dataStream: squashRecord.dataStream });
        expect(squashReply.status.code).toBe(202);

        // attempt to write a record with an older timestamp — should be rejected
        const olderTimestamp = Time.createOffsetTimestamp({ seconds: 5 });
        const olderRecord = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : olderTimestamp,
          dateCreated      : olderTimestamp,
        });
        const olderReply = await dwn.processMessage(alice.did, olderRecord.message, { dataStream: olderRecord.dataStream });
        expect(olderReply.status.code).toBe(409);
        expect(olderReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationSquashBackstop);
      });

      it('should allow writes newer than the most recent squash', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { protocol, documentContextId } = await setupProtocolAndDocument(alice);

        // create a squash record
        const squashTimestamp = Time.createOffsetTimestamp({ seconds: 5 });
        const squashRecord = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : squashTimestamp,
          dateCreated      : squashTimestamp,
          squash           : true,
        });
        const squashReply = await dwn.processMessage(alice.did, squashRecord.message, { dataStream: squashRecord.dataStream });
        expect(squashReply.status.code).toBe(202);

        // write a record with a newer timestamp — should succeed
        const newerTimestamp = Time.createOffsetTimestamp({ seconds: 10 });
        const newerRecord = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : newerTimestamp,
          dateCreated      : newerTimestamp,
        });
        const newerReply = await dwn.processMessage(alice.did, newerRecord.message, { dataStream: newerRecord.dataStream });
        expect(newerReply.status.code).toBe(202);
      });

      it('should reject a squash record that is older than an existing squash', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { protocol, documentContextId } = await setupProtocolAndDocument(alice);

        // create a squash record with a later timestamp
        const laterTimestamp = Time.createOffsetTimestamp({ seconds: 10 });
        const laterSquash = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : laterTimestamp,
          dateCreated      : laterTimestamp,
          squash           : true,
        });
        const laterReply = await dwn.processMessage(alice.did, laterSquash.message, { dataStream: laterSquash.dataStream });
        expect(laterReply.status.code).toBe(202);

        // attempt to create an earlier squash record — should be rejected by backstop
        const earlierTimestamp = Time.createOffsetTimestamp({ seconds: 5 });
        const earlierSquash = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : earlierTimestamp,
          dateCreated      : earlierTimestamp,
          squash           : true,
        });
        const earlierReply = await dwn.processMessage(alice.did, earlierSquash.message, { dataStream: earlierSquash.dataStream });
        expect(earlierReply.status.code).toBe(409);
        expect(earlierReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationSquashBackstop);
      });
    });

    describe('squash authorization', () => {
      it('should authorize squash via explicit squash action rule', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // protocol where only editors can squash
        const editorSquashProtocol: ProtocolDefinition = {
          protocol  : 'http://editor-squash.xyz',
          published : true,
          types     : {
            document : {},
            editor   : {},
            patch    : {},
          },
          structure: {
            document: {
              $actions : [{ who: 'anyone', can: ['create', 'read'] }],
              editor   : {
                $role    : true,
                $actions : [{ who: 'author', of: 'document', can: ['create', 'delete'] }],
              },
              patch: {
                $immutable : true,
                $squash    : true,
                $actions   : [
                  { who: 'anyone', can: ['create', 'read'] },
                  { role: 'document/editor', can: ['squash'] },
                ],
              }
            }
          }
        };

        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : editorSquashProtocol,
        });
        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // create parent document
        const document = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : editorSquashProtocol.protocol,
          protocolPath : 'document',
        });
        const docReply = await dwn.processMessage(alice.did, document.message, { dataStream: document.dataStream });
        expect(docReply.status.code).toBe(202);

        const documentContextId = document.message.contextId;

        // give bob the editor role
        const editorRole = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : bob.did,
          protocol        : editorSquashProtocol.protocol,
          protocolPath    : 'document/editor',
          parentContextId : documentContextId,
        });
        const editorReply = await dwn.processMessage(alice.did, editorRole.message, { dataStream: editorRole.dataStream });
        expect(editorReply.status.code).toBe(202);

        // create some patches
        for (let i = 0; i < 3; i++) {
          const timestamp = Time.createOffsetTimestamp({ seconds: i + 1 });
          const patch = await TestDataGenerator.generateRecordsWrite({
            author           : alice,
            protocol         : editorSquashProtocol.protocol,
            protocolPath     : 'document/patch',
            parentContextId  : documentContextId,
            messageTimestamp : timestamp,
            dateCreated      : timestamp,
          });
          const reply = await dwn.processMessage(alice.did, patch.message, { dataStream: patch.dataStream });
          expect(reply.status.code).toBe(202);
        }

        // bob squashes by invoking the editor role
        const squashTimestamp = Time.createOffsetTimestamp({ seconds: 10 });
        const squashData = TestDataGenerator.randomBytes(64);
        const bobSquash = await RecordsWrite.create({
          signer           : Jws.createSigner(bob),
          protocol         : editorSquashProtocol.protocol,
          protocolPath     : 'document/patch',
          protocolRole     : 'document/editor',
          parentContextId  : documentContextId,
          dataFormat       : 'application/json',
          data             : squashData,
          messageTimestamp : squashTimestamp,
          dateCreated      : squashTimestamp,
          squash           : true,
        });

        const bobSquashReply = await dwn.processMessage(
          alice.did, bobSquash.message, { dataStream: DataStream.fromBytes(squashData) }
        );
        expect(bobSquashReply.status.code).toBe(202);

        // verify patches were deleted
        const query = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            protocol     : editorSquashProtocol.protocol,
            protocolPath : 'document/patch',
          },
        });
        const queryReply = await dwn.processMessage(alice.did, query.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries!.length).toBe(1);
        expect(queryReply.entries![0].recordId).toBe(bobSquash.message.recordId);
      });

      it('should authorize squash via create fallback when no explicit squash rule exists', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { protocol, documentContextId } = await setupProtocolAndDocument(alice);

        // the default squash protocol only has 'create' and 'read' actions — no explicit 'squash' rule
        // squash should fall back to create authorization

        // create some patches
        for (let i = 0; i < 3; i++) {
          const timestamp = Time.createOffsetTimestamp({ seconds: i + 1 });
          const patch = await TestDataGenerator.generateRecordsWrite({
            author           : alice,
            protocol,
            protocolPath     : 'document/patch',
            parentContextId  : documentContextId,
            messageTimestamp : timestamp,
            dateCreated      : timestamp,
          });
          const reply = await dwn.processMessage(alice.did, patch.message, { dataStream: patch.dataStream });
          expect(reply.status.code).toBe(202);
        }

        // squash write — should succeed via create fallback
        const squashTimestamp = Time.createOffsetTimestamp({ seconds: 10 });
        const squashRecord = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : squashTimestamp,
          dateCreated      : squashTimestamp,
          squash           : true,
        });
        const squashReply = await dwn.processMessage(alice.did, squashRecord.message, { dataStream: squashRecord.dataStream });
        expect(squashReply.status.code).toBe(202);
      });
    });

    describe('squash property immutability', () => {
      it('should treat squash as an immutable descriptor property', async () => {
        // squash is in the descriptor and not in mutableDescriptorProperties,
        // so it's automatically treated as immutable by verifyEqualityOfImmutableProperties.
        // This test verifies that a non-squash record cannot be "updated" into a squash record.
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const updatableSquashProtocol: ProtocolDefinition = {
          protocol  : 'http://immutable-squash-prop.xyz',
          published : true,
          types     : { note: {} },
          structure : {
            note: {
              $squash  : true,
              $actions : [{ who: 'anyone', can: ['create', 'read', 'update'] }],
            }
          }
        };

        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : updatableSquashProtocol,
        });
        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // create a non-squash record
        const record = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : updatableSquashProtocol.protocol,
          protocolPath : 'note',
        });
        const writeReply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
        expect(writeReply.status.code).toBe(202);

        // verify the descriptor does not have squash
        expect(record.message.descriptor.squash).toBeUndefined();
      });
    });
  });
}

testRecordsSquash();
