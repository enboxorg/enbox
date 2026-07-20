import type { BearerDid } from '@enbox/dids';
import type { DwnProtocolDefinition } from '@enbox/agent';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { DwnInterface, EnboxUserAgent } from '@enbox/agent';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';
import { TypedEnbox } from '../src/typed-enbox.js';

const testDwnUrls: string[] = [testDwnUrl];

// ---------------------------------------------------------------------------
// Record.patch() / TypedRecord.patch() — the read-merge-write partial-update
// idiom. update({ data }) REPLACES the payload (full payloads required for
// encrypted records); patch() merges changed fields over the current data and
// writes the FULL merged payload through update().
// ---------------------------------------------------------------------------

describe('Record.patch()', () => {
  let aliceDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;
  let protocolUri: string;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/record-patch',
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    aliceDid = alice.did;

    dwnAlice = new DwnApi({ agent: testHarness.agent, connectedDid: aliceDid.uri });
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.syncStore.clear();
    await testHarness.dwnDataStore.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    await testHarness.agent.permissions.clear();
    testHarness.dwnStores.clear();

    protocolUri = `http://patch-protocol.xyz/${TestDataGenerator.randomString(15)}`;
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  /** Installs a plain (non-encrypted) `note` protocol at `protocolUri`. */
  async function installNoteProtocol(): Promise<void> {
    const definition: DwnProtocolDefinition = {
      published : true,
      protocol  : protocolUri,
      types     : {
        note: {
          schema      : `${protocolUri}/schemas/note`,
          dataFormats : ['application/json'],
        },
      },
      structure: {
        note: {},
      },
    };
    const { status } = await dwnAlice.protocols.configure({ definition });
    expect(status.code).toBe(202);
  }

  it('should shallow-merge patched fields over the current payload', async () => {
    await installNoteProtocol();

    const { status, record } = await dwnAlice.records.write({
      data         : { title: 'v1', body: 'unchanged body', count: 1 },
      protocol     : protocolUri,
      protocolPath : 'note',
      schema       : `${protocolUri}/schemas/note`,
      dataFormat   : 'application/json',
    });
    expect(status.code).toBe(202);

    const { status: patchStatus, record: patched } = await record!.patch({ title: 'v2' });
    expect(patchStatus.code).toBe(202);

    // Only the patched field changed — every omitted field survived.
    expect(await patched.data.json()).toEqual({ title: 'v2', body: 'unchanged body', count: 1 });
    // The original reference was mutated in-place too (update() semantics).
    expect(await record!.data.json()).toEqual({ title: 'v2', body: 'unchanged body', count: 1 });
  });

  it('should write the FULL merged payload to the agent request (not the partial)', async () => {
    await installNoteProtocol();

    const { record } = await dwnAlice.records.write({
      data         : { title: 'v1', body: 'kept', tagsCount: 3 },
      protocol     : protocolUri,
      protocolPath : 'note',
      schema       : `${protocolUri}/schemas/note`,
      dataFormat   : 'application/json',
    });

    const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

    const { status } = await record!.patch({ title: 'v2' });
    expect(status.code).toBe(202);

    // Asserted at the agent request: the write's dataStream carries the full
    // merged object, not the partial the caller passed.
    const writeCall = processSpy.getCalls().find((call) => call.args[0].messageType === DwnInterface.RecordsWrite);
    expect(writeCall).toBeDefined();
    const dataStream = writeCall!.args[0].dataStream as Blob;
    expect(dataStream).toBeInstanceOf(Blob);
    expect(JSON.parse(await dataStream.text())).toEqual({ title: 'v2', body: 'kept', tagsCount: 3 });
  });

  it('should delete fields patched with an explicit null and ignore undefined', async () => {
    await installNoteProtocol();

    const { record } = await dwnAlice.records.write({
      data         : { title: 'v1', subtitle: 'optional', body: 'kept' },
      protocol     : protocolUri,
      protocolPath : 'note',
      schema       : `${protocolUri}/schemas/note`,
      dataFormat   : 'application/json',
    });

    const { status, record: patched } = await record!.patch({
      subtitle : null, // explicit null → field deleted
      body     : undefined, // undefined → ignored, no change
    });
    expect(status.code).toBe(202);

    const patchedData = await patched.data.json() as Record<string, unknown>;
    expect(patchedData).toEqual({ title: 'v1', body: 'kept' });
    expect('subtitle' in patchedData).toBe(false);
  });

  it('should replace nested objects wholesale (shallow merge, not deep)', async () => {
    await installNoteProtocol();

    const { record } = await dwnAlice.records.write({
      data         : { title: 'v1', meta: { a: 1, b: 2 } },
      protocol     : protocolUri,
      protocolPath : 'note',
      schema       : `${protocolUri}/schemas/note`,
      dataFormat   : 'application/json',
    });

    const { record: patched } = await record!.patch({ meta: { a: 9 } });

    // The nested object is replaced as a unit — `b` does NOT survive.
    expect(await patched.data.json()).toEqual({ title: 'v1', meta: { a: 9 } });
  });

  it('should throw when the current data is not a JSON object', async () => {
    await installNoteProtocol();

    const { record } = await dwnAlice.records.write({
      data         : ['not', 'an', 'object'],
      protocol     : protocolUri,
      protocolPath : 'note',
      schema       : `${protocolUri}/schemas/note`,
      dataFormat   : 'application/json',
    });

    await expect(record!.patch({ title: 'v2' }))
      .rejects.toThrow('patch() requires the record\'s current data to be a JSON object');
  });

  it('should throw when patching a deleted record', async () => {
    await installNoteProtocol();

    const { record } = await dwnAlice.records.write({
      data         : { title: 'v1' },
      protocol     : protocolUri,
      protocolPath : 'note',
      schema       : `${protocolUri}/schemas/note`,
      dataFormat   : 'application/json',
    });
    const { status: deleteStatus } = await record!.delete();
    expect(deleteStatus.code).toBe(202);

    await expect(record!.patch({ title: 'v2' })).rejects.toThrow('Cannot patch a deleted record');
  });

  it('should re-encrypt the full merged payload when patching an encrypted record', async () => {
    const encProtocol: DwnProtocolDefinition = {
      published : true,
      protocol  : protocolUri,
      types     : {
        note: {
          schema      : `${protocolUri}/schemas/note`,
          dataFormats : ['application/json'],
        },
      },
      structure: {
        note: {},
      },
    };

    const { status: configStatus } = await dwnAlice.protocols.configure({
      definition : encProtocol,
      encryption : true,
    });
    expect(configStatus.code).toBe(202);

    const { status: writeStatus, record } = await dwnAlice.records.write({
      data         : { title: 'secret v1', body: 'confidential body' },
      protocol     : protocolUri,
      protocolPath : 'note',
      schema       : `${protocolUri}/schemas/note`,
      dataFormat   : 'application/json',
      encryption   : true,
    });
    expect(writeStatus.code).toBe(202);
    expect(record!.encryption).toBeDefined();
    const originalIV = record!.encryption!.initializationVector;

    const { status: patchStatus, record: patched } = await record!.patch({ title: 'secret v2' });
    expect(patchStatus.code).toBe(202);

    // The patched record is re-encrypted (fresh envelope), full payload intact.
    expect(patched.encryption).toBeDefined();
    expect(patched.encryption!.initializationVector).not.toBe(originalIV);

    // Read back decrypted from the DWN: the omitted field survived because
    // patch wrote the FULL merged payload (encrypted updates require it).
    const { status: readStatus, record: readRecord } = await dwnAlice.records.read({
      filter: { recordId: record!.id },
    });
    expect(readStatus.code).toBe(200);
    expect(await readRecord!.data.json()).toEqual({ title: 'secret v2', body: 'confidential body' });
  });

  describe('TypedRecord.patch()', () => {
    it('should merge typed patches, honor null-deletes, and keep the typed wrapper', async () => {
      const definition: ProtocolDefinition = {
        protocol  : protocolUri,
        published : true,
        types     : {
          page: { schema: `${protocolUri}/schemas/page`, dataFormats: ['application/json'] },
        },
        structure: {
          page: { $actions: [{ who: 'anyone', can: ['create', 'read'] }] },
        },
      };
      type PageData = { title: string; body: string; subtitle?: string };
      const typed = new TypedEnbox(dwnAlice, defineProtocol(definition, {} as { page: PageData }));

      const { status, record } = await typed.records.create('page', {
        data: { title: 'v1', body: 'kept', subtitle: 'optional' },
      });
      expect(status.code).toBe(202);

      const { status: patchStatus, record: patched } = await record!.patch({
        title    : 'v2',
        subtitle : null,
      });
      expect(patchStatus.code).toBe(202);

      const data: PageData = await patched.data.json();
      expect(data).toEqual({ title: 'v2', body: 'kept' });

      // The typed wrapper flows through the patch result.
      expect(patched.protocolPath).toBe('page');
    });

    it('should patch an auto-encrypted typed record with the full merged payload', async () => {
      const definition: ProtocolDefinition = {
        protocol  : protocolUri,
        published : true,
        types     : {
          secret: {
            schema             : `${protocolUri}/schemas/secret`,
            dataFormats        : ['application/json'],
            encryptionRequired : true,
          },
        },
        structure: {
          secret: {},
        },
      };
      type SecretData = { title: string; pin: string };
      const typed = new TypedEnbox(dwnAlice, defineProtocol(definition, {} as { secret: SecretData }));

      // configure() auto-derives + injects $keyAgreement for encrypted types.
      const { status: configStatus } = await typed.configure();
      expect(configStatus.code).toBe(202);

      const { status, record } = await typed.records.create('secret', {
        data: { title: 'vault', pin: '1234' },
      });
      expect(status.code).toBe(202);
      expect(record!.encryption).toBeDefined();

      const { status: patchStatus, record: patched } = await record!.patch({ title: 'vault v2' });
      expect(patchStatus.code).toBe(202);
      expect(patched.encryption).toBeDefined();

      // The omitted encrypted field survives the patch round-trip.
      const { status: readStatus, record: readRecord } = await typed.records.read('secret', {
        filter: { recordId: record!.id },
      });
      expect(readStatus.code).toBe(200);
      expect(await readRecord!.data.json()).toEqual({ title: 'vault v2', pin: '1234' });
    });
  });
});
