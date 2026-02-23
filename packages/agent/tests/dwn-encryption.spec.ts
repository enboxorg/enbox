import type { DerivedPrivateJwk, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';
import { ContentEncryptionAlgorithm, KeyDerivationScheme } from '@enbox/dwn-sdk-js';

import {
  buildContextKeyDecrypter,
  buildEncryptionInput,
  buildKmsDecryptCallback,
  encryptAndComputeCid,
  getEncryptionKeyDeriver,
  getEncryptionKeyInfo,
  getKeyDecrypter,
  ivLength,
  maybeDecryptReply,
  resolveKeyDecrypter,
} from '../src/dwn-encryption.js';

describe('dwn-encryption', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('ivLength', () => {
    it('should return 24 for XC20P', () => {
      expect(ivLength(ContentEncryptionAlgorithm.XC20P)).toBe(24);
    });

    it('should return 12 for A256GCM', () => {
      expect(ivLength(ContentEncryptionAlgorithm.A256GCM)).toBe(12);
    });
  });

  describe('buildEncryptionInput', () => {
    it('should build an encryption input object', () => {
      const dek = new Uint8Array(32);
      const iv = new Uint8Array(12);
      const publicKeyId = 'did:example:alice#enc';
      const publicKey = { kty: 'OKP', crv: 'X25519', x: 'mock-x' } as any;

      const result = buildEncryptionInput(
        dek, iv, publicKeyId, publicKey, KeyDerivationScheme.ProtocolPath,
      );

      expect(result.initializationVector).toBe(iv);
      expect(result.key).toBe(dek);
      expect(result.keyEncryptionInputs).toHaveLength(1);
      expect(result.keyEncryptionInputs[0].publicKeyId).toBe(publicKeyId);
      expect(result.keyEncryptionInputs[0].publicKey).toBe(publicKey);
      expect(result.keyEncryptionInputs[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    });

    it('should support ProtocolContext derivation scheme', () => {
      const result = buildEncryptionInput(
        new Uint8Array(32), new Uint8Array(12),
        'key-id', { kty: 'OKP', crv: 'X25519', x: 'x' } as any,
        KeyDerivationScheme.ProtocolContext,
      );
      expect(result.keyEncryptionInputs[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolContext);
    });
  });

  describe('encryptAndComputeCid', () => {
    it('should encrypt plaintext and return encrypted data with CID', async () => {
      const plaintext = new TextEncoder().encode('hello world');
      const dek = crypto.getRandomValues(new Uint8Array(32));
      const iv = crypto.getRandomValues(new Uint8Array(12));

      const result = await encryptAndComputeCid(plaintext, dek, iv);

      expect(result.encryptedBytes).toBeInstanceOf(Uint8Array);
      expect(result.encryptedBytes.length).toBeGreaterThan(0);
      expect(typeof result.dataCid).toBe('string');
      expect(result.dataCid.length).toBeGreaterThan(0);
      expect(result.dataSize).toBe(result.encryptedBytes.length);
      expect(result.authenticationTag).toBeInstanceOf(Uint8Array);
    });
  });

  describe('buildKmsDecryptCallback', () => {
    it('should return a KeyDecrypter with correct rootKeyId and derivationScheme', () => {
      const mockAgent = {
        keyManager: {
          jweKeyUnwrap: sinon.stub().resolves(new Uint8Array(32)),
        },
      } as any;

      const result = buildKmsDecryptCallback(
        mockAgent, 'root-key-id', 'key-uri', KeyDerivationScheme.ProtocolPath,
      );

      expect(result.rootKeyId).toBe('root-key-id');
      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(typeof result.decrypt).toBe('function');
    });

    it('should call keyManager.jweKeyUnwrap when decrypt is called', async () => {
      const jweKeyUnwrapStub = sinon.stub().resolves(new Uint8Array(32));
      const mockAgent = {
        keyManager: { jweKeyUnwrap: jweKeyUnwrapStub },
      } as any;

      const decrypter = buildKmsDecryptCallback(
        mockAgent, 'root-key-id', 'key-uri', KeyDerivationScheme.ProtocolContext,
      );

      const mockPayload = {
        encryptedKey       : new Uint8Array(48),
        ephemeralPublicKey : { kty: 'OKP', crv: 'X25519', x: 'mock-x' } as any,
      };

      await decrypter.decrypt(['path', 'to', 'key'], mockPayload);

      expect(jweKeyUnwrapStub.calledOnce).toBe(true);
      expect(jweKeyUnwrapStub.firstCall.args[0]).toEqual({
        keyUri             : 'key-uri',
        derivationPath     : ['path', 'to', 'key'],
        encryptedKey       : mockPayload.encryptedKey,
        ephemeralPublicKey : mockPayload.ephemeralPublicKey,
      });
    });
  });

  describe('buildContextKeyDecrypter', () => {
    it('should return a KeyDecrypter with correct rootKeyId and derivationScheme', () => {
      const contextKey: DerivedPrivateJwk = {
        rootKeyId         : 'ctx-root-key',
        derivationScheme  : KeyDerivationScheme.ProtocolContext,
        derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'x', d: 'd' } as any,
      };

      const result = buildContextKeyDecrypter(contextKey);

      expect(result.rootKeyId).toBe('ctx-root-key');
      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolContext);
      expect(typeof result.decrypt).toBe('function');
    });
  });

  describe('maybeDecryptReply', () => {
    it('should return immediately when request has no encryption flag', async () => {
      const request = { author: 'did:example:alice', target: 'did:example:alice' } as any;
      const reply = {} as any;

      // Should not throw and should return without doing anything.
      await maybeDecryptReply(request, reply, {} as any, { get: sinon.stub(), set: sinon.stub() }, sinon.stub());
    });

    it('should return immediately when encryption is false', async () => {
      const request = { author: 'did:example:alice', target: 'did:example:alice', encryption: false } as any;
      const reply = {} as any;

      await maybeDecryptReply(request, reply, {} as any, { get: sinon.stub(), set: sinon.stub() }, sinon.stub());
    });

    it('should throw wrapped error when RecordsRead decryption fails', async () => {
      const dwnSdk = await import('@enbox/dwn-sdk-js');
      sinon.stub(dwnSdk.Records, 'decrypt').rejects(new Error('bad cipher'));

      const mockAgent = {
        did: {
          resolve: sinon.stub().resolves({
            didDocument: {
              id                 : 'did:example:alice',
              keyAgreement       : ['#enc'],
              verificationMethod : [{
                id           : 'did:example:alice#enc',
                type         : 'JsonWebKey2020',
                controller   : 'did:example:alice',
                publicKeyJwk : { kty: 'OKP', crv: 'X25519', x: 'AAAA' },
              }],
            },
            didResolutionMetadata: {},
          }),
        },
        keyManager: {
          getKeyUri    : sinon.stub().resolves('key-uri-1'),
          jweKeyUnwrap : sinon.stub(),
        },
      } as any;

      const request = {
        author      : 'did:example:alice',
        target      : 'did:example:alice',
        encryption  : true,
        messageType : 'RecordsRead',
      } as any;

      const reply = {
        status : { code: 200 },
        entry  : {
          recordsWrite: {
            recordId   : 'rec-fail-read',
            descriptor : { protocol: 'https://example.com/proto' },
            encryption : {
              recipients: [{
                header: {
                  derivationScheme : KeyDerivationScheme.ProtocolPath,
                  kid              : 'did:example:alice#enc',
                },
              }],
            },
          },
          data: new ReadableStream(),
        },
      } as any;

      await expect(
        maybeDecryptReply(
          request, reply, mockAgent,
          { get: sinon.stub().returns(undefined), set: sinon.stub() },
          sinon.stub(),
        )
      ).rejects.toThrow('AgentDwnApi: Failed to decrypt record \'rec-fail-read\'');
    });

    it('should throw wrapped error when RecordsQuery entry decryption fails', async () => {
      const dwnSdk = await import('@enbox/dwn-sdk-js');
      sinon.stub(dwnSdk.Records, 'decrypt').rejects(new Error('bad cipher'));

      const mockAgent = {
        did: {
          resolve: sinon.stub().resolves({
            didDocument: {
              id                 : 'did:example:alice',
              keyAgreement       : ['#enc'],
              verificationMethod : [{
                id           : 'did:example:alice#enc',
                type         : 'JsonWebKey2020',
                controller   : 'did:example:alice',
                publicKeyJwk : { kty: 'OKP', crv: 'X25519', x: 'AAAA' },
              }],
            },
            didResolutionMetadata: {},
          }),
        },
        keyManager: {
          getKeyUri    : sinon.stub().resolves('key-uri-1'),
          jweKeyUnwrap : sinon.stub(),
        },
      } as any;

      const request = {
        author      : 'did:example:alice',
        target      : 'did:example:alice',
        encryption  : true,
        messageType : 'RecordsQuery',
      } as any;

      const reply = {
        status  : { code: 200 },
        entries : [{
          recordId    : 'rec-fail-query',
          encodedData : 'AAAA', // base64url-encoded
          descriptor  : { protocol: 'https://example.com/proto' },
          encryption  : {
            recipients: [{
              header: {
                derivationScheme : KeyDerivationScheme.ProtocolPath,
                kid              : 'did:example:alice#enc',
              },
            }],
          },
        }],
      } as any;

      await expect(
        maybeDecryptReply(
          request, reply, mockAgent,
          { get: sinon.stub().returns(undefined), set: sinon.stub() },
          sinon.stub(),
        )
      ).rejects.toThrow('AgentDwnApi: Failed to decrypt record \'rec-fail-query\'');
    });
  });

  describe('getEncryptionKeyInfo', () => {
    it('should throw when DID resolution fails', async () => {
      const mockAgent = {
        did: {
          resolve: sinon.stub().resolves({
            didDocument           : undefined,
            didResolutionMetadata : { error: 'notFound' },
          }),
        },
      } as any;

      await expect(
        getEncryptionKeyInfo(mockAgent, 'did:example:missing')
      ).rejects.toThrow('Failed to resolve DID');
    });

    it('should throw when DID has no keyAgreement', async () => {
      const mockAgent = {
        did: {
          resolve: sinon.stub().resolves({
            didDocument: {
              id                 : 'did:example:alice',
              verificationMethod : [],
            },
            didResolutionMetadata: {},
          }),
        },
      } as any;

      await expect(
        getEncryptionKeyInfo(mockAgent, 'did:example:alice')
      ).rejects.toThrow('does not have a keyAgreement');
    });

    it('should throw when keyAgreement has no publicKeyJwk', async () => {
      const mockAgent = {
        did: {
          resolve: sinon.stub().resolves({
            didDocument: {
              id                 : 'did:example:alice',
              keyAgreement       : ['did:example:alice#enc'],
              verificationMethod : [{
                id         : 'did:example:alice#enc',
                type       : 'JsonWebKey2020',
                controller : 'did:example:alice',
                // no publicKeyJwk
              }],
            },
            didResolutionMetadata: {},
          }),
        },
      } as any;

      await expect(
        getEncryptionKeyInfo(mockAgent, 'did:example:alice')
      ).rejects.toThrow('does not contain a public key in JWK format');
    });

    it('should throw when keyAgreement key is not X25519', async () => {
      const mockAgent = {
        did: {
          resolve: sinon.stub().resolves({
            didDocument: {
              id                 : 'did:example:alice',
              keyAgreement       : ['#enc'],
              verificationMethod : [{
                id           : 'did:example:alice#enc',
                type         : 'JsonWebKey2020',
                controller   : 'did:example:alice',
                publicKeyJwk : { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
              }],
            },
            didResolutionMetadata: {},
          }),
        },
      } as any;

      await expect(
        getEncryptionKeyInfo(mockAgent, 'did:example:alice')
      ).rejects.toThrow('requires \'X25519\'');
    });

    it('should resolve inline keyAgreement (non-string ref)', async () => {
      const mockAgent = {
        did: {
          resolve: sinon.stub().resolves({
            didDocument: {
              id           : 'did:example:alice',
              keyAgreement : [{
                id           : 'did:example:alice#enc',
                type         : 'JsonWebKey2020',
                controller   : 'did:example:alice',
                publicKeyJwk : { kty: 'OKP', crv: 'X25519', x: 'AAAA' },
              }],
            },
            didResolutionMetadata: {},
          }),
        },
        keyManager: {
          getKeyUri: sinon.stub().resolves('key-uri-inline'),
        },
      } as any;

      const result = await getEncryptionKeyInfo(mockAgent, 'did:example:alice');
      expect(result.keyId).toBe('did:example:alice#enc');
      expect(result.keyUri).toBe('key-uri-inline');
      expect(result.publicKeyJwk.crv).toBe('X25519');
    });

    it('should resolve string keyAgreement ref without # fragment', async () => {
      const mockAgent = {
        did: {
          resolve: sinon.stub().resolves({
            didDocument: {
              id                 : 'did:example:alice',
              keyAgreement       : ['enc'],
              verificationMethod : [{
                id           : 'did:example:alice#enc',
                type         : 'JsonWebKey2020',
                controller   : 'did:example:alice',
                publicKeyJwk : { kty: 'OKP', crv: 'X25519', x: 'BBBB' },
              }],
            },
            didResolutionMetadata: {},
          }),
        },
        keyManager: {
          getKeyUri: sinon.stub().resolves('key-uri-string-ref'),
        },
      } as any;

      const result = await getEncryptionKeyInfo(mockAgent, 'did:example:alice');
      expect(result.keyId).toBe('did:example:alice#enc');
    });
  });

  describe('getEncryptionKeyDeriver', () => {
    it('should return an EncryptionKeyDeriver with correct structure', async () => {
      const mockAgent = {
        did: {
          resolve: sinon.stub().resolves({
            didDocument: {
              id                 : 'did:example:alice',
              keyAgreement       : ['#enc'],
              verificationMethod : [{
                id           : 'did:example:alice#enc',
                type         : 'JsonWebKey2020',
                controller   : 'did:example:alice',
                publicKeyJwk : { kty: 'OKP', crv: 'X25519', x: 'AAAA' },
              }],
            },
            didResolutionMetadata: {},
          }),
        },
        keyManager: {
          getKeyUri       : sinon.stub().resolves('key-uri-1'),
          derivePublicKey : sinon.stub().resolves({ kty: 'OKP', crv: 'X25519', x: 'derived' }),
        },
      } as any;

      const deriver = await getEncryptionKeyDeriver(mockAgent, 'did:example:alice');
      expect(deriver.rootKeyId).toBe('did:example:alice#enc');
      expect(deriver.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(typeof deriver.derivePublicKey).toBe('function');
    });
  });

  describe('getKeyDecrypter', () => {
    it('should return a KeyDecrypter with ProtocolPath derivation scheme', async () => {
      const mockAgent = {
        did: {
          resolve: sinon.stub().resolves({
            didDocument: {
              id                 : 'did:example:alice',
              keyAgreement       : ['#enc'],
              verificationMethod : [{
                id           : 'did:example:alice#enc',
                type         : 'JsonWebKey2020',
                controller   : 'did:example:alice',
                publicKeyJwk : { kty: 'OKP', crv: 'X25519', x: 'AAAA' },
              }],
            },
            didResolutionMetadata: {},
          }),
        },
        keyManager: {
          getKeyUri    : sinon.stub().resolves('key-uri-1'),
          jweKeyUnwrap : sinon.stub().resolves(new Uint8Array(32)),
        },
      } as any;

      const decrypter = await getKeyDecrypter(mockAgent, 'did:example:alice');
      expect(decrypter.rootKeyId).toBe('did:example:alice#enc');
      expect(decrypter.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    });
  });

  describe('resolveKeyDecrypter', () => {
    const makeAliceAgent = (): any => ({
      did: {
        resolve: sinon.stub().resolves({
          didDocument: {
            id                 : 'did:example:alice',
            keyAgreement       : ['#enc'],
            verificationMethod : [{
              id           : 'did:example:alice#enc',
              type         : 'JsonWebKey2020',
              controller   : 'did:example:alice',
              publicKeyJwk : { kty: 'OKP', crv: 'X25519', x: 'AAAA' },
            }],
          },
          didResolutionMetadata: {},
        }),
      },
      keyManager: {
        getKeyUri    : sinon.stub().resolves('key-uri-1'),
        jweKeyUnwrap : sinon.stub(),
      },
    });

    it('should return a ProtocolPath key decrypter when record has no context encryption', async () => {
      const mockAgent = makeAliceAgent();

      const recordsWrite = {
        recordId   : 'rec-1',
        descriptor : { protocol: 'https://example.com/proto' },
        encryption : {
          recipients: [{
            header: { derivationScheme: KeyDerivationScheme.ProtocolPath, kid: 'key-1' },
          }],
        },
      } as unknown as RecordsWriteMessage;

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, undefined,
        { get: sinon.stub().returns(undefined), set: sinon.stub() },
        sinon.stub(),
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    });

    it('should return KMS decrypter when context key matches author enc key', async () => {
      const mockAgent = makeAliceAgent();

      const recordsWrite = {
        recordId   : 'rec-ctx-1',
        contextId  : 'root-ctx/sub',
        descriptor : { protocol: 'https://proto.example.com' },
        encryption : {
          recipients: [{
            header: {
              derivationScheme : KeyDerivationScheme.ProtocolContext,
              kid              : 'did:example:alice#enc', // matches the agent's enc key
            },
          }],
        },
      } as unknown as RecordsWriteMessage;

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, undefined,
        { get: sinon.stub().returns(undefined), set: sinon.stub() },
        sinon.stub(),
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolContext);
      expect(result.rootKeyId).toBe('did:example:alice#enc');
    });

    it('should return cached context key decrypter when available', async () => {
      const mockAgent = makeAliceAgent();

      const cachedKey: DerivedPrivateJwk = {
        rootKeyId         : 'cached-root',
        derivationScheme  : KeyDerivationScheme.ProtocolContext,
        derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'x', d: 'd' } as any,
      };
      const cache = {
        get : sinon.stub().returns(cachedKey),
        set : sinon.stub(),
      };

      const recordsWrite = {
        recordId   : 'rec-ctx-2',
        contextId  : 'root-ctx/sub',
        descriptor : { protocol: 'https://proto.example.com' },
        encryption : {
          recipients: [{
            header: {
              derivationScheme : KeyDerivationScheme.ProtocolContext,
              kid              : 'other-key', // does NOT match enc key
            },
          }],
        },
      } as unknown as RecordsWriteMessage;

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, undefined,
        cache, sinon.stub(),
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolContext);
      expect(cache.get.calledOnce).toBe(true);
    });

    it('should fetch context key locally when not cached', async () => {
      const mockAgent = makeAliceAgent();

      const contextKey: DerivedPrivateJwk = {
        rootKeyId         : 'fetched-root',
        derivationScheme  : KeyDerivationScheme.ProtocolContext,
        derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'x', d: 'd' } as any,
      };
      const fetchFn = sinon.stub().resolves(contextKey);
      const cache = {
        get : sinon.stub().returns(undefined),
        set : sinon.stub(),
      };

      const recordsWrite = {
        recordId   : 'rec-ctx-3',
        contextId  : 'root-ctx/sub',
        descriptor : { protocol: 'https://proto.example.com' },
        encryption : {
          recipients: [{
            header: {
              derivationScheme : KeyDerivationScheme.ProtocolContext,
              kid              : 'other-key',
            },
          }],
        },
      } as unknown as RecordsWriteMessage;

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, undefined,
        cache, fetchFn,
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolContext);
      expect(fetchFn.calledOnce).toBe(true);
      expect(cache.set.calledOnce).toBe(true);
    });

    it('should try remote fetch when local fetch returns undefined', async () => {
      const mockAgent = makeAliceAgent();

      const contextKey: DerivedPrivateJwk = {
        rootKeyId         : 'remote-root',
        derivationScheme  : KeyDerivationScheme.ProtocolContext,
        derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'x', d: 'd' } as any,
      };
      const fetchFn = sinon.stub()
        .onFirstCall().resolves(undefined)
        .onSecondCall().resolves(contextKey);
      const cache = {
        get : sinon.stub().returns(undefined),
        set : sinon.stub(),
      };

      const recordsWrite = {
        recordId      : 'rec-ctx-4',
        contextId     : 'root-ctx/sub',
        descriptor    : { protocol: 'https://proto.example.com' },
        authorization : {
          signature: {
            signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:example:bob#sig' })) }],
          },
        },
        encryption: {
          recipients: [{
            header: {
              derivationScheme : KeyDerivationScheme.ProtocolContext,
              kid              : 'other-key',
            },
          }],
        },
      } as unknown as RecordsWriteMessage;

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, 'did:example:bob',
        cache, fetchFn,
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolContext);
      expect(fetchFn.callCount).toBe(2);
      // Second call should use targetDid (did:example:bob) as ownerDid
      expect(fetchFn.secondCall.args[0].ownerDid).toBe('did:example:bob');
    });

    it('should throw when no context key found locally or remotely', async () => {
      const mockAgent = makeAliceAgent();

      const fetchFn = sinon.stub().resolves(undefined);
      const cache = {
        get : sinon.stub().returns(undefined),
        set : sinon.stub(),
      };

      const recordsWrite = {
        recordId      : 'rec-ctx-fail',
        contextId     : 'root-ctx/sub',
        descriptor    : { protocol: 'https://proto.example.com' },
        authorization : {
          signature: {
            signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:example:bob#sig' })) }],
          },
        },
        encryption: {
          recipients: [{
            header: {
              derivationScheme : KeyDerivationScheme.ProtocolContext,
              kid              : 'other-key',
            },
          }],
        },
      } as unknown as RecordsWriteMessage;

      await expect(resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, undefined,
        cache, fetchFn,
      )).rejects.toThrow('Failed to decrypt record');
    });

    it('should use signer DID as context owner when targetDid is not provided', async () => {
      const mockAgent = makeAliceAgent();

      const contextKey: DerivedPrivateJwk = {
        rootKeyId         : 'signer-root',
        derivationScheme  : KeyDerivationScheme.ProtocolContext,
        derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'x', d: 'd' } as any,
      };
      const fetchFn = sinon.stub()
        .onFirstCall().resolves(undefined)
        .onSecondCall().resolves(contextKey);
      const cache = {
        get : sinon.stub().returns(undefined),
        set : sinon.stub(),
      };

      const recordsWrite = {
        recordId      : 'rec-ctx-signer',
        contextId     : 'root-ctx/sub',
        descriptor    : { protocol: 'https://proto.example.com' },
        authorization : {
          signature: {
            signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:example:signer#sig' })) }],
          },
        },
        encryption: {
          recipients: [{
            header: {
              derivationScheme : KeyDerivationScheme.ProtocolContext,
              kid              : 'other-key',
            },
          }],
        },
      } as unknown as RecordsWriteMessage;

      await resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, undefined,
        cache, fetchFn,
      );

      // When targetDid is undefined, falls back to Jws.getSignerDid
      expect(fetchFn.callCount).toBe(2);
    });
  });
});
