import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { DataStore, MessageStore, ProtocolDefinition, RecordsCountReply, RecordsQueryReply, RecordsReadReply, RecordsSubscribeReply, ResumableTaskStore } from '../../src/index.js';
import type { GenerateRecordsWriteOutput, Persona } from '../utils/test-data-generator.js';

import sinon from 'sinon';

import { DidKey } from '@enbox/dids';
import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/utils/jws.js';
import { RecordsRead } from '../../src/interfaces/records-read.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { UniversalResolver } from '@enbox/dids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

export function testRecordsNestedQueryScope(): void {
  describe('Records nested query scope', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let eventLog: EventLog;
    let dwn: Dwn;

    const protocolDefinition: ProtocolDefinition = {
      protocol  : 'http://nested-query-scope.xyz',
      published : true,
      types     : {
        avatar  : {},
        profile : {},
      },
      structure: {
        profile: {
          avatar: {},
        },
      },
    };

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

    async function installProtocol(author: Persona): Promise<void> {
      const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
        author,
        protocolDefinition,
      });

      const reply = await dwn.processMessage(author.did, protocolConfig.message);
      expect(reply.status.code).toBe(202);
    }

    async function writeProfile(author: Persona, dateCreated: string): Promise<GenerateRecordsWriteOutput> {
      return writeProtocolRecord({
        author,
        dateCreated,
        protocolPath: 'profile',
      });
    }

    async function writeAvatar(author: Persona, parentContextId: string, dateCreated: string): Promise<GenerateRecordsWriteOutput> {
      return writeProtocolRecord({
        author,
        dateCreated,
        parentContextId,
        protocolPath: 'profile/avatar',
      });
    }

    async function writeProtocolRecord(input: {
      author: Persona;
      dateCreated: string;
      parentContextId?: string;
      protocolPath: string;
    }): Promise<GenerateRecordsWriteOutput> {
      const record = await TestDataGenerator.generateRecordsWrite({
        author           : input.author,
        protocol         : protocolDefinition.protocol,
        protocolPath     : input.protocolPath,
        parentContextId  : input.parentContextId,
        dateCreated      : input.dateCreated,
        messageTimestamp : input.dateCreated,
      });

      const reply = await dwn.processMessage(input.author.did, record.message, { dataStream: record.dataStream });
      expect(reply.status.code).toBe(202);
      return record;
    }

    async function seedNestedRecords(): Promise<{
      alice: Persona;
      profile1: GenerateRecordsWriteOutput;
      profile2: GenerateRecordsWriteOutput;
      profile1Avatar1: GenerateRecordsWriteOutput;
      profile1Avatar2: GenerateRecordsWriteOutput;
      profile2Avatar: GenerateRecordsWriteOutput;
    }> {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      await installProtocol(alice);

      const profile1 = await writeProfile(alice, '2026-01-01T00:00:00.000000Z');
      const profile2 = await writeProfile(alice, '2026-01-02T00:00:00.000000Z');
      const profile1Avatar1 = await writeAvatar(alice, profile1.message.contextId, '2026-02-01T00:00:00.000000Z');
      const profile1Avatar2 = await writeAvatar(alice, profile1.message.contextId, '2026-02-02T00:00:00.000000Z');
      const profile2Avatar = await writeAvatar(alice, profile2.message.contextId, '2026-03-01T00:00:00.000000Z');

      return { alice, profile1, profile2, profile1Avatar1, profile1Avatar2, profile2Avatar };
    }

    it('should reject nested Query, Count, and Subscribe requests that do not pin the direct parent context', async () => {
      const { alice, profile1Avatar1 } = await seedNestedRecords();
      const filter = {
        protocol     : protocolDefinition.protocol,
        protocolPath : 'profile/avatar',
      };

      const recordsQuery = await TestDataGenerator.generateRecordsQuery({ author: alice, filter });
      const queryReply = await dwn.processMessage(alice.did, recordsQuery.message) as RecordsQueryReply;
      expect(queryReply.status.code).toBe(400);
      expect(queryReply.status.detail).toContain(DwnErrorCode.RecordsQueryFilterMissingRequiredProperties);
      expect(queryReply.entries).toBeUndefined();

      const childScopedQuery = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { ...filter, contextId: profile1Avatar1.message.contextId },
      });
      const childScopedQueryReply = await dwn.processMessage(alice.did, childScopedQuery.message) as RecordsQueryReply;
      expect(childScopedQueryReply.status.code).toBe(400);
      expect(childScopedQueryReply.status.detail).toContain(DwnErrorCode.RecordsQueryFilterMissingRequiredProperties);

      const recordsCount = await TestDataGenerator.generateRecordsCount({ author: alice, filter });
      const countReply = await dwn.processMessage(alice.did, recordsCount.message) as RecordsCountReply;
      expect(countReply.status.code).toBe(400);
      expect(countReply.status.detail).toContain(DwnErrorCode.RecordsCountFilterMissingRequiredProperties);
      expect(countReply.count).toBeUndefined();

      const streamedRecordIds: string[] = [];
      const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({ author: alice, filter });
      const subscribeReply = await dwn.processMessage(alice.did, recordsSubscribe.message, {
        subscriptionHandler: (subscriptionMessage): void => {
          if (subscriptionMessage.type === 'event') {
            const { message } = subscriptionMessage.event;
            if ('recordId' in message && typeof message.recordId === 'string') {
              streamedRecordIds.push(message.recordId);
            }
          }
        },
      }) as RecordsSubscribeReply;
      expect(subscribeReply.status.code).toBe(400);
      expect(subscribeReply.status.detail).toContain(DwnErrorCode.RecordsSubscribeFilterMissingRequiredProperties);
      expect(subscribeReply.subscription).toBeUndefined();
      expect(subscribeReply.entries).toBeUndefined();
      expect(streamedRecordIds).toEqual([]);
    });

    it('should allow scoped nested Query, Count, and Subscribe requests for one parent context', async () => {
      const { alice, profile1, profile1Avatar1, profile1Avatar2 } = await seedNestedRecords();
      const filter = {
        protocol     : protocolDefinition.protocol,
        protocolPath : 'profile/avatar',
        contextId    : profile1.message.contextId,
      };

      const firstPageQuery = await TestDataGenerator.generateRecordsQuery({
        author     : alice,
        filter,
        pagination : { limit: 1 },
      });
      const firstPageReply = await dwn.processMessage(alice.did, firstPageQuery.message) as RecordsQueryReply;
      expect(firstPageReply.status.code).toBe(200);
      expect(firstPageReply.entries?.map((entry): string => entry.recordId)).toEqual([profile1Avatar1.message.recordId]);
      expect(firstPageReply.cursor).toBeDefined();

      const secondPageQuery = await TestDataGenerator.generateRecordsQuery({
        author     : alice,
        filter,
        pagination : { cursor: firstPageReply.cursor! },
      });
      const secondPageReply = await dwn.processMessage(alice.did, secondPageQuery.message) as RecordsQueryReply;
      expect(secondPageReply.status.code).toBe(200);
      expect(secondPageReply.entries?.map((entry): string => entry.recordId)).toEqual([profile1Avatar2.message.recordId]);
      expect(secondPageReply.cursor).toBeUndefined();

      const recordsCount = await TestDataGenerator.generateRecordsCount({ author: alice, filter });
      const countReply = await dwn.processMessage(alice.did, recordsCount.message) as RecordsCountReply;
      expect(countReply.status.code).toBe(200);
      expect(countReply.count).toBe(2);

      const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
        author     : alice,
        filter,
        pagination : { limit: 1 },
      });
      const subscribeReply = await dwn.processMessage(alice.did, recordsSubscribe.message, {
        subscriptionHandler: (): void => {},
      }) as RecordsSubscribeReply;
      expect(subscribeReply.status.code).toBe(200);
      expect(subscribeReply.entries?.map((entry): string => entry.recordId)).toEqual([profile1Avatar1.message.recordId]);
      expect(subscribeReply.cursor).toBeDefined();
      await subscribeReply.subscription?.close();
    });

    it('should keep top-level protocol queries unchanged with or without contextId', async () => {
      const { alice, profile1, profile2 } = await seedNestedRecords();
      const rootFilter = {
        protocol     : protocolDefinition.protocol,
        protocolPath : 'profile',
      };

      const recordsQuery = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: rootFilter });
      const queryReply = await dwn.processMessage(alice.did, recordsQuery.message) as RecordsQueryReply;
      expect(queryReply.status.code).toBe(200);
      expect(queryReply.entries?.map((entry): string => entry.recordId)).toEqual([
        profile1.message.recordId,
        profile2.message.recordId,
      ]);

      const scopedRootQuery = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { ...rootFilter, contextId: profile1.message.contextId },
      });
      const scopedRootReply = await dwn.processMessage(alice.did, scopedRootQuery.message) as RecordsQueryReply;
      expect(scopedRootReply.status.code).toBe(200);
      expect(scopedRootReply.entries?.map((entry): string => entry.recordId)).toEqual([profile1.message.recordId]);

      const recordsCount = await TestDataGenerator.generateRecordsCount({ author: alice, filter: rootFilter });
      const countReply = await dwn.processMessage(alice.did, recordsCount.message) as RecordsCountReply;
      expect(countReply.status.code).toBe(200);
      expect(countReply.count).toBe(2);

      const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({ author: alice, filter: rootFilter });
      const subscribeReply = await dwn.processMessage(alice.did, recordsSubscribe.message, {
        subscriptionHandler: (): void => {},
      }) as RecordsSubscribeReply;
      expect(subscribeReply.status.code).toBe(200);
      expect(subscribeReply.entries?.map((entry): string => entry.recordId)).toEqual([
        profile1.message.recordId,
        profile2.message.recordId,
      ]);
      await subscribeReply.subscription?.close();
    });

    it('should read an individual nested record by id without contextId', async () => {
      const { alice, profile1Avatar1 } = await seedNestedRecords();
      const recordsRead = await RecordsRead.create({
        signer : Jws.createSigner(alice),
        filter : { recordId: profile1Avatar1.message.recordId },
      });

      const readReply = await dwn.processMessage(alice.did, recordsRead.message) as RecordsReadReply;
      expect(readReply.status.code).toBe(200);
      expect(readReply.entry?.recordsWrite?.recordId).toBe(profile1Avatar1.message.recordId);
    });
  });
}

testRecordsNestedQueryScope();
