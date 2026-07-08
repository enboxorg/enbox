import sinon from 'sinon';
import { UniversalResolver } from '@enbox/dids';

import type { JwkParamsOkpPublic } from '@enbox/crypto';

import { ed25519 } from '../../../src/jose/algorithms/signing/ed25519.js';
import { Encoder } from '../../../src/utils/encoder.js';
import { GeneralJwsBuilder } from '../../../src/jose/jws/general/builder.js';
import { GeneralJwsVerifier } from '../../../src/jose/jws/general/verifier.js';
import { Jws } from '../../../src/utils/jws.js';
import { PrivateKeySigner } from '../../../src/index.js';
import { signatureAlgorithms } from '../../../src/jose/algorithms/signing/signature-algorithms.js';
import { afterEach, describe, expect, it } from 'bun:test';
import { DwnError, DwnErrorCode } from '../../../src/core/dwn-error.js';


const { Ed25519, secp256k1 } = signatureAlgorithms;
const secp256r1 = signatureAlgorithms['P-256'];

describe('General JWS Sign/Verify', () => {
  afterEach(() => {
    // restores all fakes, stubs, spies etc. not restoring causes a memory leak.
    // more info here: https://sinonjs.org/releases/v13/general-setup/
    sinon.restore();
  });

  it('should sign and verify secp256k1 signature using a key vector correctly', async () => {
    const { privateJwk, publicJwk } = await secp256k1.generateKeyPair();
    const payloadBytes = new TextEncoder().encode('anyPayloadValue');
    const keyId = 'did:jank:alice#key1';

    const jwsBuilder = await GeneralJwsBuilder.create(payloadBytes, [new PrivateKeySigner({ privateJwk, keyId })]);
    const jws = jwsBuilder.getJws();

    const mockResolutionResult = {
      didResolutionMetadata : {},
      didDocument           : {
        verificationMethod: [{
          id           : keyId,
          type         : 'JsonWebKey2020',
          controller   : 'did:jank:alice',
          publicKeyJwk : publicJwk
        }]
      },
      didDocumentMetadata: {}
    };

    const resolverStub = sinon.createStubInstance(UniversalResolver, {
      // @ts-ignore
      resolve: sinon.stub().withArgs('did:jank:alice').resolves(mockResolutionResult),
    });

    const verificationResult = await GeneralJwsVerifier.verifySignatures(jws, resolverStub);
    expect(verificationResult.signers).toHaveLength(1);
    expect(verificationResult.signers).toContain('did:jank:alice');
  });

  it('should sign and verify secp256r1 signature using a key vector correctly', async () => {
    const { privateJwk, publicJwk } = await secp256r1.generateKeyPair();
    const payloadBytes = new TextEncoder().encode('anyPayloadValue');
    const keyId = 'did:jank:alice#key1';

    const jwsBuilder = await GeneralJwsBuilder.create(payloadBytes, [
      new PrivateKeySigner({ privateJwk, keyId }),
    ]);
    const jws = jwsBuilder.getJws();

    const mockResolutionResult = {
      didResolutionMetadata : {},
      didDocument           : {
        verificationMethod: [
          {
            id           : keyId,
            type         : 'JsonWebKey2020',
            controller   : 'did:jank:alice',
            publicKeyJwk : publicJwk,
          },
        ],
      },
      didDocumentMetadata: {},
    };

    const resolverStub = sinon.createStubInstance(UniversalResolver, {
      // @ts-ignore
      resolve: sinon
        .stub()
        .withArgs('did:jank:alice')
        .resolves(mockResolutionResult),
    });

    const verificationResult = await GeneralJwsVerifier.verifySignatures(
      jws,
      resolverStub
    );
    expect(verificationResult.signers).toHaveLength(1);
    expect(verificationResult.signers).toContain('did:jank:alice');
  });

  it('should sign and verify ed25519 signature using a key vector correctly', async () => {
    const { privateJwk, publicJwk } = await Ed25519.generateKeyPair();
    const payloadBytes = new TextEncoder().encode('anyPayloadValue');
    const keyId = 'did:jank:alice#key1';

    const jwsBuilder = await GeneralJwsBuilder.create(payloadBytes, [new PrivateKeySigner({ privateJwk, keyId })]);
    const jws = jwsBuilder.getJws();

    const mockResolutionResult = {
      didResolutionMetadata : {},
      didDocument           : {
        verificationMethod: [{
          id           : 'did:jank:alice#key1',
          type         : 'JsonWebKey2020',
          controller   : 'did:jank:alice',
          publicKeyJwk : publicJwk
        }]
      },
      didDocumentMetadata: {}
    };

    const resolverStub = sinon.createStubInstance(UniversalResolver, {
      // @ts-ignore
      resolve: sinon.stub().withArgs('did:jank:alice').resolves(mockResolutionResult)
    });

    const verificationResult = await GeneralJwsVerifier.verifySignatures(jws, resolverStub);
    expect(verificationResult.signers).toHaveLength(1);
    expect(verificationResult.signers).toContain('did:jank:alice');
  });

  it('should throw an error for invalid Ed25519 JWK', async () => {
    const invalidJwk = {
      kty : 'RSA', // Invalid key type
      crv : 'Ed25519',
      d   : 'invalid-private-key'
    };

    const content = new TextEncoder().encode('anyPayloadValue');

    try {
      await ed25519.sign(content, invalidJwk as any);
      throw new Error('Expected an error to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DwnError);
      expect((error as DwnError).code).toBe(DwnErrorCode.Ed25519InvalidJwk);
      expect((error as DwnError).message).toContain('invalid jwk. kty MUST be OKP. crv MUST be Ed25519');
    }
  });

  it('should convert public key bytes to JWK', async () => {
    const { publicJwk } = await ed25519.generateKeyPair();
    const publicKeyBytes = Encoder.base64UrlToBytes((publicJwk as JwkParamsOkpPublic).x);

    const convertedJwk = await ed25519.publicKeyToJwk(publicKeyBytes);

    expect(convertedJwk).toEqual(publicJwk);
  });

  it('should support multiple signatures using different key types', async () => {
    const secp256k1Keys = await secp256k1.generateKeyPair();
    const ed25519Keys = await Ed25519.generateKeyPair();

    const alice = {
      did                  : 'did:jank:alice',
      privateJwk           : secp256k1Keys.privateJwk,
      jwkPublic            : secp256k1Keys.publicJwk,
      keyId                : 'did:jank:alice#key1',
      mockResolutionResult : {
        didResolutionMetadata : {},
        didDocument           : {
          verificationMethod: [{
            id           : 'did:jank:alice#key1',
            type         : 'JsonWebKey2020',
            controller   : 'did:jank:alice',
            publicKeyJwk : secp256k1Keys.publicJwk
          }]
        },
        didDocumentMetadata: {}
      }
    };

    const bob = {
      did                  : 'did:jank:bob',
      privateJwk           : ed25519Keys.privateJwk,
      jwkPublic            : ed25519Keys.publicJwk,
      keyId                : 'did:jank:bob#key1',
      mockResolutionResult : {
        didResolutionMetadata : {},
        didDocument           : {
          verificationMethod: [{
            id           : 'did:jank:bob#key1',
            type         : 'JsonWebKey2020',
            controller   : 'did:jank:bob',
            publicKeyJwk : ed25519Keys.publicJwk,
          }]
        },
        didDocumentMetadata: {}
      }
    };

    const signers = [
      new PrivateKeySigner({ privateJwk: alice.privateJwk, keyId: alice.keyId }),
      new PrivateKeySigner({ privateJwk: bob.privateJwk, keyId: bob.keyId })
    ];

    const payloadBytes = new TextEncoder().encode('anyPayloadValue');
    const jwsBuilder = await GeneralJwsBuilder.create(payloadBytes, signers);
    const jws = jwsBuilder.getJws();

    const resolveStub = sinon.stub();
    resolveStub.withArgs('did:jank:alice').resolves(alice.mockResolutionResult);
    resolveStub.withArgs('did:jank:bob').resolves(bob.mockResolutionResult);

    const resolverStub = sinon.createStubInstance(UniversalResolver, {
      // @ts-ignore
      resolve: resolveStub
    });

    const verificationResult = await GeneralJwsVerifier.verifySignatures(jws, resolverStub);
    expect(verificationResult.signers).toHaveLength(2);
    expect(verificationResult.signers).toContain(alice.did);
    expect(verificationResult.signers).toContain(bob.did);
  });

  it('should not verify the same signature more than once', async () => {
    // scenario: include two signatures in the JWS,
    // repeated calls to verifySignature should only verify each of the signature once,
    // resulting total of 2 calls to `Jws.verifySignature()` and 2 calls to cache the results.
    const { privateJwk: privateJwkEd25519, publicJwk: publicJwkEd25519 } = await Ed25519.generateKeyPair();
    const { privateJwk: privateJwkSecp256k1, publicJwk: publicJwkSecp256k1 } = await secp256k1.generateKeyPair();
    const payloadBytes = new TextEncoder().encode('anyPayloadValue');
    const keyId1 = 'did:jank:alice#key1';
    const keyId2 = 'did:jank:alice#key2';

    const jwsBuilder = await GeneralJwsBuilder.create(
      payloadBytes,
      [
        new PrivateKeySigner({ privateJwk: privateJwkEd25519, keyId: keyId1 }),
        new PrivateKeySigner({ privateJwk: privateJwkSecp256k1, keyId: keyId2 })
      ]
    );
    const jws = jwsBuilder.getJws();

    const mockResolutionResult = {
      didResolutionMetadata : {},
      didDocument           : {
        verificationMethod: [{
          id           : 'did:jank:alice#key1',
          type         : 'JsonWebKey2020',
          controller   : 'did:jank:alice',
          publicKeyJwk : publicJwkEd25519
        }, {
          id           : 'did:jank:alice#key2',
          type         : 'JsonWebKey2020',
          controller   : 'did:jank:alice',
          publicKeyJwk : publicJwkSecp256k1
        }]
      },
      didDocumentMetadata: {}
    };

    const resolverStub = sinon.createStubInstance(UniversalResolver, {
      // @ts-ignore
      resolve: sinon.stub().withArgs('did:jank:alice').resolves(mockResolutionResult)
    });

    const verifySignatureSpy = sinon.spy(Jws, 'verifySignature');
    const cacheSetSpy = sinon.spy((GeneralJwsVerifier as any).singleton.cache, 'set');

    // intentionally calling verifySignatures() multiple times on the same JWS
    await GeneralJwsVerifier.verifySignatures(jws, resolverStub);
    await GeneralJwsVerifier.verifySignatures(jws, resolverStub);
    await GeneralJwsVerifier.verifySignatures(jws, resolverStub);

    sinon.assert.calledTwice(verifySignatureSpy);
    sinon.assert.calledTwice(cacheSetSpy);
  });

  describe('GeneralJwsVerifierGetPublicKeyNotFound diagnostics', () => {
    const buildJwsForKid = async (kid: string): Promise<{ jws: any; }> => {
      const { privateJwk } = await Ed25519.generateKeyPair();
      const payloadBytes = new TextEncoder().encode('anyPayloadValue');
      const jwsBuilder = await GeneralJwsBuilder.create(payloadBytes, [new PrivateKeySigner({ privateJwk, keyId: kid })]);
      return { jws: jwsBuilder.getJws() };
    };

    it('should include the resolution error code and message when the DID cannot be resolved', async () => {
      const kid = 'did:dht:absent#0';
      const { jws } = await buildJwsForKid(kid);

      const resolverStub = sinon.createStubInstance(UniversalResolver, {
        // @ts-ignore
        resolve: sinon.stub().resolves({
          didResolutionMetadata : { error: 'notFound', errorMessage: 'BEP44 record not found' },
          didDocument           : null,
          didDocumentMetadata   : {},
        }),
      });

      let caught: DwnError | undefined;
      try {
        await GeneralJwsVerifier.verifySignatures(jws, resolverStub);
      } catch (error) {
        caught = error as DwnError;
      }

      expect(caught).toBeInstanceOf(DwnError);
      expect(caught!.code).toBe(DwnErrorCode.GeneralJwsVerifierGetPublicKeyNotFound);
      expect(caught!.message).toContain('did:dht:absent');
      expect(caught!.message).toContain(kid);
      expect(caught!.message).toContain('notFound');
      expect(caught!.message).toContain('BEP44 record not found');
    });

    it('should explain when the DID Document is missing without an explicit resolution error', async () => {
      const kid = 'did:dht:silent#0';
      const { jws } = await buildJwsForKid(kid);

      const resolverStub = sinon.createStubInstance(UniversalResolver, {
        // @ts-ignore
        resolve: sinon.stub().resolves({
          didResolutionMetadata : {},
          didDocument           : undefined,
          didDocumentMetadata   : {},
        }),
      });

      let caught: DwnError | undefined;
      try {
        await GeneralJwsVerifier.verifySignatures(jws, resolverStub);
      } catch (error) {
        caught = error as DwnError;
      }

      expect(caught).toBeInstanceOf(DwnError);
      expect(caught!.code).toBe(DwnErrorCode.GeneralJwsVerifierGetPublicKeyNotFound);
      expect(caught!.message).toContain('DID Document not found');
      expect(caught!.message).toContain('did:dht:silent');
      expect(caught!.message).toContain(kid);
    });

    it('should list the available verification method ids when the kid does not match any', async () => {
      const { privateJwk } = await Ed25519.generateKeyPair();
      const { publicJwk: otherPublicJwk } = await Ed25519.generateKeyPair();
      const payloadBytes = new TextEncoder().encode('anyPayloadValue');
      const kid = 'did:jank:alice#missing-key';
      const jwsBuilder = await GeneralJwsBuilder.create(payloadBytes, [new PrivateKeySigner({ privateJwk, keyId: kid })]);
      const jws = jwsBuilder.getJws();

      const resolverStub = sinon.createStubInstance(UniversalResolver, {
        // @ts-ignore
        resolve: sinon.stub().withArgs('did:jank:alice').resolves({
          didResolutionMetadata : {},
          didDocument           : {
            verificationMethod: [
              { id: 'did:jank:alice#sig', type: 'JsonWebKey2020', controller: 'did:jank:alice', publicKeyJwk: otherPublicJwk },
              { id: 'did:jank:alice#enc', type: 'JsonWebKey2020', controller: 'did:jank:alice', publicKeyJwk: otherPublicJwk },
            ],
          },
          didDocumentMetadata: {},
        }),
      });

      let caught: DwnError | undefined;
      try {
        await GeneralJwsVerifier.verifySignatures(jws, resolverStub);
      } catch (error) {
        caught = error as DwnError;
      }

      expect(caught).toBeInstanceOf(DwnError);
      expect(caught!.code).toBe(DwnErrorCode.GeneralJwsVerifierGetPublicKeyNotFound);
      expect(caught!.message).toContain(kid);
      expect(caught!.message).toContain('available verification methods');
      expect(caught!.message).toContain('did:jank:alice#sig');
      expect(caught!.message).toContain('did:jank:alice#enc');
    });

    it('should report when the DID Document has no verification methods', async () => {
      const kid = 'did:jank:empty#0';
      const { jws } = await buildJwsForKid(kid);

      const resolverStub = sinon.createStubInstance(UniversalResolver, {
        // @ts-ignore
        resolve: sinon.stub().withArgs('did:jank:empty').resolves({
          didResolutionMetadata : {},
          didDocument           : { verificationMethod: [] },
          didDocumentMetadata   : {},
        }),
      });

      let caught: DwnError | undefined;
      try {
        await GeneralJwsVerifier.verifySignatures(jws, resolverStub);
      } catch (error) {
        caught = error as DwnError;
      }

      expect(caught).toBeInstanceOf(DwnError);
      expect(caught!.code).toBe(DwnErrorCode.GeneralJwsVerifierGetPublicKeyNotFound);
      expect(caught!.message).toContain('has no verification methods');
      expect(caught!.message).toContain('did:jank:empty');
      expect(caught!.message).toContain(kid);
    });
  });

});
