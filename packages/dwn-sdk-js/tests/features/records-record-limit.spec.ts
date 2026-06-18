import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { Pagination } from '../../src/types/message-types.js';
import type { PaginationCursor } from '../../src/types/query-types.js';
import type {
  DataStore, MessageStore, ProtocolDefinition, RecordsCountReply, RecordsQueryReply, RecordsReadReply,
  RecordsSubscribeReply, ResumableTaskStore
} from '../../src/index.js';
import type { GenerateRecordsWriteOutput, Persona } from '../utils/test-data-generator.js';

import sinon from 'sinon';

import { DataStream } from '../../src/utils/data-stream.js';
import { DidKey } from '@enbox/dids';
import { Dwn } from '../../src/dwn.js';
import { DwnConstant } from '../../src/core/dwn-constant.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/utils/jws.js';
import { ProtocolsConfigure } from '../../src/interfaces/protocols-configure.js';
import { RecordsRead } from '../../src/interfaces/records-read.js';
import { sleep } from '@enbox/common';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { UniversalResolver } from '@enbox/dids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStoreLevel, MessageStoreLevel, ResumableTaskStoreLevel } from '../../src/index.js';

export function testRecordsRecordLimit(): void {
  describe('Records $recordLimit', () => {
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

    async function installProtocol(input: {
      author: Persona;
      definition: ProtocolDefinition;
      targetDwn?: Dwn;
    }): Promise<void> {
      const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
        author             : input.author,
        protocolDefinition : input.definition,
        messageTimestamp   : '2024-01-01T00:00:00.000000Z',
      });

      const reply = await (input.targetDwn ?? dwn).processMessage(input.author.did, protocolConfig.message);
      expect(reply.status.code).toBe(202);
    }

    async function writeProtocolRecord(input: {
      author: Persona;
      protocol: string;
      protocolPath: string;
      dateCreated: string;
      parentContextId?: string;
      targetDwn?: Dwn;
    }): Promise<GenerateRecordsWriteOutput> {
      const record = await TestDataGenerator.generateRecordsWrite({
        author           : input.author,
        recipient        : input.author.did,
        protocol         : input.protocol,
        protocolPath     : input.protocolPath,
        parentContextId  : input.parentContextId,
        dateCreated      : input.dateCreated,
        messageTimestamp : input.dateCreated,
      });

      const reply = await (input.targetDwn ?? dwn).processMessage(input.author.did, record.message, { dataStream: record.dataStream });
      expect(reply.status.code).toBe(202);
      return record;
    }

    async function queryProtocolRecordIds(input: {
      author: Persona;
      protocol: string;
      protocolPath: string;
      contextId?: string;
      pagination?: Pagination;
      targetDwn?: Dwn;
    }): Promise<{ recordIds: string[]; cursor?: PaginationCursor }> {
      const recordsQuery = await TestDataGenerator.generateRecordsQuery({
        author : input.author,
        filter : {
          protocol     : input.protocol,
          protocolPath : input.protocolPath,
          ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
        },
        pagination: input.pagination,
      });

      const reply = await (input.targetDwn ?? dwn).processMessage(input.author.did, recordsQuery.message) as RecordsQueryReply;
      expect(reply.status.code).toBe(200);

      return {
        recordIds : reply.entries?.map((entry): string => entry.recordId) ?? [],
        cursor    : reply.cursor,
      };
    }

    async function countProtocolRecords(input: {
      author: Persona;
      protocol: string;
      protocolPath: string;
      contextId?: string;
      targetDwn?: Dwn;
    }): Promise<number> {
      const recordsCount = await TestDataGenerator.generateRecordsCount({
        author : input.author,
        filter : {
          protocol     : input.protocol,
          protocolPath : input.protocolPath,
          ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
        },
      });

      const reply = await (input.targetDwn ?? dwn).processMessage(input.author.did, recordsCount.message) as RecordsCountReply;
      expect(reply.status.code).toBe(200);
      return reply.count!;
    }

    async function readRecord(input: {
      author: Persona;
      recordId: string;
      targetDwn?: Dwn;
    }): Promise<RecordsReadReply> {
      const recordsRead = await RecordsRead.create({
        signer : Jws.createSigner(input.author),
        filter : { recordId: input.recordId },
      });

      return await (input.targetDwn ?? dwn).processMessage(input.author.did, recordsRead.message) as RecordsReadReply;
    }

    async function subscribeSnapshotRecordIds(input: {
      author: Persona;
      protocol: string;
      protocolPath: string;
      targetDwn?: Dwn;
    }): Promise<string[]> {
      const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
        author : input.author,
        filter : {
          protocol     : input.protocol,
          protocolPath : input.protocolPath,
        },
      });

      const reply = await (input.targetDwn ?? dwn).processMessage(
        input.author.did,
        recordsSubscribe.message,
        { subscriptionHandler: () => {} },
      ) as RecordsSubscribeReply;
      expect(reply.status.code).toBe(200);
      await reply.subscription?.close();
      return reply.entries?.map((entry): string => entry.recordId) ?? [];
    }

    async function applyReplicatedWrite(input: {
      targetDwn: Dwn;
      tenant: string;
      record: GenerateRecordsWriteOutput;
    }): Promise<void> {
      const result = await input.targetDwn.applyReplicatedMessage(input.tenant, input.record.message, {
        dataStream: DataStream.fromBytes(input.record.dataBytes!),
      });

      if (result.kind !== 'Applied' && result.kind !== 'Duplicate' && result.kind !== 'Superseded') {
        throw new Error(`unexpected replicated write result ${result.kind}`);
      }
    }

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

      it('should reject $recordLimit above the supported max', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const definition: ProtocolDefinition = {
          protocol  : 'http://example.com/record-limit',
          published : true,
          types     : { message: {} },
          structure : {
            message: {
              $recordLimit: { max: DwnConstant.maxRecordLimit + 1, strategy: 'reject' },
            }
          }
        };

        const promise = ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        await expect(promise).rejects.toThrow(DwnErrorCode.ProtocolsConfigureInvalidRecordLimit);
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

    describe('read-time occupancy projection — reject strategy', () => {
      it('should admit candidates and project Query, Read, and Count to top-ranked occupants', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : `http://record-limit-${TestDataGenerator.randomString(12)}.xyz`,
          published : true,
          types     : { blob: {} },
          structure : {
            blob: {
              $recordLimit: { max: 2, strategy: 'reject' },
            }
          }
        };
        const protocol = protocolDefinition.protocol;
        await installProtocol({ author: alice, definition: protocolDefinition });

        const record1 = await writeProtocolRecord({
          author       : alice,
          protocol,
          protocolPath : 'blob',
          dateCreated  : '2025-01-01T00:00:00.000000Z',
        });
        const duplicateReply = await dwn.processMessage(alice.did, record1.message, {
          dataStream: DataStream.fromBytes(record1.dataBytes!),
        });
        expect(duplicateReply.status.code).toBe(409);

        const record2 = await writeProtocolRecord({
          author       : alice,
          protocol,
          protocolPath : 'blob',
          dateCreated  : '2025-01-02T00:00:00.000000Z',
        });
        const record3 = await writeProtocolRecord({
          author       : alice,
          protocol,
          protocolPath : 'blob',
          dateCreated  : '2025-01-03T00:00:00.000000Z',
        });

        expect((await queryProtocolRecordIds({ author: alice, protocol, protocolPath: 'blob' })).recordIds).toEqual([
          record1.message.recordId,
          record2.message.recordId,
        ]);
        expect(await countProtocolRecords({ author: alice, protocol, protocolPath: 'blob' })).toBe(2);

        const visibleRead = await readRecord({ author: alice, recordId: record1.message.recordId });
        expect(visibleRead.status.code).toBe(200);
        expect(visibleRead.entry?.recordsWrite?.recordId).toBe(record1.message.recordId);

        const hiddenRead = await readRecord({ author: alice, recordId: record3.message.recordId });
        expect(hiddenRead.status.code).toBe(404);
      });

      it('should promote the next candidate at read time when the current occupant is deleted', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : `http://record-limit-${TestDataGenerator.randomString(12)}.xyz`,
          published : true,
          types     : { profile: {} },
          structure : {
            profile: {
              $recordLimit: { max: 1, strategy: 'reject' },
            }
          }
        };
        const protocol = protocolDefinition.protocol;
        await installProtocol({ author: alice, definition: protocolDefinition });

        const record1 = await writeProtocolRecord({
          author       : alice,
          protocol,
          protocolPath : 'profile',
          dateCreated  : '2025-01-01T00:00:00.000000Z',
        });
        const record2 = await writeProtocolRecord({
          author       : alice,
          protocol,
          protocolPath : 'profile',
          dateCreated  : '2025-01-02T00:00:00.000000Z',
        });

        expect((await queryProtocolRecordIds({ author: alice, protocol, protocolPath: 'profile' })).recordIds).toEqual([
          record1.message.recordId,
        ]);

        const deleteRecord = await TestDataGenerator.generateRecordsDelete({
          author   : alice,
          recordId : record1.message.recordId,
        });
        const deleteReply = await dwn.processMessage(alice.did, deleteRecord.message);
        expect(deleteReply.status.code).toBe(202);

        expect((await queryProtocolRecordIds({ author: alice, protocol, protocolPath: 'profile' })).recordIds).toEqual([
          record2.message.recordId,
        ]);
        expect((await readRecord({ author: alice, recordId: record2.message.recordId })).status.code).toBe(200);
      });

      it('should project occupancy independently per exact parent context without scanning broad cross-context queries', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : `http://record-limit-${TestDataGenerator.randomString(12)}.xyz`,
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
        await installProtocol({ author: alice, definition: protocolDefinition });

        const room1 = await writeProtocolRecord({
          author       : alice,
          protocol,
          protocolPath : 'room',
          dateCreated  : '2025-01-01T00:00:00.000000Z',
        });
        const room2 = await writeProtocolRecord({
          author       : alice,
          protocol,
          protocolPath : 'room',
          dateCreated  : '2025-01-02T00:00:00.000000Z',
        });

        const room1Messages = [
          await writeProtocolRecord({
            author          : alice,
            protocol,
            protocolPath    : 'room/message',
            parentContextId : room1.message.contextId,
            dateCreated     : '2025-02-01T00:00:00.000000Z',
          }),
          await writeProtocolRecord({
            author          : alice,
            protocol,
            protocolPath    : 'room/message',
            parentContextId : room1.message.contextId,
            dateCreated     : '2025-02-02T00:00:00.000000Z',
          }),
          await writeProtocolRecord({
            author          : alice,
            protocol,
            protocolPath    : 'room/message',
            parentContextId : room1.message.contextId,
            dateCreated     : '2025-02-03T00:00:00.000000Z',
          }),
        ];
        const room2Messages = [
          await writeProtocolRecord({
            author          : alice,
            protocol,
            protocolPath    : 'room/message',
            parentContextId : room2.message.contextId,
            dateCreated     : '2025-03-01T00:00:00.000000Z',
          }),
          await writeProtocolRecord({
            author          : alice,
            protocol,
            protocolPath    : 'room/message',
            parentContextId : room2.message.contextId,
            dateCreated     : '2025-03-02T00:00:00.000000Z',
          }),
          await writeProtocolRecord({
            author          : alice,
            protocol,
            protocolPath    : 'room/message',
            parentContextId : room2.message.contextId,
            dateCreated     : '2025-03-03T00:00:00.000000Z',
          }),
        ];

        expect((await queryProtocolRecordIds({
          author       : alice,
          protocol,
          protocolPath : 'room/message',
          contextId    : room1.message.contextId,
        })).recordIds).toEqual([
          room1Messages[0].message.recordId,
          room1Messages[1].message.recordId,
        ]);
        expect((await queryProtocolRecordIds({
          author       : alice,
          protocol,
          protocolPath : 'room/message',
          contextId    : room2.message.contextId,
        })).recordIds).toEqual([
          room2Messages[0].message.recordId,
          room2Messages[1].message.recordId,
        ]);
        expect((await queryProtocolRecordIds({ author: alice, protocol, protocolPath: 'room/message' })).recordIds).toEqual([
          room1Messages[0].message.recordId,
          room1Messages[1].message.recordId,
          room1Messages[2].message.recordId,
          room2Messages[0].message.recordId,
          room2Messages[1].message.recordId,
          room2Messages[2].message.recordId,
        ]);
      });

      it('should paginate over the projected occupant set for max:N scopes', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : `http://record-limit-${TestDataGenerator.randomString(12)}.xyz`,
          published : true,
          types     : { item: {} },
          structure : {
            item: {
              $recordLimit: { max: 3, strategy: 'reject' },
            }
          }
        };
        const protocol = protocolDefinition.protocol;
        await installProtocol({ author: alice, definition: protocolDefinition });

        const records: GenerateRecordsWriteOutput[] = [];
        for (let i = 1; i <= 5; i++) {
          records.push(await writeProtocolRecord({
            author       : alice,
            protocol,
            protocolPath : 'item',
            dateCreated  : `2025-01-0${i}T00:00:00.000000Z`,
          }));
        }

        const page1 = await queryProtocolRecordIds({
          author       : alice,
          protocol,
          protocolPath : 'item',
          pagination   : { limit: 2 },
        });
        expect(page1.recordIds).toEqual([
          records[0].message.recordId,
          records[1].message.recordId,
        ]);
        expect(page1.cursor).toBeDefined();

        const page2 = await queryProtocolRecordIds({
          author       : alice,
          protocol,
          protocolPath : 'item',
          pagination   : { limit: 2, cursor: page1.cursor! },
        });
        expect(page2.recordIds).toEqual([records[2].message.recordId]);
        expect(page2.cursor).toBeUndefined();
      });

      it('should project RecordsSubscribe snapshots and suppress hidden live writes', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : `http://record-limit-${TestDataGenerator.randomString(12)}.xyz`,
          published : true,
          types     : { status: {} },
          structure : {
            status: {
              $recordLimit: { max: 1, strategy: 'reject' },
            }
          }
        };
        const protocol = protocolDefinition.protocol;
        await installProtocol({ author: alice, definition: protocolDefinition });

        const visibleRecord = await writeProtocolRecord({
          author       : alice,
          protocol,
          protocolPath : 'status',
          dateCreated  : '2025-01-01T00:00:00.000000Z',
        });
        const hiddenRecord = await writeProtocolRecord({
          author       : alice,
          protocol,
          protocolPath : 'status',
          dateCreated  : '2025-01-02T00:00:00.000000Z',
        });

        expect(await subscribeSnapshotRecordIds({ author: alice, protocol, protocolPath: 'status' })).toEqual([
          visibleRecord.message.recordId,
        ]);

        const liveRecordIds: string[] = [];
        const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : {
            protocol,
            protocolPath: 'status',
          },
        });
        const subscribeReply = await dwn.processMessage(alice.did, recordsSubscribe.message, {
          subscriptionHandler: (subscriptionMessage): void => {
            if (subscriptionMessage.type === 'event') {
              const eventMessage = subscriptionMessage.event.message;
              if (eventMessage.descriptor.method === 'Write' && 'recordId' in eventMessage && typeof eventMessage.recordId === 'string') {
                liveRecordIds.push(eventMessage.recordId);
              }
            }
          },
        }) as RecordsSubscribeReply;
        expect(subscribeReply.status.code).toBe(200);

        const laterHiddenRecord = await writeProtocolRecord({
          author       : alice,
          protocol,
          protocolPath : 'status',
          dateCreated  : '2025-01-03T00:00:00.000000Z',
        });
        expect(hiddenRecord.message.recordId).not.toBe(laterHiddenRecord.message.recordId);
        await sleep(100);
        expect(liveRecordIds).toEqual([]);

        await subscribeReply.subscription?.close();
      });

      it('should converge projected query results when replicas create max:1 and max:N occupants offline', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const testId = TestDataGenerator.randomString(12);
        const replicaAStore = new MessageStoreLevel({ location: `__TESTDATA__/record-limit-${testId}/message-a` });
        const replicaADataStore = new DataStoreLevel({ blockstoreLocation: `__TESTDATA__/record-limit-${testId}/data-a` });
        const replicaATaskStore = new ResumableTaskStoreLevel({ location: `__TESTDATA__/record-limit-${testId}/task-a` });
        const replicaBStore = new MessageStoreLevel({ location: `__TESTDATA__/record-limit-${testId}/message-b` });
        const replicaBDataStore = new DataStoreLevel({ blockstoreLocation: `__TESTDATA__/record-limit-${testId}/data-b` });
        const replicaBTaskStore = new ResumableTaskStoreLevel({ location: `__TESTDATA__/record-limit-${testId}/task-b` });
        const replicaA = await Dwn.create({
          didResolver        : didResolver,
          messageStore       : replicaAStore,
          dataStore          : replicaADataStore,
          resumableTaskStore : replicaATaskStore,
        });
        const replicaB = await Dwn.create({
          didResolver        : didResolver,
          messageStore       : replicaBStore,
          dataStore          : replicaBDataStore,
          resumableTaskStore : replicaBTaskStore,
        });

        try {
          const protocolDefinition: ProtocolDefinition = {
            protocol  : `http://record-limit-offline-${testId}.xyz`,
            published : true,
            types     : {
              note    : {},
              profile : {},
            },
            structure: {
              note: {
                $recordLimit: { max: 2, strategy: 'reject' },
              },
              profile: {
                $recordLimit: { max: 1, strategy: 'reject' },
              }
            }
          };
          const protocol = protocolDefinition.protocol;
          await installProtocol({ author: alice, definition: protocolDefinition, targetDwn: replicaA });
          await installProtocol({ author: alice, definition: protocolDefinition, targetDwn: replicaB });

          const profileA = await writeProtocolRecord({
            author       : alice,
            protocol,
            protocolPath : 'profile',
            dateCreated  : '2025-01-01T00:00:00.000000Z',
            targetDwn    : replicaA,
          });
          const profileB = await writeProtocolRecord({
            author       : alice,
            protocol,
            protocolPath : 'profile',
            dateCreated  : '2025-01-02T00:00:00.000000Z',
            targetDwn    : replicaB,
          });
          const noteA1 = await writeProtocolRecord({
            author       : alice,
            protocol,
            protocolPath : 'note',
            dateCreated  : '2025-02-01T00:00:00.000000Z',
            targetDwn    : replicaA,
          });
          const noteB = await writeProtocolRecord({
            author       : alice,
            protocol,
            protocolPath : 'note',
            dateCreated  : '2025-02-02T00:00:00.000000Z',
            targetDwn    : replicaB,
          });
          const noteA2 = await writeProtocolRecord({
            author       : alice,
            protocol,
            protocolPath : 'note',
            dateCreated  : '2025-02-03T00:00:00.000000Z',
            targetDwn    : replicaA,
          });

          await applyReplicatedWrite({ targetDwn: replicaA, tenant: alice.did, record: profileB });
          await applyReplicatedWrite({ targetDwn: replicaB, tenant: alice.did, record: profileA });
          await applyReplicatedWrite({ targetDwn: replicaA, tenant: alice.did, record: noteB });
          await applyReplicatedWrite({ targetDwn: replicaB, tenant: alice.did, record: noteA1 });
          await applyReplicatedWrite({ targetDwn: replicaB, tenant: alice.did, record: noteA2 });

          const expectedProfileIds = [profileA.message.recordId];
          const expectedNoteIds = [
            noteA1.message.recordId,
            noteB.message.recordId,
          ];
          expect((await queryProtocolRecordIds({ author: alice, protocol, protocolPath: 'profile', targetDwn: replicaA })).recordIds).toEqual(expectedProfileIds);
          expect((await queryProtocolRecordIds({ author: alice, protocol, protocolPath: 'profile', targetDwn: replicaB })).recordIds).toEqual(expectedProfileIds);
          expect((await queryProtocolRecordIds({ author: alice, protocol, protocolPath: 'note', targetDwn: replicaA })).recordIds).toEqual(expectedNoteIds);
          expect((await queryProtocolRecordIds({ author: alice, protocol, protocolPath: 'note', targetDwn: replicaB })).recordIds).toEqual(expectedNoteIds);
        } finally {
          await replicaAStore.clear();
          await replicaADataStore.clear();
          await replicaATaskStore.clear();
          await replicaBStore.clear();
          await replicaBDataStore.clear();
          await replicaBTaskStore.clear();
          await replicaA.close();
          await replicaB.close();
        }
      });

      it('should not count updates toward the record limit', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : `http://record-limit-${TestDataGenerator.randomString(12)}.xyz`,
          published : true,
          types     : { blob: {} },
          structure : {
            blob: {
              $recordLimit: { max: 1, strategy: 'reject' },
            }
          }
        };
        const protocol = protocolDefinition.protocol;
        await installProtocol({ author: alice, definition: protocolDefinition });

        const record = await writeProtocolRecord({
          author       : alice,
          protocol,
          protocolPath : 'blob',
          dateCreated  : '2025-01-01T00:00:00.000000Z',
        });
        const updatedRecord = await TestDataGenerator.generateFromRecordsWrite({
          author        : alice,
          existingWrite : record.recordsWrite,
        });

        const updateReply = await dwn.processMessage(alice.did, updatedRecord.message, { dataStream: updatedRecord.dataStream });
        expect(updateReply.status.code).toBe(202);
        expect((await queryProtocolRecordIds({ author: alice, protocol, protocolPath: 'blob' })).recordIds).toEqual([
          record.message.recordId,
        ]);
      });

      it('should reject purgeOldest strategy at write time with not-implemented error', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : `http://record-limit-${TestDataGenerator.randomString(12)}.xyz`,
          published : true,
          types     : { blob: {} },
          structure : {
            blob: {
              $recordLimit: { max: 1, strategy: 'purgeOldest' },
            }
          }
        };
        const protocol = protocolDefinition.protocol;
        await installProtocol({ author: alice, definition: protocolDefinition });

        const record = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : alice.did,
          protocol,
          protocolPath : 'blob',
        });

        const reply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationRecordLimitStrategyNotImplemented);
      });
    });
  });
}

// Self-register when run directly
testRecordsRecordLimit();
