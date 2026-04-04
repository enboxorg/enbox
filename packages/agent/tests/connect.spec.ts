import type { PortableDid } from '@enbox/dids';
import type { RecordsPermissionScope } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { Convert } from '@enbox/common';
import { CryptoUtils } from '@enbox/crypto';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import { type BearerDid, DidDht, DidJwk } from '@enbox/dids';

import { AgentPermissionsApi, DwnInterface } from '../src/index.js';
import {
  EnboxConnectProtocol,
  type EnboxConnectRequest,
  type EnboxConnectResponse,
} from '../src/enbox-connect-protocol.js';

import type { BearerIdentity, DwnMessage, DwnProtocolDefinition } from '../src/index.js';

describe('enbox connect', () => {

  /** The temporary DID that web5 connect created on behalf of the client */
  let clientEphemeralBearerDid: BearerDid;
  let clientEphemeralPortableDid: PortableDid;

  /** The real tenant (identity) of the DWN that the provider had chosen to connect */
  let providerIdentity: BearerIdentity;

  /** The new DID created for the delegate which it will impersonate in the future */
  let delegateBearerDid: BearerDid;
  let delegatePortableDid: PortableDid;

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
      method    : 'Query' as any,
      protocol  : 'http://profile-protocol.xyz',
    },
    {
      interface : 'Records' as any,
      method    : 'Read' as any,
      protocol  : 'http://profile-protocol.xyz',
    },
  ];

  let testHarness: PlatformAgentTestHarness;

  let connectRequest: EnboxConnectRequest;
  let connectRequestJwt: string;
  let connectRequestJwe: string;

  let connectResponse: EnboxConnectResponse;
  let connectResponseJwt: string;
  let connectResponseJwe: string;

  let sharedECDHPrivateKey: Uint8Array;

  const connectRequestEncryptionKey = CryptoUtils.randomBytes(32);
  const encryptionNonce = CryptoUtils.randomBytes(24);
  const randomPin = '9999';

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

    clientEphemeralBearerDid = await DidJwk.create();
    clientEphemeralPortableDid = await clientEphemeralBearerDid.export();

    delegateBearerDid = await DidJwk.create();
    delegatePortableDid = await delegateBearerDid.export();
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('client connect request phase', () => {
    // it('should create a code challenge', async () => {
    //   const result = await Oidc.generateCodeChallenge();
    //   expect(result.codeChallengeBytes).toBeInstanceOf(Uint8Array);
    //   expect(typeof result.codeChallengeBase64Url).toBe('string');
    // });

    it('should create a connect request with the client DID', async () => {
      const _randomBytesStub = sinon
        .stub(CryptoUtils, 'randomBytes')
        .returns(connectRequestEncryptionKey);

      const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const options = {
        appName            : 'Sample App',
        clientDid          : clientEphemeralPortableDid.uri,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        callbackUrl        : callbackUrl,
      };
      connectRequest = await EnboxConnectProtocol.createConnectRequest(options);
      expect(connectRequest).toEqual(expect.objectContaining(options));
      expect(typeof connectRequest.nonce).toBe('string');
      expect(typeof connectRequest.state).toBe('string');
      expect(connectRequest.callbackUrl).toBe(
        'http://localhost:3000/callback'
      );
    });

    it('should construct a signed JWT of a connect request', async () => {
      connectRequestJwt = await EnboxConnectProtocol.signJwt({
        did  : clientEphemeralBearerDid,
        data : connectRequest,
      });
      expect(typeof connectRequestJwt).toBe('string');
    });

    it('should encrypt a connect request', async () => {
      connectRequestJwe = await EnboxConnectProtocol.encryptRequest({
        jwt           : connectRequestJwt,
        encryptionKey : connectRequestEncryptionKey
      });
      expect(typeof connectRequestJwe).toBe('string');
      expect(connectRequestJwe.split('.')).toHaveLength(5);
    });
  });

  describe('provider connect response phase', () => {
    it('should get connect request from server, decrypt and verify the JWT', async () => {
      const fetchStub = sinon
        .stub(globalThis, 'fetch')
        .onFirstCall()
        .resolves({
          text: sinon.stub().resolves(connectRequestJwe),
        } as any);
      fetchStub.callThrough();

      const authorizeUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL   : 'http://localhost:3000',
        endpoint  : 'authorize',
        authParam : '12345',
      });
      expect(authorizeUrl).toBe(
        'http://localhost:3000/authorize/12345.jwt'
      );

      const result = await EnboxConnectProtocol.getConnectRequest(
        authorizeUrl,
        Convert.uint8Array(connectRequestEncryptionKey).toBase64Url()
      );
      expect(result).toEqual(connectRequest);
    });

    it('should create permission grants for each selected did', async () => {
      const results = await EnboxConnectProtocol.createPermissionGrants(
        providerIdentity.did.uri,
        delegateBearerDid,
        testHarness.agent,
        permissionScopes
      );
      const scopesRequested = permissionScopes.length;
      expect(results).toHaveLength(scopesRequested);
      expect(typeof results[0]).toBe('object');
    });

    it('should create the connect response which includes the permissionGrants, nonce, private key material', async () => {
      const options = {
        providerDid    : providerIdentity.did.uri,
        delegateDid    : delegateBearerDid.uri,
        aud            : connectRequest.clientDid,
        nonce          : connectRequest.nonce,
        delegateGrants : permissionGrants,
        delegatePortableDid,
      };
      connectResponse = await EnboxConnectProtocol.createConnectResponse(options);

      expect(connectResponse).toEqual(expect.objectContaining(options));
      expect(typeof connectResponse.iat).toBe('number');
      expect(typeof connectResponse.exp).toBe('number');
      expect(connectResponse.exp - connectResponse.iat).toBe(600);
    });

    it('should sign the connect response with the delegate DID', async () => {
      connectResponseJwt = await EnboxConnectProtocol.signJwt({
        did  : delegateBearerDid,
        data : connectResponse,
      });
      expect(typeof connectResponseJwt).toBe('string');
    });

    it('should derive a valid ECDH private key for both provider and client which is identical', async () => {
      const providerECDHDerivedPrivateKey = await EnboxConnectProtocol.deriveSharedKey(
        delegateBearerDid,
        clientEphemeralBearerDid.document
      );
      const clientECDHDerivedPrivateKey = await EnboxConnectProtocol.deriveSharedKey(
        clientEphemeralBearerDid,
        delegateBearerDid.document
      );

      expect(providerECDHDerivedPrivateKey).toBeInstanceOf(Uint8Array);
      expect(providerECDHDerivedPrivateKey.length).toBeGreaterThan(0);

      expect(clientECDHDerivedPrivateKey).toBeInstanceOf(Uint8Array);
      expect(clientECDHDerivedPrivateKey.length).toBeGreaterThan(0);
      expect(
        Convert.uint8Array(providerECDHDerivedPrivateKey).toHex()
      ).toBe(Convert.uint8Array(clientECDHDerivedPrivateKey).toHex());

      // doesnt matter client and provider are the same
      sharedECDHPrivateKey = clientECDHDerivedPrivateKey;
    });

    it('should encrypt the JWT connect response to pass back to the client', async () => {
      const randomBytesStub = sinon
        .stub(CryptoUtils, 'randomBytes')
        .returns(encryptionNonce);
      connectResponseJwe = await EnboxConnectProtocol.encryptResponse({
        jwt              : connectResponseJwt,
        encryptionKey    : sharedECDHPrivateKey,
        pin              : randomPin,
        delegateDidKeyId : delegateBearerDid.document.verificationMethod![0].id,
      });
      expect(typeof connectResponseJwe).toBe('string');
      expect(randomBytesStub.calledOnce).toBe(true);
    });

    it('should send the encrypted JWE connect response to the server', async () => {
      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      // Stub per-grant revocation createGrant calls (created inside submitConnectResponse)
      sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
        grant   : {} as any,
        message : { recordId: 'mock-revocation-grant-id' } as any,
      });
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });
      expect(callbackUrl).toBe('http://localhost:3000/callback');

      // Stub agent DWN methods so prepareProtocol (called inside submitAuthResponse)
      // succeeds without needing a real DWN server or network access.
      sinon.stub(testHarness.agent, 'processDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 200, detail: 'OK' }, entries: [{ descriptor: { interface: 'Protocols', method: 'Configure' } }] },
      } as any);
      sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'Accepted' } },
      } as any);

      // Stub fetch to capture the callback POST without making a real HTTP call.
      // The body contains a time-dependent JWE (the JWT includes `iat`/`exp`
      // from Date.now()) so we verify structure rather than exact content.
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response());

      const selectedDid = providerIdentity.did.uri;
      await EnboxConnectProtocol.submitConnectResponse(
        selectedDid,
        connectRequest,
        randomPin,
        testHarness.agent
      );

      // Find the call to the callback URL
      const callbackCall = fetchStub.getCalls().find(
        call => call.args[0] === callbackUrl
      );
      expect(callbackCall).toBeDefined();
      const options = callbackCall!.args[1] as RequestInit;
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual({
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      // Verify the body contains the expected state and an id_token
      const body = new URLSearchParams(options.body as string);
      expect(body.get('state')).toBe(connectRequest.state);
      const idToken = body.get('id_token');
      expect(typeof idToken).toBe('string');
      expect(idToken!.length).toBeGreaterThan(0);
    });
  });

  describe('client PIN entry final phase', () => {
    it('should get the connect response from server and decrypt the JWE using the PIN', async () => {
      const result = await EnboxConnectProtocol.decryptResponse(
        clientEphemeralBearerDid,
        connectResponseJwe,
        randomPin
      );
      expect(typeof result).toBe('string');
      expect(result).toBe(connectResponseJwt);
    });

    it('should fail decrypting the jwe if the wrong pin is entered', async () => {
      try {
        await EnboxConnectProtocol.decryptResponse(
          clientEphemeralBearerDid,
          connectResponseJwe,
          '87383837583757835737537734783'
        );
      } catch (e: any) {
        expect(e).toBeInstanceOf(Error);
        expect(e.message).toContain('invalid tag');
      }
    });

    it('should validate the jwt and parse it into an object', async () => {
      const result = (await EnboxConnectProtocol.verifyJwt({
        jwt: connectResponseJwt,
      })) as EnboxConnectResponse;
      expect(typeof result).toBe('object');
      expect(result.delegateGrants.length).toBeGreaterThan(0);
    });
  });

  // NOTE: `end to end client test` and `initClient — error paths` were moved
  // to @enbox/auth (wallet-connect-client.spec.ts) since WalletConnect.initClient
  // now lives in that package.

  describe('submitConnectResponse', () => {
    it('should not attempt to configure the protocol if it already exists', async () => {
      // scenario: the wallet gets a request for a protocol that it already has configured
      // the wallet should not attempt to re-configure, but instead ensure that the protocol is
      // sent to the remote DWN for the requesting client to be able to sync it down later

      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      // Stub per-grant revocation createGrant calls
      sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
        grant   : {} as any,
        message : { recordId: 'mock-revocation-grant-id' } as any,
      });
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const options = {
        appName            : 'Sample App',
        clientDid          : clientEphemeralPortableDid.uri,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        callbackUrl        : callbackUrl,
      };
      connectRequest = await EnboxConnectProtocol.createConnectRequest(options);

      // stub the processDwnRequest method to return a protocol entry
      const protocolMessage = {} as DwnMessage[DwnInterface.ProtocolsConfigure];

      // spy send request
      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });

      const processDwnRequestStub = sinon
        .stub(testHarness.agent, 'processDwnRequest')
        .resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' }, entries: [ protocolMessage ] } });

      // call submitAuthResponse
      await EnboxConnectProtocol.submitConnectResponse(
        providerIdentity.did.uri,
        connectRequest,
        randomPin,
        testHarness.agent
      );

      // expect the process request to only be called once for ProtocolsQuery
      // (per-grant revocation goes through the stubbed AgentPermissionsApi.prototype.createGrant)
      expect(processDwnRequestStub.callCount).toBe(1);
      expect(processDwnRequestStub.firstCall.args[0].messageType).toBe(DwnInterface.ProtocolsQuery);

      // send request should be called once as a ProtocolsConfigure
      expect(sendRequestSpy.callCount).toBe(1);
      expect(sendRequestSpy.firstCall.args[0].messageType).toBe(DwnInterface.ProtocolsConfigure);
    });

    it('should configure the protocol if it does not exist', async () => {
      // scenario: the wallet gets a request for a protocol that it does not have configured
      // the wallet should attempt to configure the protocol and then send the protocol to the remote DWN

      // looks for a response of 404, empty entries array or missing entries array

      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      // Stub per-grant revocation createGrant calls
      sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
        grant   : {} as any,
        message : { recordId: 'mock-revocation-grant-id' } as any,
      });
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const options = {
        appName            : 'Sample App',
        clientDid          : clientEphemeralPortableDid.uri,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        callbackUrl        : callbackUrl,
      };
      connectRequest = await EnboxConnectProtocol.createConnectRequest(options);

      // spy send request
      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });

      const processDwnRequestStub = sinon
        .stub(testHarness.agent, 'processDwnRequest')
        .resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' }, entries: [ ] } });

      // call submitAuthResponse
      await EnboxConnectProtocol.submitConnectResponse(
        providerIdentity.did.uri,
        connectRequest,
        randomPin,
        testHarness.agent
      );

      // expect the process request to be called for query and configure
      expect(processDwnRequestStub.callCount).toBe(2);
      expect(processDwnRequestStub.firstCall.args[0].messageType).toBe(DwnInterface.ProtocolsQuery);
      expect(processDwnRequestStub.secondCall.args[0].messageType).toBe(DwnInterface.ProtocolsConfigure);

      // send request should be called once as a ProtocolsConfigure
      expect(sendRequestSpy.callCount).toBe(1);
      expect(sendRequestSpy.firstCall.args[0].messageType).toBe(DwnInterface.ProtocolsConfigure);

      // reset the spys
      processDwnRequestStub.resetHistory();
      sendRequestSpy.resetHistory();

      // processDwnRequestStub should resolve a 200 with no entires
      processDwnRequestStub.resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' } } });

      // call submitAuthResponse
      await EnboxConnectProtocol.submitConnectResponse(
        providerIdentity.did.uri,
        connectRequest,
        randomPin,
        testHarness.agent
      );

      // expect the process request to be called for query and configure
      expect(processDwnRequestStub.callCount).toBe(2);
      expect(processDwnRequestStub.firstCall.args[0].messageType).toBe(DwnInterface.ProtocolsQuery);
      expect(processDwnRequestStub.secondCall.args[0].messageType).toBe(DwnInterface.ProtocolsConfigure);

      // send request should be called once as a ProtocolsConfigure
      expect(sendRequestSpy.callCount).toBe(1);
      expect(sendRequestSpy.firstCall.args[0].messageType).toBe(DwnInterface.ProtocolsConfigure);
    });

    it('should fail if the send request fails for newly configured protocol', async () => {
      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const options = {
        appName            : 'Sample App',
        clientDid          : clientEphemeralPortableDid.uri,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        callbackUrl        : callbackUrl,
      };
      connectRequest = await EnboxConnectProtocol.createConnectRequest(options);

      // spy send request
      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        reply      : { status: { code: 500, detail: 'Internal Server Error' } },
        messageCid : ''
      });

      // return without any entries
      const _processDwnRequestStub = sinon
        .stub(testHarness.agent, 'processDwnRequest')
        .resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' } } });

      try {
        // call submitAuthResponse
        await EnboxConnectProtocol.submitConnectResponse(
          providerIdentity.did.uri,
          connectRequest,
          randomPin,
          testHarness.agent
        );

        throw new Error('should have thrown an error');
      } catch (error: any) {
        expect(error.message).toBe('Could not send protocol: Internal Server Error');
        expect(sendRequestSpy.callCount).toBe(1);
      }
    });

    it('should fail if the send request fails for existing protocol', async () => {
      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const options = {
        appName            : 'Sample App',
        clientDid          : clientEphemeralPortableDid.uri,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        callbackUrl        : callbackUrl,
      };
      connectRequest = await EnboxConnectProtocol.createConnectRequest(options);

      // stub the processDwnRequest method to return a protocol entry
      const protocolMessage = {} as DwnMessage[DwnInterface.ProtocolsConfigure];

      // spy send request
      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        reply      : { status: { code: 500, detail: 'Internal Server Error' } },
        messageCid : ''
      });

      // mock returning the protocol entry
      const processDwnRequestStub = sinon
        .stub(testHarness.agent, 'processDwnRequest')
        .resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' }, entries: [ protocolMessage ] } });

      try {
        // call submitAuthResponse
        await EnboxConnectProtocol.submitConnectResponse(
          providerIdentity.did.uri,
          connectRequest,
          randomPin,
          testHarness.agent
        );

        throw new Error('should have thrown an error');
      } catch (error: any) {
        expect(error.message).toBe('Could not send protocol: Internal Server Error');
        expect(processDwnRequestStub.callCount).toBe(1);
        expect(sendRequestSpy.callCount).toBe(1);
      }
    });

    it('should throw if protocol could not be fetched at all', async () => {
      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const options = {
        appName            : 'Sample App',
        clientDid          : clientEphemeralPortableDid.uri,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        callbackUrl        : callbackUrl,
      };
      connectRequest = await EnboxConnectProtocol.createConnectRequest(options);

      // spy send request
      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        reply      : { status: { code: 500, detail: 'Internal Server Error' } },
        messageCid : ''
      });

      // mock returning the protocol entry
      const processDwnRequestStub = sinon
        .stub(testHarness.agent, 'processDwnRequest')
        .resolves({ messageCid: '', reply: { status: { code: 500, detail: 'Some Error' }, } });

      try {
        // call submitAuthResponse
        await EnboxConnectProtocol.submitConnectResponse(
          providerIdentity.did.uri,
          connectRequest,
          randomPin,
          testHarness.agent
        );

        throw new Error('should have thrown an error');
      } catch (error: any) {
        expect(error.message).toBe('Could not fetch protocol: Some Error');
        expect(processDwnRequestStub.callCount).toBe(1);
        expect(sendRequestSpy.callCount).toBe(0);
      }
    });

    it('should pass encryption: true when configuring a protocol with encryptionRequired types', async () => {
      // scenario: the wallet gets a request for a protocol that has encryptionRequired types
      // prepareProtocol should detect this and pass encryption: true to the sendDwnRequest

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

      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      // Stub per-grant revocation createGrant calls
      sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
        grant   : {} as any,
        message : { recordId: 'mock-revocation-grant-id' } as any,
      });
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const options = {
        appName            : 'Sample App',
        clientDid          : clientEphemeralPortableDid.uri,
        permissionRequests : [{ protocolDefinition: encryptedProtocol, permissionScopes: encryptedScopes }],
        callbackUrl        : callbackUrl,
      };
      connectRequest = await EnboxConnectProtocol.createConnectRequest(options);

      // spy send request
      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });

      sinon.stub(testHarness.agent, 'processDwnRequest')
        .resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' }, entries: [] } });

      await EnboxConnectProtocol.submitConnectResponse(
        providerIdentity.did.uri,
        connectRequest,
        randomPin,
        testHarness.agent
      );

      // Verify that sendDwnRequest was called with encryption: true for the ProtocolsConfigure
      const configureCall = sendRequestSpy.getCalls().find(
        (call) => call.args[0].messageType === DwnInterface.ProtocolsConfigure
      );
      expect(configureCall).toBeDefined();
      expect((configureCall!.args[0] as any).encryption).toBe(true);
    });

    it('should abort the connect flow when encrypted protocol has contextId-scoped read', async () => {
      const encryptedProtocol: DwnProtocolDefinition = {
        protocol  : 'http://encrypted-abort-ctx.xyz',
        published : true,
        types     : {
          secret: {
            schema             : 'http://encrypted-abort-ctx.xyz/schema/secret',
            dataFormats        : ['application/json'],
            encryptionRequired : true,
          },
        },
        structure: { secret: {} },
      };

      const contextScopedScopes: RecordsPermissionScope[] = [{
        interface : 'Records' as any,
        method    : 'Read' as any,
        protocol  : 'http://encrypted-abort-ctx.xyz',
        contextId : 'some-context-id',
      }];

      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });
      connectRequest = await EnboxConnectProtocol.createConnectRequest({
        appName            : 'Sample App',
        clientDid          : clientEphemeralPortableDid.uri,
        permissionRequests : [{ protocolDefinition: encryptedProtocol, permissionScopes: contextScopedScopes }],
        callbackUrl        : callbackUrl,
      });

      sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });
      sinon.stub(testHarness.agent, 'processDwnRequest')
        .resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' }, entries: [{}] as any } });

      await expect(
        EnboxConnectProtocol.submitConnectResponse(
          providerIdentity.did.uri, connectRequest, randomPin, testHarness.agent,
        )
      ).rejects.toThrow('contextId is not supported');
    });

    it('should abort the connect flow for mixed single-party + multi-party encrypted protocol', async () => {
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

      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });
      connectRequest = await EnboxConnectProtocol.createConnectRequest({
        appName            : 'Sample App',
        clientDid          : clientEphemeralPortableDid.uri,
        permissionRequests : [{ protocolDefinition: mixedProtocol, permissionScopes: readScopes }],
        callbackUrl        : callbackUrl,
      });

      sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });
      sinon.stub(testHarness.agent, 'processDwnRequest')
        .resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' }, entries: [{}] as any } });

      await expect(
        EnboxConnectProtocol.submitConnectResponse(
          providerIdentity.did.uri, connectRequest, randomPin, testHarness.agent,
        )
      ).rejects.toThrow('mixed single-party');
    });

    it('should throw if a grant that is included in the request does not match the protocol definition', async () => {
      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const mismatchedScopes = [...permissionScopes];
      mismatchedScopes[0].protocol = 'http://profile-protocol.xyz/other';

      const options = {
        appName            : 'Sample App',
        clientDid          : clientEphemeralPortableDid.uri,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        callbackUrl        : callbackUrl,
      };
      connectRequest = await EnboxConnectProtocol.createConnectRequest(options);

      try {
        // call submitAuthResponse
        await EnboxConnectProtocol.submitConnectResponse(
          providerIdentity.did.uri,
          connectRequest,
          randomPin,
          testHarness.agent
        );

        throw new Error('should have thrown an error');
      } catch (error: any) {
        expect(error.message).toBe('All permission scopes must match the protocol URI they are provided with.');
      }
    });
  });

  // NOTE: `createPermissionRequestForProtocol` tests were moved to
  // @enbox/auth (wallet-connect-client.spec.ts) since the function
  // now lives in that package.
});
