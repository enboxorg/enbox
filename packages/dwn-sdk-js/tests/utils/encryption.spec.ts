import { ArrayUtility } from '../../src/utils/array.js';
import { DataStream } from '../../src/index.js';
import { Encryption } from '../../src/utils/encryption.js';
import { expect } from 'chai';
import { Secp256k1 } from '../../src/utils/secp256k1.js';
import { etc as Secp256k1Etc } from '@noble/secp256k1';
import { TestDataGenerator } from './test-data-generator.js';

describe('Encryption', () => {
  describe('AES-256-CTR', () => {
    it('should be able to encrypt and decrypt a data stream correctly', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const initializationVector = TestDataGenerator.randomBytes(16);

      const inputBytes = TestDataGenerator.randomBytes(1_000_000);
      const inputStream = DataStream.fromBytes(inputBytes);

      const cipherStream = await Encryption.aes256CtrEncrypt(key, initializationVector, inputStream);

      const plaintextStream = await Encryption.aes256CtrDecrypt(key, initializationVector, cipherStream);
      const plaintextBytes = await DataStream.toBytes(plaintextStream);

      expect(ArrayUtility.byteArraysEqual(inputBytes, plaintextBytes)).to.be.true;
    });

    it('should propagate error on encrypt if the plaintext data stream errors', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const initializationVector = TestDataGenerator.randomBytes(16);

      const simulatedErrorMessage = 'Simulated error';

      // Create a Web ReadableStream that errors after the first chunk
      const mockPlaintextStream = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(TestDataGenerator.randomBytes(1));
          controller.error(new Error(simulatedErrorMessage));
        }
      });

      const cipherStream = await Encryption.aes256CtrEncrypt(key, initializationVector, mockPlaintextStream);

      // Reading the cipher stream should propagate the error
      try {
        await DataStream.toBytes(cipherStream);
        expect.fail('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).to.equal(simulatedErrorMessage);
      }
    });

    it('should propagate error on decrypt if the cipher data stream errors', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const initializationVector = TestDataGenerator.randomBytes(16);

      const simulatedErrorMessage = 'Simulated error';

      // Create a Web ReadableStream that errors after the first chunk
      const mockCipherStream = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(TestDataGenerator.randomBytes(1));
          controller.error(new Error(simulatedErrorMessage));
        }
      });

      const plaintextStream = await Encryption.aes256CtrDecrypt(key, initializationVector, mockCipherStream);

      // Reading the plaintext stream should propagate the error
      try {
        await DataStream.toBytes(plaintextStream);
        expect.fail('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).to.equal(simulatedErrorMessage);
      }
    });
  });

  describe('ECIES-SECP256K1', () => {
    it('should be able to encrypt and decrypt given bytes correctly', async () => {
      const { publicKey, privateKey } = await Secp256k1.generateKeyPairRaw();

      const originalPlaintext = TestDataGenerator.randomBytes(32);
      const encryptionOutput = await Encryption.eciesSecp256k1Encrypt(publicKey, originalPlaintext);
      const decryptionInput = { privateKey, ...encryptionOutput };
      const decryptedPlaintext = await Encryption.eciesSecp256k1Decrypt(decryptionInput);

      expect(ArrayUtility.byteArraysEqual(originalPlaintext, decryptedPlaintext)).to.be.true;
    });

    it('should be able to accept both compressed and uncompressed publicKeys', async () => {
      const originalPlaintext = TestDataGenerator.randomBytes(32);
      const h2b = Secp256k1Etc.hexToBytes;
      // Following test vector was taken from @noble/secp256k1 test file.
      // noble-secp256k1/main/test/vectors/secp256k1/privates.json
      const privateKey = h2b('9c7fc36bc106fd7df5e1078d03e34b9a045892abdd053ec69bfeb22327529f6c');
      const compressed = h2b('03936cb2bd56e681d360bbce6a3a7a1ccbf72f3ab8792edbc45fb08f55b929c588');
      const uncompressed = h2b('04936cb2bd56e681d360bbce6a3a7a1ccbf72f3ab8792edbc45fb08f55b929c588529b8cee53f7eff1da5fc0e6050d952b37d4de5c3b85e952dfe9d9e9b2b3b6eb');
      for (const publicKey of [compressed, uncompressed]) {
        const encrypted = await Encryption.eciesSecp256k1Encrypt(publicKey, originalPlaintext);
        const decrypted = await Encryption.eciesSecp256k1Decrypt({ privateKey, ...encrypted });
        expect(ArrayUtility.byteArraysEqual(originalPlaintext, decrypted)).to.be.true;
      }
    });
  });
});
