import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type {
  DataStore,
  MessageStore,
  ResumableTaskStore,
  StateIndex,
} from '../../src/index.js';

import messageProtocolDefinition from '../vectors/protocol-definitions/message.json' with { type: 'json' };
import nestedProtocolDefinition from '../vectors/protocol-definitions/nested.json' with { type: 'json' };
import sinon from 'sinon';

import { DwnInterfaceName } from '../../src/enums/dwn-interface-method.js';
import { Message } from '../../src/core/message.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStream, Dwn, DwnConstant, DwnErrorCode, Jws, ProtocolsConfigure, RecordsDelete, RecordsQuery, RecordsWrite, SortDirection, Time } from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';


export function testRecordsPrune(): void {
  describe('records pruning', () => {
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
      sinon.restore(); // wipe all previous stubs/spies/mocks/fakes

      // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
      await messageStore.clear();
      await dataStore.clear();
      await resumableTaskStore.clear();
      await stateIndex.clear();
    });

    afterAll(async () => {
      await dwn.close();
    });

    it('should prune all descendants when given RecordsDelete with `prune` set to `true`', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      // install a protocol with foo <- bar <- baz structure
      const nestedProtocol = nestedProtocolDefinition;
      const protocolsConfig = await ProtocolsConfigure.create({
        definition : nestedProtocol,
        signer     : Jws.createSigner(alice)
      });
      const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
      expect(protocolsConfigureReply.status.code).toBe(202);

      // writes 2 foos, 2 bars under foo1, and 2 bazes under bar1

      // write 2 foos
      const fooData = TestDataGenerator.randomBytes(100);
      const fooOptions = {
        signer       : Jws.createSigner(alice),
        protocol     : nestedProtocol.protocol,
        protocolPath : 'foo',
        schema       : nestedProtocol.types.foo.schema,
        dataFormat   : nestedProtocol.types.foo.dataFormats[0],
        data         : fooData
      };

      const foo1 = await RecordsWrite.create(fooOptions);
      const foo1WriteResponse = await dwn.processMessage(alice.did, foo1.message, { dataStream: DataStream.fromBytes(fooData) });
      expect(foo1WriteResponse.status.code).toBe(202);

      const foo2 = await RecordsWrite.create(fooOptions);
      const foo2WriteResponse = await dwn.processMessage(alice.did, foo2.message, { dataStream: DataStream.fromBytes(fooData) });
      expect(foo2WriteResponse.status.code).toBe(202);

      // write 2 bars under foo1 with data large enough to be required to be stored in the data store so we can test purge in data store
      const barData = TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
      const barOptions = {
        signer          : Jws.createSigner(alice),
        protocol        : nestedProtocol.protocol,
        protocolPath    : 'foo/bar',
        schema          : nestedProtocol.types.bar.schema,
        dataFormat      : nestedProtocol.types.bar.dataFormats[0],
        parentContextId : foo1.message.contextId,
        data            : barData
      };

      const bar1 = await RecordsWrite.create({ ...barOptions });
      const bar1WriteResponse = await dwn.processMessage(alice.did, bar1.message, { dataStream: DataStream.fromBytes(barData) });
      expect(bar1WriteResponse.status.code).toBe(202);

      const bar2 = await RecordsWrite.create({ ...barOptions });
      const bar2WriteResponse = await dwn.processMessage(alice.did, bar2.message, { dataStream: DataStream.fromBytes(barData) });
      expect(bar2WriteResponse.status.code).toBe(202);

      // write 2 bazes under bar1, each has more than 1 message associated with the record so we can test multi-message purge
      const bazData = TestDataGenerator.randomBytes(100);
      const bazOptions = {
        signer          : Jws.createSigner(alice),
        protocol        : nestedProtocol.protocol,
        protocolPath    : 'foo/bar/baz',
        schema          : nestedProtocol.types.baz.schema,
        dataFormat      : nestedProtocol.types.baz.dataFormats[0],
        parentContextId : bar1.message.contextId,
        data            : bazData
      };

      const baz1 = await RecordsWrite.create({ ...bazOptions });
      const baz1WriteResponse = await dwn.processMessage(alice.did, baz1.message, { dataStream: DataStream.fromBytes(bazData) });
      expect(baz1WriteResponse.status.code).toBe(202);

      const baz2 = await RecordsWrite.create({ ...bazOptions });
      const baz2WriteResponse = await dwn.processMessage(alice.did, baz2.message, { dataStream: DataStream.fromBytes(bazData) });
      expect(baz2WriteResponse.status.code).toBe(202);

      // make latest state of baz1 a `RecordsWrite`
      const newBaz1Data = TestDataGenerator.randomBytes(100);
      const baz1Update = await RecordsWrite.createFrom({
        signer              : Jws.createSigner(alice),
        recordsWriteMessage : baz1.message,
        data                : newBaz1Data
      });
      const baz1UpdateResponse = await dwn.processMessage(alice.did, baz1Update.message, { dataStream: DataStream.fromBytes(newBaz1Data) });
      expect(baz1UpdateResponse.status.code).toBe(202);

      // make latest state of baz2 a `RecordsDelete`
      const baz2Delete = await RecordsDelete.create({
        signer   : Jws.createSigner(alice),
        recordId : baz2.message.recordId
      });
      const baz2DeleteResponse = await dwn.processMessage(alice.did, baz2Delete.message);
      expect(baz2DeleteResponse.status.code).toBe(202);

      // sanity test messages are inserted in message store
      const queryFilter = [{
        interface : DwnInterfaceName.Records,
        protocol  : nestedProtocol.protocol
      }];
      const queryResult = await messageStore.query(alice.did, queryFilter);
      expect(queryResult.messages.length).toBe(8); // 2 foos, 2 bars, 2 bazes x 2 messages each

      // sanity test events are inserted in state index
      // NOTE: getLeaves returns ALL messageCids (including ProtocolsConfigure), so count is 9 not 8
      const events = await stateIndex.getLeaves(alice.did, []);
      expect(events.length).toBe(9);

      // sanity test data is inserted in data store
      const bar1DataGetResult = await dataStore.get(alice.did, bar1.message.recordId, bar1.message.descriptor.dataCid);
      const bar2DataGetResult = await dataStore.get(alice.did, bar2.message.recordId, bar2.message.descriptor.dataCid);
      expect(bar1DataGetResult).toBeDefined();
      expect(bar2DataGetResult).toBeDefined();

      // Delete foo1 with prune enabled
      const foo1Delete = await RecordsDelete.create({
        recordId : foo1.message.recordId,
        prune    : true,
        signer   : Jws.createSigner(alice)
      });

      const deleteReply = await dwn.processMessage(alice.did, foo1Delete.message);
      expect(deleteReply.status.code).toBe(202);

      // verify all bar and baz message are permanently deleted
      const queryResult2 = await messageStore.query(alice.did, queryFilter, { messageTimestamp: SortDirection.Ascending });
      expect(queryResult2.messages.length).toBe(3); // foo2 RecordsWrite, foo1 RecordsWrite and RecordsDelete
      expect(queryResult2.messages[0]).toEqual(expect.objectContaining(foo1.message));
      expect(queryResult2.messages[1]).toEqual(expect.objectContaining(foo2.message));
      expect(queryResult2.messages[2]).toEqual(expect.objectContaining(foo1Delete.message));

      // verify all bar and baz events are permanently deleted
      // NOTE: getLeaves returns ALL messageCids (including ProtocolsConfigure), so count is 4 not 3
      const events2 = await stateIndex.getLeaves(alice.did, []);
      expect(events2.length).toBe(4);
      const foo1RecordsWriteCid = await Message.getCid(foo1.message);
      const foo2RecordsWriteCid = await Message.getCid(foo2.message);
      const foo2RecordsDeleteCid = await Message.getCid(foo1Delete.message);
      expect(events2).toEqual(expect.arrayContaining([foo1RecordsWriteCid, foo2RecordsWriteCid, foo2RecordsDeleteCid]));

      // verify all bar data are permanently deleted
      const bar1DataGetResult2 = await dataStore.get(alice.did, bar1.message.recordId, bar1.message.descriptor.dataCid);
      const bar2DataGetResult2 = await dataStore.get(alice.did, bar2.message.recordId, bar2.message.descriptor.dataCid);
      expect(bar1DataGetResult2).toBeUndefined();
      expect(bar2DataGetResult2).toBeUndefined();

      // sanity test an external query will no longer return the deleted records
      const queryData = await RecordsQuery.create({
        signer : Jws.createSigner(alice),
        filter : { protocol: nestedProtocol.protocol }
      });
      const reply2 = await dwn.processMessage(alice.did, queryData.message);
      expect(reply2.status.code).toBe(200);
      expect(reply2.entries?.length).toBe(1); // only foo2 is left
      expect(reply2.entries![0]).toEqual(expect.objectContaining(foo2.message));
    });

    it('should allow pruning against a deleted record that is not already pruned', async () => {
      // Scenario:
      // 1. Alice has a record `foo` with a descendent chain
      // 2. Alice deletes the record `foo` WITHOUT prune, leaving the descendants intact
      // 3. Verify that Alice is able to perform a prune on `foo` to delete all its descendants

      const alice = await TestDataGenerator.generateDidKeyPersona();

      // install a protocol with foo <- bar <- baz structure
      const nestedProtocol = nestedProtocolDefinition;
      const protocolsConfig = await ProtocolsConfigure.create({
        definition : nestedProtocol,
        signer     : Jws.createSigner(alice)
      });
      const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
      expect(protocolsConfigureReply.status.code).toBe(202);

      // 1. Alice has a record `foo` with a descendent chain
      // write foo <- bar <- baz records

      const fooData = TestDataGenerator.randomBytes(100);
      const fooOptions = {
        signer       : Jws.createSigner(alice),
        protocol     : nestedProtocol.protocol,
        protocolPath : 'foo',
        schema       : nestedProtocol.types.foo.schema,
        dataFormat   : nestedProtocol.types.foo.dataFormats[0],
        data         : fooData
      };
      const foo = await RecordsWrite.create(fooOptions);
      const fooWriteResponse = await dwn.processMessage(alice.did, foo.message, { dataStream: DataStream.fromBytes(fooData) });
      expect(fooWriteResponse.status.code).toBe(202);

      const barData = TestDataGenerator.randomBytes(100);
      const barOptions = {
        signer          : Jws.createSigner(alice),
        protocol        : nestedProtocol.protocol,
        protocolPath    : 'foo/bar',
        schema          : nestedProtocol.types.bar.schema,
        dataFormat      : nestedProtocol.types.bar.dataFormats[0],
        parentContextId : foo.message.contextId,
        data            : barData
      };
      const bar = await RecordsWrite.create({ ...barOptions });
      const barWriteResponse = await dwn.processMessage(alice.did, bar.message, { dataStream: DataStream.fromBytes(barData) });
      expect(barWriteResponse.status.code).toBe(202);

      const bazData = TestDataGenerator.randomBytes(100);
      const bazOptions = {
        signer          : Jws.createSigner(alice),
        protocol        : nestedProtocol.protocol,
        protocolPath    : 'foo/bar/baz',
        schema          : nestedProtocol.types.baz.schema,
        dataFormat      : nestedProtocol.types.baz.dataFormats[0],
        parentContextId : bar.message.contextId,
        data            : bazData
      };

      const baz = await RecordsWrite.create({ ...bazOptions });
      const bazWriteResponse = await dwn.processMessage(alice.did, baz.message, { dataStream: DataStream.fromBytes(bazData) });
      expect(bazWriteResponse.status.code).toBe(202);

      // sanity records are inserted in message store
      const queryFilter = [{
        interface : DwnInterfaceName.Records,
        protocol  : nestedProtocol.protocol
      }];
      const messagesBeforeDelete = await messageStore.query(alice.did, queryFilter);
      expect(messagesBeforeDelete.messages.length).toBe(3);

      // sanity verify RecordsQuery returns no records
      const recordsQuery = await RecordsQuery.create({
        signer : Jws.createSigner(alice),
        filter : { protocol: nestedProtocol.protocol }
      });
      const recordsQueryBeforeDeleteReply = await dwn.processMessage(alice.did, recordsQuery.message);
      expect(recordsQueryBeforeDeleteReply.status.code).toBe(200);
      expect(recordsQueryBeforeDeleteReply.entries?.length).toBe(3);


      // 2. Alice deletes the record `foo` WITHOUT prune, leaving the descendants intact
      const fooDelete = await RecordsDelete.create({
        recordId : foo.message.recordId,
        // prune    : true, // intentionally showing that this is a RecordsDelete WITHOUT pruning
        signer   : Jws.createSigner(alice)
      });

      const deleteReply = await dwn.processMessage(alice.did, fooDelete.message);
      expect(deleteReply.status.code).toBe(202);

      // verify bar and baz messages still exists
      const messagesAfterDelete = await messageStore.query(alice.did, queryFilter, { messageTimestamp: SortDirection.Ascending });
      expect(messagesAfterDelete.messages.length).toBe(4); // RecordsWrite for foo, bar, baz, and RecordsDelete for foo

      // sanity verify RecordsQuery returns the descendants
      const recordsQueryAfterDeleteReply = await dwn.processMessage(alice.did, recordsQuery.message);
      expect(recordsQueryAfterDeleteReply.status.code).toBe(200);
      expect(recordsQueryAfterDeleteReply.entries?.length).toBe(2);

      // 3. Verify that Alice is able to perform a prune on `foo` to delete all its descendants
      const fooPrune = await RecordsDelete.create({
        recordId : foo.message.recordId,
        prune    : true,
        signer   : Jws.createSigner(alice)
      });

      const pruneReply = await dwn.processMessage(alice.did, fooPrune.message);
      expect(pruneReply.status.code).toBe(202);

      // verify bar and baz messages are permanently deleted
      const messagesAfterPrune = await messageStore.query(alice.did, queryFilter, { messageTimestamp: SortDirection.Ascending });
      expect(messagesAfterPrune.messages.length).toBe(2); // just RecordsWrite and RecordsDelete for foo
      expect(messagesAfterPrune.messages[0]).toEqual(expect.objectContaining(foo.message));
      expect(messagesAfterPrune.messages[1]).toEqual(expect.objectContaining(fooPrune.message));

      // sanity verify RecordsQuery returns no records
      const recordsQueryAfterPruneReply = await dwn.processMessage(alice.did, recordsQuery.message);
      expect(recordsQueryAfterPruneReply.status.code).toBe(200);
      expect(recordsQueryAfterPruneReply.entries?.length).toBe(0);
    });

    it('should resolve competing prunes to the newest as the canonical winner', async () => {
      // Scenario:
      // 1. Alice has a record `foo` with a descendent chain
      // 2. Alice prunes the record `foo`
      // 3. Verify that a newer prune displaces the existing one (same class: newest wins),
      //    while an older prune is a Conflict no-op

      const alice = await TestDataGenerator.generateDidKeyPersona();

      // install a protocol with foo <- bar <- baz structure
      const nestedProtocol = nestedProtocolDefinition;
      const protocolsConfig = await ProtocolsConfigure.create({
        definition : nestedProtocol,
        signer     : Jws.createSigner(alice)
      });
      const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
      expect(protocolsConfigureReply.status.code).toBe(202);

      // 1. Alice has a record `foo` with a descendent chain
      // write foo <- bar <- baz records

      const fooData = TestDataGenerator.randomBytes(100);
      const fooOptions = {
        signer       : Jws.createSigner(alice),
        protocol     : nestedProtocol.protocol,
        protocolPath : 'foo',
        schema       : nestedProtocol.types.foo.schema,
        dataFormat   : nestedProtocol.types.foo.dataFormats[0],
        data         : fooData
      };
      const foo = await RecordsWrite.create(fooOptions);
      const fooWriteResponse = await dwn.processMessage(alice.did, foo.message, { dataStream: DataStream.fromBytes(fooData) });
      expect(fooWriteResponse.status.code).toBe(202);

      const barData = TestDataGenerator.randomBytes(100);
      const barOptions = {
        signer          : Jws.createSigner(alice),
        protocol        : nestedProtocol.protocol,
        protocolPath    : 'foo/bar',
        schema          : nestedProtocol.types.bar.schema,
        dataFormat      : nestedProtocol.types.bar.dataFormats[0],
        parentContextId : foo.message.contextId,
        data            : barData
      };
      const bar = await RecordsWrite.create({ ...barOptions });
      const barWriteResponse = await dwn.processMessage(alice.did, bar.message, { dataStream: DataStream.fromBytes(barData) });
      expect(barWriteResponse.status.code).toBe(202);

      const bazData = TestDataGenerator.randomBytes(100);
      const bazOptions = {
        signer          : Jws.createSigner(alice),
        protocol        : nestedProtocol.protocol,
        protocolPath    : 'foo/bar/baz',
        schema          : nestedProtocol.types.baz.schema,
        dataFormat      : nestedProtocol.types.baz.dataFormats[0],
        parentContextId : bar.message.contextId,
        data            : bazData
      };

      const baz = await RecordsWrite.create({ ...bazOptions });
      const bazWriteResponse = await dwn.processMessage(alice.did, baz.message, { dataStream: DataStream.fromBytes(bazData) });
      expect(bazWriteResponse.status.code).toBe(202);

      // sanity records are inserted in message store
      const queryFilter = [{
        interface : DwnInterfaceName.Records,
        protocol  : nestedProtocol.protocol
      }];
      const queryResult = await messageStore.query(alice.did, queryFilter);
      expect(queryResult.messages.length).toBe(3);

      // sanity verify RecordsQuery returns no records
      const recordsQuery = await RecordsQuery.create({
        signer : Jws.createSigner(alice),
        filter : { protocol: nestedProtocol.protocol }
      });
      const recordsQueryBeforeDeleteReply = await dwn.processMessage(alice.did, recordsQuery.message);
      expect(recordsQueryBeforeDeleteReply.status.code).toBe(200);
      expect(recordsQueryBeforeDeleteReply.entries?.length).toBe(3);


      // 2. Alice prunes the record `foo`
      const fooPrune1 = await RecordsDelete.create({
        recordId : foo.message.recordId,
        prune    : true,
        signer   : Jws.createSigner(alice)
      });

      const prune1Reply = await dwn.processMessage(alice.did, fooPrune1.message);
      expect(prune1Reply.status.code).toBe(202);

      // 3a. a newer prune displaces the existing tombstone (idempotent cascade)
      await Time.minimalSleep();
      const fooPrune2 = await RecordsDelete.create({
        recordId : foo.message.recordId,
        prune    : true,
        signer   : Jws.createSigner(alice)
      });

      const prune2Reply = await dwn.processMessage(alice.did, fooPrune2.message);
      expect(prune2Reply.status.code).toBe(202);

      // 3b. the displaced (older) prune is now a Conflict no-op
      const prune1RetryReply = await dwn.processMessage(alice.did, fooPrune1.message);
      expect(prune1RetryReply.status.code).toBe(409);
    });

    describe('prune and co-prune protocol action', () => {
      it('should only allow a non-owner author to prune if `prune` is allowed and set to `true` in RecordsDelete', async () => {
        // Scenario:
        // 1. Alice installs a protocol allowing others to add and prune records.
        // 2. Bob writes a record + a descendant in Alice's DWN.
        // 3. Verify Bob cannot prune the records if `prune` is not set to `true` in RecordsDelete.
        // 4. Verify Bob can prune the records by setting `prune` to `true` in RecordsDelete.

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // 1. Alice installs a protocol allowing others to add and prune records.
        const protocolDefinition = {
          protocol  : 'http://post-protocol.xyz',
          published : true,
          types     : {
            post       : { },
            attachment : { }
          },
          structure: {
            post: {
              $actions: [
                {
                  who : 'anyone',
                  can : [
                    'create',
                    'prune', // allowing author to prune, but not delete
                    'read'
                  ]
                }
              ],
              attachment: {
                $actions: [
                  {
                    who : 'anyone',
                    can : ['read']
                  },
                  {
                    who : 'author',
                    of  : 'post',
                    can : ['create']
                  }
                ]
              }
            }
          }
        };
        const protocolsConfig = await ProtocolsConfigure.create({
          definition : protocolDefinition,
          signer     : Jws.createSigner(alice)
        });
        const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
        expect(protocolsConfigureReply.status.code).toBe(202);

        // 2. Bob writes a record + a descendant in Alice's DWN.
        const postData = TestDataGenerator.randomBytes(100);
        const postOptions = {
          signer       : Jws.createSigner(bob),
          protocol     : protocolDefinition.protocol,
          protocolPath : 'post',
          dataFormat   : 'application/json',
          data         : postData
        };

        const post = await RecordsWrite.create(postOptions);
        const postWriteResponse = await dwn.processMessage(alice.did, post.message, { dataStream: DataStream.fromBytes(postData) });
        expect(postWriteResponse.status.code).toBe(202);

        const attachmentData = TestDataGenerator.randomBytes(100);
        const attachmentOptions = {
          signer          : Jws.createSigner(bob),
          protocol        : protocolDefinition.protocol,
          protocolPath    : 'post/attachment',
          parentContextId : post.message.contextId,
          dataFormat      : 'application/octet-stream',
          data            : attachmentData
        };

        const attachment = await RecordsWrite.create(attachmentOptions);
        const attachmentWriteResponse = await dwn.processMessage(alice.did, attachment.message, { dataStream: DataStream.fromBytes(attachmentData) });
        expect(attachmentWriteResponse.status.code).toBe(202);

        // 3. Verify Bob cannot prune the records if `prune` is not set to `true` in RecordsDelete.
        const unauthorizedPostPrune = await RecordsDelete.create({
          recordId : post.message.recordId,
          // prune    : true, // intentionally not setting `prune` to true
          signer   : Jws.createSigner(bob)
        });

        const unauthorizedPostPruneReply = await dwn.processMessage(alice.did, unauthorizedPostPrune.message);
        expect(unauthorizedPostPruneReply.status.code).toBe(401);
        expect(unauthorizedPostPruneReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);

        // 4. Verify Bob can prune the records by setting `prune` to `true` in RecordsDelete.
        const postPrune = await RecordsDelete.create({
          recordId : post.message.recordId,
          prune    : true,
          signer   : Jws.createSigner(bob)
        });

        const pruneReply = await dwn.processMessage(alice.did, postPrune.message);
        expect(pruneReply.status.code).toBe(202);

        // sanity test `RecordsQuery` no longer returns the deleted record
        const recordsQuery = await RecordsQuery.create({
          signer : Jws.createSigner(bob),
          filter : { protocol: protocolDefinition.protocol }
        });
        const recordsQueryReply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(recordsQueryReply.status.code).toBe(200);
        expect(recordsQueryReply.entries?.length).toBe(0);
      });

      it('should not allow a non-owner author to prune if `prune` is not an authorized action', async () => {
        // Scenario:
        // 1. Alice installs a protocol allowing others to add records but not prune.
        // 2. Bob writes a record + a descendant in Alice's DWN.
        // 3. Verify Bob cannot prune the records.

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // 1. Alice installs a protocol allowing others to add records but not prune.
        const protocolDefinition = messageProtocolDefinition;
        const protocolsConfig = await ProtocolsConfigure.create({
          definition : protocolDefinition,
          signer     : Jws.createSigner(alice)
        });
        const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
        expect(protocolsConfigureReply.status.code).toBe(202);

        // 2. Bob writes a record + a descendant in Alice's DWN.
        const messageData = TestDataGenerator.randomBytes(100);
        const messageOptions = {
          signer       : Jws.createSigner(bob),
          protocol     : protocolDefinition.protocol,
          protocolPath : 'message',
          schema       : protocolDefinition.types.message.schema,
          dataFormat   : protocolDefinition.types.message.dataFormats[0],
          data         : messageData
        };

        const message = await RecordsWrite.create(messageOptions);
        const messageWriteResponse = await dwn.processMessage(alice.did, message.message, { dataStream: DataStream.fromBytes(messageData) });
        expect(messageWriteResponse.status.code).toBe(202);

        const attachmentData = TestDataGenerator.randomBytes(100);
        const attachmentOptions = {
          signer          : Jws.createSigner(bob),
          protocol        : protocolDefinition.protocol,
          protocolPath    : 'message/attachment',
          parentContextId : message.message.contextId,
          dataFormat      : 'application/octet-stream',
          data            : attachmentData
        };

        const attachment = await RecordsWrite.create(attachmentOptions);
        const attachmentWriteResponse = await dwn.processMessage(alice.did, attachment.message, { dataStream: DataStream.fromBytes(attachmentData) });
        expect(attachmentWriteResponse.status.code).toBe(202);

        // 3. Verify Bob cannot prune the records.
        const messagePrune = await RecordsDelete.create({
          recordId : message.message.recordId,
          prune    : true,
          signer   : Jws.createSigner(bob)
        });

        const deleteReply = await dwn.processMessage(alice.did, messagePrune.message);
        expect(deleteReply.status.code).toBe(401);
        expect(deleteReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);

        // sanity test `RecordsQuery` still returns the records
        const recordsQuery = await RecordsQuery.create({
          signer : Jws.createSigner(alice),
          filter : { protocol: protocolDefinition.protocol }
        });
        const recordsQueryReply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(recordsQueryReply.status.code).toBe(200);
        expect(recordsQueryReply.entries?.length).toBe(2);
      });

      it('should allow a non-author to prune if `co-prune` is allowed and `prune` is set to `true` in RecordsDelete', async () => {
        // Scenario:
        // 1. Alice installs a protocol allowing others to add and prune records.
        // 2. Bob writes a record + a descendant in Alice's DWN.
        // 3. Verify Carol cannot prune the records if `prune` is not set to `true` in RecordsDelete.
        // 4. Verify Carol can prune the records by setting `prune` to `true` in RecordsDelete.

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        // 1. Alice installs a protocol allowing others to add and prune records.
        const protocolDefinition = {
          protocol  : 'http://post-protocol.xyz',
          published : true,
          types     : {
            post       : { },
            attachment : { }
          },
          structure: {
            post: {
              $actions: [
                {
                  who : 'anyone',
                  can : [
                    'create',
                    'co-prune', // allowing anyone to prune
                    'read'
                  ]
                }
              ],
              attachment: {
                $actions: [
                  {
                    who : 'anyone',
                    can : [
                      'create',
                      'read'
                    ]
                  }
                ]
              }
            }
          }
        };
        const protocolsConfig = await ProtocolsConfigure.create({
          definition : protocolDefinition,
          signer     : Jws.createSigner(alice)
        });
        const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
        expect(protocolsConfigureReply.status.code).toBe(202);

        // 2. Bob writes a record + a descendant in Alice's DWN.
        const postData = TestDataGenerator.randomBytes(100);
        const postOptions = {
          signer       : Jws.createSigner(bob),
          protocol     : protocolDefinition.protocol,
          protocolPath : 'post',
          dataFormat   : 'application/json',
          data         : postData
        };

        const post = await RecordsWrite.create(postOptions);
        const postWriteResponse = await dwn.processMessage(alice.did, post.message, { dataStream: DataStream.fromBytes(postData) });
        expect(postWriteResponse.status.code).toBe(202);

        const attachmentData = TestDataGenerator.randomBytes(100);
        const attachmentOptions = {
          signer          : Jws.createSigner(bob),
          protocol        : protocolDefinition.protocol,
          protocolPath    : 'post/attachment',
          parentContextId : post.message.contextId,
          dataFormat      : 'application/octet-stream',
          data            : attachmentData
        };

        const attachment = await RecordsWrite.create(attachmentOptions);
        const attachmentWriteResponse = await dwn.processMessage(alice.did, attachment.message, { dataStream: DataStream.fromBytes(attachmentData) });
        expect(attachmentWriteResponse.status.code).toBe(202);

        // 3. Verify Carol cannot prune the records if `prune` is not set to `true` in RecordsDelete.
        const unauthorizedPostPrune = await RecordsDelete.create({
          recordId : post.message.recordId,
          // prune    : true, // intentionally not setting `prune` to true
          signer   : Jws.createSigner(carol)
        });

        const unauthorizedPostPruneReply = await dwn.processMessage(alice.did, unauthorizedPostPrune.message);
        expect(unauthorizedPostPruneReply.status.code).toBe(401);
        expect(unauthorizedPostPruneReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);

        // 4. Verify Carol can prune the records by setting `prune` to `true` in RecordsDelete.
        const postPrune = await RecordsDelete.create({
          recordId : post.message.recordId,
          prune    : true,
          signer   : Jws.createSigner(carol)
        });

        const deleteReply = await dwn.processMessage(alice.did, postPrune.message);
        expect(deleteReply.status.code).toBe(202);

        // sanity test `RecordsQuery` no longer returns the deleted record
        const recordsQuery = await RecordsQuery.create({
          signer : Jws.createSigner(bob),
          filter : { protocol: protocolDefinition.protocol }
        });
        const recordsQueryReply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(recordsQueryReply.status.code).toBe(200);
        expect(recordsQueryReply.entries?.length).toBe(0);
      });

      it('should not allow a non-author to prune if `prune` is allowed but `co-prune` is not allowed', async () => {
        // Scenario:
        // 1. Alice installs a protocol allowing others to add records AND only author to prune.
        // 2. Bob writes a record + a descendant in Alice's DWN.
        // 3. Verify Carol cannot prune the records.

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        // 1. Alice installs a protocol allowing others to add records AND only author to prune.
        const protocolDefinition = {
          protocol  : 'http://post-protocol.xyz',
          published : true,
          types     : {
            post       : { },
            attachment : { }
          },
          structure: {
            post: {
              $actions: [
                {
                  who : 'anyone',
                  can : [
                    'create',
                    'prune', // allowing author to prune, but not delete
                    'read'
                  ]
                }
              ],
              attachment: {
                $actions: [
                  {
                    who : 'anyone',
                    can : ['read']
                  },
                  {
                    who : 'author',
                    of  : 'post',
                    can : ['create']
                  }
                ]
              }
            }
          }
        };
        const protocolsConfig = await ProtocolsConfigure.create({
          definition : protocolDefinition,
          signer     : Jws.createSigner(alice)
        });
        const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
        expect(protocolsConfigureReply.status.code).toBe(202);

        // 2. Bob writes a record + a descendant in Alice's DWN.
        const postData = TestDataGenerator.randomBytes(100);
        const postOptions = {
          signer       : Jws.createSigner(bob),
          protocol     : protocolDefinition.protocol,
          protocolPath : 'post',
          dataFormat   : 'application/json',
          data         : postData
        };

        const post = await RecordsWrite.create(postOptions);
        const postWriteResponse = await dwn.processMessage(alice.did, post.message, { dataStream: DataStream.fromBytes(postData) });
        expect(postWriteResponse.status.code).toBe(202);

        const attachmentData = TestDataGenerator.randomBytes(100);
        const attachmentOptions = {
          signer          : Jws.createSigner(bob),
          protocol        : protocolDefinition.protocol,
          protocolPath    : 'post/attachment',
          parentContextId : post.message.contextId,
          dataFormat      : 'application/octet-stream',
          data            : attachmentData
        };

        const attachment = await RecordsWrite.create(attachmentOptions);
        const attachmentWriteResponse = await dwn.processMessage(alice.did, attachment.message, { dataStream: DataStream.fromBytes(attachmentData) });
        expect(attachmentWriteResponse.status.code).toBe(202);

        // 3. Verify Carol cannot prune the records.
        const postPrune = await RecordsDelete.create({
          recordId : post.message.recordId,
          prune    : true,
          signer   : Jws.createSigner(carol)
        });

        const deleteReply = await dwn.processMessage(alice.did, postPrune.message);
        expect(deleteReply.status.code).toBe(401);
        expect(deleteReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);

        // sanity test `RecordsQuery` still returns the records
        const recordsQuery = await RecordsQuery.create({
          signer : Jws.createSigner(bob),
          filter : { protocol: protocolDefinition.protocol }
        });
        const recordsQueryReply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(recordsQueryReply.status.code).toBe(200);
        expect(recordsQueryReply.entries?.length).toBe(2);
      });

      it('should throw if only `delete` is allowed but received a RecordsDelete with `prune` set to `true`', async () => {
        // Scenario:
        // 1. Alice installs a protocol allowing others to add and delete (not prune) records.
        // 2. Bob writes a record + a descendant in Alice's DWN.
        // 3. Verify Bob cannot prune the records.

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // 1. Alice installs a protocol allowing others to add and delete (not prune) records.
        const protocolDefinition = {
          protocol  : 'http://post-protocol.xyz',
          published : true,
          types     : {
            post       : { },
            attachment : { }
          },
          structure: {
            post: {
              $actions: [
                {
                  who : 'anyone',
                  can : [
                    'create',
                    'delete', // only allow delete, not prune
                    'read'
                  ]
                }
              ],
              attachment: {
                $actions: [
                  {
                    who : 'anyone',
                    can : [
                      'create',
                      'read'
                    ]
                  }
                ]
              }
            }
          }
        };
        const protocolsConfig = await ProtocolsConfigure.create({
          definition : protocolDefinition,
          signer     : Jws.createSigner(alice)
        });
        const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
        expect(protocolsConfigureReply.status.code).toBe(202);

        // 2. Bob writes a record + a descendant in Alice's DWN.
        const postData = TestDataGenerator.randomBytes(100);
        const postOptions = {
          signer       : Jws.createSigner(bob),
          protocol     : protocolDefinition.protocol,
          protocolPath : 'post',
          dataFormat   : 'application/json',
          data         : postData
        };

        const post = await RecordsWrite.create(postOptions);
        const postWriteResponse = await dwn.processMessage(alice.did, post.message, { dataStream: DataStream.fromBytes(postData) });
        expect(postWriteResponse.status.code).toBe(202);

        const attachmentData = TestDataGenerator.randomBytes(100);
        const attachmentOptions = {
          signer          : Jws.createSigner(bob),
          protocol        : protocolDefinition.protocol,
          protocolPath    : 'post/attachment',
          parentContextId : post.message.contextId,
          dataFormat      : 'application/octet-stream',
          data            : attachmentData
        };

        const attachment = await RecordsWrite.create(attachmentOptions);
        const attachmentWriteResponse = await dwn.processMessage(alice.did, attachment.message, { dataStream: DataStream.fromBytes(attachmentData) });
        expect(attachmentWriteResponse.status.code).toBe(202);

        // 3. Verify Bob cannot prune the records.
        const unauthorizedPostPrune = await RecordsDelete.create({
          recordId : post.message.recordId,
          prune    : true,
          signer   : Jws.createSigner(bob)
        });

        const unauthorizedPostPruneReply = await dwn.processMessage(alice.did, unauthorizedPostPrune.message);
        expect(unauthorizedPostPruneReply.status.code).toBe(401);
        expect(unauthorizedPostPruneReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);
      });

      it('should not allow creation of a protocol definition with action rule containing `prune` without `create`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition = {
          protocol  : 'http://prune-without-create.xyz',
          published : true,
          types     : {
            post: {},
          },
          structure: {
            post: {
              $actions: [
                {
                  who : 'anyone',
                  can : ['prune'] // intentionally missing `create` action
                }
              ]
            }
          }
        };

        const protocolsConfigureCreatePromise = ProtocolsConfigure.create({
          definition : protocolDefinition,
          signer     : Jws.createSigner(alice)
        });

        await expect(protocolsConfigureCreatePromise)
          .rejects.toThrow(DwnErrorCode.ProtocolsConfigureInvalidActionPruneWithoutCreate);
      });
    });
  });
}