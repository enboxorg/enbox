import type { BearerDid } from '@enbox/dids';
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { DwnPermissionScope, EnboxPlatformAgent } from '../src/index.js';

import { AgentPermissionsApi } from '../src/permissions-api.js';
import { Convert } from '@enbox/common';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { DwnInterface, DwnPermissionGrant, type PermissionGrantEntry } from '../src/index.js';
import { DwnInterfaceName, DwnMethodName, PermissionsProtocol, Time } from '@enbox/dwn-sdk-js';


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
          messageType  : DwnInterface.MessagesQuery,
        });
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toBe('CachedPermissions: No permissions found for MessagesQuery: undefined');
      }

      // create a permission grant to fetch
      const messagesQueryGrant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
        }
      });

      // store the grant as owner from bob so that it can be fetched
      const { encodedData, ...messagesQueryGrantMessage } = messagesQueryGrant.message;
      const grantReply = await testHarness.agent.processDwnRequest({
        target      : bobDid.uri,
        author      : bobDid.uri,
        signAsOwner : true,
        messageType : DwnInterface.RecordsWrite,
        rawMessage  : messagesQueryGrantMessage,
        dataStream  : new Blob([ Convert.base64Url(encodedData).toUint8Array() ])
      });
      expect(grantReply.reply.status.code).toBe(202);

      // fetch the grant
      const fetchedMessagesQueryGrant = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.MessagesQuery,
      });
      expect(fetchedMessagesQueryGrant.message.recordId).toBe(messagesQueryGrant.message.recordId);
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

    it('uses unambiguous cache keys for protocolPath-scoped grants', async () => {
      const storeGrantForDelegate = async (scope: DwnPermissionScope): Promise<PermissionGrantEntry> => {
        const grant = await testHarness.agent.permissions.createGrant({
          store       : true,
          author      : aliceDid.uri,
          grantedTo   : bobDid.uri,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
          scope
        });

        const { encodedData, ...grantMessage } = grant.message;
        const reply = await testHarness.agent.processDwnRequest({
          target      : bobDid.uri,
          author      : bobDid.uri,
          signAsOwner : true,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : grantMessage,
          dataStream  : new Blob([ Convert.base64Url(encodedData).toUint8Array() ])
        });
        expect(reply.reply.status.code).toBe(202);

        return grant;
      };

      const firstGrant = await storeGrantForDelegate({
        interface    : DwnInterfaceName.Messages,
        method       : DwnMethodName.Read,
        protocol     : 'http://example.com/a',
        protocolPath : 'b~c'
      });
      const secondGrant = await storeGrantForDelegate({
        interface    : DwnInterfaceName.Messages,
        method       : DwnMethodName.Read,
        protocol     : 'http://example.com/a~b',
        protocolPath : 'c'
      });

      const fetchGrantSpy = spyOn(testHarness.agent.permissions, 'fetchGrants');

      const firstFetched = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.MessagesRead,
        protocol     : 'http://example.com/a',
        protocolPath : 'b~c',
        cached       : false
      });
      expect(firstFetched.message.recordId).toBe(firstGrant.message.recordId);
      expect(fetchGrantSpy.mock.calls.length).toBe(1);

      const secondFetched = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.MessagesRead,
        protocol     : 'http://example.com/a~b',
        protocolPath : 'c',
        cached       : true
      });
      expect(secondFetched.message.recordId).toBe(secondGrant.message.recordId);
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

    it('should fall back to scoped remote revocation queries when checking remote grants', async () => {
      const writeGrant = await testHarness.agent.permissions.createGrant({
        store       : false,
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/remote-revocation-test'
        }
      });
      const readGrant = await testHarness.agent.permissions.createGrant({
        store       : false,
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Read,
          protocol  : 'http://example.com/remote-revocation-test'
        }
      });
      const writeRevocationMessage = {
        ...writeGrant.message,
        contextId  : `${writeGrant.message.contextId}/remote-revocation`,
        recordId   : 'remote-revocation',
        descriptor : {
          ...writeGrant.message.descriptor,
          parentId     : writeGrant.message.recordId,
          protocolPath : PermissionsProtocol.revocationPath,
        },
      };

      const sendDwnRequestStub = spyOn(testHarness.agent, 'sendDwnRequest').mockImplementation(async (request) => {
        const filter = 'messageParams' in request
          ? request.messageParams.filter as Record<string, unknown>
          : {};

        if (filter.protocolPath === PermissionsProtocol.grantPath) {
          return {
            messageCid : '',
            reply      : { entries: [writeGrant.message, readGrant.message], status: { code: 200, detail: 'OK' } }
          };
        }

        const entries = filter.contextId === writeGrant.message.contextId ? [writeRevocationMessage] : [];
        return {
          messageCid : '',
          reply      : { entries, status: { code: 200, detail: 'OK' } }
        };
      });

      const grants = await testHarness.agent.permissions.fetchGrants({
        author   : aliceDid.uri,
        target   : aliceDid.uri,
        protocol : 'http://example.com/remote-revocation-test',
        remote   : true,
      });

      expect(grants.length).toBe(1);
      expect(grants[0].message.recordId).toBe(readGrant.message.recordId);

      const revocationFilters = sendDwnRequestStub.mock.calls
        .map(([request]) => ('messageParams' in request ? request.messageParams.filter as Record<string, unknown> : {}))
        .filter(filter => filter.protocolPath === PermissionsProtocol.revocationPath);
      expect(revocationFilters.length).toBe(2);
      expect(revocationFilters.some(filter => filter.contextId === writeGrant.message.contextId)).toBe(true);
      expect(revocationFilters.some(filter => filter.contextId === readGrant.message.contextId)).toBe(true);
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

    it('should batch local revocation checks through one message store query', async () => {
      const writeGrant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/revocation-roundtrip-test'
        }
      });
      const readGrant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Read,
          protocol  : 'http://example.com/revocation-roundtrip-test'
        }
      });
      await testHarness.agent.permissions.createRevocation({
        store  : true,
        author : aliceDid.uri,
        grant  : writeGrant.grant,
      });

      const messageStoreQuerySpy = spyOn(testHarness.agent.dwn.node.storage.messageStore, 'query');

      const grants = await testHarness.agent.permissions.fetchGrants({
        author   : aliceDid.uri,
        target   : aliceDid.uri,
        protocol : 'http://example.com/revocation-roundtrip-test',
      });

      expect(grants.length).toBe(1);
      expect(grants[0].message.recordId).toBe(readGrant.message.recordId);

      const revocationQueryCalls = messageStoreQuerySpy.mock.calls.filter(([, filters]) =>
        (filters as Array<Record<string, unknown>>).some(filter => filter.protocolPath === PermissionsProtocol.revocationPath)
      );
      expect(revocationQueryCalls.length).toBe(1);

      const revocationFilters = revocationQueryCalls[0][1] as Array<Record<string, unknown>>;
      expect(revocationFilters.length).toBe(1);
      expect(revocationFilters[0].method).toBe(DwnMethodName.Write);
      expect(revocationFilters[0].parentId).toEqual(expect.arrayContaining([
        writeGrant.message.recordId,
        readGrant.message.recordId,
      ]));
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
      const parsedGrant = DwnPermissionGrant.parse(deviceXGrant.message);

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
      const writeGrant = DwnPermissionGrant.parse(deviceXGrant.message);

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
      const writeGrant = DwnPermissionGrant.parse(deviceXGrant.message);

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
      grantorAgent: EnboxPlatformAgent;
      granteeAgent: EnboxPlatformAgent;
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
      grantorAgent: EnboxPlatformAgent;
      granteeAgent: EnboxPlatformAgent;
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

      const messagesQueryGrant = await grantorAgent.permissions.createGrant({
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

      const messagesSubscribeGrant = await grantorAgent.permissions.createGrant({
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

      return {
        read      : messagesReadGrant,
        query     : messagesQueryGrant,
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
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
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
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
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
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
      });

      const aliceDeviceXMessageGrants = [
        messagesGrants.query,
        messagesGrants.read,
        messagesGrants.subscribe
      ];

      // control: match a grant without specifying delegated
      const queryGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesQuery,
      }, aliceDeviceXMessageGrants);

      expect(queryGrant?.message.recordId).toBe(messagesGrants.query.message.recordId);

      // attempt to match non-delegated grant with delegated set to true
      const notFoundDelegated = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesQuery,
      }, aliceDeviceXMessageGrants, true);

      expect(notFoundDelegated).toBeUndefined();

      // create delegated record grants
      const protocol = 'http://example.com/protocol';
      const recordsGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
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

      // Messages.Read is the only valid Messages scope — one grant covers
      // Query, Read, and Subscribe operations.
      const grant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read },
      });

      const grants = [ grant ];

      // All Messages feed operations match the same Read grant.
      for (const messageType of [
        DwnInterface.MessagesQuery,
        DwnInterface.MessagesRead,
        DwnInterface.MessagesSubscribe,
      ]) {
        const matched = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
          messageType,
        }, grants);
        expect(matched?.message.recordId).toBe(grant.message.recordId);
      }

      // Non-Messages operations do not match.
      const invalidGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.RecordsQuery,
      }, grants);

      expect(invalidGrant).toBeUndefined();
    });

    it('Messages.Read unified scope covers Query, Read, and Subscribe', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // Only a Messages.Read grant exists (no separate Subscribe grant)
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

      // Messages.Read also matches a MessagesQuery lookup
      const matchedQuery = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesQuery,
      }, readOnlyGrants);
      expect(matchedQuery?.message.recordId).toBe(readGrant.message.recordId);

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

    it('rejects malformed Messages grant with method !== Read', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // Create a valid Messages.Read grant, then tamper with the parsed scope
      // to simulate a legacy/malformed grant with method: 'Sync'.
      const grant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read },
      });

      // Build a tampered PermissionGrantEntry with scope.method = 'Sync' to
      // simulate a malformed/legacy grant that bypassed schema validation.
      const tamperedEntry = {
        message : grant.message,
        grant   : {
          ...grant.grant,
          scope: { ...grant.grant.scope, method: 'Sync' },
        },
      };

      // The tampered grant should NOT match any Messages operation.
      for (const messageType of [
        DwnInterface.MessagesQuery,
        DwnInterface.MessagesRead,
        DwnInterface.MessagesSubscribe,
      ]) {
        const matched = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
          messageType,
        }, [tamperedEntry as any]);
        expect(matched).toBeUndefined();
      }
    });

    it('Messages with protocol', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const protocol = 'http://example.com/protocol';
      const otherProtocol = 'http://example.com/other-protocol';

      // Messages.Read is the only valid Messages scope — one grant per protocol
      // covers Query, Read, and Subscribe operations.
      const protoGrant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, protocol },
      });

      const otherProtoGrant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, protocol: otherProtocol },
      });

      const deviceXMessageGrants = [ protoGrant, otherProtoGrant ];

      // All Messages feed operations match the same Read grant for the given protocol.
      for (const messageType of [
        DwnInterface.MessagesQuery,
        DwnInterface.MessagesRead,
        DwnInterface.MessagesSubscribe,
      ]) {
        const matched = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
          messageType,
          protocol,
        }, deviceXMessageGrants);
        expect(matched?.message.recordId).toBe(protoGrant.message.recordId);
      }

      // Unknown protocol returns no match.
      const invalidGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesQuery,
        protocol    : 'http://example.com/unknown-protocol'
      }, deviceXMessageGrants);

      expect(invalidGrant).toBeUndefined();

      // Other protocol matches the other grant.
      const otherMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesQuery,
        protocol    : otherProtocol
      }, deviceXMessageGrants);

      expect(otherMatch?.message.recordId).toBe(otherProtoGrant.message.recordId);
    });

    it('Messages.Read unified scope covers Query, Read, and Subscribe with protocol', async () => {
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

      // Matches MessagesQuery for the same protocol
      const matchedQuery = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesQuery,
        protocol
      }, readOnlyGrants);
      expect(matchedQuery?.message.recordId).toBe(readGrant.message.recordId);

      // Matches MessagesSubscribe for the same protocol
      const matchedSubscribe = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesSubscribe,
        protocol
      }, readOnlyGrants);
      expect(matchedSubscribe?.message.recordId).toBe(readGrant.message.recordId);

      // Does NOT match a different protocol
      const noMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesQuery,
        protocol    : 'http://example.com/other-protocol'
      }, readOnlyGrants);
      expect(noMatch).toBeUndefined();
    });

    it('Messages with protocolPath and contextId', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const protocol = 'http://example.com/messages-scope-protocol';

      const pathGrant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : {
          interface    : DwnInterfaceName.Messages,
          method       : DwnMethodName.Read,
          protocol,
          protocolPath : 'post'
        }
      });

      const contextGrant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
          protocol,
          contextId : 'root'
        }
      });

      const grants = [pathGrant, contextGrant];

      const pathMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType  : DwnInterface.MessagesRead,
        protocol,
        protocolPath : 'post'
      }, grants);
      expect(pathMatch?.message.recordId).toBe(pathGrant.message.recordId);

      const queryPathMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType  : DwnInterface.MessagesQuery,
        protocol,
        protocolPath : 'post'
      }, grants);
      expect(queryPathMatch?.message.recordId).toBe(pathGrant.message.recordId);

      const childPathMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType  : DwnInterface.MessagesRead,
        protocol,
        protocolPath : 'post/comment'
      }, grants);
      expect(childPathMatch).toBeUndefined();

      const wrongProtocolPathMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType  : DwnInterface.MessagesRead,
        protocol     : 'http://example.com/messages-scope-other-protocol',
        protocolPath : 'post'
      }, grants);
      expect(wrongProtocolPathMatch).toBeUndefined();

      const contextChildMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesRead,
        protocol,
        contextId   : 'root/child'
      }, grants);
      expect(contextChildMatch?.message.recordId).toBe(contextGrant.message.recordId);

      const contextSiblingMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesRead,
        protocol,
        contextId   : 'root2'
      }, grants);
      expect(contextSiblingMatch).toBeUndefined();

      const protocolOnlyMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesQuery,
        protocol
      }, grants);
      expect(protocolOnlyMatch).toBeUndefined();
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
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        protocol     : protocol1,
      });

      const otherProtocolGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
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
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        protocol,
        protocolPath : 'foo'
      });

      const barGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
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
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        protocol,
        contextId    : 'abc'
      });

      const defGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
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

      const childContextGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        protocol    : protocol,
        contextId   : 'abc/child'
      }, contextGrants);

      expect(childContextGrant?.message.recordId).toBe(abcGrants.write.message.recordId);

      const withoutContextGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        protocol    : protocol
      }, contextGrants);

      expect(withoutContextGrant).toBeUndefined();
    });
  });
});
