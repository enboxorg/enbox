import type { BearerDid } from '@enbox/dids';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { DwnInterfaceName, DwnMethodName, Time } from '@enbox/dwn-sdk-js';
import { PlatformAgentTestHarness, Web5UserAgent } from '@enbox/agent';

import { DwnApi } from '../src/dwn-api.js';
import { PermissionRequest } from '../src/permission-request.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';

const testDwnUrls = [testDwnUrl];

describe('PermissionRequest', () => {
  let aliceDid: BearerDid;
  let bobDid: BearerDid;
  let aliceDwn: DwnApi;
  let bobDwn: DwnApi;
  let testHarness: PlatformAgentTestHarness;
  let protocolUri: string;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : Web5UserAgent,
      agentStores : 'memory'
    });

    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    // Create an "alice" Identity to author the DWN messages.
    const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    aliceDid = alice.did;

    // Create a "bob" Identity to author the DWN messages.
    const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });
    bobDid = bob.did;

    aliceDwn = new DwnApi({ agent: testHarness.agent, connectedDid: aliceDid.uri });
    bobDwn = new DwnApi({ agent: testHarness.agent, connectedDid: bobDid.uri });
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

    // create a random protocol URI for each run
    protocolUri = `http://example.com/protocol/${TestDataGenerator.randomString(15)}`;
  });


  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('parse()', () => {
    it('should parse a grant request message', async () => {
      const { request, message } = await testHarness.agent.permissions.createRequest({
        author : aliceDid.uri,
        scope  : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
          protocol  : protocolUri
        }
      });

      const parsedRequest = await PermissionRequest.parse({
        agent        : testHarness.agent,
        connectedDid : bobDid.uri,
        message
      });

      expect(parsedRequest.toJSON()).toEqual(request);
      expect(parsedRequest.rawMessage).toEqual(message);
      expect(parsedRequest.id).toBe(request.id);
      expect(parsedRequest.requester).toBe(request.requester);
      expect(parsedRequest.description).toBe(request.description);
      expect(parsedRequest.delegated).toBe(request.delegated);
      expect(parsedRequest.scope).toEqual(request.scope);
      expect(parsedRequest.conditions).toEqual(request.conditions);
    });

    //TODO: this should happen in the `dwn-sdk-js` helper
    it.skip('throws for an invalid request');
  });

  describe('send()', () => {
    it('should send a grant request to connectedDID by default', async () => {
      const grantRequest = await aliceDwn.permissions.request({
        store : false,
        scope : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
          protocol  : protocolUri
        }
      });

      // confirm the request is not present on the remote
      let requests = await aliceDwn.permissions.queryRequests({
        from     : aliceDid.uri,
        protocol : protocolUri
      });
      expect(requests).toHaveLength(0);

      const sendReply = await grantRequest.send();
      expect(sendReply.status.code).toBe(202);

      // fetch the requests from the remote
      requests = await aliceDwn.permissions.queryRequests({
        from     : aliceDid.uri,
        protocol : protocolUri
      });

      expect(requests).toHaveLength(1);
      expect(requests[0].id).toEqual(grantRequest.id);
    });

    it('sends a grant request to a remote target', async () => {
      const grantRequest = await aliceDwn.permissions.request({
        store : false,
        scope : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
          protocol  : protocolUri
        }
      });

      // confirm the request is not present on the remote
      let remoteRequestsBob = await bobDwn.permissions.queryRequests({
        from     : bobDid.uri,
        protocol : protocolUri
      });
      expect(remoteRequestsBob).toHaveLength(0);

      // send from alice to bob's remote DWN
      const sendReply = await grantRequest.send(bobDid.uri);
      expect(sendReply.status.code).toBe(202);

      // fetch the requests from the remote
      remoteRequestsBob = await bobDwn.permissions.queryRequests({
        from     : bobDid.uri,
        protocol : protocolUri
      });
      expect(remoteRequestsBob).toHaveLength(1);
      expect(remoteRequestsBob[0].id).toEqual(grantRequest.id);
    });
  });

  describe('store()', () => {
    it('stores the request', async () => {
      // create a grant not marked as stored
      const request = await aliceDwn.permissions.request({
        store : false,
        scope : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, protocol: protocolUri }
      });

      // validate the grant does not exist in the DWN
      let fetchedRequests = await bobDwn.permissions.queryRequests({
        from     : bobDid.uri,
        protocol : protocolUri
      });
      expect(fetchedRequests.length).toBe(0);

      const sentToBob = await request.send(bobDid.uri);
      expect(sentToBob.status.code).toBe(202);

      // Bob fetches requests
      fetchedRequests = await bobDwn.permissions.queryRequests({
        from     : bobDid.uri,
        protocol : protocolUri
      });
      expect(fetchedRequests.length).toBe(1);

      let localRequests = await bobDwn.permissions.queryRequests({
        protocol: protocolUri
      });
      expect(localRequests.length).toBe(0);

      const remoteGrant = fetchedRequests[0];

      // store the grant
      const stored = await remoteGrant.store();
      expect(stored.status.code).toBe(202);

      // validate the grant now exists in the DWN
      localRequests = await bobDwn.permissions.queryRequests({
        protocol: protocolUri
      });
      expect(localRequests.length).toBe(1);
      expect(localRequests[0].toJSON()).toEqual(request.toJSON());
    });
  });

  describe('grant()', () => {
    it('should create a grant and store it by default', async () => {
      const requestFromBob = await bobDwn.permissions.request({
        store : false,
        scope : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, protocol: protocolUri }
      });

      const sentToAlice = await requestFromBob.send(aliceDid.uri);
      expect(sentToAlice.status.code).toBe(202);

      // Alice fetches requests
      const requests = await aliceDwn.permissions.queryRequests({
        from     : aliceDid.uri,
        protocol : protocolUri
      });
      expect(requests.length).toBe(1);

      // confirm no grants exist
      let grants = await aliceDwn.permissions.queryGrants({
        protocol: protocolUri
      });
      expect(grants.length).toBe(0);

      // Alice grants the request and it will be stored by default
      const dateExpires = Time.createOffsetTimestamp({ seconds: 60 });
      const grant = await requests[0].grant(dateExpires);
      expect(grant).toBeDefined();

      // confirm the grant exists
      grants = await aliceDwn.permissions.queryGrants({
        protocol: protocolUri
      });
      expect(grants.length).toBe(1);
      expect(grants[0].id).toBe(grant.id);
    });

    it('does not store the grant if store is false', async () => {
      const requestFromBob = await bobDwn.permissions.request({
        store : false,
        scope : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, protocol: protocolUri }
      });

      const sentToAlice = await requestFromBob.send(aliceDid.uri);
      expect(sentToAlice.status.code).toBe(202);

      // Alice fetches requests
      const requests = await aliceDwn.permissions.queryRequests({
        from     : aliceDid.uri,
        protocol : protocolUri
      });
      expect(requests.length).toBe(1);

      // confirm no grants exist
      let grants = await aliceDwn.permissions.queryGrants({
        protocol: protocolUri
      });
      expect(grants.length).toBe(0);

      // Alice grants the request but does not store it
      const dateExpires = Time.createOffsetTimestamp({ seconds: 60 });
      const grant = await requests[0].grant(dateExpires, false);
      expect(grant).toBeDefined();

      // confirm the grant does not exist
      grants = await aliceDwn.permissions.queryGrants({
        protocol: protocolUri
      });
      expect(grants.length).toBe(0);
    });
  });

  describe('toJSON()', () => {
    it('should return the PermissionRequest as a JSON object', async () => {
      const { request, message } = await testHarness.agent.permissions.createRequest({
        author : aliceDid.uri,
        scope  : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
          protocol  : protocolUri
        }
      });

      const grantRequest = await PermissionRequest.parse({
        agent        : testHarness.agent,
        connectedDid : bobDid.uri,
        message
      });

      expect(grantRequest.toJSON()).toEqual(request);
    });
  });
});
