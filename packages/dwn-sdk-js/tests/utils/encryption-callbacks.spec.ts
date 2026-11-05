import type { ModuleRuleSet } from '../../src/types/modules-types.js';
import type { EncryptionKeyDeriver, KeyDecrypter } from '../../src/types/encryption-types.js';
import type { PrivateKeyJwk, PublicKeyJwk } from '../../src/types/jose-types.js';

import { DataStream } from '../../src/utils/data-stream.js';
import { Encoder } from '../../src/utils/encoder.js';
import { Encryption } from '../../src/utils/encryption.js';
import { Modules } from '../../src/utils/modules.js';
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

  describe('Modules.deriveAndInjectPublicEncryptionKeys()', () => {
    it('injects the derived public key for each rule set path', async () => {
      const moduleDefinition = {
        module    : 'https://example.com/module/foo',
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
      const result = await Modules.deriveAndInjectPublicEncryptionKeys(moduleDefinition, keyDeriver);

      // key derivation is deterministic, so re-deriving each path yields the exact key each node must carry
      const module = moduleDefinition.module;
      const rootPublicKey = await keyDeriver.derivePublicKey([KeyDerivationScheme.ModulePath, module]);
      const threadPublicKey = await keyDeriver.derivePublicKey([KeyDerivationScheme.ModulePath, module, 'thread']);
      const messagePublicKey = await keyDeriver.derivePublicKey([KeyDerivationScheme.ModulePath, module, 'thread', 'message']);

      expect(result.$keyAgreement!.publicKeyJwk).toEqual(rootPublicKey);
      expect(result.structure.thread.$keyAgreement!.publicKeyJwk).toEqual(threadPublicKey);

      const messageRuleSet = result.structure.thread.message as ModuleRuleSet;
      expect(messageRuleSet.$keyAgreement!.publicKeyJwk).toEqual(messagePublicKey);
    });

    it('calls derivePublicKey with module-root and full module-path derivation paths', async () => {
      const moduleDefinition = {
        module    : 'https://example.com/module/bar',
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

      await Modules.deriveAndInjectPublicEncryptionKeys(moduleDefinition, keyDeriver);

      expect(calledPaths).toEqual([
        [KeyDerivationScheme.ModulePath, 'https://example.com/module/bar'],
        [KeyDerivationScheme.ModulePath, 'https://example.com/module/bar', 'thread'],
        [KeyDerivationScheme.ModulePath, 'https://example.com/module/bar', 'thread', 'message'],
      ]);
    });
  });

  describe('Records.decrypt() with KeyDecrypter', () => {
    it('decrypts a record encrypted with a module-path derived public key', async () => {
      const moduleDefinition = await Modules.deriveAndInjectPublicEncryptionKeys({
        module    : 'https://example.com/module/decrypt-test',
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
      const encryptedRecord = await TestDataGenerator.generateModuleEncryptedRecordsWrite({
        author                                      : alice,
        encryptSymmetricKeyWithModulePathDerivedKey : true,
        plaintextBytes,
        moduleDefinition,
        modulePath                                  : 'note',
      });

      const keyDecrypter = createKeyDecrypter(privateJwk, rootKeyId);
      const decryptedStream = await Records.decrypt(encryptedRecord.message, keyDecrypter, encryptedRecord.dataStream);
      const decryptedBytes = await DataStream.toBytes(decryptedStream);

      expect(Encoder.bytesToString(decryptedBytes)).toBe(plaintext);
    });

    it('throws if no matching key encryption entry is found', async () => {
      const moduleDefinition = await Modules.deriveAndInjectPublicEncryptionKeys({
        module    : 'https://example.com/module/mismatch-test',
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
      const encryptedRecord = await TestDataGenerator.generateModuleEncryptedRecordsWrite({
        author                                      : alice,
        encryptSymmetricKeyWithModulePathDerivedKey : true,
        plaintextBytes                              : Encoder.stringToBytes('secret'),
        moduleDefinition,
        modulePath                                  : 'note',
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
    derivationScheme : KeyDerivationScheme.ModulePath,
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
    derivationScheme : KeyDerivationScheme.ModulePath,
    derivePublicKey  : async (fullDerivationPath): Promise<PublicKeyJwk> => {
      const privateKeyBytes = await X25519.privateKeyToBytes({ privateKey: privateJwk });
      const derivedPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(privateKeyBytes, fullDerivationPath);
      const derivedPrivateKey = await X25519.bytesToPrivateKey({ privateKeyBytes: derivedPrivateKeyBytes });
      return await X25519.getPublicKey({ key: derivedPrivateKey }) as PublicKeyJwk;
    },
    rootKeyId,
  };
}
