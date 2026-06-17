import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { DataStore, MessageStore, ProtocolDefinition, ResumableTaskStore } from '../../src/index.js';

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

export function testRecordsImmutable(): void {
  describe('Records $immutable', () => {
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

    describe('ProtocolsConfigure validation', () => {
      it('should accept a protocol definition with $immutable: true', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://immutable-test.xyz',
          published : true,
          types     : { credential: {} },
          structure : {
            credential: {
              $immutable : true,
              $actions   : [{ who: 'anyone', can: ['create', 'read'] }],
            }
          }
        };

        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        const reply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(reply.status.code).toBe(202);
      });

      it('should reject $immutable on a $ref node', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://bad-immutable-ref.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : {},
          structure : {
            thread: {
              $ref       : 'threads:thread',
              $immutable : true,
            },
          },
        };

        try {
          await ProtocolsConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ProtocolsConfigureInvalidRefNodeHasDirectives);
        }
      });

      it('should warn when $immutable is combined with update or co-update actions', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const warnSpy = sinon.spy(console, 'warn');

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://immutable-warn-test.xyz',
          published : true,
          types     : { credential: {} },
          structure : {
            credential: {
              $immutable : true,
              $actions   : [{ who: 'anyone', can: ['create', 'update'] }],
            }
          }
        };

        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });

        const reply = await dwn.processMessage(alice.did, protocolConfig.message);
        expect(reply.status.code).toBe(202);

        expect(warnSpy.called).toBe(true);
        expect(warnSpy.firstCall.args[0]).toContain('$immutable: true');
        expect(warnSpy.firstCall.args[0]).toContain('update');
      });
    });

    describe('runtime enforcement', () => {
      it('should allow initial writes to immutable protocol paths', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://immutable-test.xyz',
          published : true,
          types     : { credential: {} },
          structure : {
            credential: {
              $immutable : true,
              $actions   : [{ who: 'anyone', can: ['create', 'read'] }],
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

        const record = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'credential',
        });

        const reply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
        expect(reply.status.code).toBe(202);
      });

      it('should reject updates to records at immutable protocol paths', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://immutable-test.xyz',
          published : true,
          types     : { credential: {} },
          structure : {
            credential: {
              $immutable : true,
              $actions   : [{ who: 'anyone', can: ['create', 'read'] }],
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

        // initial write — should succeed
        const record = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'credential',
        });

        const writeReply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
        expect(writeReply.status.code).toBe(202);

        // update the same record — should be rejected
        const updatedRecord = await TestDataGenerator.generateFromRecordsWrite({
          author        : alice,
          existingWrite : record.recordsWrite,
        });

        const updateReply = await dwn.processMessage(alice.did, updatedRecord.message, { dataStream: updatedRecord.dataStream });
        expect(updateReply.status.code).toBe(400);
        expect(updateReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationImmutableRecord);
      });

      it('should still allow deletion of immutable records when authorized by $actions', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://immutable-test.xyz',
          published : true,
          types     : { credential: {} },
          structure : {
            credential: {
              $immutable : true,
              $actions   : [{ who: 'anyone', can: ['create', 'read', 'delete'] }],
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

        // initial write
        const record = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'credential',
        });

        const writeReply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
        expect(writeReply.status.code).toBe(202);

        // delete — should succeed even though record is immutable
        const deleteRecord = await TestDataGenerator.generateRecordsDelete({
          author   : alice,
          recordId : record.message.recordId,
        });

        const deleteReply = await dwn.processMessage(alice.did, deleteRecord.message);
        expect(deleteReply.status.code).toBe(202);
      });

      it('should allow updates to non-immutable protocol paths in the same protocol', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://mixed-immutable-test.xyz',
          published : true,
          types     : {
            credential : {},
            note       : {},
          },
          structure: {
            credential: {
              $immutable : true,
              $actions   : [{ who: 'anyone', can: ['create', 'read'] }],
            },
            note: {
              $actions: [{ who: 'anyone', can: ['create', 'read', 'update'] }],
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

        // write a note
        const noteRecord = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'note',
        });

        const noteReply = await dwn.processMessage(alice.did, noteRecord.message, { dataStream: noteRecord.dataStream });
        expect(noteReply.status.code).toBe(202);

        // update the note — should succeed because note is NOT immutable
        const updatedNote = await TestDataGenerator.generateFromRecordsWrite({
          author        : alice,
          existingWrite : noteRecord.recordsWrite,
        });

        const updateReply = await dwn.processMessage(alice.did, updatedNote.message, { dataStream: updatedNote.dataStream });
        expect(updateReply.status.code).toBe(202);

        // write an immutable credential
        const credRecord = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'credential',
        });

        const credReply = await dwn.processMessage(alice.did, credRecord.message, { dataStream: credRecord.dataStream });
        expect(credReply.status.code).toBe(202);

        // try to update the credential — should be rejected
        const updatedCred = await TestDataGenerator.generateFromRecordsWrite({
          author        : alice,
          existingWrite : credRecord.recordsWrite,
        });

        const credUpdateReply = await dwn.processMessage(alice.did, updatedCred.message, { dataStream: updatedCred.dataStream });
        expect(credUpdateReply.status.code).toBe(400);
        expect(credUpdateReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationImmutableRecord);
      });

      it('should allow multiple initial writes (different records) to the same immutable protocol path', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://immutable-test.xyz',
          published : true,
          types     : { credential: {} },
          structure : {
            credential: {
              $immutable : true,
              $actions   : [{ who: 'anyone', can: ['create', 'read'] }],
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

        // write multiple distinct records — all should succeed
        for (let i = 0; i < 3; i++) {
          const record = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            recipient    : alice.did,
            protocol,
            protocolPath : 'credential',
          });

          const reply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
          expect(reply.status.code).toBe(202);
        }
      });
    });
  });
}

testRecordsImmutable();
