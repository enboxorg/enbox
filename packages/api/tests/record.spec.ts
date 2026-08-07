import type { BearerDid, PortableDid } from '@enbox/dids';
import type { DwnMessage, DwnMessageParams, DwnProtocolDefinition, DwnPublicKeyJwk, DwnSigner, ProcessDwnRequest } from '@enbox/agent';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { utils as didUtils } from '@enbox/dids';
import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { Stream } from '@enbox/common';

import {
  createPermissionGrants, DwnConstant, DwnContentEncryptionAlgorithm, DwnInterface, DwnKeyAgreementAlgorithm,
  DwnKeyDerivationScheme, dwnMessageConstructors, EnboxUserAgent, getRecordAuthor, getRecordProtocolRole,
} from '@enbox/agent';
import { Jws, Poller, Time } from '@enbox/dwn-sdk-js';
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
import { publishProtocol, publishRecord, publishUnstoredRecord } from './utils/test-dwn-operations.js';

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
    const { status: aliceProtocolSendStatus } = await publishProtocol(
      testHarness.agent, aliceProtocol, aliceDid.uri, aliceDid.uri
    );
    expect(aliceProtocolSendStatus.code).toBe(202);

    const { status: bobProtocolStatus, protocol: bobProtocol } = await dwnBob.protocols.configure({ definition: protocolDefinition });
    expect(bobProtocolStatus.code).toBe(202);
    expect(bobProtocol).toBeDefined();
    const { status: bobProtocolSendStatus } = await publishProtocol(
      testHarness.agent, bobProtocol, bobDid.uri, bobDid.uri
    );
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
    const { status: aliceFfaSendStatus } = await publishProtocol(
      testHarness.agent, aliceFfaProtocol, aliceDid.uri, aliceDid.uri
    );
    expect(aliceFfaSendStatus.code).toBe(202);
    const { status: bobFfaStatus, protocol: bobFfaProtocol } = await dwnBob.protocols.configure({ definition: freeForAllDefinition });
    expect(bobFfaStatus.code).toBe(202);
    const { status: bobFfaSendStatus } = await publishProtocol(
      testHarness.agent, bobFfaProtocol, bobDid.uri, bobDid.uri
    );
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
      const { status: aliceNotesProtocolSend } = await publishProtocol(
        testHarness.agent, aliceNotesProtocol, aliceDid.uri, aliceDid.uri
      );
      expect(aliceNotesProtocolSend.code).toBe(202);

      const { status: bobConfigStatus, protocol: bobNotesProtocol } = await dwnBob.protocols.configure({ definition: notesProtocol });
      expect(bobConfigStatus.code).toBe(202);
      const { status: bobNotesProtocolSend } = await publishProtocol(
        testHarness.agent, bobNotesProtocol!, bobDid.uri, bobDid.uri
      );
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

      await publishRecord(testHarness.agent, record!, aliceDid.uri, aliceDid.uri);

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

      await publishRecord(delegateHarness.agent, deletedRecord, aliceDid.uri, aliceDid.uri);

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
      const { status: aliceOtherProtocolSend } = await publishProtocol(
        testHarness.agent, aliceOtherProtocol, aliceDid.uri, aliceDid.uri
      );
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
      await publishRecord(testHarness.agent, aliceRecord!, aliceDid.uri, aliceDid.uri);

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
      await publishRecord(testHarness.agent, alicePublicRecord!, aliceDid.uri, aliceDid.uri);

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

      // Keep the record out of the local DWN so lazy data must use the captured remote route.
      const { record, status } = await dwnAlice.records.write({
        store        : false,
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Write the large record to a remote DWN.
      await publishUnstoredRecord(testHarness.agent, record!, aliceDid.uri, aliceDid.uri);

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

      // Keep the record out of the local DWN so lazy data must use the captured remote route.
      const { record, status } = await dwnAlice.records.write({
        store        : false,
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Write the large record to a remote DWN.
      await publishUnstoredRecord(testHarness.agent, record!, aliceDid.uri, aliceDid.uri);

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

      // Keep the record out of the local DWN so repeated reads cannot fall back locally.
      const { record, status } = await dwnAlice.records.write({
        store        : false,
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Write the large record to a remote DWN.
      await publishUnstoredRecord(testHarness.agent, record!, aliceDid.uri, aliceDid.uri);

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

      // Keep the record out of the local DWN so repeated reads cannot fall back locally.
      const { record, status } = await dwnAlice.records.write({
        store        : false,
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Write the large record to a remote DWN.
      await publishUnstoredRecord(testHarness.agent, record!, aliceDid.uri, aliceDid.uri);

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

      // Keep the record out of the local DWN so repeated reads cannot fall back locally.
      const { record, status } = await dwnAlice.records.write({
        store        : false,
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Write the large record to a remote DWN.
      await publishUnstoredRecord(testHarness.agent, record!, aliceDid.uri, aliceDid.uri);

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

      // Keep the record out of the local DWN so repeated reads cannot fall back locally.
      const { record, status } = await dwnAlice.records.write({
        store        : false,
        data         : dataJson,
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
      });
      expect(status.code).toBe(202);

      // Write the large record to a remote DWN.
      await publishUnstoredRecord(testHarness.agent, record!, aliceDid.uri, aliceDid.uri);

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
        const { status: carolProtocolSendStatus } = await publishProtocol(
          testHarnessCarol.agent, carolProtocol, carolDid.uri, carolDid.uri
        );
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
         *   1. Alice creates a record locally.
         */
        const { record, status } = await dwnAlice.records.write({
          data         : dataTextExceedingMaxSize,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema
        });
        expect(status.code).toBe(202);
        /**
         *   2. Alice writes the record to Carol's remote DWN.
         */
        await publishRecord(testHarness.agent, record!, aliceDid.uri, carolDid.uri);
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
         *   1. Alice creates a record locally.
         */
        const { record, status } = await dwnAlice.records.write({
          data         : dataTextExceedingMaxSize,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema
        });
        expect(status.code).toBe(202);
        /**
         *   2. Alice writes the record to Carol's remote DWN.
         */
        await publishRecord(testHarness.agent, record!, aliceDid.uri, carolDid.uri);
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
        await publishRecord(testHarnessCarol.agent, queryRecordsFrom[0]!, carolDid.uri, aliceDid.uri);
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
      const { status: aliceNotesProtocolSend } = await publishProtocol(
        testHarness.agent, aliceNotesProtocol, aliceDid.uri, aliceDid.uri
      );
      expect(aliceNotesProtocolSend.code).toBe(202);

      const { status: bobConfigStatus, protocol: bobNotesProtocol } = await dwnBob.protocols.configure({ definition: notesProtocol });
      expect(bobConfigStatus.code).toBe(202);
      const { status: bobNotesProtocolSend } = await publishProtocol(
        testHarness.agent, bobNotesProtocol!, bobDid.uri, bobDid.uri
      );
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
      await publishRecord(testHarness.agent, record!, aliceDid.uri, aliceDid.uri);

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
      await publishRecord(testHarness.agent, updatedRecord, aliceDid.uri, aliceDid.uri);

      // bob attempts to read the record again but it should not be authorized as it's unpublished
      const readResultAfterUpdate = await dwnBob.records.read({
        from   : aliceDid.uri,
        filter : {
          recordId: record!.id
        }
      });
      expect(readResultAfterUpdate.status.code).toBe(401);
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
      const { status: writeStatus, record } = await dwnAlice.records.write({
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
      await publishRecord(testHarness.agent, record, aliceDid.uri, aliceDid.uri);

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
      const updatedBobRecord = await bobRecord.update({ data: 'Hello, Alice!', from: aliceDid.uri });
      expect(updatedBobRecord).toBe(bobRecord);

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
      const { status: bobProtocolSendStatus } = await publishProtocol(
        testHarness.agent, bobProtocol, bobDid.uri, bobDid.uri
      );
      expect(bobProtocolSendStatus.code).toBe(202);

      // Alice must also configure the protocol to make updates.
      // NOTE: This is not desireable and there is an issue to address this:
      // https://github.com/enboxorg/enbox/issues/955
      const { status: aliceProtocolStatus, protocol: aliceProtocol } = await dwnAlice.protocols.configure({
        definition: protocol
      });
      expect(aliceProtocolStatus.code).toBe(202);
      const { status: aliceProtocolSend } = await publishProtocol(
        testHarness.agent, aliceProtocol, aliceDid.uri, aliceDid.uri
      );
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
        await publishRecord(testHarness.agent, noteRecord, bobDid.uri, bobDid.uri);
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
      await publishRecord(testHarness.agent, friendRecord, bobDid.uri, bobDid.uri);

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
      await publishRecord(testHarness.agent, coAuthorRecord, bobDid.uri, bobDid.uri);

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

      // Capture the exact remote request so the role inherited from the query is pinned.
      const sendDwnRequestSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');

      try {
        await coAuthorNote!.update({ data: 'updated note', from: bobDid.uri });
        throw new Error('Expected the friend role update to be rejected.');
      } catch (error) {
        expect(error).toBeInstanceOf(DwnResponseError);
        expect((error as DwnResponseError).status.code).toBe(401);
      }
      expect(sendDwnRequestSpy.callCount).toBe(1);
      expect((sendDwnRequestSpy.firstCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsWrite>)
        .messageParams?.protocolRole).toBe('friend');

      sendDwnRequestSpy.resetHistory();

      const updatedNote = await coAuthorNote!.update({
        data         : 'updated note',
        from         : bobDid.uri,
        protocolRole : 'note/coAuthor',
      });
      expect(updatedNote).toBe(coAuthorNote);
      expect(sendDwnRequestSpy.callCount).toBe(1);
      expect(getRecordProtocolRole(updatedNote.rawMessage)).toBe('note/coAuthor');
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
      const { status: aliceNotesProtocolSend } = await publishProtocol(
        testHarness.agent, aliceNotesProtocol, aliceDid.uri, aliceDid.uri
      );
      expect(aliceNotesProtocolSend.code).toBe(202);

      const { status: bobConfigStatus, protocol: bobNotesProtocol } = await dwnBob.protocols.configure({ definition: notesProtocol });
      expect(bobConfigStatus.code).toBe(202);
      const { status: bobNotesProtocolSend } = await publishProtocol(
        testHarness.agent, bobNotesProtocol!, bobDid.uri, bobDid.uri
      );
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

    it('stores the initial write before deleting an unstored record', async () => {
      const { status, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        dataFormat   : 'text/plain',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        store        : false,
      });
      expect(status.code).toBe(202);

      await record.delete();
      expect(record.deleted).toBe(true);

      try {
        await record.delete();
        throw new Error('Expected the standing tombstone to reject the second delete.');
      } catch (error) {
        expect(error).toBeInstanceOf(DwnResponseError);
        expect((error as DwnResponseError).status.code).toBe(409);
      }
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
      await publishRecord(testHarness.agent, record!, aliceDid.uri, aliceDid.uri);

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
      await publishRecord(testHarness.agent, deletedRecord, aliceDid.uri, aliceDid.uri);

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
      const { status: protocolSendStatus } = await publishProtocol(
        testHarness.agent, protocol, aliceDid.uri, aliceDid.uri
      );
      expect(protocolSendStatus.code).toBe(202);

      // Write the records locally before publishing them remotely.
      const { status: parentWriteStatus, record: parentRecord } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : protocol.definition.protocol,
        protocolPath : 'foo',
        schema       : 'http://example.com/foo',
        dataFormat   : 'text/plain'
      });
      expect(parentWriteStatus.code).toBe(202);
      expect(parentRecord).toBeDefined();
      await publishRecord(testHarness.agent, parentRecord, aliceDid.uri, aliceDid.uri);

      // Write a child record.
      const { status: child1WriteStatus, record: childRecord1 } = await dwnAlice.records.write({
        data            : 'Hello, world!',
        protocol        : protocol.definition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'http://example.com/bar',
        dataFormat      : 'text/plain',
        parentContextId : parentRecord.contextId
      });
      expect(child1WriteStatus.code).toBe(202);
      expect(childRecord1).toBeDefined();
      await publishRecord(testHarness.agent, childRecord1, aliceDid.uri, aliceDid.uri);

      // Write a second child record.
      const { status: child2WriteStatus, record: childRecord2 } = await dwnAlice.records.write({
        data            : 'Hello, world!',
        protocol        : protocol.definition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'http://example.com/bar',
        dataFormat      : 'text/plain',
        parentContextId : parentRecord.contextId
      });
      expect(child2WriteStatus.code).toBe(202);
      expect(childRecord2).toBeDefined();
      await publishRecord(testHarness.agent, childRecord2, aliceDid.uri, aliceDid.uri);

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
      await parentRecord.delete({ prune: true });
      const deletedParentRecord = parentRecord;
      expect(deletedParentRecord.deleted).toBe(true);
      await publishRecord(testHarness.agent, deletedParentRecord, aliceDid.uri, aliceDid.uri);

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
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : 'Hello, world!',
        protocol     : 'http://free-for-all.xyz',
        protocolPath : 'post',
        schema       : 'foo/bar',
        dataFormat   : 'text/plain'
      });
      expect(writeStatus.code).toBe(202);

      await record.delete();
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
      await publishRecord(testHarness.agent, bobWriteRecord, bobDid.uri, aliceDid.uri);

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
      const { status: bobProtocolSendStatus } = await publishProtocol(
        testHarness.agent, bobProtocol, bobDid.uri, bobDid.uri
      );
      expect(bobProtocolSendStatus.code).toBe(202);

      // Alice must also configure the protocol to make updates.
      // NOTE: This is not desireable and there is an issue to address this:
      // https://github.com/enboxorg/enbox/issues/955
      const { status: aliceProtocolStatus, protocol: aliceProtocol } = await dwnAlice.protocols.configure({
        definition: protocol
      });
      expect(aliceProtocolStatus.code).toBe(202);
      const { status: aliceProtocolSend } = await publishProtocol(
        testHarness.agent, aliceProtocol, aliceDid.uri, aliceDid.uri
      );
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
        await publishRecord(testHarness.agent, noteRecord, bobDid.uri, bobDid.uri);
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
      await publishRecord(testHarness.agent, friendRecord, bobDid.uri, bobDid.uri);

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
      await publishRecord(testHarness.agent, coAuthorRecord, bobDid.uri, bobDid.uri);

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

      const sendDwnRequestSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');

      const friendDelete = await dwnAlice.records.delete({
        from         : bobDid.uri,
        protocol     : protocol.protocol,
        protocolPath : 'note',
        protocolRole : 'friend',
        recordId     : coDeleteNote!.id,
      });
      expect(friendDelete.status.code).toBe(401);
      expect(sendDwnRequestSpy.callCount).toBe(1);
      expect((sendDwnRequestSpy.firstCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsDelete>)
        .messageParams?.protocolRole).toBe('friend');

      sendDwnRequestSpy.resetHistory();

      const coAuthorDelete = await dwnAlice.records.delete({
        from         : bobDid.uri,
        protocol     : protocol.protocol,
        protocolPath : 'note',
        protocolRole : 'note/coAuthor',
        recordId     : coDeleteNote!.id,
      });
      expect(coAuthorDelete.status.code).toBe(202);
      expect(sendDwnRequestSpy.callCount).toBe(1);
      expect((sendDwnRequestSpy.firstCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsDelete>)
        .messageParams?.protocolRole).toBe('note/coAuthor');

      const deletedRead = await dwnBob.records.read({
        from   : bobDid.uri,
        filter : { recordId: coDeleteNote!.id },
      });
      expect(deletedRead.status.code).toBe(404);
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
});
