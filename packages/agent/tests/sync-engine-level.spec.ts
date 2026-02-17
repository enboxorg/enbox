import sinon from 'sinon';

import { AbstractLevel } from 'abstract-level';
import { Convert } from '@enbox/common';
import { CryptoUtils } from '@enbox/crypto';
import { expect } from 'chai';
import type { GenericMessage } from '@enbox/dwn-sdk-js';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { SyncIdentityOptions } from '../src/index.js';
import { DwnConstant, DwnInterfaceName, DwnMethodName, Jws, Message, PermissionsProtocol, Time } from '@enbox/dwn-sdk-js';

import type { BearerIdentity } from '../src/bearer-identity.js';

import { AgentSyncApi } from '../src/sync-api.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

const testDwnUrls: string[] = [testDwnUrl];

describe('SyncEngineLevel', () => {
  let testHarness: PlatformAgentTestHarness;

  before(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn'
    });
  });

  after(async () => {
    sinon.restore();
    await testHarness.closeStorage();
  });

  describe('get agent', () => {
    it(`returns the 'agent' instance property`, () => {
      // we are only mocking
      const mockAgent: any = {
        agentDid: 'did:method:abc123'
      };
      const syncEngine = new SyncEngineLevel({ agent: mockAgent, db: {} as any });
      const agent = syncEngine.agent;
      expect(agent).to.exist;
      expect(agent.agentDid).to.equal('did:method:abc123');
    });

    it(`throws an error if the 'agent' instance property is undefined`, async () => {
      const syncEngine = new SyncEngineLevel({ db: {} as any });
      expect(() =>
        syncEngine.agent
      ).to.throw(Error, 'Unable to determine agent execution context');
    });
  });

  describe('with Web5 Platform Agent', function () {
    this.timeout(30_000);

    let alice: BearerIdentity;
    let randomSchema: string;
    let syncEngine: SyncEngineLevel;

    before(async () => {
      await testHarness.clearStorage();
      await testHarness.createAgentDid();

      const syncStore = testHarness.syncStore;
      syncEngine = new SyncEngineLevel({ db: syncStore, agent: testHarness.agent });
      const syncApi = new AgentSyncApi({ syncEngine, agent: testHarness.agent });
      testHarness.agent.sync = syncApi;

      alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    });

    beforeEach(async () => {
      randomSchema = CryptoUtils.randomUuid();

      sinon.restore();

      // Reset the sync lock in case a previous test timed out while sync was in progress.
      // Without this, all subsequent tests would fail with "Sync operation is already in progress."
      syncEngine['_syncLock'] = false;

      await syncEngine.clear();
      await testHarness.syncStore.clear();
      await testHarness.dwnDataStore.clear();
      await testHarness.dwnStateIndex.clear();
      await testHarness.dwnMessageStore.clear();
      await testHarness.dwnResumableTaskStore.clear();
      await testHarness.agent.permissions.clear();
      testHarness.dwnStores.clear();
    });

    after(async () => {
      sinon.restore();
      await testHarness.clearStorage();
      await testHarness.closeStorage();
    });

    it('syncs multiple messages in both directions', async () => {
      // scenario:  Alice installs a protocol only on her local DWN and writes some messages associated with it
      //            Alice installs a protocol only on her remote DWN and writes some messages associated with it
      //            Alice registers her DID to be synchronized, and kicks off a sync
      //            The sync should complete and the same records should exist on both remote and local DWNs


      // create 1 local protocol configure
      const protocolDefinition1: ProtocolDefinition = {
        published : true,
        protocol  : 'https://protocol.xyz/example/1',
        types     : {
          foo: {
            schema      : 'https://schemas.xyz/foo',
            dataFormats : ['text/plain', 'application/json']
          }
        },
        structure: {
          foo: {}
        }
      };

      const protocolsConfigure1 = await testHarness.agent.processDwnRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: protocolDefinition1
        }
      });

      // create 1 remote protocol configure
      const protocolDefinition2: ProtocolDefinition = {
        published : true,
        protocol  : 'https://protocol.xyz/example/2',
        types     : {
          bar: {
            schema      : 'https://schemas.xyz/bar',
            dataFormats : ['text/plain', 'application/json']
          }
        },
        structure: {
          bar: {}
        }
      };

      const protocolsConfigure2 = await testHarness.agent.sendDwnRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: protocolDefinition2
        }
      });


      // create 3 local records.
      const localRecords: string[] = [];
      for (let i = 0; i < 3; i++) {
        const writeResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat : 'text/plain',
            schema     : randomSchema
          },
          dataStream: new Blob([`Hello, ${i}`])
        });
        expect(writeResponse.reply.status.code).to.equal(202);

        // write an update message for one of the records
        if (i === 0) {
          const updateResponse = await testHarness.agent.dwn.processRequest({
            author        : alice.did.uri,
            target        : alice.did.uri,
            messageType   : DwnInterface.RecordsWrite,
            messageParams : {
              recordId    : writeResponse.message!.recordId,
              dataFormat  : 'text/plain',
              schema      : writeResponse.message!.descriptor.schema,
              dateCreated : writeResponse.message!.descriptor.dateCreated
            },
            dataStream: new Blob([`Hello, ${i} updated!`]),
          });
          expect(updateResponse.reply.status.code).to.equal(202);
        }

        localRecords.push((writeResponse.message!).recordId);
      }

      // create 3 remote records
      const remoteRecords: string[] = [];
      for (let i = 0; i < 3; i++) {
        const writeResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat : 'text/plain',
            schema     : randomSchema
          },
          dataStream: new Blob([`Hello, ${i}`])
        });
        expect(writeResponse.reply.status.code).to.equal(202);

        // write an update message for one of the records
        if (i === 0) {
          const updateResponse = await testHarness.agent.dwn.sendRequest({
            author        : alice.did.uri,
            target        : alice.did.uri,
            messageType   : DwnInterface.RecordsWrite,
            messageParams : {
              recordId    : writeResponse.message!.recordId,
              dataFormat  : 'text/plain',
              schema      : writeResponse.message!.descriptor.schema,
              dateCreated : writeResponse.message!.descriptor.dateCreated
            },
            dataStream: new Blob([`Hello, ${i} updated!`]),
          });
          expect(updateResponse.reply.status.code).to.equal(202);
        }
        remoteRecords.push((writeResponse.message!).recordId);
      }

      // check that protocol1 exists locally
      let localProtocolsQueryResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {}
      });
      let localProtocolsQueryReply = localProtocolsQueryResponse.reply;
      expect(localProtocolsQueryReply.status.code).to.equal(200);
      expect(localProtocolsQueryReply.entries?.length).to.equal(1);
      expect(localProtocolsQueryReply.entries).to.have.deep.equal([ protocolsConfigure1.message ]);

      // query local and check for only local records
      let localRecordsQueryResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            dataFormat : 'text/plain',
            schema     : randomSchema
          }
        }
      });
      let localRecordsQueryReply = localRecordsQueryResponse.reply;
      expect(localRecordsQueryReply.status.code).to.equal(200);
      expect(localRecordsQueryReply.entries).to.have.length(3);
      let localRecordsFromQuery = localRecordsQueryReply.entries?.map(entry => entry.recordId);
      expect(localRecordsFromQuery).to.have.members(localRecords);

      // check that protocol2 exists remotely
      let remoteProtocolsQueryResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {}
      });
      let remoteProtocolsQueryReply = remoteProtocolsQueryResponse.reply;
      expect(remoteProtocolsQueryReply.status.code).to.equal(200);
      expect(remoteProtocolsQueryReply.entries?.length).to.equal(1);
      expect(remoteProtocolsQueryReply.entries).to.have.deep.equal([ protocolsConfigure2.message ]);

      // query remote and check for only remote records
      let remoteRecordsQueryResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            dataFormat : 'text/plain',
            schema     : randomSchema
          }
        }
      });
      let remoteRecordsQueryReply = remoteRecordsQueryResponse.reply;
      expect(remoteRecordsQueryReply.status.code).to.equal(200);
      expect(remoteRecordsQueryReply.entries).to.have.length(3);
      let remoteRecordsFromQuery = remoteRecordsQueryReply.entries?.map(entry => entry.recordId);
      expect(remoteRecordsFromQuery).to.have.members(remoteRecords);

      // Register Alice's DID to be synchronized.
      await testHarness.agent.sync.registerIdentity({
        did: alice.did.uri,
      });

      // Execute Sync to pull all records from Alice's remote DWN to Alice's local DWN.
      await syncEngine.sync();

      // query local to see all protocols
      localProtocolsQueryResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {}
      });
      localProtocolsQueryReply = localProtocolsQueryResponse.reply;
      expect(localProtocolsQueryReply.status.code).to.equal(200);
      expect(localProtocolsQueryReply.entries?.length).to.equal(2);
      expect(localProtocolsQueryReply.entries).to.have.deep.equal([ protocolsConfigure1.message, protocolsConfigure2.message ]);

      // query local node to see all records
      localRecordsQueryResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            dataFormat : 'text/plain',
            schema     : randomSchema
          }
        }
      });
      localRecordsQueryReply = localRecordsQueryResponse.reply;
      expect(localRecordsQueryReply.status.code).to.equal(200);
      expect(localRecordsQueryReply.entries).to.have.length(6, 'local');
      localRecordsFromQuery = localRecordsQueryReply.entries?.map(entry => entry.recordId);
      expect(localRecordsFromQuery).to.have.members([...localRecords, ...remoteRecords]);

      // query remote node to see all protocols
      remoteProtocolsQueryResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {}
      });
      remoteProtocolsQueryReply = remoteProtocolsQueryResponse.reply;
      expect(remoteProtocolsQueryReply.status.code).to.equal(200);
      expect(remoteProtocolsQueryReply.entries?.length).to.equal(2);
      expect(remoteProtocolsQueryReply.entries).to.have.deep.equal([ protocolsConfigure1.message, protocolsConfigure2.message ]);

      // query remote node to see all records
      remoteRecordsQueryResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            dataFormat : 'text/plain',
            schema     : randomSchema
          }
        }
      });
      remoteRecordsQueryReply = remoteRecordsQueryResponse.reply;
      expect(remoteRecordsQueryReply.status.code).to.equal(200);
      expect(remoteRecordsQueryReply.entries).to.have.length(6, 'remote');
      remoteRecordsFromQuery = remoteRecordsQueryReply.entries?.map(entry => entry.recordId);
      expect(remoteRecordsFromQuery).to.have.members([...localRecords, ...remoteRecords]);
    }).slow(1000); // Yellow at 500ms, Red at 1000ms.

    describe('sync()', () => {
      it('throws an error if the sync is currently already running', async () => {
        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        // Stub getSyncTargets to simulate a slow sync
        const getSyncTargetsStub = sinon.stub(syncEngine as any, 'getSyncTargets');
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 90);
        }));

        // do not await
        syncEngine.sync();

        await clock.tickAsync(50);

        // do not block for subsequent syncs
        getSyncTargetsStub.returns(Promise.resolve([]));
        try {
          await syncEngine.sync();
          expect.fail('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).to.equal('SyncEngineLevel: Sync operation is already in progress.');
        }

        await clock.tickAsync(50);

        // no error thrown
        await syncEngine.sync();

        clock.restore();
      });
    });

    describe('pull()', () => {
      it('synchronizes records that have been updated', async () => {
        // Write a test record to Alice's remote DWN.
        const writeResponse1 = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat : 'text/plain',
            schema     : randomSchema
          },
          dataStream: new Blob(['Hello, world!'])
        });

        // Get the record ID of the test record.
        const testRecordId = writeResponse1.message!.recordId;

        // const update the record
        const updateResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            recordId    : testRecordId,
            dataFormat  : 'text/plain',
            schema      : randomSchema,
            dateCreated : writeResponse1.message!.descriptor.dateCreated
          },
          dataStream: new Blob(['Hello, world updated!'])
        });
        expect(updateResponse.reply.status.code).to.equal(202);
        expect(updateResponse.message!.recordId).to.equal(testRecordId);

        const updateMessageCid = updateResponse.messageCid;

        // Confirm the record does NOT exist on Alice's local DWN.
        let queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              dataFormat : 'text/plain',
              schema     : randomSchema
            }
          }
        });
        let localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).to.have.length(0); // Record doesn't exist on local DWN.

        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        // Execute Sync to pull all records from Alice's remote DWN to Alice's local DWN.
        await syncEngine.sync('pull');

        // Confirm the record now DOES exist on Alice's local DWN.
        queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).to.have.length(1); // Record does exist on local DWN.

        // remove `initialWrite` from the response to generate an accurate messageCid
        const { initialWrite, ...rawMessage } = localDwnQueryReply.entries![0];
        const queriedMessageCid = await Message.getCid(rawMessage);
        expect(queriedMessageCid).to.equal(updateMessageCid);
      });

      it('takes no action if no identities are registered', async () => {
        const didResolveSpy = sinon.spy(testHarness.agent.did, 'resolve');
        const sendDwnRequestSpy = sinon.spy(testHarness.agent.rpc, 'sendDwnRequest');

        await syncEngine.sync('pull');

        // Verify DID resolution and DWN requests did not occur.
        expect(didResolveSpy.notCalled).to.be.true;
        expect(sendDwnRequestSpy.notCalled).to.be.true;

        didResolveSpy.restore();
        sendDwnRequestSpy.restore();
      });

      it('logs an error if could not fetch MessagesSync permission needed for a pull sync', async () => {
        // create new identity to not conflict the previous tests's remote records
        const aliceSync = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });

        const delegateDid = await testHarness.agent.identity.create({
          store     : true,
          didMethod : 'jwk',
          metadata  : { name: 'Alice Delegate', connectedDid: aliceSync.did.uri }
        });

        await testHarness.agent.sync.registerIdentity({
          did     : aliceSync.did.uri,
          options : {
            delegateDid : delegateDid.did.uri,
            protocols   : [ 'https://protocol.xyz/foo' ]
          }
        });

        // spy on console.error to check if the error message is logged
        const consoleErrorSpy = sinon.stub(console, 'error').resolves();

        await syncEngine.sync('pull');
        expect(consoleErrorSpy.called).to.be.true;
        expect(consoleErrorSpy.args[0][0]).to.include('SyncEngineLevel: Error fetching MessagesSync permission grant for delegate DID');
      });

      it('logs an error if could not fetch MessagesRead permission needed for a sync', async () => {
        // create new identity to not conflict the previous tests's remote records
        const aliceSync = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });

        // create 3 local protocols
        const protocolFoo: ProtocolDefinition = {
          published : true,
          protocol  : 'https://protocol.xyz/foo',
          types     : {
            foo: {
              schema      : 'https://schemas.xyz/foo',
              dataFormats : ['text/plain', 'application/json']
            }
          },
          structure: {
            foo: {}
          }
        };

        // install a protocol on the remote node for aliceSync
        const protocolsFoo = await testHarness.agent.sendDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : {
            definition: protocolFoo
          }
        });
        expect(protocolsFoo.reply.status.code).to.equal(202);


        // create a record that will be read as a part of sync
        const record1 = await testHarness.agent.sendDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'https://protocol.xyz/foo',
            protocolPath : 'foo',
            schema       : 'https://schemas.xyz/foo',
            dataFormat   : 'text/plain',
          },
          dataStream: new Blob(['Hello, world!'])
        });
        expect(record1.reply.status.code).to.equal(202);


        const delegateDid = await testHarness.agent.identity.create({
          store     : true,
          didMethod : 'jwk',
          metadata  : { name: 'Alice Delegate', connectedDid: aliceSync.did.uri }
        });

        // write a MessagesSync permission grant for the delegate DID
        const messagesSyncGrant = await testHarness.agent.permissions.createGrant({
          store       : true,
          author      : aliceSync.did.uri,
          grantedTo   : delegateDid.did.uri,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
          scope       : {
            interface : DwnInterfaceName.Messages,
            method    : DwnMethodName.Sync,
            protocol  : 'https://protocol.xyz/foo'
          }
        });

        const { encodedData: messagesSyncGrantData, ...messagesSyncGrantMessage } = messagesSyncGrant.message;
        // send to the remote node
        const sendGrant = await testHarness.agent.sendDwnRequest({
          author      : aliceSync.did.uri,
          target      : aliceSync.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesSyncGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(messagesSyncGrantData).toUint8Array() ]),
        });
        expect(sendGrant.reply.status.code).to.equal(202);

        // store it as the delegate DID so that it can be fetched during sync
        const processGrant = await testHarness.agent.processDwnRequest({
          author      : delegateDid.did.uri,
          target      : delegateDid.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesSyncGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(messagesSyncGrantData).toUint8Array() ]),
          signAsOwner : true
        });
        expect(processGrant.reply.status.code).to.equal(202);

        await testHarness.agent.sync.registerIdentity({
          did     : aliceSync.did.uri,
          options : {
            delegateDid : delegateDid.did.uri,
            protocols   : [ 'https://protocol.xyz/foo' ]
          }
        });

        // spy on console.error to check if the error message is logged
        const consoleErrorSpy = sinon.stub(console, 'error').resolves();

        await syncEngine.sync('pull');
        expect(consoleErrorSpy.called).to.be.true;
        expect(consoleErrorSpy.args[0][0]).to.include('SyncEngineLevel: pull - Error fetching MessagesRead permission grant for delegate DID');
      });

      it('synchronizes records for 1 identity from remote DWN to local DWN', async () => {
        // Write a test record to Alice's remote DWN.
        const writeResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat : 'text/plain',
            schema     : randomSchema
          },
          dataStream: new Blob(['Hello, world!'])
        });

        // Get the record ID of the test record.
        const testRecordId = writeResponse.message!.recordId;

        // Confirm the record does NOT exist on Alice's local DWN.
        let queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              dataFormat : 'text/plain',
              schema     : randomSchema
            }
          }
        });
        let localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).to.have.length(0); // Record doesn't exist on local DWN.

        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        // Execute Sync to pull all records from Alice's remote DWN to Alice's local DWN.
        await syncEngine.sync('pull');

        // Confirm the record now DOES exist on Alice's local DWN.
        queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).to.have.length(1); // Record does exist on local DWN.


        // Add another record for a subsequent sync.
        const writeResponse2 = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat: 'text/plain'
          },
          dataStream: new Blob(['Hello, world 2!'])
        });
        // Get the record ID of the test record.
        const testRecord2Id = writeResponse2.message!.recordId;

        // Confirm the new record does NOT exist on Alice's local DWN.
        queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecord2Id } } // New RecordId
        });
        localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).to.have.length(0); // New Record doesn't exist on local DWN.

        await syncEngine.sync('pull');

        // Confirm the new record DOES exist on Alice's local DWN.
        queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecord2Id } } // New RecordId
        });
        localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).to.have.length(1); // New Record does exist on local DWN.
      }).slow(300); // Yellow at 150ms, Red at 300ms.

      it('synchronizes records with data larger than the `encodedData` limit within the `RecordsQuery` response', async function () {
        this.timeout(10_000); // large data sync can be slow in CI
        // larger than the size of data returned in a RecordsQuery
        const LARGE_DATA_SIZE = 1_000 + DwnConstant.maxDataSizeAllowedToBeEncoded;

        // register alice
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        // create a remote record
        const writeResponse = await testHarness.agent.dwn.sendRequest({
          store         : false,
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat: 'text/plain'
          },
          dataStream: new Blob(Array(LARGE_DATA_SIZE).fill('a')) //large data
        });

        // check that the record doesn't exist locally
        const { reply: localReply } = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: writeResponse.message!.recordId } }
        });

        expect(localReply.status.code).to.equal(200);
        expect(localReply.entries?.length).to.equal(0);

        // initiate sync
        await syncEngine.sync('pull');

        // query that the local record exists
        const { reply: localReply2 } = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: writeResponse.message!.recordId } }
        });

        expect(localReply2.status.code).to.equal(200);
        expect(localReply2.entries?.length).to.equal(1);
        const [ entry ] = localReply2.entries!;
        expect(entry.encodedData).to.be.undefined; // encodedData is undefined

        // Execute a RecordsRead to verify the data was synced.
        // check for response encodedData if it doesn't exist issue a RecordsRead
        // get individual records without encodedData to check that data exists
        const readResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsRead,
          messageParams : { filter: { recordId: writeResponse.message!.recordId } }
        });
        expect(readResponse.reply.status.code).to.equal(200);
        expect(readResponse.reply.entry).to.exist;
        expect(readResponse.reply.entry!.data).to.exist;
        expect(readResponse.reply.entry!.recordsWrite!.descriptor.dataSize).to.equal(LARGE_DATA_SIZE);
      }).slow(1200); // Yellow at 600ms, Red at 1200ms.

      it('synchronizes records for multiple identities from remote DWN to local DWN', async () => {
        // Create a second Identity to author the DWN messages.
        const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

        // Write a test record to Alice's remote DWN.
        let writeResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat: 'text/plain'
          },
          dataStream: new Blob(['Hello, Bob!'])
        });

        // Get the record ID of Alice's test record.
        const testRecordIdAlice = writeResponse.message!.recordId;

        // Write a test record to Bob's remote DWN.
        writeResponse = await testHarness.agent.dwn.sendRequest({
          author        : bob.did.uri,
          target        : bob.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat: 'text/plain'
          },
          dataStream: new Blob(['Hello, Alice!'])
        });

        // Get the record ID of Bob's test record.
        const testRecordIdBob = writeResponse.message!.recordId;

        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        // Register Bob's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did: bob.did.uri,
        });

        // Execute Sync to pull all records from Alice's and Bob's remove DWNs to their local DWNs.
        await syncEngine.sync('pull');

        // Confirm the Alice test record exist on Alice's local DWN.
        let queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordIdAlice } }
        });
        let localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).to.have.length(1); // Record does exist on local DWN.

        // Confirm the Bob test record exist on Bob's local DWN.
        queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : bob.did.uri,
          target        : bob.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordIdBob } }
        });
        localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).to.have.length(1); // Record does exist on local DWN.
      }).slow(1000); // Yellow at 500ms, Red at 1000ms.
    });

    describe('push()', () => {
      it('synchronizes records that have been updated', async () => {
        // Write a test record to Alice's local DWN.
        const writeResponse1 = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat : 'text/plain',
            schema     : randomSchema
          },
          dataStream: new Blob(['Hello, world!'])
        });

        // Get the record ID of the test record.
        const testRecordId = writeResponse1.message!.recordId;

        // const update the record
        const updateResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            recordId    : testRecordId,
            dataFormat  : 'text/plain',
            schema      : randomSchema,
            dateCreated : writeResponse1.message!.descriptor.dateCreated
          },
          dataStream: new Blob(['Hello, world updated!'])
        });
        expect(updateResponse.reply.status.code).to.equal(202);
        expect(updateResponse.message!.recordId).to.equal(testRecordId);

        const updateMessageCid = updateResponse.messageCid;

        // Confirm the record does NOT exist on Alice's remote DWN.
        let queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              dataFormat : 'text/plain',
              schema     : randomSchema
            }
          }
        });
        let remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).to.have.length(0); // Record doesn't exist on local DWN.

        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        // Execute Sync to pull all records from Alice's remote DWN to Alice's local DWN.
        await syncEngine.sync('push');

        // Confirm the record now DOES exist on Alice's local DWN.
        queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).to.have.length(1); // Record does exist on local DWN.

        // remove `initialWrite` from the response to generate an accurate messageCid
        const { initialWrite, ...rawMessage } = remoteDwnQueryReply.entries![0];
        const queriedMessageCid = await Message.getCid(rawMessage);
        expect(queriedMessageCid).to.equal(updateMessageCid);
      });

      it('takes no action if no identities are registered', async () => {
        const didResolveSpy = sinon.spy(testHarness.agent.did, 'resolve');
        const processRequestSpy = sinon.spy(testHarness.agent.dwn, 'processRequest');

        await syncEngine.sync('push');

        // Verify DID resolution and DWN requests did not occur.
        expect(didResolveSpy.notCalled).to.be.true;
        expect(processRequestSpy.notCalled).to.be.true;

        didResolveSpy.restore();
        processRequestSpy.restore();
      });

      it('logs an error if could not fetch MessagesSync permission needed for a sync', async () => {
        // create new identity to not conflict the previous tests's remote records
        const aliceSync = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });

        const delegateDid = await testHarness.agent.identity.create({
          store     : true,
          didMethod : 'jwk',
          metadata  : { name: 'Alice Delegate', connectedDid: aliceSync.did.uri }
        });

        await testHarness.agent.sync.registerIdentity({
          did     : aliceSync.did.uri,
          options : {
            delegateDid : delegateDid.did.uri,
            protocols   : [ 'https://protocol.xyz/foo' ]
          }
        });

        // spy on console.error to check if the error message is logged
        const consoleErrorSpy = sinon.stub(console, 'error').resolves();

        await syncEngine.sync('push');
        expect(consoleErrorSpy.called).to.be.true;
        expect(consoleErrorSpy.args[0][0]).to.include('SyncEngineLevel: Error fetching MessagesSync permission grant for delegate DID');
      });

      it('logs an error if could not fetch MessagesRead permission needed for a sync', async () => {
        // create new identity to not conflict the previous tests's remote records
        const aliceSync = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });

        // create 3 local protocols
        const protocolFoo: ProtocolDefinition = {
          published : true,
          protocol  : 'https://protocol.xyz/foo',
          types     : {
            foo: {
              schema      : 'https://schemas.xyz/foo',
              dataFormats : ['text/plain', 'application/json']
            }
          },
          structure: {
            foo: {}
          }
        };

        // install a protocol on the local node for aliceSync
        const protocolsFoo = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : {
            definition: protocolFoo
          }
        });
        expect(protocolsFoo.reply.status.code).to.equal(202);


        // create a record that will be read as a part of sync
        const record1 = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'https://protocol.xyz/foo',
            protocolPath : 'foo',
            schema       : 'https://schemas.xyz/foo',
            dataFormat   : 'text/plain',
          },
          dataStream: new Blob(['Hello, world!'])
        });
        expect(record1.reply.status.code).to.equal(202);


        const delegateDid = await testHarness.agent.identity.create({
          store     : true,
          didMethod : 'jwk',
          metadata  : { name: 'Alice Delegate', connectedDid: aliceSync.did.uri }
        });

        // write a MessagesSync permission grant for the delegate DID
        const messagesSyncGrant = await testHarness.agent.permissions.createGrant({
          store       : true,
          author      : aliceSync.did.uri,
          grantedTo   : delegateDid.did.uri,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
          scope       : {
            interface : DwnInterfaceName.Messages,
            method    : DwnMethodName.Sync,
            protocol  : 'https://protocol.xyz/foo'
          }
        });

        // store it as the delegate DID so that it can be fetched during sync
        const { encodedData: messagesSyncGrantData, ...messagesSyncGrantMessage } = messagesSyncGrant.message;
        const processGrant = await testHarness.agent.processDwnRequest({
          author      : delegateDid.did.uri,
          target      : delegateDid.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesSyncGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(messagesSyncGrantData).toUint8Array() ]),
          signAsOwner : true
        });
        expect(processGrant.reply.status.code).to.equal(202);

        await testHarness.agent.sync.registerIdentity({
          did     : aliceSync.did.uri,
          options : {
            delegateDid : delegateDid.did.uri,
            protocols   : [ 'https://protocol.xyz/foo' ]
          }
        });

        // spy on console.error to check if the error message is logged
        const consoleErrorSpy = sinon.stub(console, 'error').resolves();

        await syncEngine.sync('push');
        expect(consoleErrorSpy.called).to.be.true;
        expect(consoleErrorSpy.args[0][0]).to.include('SyncEngineLevel: push - Error fetching MessagesRead permission grant for delegate DID');
      });

      it('synchronizes records for 1 identity from local DWN to remote DWN', async () => {
        // Write a record that we can use for this test.
        const writeResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat: 'text/plain'
          },
          dataStream: new Blob(['Hello, world!'])
        });

        // Get the record ID of the test record.
        const testRecordId = writeResponse.message!.recordId;

        // Confirm the record does NOT exist on Alice's remote DWN.
        let queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        let remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).to.have.length(0); // Record doesn't exist on remote DWN.

        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        // Execute Sync to push all records from Alice's local DWN to Alice's remote DWN.
        await syncEngine.sync('push');

        // Confirm the record now DOES exist on Alice's remote DWN.
        queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).to.have.length(1); // Record does exist on remote DWN.

        // Add another record for a subsequent sync.
        const writeResponse2 = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat: 'text/plain'
          },
          dataStream: new Blob(['Hello, world 2!'])
        });
        // Get the record ID of the test record.
        const testRecord2Id = writeResponse2.message!.recordId;

        // Confirm the new record does NOT exist on Alice's remote DWN.
        queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecord2Id } } // New RecordId
        });
        remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).to.have.length(0); // New Record doesn't exist on local DWN.

        await syncEngine.sync('push');

        // Confirm the new record DOES exist on Alice's local DWN.
        queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecord2Id } } // New RecordId
        });
        remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).to.have.length(1); // New Record does exist on local DWN.
      }).slow(600); // Yellow at 300ms, Red at 600ms.

      it('synchronizes records with data larger than the `encodedData` limit within the `RecordsQuery` response', async function () {
        this.timeout(10_000); // large data sync can be slow in CI
        // larger than the size of data returned in a RecordsQuery
        const LARGE_DATA_SIZE = DwnConstant.maxDataSizeAllowedToBeEncoded + 1_000;

        //register alice
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        // create a local record
        const record = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat: 'text/plain'
          },
          dataStream: new Blob(Array(LARGE_DATA_SIZE).fill('a')) //large data
        });

        // check that record doesn't exist remotely
        const { reply: remoteReply } = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: record.message!.recordId } }
        });

        expect(remoteReply.status.code).to.equal(200);
        expect(remoteReply.entries?.length).to.equal(0);

        // initiate sync
        await syncEngine.sync('push');

        // query for remote REcords
        const { reply: remoteReply2 } = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: record.message!.recordId } }
        });

        expect(remoteReply2.status.code).to.equal(200);
        expect(remoteReply2.entries?.length).to.equal(1);
        const entry = remoteReply2.entries![0];
        expect(entry.encodedData).to.be.undefined;
        // check for response encodedData if it doesn't exist issue a RecordsRead
        const recordId = entry.recordId;
        // get individual records without encodedData to check that data exists
        const readRecord = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsRead,
          messageParams : { filter: { recordId } }
        });
        const reply = readRecord.reply;
        expect(reply.status.code).to.equal(200);
        expect(reply.entry).to.exist;
        expect(reply.entry!.data).to.exist;
      }).slow(1200); // Yellow at 600ms, Red at 1200ms.

      it('synchronizes records for multiple identities from local DWN to remote DWN', async () => {
        // Create a second Identity to author the DWN messages.
        const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

        // Write a test record to Alice's local DWN.
        let writeResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat: 'text/plain'
          },
          dataStream: new Blob(['Hello, Bob!'])
        });

        // Get the record ID of Alice's test record.
        const testRecordIdAlice = writeResponse.message!.recordId;

        // Write a test record to Bob's local DWN.
        writeResponse = await testHarness.agent.dwn.processRequest({
          author        : bob.did.uri,
          target        : bob.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat: 'text/plain'
          },
          dataStream: new Blob(['Hello, Alice!'])
        });

        // Get the record ID of Bob's test record.
        const testRecordIdBob = writeResponse.message!.recordId;

        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        // Register Bob's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did: bob.did.uri,
        });

        // Execute Sync to push all records from Alice's and Bob's local DWNs to their remote DWNs.
        await syncEngine.sync('push');

        // Confirm the Alice test record exist on Alice's remote DWN.
        let queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordIdAlice } }
        });
        let remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).to.have.length(1); // Record does exist on remote DWN.

        // Confirm the Bob test record exist on Bob's remote DWN.
        queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : bob.did.uri,
          target        : bob.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordIdBob } }
        });
        remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).to.equal(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).to.have.length(1); // Record does exist on remote DWN.
      }).slow(1200); // Yellow at 600ms, Red at 1200ms.
    });

    describe('sync enhancements', () => {
      it('syncs RecordsDelete messages from remote to local', async () => {
        // Scenario: Alice writes a record to her remote DWN, syncs it locally,
        //           then deletes it on the remote, and syncs again.
        //           The delete should propagate to the local DWN.

        // Register Alice's DID for sync.
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        // Write a record to Alice's remote DWN.
        const writeResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat : 'text/plain',
            schema     : randomSchema
          },
          dataStream: new Blob(['Record to be deleted'])
        });
        expect(writeResponse.reply.status.code).to.equal(202);
        const testRecordId = writeResponse.message!.recordId;

        // Pull the record to Alice's local DWN.
        await syncEngine.sync('pull');

        // Confirm the record exists on Alice's local DWN.
        let queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(queryResponse.reply.status.code).to.equal(200);
        expect(queryResponse.reply.entries).to.have.length(1);

        // Delete the record on Alice's remote DWN.
        const deleteResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsDelete,
          messageParams : { recordId: testRecordId }
        });
        expect(deleteResponse.reply.status.code).to.equal(202);

        // Pull again to sync the delete.
        await syncEngine.sync('pull');

        // Confirm the record no longer exists on Alice's local DWN.
        queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(queryResponse.reply.status.code).to.equal(200);
        expect(queryResponse.reply.entries).to.have.length(0);
      });

      it('syncs RecordsDelete messages from local to remote', async () => {
        // Scenario: Alice writes a record locally, pushes it to remote,
        //           then deletes locally, and pushes again.

        // Register Alice's DID for sync.
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        // Write a record to Alice's local DWN.
        const writeResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat : 'text/plain',
            schema     : randomSchema
          },
          dataStream: new Blob(['Record to be deleted'])
        });
        expect(writeResponse.reply.status.code).to.equal(202);
        const testRecordId = writeResponse.message!.recordId;

        // Push to remote.
        await syncEngine.sync('push');

        // Confirm record exists on remote.
        let remoteQuery = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(remoteQuery.reply.status.code).to.equal(200);
        expect(remoteQuery.reply.entries).to.have.length(1);

        // Delete the record locally.
        const deleteResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsDelete,
          messageParams : { recordId: testRecordId }
        });
        expect(deleteResponse.reply.status.code).to.equal(202);

        // Push again to sync the delete.
        await syncEngine.sync('push');

        // Confirm record no longer exists on remote.
        remoteQuery = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(remoteQuery.reply.status.code).to.equal(200);
        expect(remoteQuery.reply.entries).to.have.length(0);
      });

      it('is idempotent — running sync twice after convergence is a no-op', async () => {
        // Scenario: Alice writes a record locally, syncs once to converge,
        //           then syncs again.  The second sync should short-circuit
        //           at the root comparison and make no additional MessagesRead requests.

        // Register Alice's DID for sync.
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        // Write a record locally.
        const writeResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat : 'text/plain',
            schema     : randomSchema
          },
          dataStream: new Blob(['Idempotent sync test'])
        });
        expect(writeResponse.reply.status.code).to.equal(202);

        // First sync to push the record to remote and converge.
        await syncEngine.sync();

        // Confirm the record exists on both local and remote.
        const localQuery = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: writeResponse.message!.recordId } }
        });
        expect(localQuery.reply.entries).to.have.length(1);

        const remoteQuery = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: writeResponse.message!.recordId } }
        });
        expect(remoteQuery.reply.entries).to.have.length(1);

        // Spy on sendDwnRequest to count RPC calls during the second sync.
        const sendDwnRequestSpy = sinon.spy(testHarness.agent.rpc, 'sendDwnRequest');

        // Second sync — trees are already converged, should short-circuit.
        await syncEngine.sync();

        // The only RPC calls should be the root comparisons (one per DWN URL).
        // There should be no MessagesRead or MessagesSync subtree/leaves calls
        // beyond the root check.  With a single DWN URL, we expect exactly 1
        // root call for pull + 1 for push = 2 calls total.
        // Each call is a MessagesSync with action: 'root'.
        const rpcCalls = sendDwnRequestSpy.args;
        for (const call of rpcCalls) {
          const message = call[0]?.message as any;
          expect(message?.descriptor?.action).to.equal('root',
            'Second sync should only make root comparison calls');
        }

        sendDwnRequestSpy.restore();
      });

      it('resolves conflicts when both sides update the same record', async () => {
        // Scenario: Alice creates a record and syncs it to both DWNs.
        //           Then she updates it locally AND remotely with different data.
        //           After sync, both sides should converge to the same state.
        //           DWN conflict resolution uses the latest messageTimestamp.

        // Register Alice's DID for sync.
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        // Write a record locally.
        const writeResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat : 'text/plain',
            schema     : randomSchema
          },
          dataStream: new Blob(['Original data'])
        });
        expect(writeResponse.reply.status.code).to.equal(202);
        const testRecordId = writeResponse.message!.recordId;
        const dateCreated = writeResponse.message!.descriptor.dateCreated;

        // Sync to push the record to remote.
        await syncEngine.sync();

        // Confirm it exists on both sides.
        let localQuery = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(localQuery.reply.entries).to.have.length(1);

        let remoteQuery = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(remoteQuery.reply.entries).to.have.length(1);

        // Update on the remote with an earlier timestamp.
        const remoteUpdate = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            recordId    : testRecordId,
            dataFormat  : 'text/plain',
            schema      : randomSchema,
            dateCreated : dateCreated,
          },
          dataStream: new Blob(['Remote update'])
        });
        expect(remoteUpdate.reply.status.code).to.equal(202);

        // Update on the local with a later timestamp (by using Time offset).
        const localUpdate = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            recordId    : testRecordId,
            dataFormat  : 'text/plain',
            schema      : randomSchema,
            dateCreated : dateCreated,
          },
          dataStream: new Blob(['Local update — later'])
        });
        expect(localUpdate.reply.status.code).to.equal(202);
        const localUpdateCid = localUpdate.messageCid;

        // Sync both directions.
        await syncEngine.sync();

        // After sync, both sides should have the same record version.
        // The winner is whichever has the later messageTimestamp. Since the
        // local update happened after the remote update chronologically,
        // the local update should win on both sides.
        localQuery = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(localQuery.reply.entries).to.have.length(1);

        remoteQuery = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(remoteQuery.reply.entries).to.have.length(1);

        // Both should resolve to the same message CID.
        const { initialWrite: _localIW, ...localRawMessage } = localQuery.reply.entries![0];
        const { initialWrite: _remoteIW, ...remoteRawMessage } = remoteQuery.reply.entries![0];
        const localCid = await Message.getCid(localRawMessage);
        const remoteCid = await Message.getCid(remoteRawMessage);

        // Both sides should agree on the winning message.
        expect(localCid).to.equal(remoteCid);

        // The local update should be the winner (later timestamp).
        expect(localCid).to.equal(localUpdateCid);
      });
    });

    describe('startSync()', () => {
      it('calls sync() in each interval', async () => {
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        const syncSpy = sinon.stub(SyncEngineLevel.prototype as any, 'sync');
        syncSpy.resolves();

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        testHarness.agent.sync.startSync({ interval: '500ms' });

        await clock.tickAsync(1_400); // just under 3 intervals
        syncSpy.restore();
        clock.restore();

        // one when starting the sync, and another for each interval
        expect(syncSpy.callCount).to.equal(3, 'sync');
      });

      it('does not call sync() again until a sync round finishes', async () => {
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        // Replicate the pattern from the old pull/push test: stub an internal
        // method so the real sync() manages _syncLock, while the slow part is
        // a shared promise created BEFORE the interval.  The shared promise
        // means the first sync takes ~1500ms, but subsequent syncs complete
        // instantly (the promise is already resolved).
        //
        // The setTimeout is created before startSync, so at t=1500 it fires
        // before the interval callback — this avoids timer-ordering races.
        const walkTreeDiffStub = sinon.stub(SyncEngineLevel.prototype as any, 'walkTreeDiff');
        walkTreeDiffStub.returns(new Promise<{ onlyLocal: string[]; onlyRemote: string[] }>((resolve) => {
          clock.setTimeout(() => {
            resolve({ onlyLocal: [], onlyRemote: [] });
          }, 1_500);
        }));

        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.resolves([{ did: alice.did.uri, dwnUrl: 'http://localhost:3000', delegateDid: undefined, protocol: undefined }]);

        const getLocalRootStub = sinon.stub(SyncEngineLevel.prototype as any, 'getLocalRoot');
        getLocalRootStub.resolves('aaa');

        const getRemoteRootStub = sinon.stub(SyncEngineLevel.prototype as any, 'getRemoteRoot');
        getRemoteRootStub.resolves('bbb');

        const syncSpy = sinon.spy(SyncEngineLevel.prototype as any, 'sync');

        testHarness.agent.sync.startSync({ interval: '500ms' });

        await clock.tickAsync(1_400); // less time than the sync

        // only once for when starting the sync
        expect(syncSpy.callCount).to.equal(1, 'sync');

        await clock.tickAsync(200); //remaining time and one interval

        // once when starting, and once for the interval
        expect(syncSpy.callCount).to.equal(2, 'sync');

        await clock.tickAsync(500); // one more interval

        // one more for the interval
        expect(syncSpy.callCount).to.equal(3, 'sync');

        syncSpy.restore();
        walkTreeDiffStub.restore();
        getSyncTargetsStub.restore();
        getLocalRootStub.restore();
        getRemoteRootStub.restore();
        clock.restore();
      });

      it('calls sync once per interval with the latest interval timer being respected', async () => {
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        const syncSpy = sinon.stub(SyncEngineLevel.prototype as any, 'sync');
        // set to be a sync time longer than the interval
        syncSpy.returns(new Promise<void>((resolve) => {
          clock.setTimeout(() => {
            resolve();
          }, 1_000);
        }));

        testHarness.agent.sync.startSync({ interval: '500ms' });

        await clock.tickAsync(1_400); // less than the initial interval + the sync time

        // once for the initial call and once for each interval call
        expect(syncSpy.callCount).to.equal(2);

        // set to be a short sync time
        syncSpy.returns(new Promise<void>((resolve) => {
          clock.setTimeout(() => {
            resolve();
          }, 15);
        }));

        testHarness.agent.sync.startSync({ interval: '300ms' });

        await clock.tickAsync(301); // exactly the new interval + 1

        // one for the initial 'startSync' call and one for each interval call
        expect(syncSpy.callCount).to.equal(4);


        await clock.tickAsync(601); // two more intervals

        expect(syncSpy.callCount).to.equal(6);

        syncSpy.restore();
        clock.restore();
      });

      it('should replace the interval timer with the latest interval timer', async () => {

        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        const syncSpy = sinon.stub(SyncEngineLevel.prototype as any, 'sync');
        // set to be a sync time longer than the interval
        syncSpy.returns(new Promise<void>((resolve) => {
          clock.setTimeout(() => {
            resolve();
          }, 100);
        }));

        testHarness.agent.sync.startSync({ interval: '500ms' });

        // two intervals
        await clock.tickAsync(1_001);

        // this should equal 3, once for the initial call and once for each interval call
        expect(syncSpy.callCount).to.equal(3);

        syncSpy.resetHistory();
        testHarness.agent.sync.startSync({ interval: '200ms' });

        await clock.tickAsync(401); // two intervals

        // one for the initial 'startSync' call and one for each interval call
        expect(syncSpy.callCount).to.equal(3);

        await clock.tickAsync(401); // two more intervals

        // one additional calls for each interval
        expect(syncSpy.callCount).to.equal(5);

        syncSpy.restore();
        clock.restore();
      });

      it('should log sync errors, but continue syncing the next interval', async () => {
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        const syncSpy = sinon.stub(SyncEngineLevel.prototype as any, 'sync');

        syncSpy.returns(new Promise<void>((resolve, _reject) => {
          clock.setTimeout(() => {
            resolve();
          }, 100);
        }));

        // first call is the initial sync, 2nd and onward are the intervals
        // on the 2nd interval (3rd call), we reject the promise, a 4th call should be made
        syncSpy.onThirdCall().rejects(new Error('Sync error'));

        // spy on console.error to check if the error message is logged
        const consoleErrorSpy = sinon.stub(console, 'error').resolves();

        testHarness.agent.sync.startSync({ interval: '500ms' });

        // three intervals
        await clock.tickAsync(1_500);

        // this should equal 4, once for the initial call and once for each interval call
        expect(syncSpy.callCount).to.equal(4);

        // check if the error message is logged
        expect(consoleErrorSpy.callCount).to.equal(1);
        expect(consoleErrorSpy.args[0][0]).to.include('SyncEngineLevel: Error during sync operation');

        syncSpy.restore();
        consoleErrorSpy.restore();
        clock.restore();
      });
    });

    describe('stopSync()', () => {
      it('stops the sync interval', async () => {
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        // stub getSyncTargets to return empty array so sync() completes quickly
        // but still sets/releases the _syncLock
        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 3);
        }));

        const syncSpy = sinon.spy(SyncEngineLevel.prototype as any, 'sync');

        testHarness.agent.sync.startSync({ interval: '500ms' });

        // expect the immediate sync call
        expect(syncSpy.callCount).to.equal(1);


        await clock.tickAsync(1_300); // just under 3 intervals

        // expect 2 sync interval calls + initial sync
        expect(syncSpy.callCount).to.equal(3);

        await testHarness.agent.sync.stopSync();

        await clock.tickAsync(1_000); // 2 intervals

        // sync calls remain unchanged
        expect(syncSpy.callCount).to.equal(3);

        syncSpy.restore();
        getSyncTargetsStub.restore();
        clock.restore();
      });

      it('waits for the current sync to complete before stopping', async () => {
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        // stub getSyncTargets to take a controlled amount of time
        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 3);
        }));

        const syncSpy = sinon.spy(SyncEngineLevel.prototype as any, 'sync');

        testHarness.agent.sync.startSync({ interval: '500ms' });

        // expect the immediate sync call
        expect(syncSpy.callCount).to.equal(1);

        await clock.tickAsync(1_300); // just under 3 intervals

        // expect 2 sync interval calls + initial sync
        expect(syncSpy.callCount).to.equal(3);

        // cause getSyncTargets to take longer
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 1_000);
        }));

        await clock.tickAsync(201); // Enough time for the next interval to start

        // next interval was called
        expect(syncSpy.callCount).to.equal(4);

        // stop the sync
        await new Promise<void>((resolve) => {
          const stopPromise = testHarness.agent.sync.stopSync();
          clock.tickAsync(1_000).then(async () => {
            await stopPromise;
            resolve();
          });
        });

        // sync calls remain unchanged
        expect(syncSpy.callCount).to.equal(4);

        // wait for future intervals
        await clock.tickAsync(2_000);

        // sync calls remain unchanged
        expect(syncSpy.callCount).to.equal(4);

        syncSpy.restore();
        getSyncTargetsStub.restore();
        clock.restore();
      });

      it('throws if ongoing sync does not complete within 2 seconds', async () => {
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        // stub getSyncTargets to take a controlled amount of time
        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 3);
        }));

        const syncSpy = sinon.spy(SyncEngineLevel.prototype as any, 'sync');

        testHarness.agent.sync.startSync({ interval: '500ms' });

        // expect the immediate sync call
        expect(syncSpy.callCount).to.equal(1);

        await clock.tickAsync(1_300); // just under 3 intervals

        // expect 2 sync interval calls + initial sync
        expect(syncSpy.callCount).to.equal(3);

        // cause getSyncTargets to take longer than the 2 second timeout
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 2_700); // longer than the 2 seconds
        }));

        await clock.tickAsync(201); // Enough time for the next interval to start

        // next interval was called
        expect(syncSpy.callCount).to.equal(4);

        const stopPromise = testHarness.agent.sync.stopSync();

        try {
          await new Promise<void>((resolve, reject) => {
            stopPromise.catch((error) => reject(error));

            clock.runToLastAsync().then(async () => {
              try {
                await stopPromise;
                resolve();
              } catch (error) {
                reject(error);
              }
            });

          });
          expect.fail('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).to.equal('SyncEngineLevel: Existing sync operation did not complete within 2000 milliseconds.');
        }

        syncSpy.restore();
        getSyncTargetsStub.restore();
        clock.restore();
      });

      it('only waits for the ongoing sync for the given timeout before failing', async () => {
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri,
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        // stub getSyncTargets to take a controlled amount of time
        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 3);
        }));

        const syncSpy = sinon.spy(SyncEngineLevel.prototype as any, 'sync');

        testHarness.agent.sync.startSync({ interval: '500ms' });

        // expect the immediate sync call
        expect(syncSpy.callCount).to.equal(1);

        await clock.tickAsync(10); // enough time for the sync round trip to complete

        // cause getSyncTargets to take longer than the 2 second timeout
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 2_700); // longer than the 2 seconds
        }));

        await clock.tickAsync(501); // Enough time for the next interval to start

        // next interval was called
        expect(syncSpy.callCount).to.equal(2);

        const stopPromise = testHarness.agent.sync.stopSync(10);
        try {
          await new Promise<void>((resolve, reject) => {
            stopPromise.catch((error) => reject(error));

            clock.tickAsync(10).then(async () => {
              try {
                await stopPromise;
                resolve();
              } catch (error) {
                reject(error);
              }
            });

          });
          expect.fail('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).to.equal('SyncEngineLevel: Existing sync operation did not complete within 10 milliseconds.');
        }

        // call again with a longer timeout
        await new Promise<void>((resolve) => {
          const stopPromise2 = testHarness.agent.sync.stopSync(3_000);
          // enough time for the ongoing sync to complete + 100ms as the check interval
          clock.tickAsync(2800).then(async () => {
            stopPromise2.then(() => resolve());
          });
        });

        await clock.runToLastAsync();
        syncSpy.restore();
        getSyncTargetsStub.restore();
        clock.restore();
      });

    });

    describe('Identity Registration', () => {
      it('registers an identity with the sync engine', async () => {
        const did = alice.did.uri;
        const syncOption: SyncIdentityOptions = {
          protocols: ['https://protocol.xyz/foo', 'https://protocol.xyz/bar', 'https://protocol.xyz/baz']
        };
        await testHarness.agent.sync.registerIdentity({ did, options: syncOption });

        const identityOptions = await testHarness.agent.sync.getIdentityOptions(did);
        expect(identityOptions).to.deep.equal(syncOption);
      });

      it('throws if attempting to register an identity that is already registered', async () => {
        const did = alice.did.uri;
        const syncOption: SyncIdentityOptions = {
          protocols: ['https://protocol.xyz/foo', 'https://protocol.xyz/bar', 'https://protocol.xyz/baz']
        };
        await testHarness.agent.sync.registerIdentity({ did, options: syncOption });

        try {
          await testHarness.agent.sync.registerIdentity({ did, options: syncOption });
          expect.fail('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).to.equal(`SyncEngineLevel: Identity with DID ${did} is already registered.`);
        }
      });

      it('unregisters an identity from the sync engine', async () => {
        const did = alice.did.uri;
        const syncOption: SyncIdentityOptions = {
          protocols: ['https://protocol.xyz/foo', 'https://protocol.xyz/bar', 'https://protocol.xyz/baz']
        };
        await testHarness.agent.sync.registerIdentity({ did, options: syncOption });

        // sanity confirm that the identity is registered
        let identityOptions = await testHarness.agent.sync.getIdentityOptions(did);
        expect(identityOptions).to.deep.equal(syncOption);

        await testHarness.agent.sync.unregisterIdentity(did);

        identityOptions = await testHarness.agent.sync.getIdentityOptions(did);
        expect(identityOptions).to.be.undefined;
      });

      it('throws when attempting to unregister an identity that is not registered', async () => {
        const did = alice.did.uri;
        try {
          await testHarness.agent.sync.unregisterIdentity(did);
          expect.fail('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).to.equal(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
        }
      });

      it('gets the sync options for a specific identity', async () => {
        const did = alice.did.uri;
        const syncOption: SyncIdentityOptions = {
          protocols: ['https://protocol.xyz/foo', 'https://protocol.xyz/bar', 'https://protocol.xyz/baz']
        };
        await testHarness.agent.sync.registerIdentity({ did, options: syncOption });

        const identityOptions = await testHarness.agent.sync.getIdentityOptions(did);
        expect(identityOptions).to.deep.equal(syncOption);
      });

      it('throws if underlying DB throws an error when getting identity options', async () => {
        // stub the sublevel get method to throw an error
        const stubbedSublevel = {
          get: (_key:string): never => { throw { code: 'DB_ERROR' }; }
        };
        sinon.stub(syncEngine['_db'], 'sublevel').withArgs('registeredIdentities').returns(stubbedSublevel as any);

        try {
          await testHarness.agent.sync.getIdentityOptions('did:example:123');
          expect.fail('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).to.equal('SyncEngineLevel: Error reading level: DB_ERROR.');
        }
      });

      it('updates the sync options for a specific identity', async () => {
        const did = alice.did.uri;
        const syncOption: SyncIdentityOptions = {
          protocols: ['https://protocol.xyz/foo', 'https://protocol.xyz/bar', 'https://protocol.xyz/baz']
        };
        await testHarness.agent.sync.registerIdentity({ did, options: syncOption });

        // sanity confirm that the identity is registered
        let identityOptions = await testHarness.agent.sync.getIdentityOptions(did);
        expect(identityOptions).to.deep.equal(syncOption);

        const updatedSyncOption: SyncIdentityOptions = {
          protocols: ['https://protocol.xyz/foo', 'https://protocol.xyz/bar']
        };
        await testHarness.agent.sync.updateIdentityOptions({ did, options: updatedSyncOption });

        identityOptions = await testHarness.agent.sync.getIdentityOptions(did);
        expect(identityOptions).to.deep.equal(updatedSyncOption);
      });

      it('throws if attempting to update an identity that is not registered', async () => {
        const did = alice.did.uri;
        const syncOption: SyncIdentityOptions = {
          protocols: ['https://protocol.xyz/foo', 'https://protocol.xyz/bar', 'https://protocol.xyz/baz']
        };

        try {
          await testHarness.agent.sync.updateIdentityOptions({ did, options: syncOption });
          expect.fail('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).to.equal(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
        }
      });

      it('syncs only specified protocols', async () => {
        // create new identity to not conflict the previous tests's remote records
        const aliceSync = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });

        // create 3 local protocols
        const protocolFoo: ProtocolDefinition = {
          published : true,
          protocol  : 'https://protocol.xyz/foo',
          types     : {
            foo: {
              schema      : 'https://schemas.xyz/foo',
              dataFormats : ['text/plain', 'application/json']
            }
          },
          structure: {
            foo: {}
          }
        };

        const protocolBar: ProtocolDefinition = {
          published : true,
          protocol  : 'https://protocol.xyz/bar',
          types     : {
            bar: {
              schema      : 'https://schemas.xyz/bar',
              dataFormats : ['text/plain', 'application/json']
            }
          },
          structure: {
            bar: {}
          }
        };

        const protocolBaz: ProtocolDefinition = {
          published : true,
          protocol  : 'https://protocol.xyz/baz',
          types     : {
            baz: {
              schema      : 'https://schemas.xyz/baz',
              dataFormats : ['text/plain', 'application/json']
            }
          },
          structure: {
            baz: {}
          }
        };

        const protocolsFoo = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : {
            definition: protocolFoo
          }
        });
        expect(protocolsFoo.reply.status.code).to.equal(202);

        const protocolsBar = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : {
            definition: protocolBar
          }
        });
        expect(protocolsBar.reply.status.code).to.equal(202);

        const protocolsBaz = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : {
            definition: protocolBaz
          }
        });
        expect(protocolsBaz.reply.status.code).to.equal(202);

        // write a record for each protocol
        const recordFoo = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolFoo.protocol,
            protocolPath : 'foo',
            schema       : protocolFoo.types.foo.schema
          },
          dataStream: new Blob(['Hello, foo!'])
        });
        expect(recordFoo.reply.status.code).to.equal(202);

        const recordBar = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolBar.protocol,
            protocolPath : 'bar',
            schema       : protocolBar.types.bar.schema
          },
          dataStream: new Blob(['Hello, bar!'])
        });
        expect(recordBar.reply.status.code).to.equal(202);

        const recordBaz = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolBaz.protocol,
            protocolPath : 'baz',
            schema       : protocolBaz.types.baz.schema
          },
          dataStream: new Blob(['Hello, baz!'])
        });
        expect(recordBaz.reply.status.code).to.equal(202);

        // Register Alice's DID to be synchronized with only foo and bar protocols
        await testHarness.agent.sync.registerIdentity({
          did     : aliceSync.did.uri,
          options : {
            protocols: [ 'https://protocol.xyz/foo', 'https://protocol.xyz/bar' ]
          }
        });

        // Execute Sync to push sync, only foo protocol should be synced
        await syncEngine.sync('push');

        // query remote to see foo protocol
        const remoteProtocolsQueryResponse = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.ProtocolsQuery,
          messageParams : {}
        });
        const remoteProtocolsQueryReply = remoteProtocolsQueryResponse.reply;
        expect(remoteProtocolsQueryReply.status.code).to.equal(200);
        expect(remoteProtocolsQueryReply.entries?.length).to.equal(2);
        expect(remoteProtocolsQueryReply.entries).to.have.deep.equal([ protocolsFoo.message, protocolsBar.message ]);

        // query remote to see foo record
        const remoteFooRecordsResponse = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolFoo.protocol,
            }
          }
        });
        const remoteFooRecordsReply = remoteFooRecordsResponse.reply;
        expect(remoteFooRecordsReply.status.code).to.equal(200);
        expect(remoteFooRecordsReply.entries).to.have.length(1);
        const remoteFooRecordIds = remoteFooRecordsReply.entries?.map(entry => entry.recordId);
        expect(remoteFooRecordIds).to.have.members([ recordFoo.message!.recordId ]);

        // query remote to see bar record
        let remoteBarRecordsResponse = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolBar.protocol,
            }
          }
        });
        let remoteBarRecordsReply = remoteBarRecordsResponse.reply;
        expect(remoteBarRecordsReply.status.code).to.equal(200);
        expect(remoteBarRecordsReply.entries).to.have.length(1);
        let remoteBarRecordIds = remoteBarRecordsReply.entries?.map(entry => entry.recordId);
        expect(remoteBarRecordIds).to.have.members([ recordBar.message!.recordId ]);

        // query remote to see baz record, none should be returned
        let remoteBazRecordsResponse = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolBaz.protocol,
            }
          }
        });
        let remoteBazRecordsReply = remoteBazRecordsResponse.reply;
        expect(remoteBazRecordsReply.status.code).to.equal(200);
        expect(remoteBazRecordsReply.entries).to.have.length(0);


        // now write a foo record remotely, and a bar record locally
        // initiate a sync to both push and pull the records respectively

        // write a record to the remote for the foo protocol
        const recordFoo2 = await testHarness.agent.sendDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolFoo.protocol,
            protocolPath : 'foo',
            schema       : protocolFoo.types.foo.schema
          },
          dataStream: new Blob(['Hello, foo 2!'])
        });
        expect(recordFoo2.reply.status.code).to.equal(202);

        // write a local record to the bar protocol
        const recordBar2 = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolBar.protocol,
            protocolPath : 'bar',
            schema       : protocolBar.types.bar.schema
          },
          dataStream: new Blob(['Hello, bar 2!'])
        });
        expect(recordBar2.reply.status.code).to.equal(202);

        // confirm that the foo record is not yet in the local DWN
        let localFooRecordsResponse = await testHarness.agent.dwn.processRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolFoo.protocol,
            }
          }
        });
        let localFooRecordsReply = localFooRecordsResponse.reply;
        expect(localFooRecordsReply.status.code).to.equal(200);
        expect(localFooRecordsReply.entries).to.have.length(1);
        let localFooRecordIds = localFooRecordsReply.entries?.map(entry => entry.recordId);
        expect(localFooRecordIds).to.not.include(recordFoo2.message!.recordId);


        // confirm that the bar record is not yet in the remote DWN
        remoteBarRecordsResponse = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolBar.protocol,
            }
          }
        });
        remoteBarRecordsReply = remoteBarRecordsResponse.reply;
        expect(remoteBarRecordsReply.status.code).to.equal(200);
        expect(remoteBarRecordsReply.entries).to.have.length(1);
        remoteBarRecordIds = remoteBarRecordsReply.entries?.map(entry => entry.recordId);
        expect(remoteBarRecordIds).to.not.include(recordBar2.message!.recordId);

        // preform a pull and push sync
        await syncEngine.sync();

        // query local to see foo records with the new record
        localFooRecordsResponse = await testHarness.agent.dwn.processRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolFoo.protocol,
            }
          }
        });
        localFooRecordsReply = localFooRecordsResponse.reply;
        expect(localFooRecordsReply.status.code).to.equal(200);
        expect(localFooRecordsReply.entries).to.have.length(2);
        localFooRecordIds = localFooRecordsReply.entries?.map(entry => entry.recordId);
        expect(localFooRecordIds).to.have.members([ recordFoo.message!.recordId, recordFoo2.message!.recordId ]);

        // query remote to see bar records with the new record
        remoteBarRecordsResponse = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolBar.protocol,
            }
          }
        });
        remoteBarRecordsReply = remoteBarRecordsResponse.reply;
        expect(remoteBarRecordsReply.status.code).to.equal(200);
        expect(remoteBarRecordsReply.entries).to.have.length(2);
        remoteBarRecordIds = remoteBarRecordsReply.entries?.map(entry => entry.recordId);
        expect(remoteBarRecordIds).to.have.members([ recordBar.message!.recordId, recordBar2.message!.recordId ]);

        // confirm that still no baz records exist remotely
        remoteBazRecordsResponse = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolBaz.protocol,
            }
          }
        });
        remoteBazRecordsReply = remoteBazRecordsResponse.reply;
        expect(remoteBazRecordsReply.status.code).to.equal(200);
        expect(remoteBazRecordsReply.entries).to.have.length(0);
      });

      it('syncs only specified protocols and delegates', async () => {
        const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });

        const aliceDeviceXHarness = await PlatformAgentTestHarness.setup({
          agentClass       : TestAgent,
          agentStores      : 'memory',
          testDataLocation : '__TESTDATA__/alice-device',
        });
        await aliceDeviceXHarness.clearStorage();
        await aliceDeviceXHarness.createAgentDid();

        // create a connected DID
        const aliceDeviceX = await aliceDeviceXHarness.agent.identity.create({
          store     : true,
          didMethod : 'jwk',
          metadata  : { name: 'Alice Device X', connectedDid: alice.did.uri }
        });

        // Alice create 2 protocols on alice's remote DWN
        const protocolFoo: ProtocolDefinition = {
          published : true,
          protocol  : 'https://protocol.xyz/foo',
          types     : {
            foo: {
              schema      : 'https://schemas.xyz/foo',
              dataFormats : ['text/plain', 'application/json']
            }
          },
          structure: {
            foo: {}
          }
        };

        const protocolBar: ProtocolDefinition = {
          published : true,
          protocol  : 'https://protocol.xyz/bar',
          types     : {
            bar: {
              schema      : 'https://schemas.xyz/bar',
              dataFormats : ['text/plain', 'application/json']
            }
          },
          structure: {
            bar: {}
          }
        };

        // configure the protocols
        const protocolsFoo = await testHarness.agent.sendDwnRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : {
            definition: protocolFoo
          }
        });
        expect(protocolsFoo.reply.status.code).to.equal(202);

        const protocolsBar = await testHarness.agent.sendDwnRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : {
            definition: protocolBar
          }
        });
        expect(protocolsBar.reply.status.code).to.equal(202);

        // create grants for foo protocol, granted to aliceDeviceX
        const messagesReadGrant = await testHarness.agent.permissions.createGrant({
          store       : true,
          author      : alice.did.uri,
          grantedTo   : aliceDeviceX.did.uri,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
          scope       : { protocol: protocolFoo.protocol, interface: DwnInterfaceName.Messages, method: DwnMethodName.Read }
        });

        const messagesSyncGrant = await testHarness.agent.permissions.createGrant({
          store       : true,
          author      : alice.did.uri,
          grantedTo   : aliceDeviceX.did.uri,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
          scope       : { protocol: protocolFoo.protocol, interface: DwnInterfaceName.Messages, method: DwnMethodName.Sync }
        });

        const recordsQueryGrant = await testHarness.agent.permissions.createGrant({
          store       : true,
          author      : alice.did.uri,
          grantedTo   : aliceDeviceX.did.uri,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
          delegated   : true,
          scope       : { protocol: protocolFoo.protocol, interface: DwnInterfaceName.Records, method: DwnMethodName.Query }
        });

        const { encodedData: readGrantData, ... messagesReadGrantMessage } = messagesReadGrant.message;
        const processMessagesReadGrantAsOwner = await aliceDeviceXHarness.agent.processDwnRequest({
          author      : aliceDeviceX.did.uri,
          target      : aliceDeviceX.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesReadGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(readGrantData).toUint8Array() ]),
          signAsOwner : true
        });
        expect(processMessagesReadGrantAsOwner.reply.status.code).to.equal(202);

        const processMessagesReadGrant = await aliceDeviceXHarness.agent.processDwnRequest({
          author      : aliceDeviceX.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesReadGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(readGrantData).toUint8Array() ])
        });
        expect(processMessagesReadGrant.reply.status.code).to.equal(202);

        const { encodedData: syncGrantData, ... messagesSyncGrantMessage } = messagesSyncGrant.message;
        const processMessagesSyncGrantAsOwner = await aliceDeviceXHarness.agent.processDwnRequest({
          author      : aliceDeviceX.did.uri,
          target      : aliceDeviceX.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesSyncGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(syncGrantData).toUint8Array() ]),
          signAsOwner : true
        });
        expect(processMessagesSyncGrantAsOwner.reply.status.code).to.equal(202);

        const processMessagesSyncGrant = await aliceDeviceXHarness.agent.processDwnRequest({
          author      : aliceDeviceX.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesSyncGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(syncGrantData).toUint8Array() ]),
        });
        expect(processMessagesSyncGrant.reply.status.code).to.equal(202);

        // send the grants to the remote DWN
        const remoteMessagesSyncGrant = await testHarness.agent.sendDwnRequest({
          author      : alice.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesSyncGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(syncGrantData).toUint8Array() ]),
        });
        expect(remoteMessagesSyncGrant.reply.status.code).to.equal(202);

        const remoteMessagesReadGrant = await testHarness.agent.sendDwnRequest({
          author      : alice.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesReadGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(readGrantData).toUint8Array() ]),
        });
        expect(remoteMessagesReadGrant.reply.status.code).to.equal(202);

        const { encodedData: recordsQueryGrantData, ... recordsQueryGrantMessage } = recordsQueryGrant.message;
        const processRecordsQueryGrant = await testHarness.agent.sendDwnRequest({
          author      : alice.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : recordsQueryGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(recordsQueryGrantData).toUint8Array() ]),
        });
        expect(processRecordsQueryGrant.reply.status.code).to.equal(202);


        // create a record for each protocol
        const recordFoo = await testHarness.agent.sendDwnRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolFoo.protocol,
            protocolPath : 'foo',
            schema       : protocolFoo.types.foo.schema
          },
          dataStream: new Blob(['Hello, foo!'])
        });
        expect(recordFoo.reply.status.code).to.equal(202);

        const recordBar = await testHarness.agent.sendDwnRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolBar.protocol,
            protocolPath : 'bar',
            schema       : protocolBar.types.bar.schema
          },
          dataStream: new Blob(['Hello, bar!'])
        });
        expect(recordBar.reply.status.code).to.equal(202);

        // Register Alice's DID to be synchronized with only foo protocol
        await aliceDeviceXHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : {
            protocols   : [ protocolFoo.protocol ],
            delegateDid : aliceDeviceX.did.uri
          }
        });

        // Execute Sync, only foo protocol should be synced
        await aliceDeviceXHarness.agent.sync.sync();

        // query aliceDeviceX to see foo records
        const localFooRecords = await aliceDeviceXHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          granteeDid    : aliceDeviceX.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            delegatedGrant : recordsQueryGrant.message,
            filter         : {
              protocol: protocolFoo.protocol,
            }
          }
        });
        const didAuthor = Jws.getSignerDid(localFooRecords.message!.authorization?.signature.signatures[0]!);
        expect(didAuthor).to.equal(aliceDeviceX.did.uri);
        expect(localFooRecords.reply.status.code).to.equal(200);
        expect(localFooRecords.reply.entries).to.have.length(1);
        expect(localFooRecords.reply.entries?.map(entry => entry.recordId)).to.have.deep.equal([ recordFoo.message?.recordId ]);

        // sanity check that bar records do not exist on aliceDeviceX
        // since aliceDeviceX does not have a grant for the bar protocol, query the records using alice's signatures.
        // confirm that the query was successful on alice's remote DWN and returns the message
        const localBarRecordsQuery = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolBar.protocol,
            }
          }
        });
        expect(localBarRecordsQuery.reply.status.code).to.equal(200);
        expect(localBarRecordsQuery.reply.entries).to.have.length(1);

        // use the same message to query `aliceDeviceXHarness` DWN, should return zero results because they were not synced
        const localBarRecords = await aliceDeviceXHarness.agent.dwn.processRequest({
          author      : alice.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsQuery,
          rawMessage  : localBarRecordsQuery.message,
        });
        expect(localBarRecords.reply.status.code).to.equal(200);
        expect(localBarRecords.reply.entries).to.have.length(0);
      });

      it('defaults to all protocols and undefined delegate if no options are provided', async () => {
        // spy on AbstractLevel put
        const abstractLevelPut = sinon.spy(AbstractLevel.prototype, 'put');

        // register identity without any options
        await testHarness.agent.sync.registerIdentity({
          did: alice.did.uri
        });

        const registerIdentitiesPutCall = abstractLevelPut.args[0];
        const options = JSON.parse(registerIdentitiesPutCall[1] as string);
        // confirm that without options the options are set to an empty protocol array
        expect(options).to.deep.equal({ protocols: [] });
      });
    });
  });

  describe('topologicalSort', () => {
    // Helper to create a minimal mock GenericMessage with the given descriptor fields.
    function mockMessage(
      overrides: Record<string, unknown>,
      topLevel?: Record<string, unknown>
    ): { message: GenericMessage } {
      const descriptor = {
        interface        : DwnInterfaceName.Records,
        method           : DwnMethodName.Write,
        messageTimestamp : Time.getCurrentTimestamp(),
        ...overrides,
      };
      return {
        message: { descriptor, ...topLevel } as unknown as GenericMessage,
      };
    }

    it('returns messages unchanged when there is only one message', () => {
      const msg = mockMessage({});
      const result = SyncEngineLevel.topologicalSort([msg]);
      expect(result).to.have.length(1);
      expect(result[0]).to.equal(msg);
    });

    it('sorts ProtocolsConfigure before RecordsWrite that references the protocol', () => {
      const protocolUrl = 'https://example.com/proto';
      const recordsWrite = mockMessage(
        { protocol: protocolUrl },
        { recordId: 'rec-1' }
      );
      const protocolsConfigure = mockMessage({
        interface  : DwnInterfaceName.Protocols,
        method     : DwnMethodName.Configure,
        definition : { protocol: protocolUrl },
      });
      // Pass in reverse order: records first, protocol second.
      const result = SyncEngineLevel.topologicalSort([recordsWrite, protocolsConfigure]);
      expect(result[0]).to.equal(protocolsConfigure);
      expect(result[1]).to.equal(recordsWrite);
    });

    it('sorts initial write before update write for the same recordId', () => {
      const ts1 = '2024-01-01T00:00:00.000000Z';
      const ts2 = '2024-01-02T00:00:00.000000Z';
      const update = mockMessage(
        { dateCreated: ts1, messageTimestamp: ts2 },
        { recordId: 'rec-1' }
      );
      const initial = mockMessage(
        { dateCreated: ts1, messageTimestamp: ts1 },
        { recordId: 'rec-1' }
      );
      // Pass update first.
      const result = SyncEngineLevel.topologicalSort([update, initial]);
      expect(result[0]).to.equal(initial);
      expect(result[1]).to.equal(update);
    });

    it('sorts permission grant before a message that references it via permissionGrantId', () => {
      const grantRecordId = 'grant-record-1';
      const grant = mockMessage(
        {
          protocol         : PermissionsProtocol.uri,
          protocolPath     : PermissionsProtocol.grantPath,
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
        },
        { recordId: grantRecordId }
      );
      const dependent = mockMessage({
        permissionGrantId : grantRecordId,
        messageTimestamp  : '2024-01-02T00:00:00.000000Z',
      });
      // Pass dependent first, grant second.
      const result = SyncEngineLevel.topologicalSort([dependent, grant]);
      expect(result[0]).to.equal(grant);
      expect(result[1]).to.equal(dependent);
    });

    it('does not crash when permissionGrantId references a grant not in the batch', () => {
      const msg1 = mockMessage({ messageTimestamp: '2024-01-01T00:00:00.000000Z' });
      const msg2 = mockMessage({
        permissionGrantId : 'grant-not-in-batch',
        messageTimestamp  : '2024-01-02T00:00:00.000000Z',
      });
      // Should not throw; no edge is added because the grant is not in the batch.
      const result = SyncEngineLevel.topologicalSort([msg1, msg2]);
      expect(result).to.have.length(2);
    });

    it('handles combined protocol, parent, and grant dependencies', () => {
      const protocolUrl = 'https://example.com/proto';
      const grantRecordId = 'grant-1';
      const parentRecordId = 'parent-1';

      const protocolsConfigure = mockMessage({
        interface        : DwnInterfaceName.Protocols,
        method           : DwnMethodName.Configure,
        definition       : { protocol: protocolUrl },
        messageTimestamp : '2024-01-01T00:00:00.000000Z',
      });
      const grant = mockMessage(
        {
          protocol         : PermissionsProtocol.uri,
          protocolPath     : PermissionsProtocol.grantPath,
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
        },
        { recordId: grantRecordId }
      );
      const parent = mockMessage(
        {
          protocol         : protocolUrl,
          dateCreated      : '2024-01-02T00:00:00.000000Z',
          messageTimestamp : '2024-01-02T00:00:00.000000Z',
        },
        { recordId: parentRecordId }
      );
      const child = mockMessage(
        {
          protocol          : protocolUrl,
          parentId          : parentRecordId,
          permissionGrantId : grantRecordId,
          dateCreated       : '2024-01-03T00:00:00.000000Z',
          messageTimestamp  : '2024-01-03T00:00:00.000000Z',
        },
        { recordId: 'child-1' }
      );

      // Pass in reverse dependency order.
      const result = SyncEngineLevel.topologicalSort([child, parent, grant, protocolsConfigure]);

      // ProtocolsConfigure must come before parent and child (both reference the protocol).
      const configIdx = result.indexOf(protocolsConfigure);
      const parentIdx = result.indexOf(parent);
      const childIdx = result.indexOf(child);
      const grantIdx = result.indexOf(grant);

      expect(configIdx).to.be.lessThan(parentIdx);
      expect(configIdx).to.be.lessThan(childIdx);
      expect(parentIdx).to.be.lessThan(childIdx);
      expect(grantIdx).to.be.lessThan(childIdx);
    });
  });
});