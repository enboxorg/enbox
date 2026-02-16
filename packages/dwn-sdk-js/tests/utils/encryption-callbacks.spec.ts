import type { EncryptionKeyDeriver, KeyDecrypter } from '../../src/types/encryption-types.js';
import type { PrivateKeyJwk, PublicKeyJwk } from '../../src/types/jose-types.js';

import { DataStream } from '../../src/utils/data-stream.js';
import { Encoder } from '../../src/utils/encoder.js';
import { Encryption } from '../../src/utils/encryption.js';
import { expect } from 'chai';
import { Protocols } from '../../src/utils/protocols.js';
import { Records } from '../../src/utils/records.js';
import { Secp256k1 } from '../../src/utils/secp256k1.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { HdKey, KeyDerivationScheme } from '../../src/utils/hd-key.js';

describe('Encryption Callback Interfaces', () => {
  let privateJwk: PrivateKeyJwk;
  let rootKeyId: string;

  beforeEach(async () => {
    const { privateJwk: key } = await Secp256k1.generateKeyPair();
    privateJwk = key;
    rootKeyId = 'did:example:alice#enc';
  });

  describe('Protocols.deriveAndInjectPublicEncryptionKeys() with EncryptionKeyDeriver', () => {
    it('produces the same $encryption output as the raw-key overload', async () => {
      const protocolDefinition = {
        protocol  : 'https://example.com/protocol/foo',
        published : true,
        types     : {
          thread: {
            schema      : 'https://example.com/schema/thread',
            dataFormats : ['application/json']
          },
          message: {
            schema      : 'https://example.com/schema/message',
            dataFormats : ['text/plain']
          }
        },
        structure: {
          thread: {
            message: {}
          }
        }
      };

      // Call with raw (rootKeyId, privateJwk) — get result A
      const resultA = await Protocols.deriveAndInjectPublicEncryptionKeys(
        protocolDefinition,
        rootKeyId,
        privateJwk
      );

      // Build an EncryptionKeyDeriver that uses the same key
      const keyDeriver: EncryptionKeyDeriver = {
        rootKeyId,
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        derivePublicKey  : async (fullDerivationPath: string[]): Promise<PublicKeyJwk> => {
          const privateKeyBytes = Secp256k1.privateJwkToBytes(privateJwk);
          const derivedPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(
            privateKeyBytes, fullDerivationPath
          );
          const derivedPublicKeyBytes = await Secp256k1.getPublicKey(derivedPrivateKeyBytes);
          return Secp256k1.publicKeyToJwk(derivedPublicKeyBytes);
        }
      };

      // Call with the callback — get result B
      const resultB = await Protocols.deriveAndInjectPublicEncryptionKeys(
        protocolDefinition,
        keyDeriver
      );

      // Assert A and B have identical $encryption at every path level
      expect(resultA.structure.thread.$encryption).to.exist;
      expect(resultB.structure.thread.$encryption).to.exist;
      expect(resultA.structure.thread.$encryption!.rootKeyId).to.equal(
        resultB.structure.thread.$encryption!.rootKeyId
      );
      expect(resultA.structure.thread.$encryption!.publicKeyJwk).to.deep.equal(
        resultB.structure.thread.$encryption!.publicKeyJwk
      );

      expect(resultA.structure.thread.message.$encryption).to.exist;
      expect(resultB.structure.thread.message.$encryption).to.exist;
      expect(resultA.structure.thread.message.$encryption!.rootKeyId).to.equal(
        resultB.structure.thread.message.$encryption!.rootKeyId
      );
      expect(resultA.structure.thread.message.$encryption!.publicKeyJwk).to.deep.equal(
        resultB.structure.thread.message.$encryption!.publicKeyJwk
      );
    });

    it('calls derivePublicKey with correct full derivation paths', async () => {
      const protocolDefinition = {
        protocol  : 'https://example.com/protocol/bar',
        published : true,
        types     : {
          thread: {
            schema      : 'https://example.com/schema/thread',
            dataFormats : ['application/json']
          },
          message: {
            schema      : 'https://example.com/schema/message',
            dataFormats : ['text/plain']
          }
        },
        structure: {
          thread: {
            message: {}
          }
        }
      };

      const calledPaths: string[][] = [];
      const keyDeriver: EncryptionKeyDeriver = {
        rootKeyId,
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        derivePublicKey  : async (fullDerivationPath: string[]): Promise<PublicKeyJwk> => {
          calledPaths.push([...fullDerivationPath]);
          const privateKeyBytes = Secp256k1.privateJwkToBytes(privateJwk);
          const derivedPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(
            privateKeyBytes, fullDerivationPath
          );
          const derivedPublicKeyBytes = await Secp256k1.getPublicKey(derivedPrivateKeyBytes);
          return Secp256k1.publicKeyToJwk(derivedPublicKeyBytes);
        }
      };

      await Protocols.deriveAndInjectPublicEncryptionKeys(
        protocolDefinition,
        keyDeriver
      );

      // Assert paths: ['protocolPath', '<url>', 'thread']
      //   and ['protocolPath', '<url>', 'thread', 'message']
      expect(calledPaths).to.have.lengthOf(2);
      expect(calledPaths[0]).to.deep.equal([
        KeyDerivationScheme.ProtocolPath,
        'https://example.com/protocol/bar',
        'thread'
      ]);
      expect(calledPaths[1]).to.deep.equal([
        KeyDerivationScheme.ProtocolPath,
        'https://example.com/protocol/bar',
        'thread',
        'message'
      ]);
    });
  });

  describe('Records.decrypt() with KeyDecrypter', () => {
    it('produces the same plaintext as the raw-key overload', async () => {
      const protocolDefinition = {
        protocol  : 'https://example.com/protocol/decrypt-test',
        published : true,
        types     : {
          note: {
            schema      : 'https://example.com/schema/note',
            dataFormats : ['text/plain']
          }
        },
        structure: {
          note: {}
        }
      };

      // Derive and inject encryption keys
      const encryptedProtocol = await Protocols.deriveAndInjectPublicEncryptionKeys(
        protocolDefinition,
        rootKeyId,
        privateJwk
      );

      // Generate a test persona
      const alice = await TestDataGenerator.generatePersona();

      // Encrypt a record using the standard flow
      const plaintext = 'This is a secret message';
      const plaintextBytes = Encoder.stringToBytes(plaintext);
      const encryptedRecord = await TestDataGenerator.generateProtocolEncryptedRecordsWrite({
        plaintextBytes,
        author                                           : alice,
        protocolDefinition                               : encryptedProtocol,
        protocolPath                                     : 'note',
        encryptSymmetricKeyWithProtocolPathDerivedKey    : true,
        encryptSymmetricKeyWithProtocolContextDerivedKey : false
      });

      // Decrypt with raw DerivedPrivateJwk — get plaintext A
      const rootKey = {
        rootKeyId,
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        derivedPrivateKey : privateJwk
      };
      const decryptedStreamA = await Records.decrypt(
        encryptedRecord.message,
        rootKey,
        encryptedRecord.dataStream!
      );
      const plaintextA = await DataStream.toBytes(decryptedStreamA);

      // Build a KeyDecrypter that uses the same key
      const keyDecrypter: KeyDecrypter = {
        rootKeyId,
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        decrypt          : async (fullDerivationPath, eciesPayload) => {
          const privateKeyBytes = Secp256k1.privateJwkToBytes(privateJwk);
          const leafPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(
            privateKeyBytes, fullDerivationPath
          );
          return Encryption.eciesSecp256k1Decrypt({
            privateKey                : leafPrivateKeyBytes,
            ciphertext                : eciesPayload.ciphertext,
            ephemeralPublicKey        : eciesPayload.ephemeralPublicKey,
            initializationVector      : eciesPayload.initializationVector,
            messageAuthenticationCode : eciesPayload.messageAuthenticationCode,
          });
        }
      };

      // Decrypt with the callback — get plaintext B
      // Note: Need to create a new stream since the first one was consumed
      const encryptedRecord2 = await TestDataGenerator.generateProtocolEncryptedRecordsWrite({
        plaintextBytes,
        author                                           : alice,
        protocolDefinition                               : encryptedProtocol,
        protocolPath                                     : 'note',
        encryptSymmetricKeyWithProtocolPathDerivedKey    : true,
        encryptSymmetricKeyWithProtocolContextDerivedKey : false
      });
      const decryptedStreamB = await Records.decrypt(
        encryptedRecord2.message,
        keyDecrypter,
        encryptedRecord2.dataStream!
      );
      const plaintextB = await DataStream.toBytes(decryptedStreamB);

      // Assert A and B are identical
      expect(Encoder.bytesToString(plaintextA)).to.equal(plaintext);
      expect(Encoder.bytesToString(plaintextB)).to.equal(plaintext);
      expect(plaintextA).to.deep.equal(plaintextB);
    });

    it('throws if no matching keyEncryption entry found', async () => {
      const protocolDefinition = {
        protocol  : 'https://example.com/protocol/mismatch-test',
        published : true,
        types     : {
          note: {
            schema      : 'https://example.com/schema/note',
            dataFormats : ['text/plain']
          }
        },
        structure: {
          note: {}
        }
      };

      // Derive and inject encryption keys
      const encryptedProtocol = await Protocols.deriveAndInjectPublicEncryptionKeys(
        protocolDefinition,
        rootKeyId,
        privateJwk
      );

      const alice = await TestDataGenerator.generatePersona();
      const plaintext = 'This is a secret message';
      const plaintextBytes = Encoder.stringToBytes(plaintext);
      const encryptedRecord = await TestDataGenerator.generateProtocolEncryptedRecordsWrite({
        plaintextBytes,
        author                                           : alice,
        protocolDefinition                               : encryptedProtocol,
        protocolPath                                     : 'note',
        encryptSymmetricKeyWithProtocolPathDerivedKey    : true,
        encryptSymmetricKeyWithProtocolContextDerivedKey : false
      });

      // Build a KeyDecrypter with a non-matching rootKeyId
      const keyDecrypter: KeyDecrypter = {
        rootKeyId        : 'did:example:bob#enc', // Wrong key ID
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        decrypt          : async () => {
          throw new Error('Should not be called');
        }
      };

      // Attempt to decrypt — should throw
      await expect(
        Records.decrypt(
          encryptedRecord.message,
          keyDecrypter,
          encryptedRecord.dataStream!
        )
      ).to.be.rejectedWith('Unable to find a symmetric key encrypted using key');
    });
  });

  // Skipped tests — these will be implemented in future PRs
  describe.skip('Agent callback factories (PR 3)', () => {
    it.skip('getEncryptionKeyDeriver() constructs valid EncryptionKeyDeriver', async () => {});
    it.skip('getKeyDecrypter() constructs valid KeyDecrypter', async () => {});
  });
});
