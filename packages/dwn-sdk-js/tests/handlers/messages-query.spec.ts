import type { DidResolver } from '@enbox/dids';
import type { DataStore, MessageStore, ProtocolDefinition, ReplicationFeedReader, ResumableTaskStore } from '../../src/index.js';

import freeForAll from '../vectors/protocol-definitions/free-for-all.json' with { type: 'json' };

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DidKey, UniversalResolver } from '@enbox/dids';

import { Message } from '../../src/core/message.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestStores } from '../test-stores.js';
import { Dwn, DwnErrorCode, DwnInterfaceName, DwnMethodName, Encoder, EncryptionProtocol, Replication } from '../../src/index.js';

function getFeedReader(messageStore: MessageStore): ReplicationFeedReader | undefined {
  const candidate = messageStore as Partial<ReplicationFeedReader>;
  if (
    typeof candidate.logRead === 'function' &&
    typeof candidate.logBounds === 'function' &&
    typeof candidate.fingerprint === 'function' &&
    typeof candidate.epoch === 'function'
  ) {
    return candidate as ReplicationFeedReader;
  }
}

export function testMessagesQueryHandler(): void {
  describe('MessagesQueryHandler.handle()', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let dwn: Dwn;

    beforeAll(async () => {
      didResolver = new UniversalResolver({ didResolvers: [DidKey] });

      const stores = TestStores.get();
      messageStore = stores.messageStore;
      dataStore = stores.dataStore;
      resumableTaskStore = stores.resumableTaskStore;

      dwn = await Dwn.create({ didResolver, messageStore, dataStore, resumableTaskStore });
    });

    beforeEach(async () => {
      await messageStore.clear();
      await dataStore.clear();
      await resumableTaskStore.clear();
    });

    afterAll(async () => {
      await dwn.close();
    });

    it('returns 501 when the message store does not provide a replication feed reader', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { message } = await TestDataGenerator.generateMessagesQuery({ author: alice });

      const reply = await dwn.processMessage(alice.did, message);
      if (getFeedReader(messageStore) !== undefined) {
        expect(reply.status.code).toBe(200);
        return;
      }

      expect(reply.status.code).toBe(501);
      expect(reply.status.detail).toContain(DwnErrorCode.MessagesQueryReplicationFeedUnimplemented);
    });

    it('returns full log entries with inline RecordsWrite data detached from the message', async () => {
      if (getFeedReader(messageStore) === undefined) {
        return;
      }

      const alice = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

      const dataBytes = Encoder.stringToBytes('hello query');
      const record = await TestDataGenerator.generateRecordsWrite({
        author : alice,
        data   : dataBytes,
      });
      const writeReply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
      expect(writeReply.status.code).toBe(202);

      const { message: query } = await TestDataGenerator.generateMessagesQuery({
        author  : alice,
        filters : [{ interface: DwnInterfaceName.Records, method: DwnMethodName.Write }],
      });
      const reply = await dwn.processMessage(alice.did, query);

      expect(reply.status.code).toBe(200);
      expect(reply.entries).toHaveLength(1);
      expect(reply.entries![0].messageCid).toBe(await Message.getCid(record.message));
      expect(reply.entries![0].isLatestBaseState).toBe(true);
      expect(reply.entries![0].protocol).toBe(record.message.descriptor.protocol);
      expect(reply.entries![0].encodedData).toBe(Encoder.bytesToBase64Url(dataBytes));
      expect(reply.entries![0].message).toBeDefined();
      expect((reply.entries![0].message as { encodedData?: string }).encodedData).toBeUndefined();
      expect(reply.drained).toBe(true);
      expect(reply.cursor).toBeDefined();
    });

    it('supports cidsOnly pagination with high-water cursors', async () => {
      if (getFeedReader(messageStore) === undefined) {
        return;
      }

      const alice = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

      const expectedCids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const record = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const writeReply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
        expect(writeReply.status.code).toBe(202);
        expectedCids.push(await Message.getCid(record.message));
      }

      const firstQuery = await TestDataGenerator.generateMessagesQuery({
        author   : alice,
        filters  : [{ interface: DwnInterfaceName.Records, method: DwnMethodName.Write }],
        limit    : 2,
        cidsOnly : true,
      });
      const firstReply = await dwn.processMessage(alice.did, firstQuery.message);
      expect(firstReply.status.code).toBe(200);
      expect(firstReply.entries!.map(entry => entry.messageCid)).toEqual(expectedCids.slice(0, 2));
      expect(firstReply.entries!.every(entry => entry.message === undefined && entry.encodedData === undefined)).toBe(true);
      expect(firstReply.drained).toBe(false);
      expect(firstReply.cursor).toBeDefined();

      const secondQuery = await TestDataGenerator.generateMessagesQuery({
        author   : alice,
        filters  : [{ interface: DwnInterfaceName.Records, method: DwnMethodName.Write }],
        cursor   : firstReply.cursor,
        cidsOnly : true,
      });
      const secondReply = await dwn.processMessage(alice.did, secondQuery.message);
      expect(secondReply.status.code).toBe(200);
      expect(secondReply.entries!.map(entry => entry.messageCid)).toEqual(expectedCids.slice(2));
      expect(secondReply.drained).toBe(true);
    });

    it('includes fingerprints only for canonical sync scopes', async () => {
      const feedReader = getFeedReader(messageStore);
      if (feedReader === undefined) {
        return;
      }

      const alice = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

      const record = await TestDataGenerator.generateRecordsWrite({ author: alice });
      const writeReply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
      expect(writeReply.status.code).toBe(202);

      const globalQuery = await TestDataGenerator.generateMessagesQuery({ author: alice });
      const globalReply = await dwn.processMessage(alice.did, globalQuery.message);
      expect(globalReply.status.code).toBe(200);
      expect(globalReply.fingerprint).toBe(await feedReader.fingerprint(alice.did, [Replication.globalDomain]));

      const protocol = record.message.descriptor.protocol;
      const protocolQuery = await TestDataGenerator.generateMessagesQuery({
        author  : alice,
        filters : [{ protocol }],
      });
      const protocolReply = await dwn.processMessage(alice.did, protocolQuery.message);
      expect(protocolReply.status.code).toBe(200);
      expect(protocolReply.fingerprint).toBe(await feedReader.fingerprint(alice.did, [
        Replication.protocolDomain(protocol),
        Replication.permissionDomain(protocol),
        Replication.encryptionDomain(protocol),
      ]));

      const nonCanonicalQuery = await TestDataGenerator.generateMessagesQuery({
        author  : alice,
        filters : [{ protocol, method: DwnMethodName.Write }],
      });
      const nonCanonicalReply = await dwn.processMessage(alice.did, nonCanonicalQuery.message);
      expect(nonCanonicalReply.status.code).toBe(200);
      expect(nonCanonicalReply.fingerprint).toBeUndefined();
    });

    it('maps progress gaps to a 410 response with structured metadata', async () => {
      if (getFeedReader(messageStore) === undefined) {
        return;
      }

      const alice = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

      const { message } = await TestDataGenerator.generateMessagesQuery({
        author : alice,
        cursor : {
          streamId : 'wrong-stream',
          epoch    : 'wrong-epoch',
          position : '0',
        },
      });
      const reply = await dwn.processMessage(alice.did, message);

      expect(reply.status.code).toBe(410);
      expect(reply.error?.code).toBe('ProgressGap');
      expect(reply.error?.reason).toBe('stream_mismatch');
    });

    it('allows delegated protocol-scoped queries and includes tagged core protocol records', async () => {
      if (getFeedReader(messageStore) === undefined) {
        return;
      }

      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const protocolDefinition: ProtocolDefinition = { ...freeForAll, published: false, protocol: 'http://messages-query-delegated' };

      const { message: protocolConfigure } = await TestDataGenerator.generateProtocolsConfigure({
        author: alice,
        protocolDefinition,
      });
      const protocolReply = await dwn.processMessage(alice.did, protocolConfigure);
      expect(protocolReply.status.code).toBe(202);

      const grant = await TestDataGenerator.generateGrantCreate({
        author    : alice,
        grantedTo : bob,
        scope     : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
          protocol  : protocolDefinition.protocol,
        },
      });
      const grantReply = await dwn.processMessage(alice.did, grant.message, { dataStream: grant.dataStream });
      expect(grantReply.status.code).toBe(202);

      const record = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'post',
        schema       : protocolDefinition.types.post.schema,
      });
      const writeReply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
      expect(writeReply.status.code).toBe(202);

      const audienceEpoch = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol     : EncryptionProtocol.uri,
        protocolPath : EncryptionProtocol.audienceEpochPath,
        tags         : {
          contextId : '',
          epoch     : 1,
          keyId     : 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          protocol  : protocolDefinition.protocol,
          role      : 'friend',
        },
      });
      await messageStore.put(alice.did, audienceEpoch.message, await audienceEpoch.recordsWrite.constructIndexes(true));

      const { message: query } = await TestDataGenerator.generateMessagesQuery({
        author             : bob,
        filters            : [{ protocol: protocolDefinition.protocol }],
        permissionGrantIds : [grant.message.recordId],
        cidsOnly           : true,
      });
      const reply = await dwn.processMessage(alice.did, query);

      expect(reply.status.code).toBe(200);
      expect(reply.entries!.map(entry => entry.messageCid).sort()).toEqual([
        await Message.getCid(protocolConfigure),
        await Message.getCid(audienceEpoch.message),
        await Message.getCid(grant.message),
        await Message.getCid(record.message),
      ].sort());
    });

    it('rejects unfiltered delegated queries with a protocol-scoped grant', async () => {
      if (getFeedReader(messageStore) === undefined) {
        return;
      }

      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const protocolDefinition: ProtocolDefinition = { ...freeForAll, published: false, protocol: 'http://messages-query-unfiltered-delegated' };

      const { message: protocolConfigure } = await TestDataGenerator.generateProtocolsConfigure({
        author: alice,
        protocolDefinition,
      });
      expect((await dwn.processMessage(alice.did, protocolConfigure)).status.code).toBe(202);

      const grant = await TestDataGenerator.generateGrantCreate({
        author    : alice,
        grantedTo : bob,
        scope     : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
          protocol  : protocolDefinition.protocol,
        },
      });
      expect((await dwn.processMessage(alice.did, grant.message, { dataStream: grant.dataStream })).status.code).toBe(202);

      const { message: query } = await TestDataGenerator.generateMessagesQuery({
        author             : bob,
        permissionGrantIds : [grant.message.recordId],
      });
      const reply = await dwn.processMessage(alice.did, query);

      expect(reply.status.code).toBe(401);
      expect(reply.status.detail).toContain(DwnErrorCode.MessagesGrantAuthorizationUnfilteredSubscribeProtocolScope);
    });
  });
}
