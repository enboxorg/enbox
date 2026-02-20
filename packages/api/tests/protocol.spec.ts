import type { BearerDid } from '@enbox/dids';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { PlatformAgentTestHarness, Web5UserAgent } from '@enbox/agent';

import { DwnApi } from '../src/dwn-api.js';
import emailProtocolDefinition from './fixtures/protocol-definitions/email.json' with { type: 'json' };
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';

// TODO: Come up with a better way of resolving the TS errors.
const testDwnUrls: string[] = [testDwnUrl];

describe('Protocol', () => {
  let aliceDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : Web5UserAgent,
      agentStores : 'memory'
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    // Create an "alice" Identity to author the DWN messages.
    const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    aliceDid = alice.did;

    // Instantiate DwnApi for both test identities.
    dwnAlice = new DwnApi({ agent: testHarness.agent, connectedDid: aliceDid.uri });
  });

  beforeEach(async () => {
    await testHarness.syncStore.clear();
    await testHarness.dwnDataStore.clear();
    await testHarness.dwnStateIndex.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    await testHarness.agent.permissions.clear();
    testHarness.dwnStores.clear();
  });

  afterAll(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('send()', () => {
    it('configures protocols on remote DWNs for your own DID', async () => {
      // Alice configures a protocol on her agent connected DWN.
      const protocolUri = `http://example.com/protocol/${TestDataGenerator.randomString(15)}`;
      const { status: aliceEmailStatus, protocol: aliceEmailProtocol } = await dwnAlice.protocols.configure({
        definition: {
          ...emailProtocolDefinition,
          protocol: protocolUri
        }
      });

      expect(aliceEmailStatus.code).toBe(202);
      expect(aliceEmailProtocol.definition).toEqual({
        ...emailProtocolDefinition,
        protocol: protocolUri
      });

      // Attempt to configure the protocol on Alice's remote DWN.
      const { status } = await aliceEmailProtocol.send(aliceDid.uri);
      expect(status.code).toBe(202);

      // Query Alices's remote DWN for `email` schema records.
      const aliceRemoteQueryResult = await dwnAlice.protocols.query({
        from   : aliceDid.uri,
        filter : {
          protocol: protocolUri,
        }
      });

      expect(aliceRemoteQueryResult.status.code).toBe(200);
      expect(aliceRemoteQueryResult.protocols).toBeDefined();
      expect(aliceRemoteQueryResult.protocols.length).toBe(1);
      const [ aliceRemoteEmailProtocol ] = aliceRemoteQueryResult.protocols;
      expect(aliceRemoteEmailProtocol.definition).toEqual({
        ...emailProtocolDefinition,
        protocol: protocolUri
      });
    });
  });

  describe('toJSON()', () => {
    it('should return all defined properties', async () => {
      const protocolUri = `http://example.com/protocol/${TestDataGenerator.randomString(15)}`;
      const { status, protocol: aliceProtocol } = await dwnAlice.protocols.configure({
        definition: {
          ...emailProtocolDefinition,
          protocol: protocolUri
        }
      });
      expect(status.code).toBe(202);

      const protocolJson = aliceProtocol.toJSON();

      expect(protocolJson.descriptor).toBeDefined();
      expect(protocolJson.descriptor.interface).toBe('Protocols');
      expect(protocolJson.descriptor.method).toBe('Configure');
      expect(protocolJson.descriptor.messageTimestamp).toBeDefined();
      expect(protocolJson.descriptor.definition).toEqual({
        ...emailProtocolDefinition,
        protocol: protocolUri
      });
      expect(protocolJson.authorization).toBeDefined();
    });
  });
});
