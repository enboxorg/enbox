import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { DataStore, MessageStore, ProtocolDefinition, ResumableTaskStore, StateIndex } from '../../src/index.js';

import sinon from 'sinon';

import { DidKey } from '@enbox/dids';
import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/utils/jws.js';
import { ProtocolsConfigure } from '../../src/interfaces/protocols-configure.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { UniversalResolver } from '@enbox/dids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

export function testRecordsRecordLimit(): void {
  describe('Records $recordLimit', () => {
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

    describe('ProtocolsConfigure validation', () => {
      it('should allow $recordLimit with valid max and strategy', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const definition: ProtocolDefinition = {
          protocol  : 'http://example.com/record-limit',
          published : true,
          types     : { message: {} },
          structure : {
            message: {
              $recordLimit: { max: 5, strategy: 'reject' },
            }
          }
        };

        const protocolsConfigure = await ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        expect(protocolsConfigure.message.descriptor.definition).toBeDefined();
        expect(protocolsConfigure.message.descriptor.definition.structure.message.$recordLimit).toEqual({
          max      : 5,
          strategy : 'reject',
        });
      });

      it('should allow $recordLimit with max of 1', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const definition: ProtocolDefinition = {
          protocol  : 'http://example.com/record-limit',
          published : true,
          types     : { profile: {} },
          structure : {
            profile: {
              $recordLimit: { max: 1, strategy: 'reject' },
            }
          }
        };

        const protocolsConfigure = await ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        expect(protocolsConfigure.message.descriptor.definition.structure.profile.$recordLimit).toEqual({
          max      : 1,
          strategy : 'reject',
        });
      });

      it('should allow $recordLimit with purgeOldest strategy (schema validation only)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const definition: ProtocolDefinition = {
          protocol  : 'http://example.com/record-limit',
          published : true,
          types     : { status: {} },
          structure : {
            status: {
              $recordLimit: { max: 10, strategy: 'purgeOldest' },
            }
          }
        };

        const protocolsConfigure = await ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        expect(protocolsConfigure.message.descriptor.definition.structure.status.$recordLimit).toEqual({
          max      : 10,
          strategy : 'purgeOldest',
        });
      });

      it('should reject $recordLimit with max less than 1', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const definition: ProtocolDefinition = {
          protocol  : 'http://example.com/record-limit',
          published : true,
          types     : { message: {} },
          structure : {
            message: {
              $recordLimit: { max: 0, strategy: 'reject' } as any,
            }
          }
        };

        const promise = ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        await expect(promise).rejects.toThrow('SchemaValidator');
      });

      it('should reject $recordLimit with non-integer max', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const definition: ProtocolDefinition = {
          protocol  : 'http://example.com/record-limit',
          published : true,
          types     : { message: {} },
          structure : {
            message: {
              $recordLimit: { max: 2.5, strategy: 'reject' } as any,
            }
          }
        };

        const promise = ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        await expect(promise).rejects.toThrow('SchemaValidator');
      });

      it('should reject $recordLimit with missing strategy', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const definition: ProtocolDefinition = {
          protocol  : 'http://example.com/record-limit',
          published : true,
          types     : { message: {} },
          structure : {
            message: {
              $recordLimit: { max: 5 } as any,
            }
          }
        };

        const promise = ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        await expect(promise).rejects.toThrow('SchemaValidator');
      });

      it('should reject $recordLimit with invalid strategy', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const definition: ProtocolDefinition = {
          protocol  : 'http://example.com/record-limit',
          published : true,
          types     : { message: {} },
          structure : {
            message: {
              $recordLimit: { max: 5, strategy: 'invalidStrategy' } as any,
            }
          }
        };

        const promise = ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        await expect(promise).rejects.toThrow('SchemaValidator');
      });

      it('should allow $recordLimit on nested protocol paths', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const definition: ProtocolDefinition = {
          protocol  : 'http://example.com/record-limit',
          published : true,
          types     : {
            room    : {},
            message : {},
          },
          structure: {
            room: {
              message: {
                $recordLimit: { max: 100, strategy: 'reject' },
              }
            }
          }
        };

        const protocolsConfigure = await ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        const roomRuleSet = protocolsConfigure.message.descriptor.definition.structure.room as any;
        expect(roomRuleSet.message.$recordLimit).toEqual({
          max      : 100,
          strategy : 'reject',
        });
      });
    });

    describe('runtime enforcement — reject strategy', () => {
      it('should allow writes up to the record limit', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://record-limit-test.xyz',
          published : true,
          types     : { blob: {} },
          structure : {
            blob: {
              $recordLimit: { max: 3, strategy: 'reject' },
            }
          }
        };

        const protocol = protocolDefinition.protocol;
        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // write 3 records — all should succeed
        for (let i = 0; i < 3; i++) {
          const record = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            recipient    : alice.did,
            protocol,
            protocolPath : 'blob',
          });

          const reply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
          expect(reply.status.code).toBe(202);
        }
      });

      it('should reject writes that exceed the record limit', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://record-limit-test.xyz',
          published : true,
          types     : { blob: {} },
          structure : {
            blob: {
              $recordLimit: { max: 2, strategy: 'reject' },
            }
          }
        };

        const protocol = protocolDefinition.protocol;
        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // write 2 records — both should succeed
        for (let i = 0; i < 2; i++) {
          const record = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            recipient    : alice.did,
            protocol,
            protocolPath : 'blob',
          });

          const reply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
          expect(reply.status.code).toBe(202);
        }

        // 3rd record should be rejected
        const record3 = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'blob',
        });

        const reply3 = await dwn.processMessage(alice.did, record3.message, { dataStream: record3.dataStream });
        expect(reply3.status.code).toBe(400);
        expect(reply3.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationRecordLimitExceeded);
      });

      it('should enforce $recordLimit with max of 1 (singleton pattern)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://record-limit-test.xyz',
          published : true,
          types     : { profile: {} },
          structure : {
            profile: {
              $recordLimit: { max: 1, strategy: 'reject' },
            }
          }
        };

        const protocol = protocolDefinition.protocol;
        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // first record should succeed
        const record1 = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'profile',
        });

        const reply1 = await dwn.processMessage(alice.did, record1.message, { dataStream: record1.dataStream });
        expect(reply1.status.code).toBe(202);

        // second record should be rejected
        const record2 = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'profile',
        });

        const reply2 = await dwn.processMessage(alice.did, record2.message, { dataStream: record2.dataStream });
        expect(reply2.status.code).toBe(400);
        expect(reply2.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationRecordLimitExceeded);
      });

      it('should allow new writes after records are deleted to free up space', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://record-limit-test.xyz',
          published : true,
          types     : { blob: {} },
          structure : {
            blob: {
              $recordLimit: { max: 1, strategy: 'reject' },
            }
          }
        };

        const protocol = protocolDefinition.protocol;
        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // write first record
        const record1 = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'blob',
        });

        const reply1 = await dwn.processMessage(alice.did, record1.message, { dataStream: record1.dataStream });
        expect(reply1.status.code).toBe(202);

        // second write should be rejected
        const record2 = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'blob',
        });

        const reply2 = await dwn.processMessage(alice.did, record2.message, { dataStream: record2.dataStream });
        expect(reply2.status.code).toBe(400);

        // delete the first record
        const deleteRecord = await TestDataGenerator.generateRecordsDelete({
          author   : alice,
          recordId : record1.message.recordId,
        });

        const deleteReply = await dwn.processMessage(alice.did, deleteRecord.message);
        expect(deleteReply.status.code).toBe(202);

        // now a new write should succeed
        const record3 = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'blob',
        });

        const reply3 = await dwn.processMessage(alice.did, record3.message, { dataStream: record3.dataStream });
        expect(reply3.status.code).toBe(202);
      });

      it('should not count updates toward the record limit', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://record-limit-test.xyz',
          published : true,
          types     : { blob: {} },
          structure : {
            blob: {
              $recordLimit: { max: 1, strategy: 'reject' },
            }
          }
        };

        const protocol = protocolDefinition.protocol;
        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // write the record
        const record1 = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'blob',
        });

        const reply1 = await dwn.processMessage(alice.did, record1.message, { dataStream: record1.dataStream });
        expect(reply1.status.code).toBe(202);

        // update the same record — should succeed (not counted as new)
        const updatedRecord = await TestDataGenerator.generateFromRecordsWrite({
          author        : alice,
          existingWrite : record1.recordsWrite,
        });

        const updateReply = await dwn.processMessage(alice.did, updatedRecord.message, { dataStream: updatedRecord.dataStream });
        expect(updateReply.status.code).toBe(202);
      });

      it('should enforce $recordLimit per parent context for nested records', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://record-limit-test.xyz',
          published : true,
          types     : {
            room    : {},
            message : {},
          },
          structure: {
            room: {
              message: {
                $recordLimit: { max: 2, strategy: 'reject' },
              }
            }
          }
        };

        const protocol = protocolDefinition.protocol;
        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // create two rooms
        const room1 = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'room',
        });
        const room1Reply = await dwn.processMessage(alice.did, room1.message, { dataStream: room1.dataStream });
        expect(room1Reply.status.code).toBe(202);

        const room2 = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'room',
        });
        const room2Reply = await dwn.processMessage(alice.did, room2.message, { dataStream: room2.dataStream });
        expect(room2Reply.status.code).toBe(202);

        // write 2 messages in room1 — both should succeed
        for (let i = 0; i < 2; i++) {
          const msg = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            recipient       : alice.did,
            protocol,
            protocolPath    : 'room/message',
            parentContextId : room1.message.contextId,
          });
          const msgReply = await dwn.processMessage(alice.did, msg.message, { dataStream: msg.dataStream });
          expect(msgReply.status.code).toBe(202);
        }

        // 3rd message in room1 should be rejected
        const msg3 = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : alice.did,
          protocol,
          protocolPath    : 'room/message',
          parentContextId : room1.message.contextId,
        });
        const msg3Reply = await dwn.processMessage(alice.did, msg3.message, { dataStream: msg3.dataStream });
        expect(msg3Reply.status.code).toBe(400);
        expect(msg3Reply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationRecordLimitExceeded);

        // but room2 still has capacity — write 2 messages
        for (let i = 0; i < 2; i++) {
          const msg = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            recipient       : alice.did,
            protocol,
            protocolPath    : 'room/message',
            parentContextId : room2.message.contextId,
          });
          const msgReply = await dwn.processMessage(alice.did, msg.message, { dataStream: msg.dataStream });
          expect(msgReply.status.code).toBe(202);
        }

        // 3rd message in room2 should also be rejected
        const msg3Room2 = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : alice.did,
          protocol,
          protocolPath    : 'room/message',
          parentContextId : room2.message.contextId,
        });
        const msg3Room2Reply = await dwn.processMessage(alice.did, msg3Room2.message, { dataStream: msg3Room2.dataStream });
        expect(msg3Room2Reply.status.code).toBe(400);
        expect(msg3Room2Reply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationRecordLimitExceeded);
      });

      it('should reject purgeOldest strategy at write time with not-implemented error', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://record-limit-test.xyz',
          published : true,
          types     : { blob: {} },
          structure : {
            blob: {
              $recordLimit: { max: 1, strategy: 'purgeOldest' },
            }
          }
        };

        const protocol = protocolDefinition.protocol;
        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        const configReply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(configReply.status.code).toBe(202);

        // first record should succeed
        const record1 = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'blob',
        });

        const reply1 = await dwn.processMessage(alice.did, record1.message, { dataStream: record1.dataStream });
        expect(reply1.status.code).toBe(202);

        // second record should fail because purgeOldest is not yet implemented
        const record2 = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'blob',
        });

        const reply2 = await dwn.processMessage(alice.did, record2.message, { dataStream: record2.dataStream });
        expect(reply2.status.code).toBe(400);
        expect(reply2.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationRecordLimitStrategyNotImplemented);
      });

    });
  });
}

// Self-register when run directly
testRecordsRecordLimit();
