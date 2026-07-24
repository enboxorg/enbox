import type { BearerDid, PortableDid } from '@enbox/dids';
import type { DwnMessage, DwnMessageParams, DwnProtocolDefinition, DwnPublicKeyJwk, DwnSigner, ProcessDwnRequest } from '@enbox/agent';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { utils as didUtils } from '@enbox/dids';
import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { Stream } from '@enbox/common';

import {
  createPermissionGrants, DwnConstant, DwnContentEncryptionAlgorithm, DwnDateSort, DwnInterface, DwnKeyAgreementAlgorithm,
  DwnKeyDerivationScheme, dwnMessageConstructors, EnboxUserAgent, getRecordAuthor, getRecordProtocolRole,
  isDwnMessage,
} from '@enbox/agent';
import { DwnErrorCode, Jws, Message, Poller, Time } from '@enbox/dwn-sdk-js';
import { processConnectedGrants, WalletConnect } from '@enbox/auth';

import emailProtocolDefinition from './fixtures/protocol-definitions/email.json' with { type: 'json' };
import notesProtocolDefinition from './fixtures/protocol-definitions/notes.json' with { type: 'json' };

import { dataToBlob } from '../src/utils.js';
import { DwnApi } from '../src/dwn-api.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { Enbox } from '../src/enbox.js';
import { Record } from '../src/record.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';

const testDwnUrls: string[] = [testDwnUrl];

describe('Record', () => {
  let dataText: string;
  let dataBlob: Blob;
  let dataFormat: string;
  let aliceDid: BearerDid;
  let bobDid: BearerDid;
  let dwnAlice: DwnApi;
  let dwnBob: DwnApi;
  let testHarness: PlatformAgentTestHarness;
  let protocolDefinition: DwnProtocolDefinition;

  let consoleWarn;

  function rehydrateExternalDeletedRecordForAlice(deletedRecord: Record): Record {
    if (!deletedRecord.deleted || deletedRecord.initialWrite === undefined) {
      throw new Error('Test fixture requires a deleted record with its initial write.');
    }

    return new Record(testHarness.agent, {
      author       : deletedRecord.author,
      connectedDid : aliceDid.uri,
      dataAccess   : {
        author : aliceDid.uri,
        remote : true,
        target : aliceDid.uri,
      },
      initialWrite: deletedRecord.initialWrite,
      ...deletedRecord.rawMessage,
    });
  }

  beforeAll(async () => {
    // Suppress console.warn output due to default password warnings
    consoleWarn = console.warn;
    console.warn = (): void => {};

    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : EnboxUserAgent,
      agentStores : 'memory'
    });

    dataText = TestDataGenerator.randomString(100);
    ({ dataBlob, dataFormat } = dataToBlob(dataText));

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

    protocolDefinition = {
      ...emailProtocolDefinition,
      protocol  : `http://email-protocol.xyz/protocol/${TestDataGenerator.randomString(15)}`,
      published : true
    };

    // Configure the protocol on both DWNs
    const { status: aliceProtocolStatus, protocol: aliceProtocol } = await dwnAlice.protocols.configure({
      definition: protocolDefinition
    });
    expect(aliceProtocolStatus.code).toBe(202);
    expect(aliceProtocol).toBeDefined();
    const { status: aliceProtocolSendStatus } = await aliceProtocol.send(aliceDid.uri);
    expect(aliceProtocolSendStatus.code).toBe(202);

    const { status: bobProtocolStatus, protocol: bobProtocol } = await dwnBob.protocols.configure({ definition: protocolDefinition });
    expect(bobProtocolStatus.code).toBe(202);
    expect(bobProtocol).toBeDefined();
    const { status: bobProtocolSendStatus } = await bobProtocol.send(bobDid.uri);
    expect(bobProtocolSendStatus.code).toBe(202);

    // Install free-for-all protocol for tests that write records without a specific protocol.
    const freeForAllDefinition: DwnProtocolDefinition = {
      protocol  : 'http://free-for-all.xyz',
      published : true,
      types     : { post: {}, other: {} },
      structure : { post: {}, other: {} },
    };
    const { status: aliceFfaStatus, protocol: aliceFfaProtocol } = await dwnAlice.protocols.configure({ definition: freeForAllDefinition });
    expect(aliceFfaStatus.code).toBe(202);
    const { status: aliceFfaSendStatus } = await aliceFfaProtocol.send(aliceDid.uri);
    expect(aliceFfaSendStatus.code).toBe(202);
    const { status: bobFfaStatus, protocol: bobFfaProtocol } = await dwnBob.protocols.configure({ definition: freeForAllDefinition });
    expect(bobFfaStatus.code).toBe(202);
    const { status: bobFfaSendStatus } = await bobFfaProtocol.send(bobDid.uri);
    expect(bobFfaSendStatus.code).toBe(202);
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();

    // Restore console.warn output
    console.warn = consoleWarn;
  });

  describe('as delegateDid', () => {
    let delegateHarness: PlatformAgentTestHarness;
    let delegateDid: PortableDid;
    let delegateDwn: DwnApi;
    let notesProtocol: DwnProtocolDefinition;

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

      notesProtocol = {
        published : true,
        protocol  : `http://notes-protocol.xyz/protocol/${TestDataGenerator.randomString(15)}`,
        types     : {
          note: {
            schema      : 'https://notes-protocol.xyz/schema/note',
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

      const grantRequest = WalletConnect.createPermissionRequestForProtocol({
        definition  : notesProtocol,
        permissions : ['write', 'read', 'delete']
      });

      // alice and bob both configure the protocol
      const { status: aliceConfigStatus, protocol: aliceNotesProtocol } = await dwnAlice.protocols.configure({
        definition: notesProtocol
      });
      expect(aliceConfigStatus.code).toBe(202);
      const { status: aliceNotesProtocolSend } = await aliceNotesProtocol.send(aliceDid.uri);
      expect(aliceNotesProtocolSend.code).toBe(202);

      const { status: bobConfigStatus, protocol: bobNotesProtocol } = await dwnBob.protocols.configure({ definition: notesProtocol });
      expect(bobConfigStatus.code).toBe(202);
      const { status: bobNotesProtocolSend } = await bobNotesProtocol!.send(bobDid.uri);
      expect(bobNotesProtocolSend.code).toBe(202);

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
      const connectedProtocols = await processConnectedGrants({
        grants, connectedDid: aliceDid.uri, delegateDid: delegateDid.uri, agent: delegateHarness.agent as EnboxUserAgent,
      });

      // Register sync for Alice's DID and pull the protocol configuration.
      await (delegateHarness.agent as EnboxUserAgent).sync.registerIdentity({
        did     : aliceDid.uri,
        options : {
          delegateDid : delegateDid.uri,
          protocols   : connectedProtocols,
        }
      });
      await (delegateHarness.agent as EnboxUserAgent).sync.sync('pull');

      // Construct the Enbox instance directly with delegate support.
      const enbox = new Enbox({ agent: delegateHarness.agent, connectedDid: aliceDid.uri, delegateDid: delegateDid.uri });
      delegateDwn = (enbox as any)._dwn;
    });

    it('should update a record with a delegated grant', async () => {
      const { status, record } = await delegateDwn.records.write({
        data         : 'Hello, world!',
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema,
        dataFormat   : 'text/plain',
      });

      const dataCidBeforeDataUpdate = record!.dataCid;

      expect(status.code).toBe(202);
      expect(record).toBeDefined();

      // attempt to update the record with the delegated grant
      const updatedRecord = await record!.update({ data: 'Delegate Updated' });
      expect(updatedRecord).toBe(record);

      // attempt to read the record with the delegated grant
      const readResult = await delegateDwn.records.read({
        filter: {
          protocol : notesProtocol.protocol,
          recordId : record!.id
        }
      });

      expect(readResult.status.code).toBe(200);
      expect(readResult.record).toBeDefined();

      expect(readResult.record.dataCid).not.toBe(dataCidBeforeDataUpdate);
      expect(readResult.record.dataCid).toBe(updatedRecord.dataCid);

      // validate update signature is from the delegateDid but author is alice
      const updateSignature = Jws.getSignerDid(readResult.record.rawMessage.authorization.signature.signatures[0]);
      expect(updateSignature).toBe(delegateDid.uri);
      expect(readResult.record.author).toBe(aliceDid.uri);

      const updatedData = await updatedRecord.data.text();
      expect(updatedData).toBe('Delegate Updated');
    });

    it('should delete a record with a delegated grant', async () => {
      // alice writes a record
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema,
        dataFormat   : 'text/plain',
      });

      expect(status.code).toBe(202);
      expect(record).toBeDefined();

      // alice sends the record to her remote
      await record!.send();

      // alice device queries alice remote for the record
      const aliceDeviceRemoteQuery = await delegateDwn.records.query({
        from   : aliceDid.uri,
        filter : {
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
        }
      });

      expect(aliceDeviceRemoteQuery.status.code).toBe(200);
      expect(aliceDeviceRemoteQuery.records).toHaveLength(1);
      const aliceRecord = aliceDeviceRemoteQuery.records[0];

      // attempt to delete the record with the delegated grant
      await aliceRecord.delete();
      const deletedRecord = aliceRecord;
      expect(deletedRecord.deleted).toBe(true);

      // send the delete to the remote DWN
      await deletedRecord.send();

      // expect the delete to be signed by the delegateDid
      const deleteSignature = Jws.getSignerDid(deletedRecord.rawMessage.authorization.signature.signatures[0]);
      expect(deleteSignature).toBe(delegateDid.uri);

      // attempt to read the record with the delegated grant
      const readResult = await delegateDwn.records.read({
        filter: {
          protocol : notesProtocol.protocol,
          recordId : record!.id
        }
      });

      expect(readResult.status.code).toBe(404);
      expect(readResult.record).toBeUndefined();

      // attempt to query the record from the remote
      const queryResult = await delegateDwn.records.query({
        from   : aliceDid.uri,
        filter : {
          protocol : notesProtocol.protocol,
          recordId : record!.id
        }
      });

      expect(queryResult.status.code).toBe(200);
      expect(queryResult.records).toHaveLength(0);

      // attempting to delete again is beaten by the standing tombstone: 409 Conflict
      try {
        await deletedRecord.delete();
        throw new Error('Expected the standing tombstone to reject the second delete.');
      } catch (error) {
        expect(error).toBeInstanceOf(DwnResponseError);
        expect((error as DwnResponseError).status.code).toBe(409);
      }
    });

    it('should import a record with a delegated grant', async () => {
      // bob writes a note with alice as the recipient
      const { status: bobWriteStatus, record: bobRecord } = await dwnBob.records.write({
        data         : 'Hello, Alice!',
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema,
        dataFormat   : 'text/plain',
        recipient    : aliceDid.uri
      });
      expect(bobWriteStatus.code).toBe(202);

      // bob sends it to his remote DWN
      await bobRecord!.send();

      // confirm that alice delegate does not have it stored locally
      let aliceDeviceLocal = await delegateDwn.records.query({
        filter: {
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
        }
      });
      expect(aliceDeviceLocal.status.code).toBe(200);
      expect(aliceDeviceLocal.records).toHaveLength(0);

      // alice delegate is able to query for the note
      const { records: aliceQueryFromBobRecords, status: aliceQueryFromBobStatus } = await delegateDwn.records.query({
        from   : bobDid.uri,
        filter : {
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
        }
      });
      expect(aliceQueryFromBobStatus.code).toBe(200);
      expect(aliceQueryFromBobRecords).toBeDefined();
      expect(aliceQueryFromBobRecords).toHaveLength(1);

      const recordFromBob = aliceQueryFromBobRecords[0];
      // alice delegate imports the note
      await recordFromBob.import();

      // confirm the note is stored locally
      aliceDeviceLocal = await delegateDwn.records.query({
        filter: {
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
        }
      });
      expect(aliceDeviceLocal.status.code).toBe(200);
      expect(aliceDeviceLocal.records).toHaveLength(1);
      expect(aliceDeviceLocal.records[0].id).toBe(recordFromBob.id);
    });

    it('should store a record with a delegated grant', async () => {
      // alice writes a note
      const { status: aliceWritesStatus, record: aliceRecord } = await dwnAlice.records.write({
        data         : 'Hello, From Alice!',
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema,
        dataFormat   : 'text/plain',
      });
      expect(aliceWritesStatus.code).toBe(202);

      // alice sends it to her remote DWN
      await aliceRecord!.send();

      // sanity: alice delegate does not have the note stored locally
      let aliceDelegateResults = await delegateDwn.records.query({
        filter: {
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
        }
      });
      expect(aliceDelegateResults.status.code).toBe(200);
      expect(aliceDelegateResults.records).toHaveLength(0);

      // alice delegate is able to query for the note
      const { records: aliceQueryFromBobRecords, status: aliceQueryFromBobStatus } = await delegateDwn.records.query({
        from   : aliceDid.uri,
        filter : {
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
        }
      });
      expect(aliceQueryFromBobStatus.code).toBe(200);
      expect(aliceQueryFromBobRecords).toBeDefined();
      expect(aliceQueryFromBobRecords).toHaveLength(1);

      const recordFromBob = aliceQueryFromBobRecords[0];

      // alicedevice stores the note locally
      await recordFromBob.store();

      // confirm the note is stored locally
      aliceDelegateResults = await delegateDwn.records.query({
        filter: {
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
        }
      });
      expect(aliceDelegateResults.status.code).toBe(200);
      expect(aliceDelegateResults.records).toHaveLength(1);
    });

    it('should read large data payloads as a stream with a delegated grant', async () => {
      const largeDataJson = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
      const largeDataBytes = new TextEncoder().encode(JSON.stringify(largeDataJson));

      // Write the large record to agent-connected DWN.
      const { record: _record, status } = await delegateDwn.records.write({
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema,
        dataFormat   : 'application/json',
        data         : largeDataJson
      });
      expect(status.code).toBe(202);

      // query for the record that was just created. queries don't come with the data stream so .stream() will be invoked
      const { records: queryRecords, status: queryRecordStatus } = await delegateDwn.records.query({
        filter: {
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
        }
      });
      expect(queryRecordStatus.code).toBe(200);
      expect(queryRecords).toHaveLength(1);
      const queriedRecord = queryRecords[0];

      // Read the data stream JSON
      const dataJson = await queriedRecord.data.json();
      expect(dataJson).toEqual(largeDataJson);

      // Read the data stream Bytes
      const dataBytes = await queriedRecord.data.bytes();
      expect(dataBytes).toEqual(largeDataBytes);
    });

    it('should read large data payloads as a stream with from a public record without an explicit grant', async () => {
      // install some other protocol that the delegated did does not have a grant for
      // alice installs some other protocol
      const { status: aliceConfigStatus, protocol: aliceOtherProtocol } = await dwnAlice.protocols.configure({ definition: {
        ...notesProtocol,
        protocol: `http://other-protocol.xyz/protocol/${TestDataGenerator.randomString(15)}`
      } });
      expect(aliceConfigStatus.code).toBe(202);
      const { status: aliceOtherProtocolSend } = await aliceOtherProtocol.send(aliceDid.uri);
      expect(aliceOtherProtocolSend.code).toBe(202);

      // alice writes a private and public note with a large data payload
      const largeDataJson1 = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);

      const { status: aliceWritesStatus, record: aliceRecord } = await dwnAlice.records.write({
        data         : largeDataJson1,
        protocol     : aliceOtherProtocol.definition.protocol,
        protocolPath : 'note',
        schema       : aliceOtherProtocol.definition.types.note.schema,
        dataFormat   : 'application/json',
      });
      expect(aliceWritesStatus.code).toBe(202);
      await aliceRecord!.send();

      const largeDataJson2 = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
      const publicRecordDataBytes = new TextEncoder().encode(JSON.stringify(largeDataJson2));

      const { status: aliceWritesStatus2, record: alicePublicRecord } = await dwnAlice.records.write({
        data         : largeDataJson2,
        published    : true,
        protocol     : aliceOtherProtocol.definition.protocol,
        protocolPath : 'note',
        schema       : aliceOtherProtocol.definition.types.note.schema,
        dataFormat   : 'application/json',
      });
      expect(aliceWritesStatus2.code).toBe(202);
      await alicePublicRecord!.send();

      // the delegate attempts to read the public note
      const { records: publicRecords, status: publicStatus } = await delegateDwn.records.query({
        from   : aliceDid.uri,
        filter : {
          protocol     : aliceOtherProtocol.definition.protocol,
          protocolPath : 'note',
        }
      });
      expect(publicStatus.code).toBe(200);
      expect(publicRecords).toHaveLength(1);
      const publicRecord = publicRecords[0];
      expect(publicRecord.author).toBe(aliceDid.uri);
      const publicDataBytes = await publicRecord.data.bytes();
      expect(publicDataBytes).toEqual(publicRecordDataBytes);

      // sanity, this won't happen in real-world, but testing the results if a read is attempted on an unaauthed record
      const privateRecordOptions = {
        author       : getRecordAuthor(aliceRecord!.rawMessage),
        connectedDid : aliceDid.uri,
        dataAccess   : {
          author : delegateDid.uri,
          remote : true,
          target : aliceDid.uri,
        },
        delegateDid: delegateDid.uri,
        ...aliceRecord!.rawMessage,
      };

      const record = new Record(delegateHarness.agent, privateRecordOptions);
      try {
        await record.data.bytes();
        throw new Error('Expected unauthorized data read to fail.');
      } catch (error:any) {
        expect(error.message).toContain('Record: Unable to read stored data:');
      }
    });
  });

  it('imports a record that another user wrote', async () => {
    // Alice creates a new large record and stores it on her own dwn
    const { status: aliceThreadStatus, record: aliceThreadRecord } = await dwnAlice.records.write({
      data         : TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000),
      recipient    : bobDid.uri,
      protocol     : protocolDefinition.protocol,
      protocolPath : 'thread',
      schema       : 'http://email-protocol.xyz/schema/thread',
    });
    expect(aliceThreadStatus.code).toBe(202);
    await aliceThreadRecord!.send(aliceDid.uri);

    // Bob queries for the record on his own DWN (should not find it)
    let bobQueryBobDwn = await dwnBob.records.query({
      from   : bobDid.uri,
      filter : {
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
      }
    });
    expect(bobQueryBobDwn.status.code).toBe(200);
    expect(bobQueryBobDwn.records).toHaveLength(0); // no results

    // Bob queries for the record that was just created on Alice's remote DWN.
    let bobQueryAliceDwn = await dwnBob.records.query({
      from   : aliceDid.uri,
      filter : {
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
      }
    });
    expect(bobQueryAliceDwn.status.code).toBe(200);
    expect(bobQueryAliceDwn.records).toHaveLength(1);

    // Bob imports the record.
    const importRecord = bobQueryAliceDwn.records[0];
    await importRecord.import();

    // Bob sends the record to his remote DWN.
    await importRecord!.send();

    // Bob queries for the record on his own DWN (should now return it)
    bobQueryBobDwn = await dwnBob.records.query({
      from   : bobDid.uri,
      filter : {
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
      }
    });
    expect(bobQueryBobDwn.status.code).toBe(200);
    expect(bobQueryBobDwn.records).toHaveLength(1);
    expect(bobQueryBobDwn.records[0].id).toBe(importRecord.id);

    // Alice updates her record
    const aliceThreadUpdated1 = await aliceThreadRecord.update({
      data: TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000)
    });
    expect(aliceThreadUpdated1).toBe(aliceThreadRecord);
    await aliceThreadUpdated1.send();

    await aliceThreadUpdated1.send(bobDid.uri);

    // Alice updates her record and sends it to her own DWN again
    const updatedText = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
    const aliceThreadUpdated2 = await aliceThreadUpdated1.update({
      data: updatedText
    });
    expect(aliceThreadUpdated2).toBe(aliceThreadUpdated1);
    await aliceThreadUpdated2.send();

    // Bob queries for the updated record on alice's DWN
    bobQueryAliceDwn = await dwnBob.records.query({
      from   : aliceDid.uri,
      filter : {
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
      }
    });
    expect(bobQueryAliceDwn.status.code).toBe(200);
    expect(bobQueryAliceDwn.records).toHaveLength(1);
    const updatedRecord = bobQueryAliceDwn.records[0];

    // Bob stores the record on his own DWN.
    await updatedRecord.store();
    expect(await updatedRecord.data.text()).toBe(updatedText);

    // sends the record to his own DWN
    await updatedRecord.send();

    // Bob queries for the updated record on his own DWN.
    bobQueryBobDwn = await dwnBob.records.query({
      from   : bobDid.uri,
      filter : {
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
      }
    });
    expect(bobQueryBobDwn.status.code).toBe(200);
    expect(bobQueryBobDwn.records).toHaveLength(1);
    expect(bobQueryBobDwn.records[0].id).toBe(importRecord.id);
    expect(await bobQueryBobDwn.records[0].data.text()).toBe(updatedText);
  });

  it('should retain all defined properties', async () => {
    const encryptionVm = aliceDid.document.verificationMethod?.find(
      vm => didUtils.extractDidFragment(vm.id) === 'enc'
    );
    const encryptionPublicKeyJwk = encryptionVm!.publicKeyJwk;
    const encryptionKeyId = encryptionVm!.id;

    const aliceSigner = await aliceDid.getSigner();

    // RecordsWriteMessage properties that can be pre-defined
    const attestationSigners: DwnSigner[] = [{
      algorithm : aliceSigner.algorithm,
      keyId     : aliceSigner.keyId,
      sign      : async (data: Uint8Array): Promise<Uint8Array> => {
        return await aliceSigner.sign({ data });
      }
    }];

    const authorizationSigner: DwnSigner = {
      algorithm : aliceSigner.algorithm,
      keyId     : aliceSigner.keyId,
      sign      : async (data: Uint8Array): Promise<Uint8Array> => {
        return await aliceSigner.sign({ data });
      }
    };

    const encryptionInput: DwnMessageParams[DwnInterface.RecordsWrite]['encryptionInput'] = {
      algorithm            : DwnContentEncryptionAlgorithm.A256CTR,
      initializationVector : TestDataGenerator.randomBytes(16),
      key                  : TestDataGenerator.randomBytes(32),
      keyEncryptionInputs  : [{
        algorithm        : DwnKeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        derivationScheme : DwnKeyDerivationScheme.ProtocolPath,
        keyId            : encryptionKeyId,
        publicKey        : encryptionPublicKeyJwk as DwnPublicKeyJwk,
      }]
    };

    // RecordsWriteDescriptor properties that can be pre-defined
    const protocol = protocolDefinition.protocol;
    const protocolPath = 'thread';
    const schema = protocolDefinition.types.thread.schema;
    const recipient = aliceDid.uri;
    const published = true;

    const RecordsWrite = dwnMessageConstructors[DwnInterface.RecordsWrite];

    // Create a parent record to reference in the RecordsWriteMessage used for validation
    const parentRecordsWrite = await RecordsWrite.create({
      data   : new Uint8Array(await dataBlob.arrayBuffer()),
      dataFormat,
      protocol,
      protocolPath,
      schema,
      signer : authorizationSigner,
    });

    // Create a RecordsWriteMessage
    const recordsWrite = await RecordsWrite.create({
      attestationSigners,
      data            : new Uint8Array(await dataBlob.arrayBuffer()),
      dataFormat,
      encryptionInput,
      parentContextId : parentRecordsWrite.message.contextId,
      protocol,
      protocolPath,
      published,
      recipient,
      schema,
      signer          : authorizationSigner,
    });

    // Create record using test RecordsWriteMessage.
    const record = new Record(testHarness.agent, {
      ...recordsWrite.message,
      storedData   : dataBlob,
      author       : aliceDid.uri,
      connectedDid : aliceDid.uri,
      dataAccess   : { author: aliceDid.uri, remote: false, target: aliceDid.uri },
    });

    // Retained Record properties
    expect(record.author).toBe(aliceDid.uri);

    // Retained RecordsWriteMessage top-level properties
    expect(record.contextId).toBe(recordsWrite.message.contextId);
    expect(record.id).toBe(recordsWrite.message.recordId);
    expect(record.encryption).toBeDefined();
    expect(record.encryption).toEqual(recordsWrite.message.encryption);
    expect(record.encryption!.keyEncryption.find(r => r.derivationScheme === DwnKeyDerivationScheme.ProtocolPath)).toBeDefined();
    expect(record.attestation).toBeDefined();
    expect(record.attestation).toHaveProperty('signatures');

    // Retained RecordsWriteDescriptor properties
    expect(record.protocol).toBe(protocol);
    expect(record.protocolPath).toBe(protocolPath);
    expect(record.recipient).toBe(recipient);
    expect(record.schema).toBe(schema);
    expect(record.parentId).toBe(parentRecordsWrite.message.recordId);
    expect(record.dataCid).toBe(recordsWrite.message.descriptor.dataCid);
    expect(record.dataSize).toBe(recordsWrite.message.descriptor.dataSize);
    expect(record.dateCreated).toBe(recordsWrite.message.descriptor.dateCreated);
    expect(record.timestamp).toBe(recordsWrite.message.descriptor.messageTimestamp);
    expect(record.published).toBe(published);
    expect(record.datePublished).toBe(recordsWrite.message.descriptor.datePublished);
    expect(record.dataFormat).toBe(dataFormat);
  });

  describe('data', () => {
    let dataText500Bytes: string;
    let dataTextExceedingMaxSize: string;

    beforeAll(async () => {
      dataText500Bytes = TestDataGenerator.randomString(500);
      dataTextExceedingMaxSize = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
    });

    describe('data.blob()', () => {
      it('returns small data payloads after dwn.records.write()', async () => {
        // Generate data that is less than the encoded data limit to ensure that the data will not have to be fetched
        // with a RecordsRead when record.data.blob() is executed.
        const dataJson = TestDataGenerator.randomJson(500);
        const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

        // Write the 500B record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataJson,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });

        expect(status.code).toBe(202);

        // Confirm that the size, in bytes, of the data read as a Blob matches the original input data.
        const readDataBlob = await record!.data.blob();
        expect(readDataBlob.size).toBe(inputDataBytes.length);

        // Convert the Blob into an array and ensure it matches the input data byte for byte.
        const readDataBytes = new Uint8Array(await readDataBlob.arrayBuffer());
        expect(readDataBytes).toEqual(inputDataBytes);
      });

      it('returns small data payloads after dwn.records.read()', async () => {
        // Generate data that is less than the encoded data limit to ensure that the data will not have to be fetched
        // with a RecordsRead when record.data.blob() is executed.
        const dataJson = TestDataGenerator.randomJson(500);
        const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

        // Write the 500B record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataJson,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });

        expect(status.code).toBe(202);

        // Read the record that was just created.
        const { record: readRecord, status: readRecordStatus } = await dwnAlice.records.read({ filter: { recordId: record!.id } });

        expect(readRecordStatus.code).toBe(200);

        // Confirm that the size, in bytes, of the data read as a Blob matches the original input data.
        const readDataBlob = await readRecord.data.blob();
        expect(readDataBlob.size).toBe(inputDataBytes.length);

        // Convert the Blob into an array and ensure it matches the input data byte for byte.
        const readDataBytes = new Uint8Array(await readDataBlob.arrayBuffer());
        expect(readDataBytes).toEqual(inputDataBytes);
      });

      it('returns large data payloads after dwn.records.write()', async () => {
        // Generate data that exceeds the DWN encoded data limit to ensure that the data will have to be fetched
        // with a RecordsRead when record.data.blob() is executed.
        const dataJson = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
        const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

        // Write the large record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataJson,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });

        expect(status.code).toBe(202);

        // Confirm that the size, in bytes, of the data read as a Blob matches the original input data.
        const readDataBlob = await record!.data.blob();
        expect(readDataBlob.size).toBe(inputDataBytes.length);

        // Convert the Blob into an array and ensure it matches the input data byte for byte.
        const readDataBytes = new Uint8Array(await readDataBlob.arrayBuffer());
        expect(readDataBytes).toEqual(inputDataBytes);
      });

      it('returns large data payloads after local dwn.records.query()', async () => {
        /** Generate data that exceeds the DWN encoded data limit to ensure that the data will have to
         * be fetched with a RecordsRead when record.data.blob() is executed. */
        const dataJson = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
        const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

        // Write the large record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataJson,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });
        expect(status.code).toBe(202);

        // Query for the record that was just created.
        const { records: queryRecords, status: queryRecordStatus } = await dwnAlice.records.query({
          filter: { recordId: record!.id }
        });
        expect(queryRecordStatus.code).toBe(200);

        // Confirm that the size, in bytes, of the data read as a Blob matches the original input data.
        const [ queryRecord ] = queryRecords;
        const queriedDataBlob = await queryRecord.data.blob();
        expect(queriedDataBlob.size).toBe(inputDataBytes.length);

        // Convert the Blob into an array and ensure it matches the input data, byte for byte.
        const queriedDataBytes = new Uint8Array(await queriedDataBlob.arrayBuffer());
        expect(queriedDataBytes).toEqual(inputDataBytes);
      });

      it('returns large data payloads after local dwn.records.read()', async () => {
        // Generate data that exceeds the DWN encoded data limit to ensure that the data will have to be fetched
        // with a RecordsRead when record.data.blob() is executed.
        const dataJson = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
        const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

        // Write the large record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataJson,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });

        expect(status.code).toBe(202);

        // Read the record that was just created.
        const { record: readRecord, status: readRecordStatus } = await dwnAlice.records.read({
          filter: { recordId: record!.id }
        });

        expect(readRecordStatus.code).toBe(200);

        // Confirm that the size, in bytes, of the data read as a Blob matches the original input data.
        const readDataBlob = await readRecord.data.blob();
        expect(readDataBlob.size).toBe(inputDataBytes.length);

        // Convert the Blob into an array and ensure it matches the input data byte for byte.
        const readDataBytes = new Uint8Array(await readDataBlob.arrayBuffer());
        expect(readDataBytes).toEqual(inputDataBytes);
      });
    });

    describe('data.json()', () => {
      it('returns small data payloads after dwn.records.write()', async () => {
        // Generate data that is less than the encoded data limit to ensure that the data will not have to be fetched
        // with a RecordsRead when record.data.json() is executed.
        const dataJson = TestDataGenerator.randomJson(500);
        const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

        // Write the 500B record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataJson,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });

        expect(status.code).toBe(202);

        // Confirm that the size, in bytes, of the data read as JSON matches the original input data.
        const readDataJson = await record!.data.json();
        const readDataBytes = new TextEncoder().encode(JSON.stringify(readDataJson));
        expect(readDataBytes).toHaveLength(inputDataBytes.length);

        // Ensure the JSON returned matches the input data, byte for byte.
        expect(readDataBytes).toEqual(inputDataBytes);
      });

      it('returns small data payloads after dwnAlice.records.read()', async () => {
      // Generate data that is less than the encoded data limit to ensure that the data will not have to be fetched
      // with a RecordsRead when record.data.json() is executed.
        const dataJson = TestDataGenerator.randomJson(500);
        const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

        // Write the 500B record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataJson,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });

        expect(status.code).toBe(202);

        // Read the record that was just created.
        const { record: readRecord, status: readRecordStatus } = await dwnAlice.records.read({ filter: { recordId: record!.id } });

        expect(readRecordStatus.code).toBe(200);

        // Confirm that the size, in bytes, of the data read as JSON matches the original input data.
        const readDataJson = await readRecord!.data.json();
        const readDataBytes = new TextEncoder().encode(JSON.stringify(readDataJson));
        expect(readDataBytes).toHaveLength(inputDataBytes.length);

        // Ensure the JSON returned matches the input data, byte for byte.
        expect(readDataBytes).toEqual(inputDataBytes);
      });

      it('returns large data payloads after dwn.records.write()', async () => {
        // Generate data that exceeds the DWN encoded data limit to ensure that the data will have to be fetched
        // with a RecordsRead when record.data.json() is executed.
        const dataJson = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
        const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

        // Write the large record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataJson,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });

        expect(status.code).toBe(202);

        // Confirm that the size, in bytes, of the data read as JSON matches the original input data.
        const readDataJson = await record!.data.json();
        const readDataBytes = new TextEncoder().encode(JSON.stringify(readDataJson));
        expect(readDataBytes).toHaveLength(inputDataBytes.length);

        // Ensure the JSON returned matches the input data, byte for byte.
        expect(readDataBytes).toEqual(inputDataBytes);
      });

      it('returns large data payloads after local dwn.records.query()', async () => {
        /** Generate data that exceeds the DWN encoded data limit to ensure that the data will have to
         * be fetched with a RecordsRead when record.data.json() is executed. */
        const dataJson = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
        const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

        // Write the large record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataJson,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });
        expect(status.code).toBe(202);

        // Query for the record that was just created.
        const { records: queryRecords, status: queryRecordStatus } = await dwnAlice.records.query({
          filter: { recordId: record!.id }
        });
        expect(queryRecordStatus.code).toBe(200);

        // Confirm that the size, in bytes, of the data read as JSON matches the original input data.
        const [ queryRecord ] = queryRecords;
        const queriedDataBlob = await queryRecord!.data.json();

        // Convert the JSON to bytes and ensure it matches the input data, byte for byte.
        const queriedDataBytes = new TextEncoder().encode(JSON.stringify(queriedDataBlob));
        expect(queriedDataBytes).toHaveLength(inputDataBytes.length);
        expect(queriedDataBytes).toEqual(inputDataBytes);
      });

      it('returns large data payloads after local dwn.records.read()', async () => {
        // Generate data that exceeds the DWN encoded data limit to ensure that the data will have to be fetched
        // with a RecordsRead when record.data.json() is executed.
        const dataJson = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
        const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

        // Write the large record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataJson,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });

        expect(status.code).toBe(202);

        // Read the record that was just created.
        const { record: readRecord, status: readRecordStatus } = await dwnAlice.records.read({
          filter: { recordId: record!.id }
        });

        expect(readRecordStatus.code).toBe(200);

        // Confirm that the size, in bytes, of the data read as JSON matches the original input data.
        const readDataJson = await readRecord!.data.json();
        const readDataBytes = new TextEncoder().encode(JSON.stringify(readDataJson));
        expect(readDataBytes).toHaveLength(inputDataBytes.length);

        // Ensure the JSON returned matches the input data, byte for byte.
        expect(readDataBytes).toEqual(inputDataBytes);
      });
    });

    describe('data.stream()', () => {
      it('returns small data payloads after dwnAlice.records.write()', async () => {
        // Use a data payload that is less than the encoded data limit to ensure that the data will
        // not have to be fetched with a RecordsRead when record.data.text() is executed.
        const inputDataBytes = new TextEncoder().encode(dataText500Bytes);

        // Write the 500B record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataText500Bytes,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });
        expect(status.code).toBe(202);

        // Confirm that the length of the data read as text matches the original input data.
        const dataStream = await record!.data.stream();
        const dataStreamBytes = await Stream.consumeToBytes({ readableStream: dataStream });
        expect(dataStreamBytes).toHaveLength(dataText500Bytes.length);

        // Ensure the text returned matches the input data, byte for byte.
        expect(dataStreamBytes).toEqual(inputDataBytes);
      });

      it('returns small data payloads after dwn.records.read()', async () => {
        // Use a data payload that is less than the encoded data limit to ensure that the data will
        // not have to be fetched with a RecordsRead when record.data.text() is executed.
        const inputDataBytes = new TextEncoder().encode(dataText500Bytes);

        // Write the 500B record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataText500Bytes,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });
        expect(status.code).toBe(202);

        // Read the record that was just created.
        const { record: readRecord, status: readRecordStatus } = await dwnAlice.records.read({ filter: { recordId: record!.id } });
        expect(readRecordStatus.code).toBe(200);

        // Confirm that the length of the data read as text matches the original input data.
        const dataStream = await readRecord!.data.stream();
        const dataStreamBytes = await Stream.consumeToBytes({ readableStream: dataStream });
        expect(dataStreamBytes).toHaveLength(dataText500Bytes.length);

        // Ensure the text returned matches the input data, byte for byte.
        expect(dataStreamBytes).toEqual(inputDataBytes);
      });

      it('returns large data payloads after dwn.records.write()', async () => {
        // Use a data payload that exceeds the DWN encoded data limit to ensure that the data will
        // have to be fetched with a RecordsRead when record.data.text() is executed.
        const inputDataBytes = new TextEncoder().encode(dataTextExceedingMaxSize);

        // Write the large record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataTextExceedingMaxSize,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });
        expect(status.code).toBe(202);

        // Confirm that the length of the data read as text matches the original input data.
        const dataStream = await record!.data.stream();
        const dataStreamBytes = await Stream.consumeToBytes({ readableStream: dataStream });
        expect(dataStreamBytes).toHaveLength(dataTextExceedingMaxSize.length);

        // Ensure the text returned matches the input data, byte for byte.
        expect(dataStreamBytes).toEqual(inputDataBytes);
      });

      it('returns large data payloads after local dwn.records.query()', async () => {
        // Use a data payload that exceeds the DWN encoded data limit to ensure that the data will
        // have to be fetched with a RecordsRead when record.data.text() is executed.
        const inputDataBytes = new TextEncoder().encode(dataTextExceedingMaxSize);

        // Write the large record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataTextExceedingMaxSize,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });
        expect(status.code).toBe(202);

        // Query for the record that was just created.
        const { records: queryRecords, status: queryRecordStatus } = await dwnAlice.records.query({
          filter: { recordId: record!.id }
        });
        expect(queryRecordStatus.code).toBe(200);

        // Confirm that the length of the data read as text matches the original input data.
        const [ queryRecord ] = queryRecords;
        const dataStream = await queryRecord!.data.stream();
        const dataStreamBytes = await Stream.consumeToBytes({ readableStream: dataStream });
        expect(dataStreamBytes).toHaveLength(dataTextExceedingMaxSize.length);

        // Ensure the text returned matches the input data, byte for byte.
        expect(dataStreamBytes).toEqual(inputDataBytes);
      });

      it('returns large data payloads after local dwn.records.read()', async () => {
        // Use a data payload that exceeds the DWN encoded data limit to ensure that the data will
        // have to be fetched with a RecordsRead when record.data.text() is executed.
        const inputDataBytes = new TextEncoder().encode(dataTextExceedingMaxSize);

        // Write the large record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataTextExceedingMaxSize,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });

        expect(status.code).toBe(202);

        // Read the record that was just created.
        const { record: readRecord, status: readRecordStatus } = await dwnAlice.records.read({
          filter: { recordId: record!.id }
        });
        expect(readRecordStatus.code).toBe(200);

        // Confirm that the length of the data read as text matches the original input data.
        const dataStream = await readRecord!.data.stream();
        const dataStreamBytes = await Stream.consumeToBytes({ readableStream: dataStream });
        expect(dataStreamBytes).toHaveLength(dataTextExceedingMaxSize.length);

        // Ensure the text returned matches the input data, byte for byte.
        expect(dataStreamBytes).toEqual(inputDataBytes);
      });
    });

    describe('data.text()', () => {
      it('returns small data payloads after dwnAlice.records.write()', async () => {
        // Generate data that is less than the encoded data limit to ensure that the data will not have to be fetched
        // with a RecordsRead when record.data.text() is executed.
        const dataText = TestDataGenerator.randomString(500);

        // Write the 500B record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataText,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });

        expect(status.code).toBe(202);

        // Confirm that the length of the data read as text matches the original input data.
        const readDataText = await record!.data.text();
        expect(readDataText).toHaveLength(dataText.length);

        // Ensure the text returned matches the input data, char for char.
        expect(readDataText).toEqual(dataText);
      });

      it('returns small data payloads after dwn.records.read()', async () => {
        // Generate data that is less than the encoded data limit to ensure that the data will not have to be fetched
        // with a RecordsRead when record.data.text() is executed.
        const dataText = TestDataGenerator.randomString(500);

        // Write the 500B record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataText,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });

        expect(status.code).toBe(202);

        // Read the record that was just created.
        const { record: readRecord, status: readRecordStatus } = await dwnAlice.records.read({ filter: { recordId: record!.id } });

        expect(readRecordStatus.code).toBe(200);

        // Confirm that the length of the data read as text matches the original input data.
        const readDataText = await readRecord!.data.text();
        expect(readDataText).toHaveLength(dataText.length);

        // Ensure the text returned matches the input data, char for char.
        expect(readDataText).toEqual(dataText);
      });

      it('returns large data payloads after dwnAlice.records.write()', async () => {
        // Generate data that exceeds the DWN encoded data limit to ensure that the data will have to be fetched
        // with a RecordsRead when record.data.text() is executed.
        const dataText = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);

        // Write the large record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataText,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });

        expect(status.code).toBe(202);

        // Confirm that the length of the data read as text matches the original input data.
        const readDataText = await record!.data.text();
        expect(readDataText).toHaveLength(dataText.length);

        // Ensure the text returned matches the input data, char for char.
        expect(readDataText).toEqual(dataText);
      });

      it('returns large data payloads after local dwn.records.query()', async () => {
        /** Generate data that exceeds the DWN encoded data limit to ensure that the data will have to
         * be fetched with a RecordsRead when record.data.blob() is executed. */
        const dataText = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);

        // Write the large record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataText,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });
        expect(status.code).toBe(202);

        // Query for the record that was just created.
        const { records: queryRecords, status: queryRecordStatus } = await dwnAlice.records.query({
          filter: { recordId: record!.id }
        });
        expect(queryRecordStatus.code).toBe(200);

        // Confirm that the length of the data read as text matches the original input data.
        const [ queryRecord ] = queryRecords;
        const queriedDataText = await queryRecord!.data.text();
        expect(queriedDataText).toHaveLength(dataText.length);

        // Ensure the text returned matches the input data, char for char.
        expect(queriedDataText).toEqual(dataText);
      });

      it('returns large data payloads after local dwn.records.read()', async () => {
        // Generate data that exceeds the DWN encoded data limit to ensure that the data will have to be fetched
        // with a RecordsRead when record.data.text() is executed.
        const dataText = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);

        // Write the large record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataText,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });

        expect(status.code).toBe(202);

        // Read the record that was just created.
        const { record: readRecord, status: readRecordStatus } = await dwnAlice.records.read({
          filter: { recordId: record!.id }
        });

        expect(readRecordStatus.code).toBe(200);

        // Confirm that the length of the data read as text matches the original input data.
        const readDataText = await readRecord!.data.text();
        expect(readDataText).toHaveLength(dataText.length);

        // Ensure the text returned matches the input data, char for char.
        expect(readDataText).toEqual(dataText);
      });
    });

    describe('data.then()', () => {
      it('returns small data payloads after dwnAlice.records.write()', async () => {
        // Use a data payload that is less than the encoded data limit to ensure that the data will
        // not have to be fetched with a RecordsRead when record.data.text() is executed.
        const inputDataBytes = new TextEncoder().encode(dataText500Bytes);

        // Write the 500B record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataText500Bytes,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });
        expect(status.code).toBe(202);

        // Confirm that the length of the data read as text matches the original input data.
        const dataStream = await record.data.then(stream => stream);
        const dataStreamBytes = await Stream.consumeToBytes({ readableStream: dataStream });
        expect(dataStreamBytes).toHaveLength(dataText500Bytes.length);

        // Ensure the text returned matches the input data, byte for byte.
        expect(dataStreamBytes).toEqual(inputDataBytes);
      });

      it('returns large data payloads after dwnAlice.records.write()', async () => {
        // Generate data that exceeds the DWN encoded data limit to ensure that the data will have to be fetched
        // with a RecordsRead when record.data.text() is executed.
        const dataText = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);

        // Write the large record to agent-connected DWN.
        const { record, status } = await dwnAlice.records.write({
          data         : dataText,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
        });

        expect(status.code).toBe(202);

        // Confirm that the length of the data read as text matches the original input data.
        const dataStream = await record.data.then(stream => stream);
        const readDataText = await Stream.consumeToText({ readableStream: dataStream });
        expect(readDataText).toHaveLength(dataText.length);

        // Ensure the text returned matches the input data, char for char.
        expect(readDataText).toEqual(dataText);
      });
    });

    it('returns large data payloads after remote dwn.records.query()', async () => {
      /** Generate data that exceeds the DWN encoded data limit to ensure that the data will have to
       * be fetched with a RecordsRead when record.data.* is executed. */
      const dataJson = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
      const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

      // Create a large record but do NOT store it on the local, agent-connected DWN.
      const { record, status } = await dwnAlice.records.write({
        store        : false,
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Write the large record to a remote DWN.
      await record!.send(aliceDid.uri);

      // Query for the record that was just created on the remote DWN.
      const { records: queryRecords, status: queryRecordStatus } = await dwnAlice.records.query({
        from   : aliceDid.uri,
        filter : { recordId: record!.id }
      });
      expect(queryRecordStatus.code).toBe(200);

      // Confirm that the size, in bytes, of the data read as a Blob matches the original input data.
      const [ queryRecord ] = queryRecords;
      const queriedDataBlob = await queryRecord.data.blob();
      expect(queriedDataBlob.size).toBe(inputDataBytes.length);
    });

    it('returns large data payloads after remote dwn.records.read()', async () => {
      /** Generate data that exceeds the DWN encoded data limit to ensure that the data will have to
       * be fetched with a RecordsRead when record.data.* is executed. */
      const dataJson = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
      const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

      // Create a large record but do NOT store it on the local, agent-connected DWN.
      const { record, status } = await dwnAlice.records.write({
        store        : false,
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Write the large record to a remote DWN.
      await record!.send(aliceDid.uri);

      // Read the record that was just created on the remote DWN.
      const { record: readRecord, status: readRecordStatus } = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : { recordId: record!.id }
      });
      expect(readRecordStatus.code).toBe(200);

      // Confirm that the size, in bytes, of the data read as a Blob matches the original input data.
      const readDataBlob = await readRecord.data.blob();
      expect(readDataBlob.size).toBe(inputDataBytes.length);

      // Convert the Blob into an array and ensure it matches the input data byte for byte.
      const readDataBytes = new Uint8Array(await readDataBlob.arrayBuffer());
      expect(readDataBytes).toEqual(inputDataBytes);
    });

    it('returns small data payloads repeatedly after dwn.records.write()', async () => {
      /** Generate data that exceeds the DWN encoded data limit to ensure that the data will have to
       * be fetched with a RecordsRead when record.data.* is executed. */
      const dataJson = TestDataGenerator.randomJson(100_000);
      const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

      // Write the 500B record to agent-connected DWN.
      const { record, status } = await dwnAlice.records.write({
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Read the data payload as bytes.
      let readDataBytes = await record!.data.bytes();
      // Ensure the JSON returned matches the input data, byte for byte.
      expect(inputDataBytes).toEqual(readDataBytes);

      // Read the data payload a second time.
      readDataBytes = await record!.data.bytes();
      // Ensure the JSON returned matches the input data, byte for byte.
      expect(inputDataBytes).toEqual(readDataBytes);

      // Read the data payload a third time.
      readDataBytes = await record!.data.bytes();
      // Ensure the JSON returned matches the input data, byte for byte.
      expect(inputDataBytes).toEqual(readDataBytes);
    });

    it('returns large data payloads repeatedly after dwn.records.write()', async () => {
      /** Generate data that exceeds the DWN encoded data limit to ensure that the data will have to
       * be fetched with a RecordsRead when record.data.* is executed. */
      const dataJson = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 25000);
      const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

      // Write the large record to agent-connected DWN.
      const { record, status } = await dwnAlice.records.write({
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Confirm that the size, in bytes, of the data read as JSON matches the original input data.
      let readDataJson = await record!.data.json();
      let readDataBytes = new TextEncoder().encode(JSON.stringify(readDataJson));
      expect(readDataBytes).toHaveLength(inputDataBytes.length);

      // Ensure the JSON returned matches the input data, byte for byte.
      expect(readDataBytes).toEqual(inputDataBytes);

      // Attempt to read the record again.
      readDataJson = await record!.data.json();
      readDataBytes = new TextEncoder().encode(JSON.stringify(readDataJson));
      expect(readDataBytes).toHaveLength(inputDataBytes.length);

      // Ensure the JSON returned matches the input data, byte for byte.
      expect(readDataBytes).toEqual(inputDataBytes);

      // Attempt to read the record again.
      readDataJson = await record!.data.json();
      readDataBytes = new TextEncoder().encode(JSON.stringify(readDataJson));
      expect(readDataBytes).toHaveLength(inputDataBytes.length);

      // Ensure the JSON returned matches the input data, byte for byte.
      expect(readDataBytes).toEqual(inputDataBytes);
    });

    it('allows small data payloads written locally to be consumed as a stream repeatedly', async () => {
      /** Generate data that is less than the encoded data limit to ensure that the data will not
       * have to be fetched with a RecordsRead when record.data.blob() is executed. */
      const dataJson = TestDataGenerator.randomJson(1000);
      const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

      // Write the large record to agent-connected DWN.
      const { record, status } = await dwnAlice.records.write({
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Consume the data stream as bytes.
      let readDataStream = await record!.data.stream();
      let readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);

      // Consume the data stream as bytes a second time.
      readDataStream = await record!.data.stream();
      readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);
    });

    it('allows large data payloads written locally to be consumed as a stream repeatedly', async () => {
      /** Generate data that exceeds the DWN encoded data limit to ensure that the data will have to
       * be fetched with a RecordsRead when record.data.* is executed. */
      const dataJson = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
      const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

      // Write the large record to agent-connected DWN.
      const { record, status } = await dwnAlice.records.write({
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Consume the data stream as bytes.
      let readDataStream = await record!.data.stream();
      let readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);

      // Consume the data stream as bytes a second time.
      readDataStream = await record!.data.stream();
      readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);
    });

    it('allows small data payloads read from a remote to be consumed as a stream repeatedly', async () => {
      /** Generate data that is less than the encoded data limit to ensure that the data will not
       * have to be fetched with a RecordsRead when record.data.blob() is executed. */
      const dataJson = TestDataGenerator.randomJson(1000);
      const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

      // Create a large record but do NOT store it on the local, agent-connected DWN.
      const { record, status } = await dwnAlice.records.write({
        store        : false,
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Write the large record to a remote DWN.
      await record!.send(aliceDid.uri);

      // Read the record that was just created on the remote DWN.
      const { record: readRecord, status: readRecordStatus } = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : { recordId: record!.id }
      });
      expect(readRecordStatus.code).toBe(200);

      // Confirm that the size, in bytes, of the data read as a Blob matches the original input data.
      const readDataBlob = await readRecord.data.blob();
      expect(readDataBlob.size).toBe(inputDataBytes.length);

      // Confirm that the size, in bytes, of the data read as JSON matches the original input data.
      let readDataStream = await readRecord!.data.stream();
      let readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);

      // Consume the data stream as bytes a third time.
      readDataStream = await readRecord!.data.stream();
      readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);
    });

    it('allows large data payloads read from a remote to be consumed as a stream repeatedly', async () => {
      /** Generate data that exceeds the DWN encoded data limit to ensure that the data will have to
       * be fetched with a RecordsRead when record.data.* is executed. */
      const dataJson = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
      const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

      // Create a large record but do NOT store it on the local, agent-connected DWN.
      const { record, status } = await dwnAlice.records.write({
        store        : false,
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Write the large record to a remote DWN.
      await record!.send(aliceDid.uri);

      // Read the record that was just created on the remote DWN.
      const { record: readRecord, status: readRecordStatus } = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : { recordId: record!.id }
      });
      expect(readRecordStatus.code).toBe(200);

      // Consume the data stream as bytes.
      let readDataStream = await readRecord!.data.stream();
      let readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);

      // Consume the data stream as bytes a second time.
      readDataStream = await record!.data.stream();
      readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);

      // Consume the data stream as bytes a third time.
      readDataStream = await record!.data.stream();
      readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);
    });

    it('allows small data payloads queried from a remote to be consumed as a stream repeatedly', async () => {
      /** Generate data that is less than the encoded data limit to ensure that the data will not
       * have to be fetched with a RecordsRead when record.data.blob() is executed. */
      const dataJson = TestDataGenerator.randomJson(1000);
      const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

      // Create a large record but do NOT store it on the local, agent-connected DWN.
      const { record, status } = await dwnAlice.records.write({
        store        : false,
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Write the large record to a remote DWN.
      await record!.send(aliceDid.uri);

      // Read the record that was just created on the remote DWN.
      const { records: queriedRecords, status: queriedRecordStatus } = await dwnAlice.records.query({
        from   : aliceDid.uri,
        filter : { recordId: record!.id }
      });
      expect(queriedRecordStatus.code).toBe(200);

      const [ queriedRecord ] = queriedRecords;

      // Consume the data stream as bytes.
      let readDataStream = await queriedRecord!.data.stream();
      let readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);

      // Consume the data stream as bytes a second time.
      readDataStream = await queriedRecord!.data.stream();
      readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);

      // Consume the data stream as bytes a third time.
      readDataStream = await queriedRecord!.data.stream();
      readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);
    });

    it('allows large data payloads queried from a remote to be consumed as a stream repeatedly', async () => {
      /** Generate data that exceeds the DWN encoded data limit to ensure that the data will have to
       * be fetched with a RecordsRead when record.data.* is executed. */
      const dataJson = TestDataGenerator.randomJson(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);
      const inputDataBytes = new TextEncoder().encode(JSON.stringify(dataJson));

      // Create a large record but do NOT store it on the local, agent-connected DWN.
      const { record, status } = await dwnAlice.records.write({
        store        : false,
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Write the large record to a remote DWN.
      await record!.send(aliceDid.uri);

      // Query for the record that was just created on the remote DWN.
      const { records: queriedRecords, status: queriedRecordStatus } = await dwnAlice.records.query({
        from   : aliceDid.uri,
        filter : { recordId: record!.id }
      });
      expect(queriedRecordStatus.code).toBe(200);

      const [ queriedRecord ] = queriedRecords;

      // Consume the data stream as bytes.
      let readDataStream = await queriedRecord!.data.stream();
      let readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);

      // Consume the data stream as bytes a second time.
      readDataStream = await queriedRecord!.data.stream();
      readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);

      // Consume the data stream as bytes a third time.
      readDataStream = await queriedRecord!.data.stream();
      readDataBytes = await Stream.consumeToBytes({ readableStream: readDataStream });
      expect(readDataBytes).toHaveLength(inputDataBytes.length);
    });

    describe('with two Agents', () => {
      let dwnCarol: DwnApi;
      let carolDid: BearerDid;
      let testHarnessCarol: PlatformAgentTestHarness;

      beforeAll(async () => {
        // Create a second `TestManagedAgent` that only Carol will use.
        testHarnessCarol = await PlatformAgentTestHarness.setup({
          agentClass       : EnboxUserAgent,
          agentStores      : 'memory',
          testDataLocation : '__TESTDATA__/AGENT_BOB'
        });

        await testHarnessCarol.clearStorage();
        await testHarnessCarol.createAgentDid();

        // Create a carol Identity to author the DWN messages.
        const carol = await testHarnessCarol.createIdentity({ name: 'Carol', testDwnUrls });
        carolDid = carol.did;

        // Instantiate a new `DwnApi` using Bob's test agent.
        dwnCarol = new DwnApi({ agent: testHarnessCarol.agent, connectedDid: carolDid.uri });
      });

      beforeEach(async () => {
        await testHarnessCarol.syncStore.clear();
        await testHarnessCarol.dwnDataStore.clear();
        await testHarnessCarol.dwnMessageStore.clear();
        await testHarnessCarol.dwnResumableTaskStore.clear();
        await testHarness.agent.permissions.clear();
        testHarnessCarol.dwnStores.clear();

        const { status: carolProtocolStatus, protocol: carolProtocol } = await dwnCarol.protocols.configure({
          definition: protocolDefinition
        });
        expect(carolProtocolStatus.code).toBe(202);
        expect(carolProtocol).toBeDefined();
        const { status: carolProtocolSendStatus } = await carolProtocol.send(carolDid.uri);
        expect(carolProtocolSendStatus.code).toBe(202);
      });

      afterAll(async () => {
        await testHarnessCarol.clearStorage();
        await testHarnessCarol.closeStorage();
      });

      it('returns large data payloads of records signed by another entity after remote dwn.records.query()', async () => {
        /**
         * WHAT IS BEING TESTED?
         *
         * We are testing whether a large (> `DwnConstant.maxDataSizeAllowedToBeEncoded`) record
         * authored/signed by one party (Alice) can be written to another party's DWN (Bob), and that
         * recipient (Bob) is able to access the data payload. This test was added to reveal a bug
         * that only surfaces when accessing the data (`record.data.*`) of a record signed by a
         * different entity  a `Record` instance's data, which requires fetching the data from a
         * remote DWN. Since the large (> `DwnConstant.maxDataSizeAllowedToBeEncoded`) data was not
         * returned with the query as `encodedData`, the `Record` instance's data is not available and
         * must be fetched from the remote DWN using a `RecordsRead` message.
         *
         * What made this bug particularly difficult to track down is that the bug only surfaces when
         * keys used to sign the record are different than the keys used to fetch the record AND both
         * sets of keys are unavailable to the test Agent used by the entity that is attempting to
         * fetch the record. In all of the other tests, the same test agent is used to store the keys
         * for all entities (e.g., "Alice", "Bob", etc.) so the bug never surfaced.
         *
         * In this test, Alice is the author of the record and Bob is the recipient. Alice and Bob
         * each have their own Agents, DWNs, DIDs, and keys. Alice's DWN is configured to use
         * Alice's DID/keys, and Bob's DWN is configured to use Bob's DID/keys. When Alice writes a
         * record to Bob's DWN, the record is signed by Alice's keys. When Bob fetches the record from
         * his DWN, this test validates that the `RecordsRead` is signed by Bob's keys.
         *
         * TEST STEPS:
         *
         *   1. Alice creates a record but does NOT store it her local, agent-connected DWN.
         */
        const { record, status } = await dwnAlice.records.write({
          data         : dataTextExceedingMaxSize,
          store        : false,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema
        });
        expect(status.code).toBe(202);
        /**
         *   2. Alice writes the record to Carol's remote DWN.
         */
        await record!.send(carolDid.uri);
        /**
         *   3. Carol queries his remote DWN for the record that Alice just wrote.
         */
        const { records: queryRecordsFrom, status: queryRecordStatusFrom } = await dwnCarol.records.query({
          from   : carolDid.uri,
          filter : { recordId: record!.id }
        });
        expect(queryRecordStatusFrom.code).toBe(200);
        /**
         *   4. Validate that Bob is able to access the data payload.
         */
        const recordData = await queryRecordsFrom[0].data.blob();
        expect(recordData.size).toBe(dataTextExceedingMaxSize.length);
      });

      it('returns large data payloads of records signed by another entity after remote dwn.records.query()', async () => {
        /**
         * WHAT IS BEING TESTED?
         *
         * We are testing whether a large (> `DwnConstant.maxDataSizeAllowedToBeEncoded`) record
         * authored/signed by one party (Alice) can be written to another party's DWN (Bob), and that
         * recipient (Bob) is able to access the data payload. This test was added to reveal a bug
         * that only surfaces when accessing the data (`record.data.*`) of a record signed by a
         * different entity  a `Record` instance's data, which requires fetching the data from a
         * remote DWN. Since the large (> `DwnConstant.maxDataSizeAllowedToBeEncoded`) data was not
         * returned with the query as `encodedData`, the `Record` instance's data is not available and
         * must be fetched from the remote DWN using a `RecordsRead` message.
         *
         * What made this bug particularly difficult to track down is that the bug only surfaces when
         * keys used to sign the record are different than the keys used to fetch the record AND both
         * sets of keys are unavailable to the test Agent used by the entity that is attempting to
         * fetch the record. In all of the other tests, the same test agent is used to store the keys
         * for all entities (e.g., "Alice", "Bob", etc.) so the bug never surfaced.
         *
         * In this test, Alice is the author of the record and Bob is the recipient. Alice and Bob
         * each have their own Agents, DWNs, DIDs, and keys. Alice's DWN is configured to use
         * Alice's DID/keys, and Bob's DWN is configured to use Bob's DID/keys. When Alice writes a
         * record to Bob's DWN, the record is signed by Alice's keys. When Bob fetches the record from
         * his DWN, this test validates that the `RecordsRead` is signed by Bob's keys.
         *
         * TEST STEPS:
         *
         *   1. Alice creates a record but does NOT store it her local, agent-connected DWN.
         */
        const { record, status } = await dwnAlice.records.write({
          data         : dataTextExceedingMaxSize,
          store        : false,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema
        });
        expect(status.code).toBe(202);
        /**
         *   2. Alice writes the record to Carol's remote DWN.
         */
        await record!.send(carolDid.uri);
        /**
         *   3. Carol queries her remote DWN for the record that Alice just wrote.
         */
        const { records: queryRecordsFrom, status: queryRecordStatusFrom } = await dwnCarol.records.query({
          from   : carolDid.uri,
          filter : { recordId: record!.id }
        });
        expect(queryRecordStatusFrom.code).toBe(200);
        /**
         *   4. Validate that Carol is able to write the record to Alice's remote DWN.
         */
        await queryRecordsFrom[0]!.send(aliceDid.uri);
        /**
         *  5. Alice queries her remote DWN for the record that Carol just wrote.
         */
        const { records: queryRecordsTo, status: queryRecordStatusTo } = await dwnAlice.records.query({
          from   : aliceDid.uri,
          filter : { recordId: record!.id }
        });
        expect(queryRecordStatusTo.code).toBe(200);
        /**
         *   6. Validate that Alice is able to access the data payload.
         */
        const recordData = await queryRecordsTo[0].data.text();
        expect(recordData).toEqual(dataTextExceedingMaxSize);
      });
    });
  });

  describe('send()', () => {
    it('writes small records to remote DWNs for your own DID', async () => {
      const dataString = 'Hello, world!';

      // Alice writes a message to her agent connected DWN.
      const { status: aliceEmailStatus, record: aliceEmailRecord } = await dwnAlice.records.write({
        data         : dataString,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'email',
      });

      expect(aliceEmailStatus.code).toBe(202);
      expect(await aliceEmailRecord?.data.text()).toBe(dataString);

      // Query Alice's agent connected DWN for `email` schema records.
      const aliceAgentQueryResult = await dwnAlice.records.query({
        filter: {
          schema: 'email'
        }
      });

      expect(aliceAgentQueryResult.status.code).toBe(200);
      expect(aliceAgentQueryResult.records).toHaveLength(1);
      const [ aliceAgentEmailRecord ] = aliceAgentQueryResult.records;
      expect(await aliceAgentEmailRecord.data.text()).toBe(dataString);

      // Attempt to write the record to Alice's remote DWN.
      await aliceEmailRecord!.send(aliceDid.uri);

      // Query Alices's remote DWN for `email` schema records.
      const aliceRemoteQueryResult = await dwnAlice.records.query({
        from   : aliceDid.uri,
        filter : {
          schema: 'email'
        }
      });

      expect(aliceRemoteQueryResult.status.code).toBe(200);
      expect(aliceRemoteQueryResult.records).toBeDefined();
      expect(aliceRemoteQueryResult.records).toHaveLength(1);
      const [ aliceRemoteEmailRecord ] = aliceAgentQueryResult.records;
      expect(await aliceRemoteEmailRecord.data.text()).toBe(dataString);
    });

    it('writes large records to remote DWNs that were initially queried from a local DWN', async () => {
      /** Generate data that exceeds the DWN encoded data limit to ensure that the data will have to
       * be fetched with a RecordsRead when record.send() is executed. */
      const dataText = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);

      // Alice writes a message to her agent connected DWN.
      const { status: aliceEmailStatus } = await dwnAlice.records.write({
        data         : dataText,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'email',
      });
      expect(aliceEmailStatus.code).toBe(202);

      // Query Alice's local, agent connected DWN for `email` schema records.
      const aliceAgentQueryResult = await dwnAlice.records.query({
        filter: {
          schema: 'email'
        }
      });

      expect(aliceAgentQueryResult.status.code).toBe(200);
      expect(aliceAgentQueryResult.records).toHaveLength(1);
      const [ aliceAgentEmailRecord ] = aliceAgentQueryResult.records;

      // Attempt to write the record to Alice's remote DWN.
      await aliceAgentEmailRecord!.send(aliceDid.uri);
    });

    it('writes large records to remote DWNs that were initially read from a local DWN', async () => {
      /** Generate data that exceeds the DWN encoded data limit to ensure that the data will have to
       * be fetched with a RecordsRead when record.send() is executed. */
      const dataText = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);

      // Alice writes a message to her agent connected DWN.
      const { status: aliceEmailStatus, record: aliceEmailRecord } = await dwnAlice.records.write({
        data         : dataText,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'email',
      });
      expect(aliceEmailStatus.code).toBe(202);

      // Read from Alice's local, agent connected DWN for the record that was just created.
      const aliceAgentReadResult = await dwnAlice.records.read({
        filter: {
          recordId: aliceEmailRecord.id
        }
      });

      expect(aliceAgentReadResult.status.code).toBe(200);
      expect(aliceAgentReadResult.record).toBeDefined();

      // Attempt to write the record to Alice's remote DWN.
      await aliceAgentReadResult.record.send(aliceDid.uri);
    });

    it('writes updated records to a remote DWN', async () => {
      /**
       * NOTE: The issue that this test was added to cover was intermittently failing the first
       * time the updated record is sent to the remote DWN. However, it always failed on the second
       * attempt to send the updated record to the remote DWN. As a result, this test was written
       * to update the record twice and send it to the remote DWN after each update to ensure that
       * the issue is covered.
       */

      // Alice writes a message to her agent connected DWN.
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });
      expect(status.code).toBe(202);

      // Write the record to Alice's remote DWN.
      await record.send(aliceDid.uri);

      // Update the record by mutating the data property.
      const updatedRecord = await record!.update({ data: 'hi' });
      expect(updatedRecord).toBe(record);

      // Write the updated record to Alice's remote DWN a second time.
      await updatedRecord.send(aliceDid.uri);

      // Update the record again.
      const updatedAgain = await updatedRecord.update({ data: 'bye' });
      expect(updatedAgain).toBe(record);

      // Write the updated record to Alice's remote DWN a third time.
      await updatedAgain.send(aliceDid.uri);
    });

    it('automatically sends the initial write and update of a record to a remote DWN', async () => {
      // Alice writes a message to her agent connected DWN.
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });
      expect(status.code).toBe(202);

      // Update the record by mutating the data property.
      const updatedRecord = await record!.update({ data: 'hi' });
      expect(updatedRecord).toBe(record);

      // Write the updated record to Alice's remote DWN a second time.
      await updatedRecord.send(aliceDid.uri);
    });

    it('writes large records to remote DWNs that were initially queried from a remote DWN', async () => {
      /** Generate data that exceeds the DWN encoded data limit to ensure that the data will have to
       * be fetched with a RecordsRead when record.data.blob() is executed. */
      const dataText = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);

      // Alice creates a new large record but does not store it in her local DWN.
      const { status: aliceEmailStatus, record: aliceEmailRecord } = await dwnAlice.records.write({
        store        : false,
        data         : dataText,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
        schema       : protocolDefinition.types.thread.schema
      });
      expect(aliceEmailStatus.code).toBe(202);

      // Alice writes the large record to her own remote DWN.
      await aliceEmailRecord!.send(aliceDid.uri);

      // Alice queries for the record that was just created on her remote DWN.
      const { records: queryRecords, status: queryRecordStatus } = await dwnAlice.records.query({
        from   : aliceDid.uri,
        filter : { recordId: aliceEmailRecord!.id }
      });
      expect(queryRecordStatus.code).toBe(200);

      // Attempt to write the record to Bob's DWN.
      const [ queryRecord ] = queryRecords;
      await queryRecord!.send(bobDid.uri);

      // Confirm Bob can query his own remote DWN for the created record.
      const bobQueryResult = await dwnBob.records.query({
        from   : bobDid.uri,
        filter : {
          protocol : protocolDefinition.protocol,
          schema   : protocolDefinition.types.thread.schema
        }
      });
      expect(bobQueryResult.status.code).toBe(200);
      expect(bobQueryResult.records).toBeDefined();
      expect(bobQueryResult.records).toHaveLength(1);
    });

    it('writes large records to remote DWNs that were initially read from a remote DWN', async () => {
      /** Generate data that exceeds the DWN encoded data limit to ensure that the data will have to
       * be fetched with a RecordsRead when record.data.blob() is executed. */
      const dataText = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);

      // Alice creates a new large record but does not store it in her local DWN.
      const { status: aliceEmailStatus, record: aliceEmailRecord } = await dwnAlice.records.write({
        store        : false,
        data         : dataText,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
        schema       : protocolDefinition.types.thread.schema
      });
      expect(aliceEmailStatus.code).toBe(202);

      // Alice writes the large record to her own remote DWN.
      await aliceEmailRecord!.send(aliceDid.uri);

      // Alice queries for the record that was just created on her remote DWN.
      const { record: queryRecord, status: queryRecordStatus } = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : { recordId: aliceEmailRecord!.id }
      });
      expect(queryRecordStatus.code).toBe(200);

      // Attempt to write the record to Bob's DWN.
      await queryRecord!.send(bobDid.uri);

      // Confirm Bob can query his own remote DWN for the created record.
      const bobQueryResult = await dwnBob.records.query({
        from   : bobDid.uri,
        filter : {
          protocol : protocolDefinition.protocol,
          schema   : protocolDefinition.types.thread.schema
        }
      });
      expect(bobQueryResult.status.code).toBe(200);
      expect(bobQueryResult.records).toBeDefined();
      expect(bobQueryResult.records).toHaveLength(1);
    });

    it(`writes records to remote DWNs for someone else's DID`, async () => {
      const dataString = 'Hello, world!';

      // Alice writes a message to her own DWN.
      const { status: aliceEmailStatus, record: aliceEmailRecord } = await dwnAlice.records.write({
        data         : dataString,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
        schema       : protocolDefinition.types.thread.schema
      });

      expect(aliceEmailStatus.code).toBe(202);

      // Attempt to write the message to Bob's DWN.
      await aliceEmailRecord!.send(bobDid.uri);

      // Query Bob's remote DWN for `thread` schema records.
      const bobQueryResult = await dwnBob.records.query({
        from   : bobDid.uri,
        filter : {
          protocol : protocolDefinition.protocol,
          schema   : protocolDefinition.types.thread.schema
        }
      });

      expect(bobQueryResult.status.code).toBe(200);
      expect(bobQueryResult.records).toBeDefined();
      expect(bobQueryResult.records).toHaveLength(1);
      const [ bobRemoteEmailRecord ] = bobQueryResult.records;
      expect(await bobRemoteEmailRecord.data.text()).toBe(dataString);
    });

    describe('with store: false', () => {
      it('sends encrypted ciphertext returned by a non-stored write without re-reading', async () => {
        const encryptedProtocol: DwnProtocolDefinition = {
          protocol  : `http://encrypted-store-false.xyz/${TestDataGenerator.randomString(15)}`,
          published : true,
          types     : {
            note: {
              dataFormats        : ['text/plain'],
              schema             : 'https://schemas.xyz/encrypted-store-false-note',
              encryptionRequired : true,
            },
          },
          structure: { note: {} },
        };
        const { status: configureStatus, protocol } = await dwnAlice.protocols.configure({
          definition: encryptedProtocol,
        });
        expect(configureStatus.code).toBe(202);
        expect((await protocol!.send(aliceDid.uri)).status.code).toBe(202);

        const plaintext = 'ciphertext must be the repeatable stored source';
        const writeResult = await dwnAlice.records.write({
          data         : plaintext,
          dataFormat   : 'text/plain',
          protocol     : encryptedProtocol.protocol,
          protocolPath : 'note',
          schema       : encryptedProtocol.types.note.schema,
          store        : false,
        });
        expect(writeResult.status.code).toBe(202);
        expect(writeResult.record!.encryption).toBeDefined();

        const processRequestSpy = sinon.spy(testHarness.agent, 'processDwnRequest');
        await writeResult.record!.send(aliceDid.uri);
        expect(processRequestSpy.getCalls().some(
          (call) => call.args[0].messageType === DwnInterface.RecordsRead
        )).toBe(false);

        const remoteRead = await dwnAlice.records.read({
          from   : aliceDid.uri,
          filter : { recordId: writeResult.record!.id },
        });
        expect(remoteRead.status.code).toBe(200);
        expect(await remoteRead.record!.data.text()).toBe(plaintext);
      });

      it('writes records to your own remote DWN but not your local DWN', async () => {
        // Alice creates a record but does not store it on her local DWN with `store: false`.
        const dataString = 'Hello, world!';
        const writeResult = await dwnAlice.records.write({
          store        : false,
          data         : dataString,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema
        });

        // Confirm that the request was accepted and a Record instance was returned.
        expect(writeResult.status.code).toBe(202);
        expect(writeResult.status.detail).toBe('Accepted');
        expect(writeResult.record).toBeDefined();
        expect(await writeResult.record?.data.text()).toBe(dataString);

        // Query Alice's agent DWN for `text/plain` records.
        const queryResult = await dwnAlice.records.query({
          filter: {
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema
          }
        });

        // Confirm no `email` schema records were written.
        expect(queryResult.status.code).toBe(200);
        expect(queryResult.records).toBeDefined();
        expect(queryResult.records).toHaveLength(0);

        // Alice writes the message to her remote DWN.
        await writeResult.record.send(aliceDid.uri);

        // Query Alice's remote DWN for `plain/text` records.
        const aliceRemoteQueryResult = await dwnAlice.records.query({
          from   : aliceDid.uri,
          filter : {
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema
          }
        });

        // Confirm `email` schema record was written to Alice's remote DWN.
        expect(aliceRemoteQueryResult.status.code).toBe(200);
        expect(aliceRemoteQueryResult.records).toBeDefined();
        expect(aliceRemoteQueryResult.records).toHaveLength(1);
        const [ aliceRemoteEmailRecord ] = aliceRemoteQueryResult.records;
        expect(await aliceRemoteEmailRecord.data.text()).toBe(dataString);
      });

      it(`writes records to someone else's remote DWN but not your agent DWN`, async () => {
        // Alice writes a message to her agent DWN with `store: false`.
        const dataString = 'Hello, world!';
        const writeResult = await dwnAlice.records.write({
          store        : false,
          data         : dataString,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema
        });

        // Confirm that the request was accepted and a Record instance was returned.
        expect(writeResult.status.code).toBe(202);
        expect(writeResult.status.detail).toBe('Accepted');
        expect(writeResult.record).toBeDefined();
        expect(await writeResult.record?.data.text()).toBe(dataString);

        // Query Alice's agent DWN for `thread` schema records.
        const queryResult = await dwnAlice.records.query({
          filter: {
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema
          }
        });

        // Confirm no `thread` schema records were written.
        expect(queryResult.status.code).toBe(200);
        expect(queryResult.records).toBeDefined();
        expect(queryResult.records).toHaveLength(0);

        // Alice writes the message to Bob's remote DWN.
        await writeResult.record.send(bobDid.uri);

        // Query Bobs's remote DWN for `thread` schema records.
        const bobQueryResult = await dwnBob.records.query({
          from   : bobDid.uri,
          filter : {
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema
          }
        });

        // Confirm `thread` schema record was written to Bob's remote DWN.
        expect(bobQueryResult.status.code).toBe(200);
        expect(bobQueryResult.records).toBeDefined();
        expect(bobQueryResult.records).toHaveLength(1);
        const [ bobRemoteEmailRecord ] = bobQueryResult.records;
        expect(await bobRemoteEmailRecord.data.text()).toBe(dataString);
      });

      it('has no effect if `store: true`', async () => {
        // Alice writes a message to her agent DWN with `store: true`.
        const dataString = 'Hello, world!';
        const writeResult = await dwnAlice.records.write({
          store        : true,
          data         : dataString,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema
        });

        // Confirm that the request was accepted and a Record instance was returned.
        expect(writeResult.status.code).toBe(202);
        expect(writeResult.status.detail).toBe('Accepted');
        expect(writeResult.record).toBeDefined();
        expect(await writeResult.record?.data.text()).toBe(dataString);

        // Query Alice's agent DWN for `text/plain` records.
        const queryResult = await dwnAlice.records.query({
          filter: {
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema
          }
        });

        // Confirm the `email` schema records was written.
        expect(queryResult.status.code).toBe(200);
        expect(queryResult.records).toBeDefined();
        expect(queryResult.records).toHaveLength(1);
        const [ aliceAgentRecord ] = queryResult.records;
        expect(await aliceAgentRecord.data.text()).toBe(dataString);

        // Alice writes the message to her remote DWN.
        await writeResult.record.send(aliceDid.uri);

        // Query Alice's remote DWN for `plain/text` records.
        const aliceRemoteQueryResult = await dwnAlice.records.query({
          from   : aliceDid.uri,
          filter : {
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema
          }
        });

        // Confirm `email` schema record was written to Alice's remote DWN.
        expect(aliceRemoteQueryResult.status.code).toBe(200);
        expect(aliceRemoteQueryResult.records).toBeDefined();
        expect(aliceRemoteQueryResult.records).toHaveLength(1);
        const [ aliceRemoteEmailRecord ] = aliceRemoteQueryResult.records;
        expect(await aliceRemoteEmailRecord.data.text()).toBe(dataString);
      });
    });
  });

  describe('toJSON()', () => {
    it('should return all defined properties', async () => {
      const encryptionVm = aliceDid.document.verificationMethod?.find(
        vm => didUtils.extractDidFragment(vm.id) === 'enc'
      );
      const encryptionPublicKeyJwk = encryptionVm!.publicKeyJwk;
      const encryptionKeyId = encryptionVm!.id;

      const aliceSigner = await aliceDid.getSigner();

      // RecordsWriteMessage properties that can be pre-defined
      const attestationSigners: DwnSigner[] = [{
        algorithm : aliceSigner.algorithm,
        keyId     : aliceSigner.keyId,
        sign      : async (data: Uint8Array): Promise<Uint8Array> => {
          return await aliceSigner.sign({ data });
        }
      }];

      const authorizationSigner: DwnSigner = {
        algorithm : aliceSigner.algorithm,
        keyId     : aliceSigner.keyId,
        sign      : async (data: Uint8Array): Promise<Uint8Array> => {
          return await aliceSigner.sign({ data });
        }
      };

      const encryptionInput: DwnMessageParams[DwnInterface.RecordsWrite]['encryptionInput'] = {
        algorithm            : DwnContentEncryptionAlgorithm.A256CTR,
        initializationVector : TestDataGenerator.randomBytes(16),
        key                  : TestDataGenerator.randomBytes(32),
        keyEncryptionInputs  : [{
          algorithm        : DwnKeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
          derivationScheme : DwnKeyDerivationScheme.ProtocolPath,
          keyId            : encryptionKeyId,
          publicKey        : encryptionPublicKeyJwk as DwnPublicKeyJwk,
        }]
      };

      // RecordsWriteDescriptor properties that can be pre-defined
      const protocol = protocolDefinition.protocol;
      const protocolPath = 'thread';
      const schema = protocolDefinition.types.thread.schema;
      const recipient = aliceDid.uri;
      const published = true;

      const RecordsWrite = dwnMessageConstructors[DwnInterface.RecordsWrite];

      // Create a parent record to reference in the RecordsWriteMessage used for validation
      const parentRecordsWrite = await RecordsWrite.create({
        data   : new Uint8Array(await dataBlob.arrayBuffer()),
        dataFormat,
        protocol,
        protocolPath,
        schema,
        signer : authorizationSigner,
      });

      // Create a RecordsWriteMessage
      const recordsWrite = await RecordsWrite.create({
        attestationSigners,
        data            : new Uint8Array(await dataBlob.arrayBuffer()),
        dataFormat,
        encryptionInput,
        parentContextId : parentRecordsWrite.message.contextId,
        protocol,
        protocolPath,
        published,
        recipient,
        schema,
        signer          : authorizationSigner,
      });

      // Create record using test RecordsWriteMessage.
      const record = new Record(testHarness.agent, {
        ...recordsWrite.message,
        storedData   : dataBlob,
        author       : aliceDid.uri,
        connectedDid : aliceDid.uri,
        dataAccess   : { author: aliceDid.uri, remote: false, target: aliceDid.uri },
      });

      // Call toJSON() method.
      const recordJson = record.toJSON();

      // Retained Record properties.
      expect(recordJson.author).toBe(aliceDid.uri);

      // Retained RecordsWriteMessage top-level properties.
      expect(record.contextId).toBe(recordsWrite.message.contextId);
      expect(record.id).toBe(recordsWrite.message.recordId);
      expect(record.encryption).toBeDefined();
      expect(record.encryption).toEqual(recordsWrite.message.encryption);
      expect(record.encryption!.keyEncryption.find(r => r.derivationScheme === DwnKeyDerivationScheme.ProtocolPath)).toBeDefined();
      expect(record.attestation).toBeDefined();
      expect(record.attestation).toHaveProperty('signatures');

      // Retained RecordsWriteDescriptor properties.
      expect(recordJson.protocol).toBe(protocol);
      expect(recordJson.protocolPath).toBe(protocolPath);
      expect(recordJson.recipient).toBe(recipient);
      expect(recordJson.schema).toBe(schema);
      expect(recordJson.parentId).toBe(parentRecordsWrite.message.recordId);
      expect(recordJson.dataCid).toBe(recordsWrite.message.descriptor.dataCid);
      expect(recordJson.dataSize).toBe(recordsWrite.message.descriptor.dataSize);
      expect(recordJson.dateCreated).toBe(recordsWrite.message.descriptor.dateCreated);
      expect(recordJson.timestamp).toBe(recordsWrite.message.descriptor.messageTimestamp);
      expect(recordJson.published).toBe(published);
      expect(recordJson.datePublished).toBe(recordsWrite.message.descriptor.datePublished);
      expect(recordJson.dataFormat).toBe(dataFormat);
    });
  });

  describe('toString()', () => {
    it('should return a string representation of the record', async () => {
      // create a record
      const { record, status } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        dataFormat   : 'text/plain'
      });
      expect(status.code).toBe(202);

      const recordString = record!.toString();
      expect(typeof recordString).toBe('string');
      expect(recordString).toContain(`ID: ${record.id}`);
      expect(recordString).toContain(`Deleted: ${false}`); // record is not deleted
      expect(recordString).toContain(`Created: ${record.dateCreated}`);
      expect(recordString).toContain(`Timestamp: ${record.timestamp}`);

      // data related properties
      expect(recordString).toContain(`Data CID: ${record.dataCid}`);
      expect(recordString).toContain(`Data Format: ${record.dataFormat}`);
      expect(recordString).toContain(`Data Size: ${record.dataSize}`);
    });

    it('should return a string representation of the record with protocol properties', async () => {
      // create a record
      const { record, status } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
        schema       : protocolDefinition.types.thread.schema,
        dataFormat   : 'text/plain'
      });
      expect(status.code).toBe(202);

      const recordString = record!.toString();
      expect(typeof recordString).toBe('string');
      expect(recordString).toContain(`ID: ${record.id}`);
      expect(recordString).toContain(`Context ID: ${record.contextId}`);
      expect(recordString).toContain(`Protocol: ${record.protocol}`);
      expect(recordString).toContain(`Schema: ${record.schema}`);
      expect(recordString).toContain(`Deleted: ${false}`); // record is not deleted
      expect(recordString).toContain(`Created: ${record.dateCreated}`);
      expect(recordString).toContain(`Timestamp: ${record.timestamp}`);

      // data related properties
      expect(recordString).toContain(`Data CID: ${record.dataCid}`);
      expect(recordString).toContain(`Data Format: ${record.dataFormat}`);
      expect(recordString).toContain(`Data Size: ${record.dataSize}`);
    });

    it('should return a string representation of the record in a deleted state', async () => {
      // create a record
      const { record, status } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        dataFormat   : 'text/plain'
      });
      expect(status.code).toBe(202);

      // delete the record
      await record!.delete();
      const deletedRecord = record;
      expect(deletedRecord.deleted).toBe(true);

      const recordString = deletedRecord!.toString();
      expect(typeof recordString).toBe('string');
      expect(recordString).toContain(`ID: ${deletedRecord.id}`);
      expect(recordString).toContain(`Deleted: ${true}`); // record is deleted
      expect(recordString).toContain(`Created: ${deletedRecord.dateCreated}`);
      expect(recordString).toContain(`Timestamp: ${deletedRecord.timestamp}`);

      // data related properties
      expect(recordString).not.toContain('Data CID');
      expect(recordString).not.toContain('Data Format');
      expect(recordString).not.toContain('Data Size');
    });
  });

  describe('update()', () => {
    let notesProtocol: DwnProtocolDefinition;

    beforeEach(async () => {
      const protocolUri = `http://example.com/notes-${TestDataGenerator.randomString(15)}`;

      notesProtocol = {
        published : true,
        protocol  : protocolUri,
        types     : {
          note: {
            schema: 'http://example.com/note'
          },
          request: {
            schema: 'http://example.com/request'
          }
        },
        structure: {
          request: {
            $actions: [{
              who : 'anyone',
              can : ['create', 'update', 'delete']
            },{
              who : 'recipient',
              of  : 'request',
              can : ['co-update']
            }]
          },
          note: {
          }
        }
      };

      // alice and bob both configure the protocol
      const { status: aliceConfigStatus, protocol: aliceNotesProtocol } = await dwnAlice.protocols.configure({
        definition: notesProtocol
      });
      expect(aliceConfigStatus.code).toBe(202);
      const { status: aliceNotesProtocolSend } = await aliceNotesProtocol.send(aliceDid.uri);
      expect(aliceNotesProtocolSend.code).toBe(202);

      const { status: bobConfigStatus, protocol: bobNotesProtocol } = await dwnBob.protocols.configure({ definition: notesProtocol });
      expect(bobConfigStatus.code).toBe(202);
      const { status: bobNotesProtocolSend } = await bobNotesProtocol!.send(bobDid.uri);
      expect(bobNotesProtocolSend.code).toBe(202);

    });

    it('updates a local record on the local DWN', async () => {
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });

      const dataCidBeforeDataUpdate = record!.dataCid;

      expect(status.code).toBe(202);
      expect(record).toBeDefined();

      const updatedRecord = await record!.update({ data: 'bye' });
      expect(updatedRecord).toBe(record);

      const readResult = await dwnAlice.records.read({
        filter: {
          recordId: record!.id
        }
      });

      expect(readResult.status.code).toBe(200);
      expect(readResult.record).toBeDefined();

      expect(readResult.record.dataCid).not.toBe(dataCidBeforeDataUpdate);
      expect(readResult.record.dataCid).toBe(updatedRecord!.dataCid);

      const updatedData = await updatedRecord!.data.text();
      expect(updatedData).toBe('bye');
    });

    it('updates a record to be unpublished from published', async () => {
      // alice creates a record and sets it to published
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain',
        published    : true
      });
      expect(status.code).toBe(202);
      expect(record).toBeDefined();

      // send the record to alice's DWN
      await record!.send(aliceDid.uri);

      // bob reads the record to confirm it is published
      const readResult = await dwnBob.records.read({
        from   : aliceDid.uri,
        filter : {
          recordId: record!.id
        }
      });
      expect(readResult.status.code).toBe(200);
      expect(readResult.record).toBeDefined();
      expect(readResult.record.id).toBe(record!.id);

      // alice updates the record to be unpublished
      const updatedRecord = await record!.update({ published: false });
      expect(updatedRecord).toBe(record);

      // send the updated record to alice's DWN
      await updatedRecord.send(aliceDid.uri);

      // bob attempts to read the record again but it should not be authorized as it's unpublished
      const readResultAfterUpdate = await dwnBob.records.read({
        from   : aliceDid.uri,
        filter : {
          recordId: record!.id
        }
      });
      expect(readResultAfterUpdate.status.code).toBe(401);
    });

    it('allows to update a record locally that was initially read from a remote DWN if store() is issued', async () => {
      // Create a record but do not store it on the local DWN.
      const { status, record } = await dwnAlice.records.write({
        store        : false,
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });
      expect(status.code).toBe(202);
      expect(record).toBeDefined();

      // Store the data CID of the record before it is updated.
      const dataCidBeforeDataUpdate = record!.dataCid;

      // Write the record to a remote DWN.
      await record!.send(aliceDid.uri);

      // Read the record from the remote DWN.
      let readResult = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : {
          recordId: record!.id
        }
      });
      expect(readResult.status.code).toBe(200);
      expect(readResult.record).toBeDefined();

      const readRecord = readResult.record;

      // Attempt to update the record without storing, should fail
      try {
        await readRecord.update({ data: 'bye' });
        throw new Error('Expected an unstored remote record update to fail.');
      } catch (error) {
        expect(error).toBeInstanceOf(DwnResponseError);
        expect((error as DwnResponseError).status.code).toBe(400);
      }

      // store the record locally
      await readRecord.store();

      // Attempt to update the record, which should write the updated record the local DWN.
      const updatedRecord = await readRecord.update({ data: 'bye' });
      expect(updatedRecord).toBe(readRecord);

      // Confirm that the record was written to the local DWN.
      readResult = await dwnAlice.records.read({
        filter: {
          recordId: record!.id
        }
      });
      expect(readResult.status.code).toBe(200);
      expect(readResult.record).toBeDefined();

      // Confirm that the data CID of the record was updated.
      expect(readResult.record.dataCid).not.toBe(dataCidBeforeDataUpdate);
      expect(readResult.record.dataCid).toBe(updatedRecord.dataCid);
    });

    it('updates a record that was queried from a remote DWN without storing it', async () => {
      // Create a record but do not store it on the local DWN.
      const { status, record } = await dwnAlice.records.write({
        store        : false,
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });
      expect(status.code).toBe(202);
      expect(record).toBeDefined();

      // Store the data CID of the record before it is updated.
      const _dataCidBeforeDataUpdate = record!.dataCid;

      // Write the record to a remote DWN.
      await record!.send(aliceDid.uri);

      // Query the record from the remote DWN.
      let queryResult = await dwnAlice.records.query({
        from   : aliceDid.uri,
        filter : {
          recordId: record!.id
        }
      });
      expect(queryResult.status.code).toBe(200);
      expect(queryResult.records).toBeDefined();
      expect(queryResult.records).toHaveLength(1);

      // Attempt to update the queried record
      const [ queriedRecord ] = queryResult.records;
      const updatedRecord = await queriedRecord!.update({ data: 'Updated, world!', store: false });
      expect(updatedRecord).toBe(queriedRecord);

      // confirm that the record does not exist locally
      queryResult = await dwnAlice.records.read({
        filter: {
          recordId: record!.id
        }
      });
      expect(queryResult.status.code).toBe(404);
    });

    it('updates a record which has a parent reference from a remote DWN without storing it or its parent', async () => {
      // create a parent thread
      const { status: threadStatus, record: threadRecord } = await dwnAlice.records.write({
        store        : false,
        data         : 'Hello, world!',
        protocol     : protocolDefinition.protocol,
        schema       : protocolDefinition.types.thread.schema,
        protocolPath : 'thread'
      });

      expect(threadStatus.code).toBe(202);
      expect(threadRecord).toBeDefined();

      await threadRecord.send();

      // create an email with the thread as a parent
      const { status: emailStatus, record: emailRecord } = await dwnAlice.records.write({
        store           : false,
        data            : 'Hello, world!',
        parentContextId : threadRecord.contextId,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'thread/email',
        schema          : protocolDefinition.types.email.schema
      });
      expect(emailStatus.code).toBe(202);
      expect(emailRecord).toBeDefined();

      await emailRecord!.send();

      // update email record
      const updatedEmailRecord = await emailRecord!.update({ data: 'updated email record', store: false });
      expect(updatedEmailRecord).toBe(emailRecord);

      await updatedEmailRecord.send();

      let readResult = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : {
          recordId: emailRecord.id
        }
      });

      expect(readResult.status.code).toBe(200);
      expect(readResult.record).toBeDefined();
      expect(await readResult.record.data.text()).toBe('updated email record');

      // confirm that records do not exist locally
      readResult = await dwnAlice.records.read({
        filter: {
          recordId: emailRecord.id
        }
      });
      expect(readResult.status.code).toBe(404);

      readResult = await dwnAlice.records.read({
        filter: {
          recordId: threadRecord.id
        }
      });
      expect(readResult.status.code).toBe(404);
    });

    it('updates a record which has a parent reference', async () => {
      // create a parent thread
      const { status: threadStatus, record: threadRecord } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : protocolDefinition.protocol,
        schema       : protocolDefinition.types.thread.schema,
        protocolPath : 'thread'
      });

      expect(threadStatus.code).toBe(202);
      expect(threadRecord).toBeDefined();

      // create an email with the thread as a parent
      const { status: emailStatus, record: emailRecord } = await dwnAlice.records.write({
        data            : 'Hello, world!',
        parentContextId : threadRecord.contextId,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'thread/email',
        schema          : protocolDefinition.types.email.schema
      });
      expect(emailStatus.code).toBe(202);
      expect(emailRecord).toBeDefined();

      // update email record
      const updatedRecord = await emailRecord!.update({ data: 'updated email record' });
      expect(updatedRecord).toBe(emailRecord);

      const readResult = await dwnAlice.records.read({
        filter: {
          recordId: emailRecord.id
        }
      });

      expect(readResult.status.code).toBe(200);
      expect(readResult.record).toBeDefined();
      expect(await readResult.record.data.text()).toBe('updated email record');
    });

    it('returns new timestamp after each update', async () => {
      // Initial write of the record.
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });
      const initialTimestamp = record.timestamp;
      expect(status.code).toBe(202);

      // First update of the record.
      const firstUpdate = await record!.update({ data: 'hi' });
      expect(firstUpdate).toBe(record);

      // Verify that the timestamp was updated.
      const firstUpdateTimestamp = firstUpdate.timestamp;
      expect(initialTimestamp).not.toBe(firstUpdateTimestamp);

      //  Second update of the record.
      const secondUpdate = await firstUpdate.update({ data: 'bye' });
      expect(secondUpdate).toBe(record);

      // Verify that the timestamp was updated.
      const secondUpdateTimestamp = secondUpdate.timestamp;
      expect(firstUpdateTimestamp).not.toBe(secondUpdateTimestamp);
    });

    it('mutates the original record in-place on successful update', async () => {
      const { status, record } = await dwnAlice.records.write({
        data         : 'original',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });

      expect(status.code).toBe(202);

      // Read original data.
      const originalData = await record!.data.text();
      expect(originalData).toBe('original');

      // Update the record.
      const updatedRecord = await record!.update({ data: 'updated' });
      expect(updatedRecord).toBe(record);

      // The returned record should have the new data.
      const returnedData = await updatedRecord!.data.text();
      expect(returnedData).toBe('updated');

      // The ORIGINAL record should also reflect the new data (in-place mutation).
      const mutatedData = await record!.data.text();
      expect(mutatedData).toBe('updated');

      // Timestamps should be in sync.
      expect(record!.timestamp).toBe(updatedRecord!.timestamp);
    });

    it('throws an exception when an immutable property is modified', async () => {
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });

      expect(status.code).toBe(202);
      expect(record).toBeDefined();

      try {
        // @ts-expect-error because this test intentionally specifies an immutable property that is not present in RecordUpdateOptions.
        await record!.update({ schema: 'bar/baz' });
        throw new Error('Expected an exception to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('is an immutable property. Its value cannot be changed.');
      }
    });

    it('throws if attempting to revive a deleted record', async () => {
      // create a record but do not store it
      const { status: writeStatus, record } = await dwnAlice.records.write({
        store        : false,
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });
      expect(writeStatus.code).toBe(202);

      // delete the record but do not store it
      await record.delete();
      const deletedRecord = record;
      expect(deletedRecord.deleted).toBe(true);

      // store the record
      try {
        await deletedRecord.update({ data: 'hi' });
        throw new Error('Should have failed because the initial write is not set');
      } catch (error: any) {
        expect(error.message).toContain('Record: Cannot revive a deleted record.');
      }

    });

    it('should override tags on update', async () => {
      // create a record with tags
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain',
        tags         : {
          tag1 : 'value1',
          tag2 : 'value2'
        }
      });

      expect(status.code).toBe(202);
      expect(record).toBeDefined();
      expect(await record.data.text()).toBe('Hello, world!');
      expect(record.tags).toEqual({ tag1: 'value1', tag2: 'value2' });

      // if you do not pass any tags they remain unchanged
      const updatedRecord1 = await record!.update({
        data: 'hi',
      });

      expect(updatedRecord1).toBe(record);
      expect(updatedRecord1.tags).toEqual({ tag1: 'value1', tag2: 'value2' }); // unchanged
      expect(await updatedRecord1.data.text()).toBe('hi');

      // if you modify the tags they override the existing tags
      const updatedRecord2 = await updatedRecord1.update({
        tags: {
          tag1 : 'value3',
          tag3 : 'value4'
        }
      });

      expect(updatedRecord2).toBe(record);
      expect(updatedRecord2.tags).toEqual({ tag1: 'value3', tag3: 'value4' }); // changed to updated tags
      expect(await updatedRecord2.data.text()).toBe('hi');
    });

    it('should remove tags on update if tags are set to an empty object or null', async () => {
      // create a record with tags
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain',
        tags         : {
          tag1 : 'value1',
          tag2 : 'value2'
        }
      });

      expect(status.code).toBe(202);
      expect(record).toBeDefined();
      expect(await record.data.text()).toBe('Hello, world!');
      expect(record.tags).toEqual({ tag1: 'value1', tag2: 'value2' });

      // if you use an empty tags object it removes the tags
      const updatedRecord1 = await record!.update({
        tags: {}
      });

      expect(updatedRecord1).toBe(record);
      expect(updatedRecord1.tags).toBeUndefined(); // removed

      // add tags to the record again
      const updatedRecord2 = await updatedRecord1.update({
        tags: {
          tag1 : 'value3',
          tag3 : 'value4'
        }
      });

      expect(updatedRecord2).toBe(record);
      expect(updatedRecord2.tags).toEqual({ tag1: 'value3', tag3: 'value4' }); // added tags

      // if you use null it removes the tags
      const updatedRecord3 = await updatedRecord2.update({
        tags: null
      });

      expect(updatedRecord3).toBe(record);
      expect(updatedRecord3.tags).toBeUndefined(); // removed
    });

    it('should keep dataFormat owned by the record representation', async () => {
      // alice writes a record with the data format set to text/plain
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
        schema       : protocolDefinition.types.thread.schema,
        dataFormat   : 'text/plain'
      });

      expect(status.code).toBe(202);
      expect(record).toBeDefined();
      expect(record.dataFormat).toBe('text/plain');
      expect(await record.data.text()).toBe('Hello, world!');

      // Record handles preserve their representation. Advanced callers that
      // need to construct another representation use the raw DWN write API.
      await expect(record!.update({
        data       : { subject: 'some subject', body: 'some body' },
        // @ts-expect-error Record handles do not accept representation overrides.
        dataFormat : 'application/json',
      })).rejects.toThrow('dataFormat cannot be changed through a record handle');

      const updatedRecord = await record!.update({ data: 'Hello again!' });
      expect(updatedRecord).toBe(record);
      expect(updatedRecord.dataFormat).toBe('text/plain');
      expect(await updatedRecord.data.text()).toBe('Hello again!');
    });

    it('differentiates between creator and author', async () => {
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, Bob!',
        recipient    : bobDid.uri,
        protocol     : notesProtocol.protocol,
        protocolPath : 'request',
        schema       : notesProtocol.types.request.schema,
      });
      expect(status.code).toBe(202);
      expect(record).toBeDefined();
      await record.send();

      // bob reads the record
      const readResult = await dwnBob.records.read({
        from   : aliceDid.uri,
        filter : {
          recordId: record.id
        }
      });
      expect(readResult.status.code).toBe(200);
      expect(readResult.record).toBeDefined();

      const bobRecord = readResult.record;
      await bobRecord!.store();
      const updatedBobRecord = await bobRecord.update({ data: 'Hello, Alice!' });
      expect(updatedBobRecord).toBe(bobRecord);

      await updatedBobRecord.send(aliceDid.uri);

      // alice reads the record
      const readResultAlice = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : {
          recordId: record.id
        }
      });

      expect(readResultAlice.status.code).toBe(200);
      expect(readResultAlice.record).toBeDefined();
      expect(await readResultAlice.record.data.text()).toBe('Hello, Alice!');

      // alice is the creator
      expect(readResultAlice.record.creator).toBe(aliceDid.uri);
      // bob is the author
      expect(readResultAlice.record.author).toBe(bobDid.uri);
    });

    it('updates a record using a different protocolRole than the one used when querying for/reading the record', async () => {
      // scenario: Bob has a notes protocol that has friends who can read/query/subscribe to notes, but coAuthors that can update notes.
      // When Alice uses her friend role to query for notes, she cannot update them with that same role. Instead she uses her coAuthor role update.

      const protocol = {
        ...notesProtocolDefinition,
        protocol: 'http://example.com/notes' + TestDataGenerator.randomString(15)
      };

      // Bob configures the notes protocol for himself
      const { status: bobProtocolStatus, protocol: bobProtocol } = await dwnBob.protocols.configure({
        definition: protocol
      });
      expect(bobProtocolStatus.code).toBe(202);
      const { status: bobProtocolSendStatus } = await bobProtocol.send(bobDid.uri);
      expect(bobProtocolSendStatus.code).toBe(202);

      // Alice must also configure the protocol to make updates.
      // NOTE: This is not desireable and there is an issue to address this:
      // https://github.com/enboxorg/enbox/issues/955
      const { status: aliceProtocolStatus, protocol: aliceProtocol } = await dwnAlice.protocols.configure({
        definition: protocol
      });
      expect(aliceProtocolStatus.code).toBe(202);
      const { status: aliceProtocolSend } = await aliceProtocol.send(aliceDid.uri);
      expect(aliceProtocolSend.code).toBe(202);

      // Bob creates a few notes ensuring that the data is larger than the max encoded size
      // that way the data will be requested with a separate `read` request
      const records: Set<string> = new Set();
      for (let i = 0; i < 3; i++) {
        const data = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
        const { status: noteCreateStatus, record: noteRecord } = await dwnBob.records.write({
          data,
          protocol     : protocol.protocol,
          protocolPath : 'note',
          schema       : protocol.types.note.schema,
          dataFormat   : 'text/plain',
        });
        expect(noteCreateStatus.code).toBe(202);
        await noteRecord.send();
        records.add(noteRecord.id);
      }

      // Bob makes Alice a `friend` to allow her to read and comment on his notes
      const { status: friendCreateStatus, record: friendRecord } = await dwnBob.records.write({
        data         : 'friend!',
        recipient    : aliceDid.uri,
        protocol     : protocol.protocol,
        protocolPath : 'friend',
        schema       : protocol.types.friend.schema,
        dataFormat   : 'text/plain'
      });
      expect(friendCreateStatus.code).toBe(202);
      await friendRecord.send(bobDid.uri);

      // Bob makes alice a 'coAuthor' of one of his notes
      const aliceCoAuthorNoteId = records.keys().next().value;
      const { status: coAuthorStatus, record: coAuthorRecord } = await dwnBob.records.write({
        data            : aliceDid.uri,
        parentContextId : aliceCoAuthorNoteId,
        recipient       : aliceDid.uri,
        protocol        : protocol.protocol,
        protocolPath    : 'note/coAuthor',
        schema          : protocol.types.coAuthor.schema,
        dataFormat      : 'text/plain'
      });
      expect(coAuthorStatus.code).toBe(202);
      await coAuthorRecord.send(bobDid.uri);

      // Alice querying for bob's notes using her friend role
      const { status: aliceQueryStatus, records: bobNotesAliceQuery } = await dwnAlice.records.query({
        from         : bobDid.uri,
        protocolRole : 'friend',
        filter       : {
          protocol     : protocol.protocol,
          protocolPath : 'note',
        }
      });
      expect(aliceQueryStatus.code).toBe(200);
      expect(bobNotesAliceQuery).toBeDefined();
      expect(bobNotesAliceQuery).toHaveLength(records.size);

      // Alice looks for the record she has a co-author rule on
      const coAuthorNote = bobNotesAliceQuery.find((record) => record.id === aliceCoAuthorNoteId);
      expect(coAuthorNote).toBeDefined();

      // Alice must import the record to be able to update it
      // NOTE this should be removed after: https://github.com/enboxorg/enbox/issues/955
      await coAuthorNote.import();

      // Alice updates the co-author note without providing a new role
      const updatedNote = await coAuthorNote!.update({ data: 'updated note' });
      expect(updatedNote).toBe(coAuthorNote);

      // spy on sendDwnRequest to ensure that the protocolRole is used to read the data of the notes
      const sendDwnRequestSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');

      // confirm that it starts with 0 calls
      expect(sendDwnRequestSpy.callCount).toBe(0);

      // This is accepted locally but will fail when sending the update to the remote DWN
      try {
        await updatedNote.send(bobDid.uri);
        throw new Error('Expected the friend role update to be rejected.');
      } catch (error) {
        expect(error).toBeInstanceOf(DwnResponseError);
        expect((error as DwnResponseError).status.code).toBe(401);
      }
      expect(sendDwnRequestSpy.callCount).toBe(2); // the first call is for the initialWrite
      let record = (sendDwnRequestSpy.secondCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsWrite>).rawMessage;
      let sendAuthorizationRole = getRecordProtocolRole(record);
      expect(sendAuthorizationRole).toBe('friend');

      const updatedNoteCoAuthor = await updatedNote.update({ data: 'updated note', protocolRole: 'note/coAuthor' });
      expect(updatedNoteCoAuthor).toBe(updatedNote);

      sendDwnRequestSpy.resetHistory();

      // Now update the record with the correct role
      await updatedNoteCoAuthor.send(bobDid.uri);
      expect(sendDwnRequestSpy.callCount).toBe(1); // the initialWrite was already sent and added to the sent-cache, only the update is sent
      record = (sendDwnRequestSpy.firstCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsWrite>).rawMessage;
      sendAuthorizationRole = getRecordProtocolRole(record);
      expect(sendAuthorizationRole).toBe('note/coAuthor');
    });

    it('should auto-re-encrypt data when updating an encrypted record', async () => {
      // Define a simple protocol for encrypted notes
      const encProtocol: DwnProtocolDefinition = {
        published : true,
        protocol  : `http://encrypted-notes.xyz/${TestDataGenerator.randomString(15)}`,
        types     : {
          note: {
            schema             : 'https://schemas.xyz/note',
            dataFormats        : ['text/plain'],
            encryptionRequired : true,
          }
        },
        structure: {
          note: {}
        }
      };

      // Configure with encryption
      const { status: configStatus } = await dwnAlice.protocols.configure({
        definition: encProtocol,
      });
      expect(configStatus.code).toBe(202);

      // Write initial encrypted record
      const initialPlaintext = 'Initial secret note';
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : initialPlaintext,
        protocol     : encProtocol.protocol,
        protocolPath : 'note',
        dataFormat   : 'text/plain',
        schema       : 'https://schemas.xyz/note',
      });
      expect(writeStatus.code).toBe(202);
      expect(record).toBeDefined();
      expect(record!.encryption).toBeDefined();

      // Save original encryption metadata for comparison
      const originalIV = record!.encryption!.initializationVector;

      // Update the record — encryption should be auto-detected
      const updatedPlaintext = 'Updated secret note';
      const updatedRecord = await record!.update({ data: updatedPlaintext });
      expect(updatedRecord).toBe(record);

      // Verify the record's encryption metadata was updated
      expect(updatedRecord!.encryption).toBeDefined();
      expect(updatedRecord!.encryption!.initializationVector).not.toBe(originalIV);

      // Read back with decryption to verify the updated plaintext
      const { status: readStatus, record: readRecord } = await dwnAlice.records.read({
        filter: { recordId: record!.id },
      });
      expect(readStatus.code).toBe(200);
      expect(readRecord).toBeDefined();

      const decryptedText = await readRecord!.data.text();
      expect(decryptedText).toBe(updatedPlaintext);

      await updatedRecord.delete();

      expect(updatedRecord.deleted).toBe(true);
      expect(updatedRecord.encryption).toBeUndefined();
      expect(updatedRecord.attestation).toBeUndefined();
      expect(updatedRecord.toJSON().encryption).toBeUndefined();
    });

    it('should retain the stored data and envelope for metadata-only encrypted updates', async () => {
      const encProtocol: DwnProtocolDefinition = {
        published : true,
        protocol  : `http://encrypted-metadata.xyz/${TestDataGenerator.randomString(15)}`,
        types     : {
          note: {
            schema             : 'https://schemas.xyz/encrypted-metadata-note',
            dataFormats        : ['text/plain'],
            encryptionRequired : true,
          },
        },
        structure: { note: {} },
      };
      expect((await dwnAlice.protocols.configure({ definition: encProtocol })).status.code).toBe(202);

      const plaintext = 'metadata-only encrypted update';
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : plaintext,
        dataFormat   : 'text/plain',
        protocol     : encProtocol.protocol,
        protocolPath : 'note',
        schema       : encProtocol.types.note.schema,
      });
      expect(writeStatus.code).toBe(202);

      const originalDataCid = record!.dataCid;
      const originalEncryption = structuredClone(record!.encryption);
      const updatedRecord = await record!.update({
        tags: { state: 'reviewed' },
      });

      expect(updatedRecord).toBe(record);
      expect(updatedRecord.dataCid).toBe(originalDataCid);
      expect(updatedRecord.encryption).toEqual(originalEncryption);
      expect(await updatedRecord.data.text()).toBe(plaintext);
    });

    it('should keep updates plaintext when the protocol type requires plaintext', async () => {
      // Write a non-encrypted record
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : 'Not encrypted',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'test/plain',
        dataFormat   : 'text/plain',
      });
      expect(writeStatus.code).toBe(202);
      expect(record).toBeDefined();
      expect(record!.encryption).toBeUndefined();

      // Update — should remain non-encrypted since original was not encrypted
      const updatedRecord = await record!.update({ data: 'Still not encrypted' });
      expect(updatedRecord).toBe(record);

      // Read back to verify no encryption
      const { status: readStatus, record: readRecord } = await dwnAlice.records.read({
        filter: { recordId: record!.id },
      });
      expect(readStatus.code).toBe(200);

      const readText = await readRecord!.data.text();
      expect(readText).toBe('Still not encrypted');
      expect(readRecord!.encryption).toBeUndefined();
    });

    it('E2E: should encrypt on write and decrypt on read via API layer', async () => {
      // Define a simple protocol for encrypted notes
      const encProtocol: DwnProtocolDefinition = {
        published : true,
        protocol  : `http://encrypted-notes.xyz/${TestDataGenerator.randomString(15)}`,
        types     : {
          note: {
            schema             : 'https://schemas.xyz/note',
            dataFormats        : ['text/plain'],
            encryptionRequired : true,
          }
        },
        structure: {
          note: {}
        }
      };

      // Configure with encryption
      const { status: configStatus } = await dwnAlice.protocols.configure({
        definition: encProtocol,
      });
      expect(configStatus.code).toBe(202);

      // Write an encrypted record
      const secretText = 'This is a secret note for E2E test';
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : secretText,
        protocol     : encProtocol.protocol,
        protocolPath : 'note',
        dataFormat   : 'text/plain',
        schema       : 'https://schemas.xyz/note',
      });
      expect(writeStatus.code).toBe(202);
      expect(record).toBeDefined();
      expect(record!.encryption).toBeDefined();

      // Read back with decryption
      const { status: readStatus, record: readRecord } = await dwnAlice.records.read({
        filter: { recordId: record!.id },
      });
      expect(readStatus.code).toBe(200);
      expect(readRecord).toBeDefined();

      const decryptedText = await readRecord!.data.text();
      expect(decryptedText).toBe(secretText);

      // Query back with decryption
      const { status: queryStatus, records: queryRecords } = await dwnAlice.records.query({
        filter: { protocol: encProtocol.protocol },
      });
      expect(queryStatus.code).toBe(200);
      expect(queryRecords).toHaveLength(1);

      const queryDecryptedText = await queryRecords![0].data.text();
      expect(queryDecryptedText).toBe(secretText);
    });
  });

  describe('delete()', () => {
    let notesProtocol: DwnProtocolDefinition;

    beforeEach(async () => {
      const protocolUri = `http://example.com/notes-${TestDataGenerator.randomString(15)}`;

      notesProtocol = {
        published : true,
        protocol  : protocolUri,
        types     : {
          note: {
            schema: 'http://example.com/note'
          },
          request: {
            schema: 'http://example.com/request'
          }
        },
        structure: {
          request: {
            $actions: [{
              who : 'anyone',
              can : ['create', 'update', 'delete']
            }]
          },
          note: {
          }
        }
      };

      // alice and bob both configure the protocol
      const { status: aliceConfigStatus, protocol: aliceNotesProtocol } = await dwnAlice.protocols.configure({
        definition: notesProtocol
      });
      expect(aliceConfigStatus.code).toBe(202);
      const { status: aliceNotesProtocolSend } = await aliceNotesProtocol.send(aliceDid.uri);
      expect(aliceNotesProtocolSend.code).toBe(202);

      const { status: bobConfigStatus, protocol: bobNotesProtocol } = await dwnBob.protocols.configure({ definition: notesProtocol });
      expect(bobConfigStatus.code).toBe(202);
      const { status: bobNotesProtocolSend } = await bobNotesProtocol!.send(bobDid.uri);
      expect(bobNotesProtocolSend.code).toBe(202);

    });

    it('deletes a local record on the local DWN', async () => {
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });

      expect(writeStatus.code).toBe(202);
      expect(record).toBeDefined();

      // confirm record exists
      const { status: readStatus, record: readRecord } = await dwnAlice.records.read({
        filter: {
          recordId: record.id
        }
      });

      expect(readStatus.code).toBe(200);
      expect(readRecord).toBeDefined();
      expect(readRecord!.id).toBe(record.id);

      // delete the record
      await record.delete();
      const deletedRecord = record;

      // confirm record is in a deleted state
      expect(deletedRecord.deleted).toBe(true);

      // confirm the record has been deleted
      const readResult = await dwnAlice.records.read({
        filter: {
          recordId: record.id
        }
      });
      expect(readResult.status.code).toBe(404);
    });

    it('deletes a record on the remote DWN', async () => {
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });

      expect(writeStatus.code).toBe(202);
      expect(record).toBeDefined();

      // Write the record to Alice's remote DWN.
      await record!.send(aliceDid.uri);

      // confirm the record has been written to the remote DWN
      const readResult = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : {
          recordId: record.id
        }
      });
      expect(readResult.status.code).toBe(200);
      expect(readResult.record).toBeDefined();
      expect(readResult.record.id).toBe(record.id);

      // delete the record
      await record.delete();
      const deletedRecord = record;

      // confirm record is in a deleted state
      expect(deletedRecord.deleted).toBe(true);

      // send the delete request to the remote DWN
      await deletedRecord.send(aliceDid.uri);

      // confirm the record has been deleted
      const readResultDeleted = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : {
          recordId: record.id
        }
      });
      expect(readResultDeleted.status.code).toBe(404);
    });

    it('deletes a record and prunes its children on the local DWN', async () => {
      // Install a protocol that supports parent-child relationships.
      const { status: protocolStatus, protocol } = await dwnAlice.protocols.configure({
        definition: {
          protocol  : 'http://example.com/parent-child',
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
      expect(protocolStatus.code).toBe(202);

      // Write a parent record.
      const { status: parentWriteStatus, record: parentRecord } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : protocol.definition.protocol,
        protocolPath : 'foo',
        schema       : 'http://example.com/foo',
        dataFormat   : 'text/plain'
      });
      expect(parentWriteStatus.code).toBe(202);
      expect(parentRecord).toBeDefined();

      // Write a child record.
      const { status: child1WriteStatus, record: child1Record } = await dwnAlice.records.write({
        data            : 'Hello, world!',
        protocol        : protocol.definition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'http://example.com/bar',
        dataFormat      : 'text/plain',
        parentContextId : parentRecord.contextId
      });
      expect(child1WriteStatus.code).toBe(202);
      expect(child1Record).toBeDefined();

      // Write a second child record.
      const { status: child2WriteStatus, record: child2Record } = await dwnAlice.records.write({
        data            : 'Hello, world!',
        protocol        : protocol.definition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'http://example.com/bar',
        dataFormat      : 'text/plain',
        parentContextId : parentRecord.contextId
      });
      expect(child2WriteStatus.code).toBe(202);
      expect(child2Record).toBeDefined();

      // query for child records to confirm it exists
      const { status: childrenStatus, records: childrenRecords } = await dwnAlice.records.query({
        filter: {
          contextId    : parentRecord.contextId,
          protocol     : protocol.definition.protocol,
          protocolPath : 'foo/bar'
        }
      });
      expect(childrenStatus.code).toBe(200);
      expect(childrenRecords).toBeDefined();
      expect(childrenRecords).toHaveLength(2);
      expect(childrenRecords.map(r => r.id)).toEqual(expect.arrayContaining([child1Record.id, child2Record.id]));

      // Delete the parent record and its children.
      await parentRecord.delete({ prune: true });
      expect(parentRecord.deleted).toBe(true);

      // query for child records to confirm it was deleted
      const { status: childrenStatusAfterDelete, records: childrenRecordsAfterDelete } = await dwnAlice.records.query({
        filter: {
          contextId    : parentRecord.contextId,
          protocol     : protocol.definition.protocol,
          protocolPath : 'foo/bar'
        }
      });
      expect(childrenStatusAfterDelete.code).toBe(200);
      expect(childrenRecordsAfterDelete).toBeDefined();
      expect(childrenRecordsAfterDelete).toHaveLength(0);
    });

    it('deletes a record and prunes its children on the remote DWN', async () => {
      // Install a protocol that supports parent-child relationships.
      const { status: protocolStatus, protocol } = await dwnAlice.protocols.configure({
        definition: {
          protocol  : 'http://example.com/parent-child',
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
      expect(protocolStatus.code).toBe(202);
      const { status: protocolSendStatus } = await protocol.send(aliceDid.uri);
      expect(protocolSendStatus.code).toBe(202);

      // Write a parent record.
      const { status: parentWriteStatus, record: parentRecord } = await dwnAlice.records.write({
        store        : false,
        data         : 'Hello, world!',
        protocol     : protocol.definition.protocol,
        protocolPath : 'foo',
        schema       : 'http://example.com/foo',
        dataFormat   : 'text/plain'
      });
      expect(parentWriteStatus.code).toBe(202);
      expect(parentRecord).toBeDefined();
      await parentRecord.send(aliceDid.uri);

      // Write a child record.
      const { status: child1WriteStatus, record: childRecord1 } = await dwnAlice.records.write({
        store           : false,
        data            : 'Hello, world!',
        protocol        : protocol.definition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'http://example.com/bar',
        dataFormat      : 'text/plain',
        parentContextId : parentRecord.contextId
      });
      expect(child1WriteStatus.code).toBe(202);
      expect(childRecord1).toBeDefined();
      await childRecord1.send(aliceDid.uri);

      // Write a second child record.
      const { status: child2WriteStatus, record: childRecord2 } = await dwnAlice.records.write({
        store           : false,
        data            : 'Hello, world!',
        protocol        : protocol.definition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'http://example.com/bar',
        dataFormat      : 'text/plain',
        parentContextId : parentRecord.contextId
      });
      expect(child2WriteStatus.code).toBe(202);
      expect(childRecord2).toBeDefined();
      await childRecord2.send(aliceDid.uri);

      // query for child records to confirm it exists
      const { status: childrenStatus, records: childrenRecords } = await dwnAlice.records.query({
        from   : aliceDid.uri,
        filter : {
          contextId    : parentRecord.contextId,
          protocol     : protocol.definition.protocol,
          protocolPath : 'foo/bar'
        }
      });
      expect(childrenStatus.code).toBe(200);
      expect(childrenRecords).toBeDefined();
      expect(childrenRecords).toHaveLength(2);
      expect(childrenRecords.map(r => r.id)).toEqual(expect.arrayContaining([childRecord1.id, childRecord2.id]));

      // Delete the parent record and its children.
      await parentRecord.delete({ store: false, prune: true });
      const deletedParentRecord = parentRecord;
      expect(deletedParentRecord.deleted).toBe(true);
      await deletedParentRecord.send(aliceDid.uri);

      // query for child records to confirm it was deleted
      const { status: childrenStatusAfterDelete, records: childrenRecordsAfterDelete } = await dwnAlice.records.query({
        from   : aliceDid.uri,
        filter : {
          contextId    : parentRecord.contextId,
          protocol     : protocol.definition.protocol,
          protocolPath : 'foo/bar'
        }
      });
      expect(childrenStatusAfterDelete.code).toBe(200);
      expect(childrenRecordsAfterDelete).toBeDefined();
      expect(childrenRecordsAfterDelete).toHaveLength(0);
    });

    it('throws if a record status is deleted and initialWrite is not set', async () => {
      // create a record but do not store it
      const { status: writeStatus, record } = await dwnAlice.records.write({
        store        : false,
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });
      expect(writeStatus.code).toBe(202);

      // delete the record but do not store it
      await record.delete({ store: false });
      const deletedRecord = record;

      // purposefully delete the _initialWrite property
      delete deletedRecord['_initialWrite'];

      // store the record
      try {
        await deletedRecord.delete();
        throw new Error('Should have failed because the initial write is not set');
      } catch (error: any) {
        expect(error.message).toContain('Record: Record is in an invalid state, initial write is missing.');
      }
    });

    it('throws a conflict for a duplicate delete with store', async () => {
      // create a record
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });
      expect(writeStatus.code).toBe(202);

      // confirm record exists
      const { status: readStatus, record: readRecord } = await dwnAlice.records.read({
        filter: {
          recordId: record.id
        }
      });
      expect(readStatus.code).toBe(200);
      expect(readRecord).toBeDefined();
      expect(readRecord!.id).toBe(record.id);

      // delete the record
      await record.delete();
      const deletedRecord = record;
      expect(deletedRecord.deleted).toBe(true);

      // attempting to delete again is beaten by the standing tombstone: 409 Conflict
      try {
        await deletedRecord.delete();
        throw new Error('Expected the standing tombstone to reject the second delete.');
      } catch (error) {
        expect(error).toBeInstanceOf(DwnResponseError);
        expect((error as DwnResponseError).status.code).toBe(409);
      }
    });

    it('escalates a deleted record to a prune instead of resending the cached tombstone', async () => {
      // create a record
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });
      expect(writeStatus.code).toBe(202);

      // plain delete first
      await record.delete();
      const deletedRecord = record;
      expect(deletedRecord.deleted).toBe(true);

      // requesting a prune constructs a new tombstone that beats the standing plain delete
      // (prune dominates plain in the tombstone lattice), rather than resending the cached
      // message and failing with a 409
      await deletedRecord.delete({ prune: true });
      const prunedRecord = deletedRecord;
      expect(prunedRecord.deleted).toBe(true);

      // a repeated prune request reuses the cached prune tombstone and is beaten: 409
      try {
        await prunedRecord.delete({ prune: true });
        throw new Error('Expected the standing prune tombstone to reject the second prune.');
      } catch (error) {
        expect(error).toBeInstanceOf(DwnResponseError);
        expect((error as DwnResponseError).status.code).toBe(409);
      }
    });

    it('re-stamps a pruned record without downgrading its tombstone class', async () => {
      // create and prune a record
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });
      expect(writeStatus.code).toBe(202);
      await record.delete({ prune: true });
      const prunedRecord = record;

      // a timestamp-only re-stamp inherits the cached tombstone's prune class — constructing a
      // plain delete here would be beaten by the standing prune as a 409
      const newerTimestamp = Time.createOffsetTimestamp({ seconds: 1 });
      await prunedRecord.delete({ timestamp: newerTimestamp });
      const restampedRecord = prunedRecord;
      expect(restampedRecord.deleted).toBe(true);
      expect((restampedRecord.rawMessage as DwnMessage[DwnInterface.RecordsDelete]).descriptor.prune).toBe(true);

      // an explicitly OLDER timestamp constructs a tombstone that is beaten: 409
      const olderTimestamp = Time.createOffsetTimestamp({ seconds: -60 });
      try {
        await restampedRecord.delete({ timestamp: olderTimestamp });
        throw new Error('Expected an older tombstone to be rejected.');
      } catch (error) {
        expect(error).toBeInstanceOf(DwnResponseError);
        expect((error as DwnResponseError).status.code).toBe(409);
      }
    });

    it('a record in a deleted state returns undefined for data related fields', async () => {
      // create a record
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'http://example.org/test-schema',
        dataFormat   : 'text/plain'
      });
      expect(writeStatus.code).toBe(202);
      expect(record).toBeDefined();

      // check for data related properties
      expect(record.dataFormat).toBe('text/plain');
      expect(record.dataCid).toBeDefined();
      expect(record.dataSize).toBeDefined();
      expect(await record.data.text()).toBe('Hello, world!');

      // sanity: check immutable properties
      const recordId = record.id;
      expect(recordId).toBeDefined();
      const schema = record.schema;
      expect(schema).toBe('http://example.org/test-schema');
      const dateCreated = record.dateCreated;
      expect(dateCreated).toBeDefined();

      // sanity: check timestamp
      const timestamp = record.timestamp;
      expect(timestamp).toBeDefined();

      // delete the record
      await record.delete();
      const deletedRecord = record;

      // sanity: should be unchanged
      expect(deletedRecord.id).toBe(recordId);
      expect(deletedRecord.dateCreated).toBe(dateCreated);
      expect(deletedRecord.schema).toBe(schema);

      // timestamp should be greater than the initial timestamp
      expect(Date.parse(deletedRecord.timestamp)).toBeGreaterThan(Date.parse(timestamp));

      // check for undefined data related properties
      expect(deletedRecord.dataFormat).toBeUndefined();
      expect(deletedRecord.dataCid).toBeUndefined();
      expect(deletedRecord.dataSize).toBeUndefined();

      try {
        await deletedRecord.data.text();
        throw new Error('Expected an exception to be thrown');
      } catch (error:any) {
        expect(error.message).toContain('Cannot access data of a deleted record.');
      }
    });

    it('deletes a record from someone else', async () => {
      // bob writes a record for alice, alice deletes it and stores it
      const { status: bobWriteStatus, record: bobWriteRecord } = await dwnBob.records.write({
        data         : 'Hello, world!',
        recipient    : aliceDid.uri,
        protocol     : notesProtocol.protocol,
        protocolPath : 'request',
        schema       : notesProtocol.types.request.schema,
        dataFormat   : 'text/plain'
      });
      expect(bobWriteStatus.code).toBe(202);

      // send the record to alice's DWN
      await bobWriteRecord.send(aliceDid.uri);

      let bobsRecordToDelete: Record | undefined;
      await Poller.pollUntilSuccessOrTimeout(async () => {
        const { records } = await dwnAlice.records.query({
          from   : aliceDid.uri,
          filter : { protocol: notesProtocol.protocol, recordId: bobWriteRecord.id },
        });
        bobsRecordToDelete = records[0];
        expect(bobsRecordToDelete?.id).toBe(bobWriteRecord.id);
      });

      expect(bobsRecordToDelete!.deleted).toBe(false);
      expect(bobsRecordToDelete!.author).toBe(bobDid.uri);

      await bobsRecordToDelete!.delete();
      const deletedBobRecord = bobsRecordToDelete!;
      expect(deletedBobRecord.deleted).toBe(true);
      expect(deletedBobRecord.author).toBe(aliceDid.uri);
    });

    it('deletes a record as owner from someone else', async () => {
      // bob writes a record for alice, alice deletes it and stores it
      const { status: bobWriteStatus, record: bobWriteRecord } = await dwnBob.records.write({
        data         : 'Hello, world!',
        recipient    : aliceDid.uri,
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema,
        dataFormat   : 'text/plain'
      });
      expect(bobWriteStatus.code).toBe(202);

      // send the record to alice's DWN
      await bobWriteRecord.send(bobDid.uri);

      let bobsRecordToDelete: Record | undefined;
      await Poller.pollUntilSuccessOrTimeout(async () => {
        const { records } = await dwnAlice.records.query({
          from   : bobDid.uri,
          filter : { protocol: notesProtocol.protocol, recordId: bobWriteRecord.id },
        });
        bobsRecordToDelete = records[0];
        expect(bobsRecordToDelete?.id).toBe(bobWriteRecord.id);
      });

      expect(bobsRecordToDelete!.deleted).toBe(false);

      await bobsRecordToDelete!.delete({ signAsOwner: true });
      const deletedBobRecord = bobsRecordToDelete!;
      expect(deletedBobRecord.deleted).toBe(true);
    });

    it('deletes a record using a different protocolRole than the one used when querying for/reading the record', async () => {
      // scenario: Bob has a notes protocol that has friends who can read/query/subscribe to notes, but coAuthors that can update/delete notes.
      // When Alice uses her friend role to query for notes, she cannot delete them with that same role. Instead she uses her coAuthor role to delete.

      const protocol = {
        ...notesProtocolDefinition,
        protocol: 'http://example.com/notes' + TestDataGenerator.randomString(15)
      };

      // Bob configures the notes protocol for himself
      const { status: bobProtocolStatus, protocol: bobProtocol } = await dwnBob.protocols.configure({
        definition: protocol
      });
      expect(bobProtocolStatus.code).toBe(202);
      const { status: bobProtocolSendStatus } = await bobProtocol.send(bobDid.uri);
      expect(bobProtocolSendStatus.code).toBe(202);

      // Alice must also configure the protocol to make updates.
      // NOTE: This is not desireable and there is an issue to address this:
      // https://github.com/enboxorg/enbox/issues/955
      const { status: aliceProtocolStatus, protocol: aliceProtocol } = await dwnAlice.protocols.configure({
        definition: protocol
      });
      expect(aliceProtocolStatus.code).toBe(202);
      const { status: aliceProtocolSend } = await aliceProtocol.send(aliceDid.uri);
      expect(aliceProtocolSend.code).toBe(202);

      // Bob creates a few notes ensuring that the data is larger than the max encoded size
      // that way the data will be requested with a separate `read` request
      const records: Set<string> = new Set();
      for (let i = 0; i < 3; i++) {
        const data = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
        const { status: noteCreateStatus, record: noteRecord } = await dwnBob.records.write({
          data,
          protocol     : protocol.protocol,
          protocolPath : 'note',
          schema       : protocol.types.note.schema,
          dataFormat   : 'text/plain',
        });
        expect(noteCreateStatus.code).toBe(202);
        await noteRecord.send();
        records.add(noteRecord.id);
      }

      // Bob makes Alice a `friend` to allow her to read and comment on his notes
      const { status: friendCreateStatus, record: friendRecord } = await dwnBob.records.write({
        data         : 'friend!',
        recipient    : aliceDid.uri,
        protocol     : protocol.protocol,
        protocolPath : 'friend',
        schema       : protocol.types.friend.schema,
        dataFormat   : 'text/plain'
      });
      expect(friendCreateStatus.code).toBe(202);
      await friendRecord.send(bobDid.uri);

      // Bob makes alice a 'coAuthor' of one of his notes
      const aliceCoAuthorNoteId = records.keys().next().value;
      const { status: coAuthorStatus, record: coAuthorRecord } = await dwnBob.records.write({
        data            : aliceDid.uri,
        parentContextId : aliceCoAuthorNoteId,
        recipient       : aliceDid.uri,
        protocol        : protocol.protocol,
        protocolPath    : 'note/coAuthor',
        schema          : protocol.types.coAuthor.schema,
        dataFormat      : 'text/plain'
      });
      expect(coAuthorStatus.code).toBe(202);
      await coAuthorRecord.send(bobDid.uri);

      // Alice querying for bob's notes using her friend role
      const { status: aliceQueryStatus, records: bobNotesAliceQuery } = await dwnAlice.records.query({
        from         : bobDid.uri,
        protocolRole : 'friend',
        filter       : {
          protocol     : protocol.protocol,
          protocolPath : 'note',
        }
      });
      expect(aliceQueryStatus.code).toBe(200);
      expect(bobNotesAliceQuery).toBeDefined();
      expect(bobNotesAliceQuery).toHaveLength(records.size);

      // Alice looks for the record she has a co-author rule on
      const coDeleteNote = bobNotesAliceQuery.find((record) => record.id === aliceCoAuthorNoteId);
      expect(coDeleteNote).toBeDefined();

      // spy on sendDwnRequest to ensure that the protocolRole is used to read the data of the notes
      const sendDwnRequestSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');

      // confirm that it starts with 0 calls
      expect(sendDwnRequestSpy.callCount).toBe(0);

      await coDeleteNote.delete({ store: false });
      const deletedNote = coDeleteNote;

      try {
        await deletedNote.send(bobDid.uri);
        throw new Error('Expected the friend role delete to be rejected.');
      } catch (error) {
        expect(error).toBeInstanceOf(DwnResponseError);
        expect((error as DwnResponseError).status.code).toBe(401);
      }

      expect(sendDwnRequestSpy.callCount).toBe(2); // the first call is for the initialWrite
      let record = (sendDwnRequestSpy.secondCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsWrite>).rawMessage;
      let sendAuthorizationRole = getRecordProtocolRole(record);
      expect(sendAuthorizationRole).toBe('friend');

      sendDwnRequestSpy.resetHistory();

      // Now delete the record with the correct role
      await deletedNote.delete({ protocolRole: 'note/coAuthor', store: false });
      const deletedNoteCoAuthor = deletedNote;

      await deletedNoteCoAuthor.send(bobDid.uri);

      expect(sendDwnRequestSpy.callCount).toBe(1); // the initialWrite was already sent and added to the sent-cache, only the update is sent
      record = (sendDwnRequestSpy.firstCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsWrite>).rawMessage;
      sendAuthorizationRole = getRecordProtocolRole(record);
      expect(sendAuthorizationRole).toBe('note/coAuthor');
    });
  });

  describe('store()', () => {
    let notesProtocol: DwnProtocolDefinition;

    beforeEach(async () => {
      const protocolUri = `http://example.com/notes-${TestDataGenerator.randomString(15)}`;
      notesProtocol = {
        published : true,
        protocol  : protocolUri,
        types     : {
          note: {
            schema: 'http://example.com/note'
          },
          request: {
            schema: 'http://example.com/request'
          },
        },
        structure: {
          request: {
            $actions: [{
              who : 'anyone',
              can : ['create', 'update', 'delete']
            }]
          },
          note: {
          }
        }
      };

      // alice and bob both configure the protocol
      const { status: aliceConfigStatus, protocol: aliceNotesProtocol } = await dwnAlice.protocols.configure({
        definition: notesProtocol
      });
      expect(aliceConfigStatus.code).toBe(202);
      const { status: aliceNotesProtocolSend } = await aliceNotesProtocol.send(aliceDid.uri);
      expect(aliceNotesProtocolSend.code).toBe(202);

      const { status: bobConfigStatus, protocol: bobNotesProtocol } = await dwnBob.protocols.configure({ definition: notesProtocol });
      expect(bobConfigStatus.code).toBe(202);
      const { status: bobNotesProtocolSend } = await bobNotesProtocol!.send(bobDid.uri);
      expect(bobNotesProtocolSend.code).toBe(202);
    });

    it('should store an external record if it has been imported by the dwn owner', async () => {
      // Scenario: Alice creates a record.
      //           Bob queries for the record from Alice's DWN and then stores it to their own DWN.

      // alice creates a record and sends it to their DWN
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        published    : true,
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema
      });
      expect(status.code).toBe(202, status.detail);
      await record.send();

      // Bob queries Alice's DWN for the record.
      const aliceQueryResult = await dwnBob.records.query({
        from   : aliceDid.uri,
        filter : {
          recordId: record.id
        }
      });
      expect(aliceQueryResult.status.code).toBe(200);
      expect(aliceQueryResult.records).toHaveLength(1);
      const queriedRecord = aliceQueryResult.records[0];

      // Bob queries his own DWN for the record, which should not return any results.
      let bobQueryResult = await dwnBob.records.query({
        filter: {
          recordId: record.id
        }
      });
      expect(bobQueryResult.status.code).toBe(200);
      expect(bobQueryResult.records).toHaveLength(0);

      // Attempts to store the record without importing it, which should fail.
      try {
        await queriedRecord.store();
        throw new Error('Expected storing an external record without importing it to fail.');
      } catch (error) {
        expect(error).toBeInstanceOf(DwnResponseError);
        expect((error as DwnResponseError).status.code).toBe(401);
      }

      // Attempts to store the record flagging it for import.
      await queriedRecord.store(true);

      // Bob queries his own DWN for the record, which should return the record.
      bobQueryResult = await dwnBob.records.query({
        filter: {
          recordId: record.id
        }
      });
      expect(bobQueryResult.status.code).toBe(200);
      expect(bobQueryResult.records).toHaveLength(1);
      const storedRecord = bobQueryResult.records[0];
      expect(storedRecord.id).toBe(record.id);
    });

    it('stores an updated record to the local DWN along with the initial write', async () => {
      // Scenario: Alice creates a record and then updates it.
      //           Bob queries for the record from Alice's DWN and then stores the updated record along with it's initial write.

      // Alice creates a public record then sends it to her remote DWN.
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        published    : true,
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema
      });
      expect(status.code).toBe(202, status.detail);
      const updatedText = 'updated text';
      const updatedRecord = await record!.update({ data: updatedText });
      expect(updatedRecord).toBe(record);

      await updatedRecord.send();

      // Bob queries for the record from his own node, should not return any results
      let queryResult = await dwnBob.records.query({
        filter: {
          recordId: record.id
        }
      });
      expect(queryResult.status.code).toBe(200);
      expect(queryResult.records).toHaveLength(0);

      // Bob queries for the record from Alice's remote DWN.
      const queryResultFromAlice = await dwnBob.records.query({
        from   : aliceDid.uri,
        filter : {
          recordId: record.id
        }
      });
      expect(queryResultFromAlice.status.code).toBe(200);
      expect(queryResultFromAlice.records).toHaveLength(1);
      const queriedRecord = queryResultFromAlice.records[0];
      expect(await queriedRecord.data.text()).toBe(updatedText);

      // Attempts to store the record without signing it, which should fail.
      try {
        await queriedRecord.store();
        throw new Error('Expected storing an unsigned external update to fail.');
      } catch (error) {
        expect(error).toBeInstanceOf(DwnResponseError);
        expect((error as DwnResponseError).status.code).toBe(400);
        expect((error as DwnResponseError).status.detail).toContain(DwnErrorCode.RecordsWriteGetInitialWriteNotFound);
      }

      // Stores the record in Bob's DWN, the importRecord parameter is set to true so that Bob
      // signs the record before storing it.
      await queriedRecord.store(true);

      // The record should now exist on Bob's DWN.
      queryResult = await dwnBob.records.query({
        filter: {
          recordId: record.id
        }
      });
      expect(queryResult.status.code).toBe(200);
      expect(queryResult.records).toHaveLength(1);
      const storedRecord = queryResult.records[0];
      expect(storedRecord.id).toBe(record!.id);
      expect(await storedRecord.data.text()).toBe(updatedText);
    });

    it('stores a deleted record to the local DWN along with the initial write', async () => {
      // spy on the processMessage method to confirm it is called twice by the `store()` method
      // once for the initial write and once for the delete
      const processMessageSpy = sinon.spy(testHarness.dwn, 'processMessage');

      // create a record
      const { status: writeStatus, record } = await dwnAlice.records.write({
        store        : false,
        data         : 'Hello, world!',
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema
      });
      expect(writeStatus.code).toBe(202);
      expect(record).toBeDefined();

      // delete the record without storing
      await record.delete({ store: false });
      const deletedRecord = record;

      // check that the record is in a deleted state
      expect(deletedRecord.deleted).toBe(true);

      const storedRecordCallCount = (): number => processMessageSpy.getCalls()
        .filter((call): boolean =>
          isDwnMessage(DwnInterface.RecordsWrite, call.args[1]) ||
          isDwnMessage(DwnInterface.RecordsDelete, call.args[1])
        ).length;

      // Policy resolution may query the local DWN, but neither record message
      // has been stored yet.
      expect(storedRecordCallCount()).toBe(0);

      // store the record
      await deletedRecord.store();

      // check that it was called once for initial write and once for the delete
      expect(storedRecordCallCount()).toBe(2);
    });

    it('stores an externally signed deleted record as the owner', async () => {
      const { status: writeStatus, record } = await dwnBob.records.write({
        data         : 'Hello, world!',
        recipient    : aliceDid.uri,
        protocol     : notesProtocol.protocol,
        protocolPath : 'request',
        schema       : notesProtocol.types.request.schema,
      });
      expect(writeStatus.code).toBe(202);

      await record.delete();
      const deletedRecord = record;

      const receivedRecord = rehydrateExternalDeletedRecordForAlice(deletedRecord);
      expect(receivedRecord.deleted).toBe(true);

      await receivedRecord.store(true);

      const readResult = await dwnAlice.records.read({ filter: { recordId: receivedRecord.id } });
      expect(readResult.status.code).toBe(404);
    });

  });

  describe('import()', () => {
    let notesProtocol: DwnProtocolDefinition;

    beforeEach(async () => {
      const protocolUri = `https://example.com/protocol/${TestDataGenerator.randomString(15)}`;
      notesProtocol = {
        published : true,
        protocol  : protocolUri,
        types     : {
          note: {
            schema: 'http://example.com/note'
          },
          request: {
            schema: 'http://example.com/request'
          }
        },
        structure: {
          request: {
            $actions: [{
              who : 'anyone',
              can : ['create', 'update', 'delete']
            }]
          },
          note: {
          }
        }
      };

      // alice and bob both configure the protocol
      const { status: aliceConfigStatus, protocol: aliceNotesProtocol } = await dwnAlice.protocols.configure({
        definition: notesProtocol
      });
      expect(aliceConfigStatus.code).toBe(202);
      const { status: aliceNotesProtocolSend } = await aliceNotesProtocol.send(aliceDid.uri);
      expect(aliceNotesProtocolSend.code).toBe(202);

      const { status: bobConfigStatus, protocol: bobNotesProtocol } = await dwnBob.protocols.configure({ definition: notesProtocol });
      expect(bobConfigStatus.code).toBe(202);
      const { status: bobNotesProtocolSend } = await bobNotesProtocol!.send(bobDid.uri);
      expect(bobNotesProtocolSend.code).toBe(202);

    });

    it('should import an external record without storing it', async () => {
      // Scenario: Alice creates a record.
      //           Bob queries for the record from Alice's DWN and then imports it without storing
      //           Bob then .stores() it without specifying import explicitly as it's already been imported.

      // Alice creates a record and sends it to her DWN.
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        published    : true,
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema,
      });
      expect(status.code).toBe(202, status.detail);
      await record.send();

      // Bob queries Alice's DWN for the record.
      const aliceQueryResult = await dwnBob.records.query({
        from   : aliceDid.uri,
        filter : {
          recordId: record.id
        }
      });
      expect(aliceQueryResult.status.code).toBe(200);
      expect(aliceQueryResult.records).toHaveLength(1);
      const queriedRecord = aliceQueryResult.records[0];

      // Imports the record without storing it.
      await queriedRecord.import();

      // Bob queries his own DWN for the record, which should return the record.
      const bobQueryResult = await dwnBob.records.query({
        filter: {
          recordId: record.id
        }
      });
      expect(bobQueryResult.status.code).toBe(200);
      expect(bobQueryResult.records).toHaveLength(1);
      const storedRecord = bobQueryResult.records[0];
      expect(storedRecord.id).toBe(record.id);
    });

    it('import an external record along with the initial write', async () => {
      // Scenario: Alice creates a record and then updates it.
      //           Bob queries for the record from Alice's DWN and then stores the updated record along with it's initial write.

      // Alice creates a public record then sends it to her remote DWN.
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        published    : true,
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema,
      });
      expect(status.code).toBe(202, status.detail);
      const updatedText = 'updated text';
      const updatedRecord = await record!.update({ data: updatedText });
      expect(updatedRecord).toBe(record);
      await updatedRecord.send();

      // Bob queries Alice's DWN for the record.
      const aliceQueryResult = await dwnBob.records.query({
        from   : aliceDid.uri,
        filter : {
          recordId: record.id
        }
      });
      expect(aliceQueryResult.status.code).toBe(200);
      expect(aliceQueryResult.records).toHaveLength(1);
      const queriedRecord = aliceQueryResult.records[0];

      // Imports the record without storing it.
      await queriedRecord.import();

      // Bob queries his own DWN for the record, which should return the record.
      const bobQueryResult = await dwnBob.records.query({
        filter: {
          recordId: record.id
        }
      });
      expect(bobQueryResult.status.code).toBe(200);
      expect(bobQueryResult.records).toHaveLength(1);
      const storedRecord = bobQueryResult.records[0];
      expect(storedRecord.id).toBe(record.id);
    });

    it('signs and imports an externally signed deleted record as the owner', async () => {
      const { status: writeStatus, record } = await dwnBob.records.write({
        data         : 'Hello, world!',
        dataFormat   : 'text/plain',
        recipient    : aliceDid.uri,
        protocol     : notesProtocol.protocol,
        protocolPath : 'request',
        schema       : notesProtocol.types.request.schema,
      });
      expect(writeStatus.code).toBe(202);

      await record.delete();
      const deletedRecord = record;

      const receivedRecord = rehydrateExternalDeletedRecordForAlice(deletedRecord);
      expect(receivedRecord.deleted).toBe(true);

      await receivedRecord.import();

      const readResult = await dwnAlice.records.read({ filter: { recordId: receivedRecord.id } });
      expect(readResult.status.code).toBe(404);
    });


    describe('store: false', () => {
      it('should import an external record without storing it', async () => {
        // Scenario: Alice creates a record.
        //           Bob queries for the record from Alice's DWN and then imports it without storing
        //           Bob then .stores() it without specifying import explicitly as it's already been imported.

        // Alice creates a record and sends it to her DWN.
        const { status, record } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          published    : true,
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
          schema       : notesProtocol.types.note.schema
        });
        expect(status.code).toBe(202, status.detail);
        await record.send();

        // Bob queries Alice's DWN for the record.
        const aliceQueryResult = await dwnBob.records.query({
          from   : aliceDid.uri,
          filter : {
            recordId: record.id
          }
        });
        expect(aliceQueryResult.status.code).toBe(200);
        expect(aliceQueryResult.records).toHaveLength(1);
        const queriedRecord = aliceQueryResult.records[0];

        // Imports the record without storing it.
        await queriedRecord.import(false);

        // Queries for the record from Bob's DWN, which should not return any results.
        let bobQueryResult = await dwnBob.records.query({
          filter: {
            recordId: record.id
          }
        });
        expect(bobQueryResult.status.code).toBe(200);
        expect(bobQueryResult.records).toHaveLength(0);

        // Attempts to store the record without explicitly marking it for import as it's already
        // been imported
        await queriedRecord.store();

        // Bob queries his own DWN for the record, which should return the record.
        bobQueryResult = await dwnBob.records.query({
          filter: {
            recordId: record.id
          }
        });
        expect(bobQueryResult.status.code).toBe(200);
        expect(bobQueryResult.records).toHaveLength(1);
        const storedRecord = bobQueryResult.records[0];
        expect(storedRecord.id).toBe(record.id);
      });

      it('import an external record along with the initial write', async () => {
        // Scenario: Alice creates a record and then updates it.
        //           Bob queries for the record from Alice's DWN and then stores the updated record along with it's initial write.

        // Alice creates a public record then sends it to her remote DWN.
        const { status, record } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          published    : true,
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
          schema       : notesProtocol.types.note.schema
        });
        expect(status.code).toBe(202, status.detail);
        const updatedText = 'updated text';
        const updatedRecord = await record.update({ data: updatedText });
        expect(updatedRecord).toBe(record);
        await updatedRecord.send();

        // Bob queries Alice's DWN for the record.
        const aliceQueryResult = await dwnBob.records.query({
          from   : aliceDid.uri,
          filter : {
            recordId: record.id
          }
        });
        expect(aliceQueryResult.status.code).toBe(200);
        expect(aliceQueryResult.records).toHaveLength(1);
        const queriedRecord = aliceQueryResult.records[0];

        // Imports the record without storing it.
        await queriedRecord.import(false);

        // Queries for the record from Bob's DWN, which should not return any results.
        let bobQueryResult = await dwnBob.records.query({
          filter: {
            recordId: record.id
          }
        });
        expect(bobQueryResult.status.code).toBe(200);
        expect(bobQueryResult.records).toHaveLength(0);

        // Attempts to store the record without explicitly marking it for import as it's already been imported.
        await queriedRecord.store();

        // Bob queries his own DWN for the record, which should return the record.
        bobQueryResult = await dwnBob.records.query({
          filter: {
            recordId: record.id
          }
        });
        expect(bobQueryResult.status.code).toBe(200);
        expect(bobQueryResult.records).toHaveLength(1);
        const storedRecord = bobQueryResult.records[0];
        expect(storedRecord.id).toBe(record.id);
      });

      it('signs an externally deleted record before storing it as the owner', async () => {
        const { status: writeStatus, record } = await dwnBob.records.write({
          data         : 'Hello, world!',
          dataFormat   : 'text/plain',
          recipient    : aliceDid.uri,
          protocol     : notesProtocol.protocol,
          protocolPath : 'request',
          schema       : notesProtocol.types.request.schema,
        });
        expect(writeStatus.code).toBe(202);

        await record.delete();
        const deletedRecord = record;

        const receivedRecord = rehydrateExternalDeletedRecordForAlice(deletedRecord);
        expect(receivedRecord.deleted).toBe(true);

        const processMessageSpy = sinon.spy(testHarness.dwn, 'processMessage');
        const storedRecordCallCount = (): number => processMessageSpy.getCalls()
          .filter((call): boolean =>
            isDwnMessage(DwnInterface.RecordsWrite, call.args[1]) ||
            isDwnMessage(DwnInterface.RecordsDelete, call.args[1])
          ).length;

        await receivedRecord.import(false);
        expect(storedRecordCallCount()).toBe(0);

        await receivedRecord.store();
        expect(storedRecordCallCount()).toBe(2);

        const readResult = await dwnAlice.records.read({ filter: { recordId: receivedRecord.id } });
        expect(readResult.status.code).toBe(404);
      });

    });
  });

  describe('paginationCursor', () => {
    it('should return a cursor for pagination', async () => {
      // Create a record that is not published.
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
        schema       : protocolDefinition.types.thread.schema
      });

      expect(status.code).toBe(202);
      const messageCid = await Message.getCid(record['rawMessage']);

      const paginationCursorCreatedAscending = await record.paginationCursor(DwnDateSort.CreatedAscending);
      expect(paginationCursorCreatedAscending).toEqual({
        messageCid,
        value: record.dateCreated,
      });

      const paginationCursorCreatedDescending = await record.paginationCursor(DwnDateSort.CreatedDescending);
      expect(paginationCursorCreatedDescending).toEqual({
        messageCid,
        value: record.dateCreated,
      });

      const paginationCursorUpdatedAscending = await record.paginationCursor(DwnDateSort.UpdatedAscending);
      expect(paginationCursorUpdatedAscending).toEqual({
        messageCid,
        value: record.timestamp,
      });

      const paginationCursorUpdatedDescending = await record.paginationCursor(DwnDateSort.UpdatedDescending);
      expect(paginationCursorUpdatedDescending).toEqual({
        messageCid,
        value: record.timestamp,
      });
    });

    it('should continue updated-date pagination from a record cursor', async () => {
      const { status: firstStatus, record: firstRecord } = await dwnAlice.records.write({
        data             : 'first record',
        dateCreated      : '2025-01-01T00:00:00.000000Z',
        messageTimestamp : '2025-01-01T00:00:00.000000Z',
        protocol         : protocolDefinition.protocol,
        protocolPath     : 'thread',
        schema           : protocolDefinition.types.thread.schema
      });
      expect(firstStatus.code).toBe(202);

      const { status: secondStatus, record: secondRecord } = await dwnAlice.records.write({
        data             : 'second record',
        dateCreated      : '2025-01-02T00:00:00.000000Z',
        messageTimestamp : '2025-01-02T00:00:00.000000Z',
        protocol         : protocolDefinition.protocol,
        protocolPath     : 'thread',
        schema           : protocolDefinition.types.thread.schema
      });
      expect(secondStatus.code).toBe(202);

      const firstUpdatedRecord = await firstRecord.update({
        data      : 'first record updated last',
        timestamp : '2025-01-04T00:00:00.000000Z'
      });
      expect(firstUpdatedRecord).toBe(firstRecord);

      const secondUpdatedRecord = await secondRecord.update({
        data      : 'second record updated first',
        timestamp : '2025-01-03T00:00:00.000000Z'
      });
      expect(secondUpdatedRecord).toBe(secondRecord);

      const filter = {
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
        schema       : protocolDefinition.types.thread.schema
      };

      const cases = [
        { dateSort: DwnDateSort.UpdatedAscending, recordIds: [secondRecord.id, firstRecord.id] },
        { dateSort: DwnDateSort.UpdatedDescending, recordIds: [firstRecord.id, secondRecord.id] },
      ];
      for (const { dateSort, recordIds } of cases) {
        const firstPage = await dwnAlice.records.query({
          dateSort,
          filter,
          pagination: { limit: 1 }
        });
        expect(firstPage.status.code).toBe(200);
        expect(firstPage.records.map(record => record.id)).toEqual([recordIds[0]]);
        expect(firstPage.cursor).toBeDefined();

        const recordCursor = await firstPage.records[0].paginationCursor(dateSort);
        expect(recordCursor).toEqual(firstPage.cursor);

        const [recordCursorPage, queryCursorPage] = await Promise.all([
          dwnAlice.records.query({
            dateSort,
            filter,
            pagination: { cursor: recordCursor, limit: 1 }
          }),
          dwnAlice.records.query({
            dateSort,
            filter,
            pagination: { cursor: firstPage.cursor, limit: 1 }
          })
        ]);
        expect(recordCursorPage.records.map(record => record.id)).toEqual([recordIds[1]]);
        expect(recordCursorPage.records.map(record => record.id)).toEqual(queryCursorPage.records.map(record => record.id));
        expect(recordCursorPage.cursor).toEqual(queryCursorPage.cursor);
      }
    });

    it('should return a cursor for pagination for a published record', async () => {
      // Create a record that is not published.
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        published    : true,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
        schema       : protocolDefinition.types.thread.schema
      });
      expect(status.code).toBe(202);
      const messageCid = await Message.getCid(record['rawMessage']);

      const paginationCursorCreatedAscending = await record.paginationCursor(DwnDateSort.CreatedAscending);
      expect(paginationCursorCreatedAscending).toEqual({
        messageCid,
        value: record.dateCreated,
      });

      const paginationCursorCreatedDescending = await record.paginationCursor(DwnDateSort.CreatedDescending);
      expect(paginationCursorCreatedDescending).toEqual({
        messageCid,
        value: record.dateCreated,
      });

      const paginationCursorPublishedAscending = await record.paginationCursor(DwnDateSort.PublishedAscending);
      expect(paginationCursorPublishedAscending).toEqual({
        messageCid,
        value: record.datePublished,
      });

      const paginationCursorPublishedDescending = await record.paginationCursor(DwnDateSort.PublishedDescending);
      expect(paginationCursorPublishedDescending).toEqual({
        messageCid,
        value: record.datePublished,
      });
    });

    it('should return undefined if record is in a deleted state', async () => {
      // create a record
      const { status: writeStatus, record } = await dwnAlice.records.write({
        store        : false,
        data         : 'Hello, world!',
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
        schema       : protocolDefinition.types.thread.schema
      });
      expect(writeStatus.code).toBe(202);

      // delete the record
      await record.delete({ store: false });
      const deletedRecord = record;

      // get a pagination cursor
      const paginationCursor = await deletedRecord.paginationCursor(DwnDateSort.CreatedAscending);
      expect(paginationCursor).toBeUndefined();
    });
  });

  describe('readRecordData() error handling', () => {
    it('should wrap errors thrown during data read with a descriptive message', async () => {
      // Write a record.
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
        schema       : protocolDefinition.types.thread.schema,
        dataFormat   : 'text/plain',
      });
      expect(writeStatus.code).toBe(202);

      const lazyRecord = new Record(testHarness.agent, {
        ...record.rawMessage,
        author       : record.author,
        connectedDid : aliceDid.uri,
        dataAccess   : { author: aliceDid.uri, remote: false, target: aliceDid.uri },
      });

      // Stub processDwnRequest to throw an error.
      const stub = sinon.stub(testHarness.agent, 'processDwnRequest');
      stub.rejects(new Error('simulated network failure'));

      try {
        await lazyRecord.data.text();
        throw new Error('Expected an exception to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('Record: Unable to read stored data');
        expect(error.message).toContain('simulated network failure');
      }

      stub.restore();
    });

    it('should wrap non-200 status responses with error message', async () => {
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
        schema       : protocolDefinition.types.thread.schema,
        dataFormat   : 'text/plain',
      });
      expect(writeStatus.code).toBe(202);

      const lazyRecord = new Record(testHarness.agent, {
        ...record.rawMessage,
        author       : record.author,
        connectedDid : aliceDid.uri,
        dataAccess   : { author: aliceDid.uri, remote: false, target: aliceDid.uri },
      });

      // Stub processDwnRequest to return a non-200 status.
      const stub = sinon.stub(testHarness.agent, 'processDwnRequest');
      stub.resolves({
        messageCid : 'test-cid',
        message    : {},
        reply      : { status: { code: 404, detail: 'Not Found' }, entry: undefined },
      } as any);

      try {
        await lazyRecord.data.text();
        throw new Error('Expected an exception to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('Record: Unable to read stored data');
        expect(error.message).toContain('404');
      }

      stub.restore();
    });
  });

  describe('processRecord() deleted branch', () => {
    it('should send a RecordsDelete when storing a deleted record', async () => {
      // Create a record without storing it.
      const { status: writeStatus, record } = await dwnAlice.records.write({
        store        : false,
        data         : 'Hello, world!',
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
        schema       : protocolDefinition.types.thread.schema,
        dataFormat   : 'text/plain',
      });
      expect(writeStatus.code).toBe(202);

      // Delete the record without storing.
      await record.delete({ store: false });
      const deletedRecord = record;
      expect(deletedRecord.deleted).toBe(true);

      // Spy on processDwnRequest to verify the deleted branch sends RecordsDelete.
      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      // Store the deleted record — this should invoke processRecord() which takes the deleted branch.
      await deletedRecord.store();

      // The spy should have been called: once for the initial write and once for the delete.
      // Find the RecordsDelete call.
      const deleteCall = processSpy.getCalls().find(
        (call) => call.args[0].messageType === DwnInterface.RecordsDelete
      );
      expect(deleteCall).toBeDefined();

      processSpy.restore();
    });
  });
});
