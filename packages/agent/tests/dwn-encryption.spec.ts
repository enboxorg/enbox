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
    it('should return 16 for A256CTR', () => {
      expect(ivLength(ContentEncryptionAlgorithm.A256CTR)).toBe(16);
    });
  });

  describe('buildEncryptionInput', () => {
    it('should build an encryption input object', () => {
      const dek = new Uint8Array(32);
      const iv = new Uint8Array(16);
      const keyId = 'mock-key-id';
      const publicKey = { kty: 'OKP', crv: 'X25519', x: 'mock-x' } as any;

      const result = buildEncryptionInput(
        dek, iv, keyId, publicKey, KeyDerivationScheme.ProtocolPath,
      );

      expect(result.initializationVector).toBe(iv);
      expect(result.key).toBe(dek);
      expect(result.keyEncryptionInputs).toHaveLength(1);
      expect(result.keyEncryptionInputs[0].keyId).toBe(keyId);
      expect(result.keyEncryptionInputs[0].publicKey).toBe(publicKey);
      expect(result.keyEncryptionInputs[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    });
  });

  describe('encryptAndComputeCid', () => {
    it('should encrypt plaintext and return encrypted data with CID', async () => {
      const plaintext = new TextEncoder().encode('hello world');
      const dek = crypto.getRandomValues(new Uint8Array(32));
      const iv = crypto.getRandomValues(new Uint8Array(16));

      const result = await encryptAndComputeCid(plaintext, dek, iv);

      expect(result.encryptedBytes).toBeInstanceOf(Uint8Array);
      expect(result.encryptedBytes.length).toBeGreaterThan(0);
      expect(typeof result.dataCid).toBe('string');
      expect(result.dataCid.length).toBeGreaterThan(0);
      expect(result.dataSize).toBe(result.encryptedBytes.length);
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

      const decrypter = buildKmsDecryptCallback(mockAgent, 'root-key-id', 'key-uri', KeyDerivationScheme.ProtocolPath);

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
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'x', d: 'd' } as any,
      };

      const result = buildContextKeyDecrypter(contextKey);

      expect(result.rootKeyId).toBe('ctx-root-key');
      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
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

    it('should return ProtocolPath KMS decrypter for protocol-path records', async () => {
      const mockAgent = makeAliceAgent();

      const recordsWrite = {
        recordId   : 'rec-path-1',
        contextId  : 'rec-path-1',
        descriptor : { protocol: 'https://proto.example.com' },
        encryption : {
          keyEncryption: [{
            derivationScheme : KeyDerivationScheme.ProtocolPath,
            keyId            : 'did:example:alice#enc',
          }],
        },
      } as unknown as RecordsWriteMessage;

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, undefined,
        { get: sinon.stub().returns(undefined), set: sinon.stub() },
        sinon.stub(),
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(result.rootKeyId).toBe('did:example:alice#enc');
    });

    it('should return exact delegate key decrypter when available', async () => {
      const mockAgent = makeAliceAgent();

      const cachedKey: DerivedPrivateJwk = {
        rootKeyId         : 'cached-root',
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'x', d: 'd' } as any,
        derivationPath    : [KeyDerivationScheme.ProtocolPath, 'https://proto.example.com', 'message'],
      };
      const delegateCache = {
        get: sinon.stub().returns([{
          derivedPrivateKey : cachedKey,
          protocol          : 'https://proto.example.com',
          scope             : { kind: 'protocolPath', match: 'exact', protocolPath: 'message' },
        }]),
      };

      const recordsWrite = {
        recordId   : 'rec-exact',
        contextId  : 'rec-exact',
        descriptor : { protocol: 'https://proto.example.com', protocolPath: 'message' },
      } as unknown as RecordsWriteMessage;

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, undefined,
        { get: sinon.stub().returns(undefined), set: sinon.stub() },
        sinon.stub(),
        delegateCache,
        'did:example:delegate',
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(delegateCache.get.calledOnce).toBe(true);
    });

    it('should return protocol-wide delegate key decrypter when available', async () => {
      const mockAgent = makeAliceAgent();

      const protocolKey: DerivedPrivateJwk = {
        rootKeyId         : 'protocol-root',
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'x', d: 'd' } as any,
        derivationPath    : [KeyDerivationScheme.ProtocolPath, 'https://proto.example.com'],
      };
      const delegateCache = {
        get: sinon.stub().returns([{
          derivedPrivateKey : protocolKey,
          protocol          : 'https://proto.example.com',
          scope             : { kind: 'protocol' },
        }]),
      };

      const recordsWrite = {
        recordId   : 'rec-wide',
        contextId  : 'rec-wide',
        descriptor : { protocol: 'https://proto.example.com', protocolPath: 'message' },
      } as unknown as RecordsWriteMessage;

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, undefined,
        { get: sinon.stub().returns(undefined), set: sinon.stub() },
        sinon.stub(),
        delegateCache,
        'did:example:delegate',
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    });

    it('should fail closed for a delegate when no delivered key covers the record', async () => {
      const mockAgent = makeAliceAgent();
      const delegateCache = {
        get: sinon.stub().returns([{
          derivedPrivateKey: {
            rootKeyId         : 'other-root',
            derivationScheme  : KeyDerivationScheme.ProtocolPath,
            derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'x', d: 'd' } as any,
            derivationPath    : [KeyDerivationScheme.ProtocolPath, 'https://other.example.com'],
          },
          protocol : 'https://other.example.com',
          scope    : { kind: 'protocol' },
        }]),
      };

      const recordsWrite = {
        recordId   : 'rec-uncovered',
        contextId  : 'rec-uncovered',
        descriptor : { protocol: 'https://proto.example.com', protocolPath: 'message' },
      } as unknown as RecordsWriteMessage;

      await expect(resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, undefined,
        { get: sinon.stub().returns(undefined), set: sinon.stub() },
        sinon.stub(),
        delegateCache,
        'did:example:delegate',
      )).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(mockAgent.keyManager.getKeyUri.called).toBe(false);
    });
  });
});
