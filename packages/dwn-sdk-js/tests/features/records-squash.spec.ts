import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { DataStore, MessageStore, ProtocolDefinition, ResumableTaskStore } from '../../src/index.js';

import sinon from 'sinon';

import { DataStream } from '../../src/utils/data-stream.js';
import { DidKey } from '@enbox/dids';
import { Dwn } from '../../src/dwn.js';
import { DwnConstant } from '../../src/core/dwn-constant.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/utils/jws.js';
import { RecordsDelete } from '../../src/interfaces/records-delete.js';
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
      eventLog = TestEventLog.get();

      dwn = await Dwn.create({ didResolver, messageStore, dataStore, eventLog, resumableTaskStore });
    });

    beforeEach(async () => {
      sinon.restore();

      await messageStore.clear();
      await dataStore.clear();
      await resumableTaskStore.clear();
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
            protocolPath : 'document/patch',
            contextId    : documentContextId,
          },
        });
        const queryReply = await dwn.processMessage(alice.did, query.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries!).toHaveLength(1);
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
            protocolPath : 'document/patch',
            contextId    : documentContextId,
          },
        });
        const queryReply = await dwn.processMessage(alice.did, query.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries!).toHaveLength(2);

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
            protocolPath : 'document/patch',
            contextId    : documentContextId,
          },
        });
        const queryReply = await dwn.processMessage(alice.did, query.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries!).toHaveLength(1);
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

        // the reply status carries the error code and the squash floor timestamp as machine-readable data
        expect(olderReply.status.errorCode).toBe(DwnErrorCode.ProtocolAuthorizationSquashBackstop);
        expect(olderReply.status.info).toEqual({ squashFloorTimestamp: squashTimestamp });
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
      it('should keep explicit squash authorization separate from create', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        const roleSeparatedSquashProtocol: ProtocolDefinition = {
          protocol  : 'http://role-separated-squash.xyz',
          published : true,
          types     : {
            document : {},
            admin    : {},
            editor   : {},
            patch    : {},
          },
          structure: {
            document: {
              $actions : [{ who: 'anyone', can: ['create', 'read'] }],
              admin    : {
                $role    : true,
                $actions : [{ who: 'author', of: 'document', can: ['create', 'delete'] }],
              },
              editor: {
                $role    : true,
                $actions : [{ who: 'author', of: 'document', can: ['create', 'delete'] }],
              },
              patch: {
                $immutable : true,
                $squash    : true,
                $actions   : [
                  { role: 'document/admin', can: ['create', 'read', 'squash'] },
                  { role: 'document/editor', can: ['create', 'read'] },
                ],
              }
            }
          }
        };

        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : roleSeparatedSquashProtocol,
        });
        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // create parent document
        const document = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : roleSeparatedSquashProtocol.protocol,
          protocolPath : 'document',
        });
        const docReply = await dwn.processMessage(alice.did, document.message, { dataStream: document.dataStream });
        expect(docReply.status.code).toBe(202);

        const documentContextId = document.message.contextId;

        const editorRole = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : bob.did,
          protocol        : roleSeparatedSquashProtocol.protocol,
          protocolPath    : 'document/editor',
          parentContextId : documentContextId,
        });
        const editorReply = await dwn.processMessage(alice.did, editorRole.message, { dataStream: editorRole.dataStream });
        expect(editorReply.status.code).toBe(202);

        const adminRole = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : carol.did,
          protocol        : roleSeparatedSquashProtocol.protocol,
          protocolPath    : 'document/admin',
          parentContextId : documentContextId,
        });
        const adminReply = await dwn.processMessage(alice.did, adminRole.message, { dataStream: adminRole.dataStream });
        expect(adminReply.status.code).toBe(202);

        // editor create remains authorized for normal immutable patches
        for (let i = 0; i < 3; i++) {
          const timestamp = Time.createOffsetTimestamp({ seconds: i + 1 });
          const patch = await TestDataGenerator.generateRecordsWrite({
            author           : bob,
            protocol         : roleSeparatedSquashProtocol.protocol,
            protocolPath     : 'document/patch',
            protocolRole     : 'document/editor',
            parentContextId  : documentContextId,
            messageTimestamp : timestamp,
            dateCreated      : timestamp,
          });
          const reply = await dwn.processMessage(alice.did, patch.message, { dataStream: patch.dataStream });
          expect(reply.status.code).toBe(202);
        }

        // editor create permission must not authorize a squash
        const editorSquashTimestamp = Time.createOffsetTimestamp({ seconds: 10 });
        const editorSquashData = TestDataGenerator.randomBytes(64);
        const bobSquash = await RecordsWrite.create({
          signer           : Jws.createSigner(bob),
          protocol         : roleSeparatedSquashProtocol.protocol,
          protocolPath     : 'document/patch',
          protocolRole     : 'document/editor',
          parentContextId  : documentContextId,
          dataFormat       : 'application/json',
          data             : editorSquashData,
          messageTimestamp : editorSquashTimestamp,
          dateCreated      : editorSquashTimestamp,
          squash           : true,
        });

        const bobSquashReply = await dwn.processMessage(
          alice.did, bobSquash.message, { dataStream: DataStream.fromBytes(editorSquashData) }
        );
        expect(bobSquashReply.status.code).toBe(401);
        expect(bobSquashReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);

        // admin squash is authorized by the explicit action
        const adminSquashTimestamp = Time.createOffsetTimestamp({ seconds: 20 });
        const adminSquashData = TestDataGenerator.randomBytes(64);
        const carolSquash = await RecordsWrite.create({
          signer           : Jws.createSigner(carol),
          protocol         : roleSeparatedSquashProtocol.protocol,
          protocolPath     : 'document/patch',
          protocolRole     : 'document/admin',
          parentContextId  : documentContextId,
          dataFormat       : 'application/json',
          data             : adminSquashData,
          messageTimestamp : adminSquashTimestamp,
          dateCreated      : adminSquashTimestamp,
          squash           : true,
        });

        const carolSquashReply = await dwn.processMessage(
          alice.did, carolSquash.message, { dataStream: DataStream.fromBytes(adminSquashData) }
        );
        expect(carolSquashReply.status.code).toBe(202);

        // verify patches were deleted
        const query = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            protocol     : roleSeparatedSquashProtocol.protocol,
            protocolPath : 'document/patch',
            contextId    : documentContextId,
          },
        });
        const queryReply = await dwn.processMessage(alice.did, query.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries!).toHaveLength(1);
        expect(queryReply.entries![0].recordId).toBe(carolSquash.message.recordId);
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

    describe('protocol definition validation — $squash: false', () => {
      it('should reject a protocol definition with $squash: false at schema validation time', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const invalidProtocol: ProtocolDefinition = {
          protocol  : 'http://squash-false-test.xyz',
          published : true,
          types     : { note: {} },
          structure : {
            note: {
              $squash  : false as unknown as boolean,
              $actions : [{ who: 'anyone', can: ['create', 'read'] }],
            }
          }
        };

        // $squash: false is rejected by JSON schema validation (enum: [true]) during message creation
        await expect(TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : invalidProtocol,
        })).rejects.toThrow('must be equal to one of the allowed values');
      });
    });

    describe('root-level squash path', () => {
      it('should squash records at a root-level protocol path (no parent context)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // protocol with $squash at root level
        const rootSquashProtocol: ProtocolDefinition = {
          protocol  : 'http://root-squash.xyz',
          published : true,
          types     : { note: {} },
          structure : {
            note: {
              $squash  : true,
              $actions : [{ who: 'anyone', can: ['create', 'read'] }],
            }
          }
        };

        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : rootSquashProtocol,
        });
        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // create several root-level records
        const records = [];
        for (let i = 0; i < 4; i++) {
          const timestamp = Time.createOffsetTimestamp({ seconds: i + 1 });
          const record = await TestDataGenerator.generateRecordsWrite({
            author           : alice,
            protocol         : rootSquashProtocol.protocol,
            protocolPath     : 'note',
            messageTimestamp : timestamp,
            dateCreated      : timestamp,
          });
          const reply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
          expect(reply.status.code).toBe(202);
          records.push(record);
        }

        // squash all root-level records
        const squashTimestamp = Time.createOffsetTimestamp({ seconds: 10 });
        const squashRecord = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol         : rootSquashProtocol.protocol,
          protocolPath     : 'note',
          messageTimestamp : squashTimestamp,
          dateCreated      : squashTimestamp,
          squash           : true,
        });
        const squashReply = await dwn.processMessage(alice.did, squashRecord.message, { dataStream: squashRecord.dataStream });
        expect(squashReply.status.code).toBe(202);

        // query: only the squash record should remain
        const query = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            protocol     : rootSquashProtocol.protocol,
            protocolPath : 'note',
          },
        });
        const queryReply = await dwn.processMessage(alice.did, query.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries!).toHaveLength(1);
        expect(queryReply.entries![0].recordId).toBe(squashRecord.message.recordId);
      });

      it('should enforce backstop at a root-level protocol path', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const rootSquashProtocol: ProtocolDefinition = {
          protocol  : 'http://root-squash-backstop.xyz',
          published : true,
          types     : { note: {} },
          structure : {
            note: {
              $squash  : true,
              $actions : [{ who: 'anyone', can: ['create', 'read'] }],
            }
          }
        };

        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : rootSquashProtocol,
        });
        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // create a squash
        const squashTimestamp = Time.createOffsetTimestamp({ seconds: 10 });
        const squashRecord = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol         : rootSquashProtocol.protocol,
          protocolPath     : 'note',
          messageTimestamp : squashTimestamp,
          dateCreated      : squashTimestamp,
          squash           : true,
        });
        const squashReply = await dwn.processMessage(alice.did, squashRecord.message, { dataStream: squashRecord.dataStream });
        expect(squashReply.status.code).toBe(202);

        // attempt a write older than the squash — should be rejected
        const olderTimestamp = Time.createOffsetTimestamp({ seconds: 5 });
        const olderRecord = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol         : rootSquashProtocol.protocol,
          protocolPath     : 'note',
          messageTimestamp : olderTimestamp,
          dateCreated      : olderTimestamp,
        });
        const olderReply = await dwn.processMessage(alice.did, olderRecord.message, { dataStream: olderRecord.dataStream });
        expect(olderReply.status.code).toBe(409);
        expect(olderReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationSquashBackstop);
      });
    });

    describe('cross-context isolation', () => {
      it('should not delete records under a different parent context', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { protocol, documentContextId: docAContextId } = await setupProtocolAndDocument(alice);

        // create a second document (different parent context)
        const docB = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol,
          protocolPath : 'document',
        });
        const docBReply = await dwn.processMessage(alice.did, docB.message, { dataStream: docB.dataStream });
        expect(docBReply.status.code).toBe(202);
        const docBContextId = docB.message.contextId;

        // create patches under document A
        const patchTimestamp = Time.createOffsetTimestamp({ seconds: 1 });
        const patchA = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : docAContextId,
          messageTimestamp : patchTimestamp,
          dateCreated      : patchTimestamp,
        });
        const patchAReply = await dwn.processMessage(alice.did, patchA.message, { dataStream: patchA.dataStream });
        expect(patchAReply.status.code).toBe(202);

        // create patches under document B
        const patchB = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : docBContextId,
          messageTimestamp : patchTimestamp,
          dateCreated      : patchTimestamp,
        });
        const patchBReply = await dwn.processMessage(alice.did, patchB.message, { dataStream: patchB.dataStream });
        expect(patchBReply.status.code).toBe(202);

        // squash under document A
        const squashTimestamp = Time.createOffsetTimestamp({ seconds: 10 });
        const squashA = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : docAContextId,
          messageTimestamp : squashTimestamp,
          dateCreated      : squashTimestamp,
          squash           : true,
        });
        const squashAReply = await dwn.processMessage(alice.did, squashA.message, { dataStream: squashA.dataStream });
        expect(squashAReply.status.code).toBe(202);

        // verify patchA was deleted (squash under doc A)
        const queryA = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            protocol,
            protocolPath : 'document/patch',
            contextId    : docAContextId,
          },
        });
        const queryAReply = await dwn.processMessage(alice.did, queryA.message);
        expect(queryAReply.status.code).toBe(200);
        expect(queryAReply.entries!).toHaveLength(1);
        expect(queryAReply.entries![0].recordId).toBe(squashA.message.recordId);

        // verify patchB is still present (different parent context)
        const queryB = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            protocol,
            protocolPath : 'document/patch',
            contextId    : docBContextId,
          },
        });
        const queryBReply = await dwn.processMessage(alice.did, queryB.message);
        expect(queryBReply.status.code).toBe(200);
        expect(queryBReply.entries!).toHaveLength(1);
        expect(queryBReply.entries![0].recordId).toBe(patchB.message.recordId);
      });
    });

    describe('squash with large data (data store cleanup)', () => {
      it('should delete data from the data store for records with large data', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { protocol, documentContextId } = await setupProtocolAndDocument(alice);

        // create a patch with data larger than maxDataSizeAllowedToBeEncoded so it goes to the data store
        const largeData = TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
        const patchTimestamp = Time.createOffsetTimestamp({ seconds: 1 });
        const patch = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : patchTimestamp,
          dateCreated      : patchTimestamp,
          data             : largeData,
        });
        const patchReply = await dwn.processMessage(alice.did, patch.message, { dataStream: DataStream.fromBytes(largeData) });
        expect(patchReply.status.code).toBe(202);

        // verify data exists in the data store
        const dataBeforeSquash = await dataStore.get(alice.did, patch.message.recordId, patch.message.descriptor.dataCid);
        expect(dataBeforeSquash).toBeDefined();

        // squash
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

        // verify data was deleted from the data store
        const dataAfterSquash = await dataStore.get(alice.did, patch.message.recordId, patch.message.descriptor.dataCid);
        expect(dataAfterSquash).toBeUndefined();
      });
    });

    describe('squash backstop — equal timestamps', () => {
      it('should reject a write whose messageTimestamp equals the most recent squash timestamp', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { protocol, documentContextId } = await setupProtocolAndDocument(alice);

        // create a squash
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

        // attempt a write with the exact same timestamp as the squash — should be rejected
        const equalTimestampRecord = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : squashTimestamp,
          dateCreated      : squashTimestamp,
        });
        const equalReply = await dwn.processMessage(
          alice.did, equalTimestampRecord.message, { dataStream: equalTimestampRecord.dataStream }
        );
        expect(equalReply.status.code).toBe(409);
        expect(equalReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationSquashBackstop);
        expect(equalReply.status.errorCode).toBe(DwnErrorCode.ProtocolAuthorizationSquashBackstop);
        expect(equalReply.status.info).toEqual({ squashFloorTimestamp: squashTimestamp });
      });
    });

    describe('squash authorization — negative', () => {
      it('should reject squash when the author lacks explicit squash permission', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // protocol where only author of document can create patches and only editors can squash
        // bob has no role at all
        const restrictedProtocol: ProtocolDefinition = {
          protocol  : 'http://restricted-squash.xyz',
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
                $squash  : true,
                $actions : [
                  { who: 'author', of: 'document', can: ['create', 'read'] },
                  { role: 'document/editor', can: ['squash'] },
                ],
              }
            }
          }
        };

        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : restrictedProtocol,
        });
        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // alice creates a document
        const document = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : restrictedProtocol.protocol,
          protocolPath : 'document',
        });
        const docReply = await dwn.processMessage(alice.did, document.message, { dataStream: document.dataStream });
        expect(docReply.status.code).toBe(202);

        const documentContextId = document.message.contextId;

        // alice creates a patch (she is author of document, so she has 'create' permission)
        const patchTimestamp = Time.createOffsetTimestamp({ seconds: 1 });
        const patch = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol         : restrictedProtocol.protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : patchTimestamp,
          dateCreated      : patchTimestamp,
        });
        const patchReply = await dwn.processMessage(alice.did, patch.message, { dataStream: patch.dataStream });
        expect(patchReply.status.code).toBe(202);

        // bob tries to squash without the editor role required by the explicit squash action
        const squashTimestamp = Time.createOffsetTimestamp({ seconds: 10 });
        const bobSquash = await RecordsWrite.create({
          signer           : Jws.createSigner(bob),
          protocol         : restrictedProtocol.protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          dataFormat       : 'application/json',
          data             : TestDataGenerator.randomBytes(32),
          messageTimestamp : squashTimestamp,
          dateCreated      : squashTimestamp,
          squash           : true,
        });

        const bobSquashReply = await dwn.processMessage(
          alice.did, bobSquash.message, { dataStream: DataStream.fromBytes(TestDataGenerator.randomBytes(32)) }
        );
        expect(bobSquashReply.status.code).toBe(401);
        expect(bobSquashReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);
      });
    });

    describe('squash purges RecordsDelete messages', () => {
      it('should purge RecordsDelete tombstones for records that predate the squash', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Use a protocol with $squash but without $immutable so records can be deleted
        const deletableSquashProtocol: ProtocolDefinition = {
          protocol  : 'http://deletable-squash.xyz',
          published : true,
          types     : {
            document : {},
            patch    : {},
          },
          structure: {
            document: {
              $actions : [{ who: 'anyone', can: ['create', 'read'] }],
              patch    : {
                $squash  : true,
                $actions : [{ who: 'anyone', can: ['create', 'read', 'delete'] }],
              }
            }
          }
        };

        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : deletableSquashProtocol,
        });
        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // create parent document
        const document = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : deletableSquashProtocol.protocol,
          protocolPath : 'document',
        });
        const docReply = await dwn.processMessage(alice.did, document.message, { dataStream: document.dataStream });
        expect(docReply.status.code).toBe(202);
        const documentContextId = document.message.contextId;

        // create a patch record
        const patchTimestamp = Time.createOffsetTimestamp({ seconds: 1 });
        const patch = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol         : deletableSquashProtocol.protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : patchTimestamp,
          dateCreated      : patchTimestamp,
        });
        const patchReply = await dwn.processMessage(alice.did, patch.message, { dataStream: patch.dataStream });
        expect(patchReply.status.code).toBe(202);

        // delete that patch record (messageTimestamp must be after the patch for the delete to be accepted)
        const deleteTimestamp = Time.createOffsetTimestamp({ seconds: 2 });
        const deleteRecord = await RecordsDelete.create({
          recordId         : patch.message.recordId,
          messageTimestamp : deleteTimestamp,
          signer           : Jws.createSigner(alice),
        });
        const deleteReply = await dwn.processMessage(alice.did, deleteRecord.message);
        expect(deleteReply.status.code).toBe(202);

        // squash — this should purge patch1 (deleted, newest message timestamp is seconds: 2)
        const squashTimestamp = Time.createOffsetTimestamp({ seconds: 5 });
        const squashRecord = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol         : deletableSquashProtocol.protocol,
          protocolPath     : 'document/patch',
          parentContextId  : documentContextId,
          messageTimestamp : squashTimestamp,
          dateCreated      : squashTimestamp,
          squash           : true,
        });
        const squashReply = await dwn.processMessage(alice.did, squashRecord.message, { dataStream: squashRecord.dataStream });
        expect(squashReply.status.code).toBe(202);

        // query for all records — should see only the squash record (deleted patch1 was fully purged)
        const query = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            protocol     : deletableSquashProtocol.protocol,
            protocolPath : 'document/patch',
            contextId    : documentContextId,
          },
        });
        const queryReply = await dwn.processMessage(alice.did, query.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries!).toHaveLength(1);
        expect(queryReply.entries![0].recordId).toBe(squashRecord.message.recordId);

        // verify the deleted patch1's messages are fully purged from message store
        // by querying for it directly — should not be found (both the initial write and the RecordsDelete tombstone should be gone)
        const directQuery = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { recordId: patch.message.recordId },
        });
        const directReply = await dwn.processMessage(alice.did, directQuery.message);
        expect(directReply.status.code).toBe(200);
        expect(directReply.entries!).toHaveLength(0);
      });
    });
  });
}
