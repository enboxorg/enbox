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
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';
import {
  Oidc,
  type Web5ConnectAuthRequest,
  type Web5ConnectAuthResponse,
} from '../src/oidc.js';

import type { BearerIdentity, DwnMessage, DwnProtocolDefinition } from '../src/index.js';
import { DwnInterface, WalletConnect } from '../src/index.js';

describe('web5 connect', () => {

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

  let authRequest: Web5ConnectAuthRequest;
  let authRequestJwt: string;
  let authRequestJwe: string;

  let authResponse: Web5ConnectAuthResponse;
  let authResponseJwt: string;
  let authResponseJwe: string;

  let sharedECDHPrivateKey: Uint8Array;

  const authRequestEncryptionKey = CryptoUtils.randomBytes(32);
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

  describe('client authrequest phase', () => {
    // it('should create a code challenge', async () => {
    //   const result = await Oidc.generateCodeChallenge();
    //   expect(result.codeChallengeBytes).toBeInstanceOf(Uint8Array);
    //   expect(typeof result.codeChallengeBase64Url).toBe('string');
    // });

    it('should create an authrequest with the code challenge and client did', async () => {
      const _randomBytesStub = sinon
        .stub(CryptoUtils, 'randomBytes')
        .returns(authRequestEncryptionKey);

      const callbackUrl = Oidc.buildOidcUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const options = {
        displayName        : 'Sample App',
        client_id          : clientEphemeralPortableDid.uri,
        scope              : 'openid did:jwk',
        // code_challenge        : Convert.uint8Array(codeChallenge).toBase64Url(),
        // code_challenge_method : 'S256' as const,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        redirect_uri       : callbackUrl,
      };
      authRequest = await Oidc.createAuthRequest(options);
      expect(authRequest).toEqual(expect.objectContaining(options));
      expect(typeof authRequest.nonce).toBe('string');
      expect(typeof authRequest.state).toBe('string');
      expect(authRequest.redirect_uri).toBe(
        'http://localhost:3000/callback'
      );
    });

    it('should construct a signed jwt of an authrequest', async () => {
      authRequestJwt = await Oidc.signJwt({
        did  : clientEphemeralBearerDid,
        data : authRequest,
      });
      expect(typeof authRequestJwt).toBe('string');
    });

    it('should encrypt an authrequest using the code challenge', async () => {
      authRequestJwe = await Oidc.encryptAuthRequest({
        jwt           : authRequestJwt,
        encryptionKey : authRequestEncryptionKey
      });
      expect(typeof authRequestJwe).toBe('string');
      expect(authRequestJwe.split('.')).toHaveLength(5);
    });
  });

  describe('provider authresponse phase', () => {
    it('should get authrequest from server, decrypt and verify the jwt', async () => {
      const fetchStub = sinon
        .stub(globalThis, 'fetch')
        .onFirstCall()
        .resolves({
          text: sinon.stub().resolves(authRequestJwe),
        } as any);
      fetchStub.callThrough();

      const authorizeUrl = Oidc.buildOidcUrl({
        baseURL   : 'http://localhost:3000',
        endpoint  : 'authorize',
        authParam : '12345',
      });
      expect(authorizeUrl).toBe(
        'http://localhost:3000/authorize/12345.jwt'
      );

      const result = await Oidc.getAuthRequest(
        authorizeUrl,
        Convert.uint8Array(authRequestEncryptionKey).toBase64Url()
      );
      expect(result).toEqual(authRequest);
    });

    it('should create permission grants for each selected did', async () => {
      const results = await Oidc.createPermissionGrants(
        providerIdentity.did.uri,
        delegateBearerDid,
        testHarness.agent,
        permissionScopes
      );
      const scopesRequested = permissionScopes.length;
      expect(results).toHaveLength(scopesRequested);
      expect(typeof results[0]).toBe('object');
    });

    it('should create the authresponse which includes the permissionGrants, nonce, private key material', async () => {
      const options = {
        iss            : providerIdentity.did.uri,
        sub            : delegateBearerDid.uri,
        aud            : authRequest.client_id,
        nonce          : authRequest.nonce,
        delegateGrants : permissionGrants,
        delegatePortableDid,
      };
      authResponse = await Oidc.createResponseObject(options);

      expect(authResponse).toEqual(expect.objectContaining(options));
      expect(typeof authResponse.iat).toBe('number');
      expect(typeof authResponse.exp).toBe('number');
      expect(authResponse.exp - authResponse.iat).toBe(600);
    });

    it('should sign the authresponse with its provider did', async () => {
      authResponseJwt = await Oidc.signJwt({
        did  : delegateBearerDid,
        data : authResponse,
      });
      expect(typeof authResponseJwt).toBe('string');
    });

    it('should derive a valid ECDH private key for both provider and client which is identical', async () => {
      const providerECDHDerivedPrivateKey = await Oidc.deriveSharedKey(
        delegateBearerDid,
        clientEphemeralBearerDid.document
      );
      const clientECDHDerivedPrivateKey = await Oidc.deriveSharedKey(
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

    it('should encrypt the jwt authresponse to pass back to the client', async () => {
      const randomBytesStub = sinon
        .stub(CryptoUtils, 'randomBytes')
        .returns(encryptionNonce);
      authResponseJwe = await Oidc.encryptAuthResponse({
        jwt              : authResponseJwt,
        encryptionKey    : sharedECDHPrivateKey,
        randomPin,
        delegateDidKeyId : delegateBearerDid.document.verificationMethod![0].id,
      });
      expect(typeof authResponseJwe).toBe('string');
      expect(randomBytesStub.calledOnce).toBe(true);
    });

    it('should send the encrypted jwe authresponse to the server', async () => {
      sinon.stub(Oidc, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = Oidc.buildOidcUrl({
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
      await Oidc.submitAuthResponse(
        selectedDid,
        authRequest,
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
      expect(body.get('state')).toBe(authRequest.state);
      const idToken = body.get('id_token');
      expect(typeof idToken).toBe('string');
      expect(idToken!.length).toBeGreaterThan(0);
    });
  });

  describe('client pin entry final phase', () => {
    it('should get the authresponse from server and decrypt the jwe using the pin', async () => {
      const result = await Oidc.decryptAuthResponse(
        clientEphemeralBearerDid,
        authResponseJwe,
        randomPin
      );
      expect(typeof result).toBe('string');
      expect(result).toBe(authResponseJwt);
    });

    it('should fail decrypting the jwe if the wrong pin is entered', async () => {
      try {
        await Oidc.decryptAuthResponse(
          clientEphemeralBearerDid,
          authResponseJwe,
          '87383837583757835737537734783'
        );
      } catch (e: any) {
        expect(e).toBeInstanceOf(Error);
        expect(e.message).toContain('invalid tag');
      }
    });

    it('should validate the jwt and parse it into an object', async () => {
      const result = (await Oidc.verifyJwt({
        jwt: authResponseJwt,
      })) as Web5ConnectAuthResponse;
      expect(typeof result).toBe('object');
      expect(result.delegateGrants.length).toBeGreaterThan(0);
    });
  });

  describe('end to end client test', () => {
    it('should complete the whole connect flow with the correct pin', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      const onWalletUriReadySpy = sinon.spy();
      sinon.stub(DidJwk, 'create').resolves(clientEphemeralBearerDid);

      const par = {
        expires_in  : 3600000,
        request_uri : 'http://localhost:3000/connect/authorize/xyz.jwt',
      };

      const parResponse = new Response(JSON.stringify(par), {
        status  : 200,
        headers : { 'Content-type': 'application/json' },
      });

      const authResponse = new Response(authResponseJwe, {
        status  : 200,
        headers : { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      fetchStub.onFirstCall().resolves(parResponse);
      fetchStub.callThrough();
      fetchStub.onThirdCall().resolves(authResponse);
      fetchStub.callThrough();

      const results = await WalletConnect.initClient({
        displayName        : 'Sample App',
        walletUri          : 'http://localhost:3000/',
        connectServerUrl   : 'http://localhost:3000/connect',
        permissionRequests : [
          {
            protocolDefinition : {} as any,
            permissionScopes   : {} as any,
          },
        ],
        onWalletUriReady : (uri) => onWalletUriReadySpy(uri),
        validatePin      : async () => randomPin,
      });

      expect(fetchStub.firstCall.args[0]).toBe(
        'http://localhost:3000/connect/par'
      );
      expect(onWalletUriReadySpy.calledOnce).toBe(true);
      expect(onWalletUriReadySpy.firstCall.args[0]).toMatch(
        new RegExp(
          'http:\\/\\/[\\w.-]+:\\d+\\/\\?request_uri=http%3A%2F%2F[\\w.-]+%3A(\\d+|%24%7Bport%7D)%2Fconnect%2Fauthorize%2F[\\w.-]+\\.jwt&encryption_key=.+',
          'i'
        )
      );
      expect(fetchStub.thirdCall.args[0]).toMatch(
        new RegExp('^http:\\/\\/localhost:3000\\/connect\\/token\\/.+\\.jwt$')
      );

      expect(typeof results).toBe('object');
      expect(results?.delegateGrants).toBeInstanceOf(Array);
      expect(typeof results?.delegatePortableDid).toBe('object');
    });
  });

  describe('initClient — error paths', () => {
    it('should throw when signJwt returns undefined', async () => {
      sinon.stub(Oidc, 'signJwt').resolves(undefined as any);

      await expect(
        WalletConnect.initClient({
          displayName        : 'Sample App',
          walletUri          : 'http://localhost:3000/',
          connectServerUrl   : 'http://localhost:3000/connect',
          permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: {} as any }],
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        })
      ).rejects.toThrow('Unable to sign requestObject');
    });

    it('should throw when PAR response is not ok', async () => {
      sinon.stub(Oidc, 'signJwt').resolves('signed.jwt.value');
      sinon.stub(Oidc, 'encryptAuthRequest').resolves('encrypted-jwe');
      sinon.stub(globalThis, 'fetch').resolves(
        new Response('Bad Request', { status: 400, statusText: 'Bad Request' })
      );

      await expect(
        WalletConnect.initClient({
          displayName        : 'Sample App',
          walletUri          : 'http://localhost:3000/',
          connectServerUrl   : 'http://localhost:3000/connect',
          permissionRequests : [{ protocolDefinition: {} as any, permissionScopes: {} as any }],
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        })
      ).rejects.toThrow('400: Bad Request');
    });
  });

  describe('submitAuthResponse', () => {
    it('should not attempt to configure the protocol if it already exists', async () => {
      // scenario: the wallet gets a request for a protocol that it already has configured
      // the wallet should not attempt to re-configure, but instead ensure that the protocol is
      // sent to the remote DWN for the requesting client to be able to sync it down later

      sinon.stub(Oidc, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = Oidc.buildOidcUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const options = {
        displayName        : 'Sample App',
        client_id          : clientEphemeralPortableDid.uri,
        scope              : 'openid did:jwk',
        // code_challenge        : Convert.uint8Array(codeChallenge).toBase64Url(),
        // code_challenge_method : 'S256' as const,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        redirect_uri       : callbackUrl,
      };
      authRequest = await Oidc.createAuthRequest(options);

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
      await Oidc.submitAuthResponse(
        providerIdentity.did.uri,
        authRequest,
        randomPin,
        testHarness.agent
      );

      // expect the process request to only be called once for ProtocolsQuery
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

      sinon.stub(Oidc, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = Oidc.buildOidcUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const options = {
        displayName        : 'Sample App',
        client_id          : clientEphemeralPortableDid.uri,
        scope              : 'openid did:jwk',
        // code_challenge        : Convert.uint8Array(codeChallenge).toBase64Url(),
        // code_challenge_method : 'S256' as const,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        redirect_uri       : callbackUrl,
      };
      authRequest = await Oidc.createAuthRequest(options);

      // spy send request
      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });

      const processDwnRequestStub = sinon
        .stub(testHarness.agent, 'processDwnRequest')
        .resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' }, entries: [ ] } });

      // call submitAuthResponse
      await Oidc.submitAuthResponse(
        providerIdentity.did.uri,
        authRequest,
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
      await Oidc.submitAuthResponse(
        providerIdentity.did.uri,
        authRequest,
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
      sinon.stub(Oidc, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = Oidc.buildOidcUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const options = {
        displayName        : 'Sample App',
        client_id          : clientEphemeralPortableDid.uri,
        scope              : 'openid did:jwk',
        // code_challenge        : Convert.uint8Array(codeChallenge).toBase64Url(),
        // code_challenge_method : 'S256' as const,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        redirect_uri       : callbackUrl,
      };
      authRequest = await Oidc.createAuthRequest(options);

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
        await Oidc.submitAuthResponse(
          providerIdentity.did.uri,
          authRequest,
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
      sinon.stub(Oidc, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = Oidc.buildOidcUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const options = {
        displayName        : 'Sample App',
        client_id          : clientEphemeralPortableDid.uri,
        scope              : 'openid did:jwk',
        // code_challenge        : Convert.uint8Array(codeChallenge).toBase64Url(),
        // code_challenge_method : 'S256' as const,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        redirect_uri       : callbackUrl,
      };
      authRequest = await Oidc.createAuthRequest(options);

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
        await Oidc.submitAuthResponse(
          providerIdentity.did.uri,
          authRequest,
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
      sinon.stub(Oidc, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = Oidc.buildOidcUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const options = {
        displayName        : 'Sample App',
        client_id          : clientEphemeralPortableDid.uri,
        scope              : 'openid did:jwk',
        // code_challenge        : Convert.uint8Array(codeChallenge).toBase64Url(),
        // code_challenge_method : 'S256' as const,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        redirect_uri       : callbackUrl,
      };
      authRequest = await Oidc.createAuthRequest(options);

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
        await Oidc.submitAuthResponse(
          providerIdentity.did.uri,
          authRequest,
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

    it('should throw if a grant that is included in the request does not match the protocol definition', async () => {
      sinon.stub(Oidc, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = Oidc.buildOidcUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      const mismatchedScopes = [...permissionScopes];
      mismatchedScopes[0].protocol = 'http://profile-protocol.xyz/other';

      const options = {
        displayName        : 'Sample App',
        client_id          : clientEphemeralPortableDid.uri,
        scope              : 'openid did:jwk',
        // code_challenge        : Convert.uint8Array(codeChallenge).toBase64Url(),
        // code_challenge_method : 'S256' as const,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        redirect_uri       : callbackUrl,
      };
      authRequest = await Oidc.createAuthRequest(options);

      try {
        // call submitAuthResponse
        await Oidc.submitAuthResponse(
          providerIdentity.did.uri,
          authRequest,
          randomPin,
          testHarness.agent
        );

        throw new Error('should have thrown an error');
      } catch (error: any) {
        expect(error.message).toBe('All permission scopes must match the protocol uri they are provided with.');
      }
    });
  });

  describe('createPermissionRequestForProtocol', () => {
    it('should add sync permissions to all requests', async () => {
      const protocol:DwnProtocolDefinition = {
        published : true,
        protocol  : 'https://exmaple.org/protocols/social',
        types     : {
          note: {
            schema      : 'https://example.org/schemas/note',
            dataFormats : [ 'application/json', 'text/plain' ],
          }
        },
        structure: {
          note: {}
        }
      };

      const permissionRequests = WalletConnect.createPermissionRequestForProtocol({
        definition: protocol, permissions: []
      });

      expect(permissionRequests.protocolDefinition).toEqual(protocol);
      // Messages.Read (unified: covers Read, Subscribe, Sync) + Protocols.Query
      expect(permissionRequests.permissionScopes.length).toBe(2);
      const scopes = permissionRequests.permissionScopes;
      expect(scopes.find(
        scope => scope.interface === DwnInterfaceName.Messages && scope.method === DwnMethodName.Read
      )).toBeDefined();
      expect(scopes.find(
        scope => scope.interface === DwnInterfaceName.Protocols && scope.method === DwnMethodName.Query
      )).toBeDefined();
    });

    it('should add requested permissions to the request', async () => {
      const protocol:DwnProtocolDefinition = {
        published : true,
        protocol  : 'https://exmaple.org/protocols/social',
        types     : {
          note: {
            schema      : 'https://example.org/schemas/note',
            dataFormats : [ 'application/json', 'text/plain' ],
          }
        },
        structure: {
          note: {}
        }
      };

      const permissionRequests = WalletConnect.createPermissionRequestForProtocol({
        definition: protocol, permissions: ['write', 'read']
      });

      expect(permissionRequests.protocolDefinition).toEqual(protocol);

      // Messages.Read (unified) + 2 requested Records permissions + Protocols.Query
      expect(permissionRequests.permissionScopes.length).toBe(4);
      expect(permissionRequests.permissionScopes.find(
        scope => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Read
      )).toBeDefined();
      expect(permissionRequests.permissionScopes.find(
        scope => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Write
      )).toBeDefined();
    });

    it('supports requesting `read`, `write`, `delete`, `query`, `subscribe` and `configure` permissions', async () => {
      const protocol:DwnProtocolDefinition = {
        published : true,
        protocol  : 'https://exmaple.org/protocols/social',
        types     : {
          note: {
            schema      : 'https://example.org/schemas/note',
            dataFormats : [ 'application/json', 'text/plain' ],
          }
        },
        structure: {
          note: {}
        }
      };

      const permissionRequests = WalletConnect.createPermissionRequestForProtocol({
        definition: protocol, permissions: ['write', 'read', 'delete', 'query', 'subscribe', 'configure']
      });

      expect(permissionRequests.protocolDefinition).toEqual(protocol);

      // Messages.Read (unified) + 5 requested Records permissions + Protocols.Query + Protocols.Configure
      expect(permissionRequests.permissionScopes.length).toBe(8);
      const ps = permissionRequests.permissionScopes;
      expect(ps.find(
        scope => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Read
      )).toBeDefined();
      expect(ps.find(
        scope => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Write
      )).toBeDefined();
      expect(ps.find(
        scope => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Delete
      )).toBeDefined();
      expect(ps.find(
        scope => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Query
      )).toBeDefined();
      expect(ps.find(
        scope => scope.interface === DwnInterfaceName.Records && scope.method === DwnMethodName.Subscribe
      )).toBeDefined();
      expect(ps.find(
        scope => scope.interface === DwnInterfaceName.Protocols && scope.method === DwnMethodName.Query
      )).toBeDefined();
      expect(ps.find(
        scope => scope.interface === DwnInterfaceName.Protocols && scope.method === DwnMethodName.Configure
      )).toBeDefined();
    });
  });
});
