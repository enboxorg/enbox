import type { RecordsPermissionScope } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { EncryptionProtocol } from '@enbox/dwn-sdk-js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import { type BearerDid, DidDht, DidJwk } from '@enbox/dids';
import { Convert, logger } from '@enbox/common';

import { AgentPermissionsApi, DwnInterface, DwnPermissionGrant } from '../src/index.js';
import {
  CONNECT_SESSION_MAX_TTL_SECONDS,
  type ConnectApprovalRequest,
  ConnectCeremony,
  createConnectSessionMetadata,
  createPermissionGrants,
  executeConnectApproval,
} from '../src/connect-approval.js';

import type { BearerIdentity, DwnProtocolDefinition } from '../src/index.js';

describe('connect approval ceremony', () => {

  /** The real tenant (identity) of the DWN that the provider had chosen to connect */
  let providerIdentity: BearerIdentity;

  /** The delegate DID minted for wallet-minted sessions in these tests */
  let delegateBearerDid: BearerDid;

  /** The real tenant (identity) of the DWN that the provider is using and selecting */
  let providerIdentityBearerDid: BearerDid;
  const providerIdentityPortableDid = {
    uri      : 'did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo',
    document : {
      '@context'         : 'https://www.w3.org/ns/did/v1',
      id                 : 'did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo',
      verificationMethod : [
        {
          id   : 'did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo#0',
          type : 'JsonWebKey',
          controller:
            'did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo',
          publicKeyJwk: {
            crv : 'Ed25519',
            kty : 'OKP' as const,
            x   : 'VYKm2SCIV9Vz3BRy-v5R9GHz3EOJCPvZ1_gP1e3XiB0',
            kid : 'cyvOypa6k-4ffsRWcza37s5XVOh1kO9ICUeo1ZxHVM8',
            alg : 'EdDSA',
          },
        },
      ],
      authentication: [
        'did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo#0',
      ],
      assertionMethod: [
        'did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo#0',
      ],
      capabilityDelegation: [
        'did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo#0',
      ],
      capabilityInvocation: [
        'did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo#0',
      ],
    },
    metadata    : {},
    privateKeys : [
      {
        crv : 'Ed25519',
        d   : 'hdSIwbQwVD-fNOVEgt-k3mMl44Ip1iPi58Ex6VDGxqY',
        kty : 'OKP' as const,
        x   : 'VYKm2SCIV9Vz3BRy-v5R9GHz3EOJCPvZ1_gP1e3XiB0',
        kid : 'cyvOypa6k-4ffsRWcza37s5XVOh1kO9ICUeo1ZxHVM8',
        alg : 'EdDSA',
      },
    ],
  };

  const permissionGrants: any[] = [
    {
      reply   : { status: { code: 202, detail: 'Accepted' } },
      message : {
        recordId   : 'bafyreifzveddv32ea3tzybpgphxvdvmk2qtgdi7ykt5atgo76m426jqp3m',
        descriptor : {
          interface    : 'Records',
          method       : 'Write',
          protocol     : 'https://identity.foundation/dwn/permissions',
          protocolPath : 'grant',
          recipient:
            'did:dht:pfm8f6w57srtci1k3spp73dqgk5eo3afkimtyi4zcqc5hg1ui5mo',
          dataCid:
            'bafkreibesnbudco6hhuj5m4lc3jktvd2pd4ew4uypsiq66xxuaec4jwt7e',
          dataSize         : 156,
          dateCreated      : '2024-08-02T06:36:37.675594Z',
          messageTimestamp : '2024-08-02T06:36:37.675594Z',
          dataFormat       : 'application/json',
        },
        contextId:
          'bafyreifzveddv32ea3tzybpgphxvdvmk2qtgdi7ykt5atgo76m426jqp3m',
        authorization: {
          signature: {
            payload:
              'eyJyZWNvcmRJZCI6ImJhZnlyZWlmenZlZGR2MzJlYTN0enlicGdwaHh2ZHZtazJxdGdkaTd5a3Q1YXRnbzc2bTQyNmpxcDNtIiwiZGVzY3JpcHRvckNpZCI6ImJhZnlyZWlid3Y1ajVhbHlmbmV0Mmh6NTNoYWRsZnF6eG1vNzVsZHYyeml5cGp4enlmN2ZuZWMyYnV1IiwiY29udGV4dElkIjoiYmFmeXJlaWZ6dmVkZHYzMmVhM3R6eWJwZ3BoeHZkdm1rMnF0Z2RpN3lrdDVhdGdvNzZtNDI2anFwM20ifQ',
            signatures: [
              {
                protected:
                  'eyJraWQiOiJkaWQ6ZGh0OjFxbmdkZ2RlMzE2NHB1MTU3eDRyZWlqcWlzYm1yN2R4OG5raWNpOXltdG56ZWsxaWJpMXkjMCIsImFsZyI6IkVkRFNBIn0',
                signature:
                  '7xiNZGsb8dlom2tCSdjUQgkBsAm6XSRt6i4cNS6NDDSkCGjVr79TB7tF5VQdtwMJCrDpKtSmXQ0eEN4j2dWMAQ',
              },
            ],
          },
        },
      },
      messageCid: 'bafyreievjytxn2qbfwg4fthnsrjnob3mm2j2haar6revl723v7q2up5g5i',
    },
  ];

  const protocolDefinition: DwnProtocolDefinition = {
    protocol  : 'http://profile-protocol.xyz',
    published : true,
    types     : {
      profile: {
        schema      : 'http://profile-protocol.xyz/schema/profile',
        dataFormats : ['application/json'],
      },
    },
    structure: {
      profile: {
        $actions: [
          {
            who : 'anyone',
            can : ['create', 'update'],
          },
        ],
      },
    },
  };

  const permissionScopes: RecordsPermissionScope[] = [
    {
      interface : 'Records' as any,
      method    : 'Write' as any,
      protocol  : 'http://profile-protocol.xyz',
    },
    {
      interface : 'Records' as any,
      method    : 'Delete' as any,
      protocol  : 'http://profile-protocol.xyz',
    },
    {
      interface : 'Records' as any,
      method    : 'Read' as any,
      protocol  : 'http://profile-protocol.xyz',
    },
  ];

  let testHarness: PlatformAgentTestHarness;

  /** Builds the ceremony request the way a kernel `ConnectRequest` supplies it. */
  function approvalRequest(overrides: Partial<ConnectApprovalRequest> = {}): ConnectApprovalRequest {
    return {
      appName            : 'Sample App',
      permissionRequests : [{ protocolDefinition, permissionScopes }],
      ...overrides,
    };
  }

  beforeAll(async () => {
    providerIdentityBearerDid = await DidDht.import({
      portableDid: providerIdentityPortableDid,
    });
    sinon.stub(DidDht, 'create').resolves(providerIdentityBearerDid);
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'memory',
    });
    await testHarness.createAgentDid();
    sinon.restore();

    providerIdentity = await testHarness.createIdentity({
      name        : 'MrProvider',
      testDwnUrls : [testDwnUrl],
    });

    delegateBearerDid = await DidJwk.create();
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('createPermissionGrants', () => {
    it('should create permission grants for each requested scope with shared session metadata', async () => {
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves(['https://dwn.example']);
      sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').resolves({
        status: { code: 202, detail: 'Accepted' },
      } as any);

      const results = await createPermissionGrants(
        providerIdentity.did.uri,
        delegateBearerDid.uri,
        testHarness.agent,
        permissionScopes
      );
      const scopesRequested = permissionScopes.length;
      expect(results).toHaveLength(scopesRequested);
      expect(typeof results[0]).toBe('object');

      const grants = results.map((result) => DwnPermissionGrant.parse(result));
      const firstSession = grants[0].connectSession;
      expect(firstSession).toBeDefined();
      expect(firstSession?.id).toBeDefined();
      expect(firstSession?.expiresAt).not.toBe('2040-06-25T16:09:16.693356Z');
      expect(Date.parse(firstSession!.expiresAt) - Date.parse(firstSession!.createdAt)).toBe(86_400_000);

      for (const grant of grants) {
        expect(grant.connectSession?.id).toBe(firstSession?.id);
        expect(grant.dateExpires).toBe(firstSession!.expiresAt);
      }
    });

    it('should serialize permission grant writes per endpoint while sending to independent endpoints concurrently', async () => {
      const endpointUrls = ['https://dwn-a.example', 'https://dwn-b.example'];
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves(endpointUrls);

      const callsByEndpoint = new Map<string, number>();
      const releaseFirstCall = new Map<string, () => void>();
      const sendStub = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').callsFake(async ({ dwnUrl, signal }) => {
        const callCount = (callsByEndpoint.get(dwnUrl) ?? 0) + 1;
        callsByEndpoint.set(dwnUrl, callCount);

        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);
        if (callCount === 1) {
          await new Promise<void>((resolve) => releaseFirstCall.set(dwnUrl, resolve));
        }
        return { status: { code: 202, detail: 'Accepted' } } as any;
      });

      const result = createPermissionGrants(
        providerIdentity.did.uri,
        delegateBearerDid.uri,
        testHarness.agent,
        permissionScopes,
      );
      while (releaseFirstCall.size < endpointUrls.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      expect(sendStub.callCount).toBe(endpointUrls.length);
      releaseFirstCall.get(endpointUrls[0])!();
      while ((callsByEndpoint.get(endpointUrls[0]) ?? 0) < 2) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      expect(callsByEndpoint.get(endpointUrls[1])).toBe(1);

      releaseFirstCall.get(endpointUrls[1])!();
      await result;

      expect(sendStub.callCount).toBe(endpointUrls.length * permissionScopes.length);
    });

    it('should continue after a request timeout and report the failed grant', async () => {
      const batchController = new AbortController();
      const requestController = new AbortController();
      const timeoutStub = sinon.stub(AbortSignal, 'timeout');
      timeoutStub.onFirstCall().returns(batchController.signal);
      timeoutStub.onSecondCall().returns(requestController.signal);
      timeoutStub.callsFake(() => new AbortController().signal);
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves(['https://dwn.example']);
      let rpcCallCount = 0;
      const sendStub = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').callsFake(async ({ signal }) => {
        rpcCallCount++;
        if (rpcCallCount === 1) {
          return new Promise((_, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return { status: { code: 202, detail: 'Accepted' } } as any;
      });

      const result = createPermissionGrants(
        providerIdentity.did.uri,
        delegateBearerDid.uri,
        testHarness.agent,
        permissionScopes,
      );
      while (!sendStub.called) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      requestController.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

      await expect(result).rejects.toThrow(
        'Could not send permission grant to any DWN endpoint: grant 1 ' +
        '(Records.Write, protocol http://profile-protocol.xyz); ' +
        'https://dwn.example failed: permission grant request timed out after 10000ms',
      );
      expect(sendStub.callCount).toBe(permissionScopes.length);
      expect(timeoutStub.firstCall.args[0]).toBe(20_000);
      expect(timeoutStub.secondCall.args[0]).toBe(10_000);
    });

    it('should succeed when endpoints have complementary grant failures', async () => {
      const endpointA = 'https://dwn-a.example';
      const endpointB = 'https://dwn-b.example';
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves([endpointA, endpointB]);
      const callsByEndpoint = new Map<string, number>();
      const sendStub = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').callsFake(async ({ dwnUrl }) => {
        const callCount = (callsByEndpoint.get(dwnUrl) ?? 0) + 1;
        callsByEndpoint.set(dwnUrl, callCount);
        if ((dwnUrl === endpointA && callCount === 1) || (dwnUrl === endpointB && callCount === 2)) {
          throw new TypeError('fetch failed');
        }
        return { status: { code: 202, detail: 'Accepted' } } as any;
      });

      const grants = await createPermissionGrants(
        providerIdentity.did.uri,
        delegateBearerDid.uri,
        testHarness.agent,
        permissionScopes,
      );

      expect(grants).toHaveLength(permissionScopes.length);
      expect(sendStub.callCount).toBe(2 * permissionScopes.length);
      expect(callsByEndpoint.get(endpointA)).toBe(permissionScopes.length);
      expect(callsByEndpoint.get(endpointB)).toBe(permissionScopes.length);
    });

    it('should apply one bounded deadline to the complete permission grant batch', async () => {
      const batchController = new AbortController();
      const timeoutStub = sinon.stub(AbortSignal, 'timeout');
      timeoutStub.onFirstCall().returns(batchController.signal);
      timeoutStub.callsFake(() => new AbortController().signal);
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves(['https://dwn.example']);
      const sendStub = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').callsFake(async ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
      );

      const result = createPermissionGrants(
        providerIdentity.did.uri,
        delegateBearerDid.uri,
        testHarness.agent,
        permissionScopes,
      );
      while (!sendStub.called) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      batchController.abort(new DOMException('Permission grant batch timed out', 'TimeoutError'));

      await expect(result).rejects.toThrow('permission grant batch timed out after 20000ms');
      expect(timeoutStub.firstCall.args[0]).toBe(20_000);
      expect(sendStub.callCount).toBe(1);
    });

    it('should report when no DWN endpoint is resolved for permission grant delivery', async () => {
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves([]);
      const sendStub = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest');

      await expect(createPermissionGrants(
        providerIdentity.did.uri,
        delegateBearerDid.uri,
        testHarness.agent,
        permissionScopes,
      )).rejects.toThrow(
        'Could not send permission grant to any DWN endpoint: grant 1 ' +
        '(Records.Write, protocol http://profile-protocol.xyz); no DWN endpoints were resolved',
      );
      expect(sendStub.callCount).toBe(0);
    });

    it('should reject obsolete read-like record grant scopes', async () => {
      for (const method of ['Query', 'Subscribe', 'Count']) {
        await expect(createPermissionGrants(
          providerIdentity.did.uri,
          delegateBearerDid.uri,
          testHarness.agent,
          [{
            interface : 'Records' as any,
            method    : method as any,
            protocol  : 'http://profile-protocol.xyz',
          }]
        )).rejects.toThrow(`Records.${method} grants are not supported by connect`);
      }
    });

    it('should reject delegated protocol configure scopes', async () => {
      await expect(createPermissionGrants(
        providerIdentity.did.uri,
        delegateBearerDid.uri,
        testHarness.agent,
        [{
          interface : 'Protocols' as any,
          method    : 'Configure' as any,
          protocol  : 'http://profile-protocol.xyz',
        }]
      )).rejects.toThrow('Protocols.Configure cannot be delegated through connect');
    });
  });

  describe('createConnectSessionMetadata', () => {
    it('should bound connect session display metadata', () => {
      const session = createConnectSessionMetadata({
        id             : 's'.repeat(200),
        appName        : 'a'.repeat(200),
        appIcon        : `https://example.com/${'i'.repeat(3000)}`,
        transport      : 'postMessage',
        clientMetadata : {
          origin    : `https://${'o'.repeat(600)}.example`,
          userAgent : 'u'.repeat(600),
          platform  : 'p'.repeat(200),
          language  : 'l'.repeat(100),
          languages : Array.from({ length: 20 }, (_, index) => `language-${index}-${'x'.repeat(80)}`),
          timezone  : 't'.repeat(200),
        },
      });

      expect(session.id).toHaveLength(128);
      expect(session.appName).toHaveLength(128);
      expect(session.appIcon).toHaveLength(2048);
      expect(session.origin).toHaveLength(512);
      expect(session.userAgent).toHaveLength(512);
      expect(session.platform).toHaveLength(128);
      expect(session.language).toHaveLength(64);
      expect(session.languages).toHaveLength(16);
      expect(session.languages?.every((language) => language.length <= 64)).toBe(true);
      expect(session.timezone).toHaveLength(128);
      expect(session.transport).toBe('postMessage');
    });
  });

  describe('executeConnectApproval', () => {
    type ApprovalStubs = {
      capturedSessions: Array<{ createdAt: string; expiresAt: string }>;
      capturedDelegateDids: string[];
      revocationGrantStub: sinon.SinonStub;
    };

    /** The signed local ProtocolsQuery message reused for remote verification. */
    const signedProtocolQuery = { descriptor: { interface: 'Protocols', method: 'Query' } };

    function protocolQueryReply(definition?: DwnProtocolDefinition): {
      status: { code: number; detail: string };
      entries: Array<{ descriptor: { interface: string; method: string; definition: DwnProtocolDefinition } }>;
    } {
      return {
        status  : { code: 200, detail: 'OK' },
        entries : definition === undefined ? [] : [{ descriptor: { interface: 'Protocols', method: 'Configure', definition } }],
      };
    }

    /**
     * Routes `agent.rpc.sendDwnRequest` the way a real endpoint would during
     * protocol preparation: the signed protocol query returns `before` on the
     * first query per endpoint and `after` on subsequent (postcondition)
     * queries; every other message (configure sends, grants) returns the
     * given status.
     */
    function stubRemoteProtocolRpc(options: {
      before?: DwnProtocolDefinition;
      after?: DwnProtocolDefinition;
      sendStatus?: { code: number; detail: string };
    } = {}): sinon.SinonStub {
      const queriesSeen = new Map<string, number>();
      return sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').callsFake(async (request: any) => {
        if (request.message === signedProtocolQuery) {
          const seen = queriesSeen.get(request.dwnUrl) ?? 0;
          queriesSeen.set(request.dwnUrl, seen + 1);
          return protocolQueryReply(seen === 0 ? options.before : options.after) as any;
        }
        return { status: options.sendStatus ?? { code: 202, detail: 'Accepted' } } as any;
      });
    }

    function stubApprovalDependencies(): ApprovalStubs {
      const capturedSessions: Array<{ createdAt: string; expiresAt: string }> = [];
      const capturedDelegateDids: string[] = [];
      sinon.stub(ConnectCeremony, 'createPermissionGrants').callsFake(async (
        _selectedDid,
        delegateDid,
        _agent,
        _scopes,
        connectSession,
      ): Promise<any> => {
        capturedDelegateDids.push(delegateDid);
        if (connectSession !== undefined) {
          capturedSessions.push(connectSession);
        }
        return permissionGrants.map((grant: any) => grant.message) as any;
      });
      const revocationGrantStub = sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
        grant   : {} as any,
        message : { recordId: 'mock-revocation-grant-id', encodedData: btoa('{}') } as any,
      });
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);
      // Protocol preparation sees "not installed" and installs locally; with
      // zero endpoints resolved there is no remote verification or fan-out.
      sinon.stub(testHarness.agent, 'processDwnRequest').callsFake(async (request: any) =>
        request.messageType === DwnInterface.ProtocolsConfigure
          ? {
            messageCid : '',
            reply      : { status: { code: 202, detail: 'Accepted' } },
            message    : { descriptor: { interface: 'Protocols', method: 'Configure' } },
          } as any
          : {
            messageCid : '',
            reply      : { status: { code: 200, detail: 'OK' }, entries: [] },
            message    : signedProtocolQuery,
          } as any);
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves([]);

      return { capturedDelegateDids, capturedSessions, revocationGrantStub };
    }

    /**
     * Stubs the three grant-construction seams every ceremony test needs: the
     * permission-grant creator (returns the shared `permissionGrants` message
     * fixtures unless overridden), the revocation grant creator, and the
     * delegate DID minter. Returns the stubs callers assert against.
     */
    function stubApprovalCeremony(overrides: { permissionGrants?: unknown } = {}): {
      createGrantsStub: sinon.SinonStub;
      revocationGrantStub: sinon.SinonStub;
    } {
      const createGrantsStub = sinon.stub(ConnectCeremony, 'createPermissionGrants')
        .resolves((overrides.permissionGrants ?? permissionGrants) as any);
      const revocationGrantStub = sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
        grant   : {} as any,
        message : { recordId: 'mock-revocation-grant-id', encodedData: btoa('{}') } as any,
      });
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);
      return { createGrantsStub, revocationGrantStub };
    }

    it('should mint a delegate DID with an appended X25519 key and return the ConnectApproval shape', async () => {
      const { revocationGrantStub } = stubApprovalDependencies();

      const result = await executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest(),
      });

      // Wallet-minted session: the delegate is the response signer and its
      // portable form carries both the Ed25519 root and the derived X25519 key.
      expect(result.delegateDid).toBe(delegateBearerDid.uri);
      expect(result.responseSigner).toBe(delegateBearerDid);
      expect(result.delegatePortableDid).toBeDefined();
      expect(result.delegatePortableDid!.uri).toBe(delegateBearerDid.uri);
      expect(result.delegatePortableDid!.privateKeys?.map((key) => key.crv)).toEqual(['Ed25519', 'X25519']);

      // The delegate grants contain the session grants plus one revocation
      // grant per session grant, and the revocation mapping references both.
      const sessionGrantCount = permissionGrants.length;
      expect(result.delegateGrants).toHaveLength(sessionGrantCount * 2);
      expect(revocationGrantStub.callCount).toBe(sessionGrantCount);
      expect(result.sessionRevocations).toEqual([{
        grantId           : permissionGrants[0].message.recordId,
        revocationGrantId : 'mock-revocation-grant-id',
      }]);

      // The approval output never carries in-band decryption keys.
      expect('delegateDecryptionKeys' in result).toBe(false);
    });

    it('should create contextId-scoped revocation grants for each session grant', async () => {
      const { revocationGrantStub } = stubApprovalDependencies();

      await executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest(),
      });

      expect(revocationGrantStub.callCount).toBe(permissionGrants.length);
      const revocationParams = revocationGrantStub.firstCall.args[0];
      expect(revocationParams.delegated).toBe(true);
      expect(revocationParams.grantedTo).toBe(delegateBearerDid.uri);
      expect(revocationParams.scope.interface).toBe('Records');
      expect(revocationParams.scope.method).toBe('Write');
      expect(revocationParams.scope.protocol).toBe('https://identity.foundation/dwn/permissions');
      expect(revocationParams.scope.contextId).toBe(permissionGrants[0].message.recordId);
      expect(revocationParams.author).toBe(providerIdentity.did.uri);
    });

    it('should stamp requested session TTL onto permission and revocation grants', async () => {
      const requestedSessionTtlSeconds = 30 * 24 * 60 * 60;
      const { capturedSessions, revocationGrantStub } = stubApprovalDependencies();

      await executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest({ requestedSessionTtlSeconds }),
      });

      expect(capturedSessions).toHaveLength(1);
      const session = capturedSessions[0];
      expect(Date.parse(session.expiresAt) - Date.parse(session.createdAt)).toBe(requestedSessionTtlSeconds * 1000);
      expect(revocationGrantStub.firstCall.args[0].dateExpires).toBe(session.expiresAt);
    });

    it('should clamp requested session TTL to the wallet maximum', async () => {
      const { capturedSessions } = stubApprovalDependencies();

      await executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest({ requestedSessionTtlSeconds: CONNECT_SESSION_MAX_TTL_SECONDS + 60 }),
      });

      expect(capturedSessions).toHaveLength(1);
      const session = capturedSessions[0];
      expect(Date.parse(session.expiresAt) - Date.parse(session.createdAt)).toBe(CONNECT_SESSION_MAX_TTL_SECONDS * 1000);
    });

    it('should grant to a pre-supplied delegate DID without returning delegate private material', async () => {
      const preSuppliedDelegateDid = 'did:jwk:requester-delegate';
      const { capturedDelegateDids, revocationGrantStub } = stubApprovalDependencies();

      const result = await executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest({ delegateDid: preSuppliedDelegateDid }),
      });

      expect(capturedDelegateDids).toEqual([preSuppliedDelegateDid]);
      expect(revocationGrantStub.firstCall.args[0].grantedTo).toBe(preSuppliedDelegateDid);
      expect(result.delegateDid).toBe(preSuppliedDelegateDid);
      expect(result.delegatePortableDid).toBeUndefined();
      // A fresh response DID is minted so the wallet can still sign the response.
      expect(result.responseSigner).toBe(delegateBearerDid);
    });

    it('should create public-key wrapped grantKeys for encrypted read scopes when using a pre-supplied delegate DID', async () => {
      const preSuppliedDelegate = await DidJwk.create();
      const { capturedDelegateDids } = stubApprovalDependencies();
      const grantKeyStub = sinon.stub(ConnectCeremony, 'createGrantKeyRecordsForGrants').resolves([]);
      const encryptedProtocol: DwnProtocolDefinition = {
        protocol  : 'http://pre-supplied-encrypted.xyz',
        published : true,
        types     : {
          note: {
            schema             : 'http://pre-supplied-encrypted.xyz/note',
            dataFormats        : ['text/plain'],
            encryptionRequired : true,
          },
        },
        structure: { note: {} },
      };
      const readScopes: RecordsPermissionScope[] = [{
        interface : 'Records' as any,
        method    : 'Read' as any,
        protocol  : encryptedProtocol.protocol,
      }];

      await executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest({
          delegateDid        : preSuppliedDelegate.uri,
          permissionRequests : [{ protocolDefinition: encryptedProtocol, permissionScopes: readScopes }],
        }),
      });

      expect(capturedDelegateDids).toEqual([preSuppliedDelegate.uri]);
      expect(grantKeyStub.calledOnce).toBe(true);
      const grantKeyParams = grantKeyStub.firstCall.args[0] as any;
      expect(grantKeyParams.granteeDid).toBe(preSuppliedDelegate.uri);
      expect(grantKeyParams.granteeRootPrivateKey).toBeUndefined();
      expect(grantKeyParams.granteeRootPublicKey).toBeDefined();
      expect(grantKeyParams.granteeRootPublicKey.crv).toBe('X25519');
    });

    it('should reject unusable pre-supplied delegate encryption keys before creating grants', async () => {
      const { capturedDelegateDids, revocationGrantStub } = stubApprovalDependencies();
      const grantKeyStub = sinon.stub(ConnectCeremony, 'createGrantKeyRecordsForGrants').resolves([]);
      const encryptedProtocol: DwnProtocolDefinition = {
        protocol  : 'http://pre-supplied-invalid-encryption.xyz',
        published : true,
        types     : {
          note: {
            schema             : 'http://pre-supplied-invalid-encryption.xyz/note',
            dataFormats        : ['text/plain'],
            encryptionRequired : true,
          },
        },
        structure: { note: {} },
      };
      const readScopes: RecordsPermissionScope[] = [{
        interface : 'Records' as any,
        method    : 'Read' as any,
        protocol  : encryptedProtocol.protocol,
      }];

      await expect(executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest({
          delegateDid        : 'did:example:delegate',
          permissionRequests : [{ protocolDefinition: encryptedProtocol, permissionScopes: readScopes }],
        }),
      })).rejects.toThrow();

      expect(capturedDelegateDids).toEqual([]);
      expect(grantKeyStub.called).toBe(false);
      expect(revocationGrantStub.called).toBe(false);
    });

    it('should reject malformed pre-supplied delegate DID values before creating a response DID', async () => {
      const delegateCreateStub = sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      await expect(executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest({ delegateDid: 'wallet.example' }),
      })).rejects.toThrow('Connect delegateDid must be a valid DID URI.');
      expect(delegateCreateStub.callCount).toBe(0);
    });

    it('should reject invalid requested session TTL before creating a delegate DID', async () => {
      for (const requestedSessionTtlSeconds of [0, 0.5]) {
        const delegateCreateStub = sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

        await expect(executeConnectApproval({
          agent       : testHarness.agent,
          providerDid : providerIdentity.did.uri,
          transport   : 'relay',
          request     : approvalRequest({ requestedSessionTtlSeconds }),
        })).rejects.toThrow('Connect requestedSessionTtlSeconds must resolve to at least one whole second.');
        expect(delegateCreateStub.callCount).toBe(0);
        delegateCreateStub.restore();
      }
    });

    it('should emit a total perf log when the approval fails', async () => {
      const logStub = sinon.stub(logger, 'log');
      sinon.stub(DidJwk, 'create').rejects(new Error('delegate failed'));

      await expect(executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest(),
      })).rejects.toThrow('delegate failed');

      const logMessages = logStub.getCalls().map((call) => call.args[0]);
      expect(logMessages.some(
        (message) => message.includes('[connect.perf] delegateDid.create fail')
      )).toBe(true);
      expect(logMessages.some(
        (message) => message.includes('[connect.perf] executeConnectApproval.total fail')
      )).toBe(true);
    });

    it('should verify remote endpoints without re-configuring when local and remote installs are current', async () => {
      // Scenario: the protocol is installed locally AND every owner DWN
      // endpoint already has the matching definition. The ceremony verifies
      // each endpoint with the signed protocol query (fail-closed conflict
      // detection) but issues ZERO ProtocolsConfigure sends — locally or
      // remotely — and never touches the sequential legacy
      // `agent.sendDwnRequest` path (the historical "Authorizing…" hang).

      stubApprovalCeremony();

      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });
      const endpointUrls = ['https://dwn-a.example/', 'https://dwn-b.example/'];
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves(endpointUrls);
      const rpcSendRequestSpy = stubRemoteProtocolRpc({ before: protocolDefinition });

      const processDwnRequestStub = sinon
        .stub(testHarness.agent, 'processDwnRequest')
        .resolves({
          messageCid : '',
          reply      : protocolQueryReply(protocolDefinition),
          message    : signedProtocolQuery,
        } as any);

      await executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest(),
      });

      // Exactly one local read — the ProtocolsQuery — and no local configure.
      expect(processDwnRequestStub.callCount).toBe(1);
      expect(processDwnRequestStub.firstCall.args[0].messageType).toBe(DwnInterface.ProtocolsQuery);

      // Every endpoint was verified with the signed query, exactly once.
      const remoteQueries = rpcSendRequestSpy.getCalls().filter(
        (c) => c.args[0]?.message === signedProtocolQuery,
      );
      expect(new Set(remoteQueries.map((c) => c.args[0].dwnUrl))).toEqual(new Set(endpointUrls));
      expect(remoteQueries).toHaveLength(endpointUrls.length);

      // No redundant remote ProtocolsConfigure send via either transport.
      expect(sendRequestSpy.callCount).toBe(0);
      expect(
        rpcSendRequestSpy.getCalls().some(
          (c) => (c.args[0]?.message as any)?.descriptor?.method === 'Configure'
        ),
      ).toBe(false);
    });

    it('should configure the protocol locally and fan out to all owner DWN endpoints when the protocol is missing locally', async () => {
      // Scenario: the ceremony's `prepareProtocol` runs in the safety-fallback
      // path (caller did not pre-install). It must (a) configure the protocol
      // on the LOCAL DWN via `processDwnRequest` so the agent can sign / encrypt
      // grants for it, and (b) push the configure message to every owner DWN
      // endpoint in PARALLEL via `agent.rpc.sendDwnRequest` (best-effort).
      //
      // The legacy `agent.sendDwnRequest` path — which iterated owner endpoints
      // sequentially and is the historical bottleneck — must NOT be used.

      stubApprovalCeremony();

      // Spy on both transports — only `agent.rpc.sendDwnRequest` should fire.
      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });

      // Stub endpoint resolution to two URLs so we can observe parallel fan-out.
      const endpointUrls = ['https://dwn-a.example/', 'https://dwn-b.example/'];
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves(endpointUrls);

      // Remotes are missing the protocol before fan-out and report the
      // requested definition on the postcondition re-query.
      const rpcSendRequestSpy = stubRemoteProtocolRpc({ after: protocolDefinition });

      // ProtocolsQuery → empty entries (missing locally) on first call;
      // local ProtocolsConfigure → 202 with a synthetic descriptor on second.
      const processDwnRequestStub = sinon.stub(testHarness.agent, 'processDwnRequest');
      processDwnRequestStub
        .onFirstCall()
        .resolves({
          messageCid : '',
          reply      : { status: { code: 200, detail: 'OK' }, entries: [] },
          message    : signedProtocolQuery,
        } as any);
      processDwnRequestStub
        .onSecondCall()
        .resolves({
          messageCid : '',
          reply      : { status: { code: 202, detail: 'OK' } },
          message    : { descriptor: { interface: 'Protocols', method: 'Configure' } } as any,
        });

      await executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest(),
      });

      // processDwnRequest is called twice: ProtocolsQuery, then a LOCAL
      // ProtocolsConfigure (with messageParams + optional encryption).
      expect(processDwnRequestStub.callCount).toBe(2);
      expect(processDwnRequestStub.firstCall.args[0].messageType).toBe(DwnInterface.ProtocolsQuery);
      expect(processDwnRequestStub.secondCall.args[0].messageType).toBe(DwnInterface.ProtocolsConfigure);
      expect((processDwnRequestStub.secondCall.args[0] as any).messageParams?.definition?.protocol)
        .toBe(protocolDefinition.protocol);

      // The legacy `agent.sendDwnRequest` is no longer used by prepareProtocol.
      expect(sendRequestSpy.callCount).toBe(0);

      // Each owner DWN endpoint receives the configure message exactly once via
      // the parallel `mapConcurrentSettled` fan-out.
      const configureSends = rpcSendRequestSpy.getCalls().filter(
        (c) => (c.args[0]?.message as any)?.descriptor?.method === 'Configure',
      );
      expect(configureSends).toHaveLength(endpointUrls.length);
      expect(new Set(configureSends.map((c) => c.args[0].dwnUrl))).toEqual(new Set(endpointUrls));

      // Every per-request send carries the connect-flow per-request abort
      // budget so a single unhealthy endpoint cannot stall the hot path.
      for (const call of configureSends) {
        expect(call.args[0].signal).toBeInstanceOf(AbortSignal);
      }
    });

    it('should treat a 200 reply with no entries field as missing locally and trigger the safety fallback', async () => {
      // Some local DWN replies omit the `entries` array entirely (empty result).
      // The agent must treat that as "not installed" identically to `entries: []`.

      stubApprovalCeremony();

      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });
      const rpcSendRequestSpy = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').resolves({
        status: { code: 202, detail: 'Accepted' }
      } as any);

      // Endpoint resolution returns empty → local-only configuration, no fan-out.
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves([]);

      const processDwnRequestStub = sinon.stub(testHarness.agent, 'processDwnRequest');
      processDwnRequestStub
        .onFirstCall()
        .resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' } } });
      processDwnRequestStub
        .onSecondCall()
        .resolves({
          messageCid : '',
          reply      : { status: { code: 202, detail: 'OK' } },
          message    : { descriptor: { interface: 'Protocols', method: 'Configure' } } as any,
        });

      await executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest(),
      });

      // Treated as missing → local configure attempted.
      expect(processDwnRequestStub.callCount).toBe(2);
      expect(processDwnRequestStub.secondCall.args[0].messageType).toBe(DwnInterface.ProtocolsConfigure);

      // No endpoints → no remote fan-out, no legacy send.
      expect(sendRequestSpy.callCount).toBe(0);
      expect(
        rpcSendRequestSpy.getCalls().some(
          (c) => (c.args[0]?.message as any)?.descriptor?.method === 'Configure'
        ),
      ).toBe(false);
    });

    it('should fail if local ProtocolsConfigure fails when the protocol is missing locally', async () => {
      // Scenario: the ceremony's safety-fallback path attempts to install the
      // protocol locally before fanning out remotely. If the local install
      // itself fails (non-202/409), the connect flow MUST throw — without
      // a locally installed protocol, the agent cannot sign / encrypt grants.
      // Remote endpoint failures, in contrast, are best-effort (sync delivers
      // missed copies), so they do NOT abort the connect.

      sinon.stub(ConnectCeremony, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        reply      : { status: { code: 500, detail: 'Internal Server Error' } },
        messageCid : ''
      });
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves([]);

      // ProtocolsQuery → empty (missing locally). Local ProtocolsConfigure → 500.
      const processDwnRequestStub = sinon.stub(testHarness.agent, 'processDwnRequest');
      processDwnRequestStub
        .onFirstCall()
        .resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' }, entries: [] } });
      processDwnRequestStub
        .onSecondCall()
        .resolves({ messageCid: '', reply: { status: { code: 500, detail: 'Local DWN error' } } });

      await expect(executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest(),
      })).rejects.toThrow('Could not configure protocol locally: Local DWN error');

      // Local query + local configure = two processDwnRequest calls; no
      // legacy `agent.sendDwnRequest` calls because the new path uses the
      // RPC client directly and the failure happens before fan-out.
      expect(processDwnRequestStub.callCount).toBe(2);
      expect(sendRequestSpy.callCount).toBe(0);
    });

    it('should fail closed when no owner DWN endpoint is reachable for protocol verification', async () => {
      // Scenario: endpoints resolve for the provider but every one of them is
      // unreachable. The approval cannot verify the protocol state anywhere —
      // and grant delivery would be guaranteed to fail next — so the ceremony
      // aborts with the protocol-verification error instead of approving a
      // session the app can never use.

      stubApprovalCeremony();

      sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });
      const rpcSendRequestSpy = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest')
        .rejects(new Error('every endpoint is unhealthy'));

      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget')
        .resolves(['https://dwn-a.example/', 'https://dwn-b.example/']);

      const processDwnRequestStub = sinon.stub(testHarness.agent, 'processDwnRequest');
      processDwnRequestStub
        .onFirstCall()
        .resolves({
          messageCid : '',
          reply      : { status: { code: 200, detail: 'OK' }, entries: [] },
          message    : signedProtocolQuery,
        } as any);

      await expect(executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest(),
      })).rejects.toThrow('Could not verify the protocol definition');

      // Verification was attempted on every endpoint before failing closed,
      // and no configure was issued anywhere.
      const remoteQueries = rpcSendRequestSpy.getCalls().filter(
        (c) => c.args[0]?.message === signedProtocolQuery,
      );
      expect(remoteQueries).toHaveLength(2);
      expect(processDwnRequestStub.callCount).toBe(1);
    });

    it('should throw if protocol could not be fetched at all', async () => {
      sinon.stub(ConnectCeremony, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      // spy send request
      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        reply      : { status: { code: 500, detail: 'Internal Server Error' } },
        messageCid : ''
      });

      const processDwnRequestStub = sinon
        .stub(testHarness.agent, 'processDwnRequest')
        .resolves({ messageCid: '', reply: { status: { code: 500, detail: 'Some Error' }, } });

      await expect(executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest(),
      })).rejects.toThrow('Could not fetch protocol: Some Error');

      expect(processDwnRequestStub.callCount).toBe(1);
      expect(sendRequestSpy.callCount).toBe(0);
    });

    it('should leave encryption policy on the protocol definition during the local configure', async () => {
      // Scenario: the ceremony's safety-fallback installs a protocol whose types
      // declare `encryptionRequired: true`. AgentDwnApi derives and injects the
      // owner's `$keyAgreement` keys from that definition before signing. The
      // ceremony must not add a second caller-controlled encryption switch.

      const encryptedProtocol: DwnProtocolDefinition = {
        protocol  : 'http://encrypted-protocol.xyz',
        published : true,
        types     : {
          secret: {
            schema             : 'http://encrypted-protocol.xyz/schema/secret',
            dataFormats        : ['application/json'],
            encryptionRequired : true,
          },
        },
        structure: { secret: {} },
      };

      const encryptedScopes: RecordsPermissionScope[] = [{
        interface : 'Records' as any,
        method    : 'Write' as any,
        protocol  : 'http://encrypted-protocol.xyz',
      }];

      stubApprovalCeremony();

      sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });
      sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').resolves({
        status: { code: 202, detail: 'Accepted' }
      } as any);
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves([]);

      const processDwnRequestStub = sinon.stub(testHarness.agent, 'processDwnRequest');
      processDwnRequestStub
        .onFirstCall()
        .resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' }, entries: [] } });
      processDwnRequestStub
        .onSecondCall()
        .resolves({
          messageCid : '',
          reply      : { status: { code: 202, detail: 'OK' } },
          message    : { descriptor: { interface: 'Protocols', method: 'Configure' } } as any,
        });

      await executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest({
          permissionRequests: [{ protocolDefinition: encryptedProtocol, permissionScopes: encryptedScopes }],
        }),
      });

      // Verify the local configure carries only the definition-owned policy.
      const configureCall = processDwnRequestStub.getCalls().find(
        (call) => call.args[0].messageType === DwnInterface.ProtocolsConfigure,
      );
      expect(configureCall).toBeDefined();
      expect((configureCall!.args[0] as Record<string, unknown>).encryption).toBeUndefined();
      expect((configureCall!.args[0] as any).messageParams.definition.types.secret.encryptionRequired).toBe(true);
    });

    it('should use durable grantKey records instead of in-band decryption keys for mixed encrypted protocols', async () => {
      const mixedProtocol: DwnProtocolDefinition = {
        protocol  : 'http://mixed-encrypted.xyz',
        published : true,
        types     : {
          thread      : { schema: 'http://mixed-encrypted.xyz/thread', dataFormats: ['application/json'], encryptionRequired: true },
          participant : { schema: 'http://mixed-encrypted.xyz/participant', dataFormats: ['application/json'] },
          chat        : { schema: 'http://mixed-encrypted.xyz/chat', dataFormats: ['text/plain'], encryptionRequired: true },
          note        : { schema: 'http://mixed-encrypted.xyz/note', dataFormats: ['text/plain'], encryptionRequired: true },
        },
        structure: {
          thread: {
            participant : { $role: true },
            chat        : { $actions: [{ role: 'thread/participant', can: ['create', 'read'] }] },
          },
          note: {},
        },
      };

      const readScopes: RecordsPermissionScope[] = [{
        interface : 'Records' as any,
        method    : 'Read' as any,
        protocol  : 'http://mixed-encrypted.xyz',
      }];

      stubApprovalCeremony();
      const grantKeyStub = sinon.stub(ConnectCeremony, 'createGrantKeyRecordsForGrants').resolves([]);
      sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves([]);
      // Installed definition matches but lacks $keyAgreement keys for its
      // encrypted types → encryption upgrade → local re-configure.
      const processDwnRequestStub = sinon.stub(testHarness.agent, 'processDwnRequest');
      processDwnRequestStub
        .onFirstCall()
        .resolves({
          messageCid : '',
          reply      : {
            status  : { code: 200, detail: 'OK' },
            entries : [{ descriptor: { interface: 'Protocols', method: 'Configure', definition: mixedProtocol } }] as any,
          },
        });
      processDwnRequestStub.resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } },
        message    : { descriptor: { interface: 'Protocols', method: 'Configure' } } as any,
      });

      const result = await executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest({
          permissionRequests: [{ protocolDefinition: mixedProtocol, permissionScopes: readScopes }],
        }),
      });

      expect(grantKeyStub.calledOnce).toBe(true);
      expect('delegateDecryptionKeys' in result).toBe(false);
    });

    it('should deliver one ordered grant batch and map encrypted grants back to their protocol', async () => {
      const encryptedProtocol: DwnProtocolDefinition = {
        protocol  : 'http://ordered-encrypted.xyz',
        published : true,
        types     : {
          note: {
            schema             : 'http://ordered-encrypted.xyz/note',
            dataFormats        : ['text/plain'],
            encryptionRequired : true,
          },
        },
        structure: { note: {} },
      };
      const plainScopes = [permissionScopes[0]];
      const encryptedScopes: RecordsPermissionScope[] = [
        {
          interface : 'Records' as any,
          method    : 'Read' as any,
          protocol  : encryptedProtocol.protocol,
        },
        {
          interface : 'Records' as any,
          method    : 'Write' as any,
          protocol  : encryptedProtocol.protocol,
        },
      ];
      const createdGrants = ['plain', 'encrypted-read', 'encrypted-write'].map((recordId) => ({
        ...permissionGrants[0].message,
        recordId,
      }));

      const { createGrantsStub } = stubApprovalCeremony({ permissionGrants: createdGrants });
      const grantKeyStub = sinon.stub(ConnectCeremony, 'createGrantKeyRecordsForGrants').resolves([]);
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves([]);
      sinon.stub(testHarness.agent, 'processDwnRequest').callsFake(async (request: any) =>
        request.messageType === DwnInterface.ProtocolsConfigure
          ? {
            messageCid : '',
            reply      : { status: { code: 202, detail: 'Accepted' } },
            message    : { descriptor: { interface: 'Protocols', method: 'Configure' } },
          } as any
          : {
            messageCid : '',
            reply      : { status: { code: 200, detail: 'OK' }, entries: [] },
          } as any);

      await executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest({
          permissionRequests: [
            { protocolDefinition, permissionScopes: plainScopes },
            { protocolDefinition: encryptedProtocol, permissionScopes: encryptedScopes },
          ],
        }),
      });

      expect(createGrantsStub.calledOnce).toBe(true);
      expect(createGrantsStub.firstCall.args[3]).toEqual([...plainScopes, ...encryptedScopes]);
      expect(grantKeyStub.calledOnce).toBe(true);
      expect(grantKeyStub.firstCall.args[0].grantMessages).toEqual(createdGrants.slice(1));
      expect(grantKeyStub.firstCall.args[0].protocolDefinitions).toEqual([encryptedProtocol]);
    });

    it('should fan out durable grantKey records with their encrypted data during connect', async () => {
      const encryptedProtocol: DwnProtocolDefinition = {
        protocol  : 'http://grantkey-fanout-encrypted.xyz',
        published : true,
        types     : {
          note: {
            schema             : 'http://grantkey-fanout-encrypted.xyz/note',
            dataFormats        : ['text/plain'],
            encryptionRequired : true,
          },
        },
        structure: { note: {} },
      };
      const readScopes: RecordsPermissionScope[] = [{
        interface : 'Records' as any,
        method    : 'Read' as any,
        protocol  : encryptedProtocol.protocol,
      }];
      const grantKeyData = new Uint8Array([9, 8, 7, 6]);
      const grantKeyRecord = {
        recordId   : 'grant-key-fanout-record-id',
        descriptor : {
          interface    : 'Records',
          method       : 'Write',
          recipient    : delegateBearerDid.uri,
          protocol     : EncryptionProtocol.uri,
          protocolPath : EncryptionProtocol.wrappedGrantKeyPath,
          dataFormat   : 'application/json',
          tags         : { protocol: encryptedProtocol.protocol },
        },
        encodedData: Convert.uint8Array(grantKeyData).toBase64Url(),
      };
      const endpoints = ['https://dwn-a.example/', 'https://dwn-b.example/'];

      stubApprovalCeremony();
      sinon.stub(ConnectCeremony, 'createGrantKeyRecordsForGrants').resolves([grantKeyRecord] as any);

      // Protocol preparation runs local-only (no endpoints on its resolution
      // call); the grantKey fan-out then sees the two endpoints; the final
      // revocation fan-out sees none.
      const endpointStub = sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget');
      endpointStub.onFirstCall().resolves([]);
      endpointStub.onSecondCall().resolves(endpoints);
      endpointStub.resolves([]);
      sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });
      // Installed-but-unencrypted definition → encryption upgrade locally.
      sinon.stub(testHarness.agent, 'processDwnRequest').callsFake(async (request: any) =>
        request.messageType === DwnInterface.ProtocolsConfigure
          ? {
            messageCid : '',
            reply      : { status: { code: 202, detail: 'Accepted' } },
            message    : { descriptor: { interface: 'Protocols', method: 'Configure' } },
          } as any
          : {
            messageCid : '',
            reply      : {
              status  : { code: 200, detail: 'OK' },
              entries : [{ descriptor: { interface: 'Protocols', method: 'Configure', definition: encryptedProtocol } }],
            },
          } as any);
      const rpcSendRequestStub = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest')
        .resolves({ status: { code: 202, detail: 'Accepted' } } as any);

      await executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest({
          permissionRequests: [{ protocolDefinition: encryptedProtocol, permissionScopes: readScopes }],
        }),
      });

      expect(rpcSendRequestStub.callCount).toBe(endpoints.length);
      for (const [index, call] of rpcSendRequestStub.getCalls().entries()) {
        const sendRequest = call.args[0];
        expect(sendRequest.dwnUrl).toBe(endpoints[index]);
        expect(sendRequest.targetDid).toBe(providerIdentity.did.uri);
        expect((sendRequest.message as any).encodedData).toBeUndefined();
        expect((sendRequest.message as any).recordId).toBe(grantKeyRecord.recordId);
        expect(sendRequest.signal).toBeInstanceOf(AbortSignal);

        const sentBytes = new Uint8Array(await (sendRequest.data as Blob).arrayBuffer());
        expect([...sentBytes]).toEqual([...grantKeyData]);
      }
    });

    it('should stop the approval when durable grantKey fanout fails for every endpoint', async () => {
      const encryptedProtocol: DwnProtocolDefinition = {
        protocol  : 'http://grantkey-fanout-fail-encrypted.xyz',
        published : true,
        types     : {
          note: {
            schema             : 'http://grantkey-fanout-fail-encrypted.xyz/note',
            dataFormats        : ['text/plain'],
            encryptionRequired : true,
          },
        },
        structure: { note: {} },
      };
      const readScopes: RecordsPermissionScope[] = [{
        interface : 'Records' as any,
        method    : 'Read' as any,
        protocol  : encryptedProtocol.protocol,
      }];
      const grantKeyRecord = {
        recordId   : 'grant-key-fanout-fail-record-id',
        descriptor : {
          interface    : 'Records',
          method       : 'Write',
          recipient    : delegateBearerDid.uri,
          protocol     : EncryptionProtocol.uri,
          protocolPath : EncryptionProtocol.wrappedGrantKeyPath,
          dataFormat   : 'application/json',
          tags         : { protocol: encryptedProtocol.protocol },
        },
        encodedData: Convert.uint8Array(new Uint8Array([1, 2, 3])).toBase64Url(),
      };

      const { revocationGrantStub } = stubApprovalCeremony();
      sinon.stub(ConnectCeremony, 'createGrantKeyRecordsForGrants').resolves([grantKeyRecord] as any);

      // Protocol preparation runs local-only; the grantKey fan-out sees the
      // endpoints and every send is rejected.
      const endpointStub = sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget');
      endpointStub.onFirstCall().resolves([]);
      endpointStub.resolves(['https://dwn-a.example/', 'https://dwn-b.example/']);
      sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });
      sinon.stub(testHarness.agent, 'processDwnRequest').callsFake(async (request: any) =>
        request.messageType === DwnInterface.ProtocolsConfigure
          ? {
            messageCid : '',
            reply      : { status: { code: 202, detail: 'Accepted' } },
            message    : { descriptor: { interface: 'Protocols', method: 'Configure' } },
          } as any
          : {
            messageCid : '',
            reply      : {
              status  : { code: 200, detail: 'OK' },
              entries : [{ descriptor: { interface: 'Protocols', method: 'Configure', definition: encryptedProtocol } }],
            },
          } as any);
      sinon.stub(testHarness.agent.rpc, 'sendDwnRequest')
        .resolves({ status: { code: 500, detail: 'nope' } } as any);

      await expect(executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest({
          permissionRequests: [{ protocolDefinition: encryptedProtocol, permissionScopes: readScopes }],
        }),
      })).rejects.toThrow('Could not send grantKey record to any DWN endpoint.');

      // The ceremony aborts before revocation grants are created.
      expect(revocationGrantStub.called).toBe(false);
    });

    it('should throw if a grant that is included in the request does not match the protocol definition', async () => {
      sinon.stub(ConnectCeremony, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      // Deep-clone before mutating so this test does not leak state into
      // subsequent tests in the same describe block (a spread would be a
      // shallow copy — `mismatchedScopes[0]` would BE `permissionScopes[0]`).
      const mismatchedScopes = permissionScopes.map((s) => ({ ...s }));
      mismatchedScopes[0].protocol = 'http://profile-protocol.xyz/other';

      await expect(executeConnectApproval({
        agent       : testHarness.agent,
        providerDid : providerIdentity.did.uri,
        transport   : 'relay',
        request     : approvalRequest({
          permissionRequests: [{ protocolDefinition, permissionScopes: mismatchedScopes }],
        }),
      })).rejects.toThrow('All permission scopes must match the protocol URI they are provided with.');
    });

    describe('connect-flow fan-out parallelism (regression: "Authorizing…" hang)', () => {
      it('should fan the safety-fallback ProtocolsConfigure out to all owner DWN endpoints in PARALLEL, not sequentially', async () => {
        // Each per-endpoint send takes 250 ms. With 4 endpoints, sequential
        // execution would take ≥ 1000 ms; parallel execution should take
        // ~250 ms. This test asserts a generous-but-still-meaningful upper
        // bound (700 ms) to prevent any future regression that re-introduces
        // sequential per-endpoint iteration in the connect hot path.
        const endpointUrls = [
          'https://dwn-a.example/',
          'https://dwn-b.example/',
          'https://dwn-c.example/',
          'https://dwn-d.example/',
        ];
        const PER_SEND_DELAY_MS = 250;

        stubApprovalCeremony();

        sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves(endpointUrls);
        sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
          messageCid : '',
          reply      : { status: { code: 202, detail: 'OK' } }
        });
        const queriesSeen = new Map<string, number>();
        const rpcSendRequestStub = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest')
          .callsFake(async (request: any) => {
            await new Promise<void>((resolve) => setTimeout(resolve, PER_SEND_DELAY_MS));
            if (request.message === signedProtocolQuery) {
              const seen = queriesSeen.get(request.dwnUrl) ?? 0;
              queriesSeen.set(request.dwnUrl, seen + 1);
              return protocolQueryReply(seen === 0 ? undefined : protocolDefinition) as any;
            }
            return { status: { code: 202, detail: 'Accepted' } } as any;
          });

        const processDwnRequestStub = sinon.stub(testHarness.agent, 'processDwnRequest');
        processDwnRequestStub
          .onFirstCall()
          .resolves({
            messageCid : '',
            reply      : { status: { code: 200, detail: 'OK' }, entries: [] },
            message    : signedProtocolQuery,
          } as any);
        processDwnRequestStub
          .onSecondCall()
          .resolves({
            messageCid : '',
            reply      : { status: { code: 202, detail: 'OK' } },
            message    : { descriptor: { interface: 'Protocols', method: 'Configure' } } as any,
          });

        const start = Date.now();
        await executeConnectApproval({
          agent       : testHarness.agent,
          providerDid : providerIdentity.did.uri,
          transport   : 'relay',
          request     : approvalRequest(),
        });
        const elapsed = Date.now() - start;

        // Protocol preparation runs three endpoint-wide phases (verify query,
        // configure fan-out, postcondition re-query) — each parallel across
        // the 4 endpoints. Parallel: ~3 × 250 ms = 750 ms. Sequential
        // per-endpoint iteration would be ≥ 3 × 4 × 250 ms = 3000 ms; the
        // bound leaves CI slack while still failing loudly on a regression.
        expect(elapsed).toBeLessThan(1800);

        const configureSends = rpcSendRequestStub.getCalls().filter(
          (c) => (c.args[0]?.message as any)?.descriptor?.method === 'Configure',
        );
        expect(configureSends).toHaveLength(endpointUrls.length);
      });

      it('should attach a per-request AbortSignal with a bounded timeout to every connect-flow fan-out send', async () => {
        // The connect flow caps each `agent.rpc.sendDwnRequest` with
        // `AbortSignal.timeout(CONNECT_REQUEST_TIMEOUT_MS)` so a single
        // unhealthy endpoint cannot consume the full HTTP retry budget
        // (4 × 30 s) and stall the user-visible "Authorizing…" spinner.
        // This test asserts a signal is present on every send, that it is
        // an AbortSignal, and that it is NOT already aborted at dispatch
        // time (i.e. the budget genuinely starts when the request begins).
        stubApprovalCeremony();

        sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget')
          .resolves(['https://dwn-a.example/', 'https://dwn-b.example/']);
        sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
          messageCid : '',
          reply      : { status: { code: 202, detail: 'OK' } }
        });
        const rpcSendRequestSpy = stubRemoteProtocolRpc({ after: protocolDefinition });

        const processDwnRequestStub = sinon.stub(testHarness.agent, 'processDwnRequest');
        processDwnRequestStub
          .onFirstCall()
          .resolves({
            messageCid : '',
            reply      : { status: { code: 200, detail: 'OK' }, entries: [] },
            message    : signedProtocolQuery,
          } as any);
        processDwnRequestStub
          .onSecondCall()
          .resolves({
            messageCid : '',
            reply      : { status: { code: 202, detail: 'OK' } },
            message    : { descriptor: { interface: 'Protocols', method: 'Configure' } } as any,
          });

        await executeConnectApproval({
          agent       : testHarness.agent,
          providerDid : providerIdentity.did.uri,
          transport   : 'relay',
          request     : approvalRequest(),
        });

        // EVERY connect-flow send (verification queries + configure fan-out +
        // permission grants + revocation grants) must carry a non-aborted
        // AbortSignal so the HttpDwnRpcClient enforces the per-request budget.
        expect(rpcSendRequestSpy.callCount).toBeGreaterThan(0);
        for (const call of rpcSendRequestSpy.getCalls()) {
          const signal = call.args[0]?.signal;
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(signal!.aborted).toBe(false);
        }
      });

      it('should still complete when one endpoint hangs forever — the abort signal short-circuits the retry budget', async () => {
        // Reproduces the original "Authorizing… for minutes" symptom: one
        // unhealthy endpoint that never responds. Without per-request abort
        // plumbing, `AbortSignal.timeout(...)` from the connect flow would
        // not reach the underlying fetch and the request would burn the
        // full 4 × 30 s retry budget. We simulate that by giving the second
        // endpoint a fake `sendDwnRequest` that respects the caller's
        // AbortSignal — exactly as the real HttpDwnRpcClient now does.
        stubApprovalCeremony();

        const healthyUrl = 'https://dwn-healthy.example/';
        const hangingUrl = 'https://dwn-hanging.example/';
        sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget')
          .resolves([healthyUrl, hangingUrl]);
        sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
          messageCid : '',
          reply      : { status: { code: 202, detail: 'OK' } }
        });

        // Healthy endpoint resolves fast; hanging endpoint waits forever
        // unless the caller's AbortSignal fires (mirroring real HTTP fetch
        // semantics through `AbortSignal.any([caller, perAttemptTimeout])`).
        const queriesSeen = new Map<string, number>();
        sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').callsFake((req: any) => {
          if (req.dwnUrl === hangingUrl) {
            return new Promise((_resolve, reject) => {
              const signal = req.signal!;
              const onAbort = (): void => {
                reject(new DOMException('aborted', 'AbortError'));
              };
              if (signal.aborted) {
                onAbort();
              } else {
                signal.addEventListener('abort', onAbort, { once: true });
              }
            });
          }
          if (req.message === signedProtocolQuery) {
            const seen = queriesSeen.get(req.dwnUrl) ?? 0;
            queriesSeen.set(req.dwnUrl, seen + 1);
            return Promise.resolve(protocolQueryReply(seen === 0 ? undefined : protocolDefinition) as any);
          }
          return Promise.resolve({ status: { code: 202, detail: 'Accepted' } } as any);
        });

        const processDwnRequestStub = sinon.stub(testHarness.agent, 'processDwnRequest');
        processDwnRequestStub
          .onFirstCall()
          .resolves({
            messageCid : '',
            reply      : { status: { code: 200, detail: 'OK' }, entries: [] },
            message    : signedProtocolQuery,
          } as any);
        processDwnRequestStub
          .onSecondCall()
          .resolves({
            messageCid : '',
            reply      : { status: { code: 202, detail: 'OK' } },
            message    : { descriptor: { interface: 'Protocols', method: 'Configure' } } as any,
          });

        const start = Date.now();
        await executeConnectApproval({
          agent       : testHarness.agent,
          providerDid : providerIdentity.did.uri,
          transport   : 'relay',
          request     : approvalRequest(),
        });
        const elapsed = Date.now() - start;

        // The per-request budget is 10 s. The ceremony runs three sequential
        // phases that each touch every endpoint (prepareProtocol fan-out,
        // permission-grant fan-out — stubbed here, and revocation fan-out),
        // so a fully hung endpoint costs at most one budget per unstubbed
        // phase. We assert 25 s to leave generous CI slack while still
        // failing loudly on regressions that bypass the abort signal
        // (without this fix, the same scenario takes minutes).
        expect(elapsed).toBeLessThan(25_000);
      }, 60_000); // bun:test per-test timeout, kept above the assertion budget
    });
  });
});
