import type { BearerDid } from '@enbox/dids';
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { DwnPermissionScope, Web5PlatformAgent } from '../src/index.js';

import { AgentPermissionsApi } from '../src/permissions-api.js';
import { Convert } from '@enbox/common';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { DwnInterface, DwnPermissionGrant, type PermissionGrantEntry } from '../src/index.js';
import { DwnInterfaceName, DwnMethodName, Time } from '@enbox/dwn-sdk-js';


describe('AgentPermissionsApi', () => {
  let testHarness: PlatformAgentTestHarness;
  let aliceDid: BearerDid;
  let bobDid: BearerDid;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'memory'
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    // Create an "alice" Identity to author the DWN messages.
    const alice = await testHarness.agent.identity.create({ didMethod: 'jwk', metadata: { name: 'Alice' } });
    aliceDid = alice.did;

    const bob = await testHarness.agent.identity.create({ didMethod: 'jwk', metadata: { name: 'Bob' } });
    bobDid = bob.did;
  });

  afterAll(async () => {
    mock.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  beforeEach(async () => {
    mock.restore();
    await testHarness.clearDwnStores();
  });

  describe('get agent', () => {
    it(`returns the 'agent' instance property`, async () => {
      // we are only mocking
      const permissionsApi = new AgentPermissionsApi({ agent: testHarness.agent });
      const agent = permissionsApi.agent;
      expect(agent).toBeDefined();
      expect(agent.agentDid).toBe(testHarness.agent.agentDid);
    });

    it(`throws an error if the 'agent' instance property is undefined`, () => {
      const permissionsApi = new AgentPermissionsApi();
      expect(() =>
        permissionsApi.agent
      ).toThrow('AgentPermissionsApi: Agent is not set');
    });
  });

  describe('getPermission', () => {
    it('throws an error if no permissions are found', async () => {
      try {
        await testHarness.agent.permissions.getPermissionForRequest({
          connectedDid : aliceDid.uri,
          delegateDid  : bobDid.uri,
          messageType  : DwnInterface.MessagesSync,
        });
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toBe('CachedPermissions: No permissions found for MessagesSync: undefined');
      }

      // create a permission grant to fetch
      const messagesSyncGrant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Sync,
        }
      });

      // store the grant as owner from bob so that it can be fetched
      const { encodedData, ...messagesSyncGrantMessage } = messagesSyncGrant.message;
      const grantReply = await testHarness.agent.processDwnRequest({
        target      : bobDid.uri,
        author      : bobDid.uri,
        signAsOwner : true,
        messageType : DwnInterface.RecordsWrite,
        rawMessage  : messagesSyncGrantMessage,
        dataStream  : new Blob([ Convert.base64Url(encodedData).toUint8Array() ])
      });
      expect(grantReply.reply.status.code).toBe(202);

      // fetch the grant
      const fetchedMessagesSyncGrant = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.MessagesSync,
      });
      expect(fetchedMessagesSyncGrant.message.recordId).toBe(messagesSyncGrant.message.recordId);
    });

    it('caches and returns the permission grant', async () => {
      // create a RecordsWrite grant from alice to bob
      const protocolUri = 'http://example.com/protocol';
      const recordsWriteGrant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : protocolUri
        }
      });
      expect(recordsWriteGrant).toBeDefined();

      // store as bob
      const { encodedData, ...recordsWriteGrantMessage } = recordsWriteGrant.message;
      const grantReply = await testHarness.agent.processDwnRequest({
        target      : bobDid.uri,
        author      : bobDid.uri,
        signAsOwner : true,
        messageType : DwnInterface.RecordsWrite,
        rawMessage  : recordsWriteGrantMessage,
        dataStream  : new Blob([ Convert.base64Url(encodedData).toUint8Array() ])
      });
      expect(grantReply.reply.status.code).toBe(202);

      // spy on fetchGrant to ensure it's only called once
      const fetchGrantSpy = spyOn(testHarness.agent.permissions, 'fetchGrants');

      // get the grant
      const fetchedGrant = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.RecordsWrite,
        protocol     : protocolUri,
        cached       : true
      });
      expect(fetchedGrant.message.recordId).toBe(recordsWriteGrant.message.recordId);

      expect(fetchGrantSpy.mock.calls.length).toBe(1);

      // get the grant again
      const fetchedGrant2 = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.RecordsWrite,
        protocol     : protocolUri,
        cached       : true
      });
      expect(fetchedGrant2.message.recordId).toBe(recordsWriteGrant.message.recordId);

      // expect the fetchGrant method to not have been called again
      expect(fetchGrantSpy.mock.calls.length).toBe(1);
    });

    it('should cache the results of a fetch even if cache is set to false', async () => {
      // create a RecordsWrite grant from alice to bob
      const protocolUri = 'http://example.com/protocol';
      const recordsWriteGrant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : protocolUri
        }
      });
      expect(recordsWriteGrant).toBeDefined();

      // store as bob
      const { encodedData, ...recordsWriteGrantMessage } = recordsWriteGrant.message;
      const grantReply = await testHarness.agent.processDwnRequest({
        target      : bobDid.uri,
        author      : bobDid.uri,
        signAsOwner : true,
        messageType : DwnInterface.RecordsWrite,
        rawMessage  : recordsWriteGrantMessage,
        dataStream  : new Blob([ Convert.base64Url(encodedData).toUint8Array() ])
      });
      expect(grantReply.reply.status.code).toBe(202);

      // spy on fetchGrant to ensure it's only called once
      const fetchGrantSpy = spyOn(testHarness.agent.permissions, 'fetchGrants');

      // get the grant with cache set to false (default)
      // this will refresh the cache with the result anyway, but will always call fetchGrant when set to false
      const fetchedGrant = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.RecordsWrite,
        protocol     : protocolUri,
        cached       : false
      });
      expect(fetchedGrant.message.recordId).toBe(recordsWriteGrant.message.recordId);

      expect(fetchGrantSpy.mock.calls.length).toBe(1);

      // get the grant again (with cache set to true)
      const fetchedGrant2 = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.RecordsWrite,
        protocol     : protocolUri,
        cached       : true
      });
      expect(fetchedGrant2.message.recordId).toBe(recordsWriteGrant.message.recordId);

      // expect the fetchGrant method to not have been called again
      expect(fetchGrantSpy.mock.calls.length).toBe(1);

      // call again with cache set to false
      const fetchedGrant3 = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.RecordsWrite,
        protocol     : protocolUri,
        cached       : false
      });
      expect(fetchedGrant3.message.recordId).toBe(recordsWriteGrant.message.recordId);

      // now cache was not set to true, so expect the fetchGrant method to have been called again
      expect(fetchGrantSpy.mock.calls.length).toBe(2);
    });
  });

  describe('fetchGrants', () => {
    it('from remote', async () => {
      // spy on the processDwnRequest method
      const processDwnRequestSpy = spyOn(testHarness.agent, 'processDwnRequest');
      // mock the sendDwnRequest method to return a 200 response
      const sendDwnRequestStub = spyOn(testHarness.agent, 'sendDwnRequest').mockResolvedValue({ messageCid: '', reply: { entries: [], status: { code: 200, detail: 'OK' } } });

      // fetch permission grants
      await testHarness.agent.permissions.fetchGrants({
        author : aliceDid.uri,
        target : aliceDid.uri,
        remote : true
      });

      // expect the processDwnRequest method to not have been called
      expect(processDwnRequestSpy).not.toHaveBeenCalled();

      // expect the sendDwnRequest method to have been called
      expect(sendDwnRequestStub).toHaveBeenCalled();
    });

    it('filter by protocol', async () => {
      // create a grant for permission-1
      const protocol1Grant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol-1'
        }
      });

      // create a grant for permission-2
      const protocol2Grant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol-2'
        }
      });

      // fetch permission grants
      const protocol1Grants = await testHarness.agent.permissions.fetchGrants({
        author   : aliceDid.uri,
        target   : aliceDid.uri,
        protocol : 'http://example.com/protocol-1'
      });
      expect(protocol1Grants.length).toBe(1);
      expect(protocol1Grants[0].grant.id).toBe(protocol1Grant.grant.id);

      const protocol2Grants = await testHarness.agent.permissions.fetchGrants({
        author   : aliceDid.uri,
        target   : aliceDid.uri,
        protocol : 'http://example.com/protocol-2'
      });
      expect(protocol2Grants.length).toBe(1);
      expect(protocol2Grants[0].grant.id).toBe(protocol2Grant.grant.id);
    });

    it('throws if the query returns anything other than 200', async () => {
      // stub the processDwnRequest method to return a 400 error
      spyOn(testHarness.agent, 'processDwnRequest').mockResolvedValue({ messageCid: '', reply: { status: { code: 400, detail: 'Bad Request' } } });

      // fetch permission requests
      try {
        await testHarness.agent.permissions.fetchGrants({
          author : aliceDid.uri,
          target : aliceDid.uri,
        });
      } catch (error: any) {
        expect(error.message).toBe('PermissionsApi: Failed to fetch grants: Bad Request');
      }
    });

    it('should filter out revoked grants by default', async () => {
      // create two grants
      const grant1 = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/revocation-test'
        }
      });

      const grant2 = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Read,
          protocol  : 'http://example.com/revocation-test'
        }
      });

      // both grants should be returned before revocation
      let grants = await testHarness.agent.permissions.fetchGrants({
        author   : aliceDid.uri,
        target   : aliceDid.uri,
        protocol : 'http://example.com/revocation-test',
      });
      expect(grants.length).toBe(2);

      // revoke grant1
      await testHarness.agent.permissions.createRevocation({
        author : aliceDid.uri,
        store  : true,
        grant  : grant1.grant,
      });

      // default (checkRevoked: true) should only return the non-revoked grant
      grants = await testHarness.agent.permissions.fetchGrants({
        author   : aliceDid.uri,
        target   : aliceDid.uri,
        protocol : 'http://example.com/revocation-test',
      });
      expect(grants.length).toBe(1);
      expect(grants[0].grant.id).toBe(grant2.grant.id);
    });

    it('should include revoked grants when checkRevoked is false', async () => {
      // create a grant and revoke it
      const grant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/revocation-test-2'
        }
      });

      // revoke the grant
      await testHarness.agent.permissions.createRevocation({
        author : aliceDid.uri,
        store  : true,
        grant  : grant.grant,
      });

      // with checkRevoked: false, the revoked grant should still be returned
      const grants = await testHarness.agent.permissions.fetchGrants({
        author       : aliceDid.uri,
        target       : aliceDid.uri,
        protocol     : 'http://example.com/revocation-test-2',
        checkRevoked : false,
      });
      expect(grants.length).toBe(1);
      expect(grants[0].grant.id).toBe(grant.grant.id);
    });

    it('should use only 2 DWN roundtrips when checking revocations', async () => {
      const processDwnRequestSpy = spyOn(testHarness.agent, 'processDwnRequest');

      // fetch grants with revocation check (default)
      await testHarness.agent.permissions.fetchGrants({
        author : aliceDid.uri,
        target : aliceDid.uri,
      });

      // expect exactly 2 calls: one for grants query, one for revocations query
      expect(processDwnRequestSpy).toHaveBeenCalledTimes(2);
    });

    it('should use only 1 DWN roundtrip when checkRevoked is false', async () => {
      const processDwnRequestSpy = spyOn(testHarness.agent, 'processDwnRequest');

      // fetch grants without revocation check
      await testHarness.agent.permissions.fetchGrants({
        author       : aliceDid.uri,
        target       : aliceDid.uri,
        checkRevoked : false,
      });

      // expect exactly 1 call: only the grants query
      expect(processDwnRequestSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchRequests', () => {
    it('from remote', async () => {
      // spy on the processDwnRequest method
      const processDwnRequestSpy = spyOn(testHarness.agent, 'processDwnRequest');
      // mock the sendDwnRequest method to return a 200 response
      const sendDwnRequestStub = spyOn(testHarness.agent, 'sendDwnRequest').mockResolvedValue({ messageCid: '', reply: { entries: [], status: { code: 200, detail: 'OK' } } });

      // fetch permission grants
      await testHarness.agent.permissions.fetchRequests({
        author : aliceDid.uri,
        target : aliceDid.uri,
        remote : true
      });

      // expect the processDwnRequest method to not have been called
      expect(processDwnRequestSpy).not.toHaveBeenCalled();

      // expect the sendDwnRequest method to have been called
      expect(sendDwnRequestStub).toHaveBeenCalled();
    });

    it('filter by protocol', async () => {
      // create a request for permission-1
      const protocol1Request = await testHarness.agent.permissions.createRequest({
        author : aliceDid.uri,
        store  : true,
        scope  : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol-1'
        }
      });

      // create a request for permission-2
      const protocol2Request = await testHarness.agent.permissions.createRequest({
        author : aliceDid.uri,
        store  : true,
        scope  : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol-2'
        }
      });

      // fetch permission grants
      const protocol1Requests = await testHarness.agent.permissions.fetchRequests({
        author   : aliceDid.uri,
        target   : aliceDid.uri,
        protocol : 'http://example.com/protocol-1'
      });
      expect(protocol1Requests.length).toBe(1);
      expect(protocol1Requests[0].request.id).toBe(protocol1Request.request.id);

      const protocol2Requests = await testHarness.agent.permissions.fetchRequests({
        author   : aliceDid.uri,
        target   : aliceDid.uri,
        protocol : 'http://example.com/protocol-2'
      });
      expect(protocol2Requests.length).toBe(1);
      expect(protocol2Requests[0].request.id).toBe(protocol2Request.request.id);
    });

    it('throws if the query returns anything other than 200', async () => {
      // stub the processDwnRequest method to return a 400 error
      spyOn(testHarness.agent, 'processDwnRequest').mockResolvedValue({ messageCid: '', reply: { status: { code: 400, detail: 'Bad Request' } } });

      // fetch permission requests
      try {
        await testHarness.agent.permissions.fetchRequests({
          author : aliceDid.uri,
          target : aliceDid.uri,
        });
      } catch (error: any) {
        expect(error.message).toBe('PermissionsApi: Failed to fetch requests: Bad Request');
      }
    });
  });

  describe('isGrantRevoked', () => {
    it('from remote', async () => {
      // spy on the processDwnRequest method
      const processDwnRequestSpy = spyOn(testHarness.agent, 'processDwnRequest');
      // mock the sendDwnRequest method to return a 200 response
      const sendDwnRequestStub = spyOn(testHarness.agent, 'sendDwnRequest').mockResolvedValue({ messageCid: '', reply: { status: { code: 200, detail: 'OK' } } });

      // fetch permission grants
      await testHarness.agent.permissions.isGrantRevoked({
        author        : aliceDid.uri,
        target        : aliceDid.uri,
        grantRecordId : 'grant-record-id',
        remote        : true
      });

      // expect the processDwnRequest method to not have been called
      expect(processDwnRequestSpy).not.toHaveBeenCalled();

      // expect the sendDwnRequest method to have been called
      expect(sendDwnRequestStub).toHaveBeenCalled();
    });

    it('throws if the request was bad', async () => {
      // stub the processDwnRequest method to return a 400 error
      spyOn(testHarness.agent, 'processDwnRequest').mockResolvedValue({ messageCid: '', reply: { status: { code: 400, detail: 'Bad Request' } } });

      // create a permission request
      try {
        await testHarness.agent.permissions.isGrantRevoked({
          author        : aliceDid.uri,
          target        : aliceDid.uri,
          grantRecordId : 'grant-record-id'
        });
      } catch (error: any) {
        expect(error.message).toBe('PermissionsApi: Failed to check if grant is revoked: Bad Request');
      }
    });

    it('returns revocation status', async () => {
      // scenario: create a grant for deviceX, revoke the grant, confirm the grant is revoked

      // create an identity for deviceX
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // create a grant for deviceX
      const deviceXGrant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // check if the grant is revoked
      let isRevoked = await testHarness.agent.permissions.isGrantRevoked({
        author        : aliceDid.uri,
        target        : aliceDid.uri,
        grantRecordId : deviceXGrant.grant.id
      });
      expect(isRevoked).toBe(false);

      // create a revocation for the grant
      await testHarness.agent.permissions.createRevocation({
        author : aliceDid.uri,
        store  : true,
        grant  : deviceXGrant.grant,
      });

      // check if the grant is revoked again, should be true
      isRevoked = await testHarness.agent.permissions.isGrantRevoked({
        author        : aliceDid.uri,
        target        : aliceDid.uri,
        grantRecordId : deviceXGrant.grant.id
      });
      expect(isRevoked).toBe(true);
    });
  });

  describe('createGrant', () => {
    it('throws if the grant was not created', async () => {
      // stub the processDwnRequest method to return a 400 error
      spyOn(testHarness.agent, 'processDwnRequest').mockResolvedValue({ messageCid: '', reply: { status: { code: 400, detail: 'Bad Request' } } });

      // create a permission request
      try {
        await testHarness.agent.permissions.createGrant({
          author      : aliceDid.uri,
          grantedTo   : 'did:example:deviceX',
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
          store       : true,
          scope       : {} as DwnPermissionScope,
        });
      } catch (error: any) {
        expect(error.message).toBe('PermissionsApi: Failed to create grant: Bad Request');
      }
    });

    it('creates and stores a grant', async () => {
      // scenario: create a grant for deviceX, confirm the grant exists

      // create an identity for deviceX
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : false,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });


      // create a grant for deviceX
      const deviceXGrant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      const grants = await testHarness.agent.permissions.fetchGrants({
        author : aliceDid.uri,
        target : aliceDid.uri,
      });

      // expect to have the 1 grant created for deviceX
      expect(grants.length).toBe(1);
      expect(grants[0].message.recordId).toBe(deviceXGrant.message.recordId);
    });

    it('creates a grant without storing it', async () => {
      // scenario: create a grant for deviceX, confirm the grant does not exist

      // create an identity for deviceX
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : false,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // create a grant for deviceX store is set to false by default
      const deviceXGrant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      const grantDataObject = { ...deviceXGrant.grant };
      const parsedGrant = await DwnPermissionGrant.parse(deviceXGrant.message);

      expect(grantDataObject).toEqual(parsedGrant);
    });
  });

  describe('createRevocation', () => {
    it('throws if the revocation was not created', async () => {
      // stub the processDwnRequest method to return a 400 error
      spyOn(testHarness.agent, 'processDwnRequest').mockResolvedValue({ messageCid: '', reply: { status: { code: 400, detail: 'Bad Request' } } });

      // create a permission request
      try {
        await testHarness.agent.permissions.createRevocation({
          author : aliceDid.uri,
          store  : true,
          grant  : {
            scope: {}
          } as DwnPermissionGrant,
        });
      } catch (error: any) {
        expect(error.message).toBe('PermissionsApi: Failed to create revocation: Bad Request');
      }

    });

    it('creates and stores a grant revocation', async () => {
      // scenario: create a grant for deviceX, revoke the grant, confirm the grant is revoked

      // create an identity for deviceX
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // create a grant for deviceX
      const deviceXGrant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // parse the grant
      const writeGrant = await DwnPermissionGrant.parse(deviceXGrant.message);

      // check if the grant is revoked
      let isRevoked = await testHarness.agent.permissions.isGrantRevoked({
        author        : aliceDid.uri,
        target        : aliceDid.uri,
        grantRecordId : deviceXGrant.grant.id
      });
      expect(isRevoked).toBe(false);

      // create a revocation for the grant
      await testHarness.agent.permissions.createRevocation({
        author : aliceDid.uri,
        store  : true,
        grant  : writeGrant,
      });

      // check if the grant is revoked again, should be true
      isRevoked = await testHarness.agent.permissions.isGrantRevoked({
        author        : aliceDid.uri,
        target        : aliceDid.uri,
        grantRecordId : deviceXGrant.grant.id
      });
      expect(isRevoked).toBe(true);
    });

    it('creates a grant revocation without storing it', async () => {
      // scenario: create a grant for deviceX, revoke the grant, confirm the grant is revoked

      // create an identity for deviceX
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // create a grant for deviceX
      const deviceXGrant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // parse the grant
      const writeGrant = await DwnPermissionGrant.parse(deviceXGrant.message);

      // check if the grant is revoked
      let isRevoked = await testHarness.agent.permissions.isGrantRevoked({
        author        : aliceDid.uri,
        target        : aliceDid.uri,
        grantRecordId : deviceXGrant.grant.id
      });
      expect(isRevoked).toBe(false);

      // create a revocation for the grant without storing it
      await testHarness.agent.permissions.createRevocation({
        author : aliceDid.uri,
        grant  : writeGrant,
      });

      // check if the grant is revoked again, should be true
      isRevoked = await testHarness.agent.permissions.isGrantRevoked({
        author        : aliceDid.uri,
        target        : aliceDid.uri,
        grantRecordId : deviceXGrant.grant.id
      });
      expect(isRevoked).toBe(false);
    });
  });

  describe('createRequest', () => {
    it('throws if the request was not created', async () => {
      // stub the processDwnRequest method to return a 400 error
      spyOn(testHarness.agent, 'processDwnRequest').mockResolvedValue({ messageCid: '', reply: { status: { code: 400, detail: 'Bad Request' } } });

      // create a permission request
      try {
        await testHarness.agent.permissions.createRequest({
          author : aliceDid.uri,
          scope  : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Write,
            protocol  : 'http://example.com/protocol'
          }
        });
      } catch (error: any) {
        expect(error.message).toBe('PermissionsApi: Failed to create request: Bad Request');
      }

    });

    it('creates a permission request and stores it', async () => {
      // scenario: create a permission request confirm the request exists

      // create a permission request
      const deviceXRequest = await testHarness.agent.permissions.createRequest({
        author : aliceDid.uri,
        store  : true,
        scope  : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // query for the request
      const fetchedRequests = await testHarness.agent.permissions.fetchRequests({
        author : aliceDid.uri,
        target : aliceDid.uri,
      });

      // expect to have the 1 request created
      expect(fetchedRequests.length).toBe(1);
      expect(fetchedRequests[0].request.id).toBe(deviceXRequest.message.recordId);
    });

    it('creates a permission request without storing it', async () => {
      // scenario: create a permission request confirm the request does not exist

      // create a permission request store is set to false by default
      await testHarness.agent.permissions.createRequest({
        author : aliceDid.uri,
        scope  : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // query for the request
      const fetchedRequests = await testHarness.agent.permissions.fetchRequests({
        author : aliceDid.uri,
        target : aliceDid.uri,
      });

      // expect to have no requests
      expect(fetchedRequests.length).toBe(0);
    });
  });

  describe('matchGrantFromArray', () => {

    const createRecordGrants = async ({ grantee, grantor, grantorAgent, protocol, protocolPath, contextId }:{
      grantorAgent: Web5PlatformAgent;
      granteeAgent: Web5PlatformAgent;
      grantor: string;
      grantee: string;
      protocol: string;
      protocolPath?: string;
      contextId?: string;
    }): Promise<Record<string, PermissionGrantEntry>> => {
      const recordsWriteGrant = await grantorAgent.permissions.createGrant({
        author      : grantor,
        grantedTo   : grantee,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        delegated   : true,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol,
          protocolPath,
          contextId
        }
      });

      const recordsReadGrant = await grantorAgent.permissions.createGrant({
        author      : grantor,
        grantedTo   : grantee,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        delegated   : true,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Read,
          protocol,
          protocolPath,
          contextId
        }
      });

      const recordsDeleteGrant = await grantorAgent.permissions.createGrant({
        author      : grantor,
        grantedTo   : grantee,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        delegated   : true,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Delete,
          protocol,
          protocolPath,
          contextId
        }
      });

      const recordsQueryGrant = await grantorAgent.permissions.createGrant({
        author      : grantor,
        grantedTo   : grantee,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        delegated   : true,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Query,
          protocol,
          protocolPath,
          contextId
        }
      });

      const recordsSubscribeGrant = await grantorAgent.permissions.createGrant({
        author      : grantor,
        grantedTo   : grantee,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        delegated   : true,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Subscribe,
          protocol,
          protocolPath,
          contextId
        }
      });

      return {
        write     : recordsWriteGrant,
        read      : recordsReadGrant,
        delete    : recordsDeleteGrant,
        query     : recordsQueryGrant,
        subscribe : recordsSubscribeGrant
      };
    };

    const createMessageGrants = async ({ grantee, grantor, grantorAgent, protocol }:{
      grantorAgent: Web5PlatformAgent;
      granteeAgent: Web5PlatformAgent;
      grantor: string;
      grantee: string;
      protocol?: string;
    }): Promise<Record<string, PermissionGrantEntry>> => {

      const messagesReadGrant = await grantorAgent.permissions.createGrant({
        author      : grantor,
        grantedTo   : grantee,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
          protocol
        }
      });

      const messagesSyncGrant = await grantorAgent.permissions.createGrant({
        author      : grantor,
        grantedTo   : grantee,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Sync,
          protocol
        }
      });

      const messagesSubscribeGrant = await grantorAgent.permissions.createGrant({
        author      : grantor,
        grantedTo   : grantee,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Subscribe,
          protocol
        }
      });

      return {
        read      : messagesReadGrant,
        sync      : messagesSyncGrant,
        subscribe : messagesSubscribeGrant
      };
    };

    it('does not match a grant with a different grantee or grantor', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const aliceDeviceY = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device Y' },
        didMethod : 'jwk'
      });

      const protocol = 'http://example.com/protocol';


      const deviceXRecordGrantsFromAlice = await createRecordGrants({
        grantorAgent : testHarness.agent as Web5PlatformAgent,
        granteeAgent : testHarness.agent as Web5PlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        protocol
      });

      const deviceXRecordGrantsFromAliceArray = [
        deviceXRecordGrantsFromAlice.write,
        deviceXRecordGrantsFromAlice.read,
        deviceXRecordGrantsFromAlice.delete,
        deviceXRecordGrantsFromAlice.query,
        deviceXRecordGrantsFromAlice.subscribe
      ];

      // attempt to match a grant with a different grantee, aliceDeviceY
      const notFoundGrantee = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceY.did.uri, {
        messageType: DwnInterface.RecordsWrite,
        protocol
      }, deviceXRecordGrantsFromAliceArray);

      expect(notFoundGrantee).toBeUndefined();

      const deviceYRecordGrantsFromDeviceX = await createRecordGrants({
        grantorAgent : testHarness.agent as Web5PlatformAgent,
        granteeAgent : testHarness.agent as Web5PlatformAgent,
        grantor      : aliceDeviceX.did.uri,
        grantee      : aliceDeviceY.did.uri,
        protocol
      });

      const deviceYRecordGrantsFromDeviceXArray = [
        deviceYRecordGrantsFromDeviceX.write,
        deviceYRecordGrantsFromDeviceX.read,
        deviceYRecordGrantsFromDeviceX.delete,
        deviceYRecordGrantsFromDeviceX.query,
        deviceYRecordGrantsFromDeviceX.subscribe
      ];

      const notFoundGrantor = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceY.did.uri, {
        messageType: DwnInterface.RecordsWrite,
        protocol
      }, deviceYRecordGrantsFromDeviceXArray);

      expect(notFoundGrantor).toBeUndefined();
    });

    it('matches delegated grants if specified', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const messagesGrants = await createMessageGrants({
        grantorAgent : testHarness.agent as Web5PlatformAgent,
        granteeAgent : testHarness.agent as Web5PlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
      });

      const aliceDeviceXMessageGrants = [
        messagesGrants.sync,
        messagesGrants.read,
        messagesGrants.subscribe
      ];

      // control: match a grant without specifying delegated
      const syncGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesSync,
      }, aliceDeviceXMessageGrants);

      expect(syncGrant?.message.recordId).toBe(messagesGrants.sync.message.recordId);

      // attempt to match non-delegated grant with delegated set to true
      const notFoundDelegated = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesSync,
      }, aliceDeviceXMessageGrants, true);

      expect(notFoundDelegated).toBeUndefined();

      // create delegated record grants
      const protocol = 'http://example.com/protocol';
      const recordsGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as Web5PlatformAgent,
        granteeAgent : testHarness.agent as Web5PlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        protocol
      });

      const deviceXRecordGrants = [
        recordsGrants.write,
        recordsGrants.read,
        recordsGrants.delete,
        recordsGrants.query,
        recordsGrants.subscribe
      ];

      // match a delegated grant
      const writeGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.RecordsWrite,
        protocol
      }, deviceXRecordGrants, true);

      expect(writeGrant?.message.recordId).toBe(recordsGrants.write.message.recordId);
    });

    it('Messages', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const messageGrants = await createMessageGrants({
        grantorAgent : testHarness.agent as Web5PlatformAgent,
        granteeAgent : testHarness.agent as Web5PlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri
      });

      const deviceXMessageGrants = [
        messageGrants.sync,
        messageGrants.read,
        messageGrants.subscribe
      ];

      const syncGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesSync,
      }, deviceXMessageGrants);

      expect(syncGrant?.message.recordId).toBe(messageGrants.sync.message.recordId);

      const readGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesRead,
      }, deviceXMessageGrants);

      expect(readGrant?.message.recordId).toBe(messageGrants.read.message.recordId);

      const subscribeGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesSubscribe,
      }, deviceXMessageGrants);

      expect(subscribeGrant?.message.recordId).toBe(messageGrants.subscribe.message.recordId);

      const invalidGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.RecordsQuery,
      }, deviceXMessageGrants);

      expect(invalidGrant).toBeUndefined();
    });

    it('Messages.Read unified scope covers Sync and Subscribe', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // Only a Messages.Read grant exists (no separate Sync or Subscribe grants)
      const readGrant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
        }
      });

      const readOnlyGrants = [ readGrant ];

      // Messages.Read matches a MessagesRead lookup
      const matchedRead = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesRead,
      }, readOnlyGrants);
      expect(matchedRead?.message.recordId).toBe(readGrant.message.recordId);

      // Messages.Read also matches a MessagesSync lookup
      const matchedSync = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesSync,
      }, readOnlyGrants);
      expect(matchedSync?.message.recordId).toBe(readGrant.message.recordId);

      // Messages.Read also matches a MessagesSubscribe lookup
      const matchedSubscribe = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesSubscribe,
      }, readOnlyGrants);
      expect(matchedSubscribe?.message.recordId).toBe(readGrant.message.recordId);

      // Messages.Read does NOT match a RecordsQuery lookup
      const noMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.RecordsQuery,
      }, readOnlyGrants);
      expect(noMatch).toBeUndefined();
    });

    it('Messages with protocol', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const protocol = 'http://example.com/protocol';
      const otherProtocol = 'http://example.com/other-protocol';

      const protocolMessageGrants = await createMessageGrants({
        grantorAgent : testHarness.agent as Web5PlatformAgent,
        granteeAgent : testHarness.agent as Web5PlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        protocol
      });

      const otherProtocolMessageGrants = await createMessageGrants({
        grantorAgent : testHarness.agent as Web5PlatformAgent,
        granteeAgent : testHarness.agent as Web5PlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        protocol     : otherProtocol
      });

      const deviceXMessageGrants = [
        protocolMessageGrants.sync,
        protocolMessageGrants.read,
        protocolMessageGrants.subscribe,
        otherProtocolMessageGrants.sync,
        otherProtocolMessageGrants.read,
        otherProtocolMessageGrants.subscribe
      ];

      const syncGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesSync,
        protocol
      }, deviceXMessageGrants);

      expect(syncGrant?.message.recordId).toBe(protocolMessageGrants.sync.message.recordId);

      const readGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesRead,
        protocol
      }, deviceXMessageGrants);

      expect(readGrant?.message.recordId).toBe(protocolMessageGrants.read.message.recordId);

      const subscribeGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesSubscribe,
        protocol
      }, deviceXMessageGrants);

      expect(subscribeGrant?.message.recordId).toBe(protocolMessageGrants.subscribe.message.recordId);

      const invalidGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesSync,
        protocol    : 'http://example.com/unknown-protocol'
      }, deviceXMessageGrants);

      expect(invalidGrant).toBeUndefined();

      const otherProtocolSyncGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesSync,
        protocol    : otherProtocol
      }, deviceXMessageGrants);

      expect(otherProtocolSyncGrant?.message.recordId).toBe(otherProtocolMessageGrants.sync.message.recordId);
    });

    it('Messages.Read unified scope covers Sync and Subscribe with protocol', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const protocol = 'http://example.com/protocol';

      // Only a Messages.Read grant scoped to the protocol
      const readGrant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
          protocol
        }
      });

      const readOnlyGrants = [ readGrant ];

      // Matches MessagesSync for the same protocol
      const matchedSync = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesSync,
        protocol
      }, readOnlyGrants);
      expect(matchedSync?.message.recordId).toBe(readGrant.message.recordId);

      // Matches MessagesSubscribe for the same protocol
      const matchedSubscribe = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesSubscribe,
        protocol
      }, readOnlyGrants);
      expect(matchedSubscribe?.message.recordId).toBe(readGrant.message.recordId);

      // Does NOT match a different protocol
      const noMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesSync,
        protocol    : 'http://example.com/other-protocol'
      }, readOnlyGrants);
      expect(noMatch).toBeUndefined();
    });

    it('Records', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const protocol1 = 'http://example.com/protocol';
      const protocol2 = 'http://example.com/other-protocol';

      const protocol1Grants = await createRecordGrants({
        grantorAgent : testHarness.agent as Web5PlatformAgent,
        granteeAgent : testHarness.agent as Web5PlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        protocol     : protocol1,
      });

      const otherProtocolGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as Web5PlatformAgent,
        granteeAgent : testHarness.agent as Web5PlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        protocol     : protocol2,
      });

      const deviceXRecordGrants = [
        protocol1Grants.write,
        protocol1Grants.read,
        protocol1Grants.delete,
        protocol1Grants.query,
        protocol1Grants.subscribe,
        otherProtocolGrants.write,
        otherProtocolGrants.read,
        otherProtocolGrants.delete,
        otherProtocolGrants.query,
        otherProtocolGrants.subscribe
      ];

      const writeGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        protocol    : protocol1
      }, deviceXRecordGrants);

      expect(writeGrant?.message.recordId).toBe(protocol1Grants.write.message.recordId);

      const readGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsRead,
        protocol    : protocol1
      }, deviceXRecordGrants);

      expect(readGrant?.message.recordId).toBe(protocol1Grants.read.message.recordId);

      const deleteGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsDelete,
        protocol    : protocol1
      }, deviceXRecordGrants);

      expect(deleteGrant?.message.recordId).toBe(protocol1Grants.delete.message.recordId);

      const queryGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsQuery,
        protocol    : protocol1
      }, deviceXRecordGrants);

      expect(queryGrant?.message.recordId).toBe(protocol1Grants.query.message.recordId);

      const subscribeGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsSubscribe,
        protocol    : protocol1
      }, deviceXRecordGrants);

      expect(subscribeGrant?.message.recordId).toBe(protocol1Grants.subscribe.message.recordId);

      const queryGrantOtherProtocol = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsQuery,
        protocol    : protocol2
      }, deviceXRecordGrants);

      expect(queryGrantOtherProtocol?.message.recordId).toBe(otherProtocolGrants.query.message.recordId);

      // unknown protocol
      const invalidGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsQuery,
        protocol    : 'http://example.com/unknown-protocol'
      }, deviceXRecordGrants);

      expect(invalidGrant).toBeUndefined();
    });

    it('Records with protocolPath', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const protocol = 'http://example.com/protocol';

      const fooGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as Web5PlatformAgent,
        granteeAgent : testHarness.agent as Web5PlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        protocol,
        protocolPath : 'foo'
      });

      const barGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as Web5PlatformAgent,
        granteeAgent : testHarness.agent as Web5PlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        protocol,
        protocolPath : 'foo/bar'
      });

      const protocolGrants = [
        fooGrants.write,
        fooGrants.read,
        fooGrants.delete,
        fooGrants.query,
        fooGrants.subscribe,
        barGrants.write,
        barGrants.read,
        barGrants.delete,
        barGrants.query,
        barGrants.subscribe
      ];

      const writeFooGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType  : DwnInterface.RecordsWrite,
        protocol     : protocol,
        protocolPath : 'foo'
      }, protocolGrants);

      expect(writeFooGrant?.message.recordId).toBe(fooGrants.write.message.recordId);

      const readFooGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType  : DwnInterface.RecordsRead,
        protocol     : protocol,
        protocolPath : 'foo'
      }, protocolGrants);

      expect(readFooGrant?.message.recordId).toBe(fooGrants.read.message.recordId);

      const deleteFooGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType  : DwnInterface.RecordsDelete,
        protocol     : protocol,
        protocolPath : 'foo'
      }, protocolGrants);

      expect(deleteFooGrant?.message.recordId).toBe(fooGrants.delete.message.recordId);

      const queryGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType  : DwnInterface.RecordsQuery,
        protocol     : protocol,
        protocolPath : 'foo'
      }, protocolGrants);

      expect(queryGrant?.message.recordId).toBe(fooGrants.query.message.recordId);

      const subscribeGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType  : DwnInterface.RecordsSubscribe,
        protocol     : protocol,
        protocolPath : 'foo'
      }, protocolGrants);

      expect(subscribeGrant?.message.recordId).toBe(fooGrants.subscribe.message.recordId);

      const writeBarGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType  : DwnInterface.RecordsWrite,
        protocol     : protocol,
        protocolPath : 'foo/bar'
      }, protocolGrants);

      expect(writeBarGrant?.message.recordId).toBe(barGrants.write.message.recordId);

      const noMatchGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType  : DwnInterface.RecordsWrite,
        protocol     : protocol,
        protocolPath : 'bar'
      }, protocolGrants);

      expect(noMatchGrant).toBeUndefined();
    });

    it('Records with contextId', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const protocol = 'http://example.com/protocol';

      const abcGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as Web5PlatformAgent,
        granteeAgent : testHarness.agent as Web5PlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        protocol,
        contextId    : 'abc'
      });

      const defGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as Web5PlatformAgent,
        granteeAgent : testHarness.agent as Web5PlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        protocol,
        contextId    : 'def/ghi'
      });

      const contextGrants = [
        abcGrants.write,
        abcGrants.read,
        abcGrants.delete,
        abcGrants.query,
        abcGrants.subscribe,
        defGrants.write,
        defGrants.read,
        defGrants.delete,
        defGrants.query,
        defGrants.subscribe
      ];

      const writeFooGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        protocol    : protocol,
        contextId   : 'abc'
      }, contextGrants);

      expect(writeFooGrant?.message.recordId).toBe(abcGrants.write.message.recordId);

      const writeBarGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        protocol    : protocol,
        contextId   : 'def/ghi'
      }, contextGrants);

      expect(writeBarGrant?.message.recordId).toBe(defGrants.write.message.recordId);

      const invalidGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        protocol    : protocol,
        contextId   : 'def'
      }, contextGrants);

      expect(invalidGrant).toBeUndefined();

      const withoutContextGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        protocol    : protocol
      }, contextGrants);

      expect(withoutContextGrant).toBeUndefined();
    });
  });
});
