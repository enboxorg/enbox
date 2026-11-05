import type { DwnSubscriptionMessage } from '@enbox/dwn-clients';
import type { BearerDid, PortableDid } from '@enbox/dids';
import type {
  DwnMessage,
  DwnModuleDefinition,
  EnboxPlatformAgent,
  ProcessDwnRequest,
} from '@enbox/agent';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { PlatformAgentTestHarness } from '@enbox/agent/test';

import {
  AgentPermissionsApi, createPermissionGrants, DwnDateSort, DwnInterface,
  EnboxUserAgent, PermissionGrantNotFoundError,
} from '@enbox/agent';
import { DwnConstant, DwnInterfaceName, DwnMethodName, Jws, Poller, Time } from '@enbox/dwn-sdk-js';
import { processConnectedGrants, WalletConnect } from '@enbox/auth';

import emailModuleDefinition from './fixtures/module-definitions/email.json' with { type: 'json' };
import notesModuleDefinition from './fixtures/module-definitions/notes.json' with { type: 'json' };
import photosModuleDefinition from './fixtures/module-definitions/photos.json' with { type: 'json' };

import { DwnApi } from '../src/dwn-api.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { Enbox } from '../src/enbox.js';
import type { Record } from '../src/record.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';
import { publishModule, publishRecord, publishUnstoredRecord } from './utils/test-dwn-operations.js';

const testDwnUrls: string[] = [testDwnUrl];

function getSubscriptionRecordId(message: DwnSubscriptionMessage): string | undefined {
  if (message.type !== 'event') {
    return undefined;
  }
  const recordMessage = message.event.message as { recordId?: string; descriptor?: { recordId?: string } };
  return recordMessage.recordId ?? recordMessage.descriptor?.recordId;
}

/** Admit a remotely read write to a local test tenant through the raw agent API. */
async function storeRecordLocally(
  agent: EnboxPlatformAgent,
  record: Record,
  tenant: string,
): Promise<void> {
  const { reply } = await agent.processDwnRequest({
    author      : tenant,
    dataStream  : await record.data.stream(),
    messageType : DwnInterface.RecordsWrite,
    rawMessage  : record.rawMessage as DwnMessage[DwnInterface.RecordsWrite],
    store       : true,
    target      : tenant,
  });
  if (reply.status.code < 200 || reply.status.code > 299) {
    throw new DwnResponseError('storeRecordLocally', reply.status);
  }
}

describe('DwnApi', () => {
  let aliceDid: BearerDid;
  let bobDid: BearerDid;
  let dwnAlice: DwnApi;
  let dwnBob: DwnApi;
  let testHarness: PlatformAgentTestHarness;
  let moduleUri: string;
  let moduleDefinition: DwnModuleDefinition;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : EnboxUserAgent,
      agentStores : 'memory'
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    // Create an "alice" Identity to author the DWN messages.
    const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    aliceDid = alice.did;

    // Create a "bob" Identity to author the DWN messages.
    const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });
    bobDid = bob.did;

    // Instantiate DwnApi for both test identities.
    dwnAlice = new DwnApi({ agent: testHarness.agent, connectedDid: aliceDid.uri });
    dwnBob = new DwnApi({ agent: testHarness.agent, connectedDid: bobDid.uri });
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.syncStore.clear();
    await testHarness.dwnDataStore.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    await testHarness.agent.permissions.clear();
    testHarness.dwnStores.clear();

    dwnAlice['connectedDid'] = aliceDid.uri;
    dwnBob['connectedDid'] = bobDid.uri;

    delete dwnAlice['delegateDid'];
    delete dwnBob['delegateDid'];

    // give the module a random URI on each run
    moduleUri = `http://example.com/module/${TestDataGenerator.randomString(15)}`;
    moduleDefinition = {
      ...emailModuleDefinition,
      module: moduleUri
    };
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('messages.subscribe() from remote', () => {
    it('should stream remote events over the subscription socket', async () => {
      // Install the module locally and on the remote DWN.
      const { status: configStatus, module } = await dwnAlice.modules.configure({ definition: moduleDefinition });
      expect(configStatus.code).toBe(202);
      const { status: moduleSendStatus } = await publishModule(
        testHarness.agent, module!, aliceDid.uri, aliceDid.uri
      );
      expect(moduleSendStatus.code).toBe(202);

      const events: DwnSubscriptionMessage[] = [];
      const { status, subscription } = await dwnAlice.messages.subscribe({
        from                : aliceDid.uri,
        filters             : [{ module: moduleDefinition.module }],
        subscriptionHandler : (message): void => { events.push(message); },
      });
      expect(status.code).toBe(200);
      expect(subscription).toBeDefined();

      const remoteData = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data       : remoteData,
        module     : moduleDefinition.module,
        modulePath : 'thread',
        schema     : moduleDefinition.types.thread.schema,
        dataFormat : 'application/json',
      });
      expect(writeStatus.code).toBe(202);
      await publishRecord(testHarness.agent, record, aliceDid.uri, aliceDid.uri);

      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(events.some(event => getSubscriptionRecordId(event) === record.id)).toBe(true);
      });

      const change = events.find(event => getSubscriptionRecordId(event) === record.id)!;
      expect(change.type).toBe('event');
      if (change.type === 'event') {
        expect(change.event.message.descriptor.module).toBe(moduleDefinition.module);
      }

      await subscription!.close();
    });
  });

  describe('as delegateDid', () => {
    let delegateHarness: PlatformAgentTestHarness;
    let delegateDid: PortableDid;
    let delegateDwn: DwnApi;
    let notesModule: DwnModuleDefinition;

    beforeAll(async () => {
      delegateHarness = await PlatformAgentTestHarness.setup({
        agentClass       : EnboxUserAgent,
        agentStores      : 'memory',
        testDataLocation : '__TESTDATA__/delegateDid'
      });

      await delegateHarness.clearStorage();
      await delegateHarness.createAgentDid();
    });

    afterAll(async () => {
      await delegateHarness.clearStorage();
      await delegateHarness.closeStorage();
    });

    beforeEach(async () => {
      sinon.restore();
      await delegateHarness.syncStore.clear();
      await delegateHarness.dwnDataStore.clear();
      await delegateHarness.dwnMessageStore.clear();
      await delegateHarness.dwnResumableTaskStore.clear();
      await testHarness.agent.permissions.clear();
      delegateHarness.dwnStores.clear();

      // avoid seeing the security warning of no password during connect
      sinon.stub(console, 'warn');

      notesModule = {
        published : true,
        module    : `http://notes-module.xyz/module/${TestDataGenerator.randomString(15)}`,
        types     : {
          note: {
            schema      : 'https://notes-module.xyz/schema/note',
            dataFormats : [ 'text/plain', 'application/json' ]
          }
        },
        structure: {
          note: {}
        }
      };

      // Create a "device" JWK to use as the delegateDid
      const delegatedBearerDid = await testHarness.agent.did.create({ store: false, method: 'jwk', });
      delegateDid = await delegatedBearerDid.export();

      const grantRequest = WalletConnect.createPermissionRequestForModule({
        definition  : notesModule,
        permissions : ['write', 'read', 'delete']
      });

      // alice and bob both configure the module
      const { status: aliceConfigStatus, module: aliceNotesModule } =
        await dwnAlice.modules.configure({ definition: notesModule });
      expect(aliceConfigStatus.code).toBe(202);
      const { status: aliceNotesModuleSend } = await publishModule(
        testHarness.agent, aliceNotesModule, aliceDid.uri, aliceDid.uri
      );
      expect(aliceNotesModuleSend.code).toBe(202);

      const { status: bobConfigStatus, module: bobNotesModule } = await dwnBob.modules.configure({ definition: notesModule });
      expect(bobConfigStatus.code).toBe(202);
      const { status: bobNotesModuleSend } = await publishModule(
        testHarness.agent, bobNotesModule, bobDid.uri, bobDid.uri
      );
      expect(bobNotesModuleSend.code).toBe(202);

      const grants = await createPermissionGrants(
        aliceDid.uri, delegatedBearerDid.uri, testHarness.agent, grantRequest.permissionScopes
      );

      // Import the delegate DID as a full identity (with connectedDid metadata)
      // so the delegate agent can resolve it and sign on behalf of Alice.
      await delegateHarness.agent.identity.import({ portableIdentity: {
        portableDid : delegateDid,
        metadata    : {
          connectedDid : aliceDid.uri,
          name         : 'Default',
          uri          : delegateDid.uri,
          tenant       : delegateHarness.agent.agentDid.uri,
        }
      } });

      // Process the connected grants (stores them in the delegate agent's DWN).
      const connectedModules = await processConnectedGrants({
        grants, connectedDid: aliceDid.uri, delegateDid: delegateDid.uri, agent: delegateHarness.agent as EnboxUserAgent,
      });

      // Register sync for Alice's DID and pull the module configuration.
      await (delegateHarness.agent as EnboxUserAgent).sync.setIdentityOptions({
        did     : aliceDid.uri,
        options : {
          delegateDid : delegateDid.uri,
          modules     : connectedModules,
        }
      });
      await (delegateHarness.agent as EnboxUserAgent).sync.sync('pull');

      // Construct the Enbox instance directly with delegate support.
      const enbox = new Enbox({ agent: delegateHarness.agent, connectedDid: aliceDid.uri, delegateDid: delegateDid.uri });
      delegateDwn = (enbox as any)._dwn;
    });

    it('propagates operational permission-resolution failures', async () => {
      const failure = new Error('grant store unavailable');
      const permissionsApi = (delegateDwn as any).permissionsApi as AgentPermissionsApi;
      const resolveGrant = sinon.stub(permissionsApi, 'getPermissionForRequest').rejects(failure);

      await expect(delegateDwn.records.count({
        filter: { module: notesModule.module },
      })).rejects.toBe(failure);
      await expect(delegateDwn.modules.query({
        filter: { module: notesModule.module },
      })).rejects.toBe(failure);
      await expect(delegateDwn.messages.subscribe({
        filters             : [{ module: notesModule.module }],
        subscriptionHandler : (): void => {},
      })).rejects.toBe(failure);

      expect(resolveGrant.callCount).toBe(3);
    });

    describe('messages', () => {
      it('should subscribe with an auto-resolved Messages.Read grant and receive delegated writes', async () => {
        const { grant: messagesReadGrant } = await (delegateDwn as any).permissionsApi.getPermissionForRequest({
          connectedDid : aliceDid.uri,
          delegateDid  : delegateDid.uri,
          module       : notesModule.module,
          messageType  : DwnInterface.MessagesSubscribe,
        });
        const processSpy = sinon.spy(delegateHarness.agent, 'processDwnRequest');
        const events: DwnSubscriptionMessage[] = [];
        const { status, subscription } = await delegateDwn.messages.subscribe({
          filters             : [{ module: notesModule.module }],
          subscriptionHandler : (message): void => { events.push(message); },
        });
        expect(status.code).toBe(200);
        expect(subscription).toBeDefined();

        const subscribeRequest = processSpy.getCalls().find(
          call => call.args[0].messageType === DwnInterface.MessagesSubscribe
        )!.args[0];
        expect(subscribeRequest.messageParams.permissionGrantIds).toEqual([messagesReadGrant.id]);

        const data = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
        const { status: writeStatus, record } = await delegateDwn.records.write({
          data,
          module     : notesModule.module,
          modulePath : 'note',
          schema     : notesModule.types.note.schema,
          dataFormat : 'text/plain',
        });
        expect(writeStatus.code).toBe(202);

        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(events.some(event => getSubscriptionRecordId(event) === record.id)).toBe(true);
        });

        await subscription!.close();
      });

      it('should honour caller-supplied permissionGrantIds without re-resolution', async () => {
        // Obtain the Messages.Read grant id the connect ceremony delivered.
        const { grant } = await (delegateDwn as any).permissionsApi.getPermissionForRequest({
          connectedDid : aliceDid.uri,
          delegateDid  : delegateDid.uri,
          module       : notesModule.module,
          messageType  : DwnInterface.MessagesSubscribe,
        });

        // Explicit ids must win: no further grant resolution happens.
        const resolveSpy = sinon.spy((delegateDwn as any).permissionsApi, 'getPermissionForRequest');
        const events: DwnSubscriptionMessage[] = [];
        const { status, subscription } = await delegateDwn.messages.subscribe({
          filters             : [{ module: notesModule.module }],
          permissionGrantIds  : [grant.id],
          subscriptionHandler : (message): void => { events.push(message); },
        });
        expect(status.code).toBe(200);
        expect(resolveSpy.notCalled).toBe(true);
        resolveSpy.restore();

        const { status: writeStatus, record } = await delegateDwn.records.write({
          data       : 'explicit grant note',
          module     : notesModule.module,
          modulePath : 'note',
          schema     : notesModule.types.note.schema,
          dataFormat : 'text/plain',
        });
        expect(writeStatus.code).toBe(202);

        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(events.some(event => getSubscriptionRecordId(event) === record.id)).toBe(true);
        });

        await subscription!.close();
      });
    });

    describe('records', () => {
      it('should create a record with a delegated grant', async () => {
        const { status, record } = await delegateDwn.records.write({
          data       : 'Hello, world!',
          module     : notesModule.module,
          modulePath : 'note',
          schema     : notesModule.types.note.schema,
          dataFormat : 'text/plain',
        });

        expect(status.code).toBe(202);
        expect(record).toBeDefined();

        // alice is the author, but the signer is the delegateDid
        expect(record.author).toBe(aliceDid.uri);
        const signerDid = Jws.getSignerDid(record.rawMessage.authorization.signature.signatures[0]);
        expect(signerDid).toBe(delegateDid.uri);
        expect(record.rawMessage.authorization.authorDelegatedGrant).toBeDefined();
      });

      it('should read records with a delegated grant', async () => {
        const { status: writeStatus, record } = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : notesModule.module,
          modulePath : 'note',
          schema     : notesModule.types.note.schema,
          dataFormat : 'text/plain',
        });

        expect(writeStatus.code).toBe(202);
        expect(record).toBeDefined();
        await publishRecord(testHarness.agent, record, aliceDid.uri, aliceDid.uri);

        const { status: readStatus, record: readRecord } = await delegateDwn.records.read({
          from   : aliceDid.uri,
          filter : {
            module   : notesModule.module,
            recordId : record.id
          }
        });

        expect(readStatus.code).toBe(200);
        expect(readRecord).toBeDefined();
        expect(readRecord.id).toBeDefined();
      });

      it('should query records with a delegated grant', async () => {
        const { status: writeStatus, record } = await delegateDwn.records.write({
          data       : 'Hello, world!',
          module     : notesModule.module,
          modulePath : 'note',
          schema     : notesModule.types.note.schema,
          dataFormat : 'text/plain',
        });

        expect(writeStatus.code).toBe(202);
        expect(record).toBeDefined();

        const { status: queryStatus, records } = await delegateDwn.records.query({
          filter: {
            module     : notesModule.module,
            modulePath : 'note'
          }
        });

        expect(queryStatus.code).toBe(200);
        expect(records).toBeDefined();
        expect(records).toHaveLength(1);

        // alice is the author, but the signer is the delegateDid
        expect(records[0].author).toBe(aliceDid.uri);
        const signerDid = Jws.getSignerDid(records[0].rawMessage.authorization.signature.signatures[0]);
        expect(signerDid).toBe(delegateDid.uri);
        expect(records[0].rawMessage.authorization.authorDelegatedGrant).toBeDefined();

        // the record should be the same
        expect(records[0].id).toBe(record.id);
      });

      it('should read records as the delegate DID if no grant is found', async () => {
        // alice installs some other module
        const { status: aliceConfigStatus, module: aliceOtherModule } = await dwnAlice.modules.configure({ definition: {
          ...notesModule,
          module: `http://other-module.xyz/module/${TestDataGenerator.randomString(15)}`
        } });
        expect(aliceConfigStatus.code).toBe(202);
        const { status: aliceOtherModuleSend } = await publishModule(
          testHarness.agent, aliceOtherModule, aliceDid.uri, aliceDid.uri
        );
        expect(aliceOtherModuleSend.code).toBe(202);

        // alice writes a note record to the permissioned module
        const { status: writeStatus1, record: allowedRecord } = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : notesModule.module,
          modulePath : 'note',
          schema     : notesModule.types.note.schema,
          dataFormat : 'text/plain',
        });
        expect(writeStatus1.code).toBe(202);
        expect(allowedRecord).toBeDefined();
        await publishRecord(testHarness.agent, allowedRecord, aliceDid.uri, aliceDid.uri);

        // alice writes a public and private note to the other module
        const { status: writeStatus2, record: publicRecord } = await dwnAlice.records.write({
          data       : 'Hello, world!',
          published  : true,
          module     : aliceOtherModule.definition.module,
          modulePath : 'note',
          schema     : aliceOtherModule.definition.types.note.schema,
          dataFormat : 'text/plain',
        });
        expect(writeStatus2.code).toBe(202);
        expect(publicRecord).toBeDefined();
        await publishRecord(testHarness.agent, publicRecord, aliceDid.uri, aliceDid.uri);

        const { status: writeStatus3, record: privateRecord } = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : aliceOtherModule.definition.module,
          modulePath : 'note',
          schema     : aliceOtherModule.definition.types.note.schema,
          dataFormat : 'text/plain',
        });
        expect(writeStatus3.code).toBe(202);
        expect(privateRecord).toBeDefined();
        await publishRecord(testHarness.agent, privateRecord, aliceDid.uri, aliceDid.uri);


        // sanity: delegateDwn reads from the allowed record from alice's DWN
        const { status: readStatus1, record: allowedRecordReturned } = await delegateDwn.records.read({
          from   : aliceDid.uri,
          filter : {
            module   : notesModule.module,
            recordId : allowedRecord.id
          }
        });
        expect(readStatus1.code).toBe(200);
        expect(allowedRecordReturned).toBeDefined();
        expect(allowedRecordReturned.id).toBe(allowedRecord.id);

        // delegateDwn reads from the other module, which no permissions exist
        // only the public record is successfully returned
        const { status: readStatus2, record: publicRecordReturned } = await delegateDwn.records.read({
          from   : aliceDid.uri,
          filter : {
            recordId: publicRecord.id
          }
        });
        expect(readStatus2.code).toBe(200);
        expect(publicRecordReturned).toBeDefined();
        expect(publicRecordReturned.id).toBe(publicRecord.id);

        // attempt to read the private record, which should fail
        const { status: readStatus3, record: privateRecordReturned } = await delegateDwn.records.read({
          from   : aliceDid.uri,
          filter : {
            recordId: privateRecord.id
          }
        });
        expect(readStatus3.code).toBe(401);
        expect(privateRecordReturned).toBeUndefined();

        // sanity: query as alice to get both records
        const { status: readStatus4, record: privateRecordReturnedAlice } = await dwnAlice.records.read({
          from   : aliceDid.uri,
          filter : {
            recordId: privateRecord.id
          }
        });
        expect(readStatus4.code).toBe(200);
        expect(privateRecordReturnedAlice).toBeDefined();
        expect(privateRecordReturnedAlice.id).toBe(privateRecord.id);
      });

      it('should query records as the delegate DID if no grant is found', async () => {
        // alice installs some other module
        const { status: aliceConfigStatus, module: aliceOtherModule } = await dwnAlice.modules.configure({ definition: {
          ...notesModule,
          module: `http://other-module.xyz/module/${TestDataGenerator.randomString(15)}`
        } });
        expect(aliceConfigStatus.code).toBe(202);
        const { status: aliceOtherModuleSend } = await publishModule(
          testHarness.agent, aliceOtherModule, aliceDid.uri, aliceDid.uri
        );
        expect(aliceOtherModuleSend.code).toBe(202);

        // alice writes a note record to the permissioned module
        const { status: writeStatus1, record: allowedRecord } = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : notesModule.module,
          modulePath : 'note',
          schema     : notesModule.types.note.schema,
          dataFormat : 'text/plain',
        });
        expect(writeStatus1.code).toBe(202);
        expect(allowedRecord).toBeDefined();
        await publishRecord(testHarness.agent, allowedRecord, aliceDid.uri, aliceDid.uri);

        // alice writes a public and private note to the other module
        const { status: writeStatus2, record: publicRecord } = await dwnAlice.records.write({
          data       : 'Hello, world!',
          published  : true,
          module     : aliceOtherModule.definition.module,
          modulePath : 'note',
          schema     : aliceOtherModule.definition.types.note.schema,
          dataFormat : 'text/plain',
        });
        expect(writeStatus2.code).toBe(202);
        expect(publicRecord).toBeDefined();
        await publishRecord(testHarness.agent, publicRecord, aliceDid.uri, aliceDid.uri);

        const { status: writeStatus3, record: privateRecord } = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : aliceOtherModule.definition.module,
          modulePath : 'note',
          schema     : aliceOtherModule.definition.types.note.schema,
          dataFormat : 'text/plain',
        });
        expect(writeStatus3.code).toBe(202);
        expect(privateRecord).toBeDefined();
        await publishRecord(testHarness.agent, privateRecord, aliceDid.uri, aliceDid.uri);


        // sanity: delegateDwn queries for the allowed record from alice's DWN
        const { status: queryStatus1, records: allowedRecords } = await delegateDwn.records.query({
          from   : aliceDid.uri,
          filter : {
            module: notesModule.module
          }
        });
        expect(queryStatus1.code).toBe(200);
        expect(allowedRecords).toBeDefined();
        expect(allowedRecords).toHaveLength(1);

        // delegateDwn queries for the other module, which no permissions exist
        // only the public record is returned
        const { status: queryStatus2, records: publicRecords } = await delegateDwn.records.query({
          from   : aliceDid.uri,
          filter : {
            module: aliceOtherModule.definition.module
          }
        });
        expect(queryStatus2.code).toBe(200);
        expect(publicRecords).toBeDefined();
        expect(publicRecords).toHaveLength(1);
        expect(publicRecords[0].id).toBe(publicRecord.id);

        // sanity: query as alice to get both records
        const { status: queryStatus3, records: allRecords } = await dwnAlice.records.query({
          from   : aliceDid.uri,
          filter : {
            module: aliceOtherModule.definition.module
          }
        });
        expect(queryStatus3.code).toBe(200);
        expect(allRecords).toBeDefined();
        expect(allRecords).toHaveLength(2);
        expect(allRecords.map(r => r.id)).toEqual(expect.arrayContaining([publicRecord.id, privateRecord.id]));

        // Operations that need an authoritative owner view can reject the
        // missing grant instead of silently using the delegate-visible subset.
        await expect(delegateDwn.queryRecordsWithRequiredGrant({
          from   : aliceDid.uri,
          filter : {
            module: aliceOtherModule.definition.module,
          },
        })).rejects.toBeInstanceOf(PermissionGrantNotFoundError);
      });

    });

    describe('modules', () => {
      it('should configure a module with a delegated grant', async () => {
        const moduleUri = `http://module-configure.xyz/module/${TestDataGenerator.randomString(15)}`;

        // attempt to configure the module without a grant, it should fail
        try {
          await delegateDwn.modules.configure({
            definition: {
              ...notesModule,
              module: moduleUri,
            }
          });
          throw new Error('Expected an error to be thrown.');
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(PermissionGrantNotFoundError);
          expect((error as Error).message).toBe(
            `AgentPermissionsApi: No matching permission grant found for ModulesConfigure: ${moduleUri}`
          );
        }

        // Create an explicit lower-level grant for this test. Connect must
        // not mint Modules.Configure grants, but the DWN permission layer
        // still supports them when issued directly.
        const permissionsApi = new AgentPermissionsApi({ agent: testHarness.agent });
        const { message } = await permissionsApi.createGrant({
          author      : aliceDid.uri,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
          delegated   : true,
          grantedTo   : delegateDid.uri,
          scope       : {
            interface : DwnInterfaceName.Modules,
            method    : DwnMethodName.Configure,
            module    : moduleUri
          },
          store: true,
        });
        const grants = [message];

        await processConnectedGrants({
          grants, connectedDid : aliceDid.uri, delegateDid  : delegateDid.uri,
          agent        : delegateHarness.agent as EnboxUserAgent,
        });

        // now try again after processing the connected grant
        const { status, module } = await delegateDwn.modules.configure({
          definition: {
            ...notesModule,
            module: moduleUri,
          }
        });
        expect(status.code).toBe(202);
        expect(module).toBeDefined();
        expect(module.definition.module).toBe(moduleUri);
      });

      it('should query for a module with a permission grant', async () => {
        // configure a non public module
        const nonPublicModule = {
          ...notesModule,
          module    : `http://non-public-module.xyz/module/${TestDataGenerator.randomString(15)}`,
          published : false
        };

        const { status: nonPublicStatus, module: nonPublicModuleResponse } = await dwnAlice.modules.configure({
          definition: nonPublicModule
        });
        expect(nonPublicStatus.code).toBe(202);
        expect(nonPublicModuleResponse).toBeDefined();
        const nonPublicModuleSend = await publishModule(
          testHarness.agent, nonPublicModuleResponse, aliceDid.uri, aliceDid.uri
        );
        expect(nonPublicModuleSend.status.code).toBe(202);

        // attempt to query the module, should not return any results as there are no grants for it
        const { status: nonPublicQueryStatus, modules: nonPublicModules } = await delegateDwn.modules.query({
          from   : aliceDid.uri,
          filter : {
            module: nonPublicModule.module
          }
        });
        expect(nonPublicQueryStatus.code).toBe(200);
        expect(nonPublicModules).toBeDefined();
        expect(nonPublicModules).toHaveLength(0);

        // grant the delegate DID access to query the non-public module
        const delegatedBearerDid = await delegateHarness.agent.did.get({ didUri: delegateDid.uri });
        const grants = await createPermissionGrants(aliceDid.uri, delegatedBearerDid.uri, testHarness.agent, [{
          interface : DwnInterfaceName.Modules,
          method    : DwnMethodName.Query,
          module    : nonPublicModule.module
        }]);
        await processConnectedGrants({
          grants, connectedDid : aliceDid.uri, delegateDid  : delegateDid.uri,
          agent        : delegateHarness.agent as EnboxUserAgent,
        });

        // now query for the non-public module, should return the module
        const { status: nonPublicQueryStatus2, modules: nonPublicModules2 } = await delegateDwn.modules.query({
          from   : aliceDid.uri,
          filter : {
            module: nonPublicModule.module
          }
        });
        expect(nonPublicQueryStatus2.code).toBe(200);
        expect(nonPublicModules2).toBeDefined();
        expect(nonPublicModules2).toHaveLength(1);
      });

      it('should query for a module as the delegate DID if no grant is found', async () => {
        // configure a public module without any grants
        const publicModule = {
          ...notesModule,
          module    : `http://public-module.xyz/module/${TestDataGenerator.randomString(15)}`,
          published : true
        };

        const { status: publicStatus, module: publicModuleResponse } = await dwnAlice.modules.configure({
          definition: publicModule
        });
        expect(publicStatus.code).toBe(202);
        expect(publicModuleResponse).toBeDefined();
        const publicModuleSend = await publishModule(
          testHarness.agent, publicModuleResponse, aliceDid.uri, aliceDid.uri
        );
        expect(publicModuleSend.status.code).toBe(202);

        const { status: publicQueryStatus, modules: publicModules } = await delegateDwn.modules.query({
          from   : aliceDid.uri,
          filter : {
            module: publicModule.module
          }
        });
        expect(publicQueryStatus.code).toBe(200);
        expect(publicModules).toBeDefined();
        expect(publicModules).toHaveLength(1);
        expect(publicModules[0].definition.module).toBe(publicModule.module);
      });
    });
  });

  describe('modules.configure()', () => {
    describe('agent', () => {
      it('writes a module definition', async () => {
        const response = await dwnAlice.modules.configure({
          definition: moduleDefinition
        });

        expect(response.status.code).toBe(202);
        expect(response.status.detail).toBe('Accepted');
      });
    });
  });

  describe('modules.query()', () => {
    describe('agent', () => {
      it('should return modules matching the query', async () => {
        // Write a modules configure to the connected agent's DWN.
        const configureResponse = await dwnAlice.modules.configure({
          definition: moduleDefinition
        });
        expect(configureResponse.status.code).toBe(202);
        expect(configureResponse.status.detail).toBe('Accepted');

        // Query for the module just configured.
        const queryResponse = await dwnAlice.modules.query({
          filter: {
            module: moduleDefinition.module
          }
        });

        expect(queryResponse.status.code).toBe(200);
        expect(queryResponse.modules).toHaveLength(1);
        expect(queryResponse.modules[0].definition).toHaveProperty('types');
        expect(queryResponse.modules[0].definition).toHaveProperty('module');
        expect(queryResponse.modules[0].definition.module).toBe(moduleDefinition.module);
        expect(queryResponse.modules[0].definition).toHaveProperty('structure');
      });
    });

    describe('from: did', () => {
      it('should return modules matching the query', async () => {
        // Write a modules configure to the connected agent's DWN.
        const configureResponse = await dwnAlice.modules.configure({
          definition: moduleDefinition
        });
        expect(configureResponse.status.code).toBe(202);
        expect(configureResponse.status.detail).toBe('Accepted');

        // Write the module to the remote DWN.
        await publishModule(testHarness.agent, configureResponse.module, aliceDid.uri, aliceDid.uri);

        // Query for the module just configured.
        const queryResponse = await dwnAlice.modules.query({
          from   : aliceDid.uri,
          filter : {
            module: moduleDefinition.module
          }
        });

        expect(queryResponse.status.code).toBe(200);
        expect(queryResponse.modules).toHaveLength(1);
        expect(queryResponse.modules[0].definition).toHaveProperty('types');
        expect(queryResponse.modules[0].definition).toHaveProperty('module');
        expect(queryResponse.modules[0].definition.module).toBe(moduleDefinition.module);
        expect(queryResponse.modules[0].definition).toHaveProperty('structure');
      });

      it('returns empty modules array when no modules match the filter provided', async () => {
        // Query for a non-existent module.
        const response = await dwnAlice.modules.query({
          from   : aliceDid.uri,
          filter : {
            module: 'https://doesnotexist.com/module'
          }
        });

        expect(response.status.code).toBe(200);
        expect(response.modules).toBeDefined();
        expect(response.modules).toHaveLength(0);
      });

      it('returns published module definitions for requests from external DID', async () => {
        // Configure a published module on Alice's local DWN.
        const publicModule = await dwnAlice.modules.configure({
          definition: { ...moduleDefinition, module: 'http://proto-published', published: true }
        });
        expect(publicModule.status.code).toBe(202);

        // Configure the published module on Alice's remote DWN.
        const sendPublic = await publishModule(
          testHarness.agent, publicModule.module, aliceDid.uri, aliceDid.uri
        );
        expect(sendPublic.status.code).toBe(202);

        // Attempt to query for the published module on Alice's remote DWN authored by Bob.
        const publishedResponse = await dwnBob.modules.query({
          from   : aliceDid.uri,
          filter : {
            module: 'http://proto-published'
          }
        });

        // Verify that one query result is returned.
        expect(publishedResponse.status.code).toBe(200);
        expect(publishedResponse.modules).toHaveLength(1);
        expect(publishedResponse.modules[0].definition.module).toBe('http://proto-published');
      });

      it('does not return unpublished module definitions for requests from external DID', async () => {
        // Configure an unpublished module on Alice's DWN.
        const notPublicModule = await dwnAlice.modules.configure({
          definition: { ...moduleDefinition, module: 'http://proto-not-published', published: false }
        });
        expect(notPublicModule.status.code).toBe(202);

        // Configure the unpublished module on Alice's remote DWN.
        const sendNotPublic = await publishModule(
          testHarness.agent, notPublicModule.module, aliceDid.uri, aliceDid.uri
        );
        expect(sendNotPublic.status.code).toBe(202);

        // Attempt to query for the unpublished module on Alice's remote DWN authored by Bob.
        const nonPublishedResponse = await dwnBob.modules.query({
          from   : aliceDid.uri,
          filter : {
            module: 'http://proto-not-published'
          }
        });

        // Verify that no query results are returned.
        expect(nonPublishedResponse.status.code).toBe(200);
        expect(nonPublishedResponse.modules).toHaveLength(0);
      });

      it('returns a 401 with an invalid permissions grant', async () => {
        // Attempt to query for a record using Bob's DWN tenant with an invalid grant.
        const response = await dwnAlice.modules.query({
          from              : bobDid.uri,
          permissionGrantId : 'bafyreiduimprbncdo2oruvjrvmfmwuyz4xx3d5biegqd2qntlryvuuosem',
          filter            : {
            module: 'https://doesnotexist.com/module'
          }
        });

        expect(response.status.code).toBe(401);
        expect(response.status.detail).toContain('GrantAuthorizationGrantMissing');
        expect(response.modules).toBeDefined();
        expect(response.modules).toHaveLength(0);
      });
    });
  });

  describe('records.write()', () => {
    beforeEach(async() => {
      // Configure the module on both DWNs
      const { status: aliceModuleStatus, module: aliceModule } = await dwnAlice.modules.configure({
        definition: moduleDefinition
      });
      expect(aliceModuleStatus.code).toBe(202);
      expect(aliceModule).toBeDefined();
      const { status: aliceModuleSendStatus } = await publishModule(
        testHarness.agent, aliceModule, aliceDid.uri, aliceDid.uri
      );
      expect(aliceModuleSendStatus.code).toBe(202);
      const { status: bobModuleStatus, module: bobModule } = await dwnBob.modules.configure({ definition: moduleDefinition });
      expect(bobModuleStatus.code).toBe(202);
      expect(bobModule).toBeDefined();
      const { status: bobModuleSendStatus } = await publishModule(
        testHarness.agent, bobModule, bobDid.uri, bobDid.uri
      );
      expect(bobModuleSendStatus.code).toBe(202);

      // Install free-for-all module for tests that write records with arbitrary schema/dataFormat.
      const freeForAllDefinition: DwnModuleDefinition = {
        module    : 'http://free-for-all.xyz',
        published : true,
        types     : { post: {}, other: {} },
        structure : { post: {}, other: {} },
      };
      const { status: aliceFfaStatus, module: aliceFfaModule } = await dwnAlice.modules.configure({ definition: freeForAllDefinition });
      expect(aliceFfaStatus.code).toBe(202);
      const { status: aliceFfaSendStatus } = await publishModule(
        testHarness.agent, aliceFfaModule, aliceDid.uri, aliceDid.uri
      );
      expect(aliceFfaSendStatus.code).toBe(202);
      const { status: bobFfaStatus, module: bobFfaModule } = await dwnBob.modules.configure({ definition: freeForAllDefinition });
      expect(bobFfaStatus.code).toBe(202);
      const { status: bobFfaSendStatus } = await publishModule(
        testHarness.agent, bobFfaModule, bobDid.uri, bobDid.uri
      );
      expect(bobFfaSendStatus.code).toBe(202);
    });

    describe('agent', () => {
      it('creates a record with string data', async () => {
        const dataString = 'Hello, world!Hello, world!';
        const result = await dwnAlice.records.write({
          data       : dataString,
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
        });

        expect(result.status.code).toBe(202);
        expect(result.status.detail).toBe('Accepted');
        expect(result.record).toBeDefined();
        expect(await result.record.data.text()).toBe(dataString);
      });

      it('creates a record with tags', async () => {
        const result = await dwnAlice.records.write({
          data       : 'some data',
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
          tags       : {
            foo   : 'bar',
            count : 2,
            bool  : true
          }
        });

        expect(result.status.code).toBe(202);
        expect(result.status.detail).toBe('Accepted');
        expect(result.record).toBeDefined();
        expect(result.record.tags).toBeDefined();
        expect(result.record.tags).toEqual({
          foo   : 'bar',
          count : 2,
          bool  : true
        });

      });

      it('creates a record with JSON data', async () => {
        const dataJson = { hello: 'world!' };
        const result = await dwnAlice.records.write({
          data       : dataJson,
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
          dataFormat : 'application/json'
        });
        expect(result.status.code).toBe(202);
        expect(result.status.detail).toBe('Accepted');
        expect(result.record).toBeDefined();
        expect(await result.record.data.json()).toEqual(dataJson);
      });

      it('creates a role record for another user that they can use to create role-based records', async () => {
        /**
         * WHAT IS BEING TESTED?
         *
         * We are testing whether role records can be created for outbound participants
         * so they can use them to create records corresponding to the roles they are granted.
         *
         * TEST SETUP STEPS:
         *    1. Configure the photos module on Bob and Alice's remote and local DWNs.
         *    2. Alice creates a role-based 'friend' record for Bob, updates it, then publishes it to her remote DWN.
         *    3. Bob creates an album record using the role 'friend', adds Alice as a `participant`, and publishes both records.
         *    4. Alice admits the album and `participant` records to her local DWN.
         *    5. Alice adds Bob as an `updater` of the album and publishes the record to both remote nodes.
         *       This allows bob to edit photos in the album.
         *    6. Alice creates a photo using her participant role and publishes it to both remote nodes.
         *    7. Bob updates the photo using his updater role and publishes it to both remote nodes.
         */

        // Configure the photos module on Alice and Bob's local and remote DWNs.
        const { status: bobModuleStatus, module: bobModule } = await dwnBob.modules.configure({
          definition: photosModuleDefinition
        });
        expect(bobModuleStatus.code).toBe(202);
        const { status: bobRemoteModuleStatus } = await publishModule(
          testHarness.agent, bobModule, bobDid.uri, bobDid.uri
        );
        expect(bobRemoteModuleStatus.code).toBe(202);

        const { status: aliceModuleStatus, module: aliceModule } = await dwnAlice.modules.configure({
          definition: photosModuleDefinition
        });
        expect(aliceModuleStatus.code).toBe(202);
        const { status: aliceRemoteModuleStatus } = await publishModule(
          testHarness.agent, aliceModule, aliceDid.uri, aliceDid.uri
        );
        expect(aliceRemoteModuleStatus.code).toBe(202);

        // Alice creates a role-based 'friend' record, updates it, then sends it to her remote DWN.
        const { status: friendCreateStatus, record: friendRecord } = await dwnAlice.records.write({
          data       : 'test',
          recipient  : bobDid.uri,
          module     : photosModuleDefinition.module,
          modulePath : 'friend',
          schema     : photosModuleDefinition.types.friend.schema,
          dataFormat : 'text/plain'
        });
        expect(friendCreateStatus.code).toBe(202);
        const updatedFriendRecord = await friendRecord.update({ data: 'update' });
        expect(updatedFriendRecord).toBe(friendRecord);
        expect(await updatedFriendRecord.data.text()).toBe('update');
        await publishRecord(testHarness.agent, updatedFriendRecord, aliceDid.uri, aliceDid.uri);

        // Bob creates an album record using the role 'friend' and sends it to Alice
        const { status: albumCreateStatus, record: albumRecord } = await dwnBob.records.write({
          data       : 'test',
          recipient  : aliceDid.uri,
          module     : photosModuleDefinition.module,
          modulePath : 'album',
          moduleRole : 'friend',
          schema     : photosModuleDefinition.types.album.schema,
          dataFormat : 'text/plain'
        });
        expect(albumCreateStatus.code).toBe(202);
        await publishRecord(testHarness.agent, albumRecord, bobDid.uri, bobDid.uri);
        await publishRecord(testHarness.agent, albumRecord, bobDid.uri, aliceDid.uri);

        // Bob makes Alice a `participant` and sends the record to her and his own remote node.
        const { status: participantCreateStatus, record: participantRecord } = await dwnBob.records.write({
          data            : 'test',
          parentContextId : albumRecord.contextId,
          recipient       : aliceDid.uri,
          module          : photosModuleDefinition.module,
          modulePath      : 'album/participant',
          schema          : photosModuleDefinition.types.participant.schema,
          dataFormat      : 'text/plain'
        });
        expect(participantCreateStatus.code).toBe(202);
        await publishRecord(testHarness.agent, participantRecord, bobDid.uri, bobDid.uri);
        await publishRecord(testHarness.agent, participantRecord, bobDid.uri, aliceDid.uri);

        // Alice fetches the album record as well as the participant record that Bob created and stores it on her local node.
        const aliceAlbumReadResult = await dwnAlice.records.read({
          from   : aliceDid.uri,
          filter : {
            recordId: albumRecord.id
          }
        });
        expect(aliceAlbumReadResult.status.code).toBe(200);
        expect(aliceAlbumReadResult.record).toBeDefined();
        await storeRecordLocally(testHarness.agent, aliceAlbumReadResult.record, aliceDid.uri);

        const aliceParticipantReadResult = await dwnAlice.records.read({
          from   : aliceDid.uri,
          filter : {
            recordId: participantRecord.id
          }
        });
        expect(aliceParticipantReadResult.status.code).toBe(200);
        expect(aliceParticipantReadResult.record).toBeDefined();
        await storeRecordLocally(testHarness.agent, aliceParticipantReadResult.record, aliceDid.uri);

        // Using the participant role, Alice can make Bob an `updater` and send the record to him and her own remote node.
        // Only updater roles can update the photo record after it's been created.
        const { status: updaterCreateStatus, record: updaterRecord } = await dwnAlice.records.write({
          data            : 'test',
          parentContextId : albumRecord.contextId,
          recipient       : bobDid.uri,
          module          : photosModuleDefinition.module,
          modulePath      : 'album/updater',
          moduleRole      : 'album/participant',
          schema          : photosModuleDefinition.types.updater.schema,
          dataFormat      : 'text/plain'
        });
        expect(updaterCreateStatus.code).toBe(202);
        await publishRecord(testHarness.agent, updaterRecord, aliceDid.uri, bobDid.uri);
        await publishRecord(testHarness.agent, updaterRecord, aliceDid.uri, aliceDid.uri);

        // Alice creates a photo using her participant role and sends it to her own DWN and Bob's DWN.
        const { status: photoCreateStatus, record: photoRecord } = await dwnAlice.records.write({
          data            : 'test',
          parentContextId : albumRecord.contextId,
          module          : photosModuleDefinition.module,
          modulePath      : 'album/photo',
          moduleRole      : 'album/participant',
          schema          : photosModuleDefinition.types.photo.schema,
          dataFormat      : 'text/plain'
        });
        expect(photoCreateStatus.code).toBe(202);
        await publishRecord(testHarness.agent, photoRecord, aliceDid.uri, aliceDid.uri);
        await publishRecord(testHarness.agent, photoRecord, aliceDid.uri, bobDid.uri);

        // Bob updates the photo using his updater role and sends it to Alice and his own DWN.
        const { status: photoUpdateStatus, record: photoUpdateRecord } = await dwnBob.records.write({
          data            : 'test again',
          store           : false,
          parentContextId : albumRecord.contextId,
          recordId        : photoRecord.id,
          dateCreated     : photoRecord.dateCreated,
          module          : photosModuleDefinition.module,
          modulePath      : 'album/photo',
          moduleRole      : 'album/updater',
          schema          : photosModuleDefinition.types.photo.schema,
          dataFormat      : 'text/plain'
        });
        expect(photoUpdateStatus.code).toBe(202);
        await publishUnstoredRecord(testHarness.agent, photoUpdateRecord, bobDid.uri, aliceDid.uri);
        await publishUnstoredRecord(testHarness.agent, photoUpdateRecord, bobDid.uri, bobDid.uri);
      });
    });

    describe('agent store: false', () => {
      it('does not persist record to agent DWN', async () => {
        const dataString = 'Hello, world!';
        const createResult = await dwnAlice.records.write({
          store      : false,
          data       : dataString,
          module     : 'http://free-for-all.xyz',
          modulePath : 'post',
          schema     : 'foo/bar',
          dataFormat : 'text/plain'
        });

        expect(createResult.status.code).toBe(202);
        expect(createResult.status.detail).toBe('Accepted');
        expect(createResult.record).toBeDefined();
        expect(await createResult.record.data.text()).toBe(dataString);

        const queryResult = await dwnAlice.records.query({
          filter: {
            schema: 'foo/bar'
          }
        });

        expect(queryResult.status.code).toBe(200);
        expect(queryResult.records).toBeDefined();
        expect(queryResult.records).toHaveLength(0);
      });

      it('has no effect if `store: true`', async () => {
        const dataString = 'Hello, world!';
        const createResult = await dwnAlice.records.write({
          store      : true,
          data       : dataString,
          module     : 'http://free-for-all.xyz',
          modulePath : 'post',
          schema     : 'foo/bar',
          dataFormat : 'text/plain'
        });

        expect(createResult.status.code).toBe(202);
        expect(createResult.status.detail).toBe('Accepted');
        expect(createResult.record).toBeDefined();
        expect(await createResult.record.data.text()).toBe(dataString);

        const queryResult = await dwnAlice.records.query({
          filter: {
            schema: 'foo/bar'
          }
        });

        expect(queryResult.status.code).toBe(200);
        expect(queryResult.records).toBeDefined();
        expect(queryResult.records).toHaveLength(1);
        expect(queryResult.records[0].id).toBe(createResult.record.id);
        expect(await queryResult.records[0].data.text()).toBe(dataString);
      });
    });
  });

  describe('records.delete()', () => {
    beforeEach(async() => {
      // Configure the module on both DWNs
      const { status: aliceModuleStatus, module: aliceModule } = await dwnAlice.modules.configure({
        definition: moduleDefinition
      });
      expect(aliceModuleStatus.code).toBe(202);
      expect(aliceModule).toBeDefined();
      const { status: aliceModuleSendStatus } = await publishModule(
        testHarness.agent, aliceModule, aliceDid.uri, aliceDid.uri
      );
      expect(aliceModuleSendStatus.code).toBe(202);
      const { status: bobModuleStatus, module: bobModule } = await dwnBob.modules.configure({ definition: moduleDefinition });
      expect(bobModuleStatus.code).toBe(202);
      expect(bobModule).toBeDefined();
      const { status: bobModuleSendStatus } = await publishModule(
        testHarness.agent, bobModule, bobDid.uri, bobDid.uri
      );
      expect(bobModuleSendStatus.code).toBe(202);

      // Install free-for-all module for tests that write records with arbitrary schema/dataFormat.
      const freeForAllDefinition: DwnModuleDefinition = {
        module    : 'http://free-for-all.xyz',
        published : true,
        types     : { post: {}, other: {} },
        structure : { post: {}, other: {} },
      };
      const { status: aliceFfaStatus, module: aliceFfaModule } = await dwnAlice.modules.configure({ definition: freeForAllDefinition });
      expect(aliceFfaStatus.code).toBe(202);
      const { status: aliceFfaSendStatus } = await publishModule(
        testHarness.agent, aliceFfaModule, aliceDid.uri, aliceDid.uri
      );
      expect(aliceFfaSendStatus.code).toBe(202);
      const { status: bobFfaStatus, module: bobFfaModule } = await dwnBob.modules.configure({ definition: freeForAllDefinition });
      expect(bobFfaStatus.code).toBe(202);
      const { status: bobFfaSendStatus } = await publishModule(
        testHarness.agent, bobFfaModule, bobDid.uri, bobDid.uri
      );
      expect(bobFfaSendStatus.code).toBe(202);
    });

    describe('agent', () => {
      it('deletes a record', async () => {
        const { status: writeStatus, record } = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
        });

        expect(writeStatus.code).toBe(202);
        expect(record).toBeDefined();

        // Write the record to Alice's remote DWN.
        await publishRecord(testHarness.agent, record, aliceDid.uri, aliceDid.uri);

        const deleteResult = await dwnAlice.records.delete({
          module   : moduleUri,
          recordId : record.id
        });

        expect(deleteResult.status.code).toBe(202);
      });

      it('deletes a record and prunes its children', async () => {
        // Install a module that supports parent-child relationships.
        const { status: moduleStatus, module } = await dwnAlice.modules.configure({
          definition: {
            module    : 'http://example.com/parent-child',
            published : true,
            types     : {
              foo: {
                schema: 'http://example.com/foo',
              },
              bar: {
                schema: 'http://example.com/bar'
              }
            },
            structure: {
              foo: {
                bar: {}
              }
            }
          }
        });
        expect(moduleStatus.code).toBe(202);

        // Write a parent record.
        const { status: parentWriteStatus, record: parentRecord } = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : module.definition.module,
          modulePath : 'foo',
          schema     : 'http://example.com/foo',
          dataFormat : 'text/plain'
        });
        expect(parentWriteStatus.code).toBe(202);
        expect(parentRecord).toBeDefined();

        // Write a child record.
        const { status: childWriteStatus, record: childRecord } = await dwnAlice.records.write({
          data            : 'Hello, world!',
          module          : module.definition.module,
          modulePath      : 'foo/bar',
          schema          : 'http://example.com/bar',
          dataFormat      : 'text/plain',
          parentContextId : parentRecord.contextId
        });
        expect(childWriteStatus.code).toBe(202);
        expect(childRecord).toBeDefined();

        // query for child records to confirm it exists
        const { status: childrenStatus, records: childrenRecords } = await dwnAlice.records.query({
          filter: {
            contextId  : parentRecord.contextId,
            module     : module.definition.module,
            modulePath : 'foo/bar'
          }
        });
        expect(childrenStatus.code).toBe(200);
        expect(childrenRecords).toBeDefined();
        expect(childrenRecords).toHaveLength(1);
        expect(childrenRecords[0].id).toBe(childRecord.id);

        // Delete the parent record and its children.
        const { status: deleteStatus } = await dwnAlice.records.delete({
          recordId : parentRecord.id,
          prune    : true
        });
        expect(deleteStatus.code).toBe(202);

        // query for child records to confirm it was deleted
        const { status: childrenStatusAfterDelete, records: childrenRecordsAfterDelete } = await dwnAlice.records.query({
          filter: {
            contextId  : parentRecord.contextId,
            module     : module.definition.module,
            modulePath : 'foo/bar'
          }
        });
        expect(childrenStatusAfterDelete.code).toBe(200);
        expect(childrenRecordsAfterDelete).toBeDefined();
        expect(childrenRecordsAfterDelete).toHaveLength(0);
      });

      it('returns a 404 when the specified record does not exist', async () => {
        const deleteResult = await dwnAlice.records.delete({
          module   : moduleUri,
          recordId : 'abcd1234'
        });
        expect(deleteResult.status.code).toBe(404);
      });

    });

    describe('from: did', () => {
      it('deletes a record', async () => {
        const { status: writeStatus, record } = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : 'http://free-for-all.xyz',
          modulePath : 'post',
          schema     : 'foo/bar',
          dataFormat : 'text/plain'
        });

        expect(writeStatus.code).toBe(202);
        expect(record).toBeDefined();

        // Write the record to the remote DWN.
        await publishRecord(testHarness.agent, record, aliceDid.uri, aliceDid.uri);

        // Attempt to delete a record from the remote DWN.
        const deleteResult = await dwnAlice.records.delete({
          from     : aliceDid.uri,
          recordId : record.id
        });

        expect(deleteResult.status.code).toBe(202);
        expect(deleteResult.status.detail).toBe('Accepted');
      });

      it('returns a 401 when authentication or authorization fails', async () => {
        // Create a record on Bob's local DWN.
        const writeResult = await dwnBob.records.write({
          data       : 'Hello, world!',
          module     : 'http://free-for-all.xyz',
          modulePath : 'post',
          dataFormat : 'foo'
        });
        expect(writeResult.status.code).toBe(202);

        // Write the record to Bob's remote DWN.
        await publishRecord(testHarness.agent, writeResult.record, bobDid.uri, bobDid.uri);

        // Alice attempts to delete a record from Bob's remote DWN specifying a recordId.
        const deleteResult = await dwnAlice.records.delete({
          from     : bobDid.uri,
          recordId : writeResult.record.id
        });

        /** Confirm that authorization failed because the Alice identity does not have
         * permission to delete a record from Bob's DWN. */
        expect(deleteResult.status.code).toBe(401);
        expect(deleteResult.status.detail).toContain('unauthorized');
      });

      it('deletes records that were authored/signed by another DID', async () => {
        /**
         * WHAT IS BEING TESTED?
         *
         * We are testing whether a record authored/signed by one party (Alice) can be written to
         * another party's DWN (Bob), and that recipient (Bob) is able to delete the record.
         *
         * TEST SETUP STEPS:
         *   1. Configure the email module on Bob's local DWN.
         */
        const { status: bobModuleStatus, module: bobModule } = await dwnBob.modules.configure({
          definition: moduleDefinition,
        });
        expect(bobModuleStatus.code).toBe(202);
        /**
         *   2. Configure the email module on Bob's remote DWN.
         */
        const { status: bobRemoteModuleStatus } = await publishModule(
          testHarness.agent, bobModule, bobDid.uri, bobDid.uri
        );
        expect(bobRemoteModuleStatus.code).toBe(202);
        /**
         *   3. Alice creates a record, but doesn't store it locally.
         */
        const { status: createStatus, record: testRecord } = await dwnAlice.records.write({
          store      : false,
          data       : 'test',
          module     : moduleUri,
          modulePath : 'thread',
          schema     : 'http://email-module.xyz/schema/thread',
          dataFormat : 'text/plain'
        });
        expect(createStatus.code).toBe(202);
        expect(testRecord.author).toBe(aliceDid.uri);
        /**
         *   4. Alice writes the record to Bob's remote DWN.
         */
        await publishUnstoredRecord(testHarness.agent, testRecord, aliceDid.uri, bobDid.uri);
        /**
         *   5. Bob deletes the record from his remote DWN.
         */
        const deleteResult = await dwnBob.records.delete({
          from     : bobDid.uri,
          recordId : testRecord.id
        });
        expect(deleteResult.status.code).toBe(202);
      });
    });
  });

  describe('records.query()', () => {
    beforeEach(async() => {
      // Configure the module on both DWNs
      const { status: aliceModuleStatus, module: aliceModule } = await dwnAlice.modules.configure({
        definition: moduleDefinition
      });
      expect(aliceModuleStatus.code).toBe(202);
      expect(aliceModule).toBeDefined();
      const { status: aliceModuleSendStatus } = await publishModule(
        testHarness.agent, aliceModule, aliceDid.uri, aliceDid.uri
      );
      expect(aliceModuleSendStatus.code).toBe(202);
      const { status: bobModuleStatus, module: bobModule } = await dwnBob.modules.configure({ definition: moduleDefinition });
      expect(bobModuleStatus.code).toBe(202);
      expect(bobModule).toBeDefined();
      const { status: bobModuleSendStatus } = await publishModule(
        testHarness.agent, bobModule, bobDid.uri, bobDid.uri
      );
      expect(bobModuleSendStatus.code).toBe(202);
    });

    describe('agent', () => {
      it('returns an array of records that match the filter provided', async () => {
        const writeResult = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
          dataFormat : 'text/plain'
        });
        expect(writeResult.status.code).toBe(202);
        expect(writeResult.status.detail).toBe('Accepted');
        expect(writeResult.record).toBeDefined();

        const result = await dwnAlice.records.query({
          filter: {
            module     : moduleUri,
            modulePath : 'thread',
            schema     : moduleDefinition.types.thread.schema,
            dataFormat : 'text/plain'
          }
        });

        expect(result.status.code).toBe(200);
        expect(result.records).toBeDefined();
        expect(result.records).toHaveLength(1);
        expect(result.records[0].id).toBe(writeResult.record.id);
      });

      it('returns cursor when there are additional results', async () => {
        for (let i = 0; i < 3; i++ ) {
          const writeResult = await dwnAlice.records.write({
            data       : `Hello, world ${i + 1}!`,
            module     : moduleUri,
            modulePath : 'thread',
            schema     : moduleDefinition.types.thread.schema,
            dataFormat : 'text/plain'
          });

          expect(writeResult.status.code).toBe(202);
          expect(writeResult.status.detail).toBe('Accepted');
          expect(writeResult.record).toBeDefined();
        }

        const results = await dwnAlice.records.query({
          filter: {
            module     : moduleUri,
            modulePath : 'thread',
            schema     : moduleDefinition.types.thread.schema,
            dataFormat : 'text/plain'
          },
          pagination: { limit: 2 } // set a limit of 2
        });

        expect(results.status.code).toBe(200);
        expect(results.records).toBeDefined();
        expect(results.records).toHaveLength(2);
        expect(results.cursor).toBeDefined();

        const additionalResults = await dwnAlice.records.query({
          filter: {
            module     : moduleUri,
            modulePath : 'thread',
            schema     : moduleDefinition.types.thread.schema,
            dataFormat : 'text/plain'
          },
          pagination: { limit: 2, cursor: results.cursor }
        });
        expect(additionalResults.status.code).toBe(200);
        expect(additionalResults.records).toBeDefined();
        expect(additionalResults.records).toHaveLength(1);
        expect(additionalResults.cursor).toBeUndefined();
      });

      it('sorts results based on provided query sort parameter', async () => {
        const clock = sinon.useFakeTimers();

        const items = [];
        const publishedItems = [];
        for (let i = 0; i < 6; i++ ) {
          const writeResult = await dwnAlice.records.write({
            data       : `Hello, world ${i + 1}!`,
            published  : i % 2 == 0 ? true : false,
            module     : moduleUri,
            modulePath : 'thread',
            schema     : moduleDefinition.types.thread.schema,
            dataFormat : 'text/plain'
          });

          expect(writeResult.status.code).toBe(202);
          expect(writeResult.status.detail).toBe('Accepted');
          expect(writeResult.record).toBeDefined();

          items.push(writeResult.record.id); // add id to list in the order it was inserted
          if (writeResult.record.published === true) {
            publishedItems.push(writeResult.record.id); // add published records separately
          }

          clock.tick(1000 * 1); // travel forward one second
        }
        clock.restore();

        // query in ascending order by the dateCreated field
        const createdAscResults = await dwnAlice.records.query({
          filter: {
            module     : moduleUri,
            modulePath : 'thread',
            schema     : moduleDefinition.types.thread.schema,
            dataFormat : 'text/plain'
          },
          dateSort: DwnDateSort.CreatedAscending // same as default
        });
        expect(createdAscResults.status.code).toBe(200);
        expect(createdAscResults.records).toBeDefined();
        expect(createdAscResults.records).toHaveLength(6);
        expect(createdAscResults.records.map(r => r.id)).toEqual(items);

        // query in descending order by the dateCreated field
        const createdDescResults = await dwnAlice.records.query({
          filter: {
            module     : moduleUri,
            modulePath : 'thread',
            schema     : moduleDefinition.types.thread.schema,
            dataFormat : 'text/plain'
          },
          dateSort: DwnDateSort.CreatedDescending
        });
        expect(createdDescResults.status.code).toBe(200);
        expect(createdDescResults.records).toBeDefined();
        expect(createdDescResults.records).toHaveLength(6);
        expect(createdDescResults.records.map(r => r.id)).toEqual([...items].reverse());

        // query in ascending order by the datePublished field, this will only return published records
        const publishedAscResults = await dwnAlice.records.query({
          filter: {
            module     : moduleUri,
            modulePath : 'thread',
            schema     : moduleDefinition.types.thread.schema,
            dataFormat : 'text/plain'
          },
          dateSort: DwnDateSort.PublishedAscending
        });
        expect(publishedAscResults.status.code).toBe(200);
        expect(publishedAscResults.records).toBeDefined();
        expect(publishedAscResults.records).toHaveLength(3);
        expect(publishedAscResults.records.map(r => r.id)).toEqual(publishedItems);

        // query in desscending order by the datePublished field, this will only return published records
        const publishedDescResults = await dwnAlice.records.query({
          filter: {
            module     : moduleUri,
            modulePath : 'thread',
            schema     : moduleDefinition.types.thread.schema,
            dataFormat : 'text/plain'
          },
          dateSort: DwnDateSort.PublishedDescending
        });
        expect(publishedDescResults.status.code).toBe(200);
        expect(publishedDescResults.records).toBeDefined();
        expect(publishedDescResults.records).toHaveLength(3);
        expect(publishedDescResults.records.map(r => r.id)).toEqual([...publishedItems].reverse());
      });

      it('queries for records matching tags', async () => {

        // Write a record to the agent's local DWN that includes a tag `foo` with value `bar`
        const { status, record } = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
          dataFormat : 'text/plain',
          tags       : {
            foo: 'bar',
          }
        });
        expect(status.code).toBe(202);

        // Write a record to the agent's local DWN that includes a tag `foo` with value `baz`
        const { status: status2 } = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
          dataFormat : 'text/plain',
          tags       : {
            foo: 'baz',
          }
        });
        expect(status2.code).toBe(202);

        // Control: query the agent's local DWN for the record without any tag filters
        const result = await dwnAlice.records.query({
          filter: {
            module     : moduleUri,
            modulePath : 'thread',
            schema     : moduleDefinition.types.thread.schema,
            dataFormat : 'text/plain'
          }
        });

        // should return both records
        expect(result.status.code).toBe(200);
        expect(result.records).toBeDefined();
        expect(result.records).toHaveLength(2);


        // Query the agent's local DWN for the record using the tags.
        const fooBarResult = await dwnAlice.records.query({
          filter: {
            module     : moduleUri,
            modulePath : 'thread',
            schema     : moduleDefinition.types.thread.schema,
            dataFormat : 'text/plain',
            tags       : {
              foo: 'bar',
            }
          }
        });

        // should only return the record with the tag `foo` and value `bar`
        expect(fooBarResult.status.code).toBe(200);
        expect(fooBarResult.records).toBeDefined();
        expect(fooBarResult.records).toHaveLength(1);
        expect(fooBarResult.records[0].id).toBe(record.id);
        expect(fooBarResult.records[0].tags).toEqual({ foo: 'bar' });
      });
    });

    describe('from: did', () => {
      it('returns an array of records that match the filter provided', async () => {
        // Write a record to the agent's local DWN.
        const { record } = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
          dataFormat : 'text/plain'
        });

        // Write the record to the agent's remote DWN.
        await publishRecord(testHarness.agent, record, aliceDid.uri, aliceDid.uri);

        // Query the agent's remote DWN.
        const result = await dwnAlice.records.query({
          from   : aliceDid.uri,
          filter : {
            module     : moduleUri,
            modulePath : 'thread',
            schema     : moduleDefinition.types.thread.schema,
            dataFormat : 'text/plain'
          }
        });

        // Verify the query returns a result.
        expect(result.status.code).toBe(200);
        expect(result.records).toBeDefined();
        expect(result.records).toHaveLength(1);
        expect(result.records[0].id).toBe(record.id);
      });

      it('returns empty records array when no records match the filter provided', async () => {
        // Attempt to query Bob's DWN using the ID of a record that does not exist.
        const result = await dwnAlice.records.query({
          from   : bobDid.uri,
          filter : {
            recordId: 'abcd1234'
          }
        });
        // Confirm that the record does not currently exist on Bob's DWN.
        expect(result.status.code).toBe(200);
        expect(result.records).toBeDefined();
        expect(result.records).toHaveLength(0);
      });

      it('returns the correct author for records signed by another DID', async () => {
        /**
         * WHAT IS BEING TESTED?
         *
         * We are testing whether a record authored/signed by one party (Alice) can be written to
         * another party's DWN (Bob) and retain the original author's DID (Alice) when queried.
         *
         * TEST SETUP STEPS:
         *   1. Configure the email module on Bob's local DWN.
         */
        const { status: bobModuleStatus, module: bobModule } = await dwnBob.modules.configure({
          definition: moduleDefinition
        });
        expect(bobModuleStatus.code).toBe(202);
        /**
         *   2. Configure the email module on Bob's remote DWN.
         */
        const { status: bobRemoteModuleStatus } = await publishModule(
          testHarness.agent, bobModule, bobDid.uri, bobDid.uri
        );
        expect(bobRemoteModuleStatus.code).toBe(202);
        /**
         *   3. Alice creates a record, but doesn't store it locally.
         */
        const { status: createStatus, record: testRecord } = await dwnAlice.records.write({
          store      : false,
          data       : 'test',
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
          dataFormat : 'text/plain'
        });
        expect(createStatus.code).toBe(202);
        expect(testRecord.author).toBe(aliceDid.uri);
        /**
         *   4. Alice writes the record to Bob's remote DWN.
         */
        await publishUnstoredRecord(testHarness.agent, testRecord, aliceDid.uri, bobDid.uri);
        /**
         *   5. Bob queries his remote DWN for the record.
         */
        const bobQueryResult = await dwnBob.records.query({
          from   : bobDid.uri,
          filter : {
            recordId: testRecord.id
          }
        });

        // The record's author should be Alice's DID since Alice was the signer.
        const [ recordOnBobsDwn ] = bobQueryResult.records;
        expect(recordOnBobsDwn.author).toBe(aliceDid.uri);
      });

      it('queries for records matching tags', async () => {

        // Write a record to alice's remote DWN that includes a tag `foo` with value `bar`
        const { status, record } = await dwnAlice.records.write({
          store      : false,
          data       : 'Hello, world!',
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
          dataFormat : 'text/plain',
          tags       : {
            foo: 'bar',
          }
        });
        expect(status.code).toBe(202);
        await publishUnstoredRecord(testHarness.agent, record, aliceDid.uri, aliceDid.uri);

        // Write a record to alice's remote DWN that includes a tag `foo` with value `baz`
        const { status: status2, record: record2 } = await dwnAlice.records.write({
          store      : false,
          data       : 'Hello, world!',
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
          dataFormat : 'text/plain',
          tags       : {
            foo: 'baz',
          }
        });
        expect(status2.code).toBe(202);
        await publishUnstoredRecord(testHarness.agent, record2, aliceDid.uri, aliceDid.uri);

        // Control: query the agent's local DWN for the record without any tag filters
        const result = await dwnAlice.records.query({
          from   : aliceDid.uri,
          filter : {
            module     : moduleUri,
            modulePath : 'thread',
            schema     : moduleDefinition.types.thread.schema,
            dataFormat : 'text/plain'
          }
        });

        // should return both records
        expect(result.status.code).toBe(200);
        expect(result.records).toBeDefined();
        expect(result.records).toHaveLength(2);


        // Query the agent's local DWN for the record using the tags.
        const fooBarResult = await dwnAlice.records.query({
          from   : aliceDid.uri,
          filter : {
            module     : moduleUri,
            modulePath : 'thread',
            schema     : moduleDefinition.types.thread.schema,
            dataFormat : 'text/plain',
            tags       : {
              foo: 'bar',
            }
          }
        });

        // should only return the record with the tag `foo` and value `bar`
        expect(fooBarResult.status.code).toBe(200);
        expect(fooBarResult.records).toBeDefined();
        expect(fooBarResult.records).toHaveLength(1);
        expect(fooBarResult.records[0].id).toBe(record.id);
        expect(fooBarResult.records[0].tags).toEqual({ foo: 'bar' });
      });

      it('ensures that a moduleRole used to query is also used to read the data of the resulted records', async () => {
        // scenario: Bob has a module where he can write notes and add friends who can query and read these notes
        // Alice is a friend of Bob and she queries for the notes and reads the data of the notes
        // the moduleRole used to query for the notes should also be used to read the data of the notes

        const module = {
          ...notesModuleDefinition,
          module: 'http://example.com/notes' + TestDataGenerator.randomString(15)
        };

        // Bob configures the notes module for himself
        const { status: bobModuleStatus, module: bobModule } = await dwnBob.modules.configure({
          definition: module
        });
        expect(bobModuleStatus.code).toBe(202);
        const { status: bobRemoteModuleStatus } = await publishModule(
          testHarness.agent, bobModule, bobDid.uri, bobDid.uri
        );
        expect(bobRemoteModuleStatus.code).toBe(202);

        // Bob creates a few notes ensuring that the data is larger than the max encoded size
        // that way the data will be requested with a separate `read` request
        const recordData: Map<string, string> = new Map();
        for (let i = 0; i < 3; i++) {
          const data = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
          const { status: noteCreateStatus, record: noteRecord } = await dwnBob.records.write({
            data,
            module     : module.module,
            modulePath : 'note',
            schema     : module.types.note.schema,
            dataFormat : 'text/plain',
          });
          expect(noteCreateStatus.code).toBe(202);
          await publishRecord(testHarness.agent, noteRecord, bobDid.uri, bobDid.uri);
          recordData.set(noteRecord.id, data);
        }

        // Bob makes Alice a `friend` to allow her to read and comment on his notes
        const { status: friendCreateStatus, record: friendRecord } = await dwnBob.records.write({
          data       : 'friend!',
          recipient  : aliceDid.uri,
          module     : module.module,
          modulePath : 'friend',
          schema     : module.types.friend.schema,
          dataFormat : 'text/plain'
        });
        expect(friendCreateStatus.code).toBe(202);
        await publishRecord(testHarness.agent, friendRecord, bobDid.uri, bobDid.uri);

        // alice uses the role to query for the available notes
        const { status: notesQueryStatus, records: noteRecords } = await dwnAlice.records.query({
          from       : bobDid.uri,
          moduleRole : 'friend',
          filter     : {
            module     : module.module,
            modulePath : 'note'
          }
        });
        expect(notesQueryStatus.code).toBe(200);
        expect(noteRecords).toBeDefined();
        expect(noteRecords).toHaveLength(3);

        // spy on sendDwnRequest to ensure that the moduleRole is used to read the data of the notes
        const sendDwnRequestSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');

        // confirm that it starts with 0 calls
        expect(sendDwnRequestSpy.callCount).toBe(0);
        // Alice attempts to read the data of the notes, which should succeed
        for (const record of noteRecords) {
          const readResult = await record.data.text();
          const expectedData = recordData.get(record.id);
          expect(readResult).toBe(expectedData);
        }

        // confirm that it was called 3 times
        expect(sendDwnRequestSpy.callCount).toBe(3);

        // confirm that the moduleRole was used to read the data of the notes
        expect(sendDwnRequestSpy.getCalls().every(call =>
          call.args[0].messageType === DwnInterface.RecordsRead &&
          (call.args[0] as ProcessDwnRequest<DwnInterface.RecordsRead>).messageParams.moduleRole === 'friend'
        )).toBe(true);
      });
    });
  });

  describe('records.read()', () => {
    beforeEach(async() => {
      // Configure the module on both DWNs
      const { status: aliceModuleStatus, module: aliceModule } = await dwnAlice.modules.configure({
        definition: moduleDefinition
      });
      expect(aliceModuleStatus.code).toBe(202);
      expect(aliceModule).toBeDefined();
      const { status: aliceModuleSendStatus } = await publishModule(
        testHarness.agent, aliceModule, aliceDid.uri, aliceDid.uri
      );
      expect(aliceModuleSendStatus.code).toBe(202);
      const { status: bobModuleStatus, module: bobModule } = await dwnBob.modules.configure({ definition: moduleDefinition });
      expect(bobModuleStatus.code).toBe(202);
      expect(bobModule).toBeDefined();
      const { status: bobModuleSendStatus } = await publishModule(
        testHarness.agent, bobModule, bobDid.uri, bobDid.uri
      );
      expect(bobModuleSendStatus.code).toBe(202);
    });

    describe('agent', () => {
      it('returns a record', async () => {
        const writeResult = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
          dataFormat : 'text/plain'
        });

        expect(writeResult.status.code).toBe(202);
        expect(writeResult.status.detail).toBe('Accepted');
        expect(writeResult.record).toBeDefined();

        const result = await dwnAlice.records.read({
          filter: {
            recordId: writeResult.record.id
          }
        });

        expect(result.status.code).toBe(200);
        expect(result.record.id).toBe(writeResult.record.id);
      });

      it('returns a 404 when a record cannot be found', async () => {
        const writeResult = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
          dataFormat : 'text/plain'
        });

        expect(writeResult.status.code).toBe(202);
        expect(writeResult.status.detail).toBe('Accepted');
        expect(writeResult.record).toBeDefined();


        // Delete the record
        await writeResult.record.delete();

        const result = await dwnAlice.records.read({
          filter: {
            recordId: writeResult.record.id
          }
        });

        expect(result.status.code).toBe(404);
        expect(result.record).toBeUndefined();
      });
    });

    describe('from: did', () => {
      it('returns a record', async () => {
        // Write a record to the agent's local DWN.
        const writeResult = await dwnAlice.records.write({
          data       : 'Hello, world!',
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
          dataFormat : 'text/plain'
        });

        expect(writeResult.status.code).toBe(202);
        expect(writeResult.status.detail).toBe('Accepted');
        expect(writeResult.record).toBeDefined();

        // Write the record to the agent's remote DWN.
        await publishRecord(testHarness.agent, writeResult.record, aliceDid.uri, aliceDid.uri);

        // Attempt to read the record from the agent's remote DWN.
        const result = await dwnAlice.records.read({
          from   : aliceDid.uri,
          filter : {
            recordId: writeResult.record.id
          }
        });

        expect(result.status.code).toBe(200);
        expect(result.record.id).toBe(writeResult.record.id);
      });

      it('returns undefined record when requested record does not exit', async () => {
        // Attempt to read a record from Bob's DWN using the ID of a record that only exists in the connected agent's DWN.
        const result = await dwnAlice.records.read({
          from   : bobDid.uri,
          filter : {
            recordId: 'non-existent-id'
          }
        });

        // Confirm that the record does not currently exist on Bob's DWN.
        expect(result.status.code).toBe(404);
        expect(result.record).toBeUndefined();
      });

      it('returns the correct author for records signed by another DID', async () => {
        /**
         * WHAT IS BEING TESTED?
         *
         * We are testing whether a record authored/signed by one party (Alice) can be written to
         * another party's DWN (Bob) and retain the original author's DID (Alice) when read.
         *
         * TEST SETUP STEPS:
         *   1. Configure the email module on Bob's local DWN.
         */
        const { status: bobModuleStatus, module: bobModule } = await dwnBob.modules.configure({
          definition: moduleDefinition,
        });
        expect(bobModuleStatus.code).toBe(202);
        /**
         *   2. Configure the email module on Bob's remote DWN.
         */
        const { status: bobRemoteModuleStatus } = await publishModule(
          testHarness.agent, bobModule, bobDid.uri, bobDid.uri
        );
        expect(bobRemoteModuleStatus.code).toBe(202);
        /**
         *   3. Alice creates a record, but doesn't store it locally.
         */
        const { status: createStatus, record: testRecord } = await dwnAlice.records.write({
          store      : false,
          data       : 'test',
          module     : moduleUri,
          modulePath : 'thread',
          schema     : moduleDefinition.types.thread.schema,
          dataFormat : 'text/plain'
        });
        expect(createStatus.code).toBe(202);
        expect(testRecord.author).toBe(aliceDid.uri);
        /**
         *   4. Alice writes the record to Bob's remote DWN.
         */
        await publishUnstoredRecord(testHarness.agent, testRecord, aliceDid.uri, bobDid.uri);
        /**
         *   5. Bob queries his remote DWN for the record.
         */
        const bobQueryResult = await dwnBob.records.read({
          from   : bobDid.uri,
          filter : {
            recordId: testRecord.id
          }
        });

        // The record's author should be Alice's DID since Alice was the signer.
        const recordOnBobsDwn = bobQueryResult.record;
        expect(recordOnBobsDwn.author).toBe(aliceDid.uri);
      });
    });
  });
});
