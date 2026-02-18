import { Level } from 'level';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest, spyOn } from 'bun:test';

import type { DidResolver, DidResolverCache } from '../../src/types/did-resolution.js';

import { DidJwk } from '../../src/methods/did-jwk.js';
import { DidResolverCacheLevel } from '../../src/resolver/resolver-cache-level.js';
import { UniversalResolver } from '../../src/resolver/universal-resolver.js';

describe('DidResolverCacheLevel', () => {
  let cache: DidResolverCacheLevel;
  const cacheStoreLocation = '__TESTDATA__/DID_RESOLVERCACHE';

  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    await cache.close();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('uses default options if none are specified', async () => {
      cache = new DidResolverCacheLevel();
      expect(cache).toBeDefined();
    });

    it('should initialize with a custom database', async function() {
      const db = new Level('__TESTDATA__/customLocation');
      const cache = new DidResolverCacheLevel({ db });
      expect(cache).toBeInstanceOf(DidResolverCacheLevel);
      await cache.close();
    });

    it('uses a 15 minute TTL, by default', async () => {
      cache = new DidResolverCacheLevel({ location: cacheStoreLocation });

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

      // Time travel 16 minutes.
      jest.advanceTimersByTime(1000 * 60 * 16);

      // Confirm a cache miss.
      valueInCache = await cache.get(testDid);
      expect(valueInCache).toBeUndefined();
    });

    it('uses a custom TTL, when specified', async () => {
      // Instantiate DID resolution cache with custom TTL of 60 seconds.
      cache = new DidResolverCacheLevel({ ttl: '1m', location: cacheStoreLocation });

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

      // Time travel 61 seconds.
      jest.advanceTimersByTime(1000 * 61);

      // Confirm a cache miss.
      valueInCache = await cache.get(testDid);
      expect(valueInCache).toBeUndefined();
    });
  });

  describe('clear()', () => {
    it('removes all entries from cache', async () => {
      // Instantiate DID resolution cache with default TTL of 15 minutes.
      cache = new DidResolverCacheLevel({ location: cacheStoreLocation });

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

  describe('delete()', () => {
    it('removes specified entry from cache', async () => {
    // Instantiate DID resolution cache with default TTL of 15 minutes.
      cache = new DidResolverCacheLevel({ location: cacheStoreLocation });

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

      // Time travel 14 minutes.
      jest.advanceTimersByTime(1000 * 60 * 14);

      // Confirm cache hit for entry that hasn't yet expired.
      valueInCache = await cache.get(testDid2);
      expect(valueInCache).toEqual(testDidResolutionResult);
    });
  });

  describe('get()', () => {
    it('does not throw an error given DID that is not in the cache', async () => {
      // Instantiate DID resolution cache with default TTL of 15 minutes.
      cache = new DidResolverCacheLevel({ location: cacheStoreLocation });

      const valueInCache = await cache.get('did:method:not-present');
      expect(valueInCache).toBeUndefined();
    });

    it('throws an error if the given DID is null or undefined', async () => {
      // Instantiate DID resolution cache with default TTL of 15 minutes.
      cache = new DidResolverCacheLevel({ location: cacheStoreLocation });

      try {
        // @ts-expect-error - Test invalid input.
        await cache.get(null);
        throw new Error('An error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('Key cannot be null or undefined');
      }

      try {
        // @ts-expect-error - Test invalid input.
        await cache.get(undefined);
        throw new Error('An error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('Key cannot be null or undefined');
      }
    });
  });

  describe('with UniversalResolver', () => {
    let cache: DidResolverCache;
    let didResolver: DidResolver;

    beforeAll(() => {
      cache = new DidResolverCacheLevel();
    });

    beforeEach(async () => {
      await cache.clear();
      const didMethodApis = [DidJwk];
      didResolver = new UniversalResolver({ cache, didResolvers: didMethodApis });
    });

    afterAll(async () => {
      await cache.clear();
    });

    it('should cache miss for the first resolution attempt', async () => {
      const did = 'did:jwk:eyJrdHkiOiJPS1AiLCJjcnYiOiJFZDI1NTE5IiwieCI6IjNFQmFfRUxvczJhbHZMb2pxSVZjcmJLcGlyVlhqNmNqVkQ1djJWaHdMejgifQ';
      // Create a spy on the get method of the cache
      const cacheGetSpy = spyOn(cache, 'get');

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
      // Create a spy on the get method of the cache
      const cacheGetSpy = spyOn(cache, 'get');
      const cacheSetSpy = spyOn(cache, 'set');

      await didResolver.resolve(did);

      // Verify there was a cache miss.
      expect(cacheGetSpy).toHaveBeenCalledTimes(1);
      expect(cacheSetSpy).toHaveBeenCalledTimes(1);

      // Verify the cache returned undefined.
      let getCacheResult = await cacheGetSpy.mock.results[0].value;
      expect(getCacheResult).toBeUndefined();

      // Resolve the same DID again.
      await didResolver.resolve(did);

      // Verify that cache.get() was called.
      expect(cacheGetSpy).toHaveBeenCalled();
      expect(cacheGetSpy).toHaveBeenCalledTimes(2);

      // Verify there was a cache hit this time.
      getCacheResult = await cacheGetSpy.mock.results[1].value;
      expect(getCacheResult).toBeDefined();
      expect(getCacheResult).toHaveProperty('@context');
      expect(getCacheResult).toHaveProperty('didDocument');
      expect(getCacheResult).toHaveProperty('didDocumentMetadata');
      expect(getCacheResult).toHaveProperty('didResolutionMetadata');

      cacheGetSpy.mockRestore();
    });
  });
});
