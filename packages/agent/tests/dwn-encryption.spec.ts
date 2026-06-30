import type { AudienceEpochPayload } from '../src/dwn-encryption.js';
import type { DerivedPrivateJwk, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { X25519 } from '@enbox/crypto';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  ContentEncryptionAlgorithm,
  DataStream,
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  Encryption,
  EncryptionProtocol,
  HdKey,
  KeyAgreementAlgorithm,
  KeyDerivationScheme,
  Records,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
  TestDataGenerator,
  Time,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import {
  buildEncryptionInput,
  buildKmsDecryptCallback,
  buildProtocolPathSubtreeDecrypter,
  createGrantKeyRecordsForGrants,
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
          unwrapContentKey: sinon.stub().resolves(new Uint8Array(32)),
        },
      } as any;

      const result = buildKmsDecryptCallback(
        mockAgent, 'root-key-id', 'key-uri', KeyDerivationScheme.ProtocolPath,
      );

      expect(result.rootKeyId).toBe('root-key-id');
      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(typeof result.decrypt).toBe('function');
    });

    it('should call keyManager.unwrapContentKey when decrypt is called', async () => {
      const unwrapContentKeyStub = sinon.stub().resolves(new Uint8Array(32));
      const mockAgent = {
        keyManager: { unwrapContentKey: unwrapContentKeyStub },
      } as any;

      const decrypter = buildKmsDecryptCallback(mockAgent, 'root-key-id', 'key-uri', KeyDerivationScheme.ProtocolPath);

      const mockPayload = {
        encryptedKey       : new Uint8Array(48),
        ephemeralPublicKey : { kty: 'OKP', crv: 'X25519', x: 'mock-x' } as any,
      };

      await decrypter.decrypt(['path', 'to', 'key'], mockPayload);

      expect(unwrapContentKeyStub.calledOnce).toBe(true);
      expect(unwrapContentKeyStub.firstCall.args[0]).toEqual({
        keyUri             : 'key-uri',
        derivationPath     : ['path', 'to', 'key'],
        encryptedKey       : mockPayload.encryptedKey,
        ephemeralPublicKey : mockPayload.ephemeralPublicKey,
      });
    });
  });

  describe('buildProtocolPathSubtreeDecrypter', () => {
    it('should return a KeyDecrypter with correct rootKeyId and derivationScheme', () => {
      const protocolPathKey: DerivedPrivateJwk = {
        rootKeyId         : 'ctx-root-key',
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'x', d: 'd' } as any,
      };

      const result = buildProtocolPathSubtreeDecrypter(protocolPathKey);

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
      await maybeDecryptReply(request, reply, {} as any);
    });

    it('should return immediately when encryption is false', async () => {
      const request = { author: 'did:example:alice', target: 'did:example:alice', encryption: false } as any;
      const reply = {} as any;

      await maybeDecryptReply(request, reply, {} as any);
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
          getKeyUri        : sinon.stub().resolves('key-uri-1'),
          unwrapContentKey : sinon.stub(),
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
          getKeyUri        : sinon.stub().resolves('key-uri-1'),
          unwrapContentKey : sinon.stub(),
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
        )
      ).rejects.toThrow('AgentDwnApi: Failed to decrypt record \'rec-fail-query\'');
    });

    it('should decrypt RecordsRead replies using delivered delegate keys without owner KMS fallback', async () => {
      const owner = await TestDataGenerator.generateDidKeyPersona();
      const protocol = 'https://example.com/delegate-delivered-key';
      const plaintext = Encoder.stringToBytes('delivered key plaintext');
      const rootKey: DerivedPrivateJwk = {
        rootKeyId         : owner.keyId,
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        derivedPrivateKey : owner.encryptionKeyPair.privateJwk,
      };
      const protocolKey = await HdKey.derivePrivateKey(rootKey, [KeyDerivationScheme.ProtocolPath, protocol]);
      const leafPublicKey = await HdKey.derivePublicKey(rootKey, [KeyDerivationScheme.ProtocolPath, protocol, 'note']);

      const dataEncryptionKey = crypto.getRandomValues(new Uint8Array(32));
      const dataEncryptionInitializationVector = crypto.getRandomValues(new Uint8Array(16));
      const encryptedData = await Encryption.encrypt(
        ContentEncryptionAlgorithm.A256CTR,
        dataEncryptionKey,
        dataEncryptionInitializationVector,
        plaintext,
      );
      const encryptionInput = buildEncryptionInput(
        dataEncryptionKey,
        dataEncryptionInitializationVector,
        await Encryption.getKeyId(leafPublicKey),
        leafPublicKey,
        KeyDerivationScheme.ProtocolPath,
      );
      const recordsWrite = await TestDataGenerator.generateRecordsWrite({
        author       : owner,
        data         : encryptedData,
        encryptionInput,
        protocol,
        protocolPath : 'note',
      });
      const request = {
        author      : owner.did,
        encryption  : true,
        granteeDid  : 'did:example:delegate',
        messageType : DwnInterface.RecordsRead,
        target      : owner.did,
      } as any;
      const reply = {
        status : { code: 200 },
        entry  : {
          recordsWrite : recordsWrite.message,
          data         : DataStream.fromBytes(encryptedData),
        },
      } as any;
      const mockAgent = {
        keyManager: {
          getKeyUri        : sinon.stub().rejects(new Error('owner KMS fallback should not be used')),
          unwrapContentKey : sinon.stub().rejects(new Error('owner KMS fallback should not be used')),
        },
      } as any;
      const delegateCache = {
        get: sinon.stub().returns([{
          derivedPrivateKey : protocolKey,
          protocol,
          scope             : { kind: 'protocol' },
        }]),
      };

      await maybeDecryptReply(
        request,
        reply,
        mockAgent,
        delegateCache,
      );

      expect(mockAgent.keyManager.getKeyUri.called).toBe(false);
      expect(mockAgent.keyManager.unwrapContentKey.called).toBe(false);
      expect(Encoder.bytesToString(await DataStream.toBytes(reply.entry.data))).toBe('delivered key plaintext');
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
          getKeyUri        : sinon.stub().resolves('key-uri-1'),
          unwrapContentKey : sinon.stub().resolves(new Uint8Array(32)),
        },
      } as any;

      const decrypter = await getKeyDecrypter(mockAgent, 'did:example:alice');
      expect(decrypter.rootKeyId).toBe('did:example:alice#enc');
      expect(decrypter.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    });
  });

  describe('createGrantKeyRecordsForGrants', () => {
    it('should skip grants that cannot carry durable encrypted read access', async () => {
      const grantor = await TestDataGenerator.generatePersona({ did: 'did:example:alice' });
      const grantee = await TestDataGenerator.generatePersona({ did: 'did:example:delegate' });
      const writeGrant = await TestDataGenerator.generateGrantCreate({
        author      : grantor,
        grantedTo   : grantee,
        delegated   : true,
        dateExpires : '2040-06-25T16:09:16.693356Z',
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'https://proto.example.com',
        },
      });
      const contextReadGrant = await TestDataGenerator.generateGrantCreate({
        author      : grantor,
        grantedTo   : grantee,
        delegated   : true,
        dateExpires : '2040-06-25T16:09:16.693356Z',
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Read,
          protocol  : 'https://proto.example.com',
          contextId : 'context-a',
        },
      });
      const processDwnRequest = sinon.stub().rejects(new Error('ineligible grants should not write records'));

      const records = await createGrantKeyRecordsForGrants({
        agent                 : { processDwnRequest } as any,
        ownerDid              : grantor.did,
        granteeDid            : grantee.did,
        granteeRootPrivateKey : await X25519.generateKey(),
        grantMessages         : [writeGrant.dataEncodedMessage, contextReadGrant.dataEncodedMessage],
      });

      expect(records).toHaveLength(0);
      expect(processDwnRequest.called).toBe(false);
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
        getKeyUri        : sinon.stub().resolves('key-uri-1'),
        unwrapContentKey : sinon.stub(),
      },
    });

    const makeGrantKeyResolverFixture = async ({
      grantScopeProtocolPath,
      grantDateExpires,
      payloadScopeProtocolPath,
      recordProtocolPath = 'message',
      includeEncodedData = true,
      grantRevoked = false,
      mutatePayload,
      mutateRecordTags,
    }: {
      grantScopeProtocolPath?: string;
      grantDateExpires?: string;
      payloadScopeProtocolPath?: string;
      recordProtocolPath?: string;
      includeEncodedData?: boolean;
      grantRevoked?: boolean;
      mutatePayload?: (payload: any) => void;
      mutateRecordTags?: (tags: Record<string, string>) => void;
    } = {}): Promise<{
      delegateCache: { get: sinon.SinonStub; set: sinon.SinonStub };
      grantKeyRecordId: string;
      grantRecordId: string;
      mockAgent: any;
      recordsWrite: RecordsWriteMessage;
    }> => {
      const protocol = 'https://proto.example.com';
      const grantor = await TestDataGenerator.generatePersona({ did: 'did:example:alice' });
      const grantee = await TestDataGenerator.generatePersona({ did: 'did:example:delegate' });
      const grant = await TestDataGenerator.generateGrantCreate({
        author    : grantor,
        grantedTo : grantee,
        delegated : true,
        scope     : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Read,
          protocol,
          ...(grantScopeProtocolPath !== undefined ? { protocolPath: grantScopeProtocolPath } : {}),
        },
        dateExpires: grantDateExpires ?? '2040-06-25T16:09:16.693356Z',
      });

      const privateKeyJwk = await X25519.generateKey();
      const publicKeyJwk = await X25519.getPublicKey({ key: privateKeyJwk });
      const keyId = await Encryption.getKeyId(publicKeyJwk);
      const payload = {
        grantId : grant.dataEncodedMessage.recordId,
        scope   : {
          scheme: KeyDerivationScheme.ProtocolPath,
          protocol,
          ...(payloadScopeProtocolPath !== undefined ? { protocolPath: payloadScopeProtocolPath } : {}),
        },
        keyMaterial: {
          algorithm      : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
          derivationPath : [
            KeyDerivationScheme.ProtocolPath,
            protocol,
            ...(payloadScopeProtocolPath !== undefined ? payloadScopeProtocolPath.split('/') : []),
          ],
          derivationScheme: KeyDerivationScheme.ProtocolPath,
          keyId,
          privateKeyJwk,
          publicKeyJwk,
        },
      };
      mutatePayload?.(payload);
      const tags = {
        grantId  : payload.grantId,
        protocol : payload.scope.protocol,
        ...(payload.scope.protocolPath !== undefined ? { protocolPath: payload.scope.protocolPath } : {}),
        keyId    : payload.keyMaterial.keyId,
      };
      mutateRecordTags?.(tags);

      const grantKeyWrite = await TestDataGenerator.generateRecordsWrite({
        author       : grantor,
        recipient    : grantee.did,
        protocol     : EncryptionProtocol.uri,
        protocolPath : EncryptionProtocol.grantKeyPath,
        schema       : EncryptionProtocol.definition.types.grantKey.schema,
        dataFormat   : 'application/json',
        data         : new Uint8Array([1, 2, 3]),
        tags,
      });
      const grantKeyMessage = {
        ...grantKeyWrite.message,
        ...(includeEncodedData ? { encodedData: Encoder.bytesToBase64Url(grantKeyWrite.dataBytes!) } : {}),
      } as RecordsWriteMessage & { encodedData?: string };

      sinon.stub(Records, 'decrypt').resolves(DataStream.fromBytes(Encoder.objectToBytes(payload)));

      const processDwnRequest = sinon.stub();
      processDwnRequest.onFirstCall().resolves({
        reply: {
          status  : { code: 200, detail: 'OK' },
          entries : [grantKeyMessage],
        },
      });
      let nextCallIndex = 1;
      if (!includeEncodedData) {
        processDwnRequest.onCall(nextCallIndex).resolves({
          reply: {
            status : { code: 200, detail: 'OK' },
            entry  : {
              recordsWrite : grantKeyWrite.message,
              data         : DataStream.fromBytes(grantKeyWrite.dataBytes!),
            },
          },
        });
        nextCallIndex++;
      }
      processDwnRequest.onCall(nextCallIndex).resolves({
        reply: {
          status : { code: 200, detail: 'OK' },
          entry  : {
            recordsWrite : grant.message,
            data         : DataStream.fromBytes(grant.dataBytes),
          },
        },
      });
      const mockAgent = {
        did: {
          resolve: sinon.stub().resolves({
            didDocument: {
              id                 : grantee.did,
              keyAgreement       : ['#enc'],
              verificationMethod : [{
                id           : `${grantee.did}#enc`,
                type         : 'JsonWebKey2020',
                controller   : grantee.did,
                publicKeyJwk : grantee.encryptionKeyPair.publicJwk,
              }],
            },
            didResolutionMetadata: {},
          }),
        },
        keyManager: {
          getKeyUri        : sinon.stub().resolves('grantee-key-uri'),
          unwrapContentKey : sinon.stub(),
        },
        permissions: {
          isGrantRevoked: sinon.stub().resolves(grantRevoked),
        },
        processDwnRequest,
      };

      return {
        mockAgent,
        delegateCache: {
          get : sinon.stub().returns(undefined),
          set : sinon.stub(),
        },
        grantKeyRecordId : grantKeyMessage.recordId,
        grantRecordId    : grant.dataEncodedMessage.recordId,
        recordsWrite     : {
          recordId   : 'rec-grant-key-validation',
          contextId  : 'rec-grant-key-validation',
          descriptor : { protocol, protocolPath: recordProtocolPath },
        } as unknown as RecordsWriteMessage,
      };
    };

    const makeRoleAudienceResolverFixture = async ({
      includeAudienceEpoch = true,
      includeRoleRecord = true,
      mutateAudienceEpochPayload,
    }: {
      includeAudienceEpoch?: boolean;
      includeRoleRecord?: boolean;
      mutateAudienceEpochPayload?: (payload: AudienceEpochPayload) => void;
    } = {}): Promise<{
      audienceCache: { get: sinon.SinonStub; set: sinon.SinonStub };
      audienceKeyId: string;
      mockAgent: any;
      recordsWrite: RecordsWriteMessage;
    }> => {
      const protocol = 'https://proto.example.com/chat';
      const contextId = 'thread-1';
      const role = 'thread/participant';
      const epoch = 1;
      const sourceDid = 'did:example:alice';
      const recipientDid = 'did:example:bob';

      const sourcePersona = await TestDataGenerator.generatePersona({ did: sourceDid });
      const recipientPersona = await TestDataGenerator.generatePersona({ did: recipientDid });
      const rolePathPrivateKey = await X25519.generateKey();
      const rolePathPrivateKeyBytes = await X25519.privateKeyToBytes({ privateKey: rolePathPrivateKey });
      const audiencePrivateKey = await X25519.generateKey();
      const audiencePublicKey = await X25519.getPublicKey({ key: audiencePrivateKey });
      const keyId = await Encryption.getKeyId(audiencePublicKey);
      const audienceKeyPayload = {
        protocol    : protocol,
        contextId   : contextId,
        role        : role,
        epoch       : epoch,
        keyMaterial : {
          algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
          derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
          keyId,
          privateKeyJwk    : audiencePrivateKey,
          publicKeyJwk     : audiencePublicKey,
        },
      };
      const audienceTags = {
        protocol,
        contextId,
        role,
        epoch,
        keyId,
      };

      const audienceKeyWrite = await TestDataGenerator.generateRecordsWrite({
        author       : sourcePersona,
        recipient    : recipientDid,
        protocol     : EncryptionProtocol.uri,
        protocolPath : EncryptionProtocol.audienceKeyPath,
        schema       : EncryptionProtocol.definition.types.audienceKey.schema,
        dataFormat   : 'application/json',
        data         : new Uint8Array([1, 2, 3]),
        tags         : audienceTags,
      });
      const audienceKeyMessage = {
        ...audienceKeyWrite.message,
        encodedData: Encoder.bytesToBase64Url(audienceKeyWrite.dataBytes!),
      } as RecordsWriteMessage & { encodedData: string };

      const audienceEpochPayload = {
        protocol,
        contextId,
        role,
        epoch,
        keyId,
        publicKeyJwk: audiencePublicKey,
      };
      mutateAudienceEpochPayload?.(audienceEpochPayload);
      const audienceEpochWrite = await TestDataGenerator.generateRecordsWrite({
        author       : sourcePersona,
        published    : true,
        protocol     : EncryptionProtocol.uri,
        protocolPath : EncryptionProtocol.audienceEpochPath,
        schema       : EncryptionProtocol.definition.types.audienceEpoch.schema,
        dataFormat   : 'application/json',
        data         : Encoder.objectToBytes(audienceEpochPayload),
        tags         : audienceTags,
      });
      const audienceEpochMessage = {
        ...audienceEpochWrite.message,
        encodedData: Encoder.bytesToBase64Url(audienceEpochWrite.dataBytes!),
      } as RecordsWriteMessage & { encodedData: string };

      const roleRecord = {
        contextId  : `${contextId}/participant-1`,
        descriptor : {
          recipient    : recipientDid,
          protocol,
          protocolPath : role,
        },
      } as RecordsWriteMessage;

      sinon.stub(Records, 'decrypt').resolves(DataStream.fromBytes(Encoder.objectToBytes(audienceKeyPayload)));

      const processDwnRequest = sinon.stub();
      processDwnRequest.onFirstCall().resolves({
        reply: {
          status  : { code: 200, detail: 'OK' },
          entries : [audienceKeyMessage],
        },
      });
      processDwnRequest.onSecondCall().resolves({
        reply: {
          status  : { code: 200, detail: 'OK' },
          entries : includeAudienceEpoch ? [audienceEpochMessage] : [],
        },
      });
      processDwnRequest.onThirdCall().resolves({
        reply: {
          status  : { code: 200, detail: 'OK' },
          entries : includeRoleRecord ? [roleRecord] : [],
        },
      });

      const mockAgent = {
        did: {
          resolve: sinon.stub().resolves({
            didDocument: {
              id                 : recipientDid,
              keyAgreement       : ['#enc'],
              verificationMethod : [{
                id           : `${recipientDid}#enc`,
                type         : 'JsonWebKey2020',
                controller   : recipientDid,
                publicKeyJwk : recipientPersona.encryptionKeyPair.publicJwk,
              }],
            },
            didResolutionMetadata: {},
          }),
        },
        keyManager: {
          derivePrivateKeyBytes : sinon.stub().resolves(rolePathPrivateKeyBytes),
          derivePublicKey       : sinon.stub(),
          getKeyUri             : sinon.stub().resolves('recipient-key-uri'),
          unwrapContentKey      : sinon.stub(),
        },
        processDwnRequest,
        secrets: {
          get : sinon.stub().resolves(undefined),
          put : sinon.stub().resolves(),
        },
      };

      return {
        audienceKeyId : keyId,
        mockAgent,
        audienceCache : {
          get : sinon.stub().returns(undefined),
          set : sinon.stub(),
        },
        recordsWrite: {
          recordId   : 'rec-role-audience',
          contextId  : `${contextId}/chat-1`,
          descriptor : { protocol, protocolPath: 'thread/chat' },
          encryption : {
            keyEncryption: [{
              derivationScheme: ROLE_AUDIENCE_DERIVATION_SCHEME,
              protocol,
              role,
              epoch,
              keyId,
            }],
          },
        } as unknown as RecordsWriteMessage,
      };
    };

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
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(result.rootKeyId).toBe('did:example:alice#enc');
    });

    it('should return path-subtree delegate key decrypter when available', async () => {
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
          scope             : { kind: 'protocolPath', protocolPath: 'message' },
        }]),
      };

      const recordsWrite = {
        recordId   : 'rec-exact',
        contextId  : 'rec-exact',
        descriptor : { protocol: 'https://proto.example.com', protocolPath: 'message' },
      } as unknown as RecordsWriteMessage;

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, undefined,
        delegateCache,
        'did:example:delegate',
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(delegateCache.get.calledOnce).toBe(true);
    });

    it('should return ancestor path-subtree delegate key decrypter for descendant records', async () => {
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
          scope             : { kind: 'protocolPath', protocolPath: 'message' },
        }]),
      };

      const recordsWrite = {
        recordId   : 'rec-descendant',
        contextId  : 'rec-descendant',
        descriptor : { protocol: 'https://proto.example.com', protocolPath: 'message/reply' },
      } as unknown as RecordsWriteMessage;

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, undefined,
        delegateCache,
        'did:example:delegate',
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(result.rootKeyId).toBe('cached-root');
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
        delegateCache,
        'did:example:delegate',
      )).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(mockAgent.keyManager.getKeyUri.called).toBe(false);
    });

    it('should fail closed for a delegate when no delegate key cache is provided', async () => {
      const mockAgent = makeAliceAgent();
      const recordsWrite = {
        recordId   : 'rec-no-cache',
        contextId  : 'rec-no-cache',
        descriptor : { protocol: 'https://proto.example.com', protocolPath: 'message' },
      } as unknown as RecordsWriteMessage;

      await expect(resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, undefined,
        undefined,
        'did:example:delegate',
      )).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(mockAgent.keyManager.getKeyUri.called).toBe(false);
    });

    it('should fail closed for a delegate when no durable grantKey covers the record', async () => {
      const mockAgent = {
        ...makeAliceAgent(),
        processDwnRequest: sinon.stub().resolves({
          reply: {
            status  : { code: 200, detail: 'OK' },
            entries : [],
          },
        }),
      };
      const delegateCache = {
        get : sinon.stub().returns(undefined),
        set : sinon.stub(),
      };

      const recordsWrite = {
        recordId   : 'rec-no-grant-key',
        contextId  : 'rec-no-grant-key',
        descriptor : { protocol: 'https://proto.example.com', protocolPath: 'message' },
      } as unknown as RecordsWriteMessage;

      await expect(resolveKeyDecrypter(
        mockAgent, 'did:example:alice', recordsWrite, 'did:example:alice',
        delegateCache,
        'did:example:delegate',
      )).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(mockAgent.processDwnRequest.calledOnce).toBe(true);
      expect(mockAgent.processDwnRequest.firstCall.args[0].messageParams.filter).toEqual({
        recipient    : 'did:example:delegate',
        protocol     : EncryptionProtocol.uri,
        protocolPath : EncryptionProtocol.grantKeyPath,
        tags         : { protocol: 'https://proto.example.com' },
      });
      expect(delegateCache.set.called).toBe(false);
      expect(mockAgent.keyManager.getKeyUri.called).toBe(false);
    });

    it('should hydrate and cache a path-scoped durable grantKey for descendant records', async () => {
      const { mockAgent, delegateCache, grantRecordId, recordsWrite } = await makeGrantKeyResolverFixture({
        grantScopeProtocolPath   : 'message',
        payloadScopeProtocolPath : 'message',
        recordProtocolPath       : 'message/reply',
      });

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:delegate', recordsWrite, 'did:example:alice',
        delegateCache,
        'did:example:delegate',
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(delegateCache.set.calledOnce).toBe(true);

      const cachedKeys = delegateCache.set.firstCall.args[1];
      expect(cachedKeys).toHaveLength(1);
      expect(cachedKeys[0].protocol).toBe('https://proto.example.com');
      expect(cachedKeys[0].scope).toEqual({ kind: 'protocolPath', protocolPath: 'message' });
      expect(mockAgent.processDwnRequest.callCount).toBe(2);
      expect(mockAgent.permissions.isGrantRevoked.calledOnceWith({
        author : 'did:example:delegate',
        target : 'did:example:alice',
        grantRecordId,
      })).toBe(true);
    });

    it('should read durable grantKey data when the query entry omits encodedData', async () => {
      const { mockAgent, delegateCache, grantKeyRecordId, recordsWrite } = await makeGrantKeyResolverFixture({
        includeEncodedData: false,
      });

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:delegate', recordsWrite, 'did:example:alice',
        delegateCache,
        'did:example:delegate',
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(delegateCache.set.calledOnce).toBe(true);
      expect(mockAgent.processDwnRequest.callCount).toBe(3);
      expect(mockAgent.processDwnRequest.secondCall.args[0]).toMatchObject({
        author        : 'did:example:delegate',
        target        : 'did:example:alice',
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { recordId: grantKeyRecordId } },
      });
    });

    it('should reject a durable grantKey whose scope does not cover the encrypted record', async () => {
      const { mockAgent, delegateCache, recordsWrite } = await makeGrantKeyResolverFixture({
        grantScopeProtocolPath   : 'message/reply',
        payloadScopeProtocolPath : 'message/reply',
        recordProtocolPath       : 'message',
      });

      await expect(resolveKeyDecrypter(
        mockAgent, 'did:example:delegate', recordsWrite, 'did:example:alice',
        delegateCache,
        'did:example:delegate',
      )).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(delegateCache.set.called).toBe(false);
    });

    it('should reject a durable grantKey when the referenced permission grant has expired', async () => {
      const { mockAgent, delegateCache, recordsWrite } = await makeGrantKeyResolverFixture({
        grantDateExpires: Time.createOffsetTimestamp({ seconds: -60 }),
      });

      await expect(resolveKeyDecrypter(
        mockAgent, 'did:example:delegate', recordsWrite, 'did:example:alice',
        delegateCache,
        'did:example:delegate',
      )).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(delegateCache.set.called).toBe(false);
      expect(mockAgent.permissions.isGrantRevoked.called).toBe(false);
    });

    it('should reject a durable grantKey when the referenced permission grant has been revoked', async () => {
      const { mockAgent, delegateCache, recordsWrite } = await makeGrantKeyResolverFixture({
        grantRevoked: true,
      });

      await expect(resolveKeyDecrypter(
        mockAgent, 'did:example:delegate', recordsWrite, 'did:example:alice',
        delegateCache,
        'did:example:delegate',
      )).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(delegateCache.set.called).toBe(false);
      expect(mockAgent.permissions.isGrantRevoked.calledOnce).toBe(true);
    });

    it('should reject a durable grantKey whose payload does not match its record tags', async () => {
      const { mockAgent, delegateCache, recordsWrite } = await makeGrantKeyResolverFixture({
        mutateRecordTags: (tags): void => {
          tags.protocol = 'https://proto.example.com/other';
        },
      });

      await expect(resolveKeyDecrypter(
        mockAgent, 'did:example:delegate', recordsWrite, 'did:example:alice',
        delegateCache,
        'did:example:delegate',
      )).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(delegateCache.set.called).toBe(false);
    });

    it('should reject a durable grantKey whose keyId does not match the delivered key material', async () => {
      const { mockAgent, delegateCache, recordsWrite } = await makeGrantKeyResolverFixture({
        mutatePayload: (payload): void => {
          payload.keyMaterial.keyId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        },
      });

      await expect(resolveKeyDecrypter(
        mockAgent, 'did:example:delegate', recordsWrite, 'did:example:alice',
        delegateCache,
        'did:example:delegate',
      )).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(delegateCache.set.called).toBe(false);
    });

    it('should reject a durable grantKey whose derivationPath does not match its scope', async () => {
      const { mockAgent, delegateCache, recordsWrite } = await makeGrantKeyResolverFixture({
        mutatePayload: (payload): void => {
          payload.keyMaterial.derivationPath = [KeyDerivationScheme.ProtocolPath, 'https://proto.example.com', 'other'];
        },
      });

      await expect(resolveKeyDecrypter(
        mockAgent, 'did:example:delegate', recordsWrite, 'did:example:alice',
        delegateCache,
        'did:example:delegate',
      )).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(delegateCache.set.called).toBe(false);
    });

    it('should hydrate a role-audience key only after verifying the audienceEpoch and role assignment', async () => {
      const { mockAgent, audienceCache, audienceKeyId, recordsWrite } = await makeRoleAudienceResolverFixture();

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:bob', recordsWrite, 'did:example:alice',
        undefined,
        undefined,
        audienceCache,
      );

      expect(result.derivationScheme).toBe(ROLE_AUDIENCE_DERIVATION_SCHEME);
      expect(audienceCache.set.calledOnce).toBe(true);
      expect(mockAgent.processDwnRequest.callCount).toBe(3);
      expect(mockAgent.processDwnRequest.secondCall.args[0].messageParams.filter).toEqual({
        protocol     : EncryptionProtocol.uri,
        protocolPath : EncryptionProtocol.audienceEpochPath,
        tags         : {
          protocol  : 'https://proto.example.com/chat',
          contextId : 'thread-1',
          role      : 'thread/participant',
          epoch     : 1,
          keyId     : audienceKeyId,
        },
      });
      expect(mockAgent.processDwnRequest.thirdCall.args[0].messageParams.filter).toEqual({
        contextId    : 'thread-1',
        recipient    : 'did:example:bob',
        protocol     : 'https://proto.example.com/chat',
        protocolPath : 'thread/participant',
      });
    });

    it('should skip an audienceKey that does not match an accepted audienceEpoch', async () => {
      const { mockAgent, audienceCache, recordsWrite } = await makeRoleAudienceResolverFixture({
        includeAudienceEpoch: false,
      });

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:bob', recordsWrite, 'did:example:alice',
        undefined,
        undefined,
        audienceCache,
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(audienceCache.set.called).toBe(false);
      expect(mockAgent.processDwnRequest.callCount).toBe(2);
    });

    it('should skip an audienceKey whose key material differs from the accepted audienceEpoch', async () => {
      const { mockAgent, audienceCache, recordsWrite } = await makeRoleAudienceResolverFixture({
        mutateAudienceEpochPayload: (payload): void => {
          payload.publicKeyJwk = { kty: 'OKP', crv: 'X25519', x: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' };
        },
      });

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:bob', recordsWrite, 'did:example:alice',
        undefined,
        undefined,
        audienceCache,
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(audienceCache.set.called).toBe(false);
      expect(mockAgent.processDwnRequest.callCount).toBe(2);
    });

    it('should skip an audienceKey when the recipient has no active role assignment', async () => {
      const { mockAgent, audienceCache, recordsWrite } = await makeRoleAudienceResolverFixture({
        includeRoleRecord: false,
      });

      const result = await resolveKeyDecrypter(
        mockAgent, 'did:example:bob', recordsWrite, 'did:example:alice',
        undefined,
        undefined,
        audienceCache,
      );

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(audienceCache.set.called).toBe(false);
      expect(mockAgent.processDwnRequest.callCount).toBe(3);
    });
  });
});
