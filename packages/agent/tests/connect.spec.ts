import type { PortableDid } from '@enbox/dids';
import type { RecordsPermissionScope } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { CryptoUtils } from '@enbox/crypto';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import { type BearerDid, DidDht, DidJwk } from '@enbox/dids';
import { Convert, logger } from '@enbox/common';

import { AgentPermissionsApi, DwnInterface, DwnPermissionGrant } from '../src/index.js';
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
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves(['https://dwn.example']);
      sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').resolves({
        status: { code: 202, detail: 'Accepted' },
      } as any);

      const results = await EnboxConnectProtocol.createPermissionGrants(
        providerIdentity.did.uri,
        delegateBearerDid,
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
        expect(grant.dateExpires).toBe(firstSession?.expiresAt);
      }
    });

    it('should bound connect session display metadata', () => {
      const session = EnboxConnectProtocol.createConnectSessionMetadata({
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

    it('should reject obsolete read-like record grant scopes', async () => {
      for (const method of ['Query', 'Subscribe', 'Count']) {
        await expect(EnboxConnectProtocol.createPermissionGrants(
          providerIdentity.did.uri,
          delegateBearerDid,
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
      await expect(EnboxConnectProtocol.createPermissionGrants(
        providerIdentity.did.uri,
        delegateBearerDid,
        testHarness.agent,
        [{
          interface : 'Protocols' as any,
          method    : 'Configure' as any,
          protocol  : 'http://profile-protocol.xyz',
        }]
      )).rejects.toThrow('Protocols.Configure cannot be delegated through connect');
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
        jwt                  : connectResponseJwt,
        encryptionKey        : sharedECDHPrivateKey,
        pin                  : randomPin,
        delegatePublicKeyJwk : delegateBearerDid.document.verificationMethod![0].publicKeyJwk!,
      });
      expect(typeof connectResponseJwe).toBe('string');
      expect(randomBytesStub.calledOnce).toBe(true);
    });

    it('should send the encrypted JWE connect response to the server', async () => {
      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      // Stub per-grant revocation createGrant calls (created inside submitConnectResponse)
      sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
        grant   : {} as any,
        message : { recordId: 'mock-revocation-grant-id', encodedData: btoa('{}') } as any,
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

  describe('JWE privacy — no kid leak (issue #890)', () => {
    it('should not include kid in the JWE protected header', async () => {
      const [protectedHeaderB64U] = connectResponseJwe.split('.');
      const header = Convert.base64Url(protectedHeaderB64U).toObject() as Record<string, unknown>;

      expect(header.kid).toBeUndefined();
    });

    it('should include an epk (ephemeral public key) in the JWE protected header', async () => {
      const [protectedHeaderB64U] = connectResponseJwe.split('.');
      const header = Convert.base64Url(protectedHeaderB64U).toObject() as Record<string, unknown>;

      expect(header.epk).toBeDefined();
      expect(typeof header.epk).toBe('object');
    });

    it('should only include minimal key material (kty, crv, x) in epk — no kid or alg', async () => {
      const [protectedHeaderB64U] = connectResponseJwe.split('.');
      const header = Convert.base64Url(protectedHeaderB64U).toObject() as Record<string, unknown>;
      const epk = header.epk as Record<string, unknown>;

      expect(Object.keys(epk).sort()).toEqual(['crv', 'kty', 'x']);
      expect(epk.kid).toBeUndefined();
      expect(epk.alg).toBeUndefined();
    });

    it('should not contain a did: URI anywhere in the relay-visible protected header', async () => {
      const [protectedHeaderB64U] = connectResponseJwe.split('.');
      const headerJson = Convert.base64Url(protectedHeaderB64U).toString();

      expect(headerJson).not.toContain('did:');
    });

    it('should decrypt correctly with epk-based key agreement (round-trip)', async () => {
      // Encrypt a fresh response with epk, then decrypt — verifies the full round-trip.
      const freshJwe = await EnboxConnectProtocol.encryptResponse({
        jwt                  : connectResponseJwt,
        encryptionKey        : sharedECDHPrivateKey,
        pin                  : randomPin,
        delegatePublicKeyJwk : delegateBearerDid.document.verificationMethod![0].publicKeyJwk!,
      });

      const decrypted = await EnboxConnectProtocol.decryptResponse(
        clientEphemeralBearerDid,
        freshJwe,
        randomPin
      );

      expect(decrypted).toBe(connectResponseJwt);
    });

    it('should decrypt correctly without a PIN (local flow)', async () => {
      const jweNoPin = await EnboxConnectProtocol.encryptResponse({
        jwt                  : connectResponseJwt,
        encryptionKey        : sharedECDHPrivateKey,
        delegatePublicKeyJwk : delegateBearerDid.document.verificationMethod![0].publicKeyJwk!,
      });

      const decrypted = await EnboxConnectProtocol.decryptResponse(
        clientEphemeralBearerDid,
        jweNoPin,
      );

      expect(decrypted).toBe(connectResponseJwt);
    });

    it('should throw when epk is missing from the protected header', async () => {
      const badHeader = { alg: 'dir', cty: 'JWT', enc: 'XC20P', typ: 'JWT' };
      const badJwe = [
        Convert.object(badHeader).toBase64Url(),
        '',
        Convert.uint8Array(new Uint8Array(24)).toBase64Url(),
        Convert.uint8Array(new Uint8Array(16)).toBase64Url(),
        Convert.uint8Array(new Uint8Array(16)).toBase64Url(),
      ].join('.');

      await expect(
        EnboxConnectProtocol.decryptResponse(clientEphemeralBearerDid, badJwe, randomPin)
      ).rejects.toThrow('missing required "epk"');
    });

    it('should throw when epk is null', async () => {
      const badHeader = { alg: 'dir', cty: 'JWT', enc: 'XC20P', typ: 'JWT', epk: null };
      const badJwe = [
        Convert.object(badHeader).toBase64Url(),
        '',
        Convert.uint8Array(new Uint8Array(24)).toBase64Url(),
        Convert.uint8Array(new Uint8Array(16)).toBase64Url(),
        Convert.uint8Array(new Uint8Array(16)).toBase64Url(),
      ].join('.');

      await expect(
        EnboxConnectProtocol.decryptResponse(clientEphemeralBearerDid, badJwe, randomPin)
      ).rejects.toThrow('missing required "epk"');
    });

    it('should throw when epk is a string instead of an object', async () => {
      const badHeader = { alg: 'dir', cty: 'JWT', enc: 'XC20P', typ: 'JWT', epk: 'did:jwk:abc' };
      const badJwe = [
        Convert.object(badHeader).toBase64Url(),
        '',
        Convert.uint8Array(new Uint8Array(24)).toBase64Url(),
        Convert.uint8Array(new Uint8Array(16)).toBase64Url(),
        Convert.uint8Array(new Uint8Array(16)).toBase64Url(),
      ].join('.');

      await expect(
        EnboxConnectProtocol.decryptResponse(clientEphemeralBearerDid, badJwe, randomPin)
      ).rejects.toThrow('missing required "epk"');
    });

    it('should throw when epk is a number', async () => {
      const badHeader = { alg: 'dir', cty: 'JWT', enc: 'XC20P', typ: 'JWT', epk: 42 };
      const badJwe = [
        Convert.object(badHeader).toBase64Url(),
        '',
        Convert.uint8Array(new Uint8Array(24)).toBase64Url(),
        Convert.uint8Array(new Uint8Array(16)).toBase64Url(),
        Convert.uint8Array(new Uint8Array(16)).toBase64Url(),
      ].join('.');

      await expect(
        EnboxConnectProtocol.decryptResponse(clientEphemeralBearerDid, badJwe, randomPin)
      ).rejects.toThrow('missing required "epk"');
    });

    it('should fail decryption when the epk is tampered with', async () => {
      // Swap the epk with a completely different key — ECDH will derive
      // a different shared secret and AEAD decryption will fail.
      const differentDid = await DidJwk.create();
      const wrongEpk = differentDid.document.verificationMethod![0].publicKeyJwk!;

      const [, ...rest] = connectResponseJwe.split('.');
      const tamperedHeader = {
        alg : 'dir',
        cty : 'JWT',
        enc : 'XC20P',
        typ : 'JWT',
        epk : { kty: wrongEpk.kty, crv: wrongEpk.crv, x: wrongEpk.x },
      };
      const tamperedJwe = [Convert.object(tamperedHeader).toBase64Url(), ...rest].join('.');

      await expect(
        EnboxConnectProtocol.decryptResponse(clientEphemeralBearerDid, tamperedJwe, randomPin)
      ).rejects.toThrow();
    });

    it('should fail decryption when a different client DID is used', async () => {
      const wrongClientDid = await DidJwk.create();

      await expect(
        EnboxConnectProtocol.decryptResponse(wrongClientDid, connectResponseJwe, randomPin)
      ).rejects.toThrow();
    });

    it('should fail decryption when ciphertext is tampered with', async () => {
      const parts = connectResponseJwe.split('.');
      // Flip a byte in the ciphertext segment.
      const ciphertextBytes = Convert.base64Url(parts[3]).toUint8Array();
      ciphertextBytes[0] ^= 0xff;
      parts[3] = Convert.uint8Array(ciphertextBytes).toBase64Url();
      const tamperedJwe = parts.join('.');

      await expect(
        EnboxConnectProtocol.decryptResponse(clientEphemeralBearerDid, tamperedJwe, randomPin)
      ).rejects.toThrow();
    });

    it('should fail when PIN was used during encryption but omitted during decryption', async () => {
      // connectResponseJwe was encrypted WITH randomPin — decrypt without it.
      await expect(
        EnboxConnectProtocol.decryptResponse(clientEphemeralBearerDid, connectResponseJwe)
      ).rejects.toThrow();
    });

    it('should fail when PIN was not used during encryption but provided during decryption', async () => {
      const jweNoPin = await EnboxConnectProtocol.encryptResponse({
        jwt                  : connectResponseJwt,
        encryptionKey        : sharedECDHPrivateKey,
        delegatePublicKeyJwk : delegateBearerDid.document.verificationMethod![0].publicKeyJwk!,
      });

      await expect(
        EnboxConnectProtocol.decryptResponse(clientEphemeralBearerDid, jweNoPin, '1234')
      ).rejects.toThrow();
    });

    it('should strip extra JWK fields (kid, alg, d) from the epk in the header', async () => {
      // Pass a JWK that has extra identifying/private fields.
      const fullJwk = {
        ...delegateBearerDid.document.verificationMethod![0].publicKeyJwk!,
        kid : 'some-identifying-kid',
        alg : 'EdDSA',
        d   : 'private-key-material-that-must-not-leak',
      };

      const jwe = await EnboxConnectProtocol.encryptResponse({
        jwt                  : connectResponseJwt,
        encryptionKey        : sharedECDHPrivateKey,
        delegatePublicKeyJwk : fullJwk,
        pin                  : randomPin,
      });

      const [headerB64U] = jwe.split('.');
      const header = Convert.base64Url(headerB64U).toObject() as Record<string, unknown>;
      const epk = header.epk as Record<string, unknown>;

      expect(Object.keys(epk).sort()).toEqual(['crv', 'kty', 'x']);
      expect(epk.kid).toBeUndefined();
      expect(epk.alg).toBeUndefined();
      expect(epk.d).toBeUndefined();

      // Should still decrypt correctly since the key material is the same.
      const decrypted = await EnboxConnectProtocol.decryptResponse(
        clientEphemeralBearerDid, jwe, randomPin
      );
      expect(decrypted).toBe(connectResponseJwt);
    });

    it('should produce non-correlatable epk values for different delegate DIDs', async () => {
      const delegate1 = await DidJwk.create();
      const delegate2 = await DidJwk.create();

      const sharedKey1 = await EnboxConnectProtocol.deriveSharedKey(
        delegate1, clientEphemeralBearerDid.document
      );
      const sharedKey2 = await EnboxConnectProtocol.deriveSharedKey(
        delegate2, clientEphemeralBearerDid.document
      );

      const jwe1 = await EnboxConnectProtocol.encryptResponse({
        jwt                  : connectResponseJwt,
        encryptionKey        : sharedKey1,
        delegatePublicKeyJwk : delegate1.document.verificationMethod![0].publicKeyJwk!,
      });
      const jwe2 = await EnboxConnectProtocol.encryptResponse({
        jwt                  : connectResponseJwt,
        encryptionKey        : sharedKey2,
        delegatePublicKeyJwk : delegate2.document.verificationMethod![0].publicKeyJwk!,
      });

      const header1 = Convert.base64Url(jwe1.split('.')[0]).toObject() as Record<string, any>;
      const header2 = Convert.base64Url(jwe2.split('.')[0]).toObject() as Record<string, any>;

      // The x coordinates must differ — each delegate has a unique key pair.
      expect(header1.epk.x).not.toBe(header2.epk.x);
    });
  });

  describe('submitConnectResponse', () => {
    it('should emit a total perf log when submission fails', async () => {
      const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });
      const request = await EnboxConnectProtocol.createConnectRequest({
        appName            : 'Sample App',
        clientDid          : clientEphemeralPortableDid.uri,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        callbackUrl,
      });
      const logStub = sinon.stub(logger, 'log');
      sinon.stub(DidJwk, 'create').rejects(new Error('delegate failed'));

      await expect(
        EnboxConnectProtocol.submitConnectResponse(
          providerIdentity.did.uri,
          request,
          randomPin,
          testHarness.agent,
        )
      ).rejects.toThrow('delegate failed');

      const logMessages = logStub.getCalls().map((call) => call.args[0]);
      expect(logMessages.some(
        (message) => message.includes('[connect.perf] delegateDid.create fail')
      )).toBe(true);
      expect(logMessages.some(
        (message) => message.includes('[connect.perf] submitConnectResponse.total fail')
      )).toBe(true);
    });

    it('should fail and log when callback POST returns a non-2xx response', async () => {
      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
        grant   : {} as any,
        message : { recordId: 'mock-revocation-grant-id', encodedData: btoa('{}') } as any,
      });
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);
      sinon.stub(testHarness.agent, 'processDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 200, detail: 'OK' }, entries: [{ descriptor: { interface: 'Protocols', method: 'Configure' } }] },
      } as any);
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves([]);
      sinon.stub(globalThis, 'fetch').resolves(new Response('server error', { status: 500 }));
      const logStub = sinon.stub(logger, 'log');
      const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });
      const request = await EnboxConnectProtocol.createConnectRequest({
        appName            : 'Sample App',
        clientDid          : clientEphemeralPortableDid.uri,
        permissionRequests : [{ protocolDefinition, permissionScopes }],
        callbackUrl,
      });

      await expect(
        EnboxConnectProtocol.submitConnectResponse(
          providerIdentity.did.uri,
          request,
          randomPin,
          testHarness.agent,
        )
      ).rejects.toThrow('Connect: callback POST failed with HTTP 500.');

      const logMessages = logStub.getCalls().map((call) => call.args[0]);
      expect(logMessages.some(
        (message) => message.includes('[connect.perf] response.callbackPost fail')
      )).toBe(true);
      expect(logMessages.some(
        (message) => message.includes('[connect.perf] submitConnectResponse.total fail')
      )).toBe(true);
    });

    it('should skip the redundant remote ProtocolsConfigure when the protocol is already installed locally', async () => {
      // Scenario: the wallet's own `prepareProtocol` (in @enbox/web-wallet) ran
      // BEFORE `submitConnectResponse` and pushed the protocol to every owner
      // DWN endpoint. The agent's internal `prepareProtocol` should detect the
      // protocol is already installed locally and short-circuit — issuing
      // exactly one local `ProtocolsQuery` and zero remote sends.
      //
      // This is the regression-prevention test for the "Authorizing…" hang:
      // a redundant per-protocol `agent.sendDwnRequest` would queue behind
      // the underlying HTTP client's 4×30 s retry budget for any unhealthy
      // endpoint, multiplying user-visible latency by `N protocols × 30 s`.

      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      // Stub per-grant revocation createGrant calls
      sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
        grant   : {} as any,
        message : { recordId: 'mock-revocation-grant-id', encodedData: btoa('{}') } as any,
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

      // Spy on both transport methods. Neither agent.sendDwnRequest nor
      // agent.rpc.sendDwnRequest should be invoked when the protocol is
      // already installed locally — that is the whole point of the fix.
      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });
      const rpcSendRequestSpy = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').resolves({
        status: { code: 202, detail: 'Accepted' }
      } as any);

      const processDwnRequestStub = sinon
        .stub(testHarness.agent, 'processDwnRequest')
        .resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' }, entries: [ protocolMessage ] } });

      // Stub fetch so the relay POST does not escape the test environment.
      sinon.stub(globalThis, 'fetch').resolves(new Response());

      // call submitAuthResponse
      await EnboxConnectProtocol.submitConnectResponse(
        providerIdentity.did.uri,
        connectRequest,
        randomPin,
        testHarness.agent
      );

      // Exactly one local read — the ProtocolsQuery — and nothing else.
      expect(processDwnRequestStub.callCount).toBe(1);
      expect(processDwnRequestStub.firstCall.args[0].messageType).toBe(DwnInterface.ProtocolsQuery);

      // No redundant remote ProtocolsConfigure send via either transport.
      expect(sendRequestSpy.callCount).toBe(0);
      expect(
        rpcSendRequestSpy.getCalls().some(
          (c) => (c.args[0]?.message as any)?.descriptor?.method === 'Configure'
        ),
      ).toBe(false);
    });

    it('should configure the protocol locally and fan out to all owner DWN endpoints when the protocol is missing locally', async () => {
      // Scenario: the agent's `prepareProtocol` runs in the safety-fallback
      // path (caller did not pre-install). It must (a) configure the protocol
      // on the LOCAL DWN via `processDwnRequest` so the agent can sign / encrypt
      // grants for it, and (b) push the configure message to every owner DWN
      // endpoint in PARALLEL via `agent.rpc.sendDwnRequest` (best-effort).
      //
      // The legacy `agent.sendDwnRequest` path — which iterated owner endpoints
      // sequentially and is the historical bottleneck — must NOT be used.

      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      // Stub per-grant revocation createGrant calls
      sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
        grant   : {} as any,
        message : { recordId: 'mock-revocation-grant-id', encodedData: btoa('{}') } as any,
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

      // Spy on both transports — only `agent.rpc.sendDwnRequest` should fire.
      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        messageCid : '',
        reply      : { status: { code: 202, detail: 'OK' } }
      });
      const rpcSendRequestSpy = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').resolves({
        status: { code: 202, detail: 'Accepted' }
      } as any);

      // Stub endpoint resolution to two URLs so we can observe parallel fan-out.
      const endpointUrls = ['https://dwn-a.example/', 'https://dwn-b.example/'];
      sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves(endpointUrls);

      // ProtocolsQuery → empty entries (missing locally) on first call;
      // local ProtocolsConfigure → 202 with a synthetic descriptor on second.
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

      // Stub fetch so the relay POST does not escape the test environment.
      sinon.stub(globalThis, 'fetch').resolves(new Response());

      await EnboxConnectProtocol.submitConnectResponse(
        providerIdentity.did.uri,
        connectRequest,
        randomPin,
        testHarness.agent
      );

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
      expect(configureSends.length).toBe(endpointUrls.length);
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

      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
        grant   : {} as any,
        message : { recordId: 'mock-revocation-grant-id', encodedData: btoa('{}') } as any,
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

      sinon.stub(globalThis, 'fetch').resolves(new Response());

      await EnboxConnectProtocol.submitConnectResponse(
        providerIdentity.did.uri,
        connectRequest,
        randomPin,
        testHarness.agent
      );

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
      // Scenario: the agent's safety-fallback path attempts to install the
      // protocol locally before fanning out remotely. If the local install
      // itself fails (non-202/409), the connect flow MUST throw — without
      // a locally installed protocol, the agent cannot sign / encrypt grants.
      // Remote endpoint failures, in contrast, are best-effort (sync delivers
      // missed copies), so they do NOT abort the connect.

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

      const sendRequestSpy = sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
        reply      : { status: { code: 500, detail: 'Internal Server Error' } },
        messageCid : ''
      });

      // ProtocolsQuery → empty (missing locally). Local ProtocolsConfigure → 500.
      const processDwnRequestStub = sinon.stub(testHarness.agent, 'processDwnRequest');
      processDwnRequestStub
        .onFirstCall()
        .resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' }, entries: [] } });
      processDwnRequestStub
        .onSecondCall()
        .resolves({ messageCid: '', reply: { status: { code: 500, detail: 'Local DWN error' } } });

      sinon.stub(globalThis, 'fetch').resolves(new Response());

      try {
        await EnboxConnectProtocol.submitConnectResponse(
          providerIdentity.did.uri,
          connectRequest,
          randomPin,
          testHarness.agent
        );

        throw new Error('should have thrown an error');
      } catch (error: any) {
        expect(error.message).toBe('Could not configure protocol locally: Local DWN error');
        // Local query + local configure = two processDwnRequest calls; no
        // legacy `agent.sendDwnRequest` calls because the new path uses the
        // RPC client directly and the failure happens before fan-out.
        expect(processDwnRequestStub.callCount).toBe(2);
        expect(sendRequestSpy.callCount).toBe(0);
      }
    });

    it('should NOT throw when remote endpoints are unhealthy after a successful local configure', async () => {
      // Scenario: the local install succeeds but every owner DWN endpoint
      // returns 5xx / aborts. The fan-out is best-effort — sync will
      // eventually deliver missing copies — so the connect must succeed.
      // This guards the "Authorizing…" hot path against a single bad
      // endpoint dragging the user into an error state.

      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
        grant   : {} as any,
        message : { recordId: 'mock-revocation-grant-id', encodedData: btoa('{}') } as any,
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
        .resolves({ messageCid: '', reply: { status: { code: 200, detail: 'OK' }, entries: [] } });
      processDwnRequestStub
        .onSecondCall()
        .resolves({
          messageCid : '',
          reply      : { status: { code: 202, detail: 'OK' } },
          message    : { descriptor: { interface: 'Protocols', method: 'Configure' } } as any,
        });

      sinon.stub(globalThis, 'fetch').resolves(new Response());

      // Must not throw — best-effort fan-out swallows individual failures.
      await EnboxConnectProtocol.submitConnectResponse(
        providerIdentity.did.uri,
        connectRequest,
        randomPin,
        testHarness.agent
      );

      // The fan-out was attempted on every endpoint despite the failures.
      const configureSends = rpcSendRequestSpy.getCalls().filter(
        (c) => (c.args[0]?.message as any)?.descriptor?.method === 'Configure',
      );
      expect(configureSends.length).toBe(2);
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

    it('should pass encryption: true to the LOCAL ProtocolsConfigure when the protocol has encryptionRequired types', async () => {
      // Scenario: the agent's safety-fallback installs a protocol whose types
      // declare `encryptionRequired: true`. The LOCAL configure (via
      // `processDwnRequest`) must carry `encryption: true` so the local DWN
      // derives and injects `$keyAgreement` keys from the owner's X25519 root.
      // The remote fan-out then re-uses the resulting raw message — no
      // `encryption` flag is needed on the per-endpoint sends.

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
        message : { recordId: 'mock-revocation-grant-id', encodedData: btoa('{}') } as any,
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

      sinon.stub(globalThis, 'fetch').resolves(new Response());

      await EnboxConnectProtocol.submitConnectResponse(
        providerIdentity.did.uri,
        connectRequest,
        randomPin,
        testHarness.agent
      );

      // Verify the LOCAL ProtocolsConfigure carried `encryption: true`.
      const configureCall = processDwnRequestStub.getCalls().find(
        (call) => call.args[0].messageType === DwnInterface.ProtocolsConfigure,
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

    it('should include protocol-wide decryption keys for mixed encrypted protocols', async () => {
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
      const grantKeyStub = sinon.stub(EnboxConnectProtocol, 'createGrantKeyRecordsForGrants').resolves([]);
      sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
        grant   : {} as any,
        message : { recordId: 'mock-revocation-grant-id', encodedData: btoa('{}') } as any,
      });
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
      processDwnRequestStub.resolves({ messageCid: '', reply: { status: { code: 202, detail: 'OK' } } });
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response());

      await EnboxConnectProtocol.submitConnectResponse(
        providerIdentity.did.uri, connectRequest, randomPin, testHarness.agent,
      );

      const callbackCall = fetchStub.getCalls().find(
        call => call.args[0] === callbackUrl
      );
      expect(callbackCall).toBeDefined();
      const options = callbackCall!.args[1] as RequestInit;
      const body = new URLSearchParams(options.body as string);
      const idToken = body.get('id_token');
      expect(typeof idToken).toBe('string');

      const responseJwt = await EnboxConnectProtocol.decryptResponse(
        clientEphemeralBearerDid,
        idToken!,
        randomPin,
      );
      const response = (await EnboxConnectProtocol.verifyJwt({
        jwt: responseJwt,
      })) as EnboxConnectResponse;

      expect(response.delegateDecryptionKeys).toHaveLength(1);
      expect(response.delegateDecryptionKeys![0].scope.kind).toBe('protocol');
      expect(grantKeyStub.calledOnce).toBe(true);
      expect(response.delegateDecryptionKeys![0].derivedPrivateKey.derivationPath).toEqual([
        'protocolPath',
        mixedProtocol.protocol,
      ]);
    });

    it('should throw if a grant that is included in the request does not match the protocol definition', async () => {
      sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
      sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
      sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

      const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'http://localhost:3000',
        endpoint : 'callback',
      });

      // Deep-clone before mutating so this test does not leak state into
      // subsequent tests in the same describe block (the spread above is a
      // shallow copy — `mismatchedScopes[0]` IS `permissionScopes[0]`).
      const mismatchedScopes = permissionScopes.map((s) => ({ ...s }));
      mismatchedScopes[0].protocol = 'http://profile-protocol.xyz/other';

      const options = {
        appName            : 'Sample App',
        clientDid          : clientEphemeralPortableDid.uri,
        // Use the deep-cloned mismatched scopes so the validation actually
        // fires regardless of whether the prior shallow-copy bug existed.
        permissionRequests : [{ protocolDefinition, permissionScopes: mismatchedScopes }],
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

        sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
        sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
          grant   : {} as any,
          message : { recordId: 'mock-revocation-grant-id', encodedData: btoa('{}') } as any,
        });
        sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
        sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

        const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
          baseURL  : 'http://localhost:3000',
          endpoint : 'callback',
        });

        connectRequest = await EnboxConnectProtocol.createConnectRequest({
          appName            : 'Sample App',
          clientDid          : clientEphemeralPortableDid.uri,
          permissionRequests : [{ protocolDefinition, permissionScopes }],
          callbackUrl        : callbackUrl,
        });

        sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget').resolves(endpointUrls);
        sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
          messageCid : '',
          reply      : { status: { code: 202, detail: 'OK' } }
        });
        const rpcSendRequestStub = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest')
          .callsFake(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, PER_SEND_DELAY_MS));
            return { status: { code: 202, detail: 'Accepted' } } as any;
          });

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

        sinon.stub(globalThis, 'fetch').resolves(new Response());

        const start = Date.now();
        await EnboxConnectProtocol.submitConnectResponse(
          providerIdentity.did.uri,
          connectRequest,
          randomPin,
          testHarness.agent,
        );
        const elapsed = Date.now() - start;

        // Sequential lower bound: 4 × 250 ms = 1000 ms. Parallel should be
        // close to 250 ms; we allow generous slack for scheduling, GC, the
        // surrounding submitConnectResponse work, and CI noise.
        expect(elapsed).toBeLessThan(700);

        const configureSends = rpcSendRequestStub.getCalls().filter(
          (c) => (c.args[0]?.message as any)?.descriptor?.method === 'Configure',
        );
        expect(configureSends.length).toBe(endpointUrls.length);
      });

      it('should attach a per-request AbortSignal with a bounded timeout to every connect-flow fan-out send', async () => {
        // The connect flow caps each `agent.rpc.sendDwnRequest` with
        // `AbortSignal.timeout(CONNECT_REQUEST_TIMEOUT_MS)` so a single
        // unhealthy endpoint cannot consume the full HTTP retry budget
        // (4 × 30 s) and stall the user-visible "Authorizing…" spinner.
        // This test asserts a signal is present on every send, that it is
        // an AbortSignal, and that it is NOT already aborted at dispatch
        // time (i.e. the budget genuinely starts when the request begins).
        sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
        sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
          grant   : {} as any,
          message : { recordId: 'mock-revocation-grant-id', encodedData: btoa('{}') } as any,
        });
        sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
        sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

        const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
          baseURL  : 'http://localhost:3000',
          endpoint : 'callback',
        });

        connectRequest = await EnboxConnectProtocol.createConnectRequest({
          appName            : 'Sample App',
          clientDid          : clientEphemeralPortableDid.uri,
          permissionRequests : [{ protocolDefinition, permissionScopes }],
          callbackUrl        : callbackUrl,
        });

        sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget')
          .resolves(['https://dwn-a.example/', 'https://dwn-b.example/']);
        sinon.stub(testHarness.agent, 'sendDwnRequest').resolves({
          messageCid : '',
          reply      : { status: { code: 202, detail: 'OK' } }
        });
        const rpcSendRequestSpy = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest')
          .resolves({ status: { code: 202, detail: 'Accepted' } } as any);

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

        sinon.stub(globalThis, 'fetch').resolves(new Response());

        await EnboxConnectProtocol.submitConnectResponse(
          providerIdentity.did.uri,
          connectRequest,
          randomPin,
          testHarness.agent,
        );

        // EVERY connect-flow send (configure fan-out + permission grants +
        // revocation grants) must carry a non-aborted AbortSignal so the
        // HttpDwnRpcClient enforces the per-request budget.
        expect(rpcSendRequestSpy.callCount).toBeGreaterThan(0);
        for (const call of rpcSendRequestSpy.getCalls()) {
          const signal = call.args[0]?.signal;
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(signal!.aborted).toBe(false);
        }
      });

      it('should still complete when one endpoint hangs forever \u2014 the abort signal short-circuits the retry budget', async () => {
        // Reproduces the original "Authorizing… for minutes" symptom: one
        // unhealthy endpoint that never responds. Without per-request abort
        // plumbing, `AbortSignal.timeout(...)` from the connect flow would
        // not reach the underlying fetch and the request would burn the
        // full 4 × 30 s retry budget. We simulate that by giving the second
        // endpoint a fake `sendDwnRequest` that respects the caller's
        // AbortSignal — exactly as the real HttpDwnRpcClient now does.
        sinon.stub(EnboxConnectProtocol, 'createPermissionGrants').resolves(permissionGrants as any);
        sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({
          grant   : {} as any,
          message : { recordId: 'mock-revocation-grant-id', encodedData: btoa('{}') } as any,
        });
        sinon.stub(CryptoUtils, 'randomBytes').returns(encryptionNonce);
        sinon.stub(DidJwk, 'create').resolves(delegateBearerDid);

        const callbackUrl = EnboxConnectProtocol.buildConnectUrl({
          baseURL  : 'http://localhost:3000',
          endpoint : 'callback',
        });

        connectRequest = await EnboxConnectProtocol.createConnectRequest({
          appName            : 'Sample App',
          clientDid          : clientEphemeralPortableDid.uri,
          permissionRequests : [{ protocolDefinition, permissionScopes }],
          callbackUrl        : callbackUrl,
        });

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
        sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').callsFake((req) => {
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
          return Promise.resolve({ status: { code: 202, detail: 'Accepted' } } as any);
        });

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

        sinon.stub(globalThis, 'fetch').resolves(new Response());

        const start = Date.now();
        await EnboxConnectProtocol.submitConnectResponse(
          providerIdentity.did.uri,
          connectRequest,
          randomPin,
          testHarness.agent,
        );
        const elapsed = Date.now() - start;

        // The per-request budget is 10 s. submitConnectResponse runs three
        // sequential phases that each touch every endpoint (prepareProtocol
        // fan-out, permission-grant fan-out — stubbed here, and revocation
        // fan-out), so a fully hung endpoint costs at most one budget per
        // unstubbed phase. We assert 25 s to leave generous CI slack while
        // still failing loudly on regressions that bypass the abort signal
        // (without this fix, the same scenario takes minutes).
        expect(elapsed).toBeLessThan(25_000);
      }, 60_000); // bun:test per-test timeout, kept above the assertion budget
    });
  });

  // NOTE: `createPermissionRequestForProtocol` tests were moved to
  // @enbox/auth (wallet-connect-client.spec.ts) since the function
  // now lives in that package.
});
