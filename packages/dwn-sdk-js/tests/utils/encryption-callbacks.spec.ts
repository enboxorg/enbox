import type { ProtocolRuleSet } from '../../src/types/protocols-types.js';
import type { EncryptionKeyDeriver, KeyDecrypter } from '../../src/types/encryption-types.js';
import type { PrivateKeyJwk, PublicKeyJwk } from '../../src/types/jose-types.js';

import { DataStream } from '../../src/utils/data-stream.js';
import { Encoder } from '../../src/utils/encoder.js';
import { Encryption } from '../../src/utils/encryption.js';
import { Protocols } from '../../src/utils/protocols.js';
import { Records } from '../../src/utils/records.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { X25519 } from '@enbox/crypto';

import { beforeEach, describe, expect, it } from 'bun:test';
import { HdKey, KeyDerivationScheme } from '../../src/utils/hd-key.js';

describe('Encryption callback interfaces', () => {
  let privateJwk: PrivateKeyJwk;
  let rootKeyId: string;

  beforeEach(async () => {
    privateJwk = await X25519.generateKey() as PrivateKeyJwk;
    rootKeyId = 'did:example:alice#enc';
  });

  describe('Protocols.deriveAndInjectPublicEncryptionKeys()', () => {
    it('produces the same $keyAgreement output as the raw-key overload', async () => {
      const protocolDefinition = {
        protocol  : 'https://example.com/protocol/foo',
        published : true,
        types     : {
          message: {
            dataFormats        : ['text/plain'],
            encryptionRequired : true,
            schema             : 'https://example.com/schema/message',
          },
          thread: {
            dataFormats : ['application/json'],
            schema      : 'https://example.com/schema/thread',
          },
        },
        structure: {
          thread: {
            message: {},
          },
        }
      };

      const resultA = await Protocols.deriveAndInjectPublicEncryptionKeys(protocolDefinition, rootKeyId, privateJwk);
      const keyDeriver = createKeyDeriver(privateJwk, rootKeyId);
      const resultB = await Protocols.deriveAndInjectPublicEncryptionKeys(protocolDefinition, keyDeriver);

      expect(resultA.$keyAgreement!.publicKeyJwk).toEqual(resultB.$keyAgreement!.publicKeyJwk);
      expect(resultA.structure.thread.$keyAgreement!.publicKeyJwk).toEqual(resultB.structure.thread.$keyAgreement!.publicKeyJwk);

      const messageRuleSetA = resultA.structure.thread.message as ProtocolRuleSet;
      const messageRuleSetB = resultB.structure.thread.message as ProtocolRuleSet;
      expect(messageRuleSetA.$keyAgreement!.publicKeyJwk).toEqual(messageRuleSetB.$keyAgreement!.publicKeyJwk);
    });

    it('calls derivePublicKey with protocol-root and full protocol-path derivation paths', async () => {
      const protocolDefinition = {
        protocol  : 'https://example.com/protocol/bar',
        published : true,
        types     : {
          message: {
            dataFormats        : ['text/plain'],
            encryptionRequired : true,
            schema             : 'https://example.com/schema/message',
          },
          thread: {
            dataFormats : ['application/json'],
            schema      : 'https://example.com/schema/thread',
          },
        },
        structure: {
          thread: {
            message: {},
          },
        }
      };
      const calledPaths: string[][] = [];
      const keyDeriver = createKeyDeriver(privateJwk, rootKeyId, calledPaths);

      await Protocols.deriveAndInjectPublicEncryptionKeys(protocolDefinition, keyDeriver);

      expect(calledPaths).toEqual([
        [KeyDerivationScheme.ProtocolPath, 'https://example.com/protocol/bar'],
        [KeyDerivationScheme.ProtocolPath, 'https://example.com/protocol/bar', 'thread'],
        [KeyDerivationScheme.ProtocolPath, 'https://example.com/protocol/bar', 'thread', 'message'],
      ]);
    });
  });

  describe('Records.decrypt() with KeyDecrypter', () => {
    it('produces the same plaintext as the raw-key overload', async () => {
      const protocolDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys({
        protocol  : 'https://example.com/protocol/decrypt-test',
        published : true,
        types     : {
          note: {
            dataFormats        : ['text/plain'],
            encryptionRequired : true,
            schema             : 'https://example.com/schema/note',
          },
        },
        structure: {
          note: {},
        }
      }, rootKeyId, privateJwk);
      const alice = await TestDataGenerator.generatePersona();
      const plaintext = 'This is a secret message';
      const plaintextBytes = Encoder.stringToBytes(plaintext);
      const encryptedRecord = await TestDataGenerator.generateProtocolEncryptedRecordsWrite({
        author                                        : alice,
        encryptSymmetricKeyWithProtocolPathDerivedKey : true,
        plaintextBytes,
        protocolDefinition,
        protocolPath                                  : 'note',
      });
      const rootKey = {
        derivedPrivateKey : privateJwk,
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        rootKeyId,
      };

      const decryptedStreamA = await Records.decrypt(encryptedRecord.message, rootKey, encryptedRecord.dataStream);
      const plaintextA = await DataStream.toBytes(decryptedStreamA);
      const keyDecrypter = createKeyDecrypter(privateJwk, rootKeyId);
      const encryptedRecord2 = await TestDataGenerator.generateProtocolEncryptedRecordsWrite({
        author                                        : alice,
        encryptSymmetricKeyWithProtocolPathDerivedKey : true,
        plaintextBytes,
        protocolDefinition,
        protocolPath                                  : 'note',
      });
      const decryptedStreamB = await Records.decrypt(encryptedRecord2.message, keyDecrypter, encryptedRecord2.dataStream);
      const plaintextB = await DataStream.toBytes(decryptedStreamB);

      expect(Encoder.bytesToString(plaintextA)).toBe(plaintext);
      expect(Encoder.bytesToString(plaintextB)).toBe(plaintext);
    });

    it('throws if no matching key encryption entry is found', async () => {
      const protocolDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys({
        protocol  : 'https://example.com/protocol/mismatch-test',
        published : true,
        types     : {
          note: {
            dataFormats        : ['text/plain'],
            encryptionRequired : true,
            schema             : 'https://example.com/schema/note',
          },
        },
        structure: {
          note: {},
        }
      }, rootKeyId, privateJwk);
      const alice = await TestDataGenerator.generatePersona();
      const encryptedRecord = await TestDataGenerator.generateProtocolEncryptedRecordsWrite({
        author                                        : alice,
        encryptSymmetricKeyWithProtocolPathDerivedKey : true,
        plaintextBytes                                : Encoder.stringToBytes('secret'),
        protocolDefinition,
        protocolPath                                  : 'note',
      });
      const otherPrivateKey = await X25519.generateKey() as PrivateKeyJwk;

      await expect(
        Records.decrypt(
          encryptedRecord.message,
          { derivedPrivateKey: otherPrivateKey, derivationScheme: KeyDerivationScheme.ProtocolPath, rootKeyId: 'did:example:bob#enc' },
          encryptedRecord.dataStream,
        )
      ).rejects.toThrow('Unable to find a matching key encryption entry');
    });
  });
});

function createKeyDeriver(privateJwk: PrivateKeyJwk, rootKeyId: string, calledPaths: string[][] = []): EncryptionKeyDeriver {
  return {
    derivationScheme : KeyDerivationScheme.ProtocolPath,
    derivePublicKey  : async (fullDerivationPath: string[]): Promise<PublicKeyJwk> => {
      calledPaths.push([...fullDerivationPath]);
      const privateKeyBytes = await X25519.privateKeyToBytes({ privateKey: privateJwk });
      const derivedPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(privateKeyBytes, fullDerivationPath);
      const derivedPrivateKey = await X25519.bytesToPrivateKey({ privateKeyBytes: derivedPrivateKeyBytes });
      return await X25519.getPublicKey({ key: derivedPrivateKey }) as PublicKeyJwk;
    },
    rootKeyId,
  };
}

function createKeyDecrypter(privateJwk: PrivateKeyJwk, rootKeyId: string): KeyDecrypter {
  return {
    decrypt: async (fullDerivationPath, keyUnwrapPayload): Promise<Uint8Array> => {
      const privateKeyBytes = await X25519.privateKeyToBytes({ privateKey: privateJwk });
      const leafPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(privateKeyBytes, fullDerivationPath);
      const leafPrivateKey = await X25519.bytesToPrivateKey({ privateKeyBytes: leafPrivateKeyBytes });
      return Encryption.unwrapKey(leafPrivateKey, keyUnwrapPayload.keyEncryption);
    },
    derivationScheme : KeyDerivationScheme.ProtocolPath,
    derivePublicKey  : async (fullDerivationPath): Promise<PublicKeyJwk> => {
      const privateKeyBytes = await X25519.privateKeyToBytes({ privateKey: privateJwk });
      const derivedPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(privateKeyBytes, fullDerivationPath);
      const derivedPrivateKey = await X25519.bytesToPrivateKey({ privateKeyBytes: derivedPrivateKeyBytes });
      return await X25519.getPublicKey({ key: derivedPrivateKey }) as PublicKeyJwk;
    },
    rootKeyId,
  };
}
