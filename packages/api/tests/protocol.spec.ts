import type { BearerDid } from '@enbox/dids';

import { expect } from 'chai';

import { PlatformAgentTestHarness, Web5UserAgent } from '@enbox/agent';

// NOTE: @noble/secp256k1 requires globalThis.crypto polyfill for node.js <=18: https://github.com/paulmillr/noble-secp256k1/blob/main/README.md#usage
// Remove when we move off of node.js v18 to v20, earliest possible time would be Oct 2023: https://github.com/nodejs/release#release-schedule
import { DwnApi } from '../src/dwn-api.js';
import emailProtocolDefinition from './fixtures/protocol-definitions/email.json' with { type: 'json' };
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';
import { webcrypto } from 'node:crypto';
// @ts-ignore
if (!globalThis.crypto) {globalThis.crypto = webcrypto;}

// TODO: Come up with a better way of resolving the TS errors.
const testDwnUrls: string[] = [testDwnUrl];

describe('Protocol', () => {
  let aliceDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;

  before(async () => {
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
    await testHarness.dwnEventLog.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    await testHarness.agent.permissions.clear();
    testHarness.dwnStores.clear();
  });

  after(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('send()', () => {
    it('configures protocols on remote DWNs for your own DID', async () => {
      // Alice configures a protocol on her agent connected DWN.
      const protocolUri = `http://example.com/protocol/${TestDataGenerator.randomString(15)}`;
      const { status: aliceEmailStatus, protocol: aliceEmailProtocol } = await dwnAlice.protocols.configure({
        message: {
          definition: {
            ...emailProtocolDefinition,
            protocol: protocolUri
          }
        }
      });

      expect(aliceEmailStatus.code).to.equal(202);
      expect(aliceEmailProtocol.definition).to.deep.equal({
        ...emailProtocolDefinition,
        protocol: protocolUri
      });

      // Attempt to configure the protocol on Alice's remote DWN.
      const { status } = await aliceEmailProtocol.send(aliceDid.uri);
      expect(status.code).to.equal(202);

      // Query Alices's remote DWN for `email` schema records.
      const aliceRemoteQueryResult = await dwnAlice.protocols.query({
        from    : aliceDid.uri,
        message : {
          filter: {
            protocol: protocolUri,
          }
        }
      });

      expect(aliceRemoteQueryResult.status.code).to.equal(200);
      expect(aliceRemoteQueryResult.protocols).to.exist;
      expect(aliceRemoteQueryResult.protocols.length).to.equal(1);
      const [ aliceRemoteEmailProtocol ] = aliceRemoteQueryResult.protocols;
      expect(aliceRemoteEmailProtocol.definition).to.deep.equal({
        ...emailProtocolDefinition,
        protocol: protocolUri
      });
    });
  });

  describe('toJSON()', () => {
    xit('should return all defined properties');
  });
});