import type { BearerDid } from '@enbox/dids';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { DwnInterfaceName, DwnMethodName, Time } from '@enbox/dwn-sdk-js';
import { EnboxUserAgent, PlatformAgentTestHarness } from '@enbox/agent';

import { DwnApi } from '../src/dwn-api.js';
import { PermissionGrantRevocation } from '../src/grant-revocation.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';

const testDwnUrls: string[] = [testDwnUrl];

describe('PermissionGrantRevocation', () => {
  let aliceDid: BearerDid;
  let bobDid: BearerDid;
  let aliceDwn: DwnApi;
  let testHarness: PlatformAgentTestHarness;
  let protocolUri: string;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/grant-revocation',
    });

    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    aliceDid = alice.did;

    const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });
    bobDid = bob.did;

    aliceDwn = new DwnApi({ agent: testHarness.agent, connectedDid: aliceDid.uri });
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.syncStore.clear();
    await testHarness.dwnDataStore.clear();
    await testHarness.dwnStateIndex.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    await testHarness.agent.permissions.clear();
    testHarness.dwnStores.clear();

    protocolUri = `http://example.com/protocol/${TestDataGenerator.randomString(15)}`;
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('parse()', () => {
    it('should create a PermissionGrantRevocation from a revocation message', async () => {
      // Create and store a grant
      const grant = await aliceDwn.permissions.grant({
        store       : true,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, protocol: protocolUri },
      });

      // Revoke the grant (returns a PermissionGrantRevocation)
      const revocation = await grant.revoke(false);
      const rawMessage = revocation.rawMessage;

      // Parse the revocation from its raw message
      const parsed = await PermissionGrantRevocation.parse({
        connectedDid : aliceDid.uri,
        agent        : testHarness.agent,
        message      : rawMessage,
      });

      expect(parsed).toBeDefined();
      expect(parsed.rawMessage).toEqual(rawMessage);
    });
  });

  describe('author', () => {
    it('should return the author of the revocation message', async () => {
      const grant = await aliceDwn.permissions.grant({
        store       : true,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, protocol: protocolUri },
      });

      const revocation = await grant.revoke(false);
      expect(revocation.author).toBe(aliceDid.uri);
    });
  });

  describe('send()', () => {
    it('should send the revocation to the connectedDid by default', async () => {
      const grant = await aliceDwn.permissions.grant({
        store       : true,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, protocol: protocolUri },
      });

      // Send the grant to alice's remote first
      const { status: grantSendStatus } = await grant.send();
      expect(grantSendStatus.code).toBe(202);

      // Revoke but don't store locally
      const revocation = await grant.revoke(false);

      // Send the revocation to alice's remote (default target)
      const { status } = await revocation.send();
      expect(status.code).toBe(202);

      // Verify the revocation is visible on alice's remote
      const isRevoked = await grant.isRevoked(true);
      expect(isRevoked).toBe(true);
    });

    it('should send the revocation to a specified target', async () => {
      const grant = await aliceDwn.permissions.grant({
        store       : true,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, protocol: protocolUri },
      });

      // Send the grant to alice's remote first
      const { status: grantSendStatus } = await grant.send();
      expect(grantSendStatus.code).toBe(202);

      // Revoke and send to a specific target
      const revocation = await grant.revoke(false);
      const { status } = await revocation.send(aliceDid.uri);
      expect(status.code).toBe(202);
    });
  });

  describe('store()', () => {
    it('should store the revocation to the local DWN', async () => {
      const grant = await aliceDwn.permissions.grant({
        store       : true,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, protocol: protocolUri },
      });

      let isRevoked = await grant.isRevoked();
      expect(isRevoked).toBe(false);

      // Revoke but don't store
      const revocation = await grant.revoke(false);

      // Still not revoked locally
      isRevoked = await grant.isRevoked();
      expect(isRevoked).toBe(false);

      // Store the revocation
      const { status } = await revocation.store();
      expect(status.code).toBe(202);

      // Now locally revoked
      isRevoked = await grant.isRevoked();
      expect(isRevoked).toBe(true);
    });

    it('should store the revocation as owner when importRevocation is true', async () => {
      const grant = await aliceDwn.permissions.grant({
        store       : true,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, protocol: protocolUri },
      });

      const revocation = await grant.revoke(false);
      const { status } = await revocation.store(true);
      expect(status.code).toBe(202);
    });
  });

  describe('rawMessage', () => {
    it('should return the underlying DWN message', async () => {
      const grant = await aliceDwn.permissions.grant({
        store       : true,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, protocol: protocolUri },
      });

      const revocation = await grant.revoke(false);
      const raw = revocation.rawMessage;

      expect(raw).toBeDefined();
      expect(raw.descriptor).toBeDefined();
      expect(raw.encodedData).toBeDefined();
    });
  });
});
