import type { UnwrapPromise } from '@enbox/common';

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { DidResource } from '../../src/types/did-core.js';

import { DidJwk } from '../../src/methods/did-jwk.js';
import DidJwkResolveTestVector from '../fixtures/web5-spec-vectors/did_jwk/resolve.json' with { type: 'json' };
import { isDidVerificationMethod } from '../../src/utils.js';
import { UniversalResolver } from '../../src/resolver/universal-resolver.js';

describe('UniversalResolver', () => {
  describe('open()', () => {
    it('delegates to the cache open()', async () => {
      const cache = {
        open   : mock(() => Promise.resolve()),
        close  : mock(() => Promise.resolve()),
        get    : mock(),
        set    : mock(),
        delete : mock(),
        clear  : mock(),
      };
      const resolver = new UniversalResolver({ didResolvers: [DidJwk], cache });
      await resolver.open();
      expect(cache.open).toHaveBeenCalledTimes(1);
    });
  });

  describe('close()', () => {
    it('delegates to the cache close()', async () => {
      const cache = {
        open   : mock(() => Promise.resolve()),
        close  : mock(() => Promise.resolve()),
        get    : mock(),
        set    : mock(),
        delete : mock(),
        clear  : mock(),
      };
      const resolver = new UniversalResolver({ didResolvers: [DidJwk], cache });
      await resolver.close();
      expect(cache.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolve()', () => {
    let didResolver: UniversalResolver;

    beforeEach(() => {
      const didMethodApis = [DidJwk];
      didResolver = new UniversalResolver({ didResolvers: didMethodApis });
    });

    afterEach(() => {
      mock.restore();
    });

    it('returns an invalidDid error if the DID cannot be parsed', async () => {
      const didResolutionResult = await didResolver.resolve('unparseable:did');
      expect(didResolutionResult).toBeDefined();
      expect(didResolutionResult).toHaveProperty('@context');
      expect(didResolutionResult).toHaveProperty('didDocument');
      expect(didResolutionResult).toHaveProperty('didDocumentMetadata');
      expect(didResolutionResult).toHaveProperty('didResolutionMetadata');
      expect(didResolutionResult.didResolutionMetadata).toHaveProperty('error', 'invalidDid');
    });

    it('returns a methodNotSupported error if the DID method is not supported', async () => {
      const didResolutionResult = await didResolver.resolve('did:unknown:abc123');
      expect(didResolutionResult).toBeDefined();
      expect(didResolutionResult).toHaveProperty('@context');
      expect(didResolutionResult).toHaveProperty('didDocument');
      expect(didResolutionResult).toHaveProperty('didDocumentMetadata');
      expect(didResolutionResult).toHaveProperty('didResolutionMetadata');
      expect(didResolutionResult.didResolutionMetadata).toHaveProperty('error', 'methodNotSupported');
    });

    it('should not attempt to cache a DID resolution result if the result is an error', async () => {
      // Create a spy on the cache.set method
      const cacheSetSpy = spyOn(didResolver['cache'], 'set');

      // stub the underlying JWK Resolver to return an error
      const resultWithError = {
        didResolutionMetadata: {
          error: 'anyError'
        },
        didDocument: {
          id: 'did:jwk:123456789abcdefghi'
        },
        didDocumentMetadata: {}
      };

      const didMethodResolver = spyOn(DidJwk, 'resolve').mockResolvedValue(resultWithError);

      // Resolve a DID
      const did = 'did:jwk:123456789abcdefghi';
      await didResolver.resolve(did);

      // expect that the cache.set method was not called
      expect(cacheSetSpy).not.toHaveBeenCalled();
      expect(didMethodResolver).toHaveBeenCalledTimes(1);
    });

    it('should set cache for a DID resolution result if the result is not an error', async () => {
      // Create a spy on the cache.set method
      const cacheSetSpy = spyOn(didResolver['cache'], 'set');

      // stub the underlying JWK Resolver to not return an error
      const result = {
        didResolutionMetadata : {},
        didDocument           : {
          id: 'did:jwk:123456789abcdefghi'
        },
        didDocumentMetadata: {}
      };

      const didMethodResolver = spyOn(DidJwk, 'resolve').mockResolvedValue(result);

      // Resolve a DID
      const did = 'did:jwk:123456789abcdefghi';
      await didResolver.resolve(did);

      // expect that the cache.set was called once
      expect(cacheSetSpy).toHaveBeenCalledTimes(1);
      expect(didMethodResolver).toHaveBeenCalledTimes(1);
    });

    it('pass DID JWK resolve test vectors', async () => {
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

  describe('dereference()', () => {
    let didResolver: UniversalResolver;

    beforeEach(() => {
      const didMethodApis = [DidJwk];
      didResolver = new UniversalResolver({ didResolvers: didMethodApis });
    });

    it('returns a result with contentStream set to null and dereferenceMetadata.error set to invalidDidUrl, if the DID URL is invalid', async () => {
      const result = await didResolver.dereference('abcd123;;;');
      expect(result.contentStream).toBeNull();
      expect(result.dereferencingMetadata.error).toBeDefined();
      expect(result.dereferencingMetadata.error).toBe('invalidDidUrl');
    });

    it('returns a result with contentStream set to null and dereferenceMetadata.error set to invalidDid, if the DID is invalid', async () => {
      const result = await didResolver.dereference('did:jwk:abcd123');
      expect(result.contentStream).toBeNull();
      expect(result.dereferencingMetadata.error).toBeDefined();
      expect(result.dereferencingMetadata.error).toBe('invalidDid');
    });

    it('returns a DID verification method resource as the value of contentStream if found', async () => {
      const did = await DidJwk.create();

      const result = await didResolver.dereference(did.document!.verificationMethod![0].id);
      expect(result.contentStream).not.toBeNull();
      expect(result.dereferencingMetadata.error).toBeUndefined();

      const didResource = result.contentStream;
      expect(isDidVerificationMethod(didResource)).toBe(true);
    });

    it('returns a DID service resource as the value of contentStream if found', async () => {
      // Create an instance of UniversalResolver
      const resolver = new UniversalResolver({ didResolvers: [] });

      // Stub the resolve method
      const mockDidResolutionResult = {
        '@context'  : 'https://w3id.org/did-resolution/v1',
        didDocument : {
          id      : 'did:example:123456789abcdefghi',
          service : [
            {
              id              : '#dwn',
              type            : 'DecentralizedWebNode',
              serviceEndpoint : {
                nodes: [ 'https://enbox-dwn.fly.dev' ]
              }
            }
          ],
        },
        didDocumentMetadata   : {},
        didResolutionMetadata : {}
      };

      const resolveStub = spyOn(resolver, 'resolve').mockResolvedValue(mockDidResolutionResult);

      const testDidUrl = 'did:example:123456789abcdefghi#dwn';
      const result = await resolver.dereference(testDidUrl);

      expect(resolveStub).toHaveBeenCalledTimes(1);
      expect(result.contentStream).toEqual(mockDidResolutionResult.didDocument.service[0]);

      // Restore the original resolve method
      resolveStub.mockRestore();
    });

    it('returns the entire DID document as the value of contentStream if the DID URL contains no fragment', async () => {
      const did = await DidJwk.create();

      const result = await didResolver.dereference(did.uri);
      expect(result.contentStream).not.toBeNull();
      expect(result.dereferencingMetadata.error).toBeUndefined();

      const didResource = result.contentStream as DidResource;
      if (!(!isDidVerificationMethod(didResource) && !isDidVerificationMethod(didResource))) {throw new Error('Expected DidResource to be a DidDocument');}
      expect(didResource['@context']).toBeDefined();
      expect(didResource['@context']).toContain('https://www.w3.org/ns/did/v1');
    });

    it('returns contentStream set to null and dereferenceMetadata.error set to notFound if resource is not found', async () => {
      const did = await DidJwk.create();

      const result = await didResolver.dereference(`${did.uri}#1`);
      expect(result.contentStream).toBeNull();
      expect(result.dereferencingMetadata.error).toBeDefined();
      expect(result.dereferencingMetadata.error).toBe('notFound');
    });
  });
});
