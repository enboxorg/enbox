import type { DidResolverCache } from '../../src/types/did-resolution.js';

import { DidJwk } from '../../src/methods/did-jwk.js';
import { DidResolverCacheMemory } from '../../src/resolver/resolver-cache-memory.js';
import { UniversalResolver } from '../../src/resolver/universal-resolver.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

// Helper function to pause execution for a specified amount of time (in milliseconds).
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('DidResolverCacheMemory', () => {
  let cache: DidResolverCacheMemory;

  describe('open()', () => {
    it('is a no-op and resolves without error', async () => {
      cache = new DidResolverCacheMemory();
      await expect(cache.open()).resolves.toBeUndefined();
    });
  });

  describe('constructor', () => {
    it('uses default options if none are specified', async () => {
      cache = new DidResolverCacheMemory();
      expect(cache).toBeDefined();
    });

    it('uses a 15 minute TTL, by default', async () => {
      cache = new DidResolverCacheMemory();

      const testDid = 'did:example:alice';

      const testDidResolutionResult = {
        didResolutionMetadata : {},
        didDocument           : { id: 'abc123' },
        didDocumentMetadata   : {}
      };

      // Write an entry into the cache.
      await cache.set(testDid, testDidResolutionResult);

      // @ts-expect-error - Accessing private variable for testing purposes.
      expect(cache.cache.getRemainingTTL(testDid)).toBeGreaterThanOrEqual(1000 * 60 * 15 - 25);
      // @ts-expect-error - Accessing private variable for testing purposes.
      expect(cache.cache.getRemainingTTL(testDid)).toBeLessThan(1000 * 60 * 15 + 25);
    });

    it('uses a custom TTL, when specified', async () => {
      // Instantiate DID resolution cache with custom TTL of 5 milliseconds.
      cache = new DidResolverCacheMemory({ ttl: '5' });

      const testDid = 'did:example:alice';

      const testDidResolutionResult = {
        didResolutionMetadata : {},
        didDocument           : { id: 'abc123' },
        didDocumentMetadata   : {}
      };

      // Write an entry into the cache.
      await cache.set(testDid, testDidResolutionResult);

      // Confirm a cache hit.
      let valueInCache = await cache.get(testDid);
      expect(valueInCache).toEqual(testDidResolutionResult);

      // Sleep for 10 milliseconds.
      await sleep(10);

      // Confirm a cache miss.
      valueInCache = await cache.get(testDid);
      expect(valueInCache).toBeUndefined();
    });
  });

  describe('clear()', () => {
    it('removes all entries from cache', async () => {
      cache = new DidResolverCacheMemory();

      const testDid1 = 'did:example:alice';
      const testDid2 = 'did:example:bob';

      const testDidResolutionResult = {
        didResolutionMetadata : {},
        didDocument           : { id: 'abc123' },
        didDocumentMetadata   : {}
      };

      await cache.set(testDid1, testDidResolutionResult);
      await cache.set(testDid2, testDidResolutionResult);

      await cache.clear();

      let valueInCache = await cache.get(testDid1);
      expect(valueInCache).toBeUndefined();
      valueInCache = await cache.get(testDid2);
      expect(valueInCache).toBeUndefined();
    });
  });

  describe('close()', () => {
    it('is a no-op', async () => {
      cache = new DidResolverCacheMemory();

      const testDid1 = 'did:example:alice';

      const testDidResolutionResult = {
        didResolutionMetadata : {},
        didDocument           : { id: 'abc123' },
        didDocumentMetadata   : {}
      };

      await cache.set(testDid1, testDidResolutionResult);

      await cache.close();

      const valueInCache = await cache.get(testDid1);
      expect(valueInCache).toEqual(testDidResolutionResult);
    });
  });

  describe('delete()', () => {
    it('removes specified entry from cache', async () => {
      cache = new DidResolverCacheMemory();

      const testDid1 = 'did:example:alice';
      const testDid2 = 'did:example:bob';

      const testDidResolutionResult = {
        didResolutionMetadata : {},
        didDocument           : { id: 'abc123' },
        didDocumentMetadata   : {}
      };

      await cache.set(testDid1, testDidResolutionResult);
      await cache.set(testDid2, testDidResolutionResult);

      await cache.delete(testDid1);

      // Confirm cache miss for deleted entry.
      let valueInCache = await cache.get(testDid1);
      expect(valueInCache).toBeUndefined();

      // Confirm cache hit for entry that hasn't yet expired.
      valueInCache = await cache.get(testDid2);
      expect(valueInCache).toEqual(testDidResolutionResult);
    });
  });

  describe('get()', () => {
    it('does not throw an error given DID that is not in the cache', async () => {
      cache = new DidResolverCacheMemory();

      const valueInCache = await cache.get('did:method:not-present');
      expect(valueInCache).toBeUndefined();
    });

    it('throws an error if the given DID is null or undefined', async () => {
      cache = new DidResolverCacheMemory();

      try {
        // @ts-expect-error - Test invalid input.
        await cache.get(null);
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('Key cannot be null or undefined');
      }

      try {
        // @ts-expect-error - Test invalid input.
        await cache.get(undefined);
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('Key cannot be null or undefined');
      }
    });
  });

  describe('with DidResolver', () => {
    let resolverCache: DidResolverCache;
    let didResolver: UniversalResolver;

    beforeAll(() => {
      resolverCache = new DidResolverCacheMemory();
    });

    beforeEach(async () => {
      await resolverCache.clear();
      const didMethodApis = [DidJwk];
      didResolver = new UniversalResolver({ cache: resolverCache, didResolvers: didMethodApis });
    });

    afterAll(async () => {
      await resolverCache.clear();
    });

    it('should cache miss for the first resolution attempt', async () => {
      const did = 'did:jwk:eyJrdHkiOiJPS1AiLCJjcnYiOiJFZDI1NTE5IiwieCI6IjNFQmFfRUxvczJhbHZMb2pxSVZjcmJLcGlyVlhqNmNqVkQ1djJWaHdMejgifQ';
      const cacheGetSpy = spyOn(resolverCache, 'get');

      await didResolver.resolve(did);

      // Verify that cache.get() was called.
      expect(cacheGetSpy).toHaveBeenCalled();

      // Verify the cache returned undefined.
      const getCacheResult = await cacheGetSpy.mock.results[0].value;
      expect(getCacheResult).toBeUndefined();

      cacheGetSpy.mockRestore();
    });

    it('should cache hit for the second resolution attempt', async () => {
      const did = 'did:jwk:eyJrdHkiOiJPS1AiLCJjcnYiOiJFZDI1NTE5IiwieCI6IjNFQmFfRUxvczJhbHZMb2pxSVZjcmJLcGlyVlhqNmNqVkQ1djJWaHdMejgifQ';
      const cacheGetSpy = spyOn(resolverCache, 'get');
      const cacheSetSpy = spyOn(resolverCache, 'set');

      await didResolver.resolve(did);

      // Verify there was a cache miss.
      expect(cacheGetSpy).toHaveBeenCalledTimes(1);
      expect(cacheSetSpy).toHaveBeenCalledTimes(1);

      // Verify the cache returned undefined.
      let getCacheResult = await cacheGetSpy.mock.results[0].value;
      expect(getCacheResult).toBeUndefined();

      // Resolve the same DID again.
      await didResolver.resolve(did);

      // Verify that cache.get() was called twice.
      expect(cacheGetSpy).toHaveBeenCalledTimes(2);

      // Verify there was a cache hit this time.
      getCacheResult = await cacheGetSpy.mock.results[1].value;
      expect(getCacheResult).toBeDefined();
      expect(getCacheResult).toHaveProperty('@context');
      expect(getCacheResult).toHaveProperty('didDocument');
      expect(getCacheResult).toHaveProperty('didDocumentMetadata');
      expect(getCacheResult).toHaveProperty('didResolutionMetadata');

      cacheGetSpy.mockRestore();
      cacheSetSpy.mockRestore();
    });
  });
});
