import { beforeEach, describe, expect, it } from 'bun:test';

import { type DidDocument, DidVerificationRelationship } from '../src/types/did-core.js';

import {
  extractDidFragment,
  getServices,
  getVerificationMethodByKey,
  getVerificationMethods,
  getVerificationMethodTypes,
  getVerificationRelationshipsById,
  isDidService,
  isDidVerificationMethod,
  isDwnDidService,
  isPortableDid,
  keyBytesToMultibaseId,
  multibaseIdToKeyBytes,
} from '../src/utils.js';

import DidUtilsGetVerificationMethodByKeyTestVector from './fixtures/test-vectors/utils/get-verification-method-by-key.json' with { type: 'json' };
import DidUtilsgetVerificationMethodsTestVector from './fixtures/test-vectors/utils/get-verification-methods.json' with { type: 'json' };
import DidUtilsGetVerificationMethodTypesTestVector from './fixtures/test-vectors/utils/get-verification-method-types.json' with { type: 'json' };

describe('DID Utils', () => {
  describe('extractDidFragment()', () => {
    it('returns the fragment when a DID string with a fragment is provided', () => {
      const result = extractDidFragment('did:example:123#key-1');
      expect(result).toBe('key-1');
    });

    it('returns the input string when a string without a fragment is provided', () => {
      let result = extractDidFragment('did:example:123');
      expect(result).toBe('did:example:123');

      result = extractDidFragment('0');
      expect(result).toBe('0');
    });

    it('returns undefined for non-string inputs', () => {
      const result = extractDidFragment({ id: 'did:example:123#0', type: 'JsonWebKey' });
      expect(result).toBeUndefined();
    });

    it('returns undefined for array inputs', () => {
      const result = extractDidFragment([{ id: 'did:example:123#0', type: 'JsonWebKey' }]);
      expect(result).toBeUndefined();
    });

    it('returns undefined for undefined inputs', () => {
      const result = extractDidFragment(undefined);
      expect(result).toBeUndefined();
    });

    it('returns undefined for empty string input', () => {
      const result = extractDidFragment('');
      expect(result).toBeUndefined();
    });

    it('returns "0" when input is "did:method:123#0"', () => {
      const result = extractDidFragment('did:method:123#0');
      expect(result).toBe('0');
    });

    it('returns "0" when input is "#0"', () => {
      const result = extractDidFragment('#0');
      expect(result).toBe('0');
    });
  });

  describe('getServices()', () => {
    const didDocument: DidDocument = {
      id      : 'did:example:123',
      service : [
        { id: 'service1', type: 'TypeA', serviceEndpoint: 'http://example.com/service1' },
        { id: 'service2', type: 'TypeB', serviceEndpoint: 'http://example.com/service2' },
        { id: 'service3', type: 'TypeA', serviceEndpoint: 'http://example.com/service3' }
      ]
    };

    it('returns all services if no id or type filter is provided', () => {
      const services = getServices({ didDocument });
      expect(services).toHaveLength(3);
    });

    it('should filter services by id', () => {
      const services = getServices({ didDocument, id: 'service1' });
      expect(services).toHaveLength(1);
      expect(services[0].id).toBe('service1');
    });

    it('returns an empty array if no services are present', () => {
      const emptyDidDocument = {} as DidDocument;
      const services = getServices({ didDocument: emptyDidDocument });
      expect(services).toEqual([]);
    });

    it('should filter services by type', () => {
      const services = getServices({ didDocument, type: 'TypeA' });
      expect(services).toHaveLength(2);
      services.forEach(service => expect(service.type).toBe('TypeA'));
    });

    it('returns an empty array if no service matches the specified type', () => {
      const services = getServices({ didDocument, type: 'NonExistingType' });
      expect(services).toEqual([]);
    });

    it('should filter services by both id and type', () => {
      const services = getServices({ didDocument, id: 'service3', type: 'TypeA' });
      expect(services).toHaveLength(1);
      expect(services[0].id).toBe('service3');
      expect(services[0].type).toBe('TypeA');
    });

    it('returns an empty array if no service matches both the specified id and type', () => {
      const services = getServices({ didDocument, id: 'service3', type: 'TypeB' });
      expect(services).toEqual([]);
    });

    it('returns an empty array if didDocument is null', () => {
      // @ts-expect-error - Testing invalid input
      const services = getServices({ didDocument: null });
      expect(services).toEqual([]);
    });

    it('returns an empty array if didDocument is undefined', () => {
      // @ts-expect-error - Testing invalid input
      const services = getServices({ didDocument: undefined });
      expect(services).toEqual([]);
    });
  });

  describe('getVerificationMethodByKey()', () => {
    type TestVector = {
      description: string;
      input: Parameters<typeof getVerificationMethodByKey>[0];
      output: ReturnType<typeof getVerificationMethodByKey>;
      errors: boolean;
    };

    for (const vector of DidUtilsGetVerificationMethodByKeyTestVector.vectors as unknown as TestVector[]) {
      it(vector.description, async () => {
        let errorOccurred = false;
        try {
          const verificationMethods = await getVerificationMethodByKey(vector.input);

          expect(verificationMethods).toEqual(vector.output);

        } catch { errorOccurred = true; }
        expect(errorOccurred).toBe(vector.errors);
      });
    }
  });

  describe('getVerificationMethods()', () => {
    type TestVector = {
      description: string;
      input: Parameters<typeof getVerificationMethods>[0];
      output: ReturnType<typeof getVerificationMethods>;
      errors: boolean;
    };

    for (const vector of DidUtilsgetVerificationMethodsTestVector.vectors as unknown as TestVector[]) {
      it(vector.description, async () => {
        let errorOccurred = false;
        try {
          const verificationMethods = getVerificationMethods({
            didDocument: vector.input.didDocument as DidDocument
          });

          expect(verificationMethods).toEqual(vector.output);

        } catch { errorOccurred = true; }
        expect(errorOccurred).toBe(vector.errors);
      });
    }
  });

  describe('getVerificationMethodTypes()', () => {
    type TestVector = {
      description: string;
      input: Parameters<typeof getVerificationMethodTypes>[0];
      output: ReturnType<typeof getVerificationMethodTypes>;
      errors: boolean;
    };

    for (const vector of DidUtilsGetVerificationMethodTypesTestVector.vectors as unknown as TestVector[]) {
      it(vector.description, async () => {
        let errorOccurred = false;
        try {
          const types = getVerificationMethodTypes(vector.input);

          expect(types).toEqual(vector.output);

        } catch { errorOccurred = true; }
        expect(errorOccurred).toBe(vector.errors);
      });
    }

    it('returns an empty array if no verification methods are present', () => {
      const emptyDidDocument = {} as DidDocument;
      const types = getVerificationMethodTypes({ didDocument: emptyDidDocument });
      expect(types).toEqual([]);
    });

    it('throws an error when didDocument is not provided', async () => {
      try {
        // @ts-expect-error - Testing invalid input
        getVerificationMethodTypes({ });
        throw new Error('Test failed - error not thrown');
      } catch (error: any) {
        expect(error.message).toContain('parameter missing');
      }
    });
  });

  describe('isDidService', () => {
    it('returns true for a valid DidService object', () => {
      const validService = {
        id              : 'did:example:123#service-1',
        type            : 'OidcService',
        serviceEndpoint : 'https://example.com/oidc'
      };
      expect(isDidService(validService)).toBe(true);
    });

    it('returns false for an object missing the id property', () => {
      const noIdService = {
        type            : 'OidcService',
        serviceEndpoint : 'https://example.com/oidc'
      };
      expect(isDidService(noIdService)).toBe(false);
    });

    it('returns false for an object missing the type property', () => {
      const noTypeService = {
        id              : 'did:example:123#service-1',
        serviceEndpoint : 'https://example.com/oidc'
      };
      expect(isDidService(noTypeService)).toBe(false);
    });

    it('returns false for an object missing the serviceEndpoint property', () => {
      const noEndpointService = {
        id   : 'did:example:123#service-1',
        type : 'OidcService'
      };
      expect(isDidService(noEndpointService)).toBe(false);
    });

    it('returns false for a null object', () => {
      expect(isDidService(null)).toBe(false);
    });

    it('returns false for an undefined object', () => {
      expect(isDidService(undefined)).toBe(false);
    });

    it('returns false for a non-object value', () => {
      expect(isDidService('string')).toBe(false);
      expect(isDidService(123)).toBe(false);
      expect(isDidService(true)).toBe(false);
    });

    it('returns false for an empty object', () => {
      expect(isDidService({})).toBe(false);
    });

    it('returns false for an object with extra properties', () => {
      const extraPropsService = {
        id              : 'did:example:123#service-1',
        type            : 'OidcService',
        serviceEndpoint : 'https://example.com/oidc',
        extraProp       : 'extraValue'
      };
      expect(isDidService(extraPropsService)).toBe(true); // Note: Extra properties do not invalidate a DidService.
    });
  });

  describe('getVerificationRelationshipsById', () => {
    let didDocument: DidDocument;

    beforeEach(() => {
      didDocument = {
        id              : 'did:example:123',
        authentication  : ['did:example:123#auth'],
        assertionMethod : [
          {
            id         : 'did:example:123#assert',
            type       : 'JsonWebKey',
            controller : 'did:example:123'
          }
        ],
        capabilityDelegation: ['did:example:123#key-2'],
      };
    });

    it('should return an empty array if no relationships match the methodId', () => {
      const result = getVerificationRelationshipsById({ didDocument, methodId: '0' });
      expect(result).toEqual([]);
    });

    it('should return matching relationships by direct reference', () => {
      const result = getVerificationRelationshipsById({ didDocument, methodId: 'auth' });
      expect(result).toContain(DidVerificationRelationship.authentication);
    });

    it('should return matching relationships by embedded method', () => {
      const result = getVerificationRelationshipsById({ didDocument, methodId: 'assert' });
      expect(result).toContain(DidVerificationRelationship.assertionMethod);
    });

    it('handles method IDs with or without hash symbol prefix', () => {
      let result = getVerificationRelationshipsById({ didDocument, methodId: 'key-2' });
      expect(result).toContain(DidVerificationRelationship.capabilityDelegation);
      result = getVerificationRelationshipsById({ didDocument, methodId: '#key-2' });
      expect(result).toContain(DidVerificationRelationship.capabilityDelegation);
    });

    it('handles method IDs with a full DID URL', () => {
      const result = getVerificationRelationshipsById({ didDocument, methodId: 'did:example:123#key-2' });
      expect(result).toContain(DidVerificationRelationship.capabilityDelegation);
    });

    it('ignores the DID if the method IDs is a full DID URL', () => {
      // While not technically disallowed, it is not recommended for a verification method in a
      // DID document to reference another DID. If a use case ever arises for this, we can revisit
      // adding support to enable matching method IDs with the same identifier but different DIDs.
      const result = getVerificationRelationshipsById({ didDocument, methodId: 'did:example:456#key-2' });
      expect(result).toContain(DidVerificationRelationship.capabilityDelegation);
    });
  });

  describe('isDwnDidService', () => {
    it('returns true for a DwnDidService without enc/sig (spec-compliant minimal)', () => {
      const minimalDwnService = {
        id              : 'did:example:123#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : 'https://dwn.example.org',
      };
      expect(isDwnDidService(minimalDwnService)).toBe(true);
    });

    it('returns true for a DwnDidService with legacy enc/sig properties', () => {
      const legacyDwnService = {
        id              : 'did:example:123#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : 'https://dwn.example.org',
        enc             : 'did:example:123#key-1',
        sig             : 'did:example:123#key-2'
      };
      expect(isDwnDidService(legacyDwnService)).toBe(true);
    });

    it('returns true with only enc present (no sig)', () => {
      const encOnlyService = {
        id              : 'did:example:123#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : 'https://dwn.example.org',
        enc             : 'did:example:123#key-1'
      };
      expect(isDwnDidService(encOnlyService)).toBe(true);
    });

    it('returns true with only sig present (no enc)', () => {
      const sigOnlyService = {
        id              : 'did:example:123#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : 'https://dwn.example.org',
        sig             : 'did:example:123#key-2'
      };
      expect(isDwnDidService(sigOnlyService)).toBe(true);
    });

    it('returns false for a non-DwnDidService type', () => {
      const nonDwnService = {
        id              : 'did:example:123#service',
        type            : 'SomeOtherType',
        serviceEndpoint : 'https://service.example.org',
      };
      expect(isDwnDidService(nonDwnService)).toBe(false);
    });

    it('returns false for invalid enc property type', () => {
      const invalidEncService = {
        id              : 'did:example:123#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : 'https://dwn.example.org',
        enc             : 123,
      };
      expect(isDwnDidService(invalidEncService)).toBe(false);
    });

    it('returns false for invalid sig property type', () => {
      const invalidSigService = {
        id              : 'did:example:123#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : 'https://dwn.example.org',
        sig             : true
      };
      expect(isDwnDidService(invalidSigService)).toBe(false);
    });

    it('returns false for an array of non-string in enc', () => {
      const arrayEncService = {
        id              : 'did:example:123#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : 'https://dwn.example.org',
        enc             : [123, 'did:example:123#key-1'],
      };
      expect(isDwnDidService(arrayEncService)).toBe(false);
    });

    it('returns false for an array of non-string in sig', () => {
      const arraySigService = {
        id              : 'did:example:123#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : 'https://dwn.example.org',
        sig             : ['did:example:123#key-2', null]
      };
      expect(isDwnDidService(arraySigService)).toBe(false);
    });

    it('returns false for a null object', () => {
      expect(isDwnDidService(null)).toBe(false);
    });

    it('returns false for an undefined object', () => {
      expect(isDwnDidService(undefined)).toBe(false);
    });

    it('returns false for a non-object value', () => {
      expect(isDwnDidService('string')).toBe(false);
      expect(isDwnDidService(123)).toBe(false);
      expect(isDwnDidService(true)).toBe(false);
    });

    it('returns false for an object not adhering to DidService structure', () => {
      const invalidStructureService = {
        id            : 'did:example:123#dwn',
        type          : 'DecentralizedWebNode',
        wrongProperty : 'https://dwn.example.org',
      };
      expect(isDwnDidService(invalidStructureService)).toBe(false);
    });

    it('returns false for an empty object', () => {
      expect(isDwnDidService({})).toBe(false);
    });
  });

  describe('isDidVerificationMethod', () => {
    it('returns true for a valid DidVerificationMethod object', () => {
      const validVerificationMethod = {
        id           : 'did:example:123#0',
        type         : 'JsonWebKey2020',
        controller   : 'did:example:123',
        publicKeyJwk : {}
      };
      expect(isDidVerificationMethod(validVerificationMethod)).toBe(true);
    });

    it('returns false for an object missing the id property', () => {
      const missingId = {
        type         : 'JsonWebKey2020',
        controller   : 'did:example:123',
        publicKeyJwk : {}
      };
      expect(isDidVerificationMethod(missingId)).toBe(false);
    });

    it('returns false for an object missing the type property', () => {
      const missingType = {
        id           : 'did:example:123#0',
        controller   : 'did:example:123',
        publicKeyJwk : {}
      };
      expect(isDidVerificationMethod(missingType)).toBe(false);
    });

    it('returns false for an object missing the controller property', () => {
      const missingController = {
        id           : 'did:example:123#0',
        type         : 'JsonWebKey2020',
        publicKeyJwk : {}
      };
      expect(isDidVerificationMethod(missingController)).toBe(false);
    });

    it('returns false for an object with incorrect property types', () => {
      expect(isDidVerificationMethod({
        id         : 123,
        type       : {},
        controller : false
      })).toBe(false);
      expect(isDidVerificationMethod({
        id         : 'did:example:123',
        type       : {},
        controller : false
      })).toBe(false);
      expect(isDidVerificationMethod({
        id         : 'did:example:123',
        type       : 'JsonWebKey2020',
        controller : false
      })).toBe(false);
    });

    it('returns false for a null object', () => {
      expect(isDidVerificationMethod(null)).toBe(false);
    });

    it('returns false for an undefined object', () => {
      expect(isDidVerificationMethod(undefined)).toBe(false);
    });

    it('returns false for a non-object value', () => {
      expect(isDidVerificationMethod('string')).toBe(false);
      expect(isDidVerificationMethod(123)).toBe(false);
      expect(isDidVerificationMethod(true)).toBe(false);
    });

    it('returns false for an empty object', () => {
      expect(isDidVerificationMethod({})).toBe(false);
    });

    it('returns true for an object with extra properties', () => {
      const extraProps = {
        id           : 'did:example:123#0',
        type         : 'JsonWebKey2020',
        controller   : 'did:example:123',
        publicKeyJwk : {},
        extra        : 'extraValue'
      };
      expect(isDidVerificationMethod(extraProps)).toBe(true);
    });
  });

  describe('keyBytesToMultibaseId()', () => {
    it('returns a multibase encoded string', () => {
      const input = {
        keyBytes       : new Uint8Array(32),
        multicodecName : 'ed25519-pub',
      };
      const encoded = keyBytesToMultibaseId({ keyBytes: input.keyBytes, multicodecName: input.multicodecName });
      expect(typeof encoded).toBe('string');
      expect(encoded.substring(0, 1)).toBe('z');
      expect(encoded.substring(1, 4)).toBe('6Mk');
    });

    it('passes test vectors', () => {
      let input: { keyBytes: Uint8Array, multicodecName: string };
      let output: string;
      let encoded: string;

      // Test Vector 1.
      input = {
        keyBytes       : (new Uint8Array(32)).fill(0),
        multicodecName : 'ed25519-pub',
      };
      output = 'z6MkeTG3bFFSLYVU7VqhgZxqr6YzpaGrQtFMh1uvqGy1vDnP';
      encoded = keyBytesToMultibaseId({ keyBytes: input.keyBytes, multicodecName: input.multicodecName });
      expect(encoded).toBe(output);

      // Test Vector 2.
      input = {
        keyBytes       : (new Uint8Array(32)).fill(1),
        multicodecName : 'ed25519-pub',
      };
      output = 'z6MkeXBLjYiSvqnhFb6D7sHm8yKm4jV45wwBFRaatf1cfZ76';
      encoded = keyBytesToMultibaseId({ keyBytes: input.keyBytes, multicodecName: input.multicodecName });
      expect(encoded).toBe(output);

      // Test Vector 3.
      input = {
        keyBytes       : (new Uint8Array(32)).fill(9),
        multicodecName : 'ed25519-pub',
      };
      output = 'z6Mkf4XhsxSXfEAWNK6GcFu7TyVs21AfUTRjiguqMhNQeDgk';
      encoded = keyBytesToMultibaseId({ keyBytes: input.keyBytes, multicodecName: input.multicodecName });
      expect(encoded).toBe(output);
    });
  });

  describe('multibaseIdToKeyBytes()', () => {
    it('converts secp256k1-pub multibase identifiers', () => {
      const multibaseKeyId = 'zQ3shMrXA3Ah8h5asMM69USP8qRDnPaCLRV3nPmitAXVfWhgp';

      const { keyBytes, multicodecCode, multicodecName } = multibaseIdToKeyBytes({ multibaseKeyId });

      expect(keyBytes).toBeDefined();
      expect(keyBytes).toBeInstanceOf(Uint8Array);
      expect(keyBytes).toHaveLength(33);
      expect(multicodecCode).toBeDefined();
      expect(multicodecCode).toBe(231);
      expect(multicodecName).toBeDefined();
      expect(multicodecName).toBe('secp256k1-pub');
    });

    it('converts ed25519-pub multibase identifiers', () => {
      const multibaseKeyId = 'z6MkizSHspkM891CAnYZis1TJkB4fWwuyVjt4pV93rWPGYwW';

      const { keyBytes, multicodecCode, multicodecName } = multibaseIdToKeyBytes({ multibaseKeyId });

      expect(keyBytes).toBeDefined();
      expect(keyBytes).toBeInstanceOf(Uint8Array);
      expect(keyBytes).toHaveLength(32);
      expect(multicodecCode).toBeDefined();
      expect(multicodecCode).toBe(237);
      expect(multicodecName).toBeDefined();
      expect(multicodecName).toBe('ed25519-pub');
    });

    it('converts x25519-pub multibase identifiers', () => {
      const multibaseKeyId = 'z6LSfsF6tQA7j56WSzNPT4yrzZprzGEK8137DMeAVLgGBJEz';

      const { keyBytes, multicodecCode, multicodecName } = multibaseIdToKeyBytes({ multibaseKeyId });

      expect(keyBytes).toBeDefined();
      expect(keyBytes).toBeInstanceOf(Uint8Array);
      expect(keyBytes).toHaveLength(32);
      expect(multicodecCode).toBeDefined();
      expect(multicodecCode).toBe(236);
      expect(multicodecName).toBeDefined();
      expect(multicodecName).toBe('x25519-pub');
    });

    it('throws an error for an invalid multibase identifier', async () => {
      try {
        multibaseIdToKeyBytes({ multibaseKeyId: 'z6Mkiz' });
      } catch (error: any) {
        expect(error.message).toContain('Invalid multibase identifier');
      }
    });
  });

  describe('isPortableDid()', () => {
    it('returns true for a valid PortableDid object', () => {
      const portableDid = {
        uri      : 'did:jwk:abc123',
        document : { id: 'did:jwk:abc123' },
        metadata : {},
      };
      expect(isPortableDid(portableDid)).toBe(true);
    });

    it('returns true when keyManager is undefined', () => {
      const portableDid = {
        uri        : 'did:jwk:abc123',
        document   : { id: 'did:jwk:abc123' },
        metadata   : {},
        keyManager : undefined,
      };
      expect(isPortableDid(portableDid)).toBe(true);
    });

    it('returns false when keyManager is present', () => {
      const bearerDid = {
        uri        : 'did:jwk:abc123',
        document   : { id: 'did:jwk:abc123' },
        metadata   : {},
        keyManager : {},
      };
      expect(isPortableDid(bearerDid)).toBe(false);
    });

    it('returns false for non-object values', () => {
      expect(isPortableDid(null)).toBe(false);
      expect(isPortableDid(undefined)).toBe(false);
      expect(isPortableDid('string')).toBe(false);
      expect(isPortableDid(42)).toBe(false);
    });

    it('returns false when required properties are missing', () => {
      expect(isPortableDid({ uri: 'did:example:123' })).toBe(false);
      expect(isPortableDid({ uri: 'did:example:123', document: {} })).toBe(false);
      expect(isPortableDid({ document: {}, metadata: {} })).toBe(false);
    });
  });
});
