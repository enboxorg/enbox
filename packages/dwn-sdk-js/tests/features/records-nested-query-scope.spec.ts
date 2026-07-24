import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { DataStore, MessageStore, ProtocolDefinition, RecordsCountReply, RecordsQueryReply, RecordsReadReply, RecordsSubscribeReply, ResumableTaskStore } from '../../src/index.js';
import type { GenerateRecordsWriteOutput, Persona } from '../utils/test-data-generator.js';

import sinon from 'sinon';

import { DidKey } from '@enbox/dids';
import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/utils/jws.js';
import { Poller } from '../utils/poller.js';
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
        avatar    : {},
        channel   : {},
        community : {},
        message   : {},
        profile   : {},
      },
      structure: {
        community: {
          channel: {
            message: {},
          },
        },
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

    async function seedCommunityRecords(): Promise<{
      alice: Persona;
      community: GenerateRecordsWriteOutput;
      channel1: GenerateRecordsWriteOutput;
      channel2: GenerateRecordsWriteOutput;
      channel1Message1: GenerateRecordsWriteOutput;
      channel1Message2: GenerateRecordsWriteOutput;
      channel2Message: GenerateRecordsWriteOutput;
    }> {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      await installProtocol(alice);

      const community = await writeProtocolRecord({
        author       : alice,
        dateCreated  : '2026-04-01T00:00:00.000000Z',
        protocolPath : 'community',
      });
      const channel1 = await writeProtocolRecord({
        author          : alice,
        dateCreated     : '2026-04-02T00:00:00.000000Z',
        parentContextId : community.message.contextId,
        protocolPath    : 'community/channel',
      });
      const channel2 = await writeProtocolRecord({
        author          : alice,
        dateCreated     : '2026-04-03T00:00:00.000000Z',
        parentContextId : community.message.contextId,
        protocolPath    : 'community/channel',
      });
      const channel1Message1 = await writeProtocolRecord({
        author          : alice,
        dateCreated     : '2026-04-04T00:00:00.000000Z',
        parentContextId : channel1.message.contextId,
        protocolPath    : 'community/channel/message',
      });
      const channel1Message2 = await writeProtocolRecord({
        author          : alice,
        dateCreated     : '2026-04-05T00:00:00.000000Z',
        parentContextId : channel1.message.contextId,
        protocolPath    : 'community/channel/message',
      });
      const channel2Message = await writeProtocolRecord({
        author          : alice,
        dateCreated     : '2026-04-06T00:00:00.000000Z',
        parentContextId : channel2.message.contextId,
        protocolPath    : 'community/channel/message',
      });

      return { alice, community, channel1, channel2, channel1Message1, channel1Message2, channel2Message };
    }

    async function expectScopedSnapshot(input: {
      alice: Persona;
      contextId: string;
      expectedRecordIds: string[];
    }): Promise<void> {
      const filter = {
        contextId    : input.contextId,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'community/channel/message',
      };

      const recordsQuery = await TestDataGenerator.generateRecordsQuery({ author: input.alice, filter });
      const queryReply = await dwn.processMessage(input.alice.did, recordsQuery.message) as RecordsQueryReply;
      expect(queryReply.status.code).toBe(200);
      expect(queryReply.entries?.map((entry): string => entry.recordId)).toEqual(input.expectedRecordIds);

      const recordsCount = await TestDataGenerator.generateRecordsCount({ author: input.alice, filter });
      const countReply = await dwn.processMessage(input.alice.did, recordsCount.message) as RecordsCountReply;
      expect(countReply.status.code).toBe(200);
      expect(countReply.count).toBe(input.expectedRecordIds.length);

      const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({ author: input.alice, filter });
      const subscribeReply = await dwn.processMessage(input.alice.did, recordsSubscribe.message, {
        subscriptionHandler: (): void => {},
      }) as RecordsSubscribeReply;
      expect(subscribeReply.status.code).toBe(200);
      expect(subscribeReply.entries?.map((entry): string => entry.recordId)).toEqual(input.expectedRecordIds);
      await subscribeReply.subscription?.close();
    }

    it('should reject missing, malformed, and too-deep context scopes for nested requests', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      await installProtocol(alice);

      const expectInvalidScope = async (contextId?: string, parentId?: string): Promise<void> => {
        const filter = {
          protocol     : protocolDefinition.protocol,
          protocolPath : 'community/channel/message',
          ...(contextId === undefined ? {} : { contextId }),
          ...(parentId === undefined ? {} : { parentId }),
        };

        const recordsQuery = await TestDataGenerator.generateRecordsQuery({ author: alice, filter });
        const queryReply = await dwn.processMessage(alice.did, recordsQuery.message) as RecordsQueryReply;
        expect(queryReply.status.code).toBe(400);
        expect(queryReply.status.detail).toContain(DwnErrorCode.RecordsQueryNestedProtocolPathContextIdInvalid);
        expect(queryReply.entries).toBeUndefined();

        const recordsCount = await TestDataGenerator.generateRecordsCount({ author: alice, filter });
        const countReply = await dwn.processMessage(alice.did, recordsCount.message) as RecordsCountReply;
        expect(countReply.status.code).toBe(400);
        expect(countReply.status.detail).toContain(DwnErrorCode.RecordsCountNestedProtocolPathContextIdInvalid);
        expect(countReply.count).toBeUndefined();

        const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({ author: alice, filter });
        const subscribeReply = await dwn.processMessage(alice.did, recordsSubscribe.message) as RecordsSubscribeReply;
        expect(subscribeReply.status.code).toBe(400);
        expect(subscribeReply.status.detail).toContain(DwnErrorCode.RecordsSubscribeNestedProtocolPathContextIdInvalid);
        expect(subscribeReply.subscription).toBeUndefined();
        expect(subscribeReply.entries).toBeUndefined();
      };

      await expectInvalidScope();
      await expectInvalidScope('community/channel/message/tooDeep');
      await expectInvalidScope('community/channel/message/tooDeep', 'selected-parent');

      const boundedPathWideSubscribe = await TestDataGenerator.generateRecordsSubscribe({
        author : alice,
        filter : {
          protocol     : protocolDefinition.protocol,
          protocolPath : 'community/channel/message',
        },
        pagination: { limit: 1 },
      });
      const boundedPathWideReply = await dwn.processMessage(
        alice.did,
        boundedPathWideSubscribe.message,
      ) as RecordsSubscribeReply;
      expect(boundedPathWideReply.status.code).toBe(200);
      expect(boundedPathWideReply.entries).toEqual([]);
      await boundedPathWideReply.subscription?.close();

      const malformedFilter = {
        contextId    : 'community//channel',
        protocol     : protocolDefinition.protocol,
        protocolPath : 'community/channel/message',
      };
      await expect(TestDataGenerator.generateRecordsQuery({ author: alice, filter: malformedFilter })).rejects.toThrow('SchemaValidatorFailure');
      await expect(TestDataGenerator.generateRecordsCount({ author: alice, filter: malformedFilter })).rejects.toThrow('SchemaValidatorFailure');
      await expect(TestDataGenerator.generateRecordsSubscribe({ author: alice, filter: malformedFilter })).rejects.toThrow('SchemaValidatorFailure');
    });

    it('should select exact, direct-parent, and ancestor scopes consistently', async () => {
      const { alice, community, channel1, channel1Message1, channel1Message2, channel2Message } = await seedCommunityRecords();

      await expectScopedSnapshot({
        alice,
        contextId         : channel1Message1.message.contextId,
        expectedRecordIds : [channel1Message1.message.recordId],
      });
      await expectScopedSnapshot({
        alice,
        contextId         : channel1.message.contextId,
        expectedRecordIds : [channel1Message1.message.recordId, channel1Message2.message.recordId],
      });
      await expectScopedSnapshot({
        alice,
        contextId         : community.message.contextId,
        expectedRecordIds : [
          channel1Message1.message.recordId,
          channel1Message2.message.recordId,
          channel2Message.message.recordId,
        ],
      });
    });

    it('should paginate an ancestor scope without crossing a context segment boundary', async () => {
      const { alice, community, channel1, channel1Message1, channel1Message2, channel2Message } = await seedCommunityRecords();
      const filter = {
        contextId    : community.message.contextId,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'community/channel/message',
      };

      const firstPageQuery = await TestDataGenerator.generateRecordsQuery({
        author     : alice,
        filter,
        pagination : { limit: 2 },
      });
      const firstPageReply = await dwn.processMessage(alice.did, firstPageQuery.message) as RecordsQueryReply;
      expect(firstPageReply.status.code).toBe(200);
      expect(firstPageReply.entries?.map((entry): string => entry.recordId)).toEqual([
        channel1Message1.message.recordId,
        channel1Message2.message.recordId,
      ]);
      expect(firstPageReply.cursor).toBeDefined();

      const secondPageQuery = await TestDataGenerator.generateRecordsQuery({
        author     : alice,
        filter,
        pagination : { cursor: firstPageReply.cursor! },
      });
      const secondPageReply = await dwn.processMessage(alice.did, secondPageQuery.message) as RecordsQueryReply;
      expect(secondPageReply.status.code).toBe(200);
      expect(secondPageReply.entries?.map((entry): string => entry.recordId)).toEqual([channel2Message.message.recordId]);
      expect(secondPageReply.cursor).toBeUndefined();

      const truncatedContextId = community.message.contextId.slice(0, -1);
      await expectScopedSnapshot({ alice, contextId: truncatedContextId, expectedRecordIds: [] });

      const matchingLiveRecordIds: string[] = [];
      const boundaryLiveRecordIds: string[] = [];
      const matchingSubscribe = await TestDataGenerator.generateRecordsSubscribe({ author: alice, filter });
      const matchingSubscribeReply = await dwn.processMessage(alice.did, matchingSubscribe.message, {
        subscriptionHandler: (subscriptionMessage): void => {
          if (
            subscriptionMessage.type === 'event' &&
            'recordId' in subscriptionMessage.event.message &&
            typeof subscriptionMessage.event.message.recordId === 'string'
          ) {
            matchingLiveRecordIds.push(subscriptionMessage.event.message.recordId);
          }
        },
      }) as RecordsSubscribeReply;
      expect(matchingSubscribeReply.status.code).toBe(200);

      const boundarySubscribe = await TestDataGenerator.generateRecordsSubscribe({
        author : alice,
        filter : { ...filter, contextId: truncatedContextId },
      });
      const boundarySubscribeReply = await dwn.processMessage(alice.did, boundarySubscribe.message, {
        subscriptionHandler: (subscriptionMessage): void => {
          if (
            subscriptionMessage.type === 'event' &&
            'recordId' in subscriptionMessage.event.message &&
            typeof subscriptionMessage.event.message.recordId === 'string'
          ) {
            boundaryLiveRecordIds.push(subscriptionMessage.event.message.recordId);
          }
        },
      }) as RecordsSubscribeReply;
      expect(boundarySubscribeReply.status.code).toBe(200);
      expect(boundarySubscribeReply.entries).toEqual([]);

      const liveMessage = await writeProtocolRecord({
        author          : alice,
        dateCreated     : '2026-04-07T00:00:00.000000Z',
        parentContextId : channel1.message.contextId,
        protocolPath    : 'community/channel/message',
      });
      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(matchingLiveRecordIds).toEqual([liveMessage.message.recordId]);
      });
      expect(boundaryLiveRecordIds).toEqual([]);

      await matchingSubscribeReply.subscription?.close();
      await boundarySubscribeReply.subscription?.close();
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
