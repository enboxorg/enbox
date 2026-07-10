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
    it('injects the derived public key for each rule set path', async () => {
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

      const keyDeriver = createKeyDeriver(privateJwk, rootKeyId);
      const result = await Protocols.deriveAndInjectPublicEncryptionKeys(protocolDefinition, keyDeriver);

      // key derivation is deterministic, so re-deriving each path yields the exact key each node must carry
      const protocol = protocolDefinition.protocol;
      const rootPublicKey = await keyDeriver.derivePublicKey([KeyDerivationScheme.ProtocolPath, protocol]);
      const threadPublicKey = await keyDeriver.derivePublicKey([KeyDerivationScheme.ProtocolPath, protocol, 'thread']);
      const messagePublicKey = await keyDeriver.derivePublicKey([KeyDerivationScheme.ProtocolPath, protocol, 'thread', 'message']);

      expect(result.$keyAgreement!.publicKeyJwk).toEqual(rootPublicKey);
      expect(result.structure.thread.$keyAgreement!.publicKeyJwk).toEqual(threadPublicKey);

      const messageRuleSet = result.structure.thread.message as ProtocolRuleSet;
      expect(messageRuleSet.$keyAgreement!.publicKeyJwk).toEqual(messagePublicKey);
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
    it('decrypts a record encrypted with a protocol-path derived public key', async () => {
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
      }, createKeyDeriver(privateJwk, rootKeyId));
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

      const keyDecrypter = createKeyDecrypter(privateJwk, rootKeyId);
      const decryptedStream = await Records.decrypt(encryptedRecord.message, keyDecrypter, encryptedRecord.dataStream);
      const decryptedBytes = await DataStream.toBytes(decryptedStream);

      expect(Encoder.bytesToString(decryptedBytes)).toBe(plaintext);
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
      }, createKeyDeriver(privateJwk, rootKeyId));
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
          createKeyDecrypter(otherPrivateKey, 'did:example:bob#enc'),
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
