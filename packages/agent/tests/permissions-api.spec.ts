import type { BearerDid } from '@enbox/dids';
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { DwnPermissionScope, EnboxPlatformAgent } from '../src/index.js';

import { Convert } from '@enbox/common';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { AgentPermissionsApi, PermissionGrantNotFoundError } from '../src/permissions-api.js';
import { DwnInterface, DwnPermissionGrant, type PermissionGrantEntry } from '../src/index.js';
import { DwnInterfaceName, DwnMethodName, PermissionsModule, Time } from '@enbox/dwn-sdk-js';


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
    const storeGrantAsBob = async (scope: DwnPermissionScope): Promise<PermissionGrantEntry> => {
      const grant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope
      });

      const { encodedData, ...grantMessage } = grant.message;
      const grantReply = await testHarness.agent.processDwnRequest({
        target      : bobDid.uri,
        author      : bobDid.uri,
        signAsOwner : true,
        messageType : DwnInterface.RecordsWrite,
        rawMessage  : grantMessage,
        dataStream  : new Blob([ Convert.base64Url(encodedData).toUint8Array() ])
      });
      expect(grantReply.reply.status.code).toBe(202);

      return grant;
    };

    it('throws an error if no permissions are found', async () => {
      try {
        await testHarness.agent.permissions.getPermissionForRequest({
          connectedDid : aliceDid.uri,
          delegateDid  : bobDid.uri,
          messageType  : DwnInterface.MessagesQuery,
        });
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(PermissionGrantNotFoundError);
        expect(error.message).toBe('AgentPermissionsApi: No matching permission grant found for MessagesQuery: undefined');
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

    it('invalidates a cached catalog when a grant is stored locally', async () => {
      const module = 'http://example.com/permission-cache-invalidation';
      const request = {
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.RecordsWrite,
        module,
      } as const;

      await expect(testHarness.agent.permissions.getPermissionForRequest(request))
        .rejects.toBeInstanceOf(PermissionGrantNotFoundError);

      const storedGrant = await storeGrantAsBob({
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write,
        module,
      });
      const fetchedGrant = await testHarness.agent.permissions.getPermissionForRequest(request);

      expect(fetchedGrant.message.recordId).toBe(storedGrant.message.recordId);
    });

    it('uses Records.Read grants for read-like record requests', async () => {
      const module = 'http://example.com/module';
      const readGrant = await storeGrantAsBob({
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Read,
        module
      });

      for (const messageType of [
        DwnInterface.RecordsCount,
        DwnInterface.RecordsRead,
        DwnInterface.RecordsQuery,
        DwnInterface.RecordsSubscribe,
      ]) {
        const fetchedGrant = await testHarness.agent.permissions.getPermissionForRequest({
          connectedDid : aliceDid.uri,
          delegateDid  : bobDid.uri,
          messageType,
          module
        });
        expect(fetchedGrant.message.recordId).toBe(readGrant.message.recordId);
      }
    });

    it('rejects malformed Records.Query permission grants at storage', async () => {
      const module = 'http://example.com/module';

      await expect(storeGrantAsBob({
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Query as any,
        module
      })).rejects.toThrow('PermissionsApi: Failed to create grant');
    });

    it('caches and returns the permission grant', async () => {
      // create a RecordsWrite grant from alice to bob
      const moduleUri = 'http://example.com/module';
      const recordsWriteGrant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : moduleUri
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
        module       : moduleUri,
      });
      expect(fetchedGrant.message.recordId).toBe(recordsWriteGrant.message.recordId);

      expect(fetchGrantSpy.mock.calls).toHaveLength(1);

      // get the grant again
      const fetchedGrant2 = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.RecordsWrite,
        module       : moduleUri,
      });
      expect(fetchedGrant2.message.recordId).toBe(recordsWriteGrant.message.recordId);

      // expect the fetchGrant method to not have been called again
      expect(fetchGrantSpy.mock.calls).toHaveLength(1);
    });

    it('should cache the results of an explicit fresh fetch', async () => {
      // create a RecordsWrite grant from alice to bob
      const moduleUri = 'http://example.com/module';
      const recordsWriteGrant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : moduleUri
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

      // Explicitly refresh the grant catalog. The fresh result still populates the cache.
      const fetchedGrant = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.RecordsWrite,
        module       : moduleUri,
        forceRefresh : true
      });
      expect(fetchedGrant.message.recordId).toBe(recordsWriteGrant.message.recordId);

      expect(fetchGrantSpy.mock.calls).toHaveLength(1);

      // The default lookup reuses the refreshed catalog.
      const fetchedGrant2 = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.RecordsWrite,
        module       : moduleUri,
      });
      expect(fetchedGrant2.message.recordId).toBe(recordsWriteGrant.message.recordId);

      // expect the fetchGrant method to not have been called again
      expect(fetchGrantSpy.mock.calls).toHaveLength(1);

      // A second explicit refresh performs another store read.
      const fetchedGrant3 = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.RecordsWrite,
        module       : moduleUri,
        forceRefresh : true
      });
      expect(fetchedGrant3.message.recordId).toBe(recordsWriteGrant.message.recordId);

      expect(fetchGrantSpy.mock.calls).toHaveLength(2);
    });

    it('matches distinct modulePath scopes from one cached grant catalog', async () => {
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
        interface  : DwnInterfaceName.Messages,
        method     : DwnMethodName.Read,
        module     : 'http://example.com/a',
        modulePath : 'b~c'
      });
      const secondGrant = await storeGrantForDelegate({
        interface  : DwnInterfaceName.Messages,
        method     : DwnMethodName.Read,
        module     : 'http://example.com/a~b',
        modulePath : 'c'
      });

      const fetchGrantSpy = spyOn(testHarness.agent.permissions, 'fetchGrants');

      const firstFetched = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.MessagesRead,
        module       : 'http://example.com/a',
        modulePath   : 'b~c',
        forceRefresh : true
      });
      expect(firstFetched.message.recordId).toBe(firstGrant.message.recordId);
      expect(fetchGrantSpy.mock.calls).toHaveLength(1);

      const secondFetched = await testHarness.agent.permissions.getPermissionForRequest({
        connectedDid : aliceDid.uri,
        delegateDid  : bobDid.uri,
        messageType  : DwnInterface.MessagesRead,
        module       : 'http://example.com/a~b',
        modulePath   : 'c',
      });
      expect(secondFetched.message.recordId).toBe(secondGrant.message.recordId);
      expect(fetchGrantSpy.mock.calls).toHaveLength(1);
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

    it('should fall back to single-grant remote revocation reads when checking remote grants', async () => {
      const writeGrant = await testHarness.agent.permissions.createGrant({
        store       : false,
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'http://example.com/remote-revocation-test'
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
          module    : 'http://example.com/remote-revocation-test'
        }
      });

      const sendDwnRequestStub = spyOn(testHarness.agent, 'sendDwnRequest').mockImplementation(async (request) => {
        const filter = 'messageParams' in request
          ? request.messageParams.filter as Record<string, unknown>
          : {};

        if (request.messageType === DwnInterface.RecordsQuery && filter.modulePath === PermissionsModule.grantPath) {
          return {
            messageCid : '',
            reply      : { entries: [writeGrant.message, readGrant.message], status: { code: 200, detail: 'OK' } }
          };
        }

        const status = filter.parentId === writeGrant.message.recordId
          ? { code: 200, detail: 'OK' }
          : { code: 404, detail: 'Not Found' };
        return {
          messageCid : '',
          reply      : { status }
        };
      });

      const grants = await testHarness.agent.permissions.fetchGrants({
        author       : aliceDid.uri,
        target       : aliceDid.uri,
        module       : 'http://example.com/remote-revocation-test',
        remote       : true,
        checkRevoked : true,
      });

      expect(grants).toHaveLength(1);
      expect(grants[0].message.recordId).toBe(readGrant.message.recordId);

      const revocationFilters = sendDwnRequestStub.mock.calls
        .map(([request]) => ('messageParams' in request ? request.messageParams.filter as Record<string, unknown> : {}))
        .filter(filter => filter.modulePath === PermissionsModule.revocationPath);
      expect(revocationFilters).toHaveLength(2);
      expect(revocationFilters.some(filter => filter.parentId === writeGrant.message.recordId)).toBe(true);
      expect(revocationFilters.some(filter => filter.parentId === readGrant.message.recordId)).toBe(true);
      expect(revocationFilters.every(filter => filter.contextId === undefined)).toBe(true);
      expect(revocationFilters.every(filter => !Array.isArray(filter.parentId))).toBe(true);
    });

    it('filter by module', async () => {
      // create a grant for permission-1
      const module1Grant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'http://example.com/module-1'
        }
      });

      // create a grant for permission-2
      const module2Grant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'http://example.com/module-2'
        }
      });

      // fetch permission grants
      const module1Grants = await testHarness.agent.permissions.fetchGrants({
        author : aliceDid.uri,
        target : aliceDid.uri,
        module : 'http://example.com/module-1'
      });
      expect(module1Grants).toHaveLength(1);
      expect(module1Grants[0].grant.id).toBe(module1Grant.grant.id);

      const module2Grants = await testHarness.agent.permissions.fetchGrants({
        author : aliceDid.uri,
        target : aliceDid.uri,
        module : 'http://example.com/module-2'
      });
      expect(module2Grants).toHaveLength(1);
      expect(module2Grants[0].grant.id).toBe(module2Grant.grant.id);
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

    it('should filter out revoked grants when checkRevoked is true', async () => {
      // create two grants
      const grant1 = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'http://example.com/revocation-test'
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
          module    : 'http://example.com/revocation-test'
        }
      });

      // both grants should be returned before revocation
      let grants = await testHarness.agent.permissions.fetchGrants({
        author : aliceDid.uri,
        target : aliceDid.uri,
        module : 'http://example.com/revocation-test',
      });
      expect(grants).toHaveLength(2);

      // revoke grant1
      await testHarness.agent.permissions.createRevocation({
        author : aliceDid.uri,
        store  : true,
        grant  : grant1.grant,
      });

      // checkRevoked filters out revoked grants.
      grants = await testHarness.agent.permissions.fetchGrants({
        author       : aliceDid.uri,
        target       : aliceDid.uri,
        module       : 'http://example.com/revocation-test',
        checkRevoked : true,
      });
      expect(grants).toHaveLength(1);
      expect(grants[0].grant.id).toBe(grant2.grant.id);
    });

    it('should include revoked grants when checkRevoked is omitted or false', async () => {
      // create a grant and revoke it
      const grant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'http://example.com/revocation-test-2'
        }
      });

      // revoke the grant
      await testHarness.agent.permissions.createRevocation({
        author : aliceDid.uri,
        store  : true,
        grant  : grant.grant,
      });

      // without checkRevoked, the revoked grant should still be returned.
      let grants = await testHarness.agent.permissions.fetchGrants({
        author : aliceDid.uri,
        target : aliceDid.uri,
        module : 'http://example.com/revocation-test-2',
      });
      expect(grants).toHaveLength(1);
      expect(grants[0].grant.id).toBe(grant.grant.id);

      // with checkRevoked: false, the revoked grant should still be returned.
      grants = await testHarness.agent.permissions.fetchGrants({
        author       : aliceDid.uri,
        target       : aliceDid.uri,
        module       : 'http://example.com/revocation-test-2',
        checkRevoked : false,
      });
      expect(grants).toHaveLength(1);
      expect(grants[0].grant.id).toBe(grant.grant.id);
    });

    it('should check revocations through one message-path read per grant when checkRevoked is true', async () => {
      const writeGrant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : aliceDid.uri,
        grantedTo   : aliceDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'http://example.com/revocation-roundtrip-test'
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
          module    : 'http://example.com/revocation-roundtrip-test'
        }
      });
      await testHarness.agent.permissions.createRevocation({
        store  : true,
        author : aliceDid.uri,
        grant  : writeGrant.grant,
      });
      await testHarness.agent.permissions.clear();

      const processDwnRequestSpy = spyOn(testHarness.agent, 'processDwnRequest');

      const grants = await testHarness.agent.permissions.fetchGrants({
        author       : aliceDid.uri,
        target       : aliceDid.uri,
        module       : 'http://example.com/revocation-roundtrip-test',
        checkRevoked : true,
      });

      expect(grants).toHaveLength(1);
      expect(grants[0].message.recordId).toBe(readGrant.message.recordId);

      const revocationFilters = processDwnRequestSpy.mock.calls
        .filter(([request]) => request.messageType === DwnInterface.RecordsRead)
        .map(([request]) => request.messageParams.filter as Record<string, unknown>);
      expect(revocationFilters).toHaveLength(2);

      expect(revocationFilters.map(filter => filter.parentId).sort()).toEqual([
        readGrant.message.recordId,
        writeGrant.message.recordId,
      ].sort());
      expect(revocationFilters.every(filter => filter.module === PermissionsModule.uri)).toBe(true);
      expect(revocationFilters.every(filter => filter.modulePath === PermissionsModule.revocationPath)).toBe(true);
      expect(revocationFilters.every(filter => !Array.isArray(filter.parentId))).toBe(true);

      const grantsAgain = await testHarness.agent.permissions.fetchGrants({
        author       : aliceDid.uri,
        target       : aliceDid.uri,
        module       : 'http://example.com/revocation-roundtrip-test',
        checkRevoked : true,
      });
      expect(grantsAgain).toHaveLength(1);
      expect(grantsAgain[0].message.recordId).toBe(readGrant.message.recordId);

      const repeatedRevocationFilters = processDwnRequestSpy.mock.calls
        .filter(([request]) => request.messageType === DwnInterface.RecordsRead)
        .map(([request]) => request.messageParams.filter as Record<string, unknown>);
      expect(repeatedRevocationFilters).toHaveLength(3);
      expect(repeatedRevocationFilters[2].parentId).toBe(readGrant.message.recordId);
    });

    it('should use the message path for cross-tenant local revocation checks', async () => {
      const writeGrant = await testHarness.agent.permissions.createGrant({
        store       : false,
        author      : aliceDid.uri,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'http://example.com/cross-tenant-revocation-test'
        }
      });
      const processDwnRequestStub = spyOn(testHarness.agent, 'processDwnRequest').mockImplementation(async (request) => {
        const filter = 'messageParams' in request
          ? request.messageParams.filter as Record<string, unknown>
          : {};

        if (request.messageType === DwnInterface.RecordsQuery && filter.modulePath === PermissionsModule.grantPath) {
          return {
            messageCid : '',
            reply      : { entries: [writeGrant.message], status: { code: 200, detail: 'OK' } }
          };
        }

        return {
          messageCid : '',
          reply      : { status: { code: 404, detail: 'Not Found' } }
        };
      });

      const grants = await testHarness.agent.permissions.fetchGrants({
        author       : bobDid.uri,
        target       : aliceDid.uri,
        module       : 'http://example.com/cross-tenant-revocation-test',
        checkRevoked : true,
      });

      expect(grants).toHaveLength(1);

      const revocationFilters = processDwnRequestStub.mock.calls
        .filter(([request]) => request.messageType === DwnInterface.RecordsRead)
        .map(([request]) => request.messageParams.filter as Record<string, unknown>);
      expect(revocationFilters).toEqual([{
        parentId   : writeGrant.message.recordId,
        module     : PermissionsModule.uri,
        modulePath : PermissionsModule.revocationPath,
      }]);
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

    it('filter by module', async () => {
      // create a request for permission-1
      const module1Request = await testHarness.agent.permissions.createRequest({
        author : aliceDid.uri,
        store  : true,
        scope  : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'http://example.com/module-1'
        }
      });

      // create a request for permission-2
      const module2Request = await testHarness.agent.permissions.createRequest({
        author : aliceDid.uri,
        store  : true,
        scope  : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : 'http://example.com/module-2'
        }
      });

      // fetch permission grants
      const module1Requests = await testHarness.agent.permissions.fetchRequests({
        author : aliceDid.uri,
        target : aliceDid.uri,
        module : 'http://example.com/module-1'
      });
      expect(module1Requests).toHaveLength(1);
      expect(module1Requests[0].request.id).toBe(module1Request.request.id);

      const module2Requests = await testHarness.agent.permissions.fetchRequests({
        author : aliceDid.uri,
        target : aliceDid.uri,
        module : 'http://example.com/module-2'
      });
      expect(module2Requests).toHaveLength(1);
      expect(module2Requests[0].request.id).toBe(module2Request.request.id);
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
          module    : 'http://example.com/module'
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
          module    : 'http://example.com/module'
        }
      });

      const grants = await testHarness.agent.permissions.fetchGrants({
        author : aliceDid.uri,
        target : aliceDid.uri,
      });

      // expect to have the 1 grant created for deviceX
      expect(grants).toHaveLength(1);
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
          module    : 'http://example.com/module'
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
          module    : 'http://example.com/module'
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
          module    : 'http://example.com/module'
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
            module    : 'http://example.com/module'
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
          module    : 'http://example.com/module'
        }
      });

      // query for the request
      const fetchedRequests = await testHarness.agent.permissions.fetchRequests({
        author : aliceDid.uri,
        target : aliceDid.uri,
      });

      // expect to have the 1 request created
      expect(fetchedRequests).toHaveLength(1);
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
          module    : 'http://example.com/module'
        }
      });

      // query for the request
      const fetchedRequests = await testHarness.agent.permissions.fetchRequests({
        author : aliceDid.uri,
        target : aliceDid.uri,
      });

      // expect to have no requests
      expect(fetchedRequests).toHaveLength(0);
    });
  });

  describe('matchGrantFromArray', () => {

    const createRecordGrants = async ({ grantee, grantor, grantorAgent, module, modulePath, contextId }:{
      grantorAgent: EnboxPlatformAgent;
      granteeAgent: EnboxPlatformAgent;
      grantor: string;
      grantee: string;
      module: string;
      modulePath?: string;
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
          module,
          modulePath,
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
          module,
          modulePath,
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
          module,
          modulePath,
          contextId
        }
      });

      return {
        write  : recordsWriteGrant,
        read   : recordsReadGrant,
        delete : recordsDeleteGrant
      };
    };

    const createMessageGrants = async ({ grantee, grantor, grantorAgent, module }:{
      grantorAgent: EnboxPlatformAgent;
      granteeAgent: EnboxPlatformAgent;
      grantor: string;
      grantee: string;
      module?: string;
    }): Promise<Record<string, PermissionGrantEntry>> => {

      const messagesReadGrant = await grantorAgent.permissions.createGrant({
        author      : grantor,
        grantedTo   : grantee,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
          module
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
          module
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
          module
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

      const module = 'http://example.com/module';


      const deviceXRecordGrantsFromAlice = await createRecordGrants({
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        module
      });

      const deviceXRecordGrantsFromAliceArray = [
        deviceXRecordGrantsFromAlice.write,
        deviceXRecordGrantsFromAlice.read,
        deviceXRecordGrantsFromAlice.delete
      ];

      // attempt to match a grant with a different grantee, aliceDeviceY
      const notFoundGrantee = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceY.did.uri, {
        messageType: DwnInterface.RecordsWrite,
        module
      }, deviceXRecordGrantsFromAliceArray);

      expect(notFoundGrantee).toBeUndefined();

      const deviceYRecordGrantsFromDeviceX = await createRecordGrants({
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
        grantor      : aliceDeviceX.did.uri,
        grantee      : aliceDeviceY.did.uri,
        module
      });

      const deviceYRecordGrantsFromDeviceXArray = [
        deviceYRecordGrantsFromDeviceX.write,
        deviceYRecordGrantsFromDeviceX.read,
        deviceYRecordGrantsFromDeviceX.delete
      ];

      const notFoundGrantor = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceY.did.uri, {
        messageType: DwnInterface.RecordsWrite,
        module
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

      const latestExpiringGrant = aliceDeviceXMessageGrants.reduce((latest, candidate) =>
        candidate.grant.dateExpires > latest.grant.dateExpires ? candidate : latest
      );
      expect(queryGrant?.message.recordId).toBe(latestExpiringGrant.message.recordId);

      // attempt to match non-delegated grant with delegated set to true
      const notFoundDelegated = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesQuery,
      }, aliceDeviceXMessageGrants, true);

      expect(notFoundDelegated).toBeUndefined();

      // create delegated record grants
      const module = 'http://example.com/module';
      const recordsGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        module
      });

      const deviceXRecordGrants = [
        recordsGrants.write,
        recordsGrants.read,
        recordsGrants.delete
      ];

      // match a delegated grant
      const writeGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.RecordsWrite,
        module
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

    it('Messages with module', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const module = 'http://example.com/module';
      const otherModule = 'http://example.com/other-module';

      // Messages.Read is the only valid Messages scope — one grant per module
      // covers Query, Read, and Subscribe operations.
      const moduleGrant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, module },
      });

      const otherModuleGrant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, module: otherModule },
      });

      const deviceXMessageGrants = [ moduleGrant, otherModuleGrant ];

      // All Messages feed operations match the same Read grant for the given module.
      for (const messageType of [
        DwnInterface.MessagesQuery,
        DwnInterface.MessagesRead,
        DwnInterface.MessagesSubscribe,
      ]) {
        const matched = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
          messageType,
          module,
        }, deviceXMessageGrants);
        expect(matched?.message.recordId).toBe(moduleGrant.message.recordId);
      }

      // Unknown module returns no match.
      const invalidGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesQuery,
        module      : 'http://example.com/unknown-module'
      }, deviceXMessageGrants);

      expect(invalidGrant).toBeUndefined();

      // Other module matches the other grant.
      const otherMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesQuery,
        module      : otherModule
      }, deviceXMessageGrants);

      expect(otherMatch?.message.recordId).toBe(otherModuleGrant.message.recordId);
    });

    it('Messages.Read unified scope covers Query, Read, and Subscribe with module', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const module = 'http://example.com/module';

      // Only a Messages.Read grant scoped to the module
      const readGrant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
          module
        }
      });

      const readOnlyGrants = [ readGrant ];

      // Matches MessagesQuery for the same module
      const matchedQuery = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesQuery,
        module
      }, readOnlyGrants);
      expect(matchedQuery?.message.recordId).toBe(readGrant.message.recordId);

      // Matches MessagesSubscribe for the same module
      const matchedSubscribe = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesSubscribe,
        module
      }, readOnlyGrants);
      expect(matchedSubscribe?.message.recordId).toBe(readGrant.message.recordId);

      // Does NOT match a different module
      const noMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesQuery,
        module      : 'http://example.com/other-module'
      }, readOnlyGrants);
      expect(noMatch).toBeUndefined();
    });

    it('Messages with modulePath and contextId', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const module = 'http://example.com/messages-scope-module';

      const pathGrant = await testHarness.agent.permissions.createGrant({
        author      : aliceDid.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        store       : true,
        scope       : {
          interface  : DwnInterfaceName.Messages,
          method     : DwnMethodName.Read,
          module,
          modulePath : 'post'
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
          module,
          contextId : 'root'
        }
      });

      const grants = [pathGrant, contextGrant];

      const pathMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesRead,
        module,
        modulePath  : 'post'
      }, grants);
      expect(pathMatch?.message.recordId).toBe(pathGrant.message.recordId);

      const queryPathMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesQuery,
        module,
        modulePath  : 'post'
      }, grants);
      expect(queryPathMatch?.message.recordId).toBe(pathGrant.message.recordId);

      const childPathMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesRead,
        module,
        modulePath  : 'post/comment'
      }, grants);
      expect(childPathMatch?.message.recordId).toBe(pathGrant.message.recordId);

      const wrongModulePathMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesRead,
        module      : 'http://example.com/messages-scope-other-module',
        modulePath  : 'post'
      }, grants);
      expect(wrongModulePathMatch).toBeUndefined();

      const contextChildMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesRead,
        module,
        contextId   : 'root/child'
      }, grants);
      expect(contextChildMatch?.message.recordId).toBe(contextGrant.message.recordId);

      const contextSiblingMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.MessagesRead,
        module,
        contextId   : 'root2'
      }, grants);
      expect(contextSiblingMatch).toBeUndefined();

      const moduleOnlyMatch = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType: DwnInterface.MessagesQuery,
        module
      }, grants);
      expect(moduleOnlyMatch).toBeUndefined();
    });

    it('Records', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const module1 = 'http://example.com/module';
      const module2 = 'http://example.com/other-module';

      const module1Grants = await createRecordGrants({
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        module       : module1,
      });

      const otherModuleGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        module       : module2,
      });

      const deviceXRecordGrants = [
        module1Grants.write,
        module1Grants.read,
        module1Grants.delete,
        otherModuleGrants.write,
        otherModuleGrants.read,
        otherModuleGrants.delete
      ];

      const writeGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        module      : module1
      }, deviceXRecordGrants);

      expect(writeGrant?.message.recordId).toBe(module1Grants.write.message.recordId);

      const readGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsRead,
        module      : module1
      }, deviceXRecordGrants);

      expect(readGrant?.message.recordId).toBe(module1Grants.read.message.recordId);

      const deleteGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsDelete,
        module      : module1
      }, deviceXRecordGrants);

      expect(deleteGrant?.message.recordId).toBe(module1Grants.delete.message.recordId);

      const queryGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsQuery,
        module      : module1
      }, deviceXRecordGrants);

      expect(queryGrant?.message.recordId).toBe(module1Grants.read.message.recordId);

      const subscribeGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsSubscribe,
        module      : module1
      }, deviceXRecordGrants);

      expect(subscribeGrant?.message.recordId).toBe(module1Grants.read.message.recordId);

      const countGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsCount,
        module      : module1
      }, deviceXRecordGrants);

      expect(countGrant?.message.recordId).toBe(module1Grants.read.message.recordId);

      const queryGrantOtherModule = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsQuery,
        module      : module2
      }, deviceXRecordGrants);

      expect(queryGrantOtherModule?.message.recordId).toBe(otherModuleGrants.read.message.recordId);

      // unknown module
      const invalidGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsQuery,
        module      : 'http://example.com/unknown-module'
      }, deviceXRecordGrants);

      expect(invalidGrant).toBeUndefined();
    });

    it('Records with modulePath', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const module = 'http://example.com/module';

      const fooGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        module,
        modulePath   : 'foo'
      });

      const barGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        module,
        modulePath   : 'foo/bar'
      });

      const moduleGrants = [
        fooGrants.write,
        fooGrants.read,
        fooGrants.delete,
        barGrants.write,
        barGrants.read,
        barGrants.delete
      ];

      const writeFooGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        module      : module,
        modulePath  : 'foo'
      }, moduleGrants);

      expect(writeFooGrant?.message.recordId).toBe(fooGrants.write.message.recordId);

      const readFooGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsRead,
        module      : module,
        modulePath  : 'foo'
      }, moduleGrants);

      expect(readFooGrant?.message.recordId).toBe(fooGrants.read.message.recordId);

      const deleteFooGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsDelete,
        module      : module,
        modulePath  : 'foo'
      }, moduleGrants);

      expect(deleteFooGrant?.message.recordId).toBe(fooGrants.delete.message.recordId);

      const queryGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsQuery,
        module      : module,
        modulePath  : 'foo'
      }, moduleGrants);

      expect(queryGrant?.message.recordId).toBe(fooGrants.read.message.recordId);

      const subscribeGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsSubscribe,
        module      : module,
        modulePath  : 'foo'
      }, moduleGrants);

      expect(subscribeGrant?.message.recordId).toBe(fooGrants.read.message.recordId);

      const writeBarGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        module      : module,
        modulePath  : 'foo/bar'
      }, moduleGrants);

      expect(writeBarGrant?.message.recordId).toBe(barGrants.write.message.recordId);

      const noMatchGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        module      : module,
        modulePath  : 'bar'
      }, moduleGrants);

      expect(noMatchGrant).toBeUndefined();
    });

    it('Records with contextId', async () => {
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      const module = 'http://example.com/module';

      const abcGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        module,
        contextId    : 'abc'
      });

      const defGrants = await createRecordGrants({
        grantorAgent : testHarness.agent as EnboxPlatformAgent,
        granteeAgent : testHarness.agent as EnboxPlatformAgent,
        grantor      : aliceDid.uri,
        grantee      : aliceDeviceX.did.uri,
        module,
        contextId    : 'def/ghi'
      });

      const contextGrants = [
        abcGrants.write,
        abcGrants.read,
        abcGrants.delete,
        defGrants.write,
        defGrants.read,
        defGrants.delete
      ];

      const writeFooGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        module      : module,
        contextId   : 'abc'
      }, contextGrants);

      expect(writeFooGrant?.message.recordId).toBe(abcGrants.write.message.recordId);

      const writeBarGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        module      : module,
        contextId   : 'def/ghi'
      }, contextGrants);

      expect(writeBarGrant?.message.recordId).toBe(defGrants.write.message.recordId);

      const invalidGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        module      : module,
        contextId   : 'def'
      }, contextGrants);

      expect(invalidGrant).toBeUndefined();

      const childContextGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        module      : module,
        contextId   : 'abc/child'
      }, contextGrants);

      expect(childContextGrant?.message.recordId).toBe(abcGrants.write.message.recordId);

      const withoutContextGrant = await AgentPermissionsApi.matchGrantFromArray(aliceDid.uri, aliceDeviceX.did.uri, {
        messageType : DwnInterface.RecordsWrite,
        module      : module
      }, contextGrants);

      expect(withoutContextGrant).toBeUndefined();
    });
  });
});
