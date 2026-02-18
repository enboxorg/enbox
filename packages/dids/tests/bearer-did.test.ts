import type { CryptoApi } from '@enbox/crypto';

import { LocalKeyManager } from '@enbox/crypto';
import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { PortableDid } from '../src/types/portable-did.js';

import { BearerDid } from '../src/bearer-did.js';

describe('BearerDid', () => {
  let portableDid: PortableDid;

  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    portableDid = {
      uri      : 'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ',
      document : {
        '@context': [
          'https://www.w3.org/ns/did/v1',
          'https://w3id.org/security/suites/jws-2020/v1',
        ],
        id                 : 'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ',
        verificationMethod : [
          {
            id           : 'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ#0',
            type         : 'JsonWebKey2020',
            controller   : 'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ',
            publicKeyJwk : {
              crv : 'Ed25519',
              kty : 'OKP',
              x   : 'o40shZrsco-CfEqk6mFsXfcP94ly3Az3gm84PzAUsXo',
              kid : 'BDp0xim82GswlxnPV8TPtBdUw80wkGIF8gjFbw1x5iQ',
              alg : 'EdDSA',
            },
          },
        ],
        authentication: [
          'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ#0',
        ],
        assertionMethod: [
          'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ#0',
        ],
        capabilityInvocation: [
          'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ#0',
        ],
        capabilityDelegation: [
          'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ#0',
        ],
        keyAgreement: [
          'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ#0',
        ],
      },
      metadata: {
      },
      privateKeys: [
        {
          crv : 'Ed25519',
          d   : '628WwXicdWc0BULN1JG_ybSrhwWWnz9NFwxbG09Ecr0',
          kty : 'OKP',
          x   : 'o40shZrsco-CfEqk6mFsXfcP94ly3Az3gm84PzAUsXo',
          kid : 'BDp0xim82GswlxnPV8TPtBdUw80wkGIF8gjFbw1x5iQ',
          alg : 'EdDSA',
        },
      ],
    };
  });

  describe('export()', () => {
    it('returns a PortableDid', async () => {
      // Create a DID to use for the test.
      const did = await BearerDid.import({ portableDid });

      const exportedPortableDid = await did.export();

      expect(exportedPortableDid).toHaveProperty('uri', portableDid.uri);
      expect(exportedPortableDid).toHaveProperty('document');
      expect(exportedPortableDid).toHaveProperty('metadata');
      expect(exportedPortableDid).toHaveProperty('privateKeys');

      expect(exportedPortableDid.document.verificationMethod).toHaveLength(1);
      expect(exportedPortableDid.document).toEqual(portableDid.document);
    });

    it('exported PortableDid does not include private keys  if the key manager does not support exporting keys', async () => {
      // Create a key manager that does not support exporting keys.
      const keyManagerWithoutExport: CryptoApi = {
        digest       : mock(async () => undefined) as any,
        generateKey  : mock(async () => undefined) as any,
        getKeyUri    : mock(async () => undefined) as any,
        getPublicKey : mock(async () => undefined) as any,
        sign         : mock(async () => undefined) as any,
        verify       : mock(async () => undefined) as any,
      };

      const did = await BearerDid.import({ portableDid });
      did.keyManager = keyManagerWithoutExport;

      const exportedPortableDid = await did.export();

      expect(exportedPortableDid).not.toHaveProperty('privateKeys');
    });

    it('throws an error if the DID document lacks any verification methods', async () => {
      const did = await BearerDid.import({ portableDid });

      // Delete the verification method property from the DID document.
      delete did.document.verificationMethod;

      try {
        await did.export();
        throw new Error('Error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('is missing verification methods');
      }
    });

    it('throws an error if verification methods lack a public key', async () => {
      const did = await BearerDid.import({ portableDid });

      // Delete the verification method property from the DID document.
      delete did.document.verificationMethod![0].publicKeyJwk;

      try {
        await did.export();
        throw new Error('Error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('does not contain a public key');
      }
    });
  });

  describe('getSigner()', () => {
    let keyManagerMock: any;

    beforeEach(() => {
      // Mock for CryptoApi
      keyManagerMock = {
        digest       : mock(async () => undefined),
        generateKey  : mock(async () => undefined),
        getKeyUri    : mock(async () => `urn:jwk${portableDid.document.verificationMethod![0].publicKeyJwk!.kid}`),
        getPublicKey : mock(async () => portableDid.document.verificationMethod![0].publicKeyJwk!),
        importKey    : mock(async () => `urn:jwk${portableDid.document.verificationMethod![0].publicKeyJwk!.kid}`),
        sign         : mock(async () => new Uint8Array(64).fill(0)),
        verify       : mock(async () => true),
      };
    });

    it('returns a signer with sign and verify functions', async () => {
      const did = await BearerDid.import({
        portableDid,
        keyManager: keyManagerMock
      });
      const signer = await did.getSigner();

      expect(typeof signer).toBe('object');
      expect(signer).toHaveProperty('sign');
      expect(typeof signer.sign).toBe('function');
      expect(signer).toHaveProperty('verify');
      expect(typeof signer.verify).toBe('function');
    });

    it('handles public keys that do not contain an "alg" property', async () => {
      const did = await BearerDid.import({
        portableDid,
        keyManager: keyManagerMock
      });

      const { alg, ...publicKeyWithoutAlg } = portableDid.document.verificationMethod![0].publicKeyJwk!;
      keyManagerMock.getPublicKey = mock(async () => publicKeyWithoutAlg);

      const signer = await did.getSigner();

      expect(signer).toHaveProperty('algorithm', 'EdDSA');
    });

    it('sign function should call keyManager.sign with correct parameters', async () => {
      const did = await BearerDid.import({
        portableDid,
        keyManager: keyManagerMock
      });
      const signer = await did.getSigner();
      const dataToSign = new Uint8Array([0x00, 0x01]);

      await signer.sign({ data: dataToSign });

      expect(keyManagerMock.sign).toHaveBeenCalledTimes(1);
      expect(keyManagerMock.sign).toHaveBeenCalledWith(expect.objectContaining({ data: dataToSign }));
    });

    it('verify function should call keyManager.verify with correct parameters', async () => {
      const did = await BearerDid.import({
        portableDid,
        keyManager: keyManagerMock
      });
      const signer = await did.getSigner();
      const dataToVerify = new Uint8Array([0x00, 0x01]);
      const signature = new Uint8Array([0x01, 0x02]);

      await signer.verify({ data: dataToVerify, signature });

      expect(keyManagerMock.verify).toHaveBeenCalledTimes(1);
      expect(keyManagerMock.verify).toHaveBeenCalledWith(expect.objectContaining({ data: dataToVerify, signature }));
    });

    it('uses the provided methodId to fetch the public key', async () => {
      const methodId = '0';
      const publicKey = portableDid.document.verificationMethod![0].publicKeyJwk!;

      const did = await BearerDid.import({
        portableDid,
        keyManager: keyManagerMock
      });
      const signer = await did.getSigner({ methodId });

      expect(typeof signer).toBe('object');
      expect(keyManagerMock.getKeyUri).toHaveBeenCalledWith({ key: publicKey });
    });

    it('handles undefined params', async () => {
      const did = await BearerDid.import({
        portableDid,
        keyManager: keyManagerMock
      });

      // Simulate the creation of a signer with undefined params
      // @ts-expect-error - Testing the method with undefined params
      const signer = await did.getSigner({ });

      // Note: Since this test does not interact with an actual keyManager, it primarily ensures
      // that the method doesn't break with undefined params.
      expect(signer).toHaveProperty('sign');
      expect(signer).toHaveProperty('verify');
    });

    it('throws an error if the public key contains an unknown "crv" property', async () => {
      const did = await BearerDid.import({
        portableDid,
        keyManager: keyManagerMock
      });

      const { alg, ...publicKeyWithoutAlg } = portableDid.document.verificationMethod![0].publicKeyJwk!;
      publicKeyWithoutAlg.crv = 'unknown-crv';
      keyManagerMock.getPublicKey = mock(async () => publicKeyWithoutAlg);

      try {
        await did.getSigner();
        throw new Error('Error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('crv=unknown-crv');
        expect(error.message).toContain('Unable to determine algorithm');
      }
    });

    it('throws an error if the methodId does not match any verification method in the DID Document', async () => {
      const methodId = 'nonexistent-id';

      const did = await BearerDid.import({
        portableDid,
        keyManager: keyManagerMock
      });

      try {
        await did.getSigner({ methodId });
        throw new Error('Error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('method intended for signing could not be determined');
      }
    });

    it('throws an error if the DID Document does not contain an assertionMethod property', async () => {
      delete portableDid.document.assertionMethod;

      const did = await BearerDid.import({
        portableDid,
        keyManager: keyManagerMock
      });

      try {
        await did.getSigner();
        throw new Error('Error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('method intended for signing could not be determined');
      }
    });

    it('throws an error if the DID Document does not any verification methods', async () => {
      const did = await BearerDid.import({
        portableDid,
        keyManager: keyManagerMock
      });

      did.document.verificationMethod = undefined;

      try {
        await did.getSigner();
        throw new Error('Error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('method intended for signing could not be determined');
      }
    });

    it('throws an error if the DID Document contains an embedded assertionMethod verification method', async () => {
      portableDid.document.assertionMethod = [
        {
          'type'         : 'JsonWebKey2020',
          'id'           : 'did:jwk:eyJrdHkiOiJFQyIsInVzZSI6InNpZyIsImNydiI6InNlY3AyNTZrMSIsImtpZCI6ImkzU1BSQnRKS292SEZzQmFxTTkydGk2eFFDSkxYM0U3WUNld2lIVjJDU2ciLCJ4IjoidmRyYnoyRU96dmJMRFZfLWtMNGVKdDdWSS04VEZaTm1BOVlnV3p2aGg3VSIsInkiOiJWTEZxUU1aUF9Bc3B1Y1hvV1gyLWJHWHBBTzFmUTVMbjE5VjVSQXhyZ3ZVIiwiYWxnIjoiRVMyNTZLIn0#0',
          'controller'   : 'did:jwk:eyJrdHkiOiJFQyIsInVzZSI6InNpZyIsImNydiI6InNlY3AyNTZrMSIsImtpZCI6ImkzU1BSQnRKS292SEZzQmFxTTkydGk2eFFDSkxYM0U3WUNld2lIVjJDU2ciLCJ4IjoidmRyYnoyRU96dmJMRFZfLWtMNGVKdDdWSS04VEZaTm1BOVlnV3p2aGg3VSIsInkiOiJWTEZxUU1aUF9Bc3B1Y1hvV1gyLWJHWHBBTzFmUTVMbjE5VjVSQXhyZ3ZVIiwiYWxnIjoiRVMyNTZLIn0',
          'publicKeyJwk' : {
            'kty' : 'EC',
            'use' : 'sig',
            'crv' : 'secp256k1',
            'kid' : 'i3SPRBtJKovHFsBaqM92ti6xQCJLX3E7YCewiHV2CSg',
            'x'   : 'vdrbz2EOzvbLDV_-kL4eJt7VI-8TFZNmA9YgWzvhh7U',
            'y'   : 'VLFqQMZP_AspucXoWX2-bGXpAO1fQ5Ln19V5RAxrgvU',
            'alg' : 'ES256K'
          }
        }
      ];

      const did = await BearerDid.import({
        portableDid,
        keyManager: keyManagerMock
      });

      try {
        await did.getSigner();
        throw new Error('Error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('method intended for signing could not be determined');
      }
    });

    it('throws an error if the key is missing in the key manager', async () => {
      const did = await BearerDid.import({ portableDid });

      // Replace the key manager with one that does not contain the keys for the DID.
      did.keyManager = new LocalKeyManager();

      try {
        await did.getSigner();
        throw new Error('Error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('Key not found');
      }
    });
  });

  describe('import()', () => {
    let portableDid: PortableDid;

    beforeEach(() => {
      // Define a DID to use for the test.
      portableDid = {
        uri      : 'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ',
        document : {
          '@context': [
            'https://www.w3.org/ns/did/v1',
            'https://w3id.org/security/suites/jws-2020/v1',
          ],
          id                 : 'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ',
          verificationMethod : [
            {
              id           : 'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ#0',
              type         : 'JsonWebKey2020',
              controller   : 'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ',
              publicKeyJwk : {
                crv : 'Ed25519',
                kty : 'OKP',
                x   : 'o40shZrsco-CfEqk6mFsXfcP94ly3Az3gm84PzAUsXo',
                kid : 'BDp0xim82GswlxnPV8TPtBdUw80wkGIF8gjFbw1x5iQ',
                alg : 'EdDSA',
              },
            },
          ],
          authentication: [
            'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ#0',
          ],
          assertionMethod: [
            'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ#0',
          ],
          capabilityInvocation: [
            'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ#0',
          ],
          capabilityDelegation: [
            'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ#0',
          ],
          keyAgreement: [
            'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6Im80MHNoWnJzY28tQ2ZFcWs2bUZzWGZjUDk0bHkzQXozZ204NFB6QVVzWG8iLCJraWQiOiJCRHAweGltODJHc3dseG5QVjhUUHRCZFV3ODB3a0dJRjhnakZidzF4NWlRIiwiYWxnIjoiRWREU0EifQ#0',
          ],
        },
        metadata: {
        },
        privateKeys: [
          {
            crv : 'Ed25519',
            d   : '628WwXicdWc0BULN1JG_ybSrhwWWnz9NFwxbG09Ecr0',
            kty : 'OKP',
            x   : 'o40shZrsco-CfEqk6mFsXfcP94ly3Az3gm84PzAUsXo',
            kid : 'BDp0xim82GswlxnPV8TPtBdUw80wkGIF8gjFbw1x5iQ',
            alg : 'EdDSA',
          },
        ],
      };
    });

    it('throws an error if the DID document lacks any verification methods', async () => {
      // Delete the verification method property from the DID document.
      delete portableDid.document.verificationMethod;

      try {
        await BearerDid.import({ portableDid });
        throw new Error('Error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('verification method is required but 0 were given');
      }
    });

    it('throws an error if the DID document does not contain a public key', async () => {
      // Delete the public key from the DID document.
      delete portableDid.document.verificationMethod![0].publicKeyJwk;

      try {
        await BearerDid.import({ portableDid });
        throw new Error('Error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('does not contain a public key');
      }
    });

    it('throws an error if no private keys are given and the key manager does not contain the keys', async () => {
      // Delete the private keys from the portable DID to trigger the error.
      delete portableDid.privateKeys;

      try {
        await BearerDid.import({ portableDid });
        throw new Error('Expected an error to be thrown.');
      } catch (error: any) {
        expect(error.message).toContain('Key not found');
      }
    });

    it('does not attempt to import a key that is already in the key manager', async () => {

      // create a key manager
      const keyManager = new LocalKeyManager();

      // Import one of the private keys into the key manager
      const privateKey = portableDid.privateKeys![0];
      await keyManager.importKey({ key: privateKey });

      // spy on the importKey method
      const importKeySpy = spyOn(keyManager, 'importKey');

      // attempt to import the BearerDid with the key manager
      const did = await BearerDid.import({ portableDid, keyManager });
      expect(did.uri).toBe(portableDid.uri);
      expect(importKeySpy).not.toHaveBeenCalled();
    });
  });
});
