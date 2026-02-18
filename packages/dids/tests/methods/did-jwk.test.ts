import type { DidDocument } from '../../src/types/did-core.js';
import type { Jwk } from '@enbox/crypto';
import type { PortableDid } from '../../src/types/portable-did.js';
import type { UnwrapPromise } from '@enbox/common';

import { DidErrorCode } from '../../src/did-error.js';
import { DidJwk } from '../../src/methods/did-jwk.js';
import DidJwkResolveTestVector from '../fixtures/web5-spec-vectors/did_jwk/resolve.json' with { type: 'json' };
import { LocalKeyManager } from '@enbox/crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';

describe('DidJwk', () => {
  let keyManager: LocalKeyManager;

  beforeAll(() => {
    keyManager = new LocalKeyManager();
  });

  describe('create()', () => {
    it('creates a did:jwk DID', async () => {
      const did = await DidJwk.create({ keyManager, options: { algorithm: 'secp256k1' } });

      expect(did).toHaveProperty('document');
      expect(did).toHaveProperty('getSigner');
      expect(did).toHaveProperty('keyManager');
      expect(did).toHaveProperty('metadata');
      expect(did).toHaveProperty('uri');
      expect(did.uri.startsWith('did:jwk:')).toBe(true);
      expect(did.document.verificationMethod).toHaveLength(1);
    });

    it('uses a default key manager and key generation algorithm if neither is given', async () => {
      // Create a DID with no params.
      let did = await DidJwk.create();
      expect(did.uri.startsWith('did:jwk:')).toBe(true);

      // Create a DID with an empty options object.
      did = await DidJwk.create({ options: {} });
      expect(did.uri.startsWith('did:jwk:')).toBe(true);

      // Create a DID with an empty options object and undefined key manager.
      did = await DidJwk.create({});
      expect(did.uri.startsWith('did:jwk:')).toBe(true);
    });

    it('creates a DID using the top-level algorithm property, if given', async () => {
      const did = await DidJwk.create({ keyManager, options: { algorithm: 'secp256k1' } });

      // Retrieve the public key from the key manager.
      const keyUri = await keyManager.getKeyUri({ key: did.document.verificationMethod![0]!.publicKeyJwk! });
      const publicKey = await keyManager.getPublicKey({ keyUri });

      // Verify the public key is an secp256k1 key.
      expect(publicKey).toHaveProperty('crv', 'secp256k1');
    });

    it('creates a DID using the verificationMethods algorithm property, if given', async () => {
      const did = await DidJwk.create({ keyManager, options: { verificationMethods: [{ algorithm: 'secp256k1' }] } });

      // Retrieve the public key from the key manager.
      const keyUri = await keyManager.getKeyUri({ key: did.document.verificationMethod![0]!.publicKeyJwk! });
      const publicKey = await keyManager.getPublicKey({ keyUri });

      // Verify the public key is an secp256k1 key.
      expect(publicKey).toHaveProperty('crv', 'secp256k1');
    });

    it('creates a DID with an Ed25519 key, by default', async () => {
      const did = await DidJwk.create({ keyManager });

      // Retrieve the public key from the key manager.
      const keyUri = await keyManager.getKeyUri({ key: did.document.verificationMethod![0]!.publicKeyJwk! });
      const publicKey = await keyManager.getPublicKey({ keyUri });

      // Verify the public key is an Ed25519 key.
      expect(publicKey).toHaveProperty('crv', 'Ed25519');
    });

    it('creates a DID using any signature algorithm supported by the provided KMS', async () => {
      expect(
        await DidJwk.create({ keyManager, options: { algorithm: 'secp256k1' } })
      ).toHaveProperty('uri');

      expect(
        await DidJwk.create({ keyManager, options: { algorithm: 'Ed25519' } })
      ).toHaveProperty('uri');
    });

    it('throws an error if both algorithm and verificationMethods are provided', async () => {
      try {
        await DidJwk.create({
          keyManager,
          options: {
            algorithm           : 'Ed25519',
            verificationMethods : [{ algorithm: 'Ed25519' }]
          }
        });
        throw new Error('Expected an error to be thrown.');
      } catch (error: any) {
        expect(error.message).toContain('options are mutually exclusive');
      }
    });

    it('throws an error if zero verificationMethods are given', async () => {
      try {
        await DidJwk.create({ keyManager, options: { verificationMethods: [] } });
        throw new Error('Expected an error to be thrown.');
      } catch (error: any) {
        expect(error.message).toContain('must contain exactly one entry');
      }
    });

    it('throws an error if two or more verificationMethods are given', async () => {
      try {
        await DidJwk.create({
          keyManager,
          options: { verificationMethods: [{ algorithm: 'secp256k1' }, { algorithm: 'Ed25519' }] }
        });
        throw new Error('Expected an error to be thrown.');
      } catch (error: any) {
        expect(error.message).toContain('must contain exactly one entry');
      }
    });
  });

  describe('export()', () => {
    it('returns a single verification method for a DID', async () => {
      // Create a DID to use for the test.
      const did = await DidJwk.create();

      const portableDid = await did.export();

      expect(portableDid.document).toHaveProperty('verificationMethod');
      expect(portableDid.document.verificationMethod).toHaveLength(1);
      expect(portableDid.document.verificationMethod![0]).toHaveProperty('publicKeyJwk');
      expect(portableDid.document.verificationMethod![0]).toHaveProperty('type');
      expect(portableDid.document.verificationMethod![0]).toHaveProperty('id');
      expect(portableDid.document.verificationMethod![0]).toHaveProperty('controller');
      expect(portableDid.privateKeys).toHaveLength(1);
      expect(portableDid.privateKeys![0]).toHaveProperty('crv');
      expect(portableDid.privateKeys![0]).toHaveProperty('x');
      expect(portableDid.privateKeys![0]).toHaveProperty('d');
    });
  });

  describe('getSigningMethod()', () => {
    it('returns the signing method for a DID', async () => {
      // Create a DID to use for the test.
      const did = await DidJwk.create();

      const signingMethod = await DidJwk.getSigningMethod({ didDocument: did.document });

      expect(signingMethod).toHaveProperty('publicKeyJwk');
      expect(signingMethod).toHaveProperty('type', 'JsonWebKey');
      expect(signingMethod).toHaveProperty('id', `${did.uri}#0`);
      expect(signingMethod).toHaveProperty('controller', did.uri);
    });

    it('throws an error if the DID document is missing verification methods', async function () {
      try {
        await DidJwk.getSigningMethod({
          didDocument: { id: 'did:jwk:123' }
        });
        throw new Error('Error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('verification method intended for signing could not be determined');
      }
    });

    it('throws an error if a non-jwk method is used', async function () {
      // Example DID Document with a non-jwk method
      const didDocument: DidDocument = {
        '@context'         : 'https://www.w3.org/ns/did/v1',
        id                 : 'did:example:123',
        verificationMethod : [
          {
            id           : 'did:example:123#0',
            type         : 'JsonWebKey2020',
            controller   : 'did:example:123',
            publicKeyJwk : {} as Jwk
          }
        ],
      };

      await expect(DidJwk.getSigningMethod({ didDocument })).rejects.toThrow('Method not supported: example');
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

    it('returns a BearerDid from the given DID JWK PortableDid', async () => {
      const did = await DidJwk.import({ portableDid });

      expect(did).toHaveProperty('document');
      expect(did).toHaveProperty('getSigner');
      expect(did).toHaveProperty('keyManager');
      expect(did).toHaveProperty('metadata');
      expect(did).toHaveProperty('uri', portableDid.uri);
      expect(did.document).toEqual(portableDid.document);
    });

    it('returns a DID with a getSigner function that can sign and verify data', async () => {
      const did = await DidJwk.import({ portableDid });
      const signer = await did.getSigner();
      const data = new Uint8Array([1, 2, 3]);
      const signature = await signer.sign({ data });
      const isValid = await signer.verify({ data, signature });

      expect(signature).toHaveLength(64);
      expect(isValid).toBe(true);
    });

    it('throws an error if the DID method is not supported', async () => {
      // Change the method to something other than 'jwk'.
      portableDid.uri = 'did:unknown:abc123';

      try {
        await DidJwk.import({ portableDid });
        throw new Error('Expected an error to be thrown.');
      } catch (error: any) {
        expect(error.code).toBe(DidErrorCode.MethodNotSupported);
        expect(error.message).toContain('Method not supported');
      }
    });

    it('throws an error if the DID method cannot be determined', async () => {
      // An unparsable DID URI.
      portableDid.uri = 'did:abc123';

      try {
        await DidJwk.import({ portableDid });
        throw new Error('Expected an error to be thrown.');
      } catch (error: any) {
        expect(error.code).toBe(DidErrorCode.MethodNotSupported);
        expect(error.message).toContain('Method not supported');
      }
    });

    it('throws an error if the DID document contains two or more verification methods', async () => {
      // Add a second verification method to the DID document.
      portableDid.document.verificationMethod?.push(portableDid.document.verificationMethod[0]);

      try {
        await DidJwk.import({ portableDid });
        throw new Error('Expected an error to be thrown.');
      } catch (error: any) {
        expect(error.code).toBe(DidErrorCode.InvalidDidDocument);
        expect(error.message).toContain('DID document must contain exactly one verification method');
      }
    });
  });

  describe('resolve()', () => {
    it(`does not include the 'keyAgreement' relationship when JWK use is 'sig'`, async () => {
      const didWithSigKeyUse = 'did:jwk:eyJjcnYiOiJFZDI1NTE5Iiwia3R5IjoiT0tQIiwieCI6IkMxeUttMzhGYWdLamZRblpjLVFuVEdFYm5wSXUwTE8tTGNIbXZUbE01b0UiLCJraWQiOiJ6d1RvZVFpb0NkbGROV20wZEtZNG95T1dlb1BSRzZ2UG40SW1Hb0M5ekZNIiwiYWxnIjoiRWREU0EiLCJ1c2UiOiJzaWcifQ';

      const resolutionResult = await DidJwk.resolve(didWithSigKeyUse);

      // Verify the DID document does not contain the `keyAgreement` relationship.
      expect(resolutionResult.didDocument).not.toHaveProperty('keyAgreement');
    });

    it(`only specifies 'keyAgreement' relationship when JWK use is 'enc'`, async () => {
      const didWithEncKeyUse = 'did:jwk:eyJrdHkiOiJFQyIsImNydiI6InNlY3AyNTZrMSIsIngiOiJCTVcwQ2lnMjBuTFozTTV5NzkxTEFuY2RyZnl6WS1qTE95UnNVU29tX1g4IiwieSI6IlVrajU4N0VJcVk4cl9jYU1zUmNOZkI4MWxjbGJPNjRmUG4yOXRHOEJWbUkiLCJraWQiOiI5Yi1oUTVlc0NiQlpKNkl5Z0hFZ0Z6T21rUkM1U2QzSlZ5R2FLS0ZGZUVFIiwiYWxnIjoiRVMyNTZLIiwidXNlIjoiZW5jIn0';

      const resolutionResult = await DidJwk.resolve(didWithEncKeyUse);

      // Verrify the DID document does not contain any verification relationships other than `keyAgreement`.
      expect(resolutionResult.didDocument).toHaveProperty('keyAgreement');
      expect(resolutionResult.didDocument).not.toHaveProperty('assertionMethod');
      expect(resolutionResult.didDocument).not.toHaveProperty('authentication');
      expect(resolutionResult.didDocument).not.toHaveProperty('capabilityDelegation');
      expect(resolutionResult.didDocument).not.toHaveProperty('capabilityInvocation');
    });

    it('returns an error due to DID parsing failing', async function () {
      const invalidDidUri = 'did:invalidFormat';
      const resolutionResult = await DidJwk.resolve(invalidDidUri);
      expect(resolutionResult.didResolutionMetadata.error).toBe('invalidDid');
    });

    it('returns an error due to failing to decode the publicKeyJwk', async function () {
      const didUriWithInvalidEncoding = 'did:jwk:invalidEncoding';
      const resolutionResult = await DidJwk.resolve(didUriWithInvalidEncoding);
      expect(resolutionResult.didResolutionMetadata.error).toBe('invalidDid');
    });

    it('returns an error because the DID method is not "jwk"', async function () {
      const didUriWithDifferentMethod = 'did:notjwk:eyJmb28iOiJiYXIifQ';
      const resolutionResult = await DidJwk.resolve(didUriWithDifferentMethod);
      expect(resolutionResult.didResolutionMetadata.error).toBe('methodNotSupported');
    });
  });

  describe('Web5TestVectorsDidJwk', () => {
    it('resolve', async () => {
      type TestVector = {
        description: string;
        input: Parameters<typeof DidJwk.resolve>[0];
        output: UnwrapPromise<ReturnType<typeof DidJwk.resolve>>;
        errors: boolean;
      };

      for (const vector of DidJwkResolveTestVector.vectors as unknown as TestVector[]) {
        const didResolutionResult = await DidJwk.resolve(vector.input);

        expect(didResolutionResult).toEqual(vector.output);
      }
    });
  });
});
