import type { DataEncodedRecordsWriteMessage, DerivedPrivateJwk, PrivateKeyJwk, ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { X25519 } from '@enbox/crypto';

import { createPortableDidWithEncryptionKey } from './utils/delegate-did.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';

import {
  AudienceDecryptError,
  buildEncryptionInput,
  buildKmsDecryptCallback,
  buildProtocolPathSubtreeDecrypter,
  createGrantKeyRecordsForGrants,
  encryptAndComputeCid,
  getEncryptionKeyDeriver,
  getEncryptionKeyInfo,
  getKeyDecrypter,
  hasAudienceSealCoverage,
  ivLength,
  maybeDecryptReply,
  resolveAudienceDecryptionKey,
  resolveKeyDecrypter,
} from '../src/dwn-encryption.js';
import {
  ContentEncryptionAlgorithm,
  DataStream,
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  Encryption,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  EncryptionControlDeliveryRecipientAuthority,
  EncryptionProtocol,
  HdKey,
  KeyAgreementAlgorithm,
  KeyDerivationScheme,
  Records,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
  TestDataGenerator,
  Time,
  WRAPPED_GRANT_KEY_FORMAT,
} from '@enbox/dwn-sdk-js';

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

      // No encryption flag: it returns immediately without mutating the reply.
      await maybeDecryptReply(request, reply, {} as any);
      expect(reply).toEqual({});
    });

    it('should return immediately when encryption is false', async () => {
      const request = { author: 'did:example:alice', target: 'did:example:alice', encryption: false } as any;
      const reply = {} as any;

      // encryption:false short-circuits the same way — the reply is left untouched.
      await maybeDecryptReply(request, reply, {} as any);
      expect(reply).toEqual({});
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

    it('should skip decryption for encryption-control RecordsRead replies', async () => {
      const decryptStub = sinon.stub(Records, 'decrypt').rejects(new Error('control records are not app data'));
      const request = {
        author      : 'did:example:alice',
        target      : 'did:example:alice',
        encryption  : true,
        messageType : DwnInterface.RecordsRead,
      } as any;
      const reply = {
        status : { code: 200 },
        entry  : {
          recordsWrite: {
            recordId   : 'delivery-record',
            descriptor : {
              protocol     : 'https://example.com/proto',
              protocolPath : ENCRYPTION_CONTROL_DELIVERY_PATH,
            },
            encryption: {
              keyEncryption: [],
            },
          },
          data: DataStream.fromBytes(new Uint8Array([1, 2, 3])),
        },
      } as any;

      await maybeDecryptReply(request, reply, {} as any);

      expect(decryptStub.called).toBe(false);
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

    describe('audience decrypt failure taxonomy for role-wrapped records', () => {
      function makeRoleWrappedReadReply(): any {
        return {
          status : { code: 200 },
          entry  : {
            recordsWrite: {
              recordId   : 'rec-role-wrapped',
              contextId  : 'rec-role-wrapped',
              descriptor : { protocol: 'https://proto.example.com', protocolPath: 'note' },
              encryption : {
                keyEncryption: [{
                  algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
                  derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
                  keyId            : 'wrapped-role-key',
                  protocol         : 'https://proto.example.com',
                  rolePath         : 'admin',
                }],
              },
            },
            data: new ReadableStream(),
          },
        };
      }

      function makeRecipientAgent(sendDwnRequest: sinon.SinonStub): any {
        return {
          did: {
            resolve: sinon.stub().resolves({
              didDocument: {
                id                 : 'did:example:bob',
                keyAgreement       : ['#enc'],
                verificationMethod : [{
                  id           : 'did:example:bob#enc',
                  type         : 'JsonWebKey2020',
                  controller   : 'did:example:bob',
                  publicKeyJwk : { kty: 'OKP', crv: 'X25519', x: 'AAAA' },
                }],
              },
              didResolutionMetadata: {},
            }),
          },
          keyManager        : { getKeyUri: sinon.stub().resolves('key-uri-bob') },
          processDwnRequest : sinon.stub().resolves({ reply: { status: { code: 200, detail: 'OK' }, entries: [] } }),
          sendDwnRequest,
        };
      }

      const recipientReadRequest = {
        author      : 'did:example:bob',
        target      : 'did:example:alice',
        encryption  : true,
        messageType : 'RecordsRead',
      } as any;

      async function decryptAndCatch(mockAgent: any): Promise<AudienceDecryptError> {
        const dwnSdk = await import('@enbox/dwn-sdk-js');
        sinon.stub(dwnSdk.Records, 'decrypt').rejects(new Error('no matching key encryption entry in test'));

        let caught: unknown;
        try {
          await maybeDecryptReply(recipientReadRequest, makeRoleWrappedReadReply(), mockAgent);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(AudienceDecryptError);
        return caught as AudienceDecryptError;
      }

      it('should classify an unreachable remote during the audience lookup as remote-unverifiable', async () => {
        const mockAgent = makeRecipientAgent(sinon.stub().rejects(new Error('remote transport down in test')));

        const decryptError = await decryptAndCatch(mockAgent);

        expect(decryptError.cause).toBe('remote-unverifiable');
        expect(decryptError.detail).toContain('no audience record');
        expect(decryptError.recordId).toBe('rec-role-wrapped');
        expect(decryptError.protocol).toBe('https://proto.example.com');
        expect(decryptError.recipientDid).toBe('did:example:bob');
      });

      it('should fall back to cause unknown when audience absence is authoritative and no current audience is visible', async () => {
        const mockAgent = makeRecipientAgent(sinon.stub().resolves({ reply: { status: { code: 200, detail: 'OK' }, entries: [] } }));

        const decryptError = await decryptAndCatch(mockAgent);

        expect(decryptError.cause).toBe('unknown');
        expect(decryptError.detail).toContain('Original error');
      });
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
      const rootPrivateKeyBytes = await X25519.privateKeyToBytes({ privateKey: rootKey.derivedPrivateKey });
      const protocolKeyPath = [KeyDerivationScheme.ProtocolPath, protocol];
      const protocolKeyBytes = await HdKey.derivePrivateKeyBytes(rootPrivateKeyBytes, protocolKeyPath);
      const protocolKey: DerivedPrivateJwk = {
        rootKeyId         : owner.keyId,
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        derivationPath    : protocolKeyPath,
        derivedPrivateKey : await X25519.bytesToPrivateKey({ privateKeyBytes: protocolKeyBytes }) as PrivateKeyJwk,
      };
      const leafPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(protocolKeyBytes, ['note']);
      const leafPrivateKey = await X25519.bytesToPrivateKey({ privateKeyBytes: leafPrivateKeyBytes });
      const leafPublicKey = await X25519.getPublicKey({ key: leafPrivateKey });

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
          grantorDid        : owner.did,
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

  describe('resolveAudienceDecryptionKey', () => {
    it('should query participant deliveries through the delegated read actor for member delegates', async () => {
      const protocol = 'https://example.com/member-delegate-delivery';
      const rolePath = 'chat/member';
      const contextId = 'chat-root';
      const sourceDid = 'did:example:alice';
      const recipientDid = 'did:example:bob';
      const granteeDid = 'did:example:bob-delegate';
      const delegatedGrant = { recordId: 'bob-delegate-grant' } as unknown as DataEncodedRecordsWriteMessage;
      const audiencePrivateKeyJwk = await X25519.generateKey();
      const audiencePublicKeyJwk = await X25519.getPublicKey({ key: audiencePrivateKeyJwk });
      const audienceKeyId = await Encryption.getKeyId(audiencePublicKeyJwk);
      const delegateRootPrivateKey = await X25519.generateKey();
      const delegateRootPublicKey = await X25519.getPublicKey({ key: delegateRootPrivateKey });
      const delegateRootPrivateKeyBytes = await X25519.privateKeyToBytes({ privateKey: delegateRootPrivateKey });
      const audiencePayload = {
        protocol,
        rolePath,
        contextId,
        keyId            : audienceKeyId,
        publicKeyJwk     : audiencePublicKeyJwk,
        sealedPrivateKey : {
          algorithm          : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
          derivationScheme   : 'seal',
          encryptedKey       : Encoder.bytesToBase64Url(new Uint8Array([1, 2, 3])),
          ephemeralPublicKey : audiencePublicKeyJwk,
          keyId              : 'seal-key-id',
        },
      };
      const audienceMessage = {
        recordId    : 'audience-record',
        encodedData : Encoder.bytesToBase64Url(Encoder.objectToBytes(audiencePayload)),
        descriptor  : {
          protocol,
          protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          tags         : {
            protocol,
            rolePath,
            contextId,
            keyId: audienceKeyId,
          },
        },
      } as unknown as RecordsWriteMessage & { encodedData: string };
      const deliveryPayload = {
        protocol,
        rolePath,
        contextId,
        keyId       : audienceKeyId,
        keyMaterial : {
          algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
          derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
          keyId            : audienceKeyId,
          privateKeyJwk    : audiencePrivateKeyJwk,
          publicKeyJwk     : audiencePublicKeyJwk,
        },
      };
      const deliveryMessage = {
        recordId    : 'delivery-record',
        encodedData : Encoder.bytesToBase64Url(new Uint8Array([9, 9, 9])),
        descriptor  : {
          recipient    : recipientDid,
          protocol,
          protocolPath : ENCRYPTION_CONTROL_DELIVERY_PATH,
          tags         : {
            protocol,
            rolePath,
            contextId,
            keyId              : audienceKeyId,
            recipientAuthority : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
          },
        },
      } as unknown as RecordsWriteMessage & { encodedData: string };
      const roleMessage = {
        recordId   : 'role-record',
        contextId  : `${contextId}/role-record`,
        descriptor : {
          recipient    : recipientDid,
          protocol,
          protocolPath : rolePath,
        },
      } as unknown as RecordsWriteMessage;
      const processDwnRequest = sinon.stub().callsFake(async (request: any): Promise<any> => {
        const filter = request.messageParams.filter;
        if (request.messageType === DwnInterface.RecordsQuery && filter.protocolPath === ENCRYPTION_CONTROL_AUDIENCE_PATH) {
          return {
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [audienceMessage],
            },
          };
        }

        if (request.messageType === DwnInterface.RecordsQuery && filter.protocolPath === ENCRYPTION_CONTROL_DELIVERY_PATH) {
          return {
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : filter.recipient === recipientDid ? [deliveryMessage] : [],
            },
          };
        }

        if (request.messageType === DwnInterface.RecordsQuery && filter.protocolPath === rolePath) {
          return {
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [roleMessage],
            },
          };
        }

        return {
          reply: {
            status  : { code: 200, detail: 'OK' },
            entries : [],
          },
        };
      });
      const mockAgent = {
        did: {
          resolve: sinon.stub().resolves({
            didDocument: {
              id                 : granteeDid,
              keyAgreement       : ['#enc'],
              verificationMethod : [{
                controller   : granteeDid,
                id           : `${granteeDid}#enc`,
                publicKeyJwk : delegateRootPublicKey,
                type         : 'JsonWebKey2020',
              }],
            },
            didResolutionMetadata: {},
          }),
        },
        keyManager: {
          derivePrivateKeyBytes: sinon.stub().callsFake(async ({ derivationPath }: { derivationPath: string[] }): Promise<Uint8Array> => {
            return HdKey.derivePrivateKeyBytes(delegateRootPrivateKeyBytes, derivationPath);
          }),
          getKeyUri: sinon.stub().resolves('delegate-key-uri'),
        },
        processDwnRequest,
        sendDwnRequest: sinon.stub().resolves({
          reply: {
            status  : { code: 200, detail: 'OK' },
            entries : [],
          },
        }),
      };
      const delegateDecryptionKeyCache = {
        get: sinon.stub().withArgs(`ddk~${granteeDid}`).returns([{
          derivedPrivateKey: {
            rootKeyId         : 'bob-grant-key',
            derivationScheme  : KeyDerivationScheme.ProtocolPath,
            derivedPrivateKey : delegateRootPrivateKey,
          },
          grantorDid : recipientDid,
          protocol,
          scope      : { kind: 'protocol' },
        }]),
        set: sinon.stub(),
      };
      sinon.stub(Records, 'decrypt').resolves(DataStream.fromBytes(Encoder.objectToBytes(deliveryPayload)));

      const result = await resolveAudienceDecryptionKey({
        agent : mockAgent as any,
        sourceDid,
        recipientDid,
        granteeDid,
        delegatedGrant,
        delegateDecryptionKeyCache,
        protocol,
        contextId,
        rolePath,
        keyId : audienceKeyId,
      });
      const deliveryRecipients = processDwnRequest.getCalls()
        .map((call) => call.args[0])
        .filter((request) => request.messageParams?.filter?.protocolPath === ENCRYPTION_CONTROL_DELIVERY_PATH);

      expect(result?.recipientDid).toBe(recipientDid);
      expect(result?.keyMaterial.keyId).toBe(audienceKeyId);
      expect(deliveryRecipients.map((request) => request.messageParams.filter.recipient)).toEqual([recipientDid]);
      expect(deliveryRecipients.map((request) => request.author)).toEqual([recipientDid]);
      expect(deliveryRecipients.map((request) => request.granteeDid)).toEqual([granteeDid]);
      expect(deliveryRecipients[0].messageParams.delegatedGrant).toBe(delegatedGrant);
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

  describe('hasAudienceSealCoverage', () => {
    it('should return false when the source tenant key is not available locally', async () => {
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
          derivePrivateKeyBytes : sinon.stub().rejects(new Error('Key not found: urn:jwk:alice')),
          getKeyUri             : sinon.stub().resolves('urn:jwk:alice'),
        },
      } as any;

      const result = await hasAudienceSealCoverage({
        agent     : mockAgent,
        protocol  : 'https://example.org/protocols/seal-coverage',
        rolePath  : 'member',
        sourceDid : 'did:example:alice',
      });

      expect(result).toBe(false);
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
    it('should skip grants that cannot carry durable encrypted access', async () => {
      const grantor = await TestDataGenerator.generatePersona({ did: 'did:example:alice' });
      const grantee = await TestDataGenerator.generatePersona({ did: 'did:example:delegate' });
      const deleteGrant = await TestDataGenerator.generateGrantCreate({
        author      : grantor,
        grantedTo   : grantee,
        delegated   : true,
        dateExpires : '2040-06-25T16:09:16.693356Z',
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Delete,
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
      const messagesReadGrant = await TestDataGenerator.generateGrantCreate({
        author      : grantor,
        grantedTo   : grantee,
        delegated   : true,
        dateExpires : '2040-06-25T16:09:16.693356Z',
        scope       : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
          protocol  : 'https://proto.example.com',
        },
      });
      const processDwnRequest = sinon.stub().rejects(new Error('ineligible grants should not write records'));

      const records = await createGrantKeyRecordsForGrants({
        agent                 : { processDwnRequest } as any,
        ownerDid              : grantor.did,
        granteeDid            : grantee.did,
        granteeRootPrivateKey : await X25519.generateKey(),
        grantMessages         : [deleteGrant.dataEncodedMessage, contextReadGrant.dataEncodedMessage, messagesReadGrant.dataEncodedMessage],
      });

      expect(records).toHaveLength(0);
      expect(processDwnRequest.called).toBe(false);
    });

    it('should create grantKey records for read scope keys and referenced local role keys', async () => {
      const grantor = await TestDataGenerator.generatePersona({ did: 'did:example:alice' });
      const grantee = await TestDataGenerator.generatePersona({ did: 'did:example:delegate' });
      const ownerPrivateKey = await X25519.generateKey();
      const protocolDefinition = await createGrantKeyCoverageProtocolDefinition('https://proto.example.com');
      const readGrant = await TestDataGenerator.generateGrantCreate({
        author      : grantor,
        grantedTo   : grantee,
        delegated   : true,
        dateExpires : '2040-06-25T16:09:16.693356Z',
        scope       : {
          interface    : DwnInterfaceName.Records,
          method       : DwnMethodName.Read,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'chat/message',
        },
      });
      const processDwnRequest = sinon.stub().callsFake(async (request: any): Promise<any> => ({
        message: {
          recordId   : `grant-key-${processDwnRequest.callCount}`,
          descriptor : {
            ...request.messageParams,
            messageTimestamp: Time.getCurrentTimestamp(),
          },
        },
        reply: { status: { code: 202, detail: 'Accepted' } },
      }));
      const mockAgent = await createGrantKeyProducerAgent(grantor.did, ownerPrivateKey, processDwnRequest);

      const records = await createGrantKeyRecordsForGrants({
        agent                 : mockAgent,
        ownerDid              : grantor.did,
        granteeDid            : grantee.did,
        granteeRootPrivateKey : await X25519.generateKey(),
        grantMessages         : [readGrant.dataEncodedMessage],
        protocolDefinitions   : [protocolDefinition],
      });

      expect(records).toHaveLength(2);
      expect(records.map((record) => record.descriptor.tags?.protocolPath).sort()).toEqual(['chat/member', 'chat/message']);
      expect(processDwnRequest.callCount).toBe(2);
      expect(processDwnRequest.getCalls().every((call) => call.args[0].messageType === DwnInterface.RecordsWrite)).toBe(true);
    });

    it('should create grantKey records for role paths covered by write grants', async () => {
      const grantor = await TestDataGenerator.generatePersona({ did: 'did:example:alice' });
      const grantee = await TestDataGenerator.generatePersona({ did: 'did:example:delegate' });
      const ownerPrivateKey = await X25519.generateKey();
      const protocolDefinition = await createGrantKeyCoverageProtocolDefinition('https://proto.example.com');
      const writeGrant = await TestDataGenerator.generateGrantCreate({
        author      : grantor,
        grantedTo   : grantee,
        delegated   : true,
        dateExpires : '2040-06-25T16:09:16.693356Z',
        scope       : {
          interface    : DwnInterfaceName.Records,
          method       : DwnMethodName.Write,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'chat',
        },
      });
      const processDwnRequest = sinon.stub().callsFake(async (request: any): Promise<any> => ({
        message: {
          recordId   : `grant-key-${processDwnRequest.callCount}`,
          descriptor : {
            ...request.messageParams,
            messageTimestamp: Time.getCurrentTimestamp(),
          },
        },
        reply: { status: { code: 202, detail: 'Accepted' } },
      }));
      const mockAgent = await createGrantKeyProducerAgent(grantor.did, ownerPrivateKey, processDwnRequest);

      const records = await createGrantKeyRecordsForGrants({
        agent                 : mockAgent,
        ownerDid              : grantor.did,
        granteeDid            : grantee.did,
        granteeRootPrivateKey : await X25519.generateKey(),
        grantMessages         : [writeGrant.dataEncodedMessage],
        protocolDefinitions   : [protocolDefinition],
      });

      expect(records).toHaveLength(2);
      expect(records.map((record) => record.descriptor.tags?.protocolPath).sort()).toEqual(['chat/admin', 'chat/member']);
      expect(processDwnRequest.callCount).toBe(2);
    });

    it('should wrap and hydrate grantKey records for a pre-supplied did:jwk delegate', async () => {
      const testHarness = await PlatformAgentTestHarness.setup({
        agentClass       : TestAgent,
        agentStores      : 'memory',
        testDataLocation : '__TESTDATA__/wrapped-grant-key-roundtrip',
      });

      try {
        await testHarness.clearStorage();
        await testHarness.createAgentDid();

        const delegatePortableDid = await createPortableDidWithEncryptionKey();
        const delegateDid = await testHarness.agent.did.import({
          portableDid : delegatePortableDid,
          tenant      : testHarness.agent.agentDid.uri,
        });
        const delegateKeyInfo = await getEncryptionKeyInfo(testHarness.agent, delegateDid.uri);

        const grantor = await TestDataGenerator.generatePersona({ did: 'did:example:alice' });
        const grantee = await TestDataGenerator.generatePersona({ did: delegateDid.uri });
        const ownerPrivateKey = await X25519.generateKey();
        const protocol = 'https://wrapped-grant-key.example.com';
        const readGrant = await TestDataGenerator.generateGrantCreate({
          author      : grantor,
          grantedTo   : grantee,
          delegated   : true,
          dateExpires : '2040-06-25T16:09:16.693356Z',
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Read,
            protocol,
          },
        });
        const grantKeyWriteStub = sinon.stub().callsFake(async (request: any): Promise<any> => {
          const dataBytes = await DataStream.toBytes(request.dataStream);
          const grantKeyWrite = await TestDataGenerator.generateRecordsWrite({
            author       : grantor,
            data         : dataBytes,
            dataFormat   : 'application/json',
            protocol     : EncryptionProtocol.uri,
            protocolPath : EncryptionProtocol.grantKeyPath,
            recipient    : delegateDid.uri,
            schema       : EncryptionProtocol.definition.types.grantKey.schema,
            tags         : request.messageParams.tags,
          });

          return {
            message: {
              ...grantKeyWrite.message,
              descriptor: {
                ...grantKeyWrite.message.descriptor,
                dataCid  : request.messageParams.dataCid,
                dataSize : request.messageParams.dataSize,
                tags     : request.messageParams.tags,
              },
            },
            reply: { status: { code: 202, detail: 'Accepted' } },
          };
        });
        const producerAgent = await createGrantKeyProducerAgent(grantor.did, ownerPrivateKey, grantKeyWriteStub);

        const grantKeyRecords = await createGrantKeyRecordsForGrants({
          agent                : producerAgent,
          ownerDid             : grantor.did,
          granteeDid           : delegateDid.uri,
          granteeRootPublicKey : delegateKeyInfo.publicKeyJwk,
          grantMessages        : [readGrant.dataEncodedMessage],
        });

        expect(grantKeyRecords).toHaveLength(1);
        expect(grantKeyRecords[0].encryption).toBeUndefined();
        const envelope = Encoder.bytesToObject(Encoder.base64UrlToBytes(grantKeyRecords[0].encodedData)) as any;
        expect(envelope.format).toBe(WRAPPED_GRANT_KEY_FORMAT);
        expect(envelope.keyEncryption.keyId).toBe(await Encryption.getKeyId(delegateKeyInfo.publicKeyJwk));
        expect(envelope.contentEncryption.algorithm).toBe(ContentEncryptionAlgorithm.A256CTR);
        expect(typeof envelope.ciphertext).toBe('string');

        const staleEnvelope = structuredClone(envelope);
        staleEnvelope.keyEncryption.keyId = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
        const staleGrantKeyRecord = {
          ...grantKeyRecords[0],
          encodedData : Encoder.bytesToBase64Url(Encoder.objectToBytes(staleEnvelope)),
          recordId    : 'stale-wrapped-grant-key',
        };
        const processDwnRequestStub = sinon.stub(testHarness.agent, 'processDwnRequest');
        processDwnRequestStub.onFirstCall().resolves({
          reply: {
            status  : { code: 200, detail: 'OK' },
            entries : [staleGrantKeyRecord, grantKeyRecords[0]],
          },
        });
        processDwnRequestStub.onSecondCall().resolves({
          reply: {
            status : { code: 200, detail: 'OK' },
            entry  : {
              recordsWrite : readGrant.message,
              data         : DataStream.fromBytes(readGrant.dataBytes),
            },
          },
        });
        sinon.stub(testHarness.agent.permissions, 'isGrantRevoked').resolves(false);

        const delegateCache = {
          get : sinon.stub().returns(undefined),
          set : sinon.stub(),
        };
        const keyDecrypter = await resolveKeyDecrypter({
          agent                      : testHarness.agent,
          authorDid                  : delegateDid.uri,
          delegateDecryptionKeyCache : delegateCache,
          granteeDid                 : delegateDid.uri,
          recordsWrite               : {
            recordId   : 'wrapped-record',
            contextId  : 'wrapped-record',
            descriptor : { protocol, protocolPath: 'note' },
          } as unknown as RecordsWriteMessage,
          targetDid: grantor.did,
        });

        expect(keyDecrypter.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
        expect(delegateCache.set.calledOnce).toBe(true);
        expect(processDwnRequestStub.callCount).toBe(2);

        processDwnRequestStub.onThirdCall().resolves({
          reply: {
            status  : { code: 200, detail: 'OK' },
            entries : [staleGrantKeyRecord],
          },
        });
        const mismatchedOnlyCache = {
          get : sinon.stub().returns(undefined),
          set : sinon.stub(),
        };
        await expect(resolveKeyDecrypter({
          agent                      : testHarness.agent,
          authorDid                  : delegateDid.uri,
          delegateDecryptionKeyCache : mismatchedOnlyCache,
          granteeDid                 : delegateDid.uri,
          recordsWrite               : {
            recordId   : 'wrapped-record',
            contextId  : 'wrapped-record',
            descriptor : { protocol, protocolPath: 'note' },
          } as unknown as RecordsWriteMessage,
          targetDid: grantor.did,
        })).rejects.toThrow('targets key');
        expect(mismatchedOnlyCache.set.called).toBe(false);
      } finally {
        await testHarness.clearStorage();
        await testHarness.closeStorage();
      }
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
      protocolDefinition,
      grantKeyRemoteOnly = false,
      mutatePayload,
      mutateRecordTags,
    }: {
      grantScopeProtocolPath?: string;
      grantDateExpires?: string;
      payloadScopeProtocolPath?: string;
      recordProtocolPath?: string;
      includeEncodedData?: boolean;
      grantRevoked?: boolean;
      protocolDefinition?: ProtocolDefinition;
      grantKeyRemoteOnly?: boolean;
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
        encryption: {
          algorithm            : ContentEncryptionAlgorithm.A256CTR,
          initializationVector : Encoder.bytesToBase64Url(new Uint8Array(16)),
          keyEncryption        : [],
        },
        ...(includeEncodedData ? { encodedData: Encoder.bytesToBase64Url(grantKeyWrite.dataBytes!) } : {}),
      } as RecordsWriteMessage & { encodedData?: string };

      sinon.stub(Records, 'decrypt').resolves(DataStream.fromBytes(Encoder.objectToBytes(payload)));

      const processDwnRequest = sinon.stub();
      const grantKeyQueryReply = {
        reply: {
          status  : { code: 200, detail: 'OK' },
          entries : [grantKeyMessage],
        },
      };
      processDwnRequest.onFirstCall().resolves(grantKeyRemoteOnly ? {
        reply: {
          status  : { code: 200, detail: 'OK' },
          entries : [],
        },
      } : grantKeyQueryReply);
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
      nextCallIndex++;
      if (protocolDefinition !== undefined) {
        processDwnRequest.onCall(nextCallIndex).resolves({
          reply: {
            status  : { code: 200, detail: 'OK' },
            entries : [{ descriptor: { definition: protocolDefinition } }],
          },
        });
        nextCallIndex++;
      }
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
        sendDwnRequest: sinon.stub().resolves(grantKeyQueryReply),
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

      const result = await resolveKeyDecrypter({
        agent     : mockAgent,
        authorDid : 'did:example:alice',
        recordsWrite,
        targetDid : undefined,
      });

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

      const result = await resolveKeyDecrypter({
        agent     : mockAgent,
        authorDid : 'did:example:alice',
        recordsWrite,
        targetDid : undefined,
      });

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
          grantorDid        : 'did:example:alice',
          protocol          : 'https://proto.example.com',
          scope             : { kind: 'protocolPath', protocolPath: 'message' },
        }]),
      };

      const recordsWrite = {
        recordId   : 'rec-exact',
        contextId  : 'rec-exact',
        descriptor : { protocol: 'https://proto.example.com', protocolPath: 'message' },
      } as unknown as RecordsWriteMessage;

      const result = await resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:alice',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      });

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
          grantorDid        : 'did:example:alice',
          protocol          : 'https://proto.example.com',
          scope             : { kind: 'protocolPath', protocolPath: 'message' },
        }]),
      };

      const recordsWrite = {
        recordId   : 'rec-descendant',
        contextId  : 'rec-descendant',
        descriptor : { protocol: 'https://proto.example.com', protocolPath: 'message/reply' },
      } as unknown as RecordsWriteMessage;

      const result = await resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:alice',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      });

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
          grantorDid        : 'did:example:alice',
          protocol          : 'https://proto.example.com',
          scope             : { kind: 'protocol' },
        }]),
      };

      const recordsWrite = {
        recordId   : 'rec-wide',
        contextId  : 'rec-wide',
        descriptor : { protocol: 'https://proto.example.com', protocolPath: 'message' },
      } as unknown as RecordsWriteMessage;

      const result = await resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:alice',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      });

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    });

    it('should ignore cached delegate keys issued by a different grantor', async () => {
      const mockAgent = makeAliceAgent();
      const protocolKey: DerivedPrivateJwk = {
        rootKeyId         : 'bob-protocol-root',
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'x', d: 'd' } as any,
        derivationPath    : [KeyDerivationScheme.ProtocolPath, 'https://proto.example.com'],
      };
      const delegateCache = {
        get: sinon.stub().returns([{
          derivedPrivateKey : protocolKey,
          grantorDid        : 'did:example:bob',
          protocol          : 'https://proto.example.com',
          scope             : { kind: 'protocol' },
        }]),
      };
      const recordsWrite = {
        recordId   : 'rec-wrong-grantor',
        contextId  : 'rec-wrong-grantor',
        descriptor : { protocol: 'https://proto.example.com', protocolPath: 'message' },
      } as unknown as RecordsWriteMessage;

      await expect(resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:alice',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      })).rejects.toThrow('no delivered decryption key covers encrypted record');
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
          grantorDid : 'did:example:alice',
          protocol   : 'https://other.example.com',
          scope      : { kind: 'protocol' },
        }]),
      };

      const recordsWrite = {
        recordId   : 'rec-uncovered',
        contextId  : 'rec-uncovered',
        descriptor : { protocol: 'https://proto.example.com', protocolPath: 'message' },
      } as unknown as RecordsWriteMessage;

      await expect(resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:alice',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : undefined,
      })).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(mockAgent.keyManager.getKeyUri.called).toBe(false);
    });

    it('should fail closed for a delegate when no delegate key cache is provided', async () => {
      const mockAgent = makeAliceAgent();
      const recordsWrite = {
        recordId   : 'rec-no-cache',
        contextId  : 'rec-no-cache',
        descriptor : { protocol: 'https://proto.example.com', protocolPath: 'message' },
      } as unknown as RecordsWriteMessage;

      await expect(resolveKeyDecrypter({
        agent      : mockAgent,
        authorDid  : 'did:example:alice',
        granteeDid : 'did:example:delegate',
        recordsWrite,
        targetDid  : undefined,
      })).rejects.toThrow('no delivered decryption key covers encrypted record');

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
        sendDwnRequest: sinon.stub().resolves({
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

      await expect(resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:alice',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      })).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(mockAgent.processDwnRequest.calledOnce).toBe(true);
      expect(mockAgent.processDwnRequest.firstCall.args[0].messageParams.filter).toEqual({
        recipient    : 'did:example:delegate',
        protocol     : EncryptionProtocol.uri,
        protocolPath : EncryptionProtocol.grantKeyPath,
        tags         : { protocol: 'https://proto.example.com' },
      });
      expect(mockAgent.sendDwnRequest.calledOnce).toBe(true);
      expect(delegateCache.set.called).toBe(false);
      expect(mockAgent.keyManager.getKeyUri.called).toBe(false);
    });

    it('should hydrate and cache a path-scoped durable grantKey for descendant records', async () => {
      const { mockAgent, delegateCache, grantRecordId, recordsWrite } = await makeGrantKeyResolverFixture({
        grantScopeProtocolPath   : 'message',
        payloadScopeProtocolPath : 'message',
        recordProtocolPath       : 'message/reply',
      });

      const result = await resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:delegate',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      });

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

    it('should hydrate a read-grant role-path durable grantKey referenced by a covered read rule', async () => {
      const protocolDefinition = await createGrantKeyCoverageProtocolDefinition('https://proto.example.com');
      const { mockAgent, delegateCache, recordsWrite } = await makeGrantKeyResolverFixture({
        grantScopeProtocolPath   : 'chat/message',
        payloadScopeProtocolPath : 'chat/member',
        protocolDefinition,
        recordProtocolPath       : 'chat/member',
      });

      const result = await resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:delegate',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      });

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(delegateCache.set.calledOnce).toBe(true);
      expect(mockAgent.processDwnRequest.callCount).toBe(3);
      expect(mockAgent.processDwnRequest.thirdCall.args[0]).toMatchObject({
        author        : 'did:example:delegate',
        target        : 'did:example:alice',
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: 'https://proto.example.com' } },
      });
    });

    it('should read durable grantKey data when the query entry omits encodedData', async () => {
      const { mockAgent, delegateCache, grantKeyRecordId, recordsWrite } = await makeGrantKeyResolverFixture({
        includeEncodedData: false,
      });

      const result = await resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:delegate',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      });

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

    it('should hydrate durable grantKeys from remote fallback when the local replica has not synced', async () => {
      const { mockAgent, delegateCache, recordsWrite } = await makeGrantKeyResolverFixture({
        grantKeyRemoteOnly: true,
      });

      const result = await resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:delegate',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      });

      expect(result.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
      expect(mockAgent.sendDwnRequest.calledOnce).toBe(true);
      expect(mockAgent.sendDwnRequest.firstCall.args[0].messageParams.filter).toEqual({
        recipient    : 'did:example:delegate',
        protocol     : EncryptionProtocol.uri,
        protocolPath : EncryptionProtocol.grantKeyPath,
        tags         : { protocol: 'https://proto.example.com' },
      });
      expect(delegateCache.set.calledOnce).toBe(true);
    });

    it('should reject a durable grantKey whose scope does not cover the encrypted record', async () => {
      const { mockAgent, delegateCache, recordsWrite } = await makeGrantKeyResolverFixture({
        grantScopeProtocolPath   : 'message/reply',
        payloadScopeProtocolPath : 'message/reply',
        recordProtocolPath       : 'message',
      });

      await expect(resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:delegate',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      })).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(delegateCache.set.called).toBe(false);
    });

    it('should reject a durable grantKey when the referenced permission grant has expired', async () => {
      const { mockAgent, delegateCache, recordsWrite } = await makeGrantKeyResolverFixture({
        grantDateExpires: Time.createOffsetTimestamp({ seconds: -60 }),
      });

      await expect(resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:delegate',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      })).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(delegateCache.set.called).toBe(false);
      expect(mockAgent.permissions.isGrantRevoked.called).toBe(false);
    });

    it('should reject a durable grantKey when the referenced permission grant has been revoked', async () => {
      const { mockAgent, delegateCache, recordsWrite } = await makeGrantKeyResolverFixture({
        grantRevoked: true,
      });

      await expect(resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:delegate',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      })).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(delegateCache.set.called).toBe(false);
      expect(mockAgent.permissions.isGrantRevoked.calledOnce).toBe(true);
    });

    it('should reject a durable grantKey whose payload does not match its record tags', async () => {
      const { mockAgent, delegateCache, recordsWrite } = await makeGrantKeyResolverFixture({
        mutateRecordTags: (tags): void => {
          tags.protocol = 'https://proto.example.com/other';
        },
      });

      await expect(resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:delegate',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      })).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(delegateCache.set.called).toBe(false);
    });

    it('should reject a durable grantKey whose keyId does not match the delivered key material', async () => {
      const { mockAgent, delegateCache, recordsWrite } = await makeGrantKeyResolverFixture({
        mutatePayload: (payload): void => {
          payload.keyMaterial.keyId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        },
      });

      await expect(resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:delegate',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      })).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(delegateCache.set.called).toBe(false);
    });

    it('should reject a durable grantKey whose derivationPath does not match its scope', async () => {
      const { mockAgent, delegateCache, recordsWrite } = await makeGrantKeyResolverFixture({
        mutatePayload: (payload): void => {
          payload.keyMaterial.derivationPath = [KeyDerivationScheme.ProtocolPath, 'https://proto.example.com', 'other'];
        },
      });

      await expect(resolveKeyDecrypter({
        agent                      : mockAgent,
        authorDid                  : 'did:example:delegate',
        delegateDecryptionKeyCache : delegateCache,
        granteeDid                 : 'did:example:delegate',
        recordsWrite,
        targetDid                  : 'did:example:alice',
      })).rejects.toThrow('no delivered decryption key covers encrypted record');

      expect(delegateCache.set.called).toBe(false);
    });

  });
});

async function createGrantKeyCoverageProtocolDefinition(protocol: string): Promise<ProtocolDefinition> {
  const rolePublicKey = await X25519.getPublicKey({ key: await X25519.generateKey() });
  return {
    published : true,
    protocol,
    types     : {
      admin   : { dataFormats: ['application/json'] },
      chat    : { dataFormats: ['application/json'] },
      member  : { dataFormats: ['application/json'] },
      message : { dataFormats: ['application/json'], encryptionRequired: true },
    },
    structure: {
      chat: {
        admin: {
          $keyAgreement : { publicKeyJwk: rolePublicKey },
          $role         : true,
        },
        member: {
          $keyAgreement : { publicKeyJwk: rolePublicKey },
          $role         : true,
        },
        message: {
          $actions      : [{ can: ['read'], role: 'chat/member' }],
          $keyAgreement : { publicKeyJwk: rolePublicKey },
        },
      },
    },
  };
}

async function createGrantKeyProducerAgent(
  ownerDid: string,
  ownerPrivateKey: Awaited<ReturnType<typeof X25519.generateKey>>,
  processDwnRequest: sinon.SinonStub,
): Promise<any> {
  const ownerPublicKey = await X25519.getPublicKey({ key: ownerPrivateKey });
  const ownerPrivateKeyBytes = await X25519.privateKeyToBytes({ privateKey: ownerPrivateKey });
  return {
    did: {
      resolve: sinon.stub().resolves({
        didDocument: {
          id                 : ownerDid,
          keyAgreement       : ['#enc'],
          verificationMethod : [{
            controller   : ownerDid,
            id           : `${ownerDid}#enc`,
            publicKeyJwk : ownerPublicKey,
            type         : 'JsonWebKey2020',
          }],
        },
        didResolutionMetadata: {},
      }),
    },
    keyManager: {
      derivePrivateKeyBytes: sinon.stub().callsFake(async ({ derivationPath }: { derivationPath: string[] }): Promise<Uint8Array> => {
        return HdKey.derivePrivateKeyBytes(ownerPrivateKeyBytes, derivationPath);
      }),
      getKeyUri: sinon.stub().resolves('owner-key-uri'),
    },
    processDwnRequest,
  };
}
