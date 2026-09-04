import { Level } from 'level';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { DidResolutionResult } from '../../src/types/did-core.js';
import type { DidResolver, DidResolverCache } from '../../src/types/did-resolution.js';

import { DidJwk } from '../../src/methods/did-jwk.js';
import { DidResolverCacheLevel } from '../../src/resolver/resolver-cache-level.js';
import { UniversalResolver } from '../../src/resolver/universal-resolver.js';

describe('DidResolverCacheLevel', () => {
  let cache: DidResolverCacheLevel;
  const cacheStoreLocation = '__TESTDATA__/DID_RESOLVERCACHE';

  afterEach(async () => {
    await cache.close();
  });

  describe('open()', () => {
    it('opens the underlying LevelDB store', async () => {
      cache = new DidResolverCacheLevel({ location: cacheStoreLocation });
      await expect(cache.open()).resolves.toBeUndefined();
    });

    it('is a safe no-op when called on an already-open store', async () => {
      cache = new DidResolverCacheLevel({ location: cacheStoreLocation });
      await cache.open();
      await expect(cache.open()).resolves.toBeUndefined();
    });
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

      // Simulate time travel 16 minutes by advancing Date.now().
      const realNow = Date.now;
      Date.now = (): number => realNow() + 1000 * 60 * 16;

      try {
        // Confirm a cache miss.
        valueInCache = await cache.get(testDid);
        expect(valueInCache).toBeUndefined();
        expect(await cache.getRetained(testDid)).toEqual(testDidResolutionResult);
      } finally {
        Date.now = realNow;
      }
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

      // Simulate time travel 61 seconds by advancing Date.now().
      const realNow = Date.now;
      Date.now = (): number => realNow() + 1000 * 61;

      try {
        // Confirm a cache miss.
        valueInCache = await cache.get(testDid);
        expect(valueInCache).toBeUndefined();
        expect(await cache.getRetained(testDid)).toEqual(testDidResolutionResult);
      } finally {
        Date.now = realNow;
      }
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

      // Confirm cache hit for entry that hasn't yet expired (no time travel needed).
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

  describe('retention', () => {
    const resolution = (didUri: string): DidResolutionResult => ({
      didResolutionMetadata : {},
      didDocument           : { id: didUri },
      didDocumentMetadata   : {},
    });

    it('evicts an unpinned result after it remains unused for maxIdle', async () => {
      const nowSpy = spyOn(Date, 'now').mockReturnValue(1_000);
      cache = new DidResolverCacheLevel({
        location      : '__TESTDATA__/DID_RESOLVERCACHE_IDLE',
        maxIdle       : '1m',
        touchInterval : '1ms',
      });
      await cache.clear();
      const did = 'did:example:idle';
      await cache.set(did, resolution(did));

      try {
        nowSpy.mockReturnValue(61_000);
        expect(await cache.getRetained(did)).toBeUndefined();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('persists renewed idle retention across cache reopen', async () => {
      const nowSpy = spyOn(Date, 'now').mockReturnValue(1_000);
      const location = '__TESTDATA__/DID_RESOLVERCACHE_TOUCH';
      const options = { location, maxIdle: '1m', touchInterval: '1ms' };
      const did = 'did:example:active';
      const result = resolution(did);
      cache = new DidResolverCacheLevel(options);
      await cache.clear();
      await cache.set(did, result);

      try {
        nowSpy.mockReturnValue(31_000);
        expect(await cache.getRetained(did)).toEqual(result);
        await cache.close();

        nowSpy.mockReturnValue(80_000);
        cache = new DidResolverCacheLevel(options);
        await cache.open();
        expect(await cache.getRetained(did)).toEqual(result);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('evicts the least-recently-used result when the byte budget is exceeded', async () => {
      const nowSpy = spyOn(Date, 'now').mockReturnValue(1_000);
      const didA = 'did:example:aaaa';
      const didB = 'did:example:bbbb';
      const didC = 'did:example:cccc';
      const bytesPerEntry = new TextEncoder().encode(
        didA + JSON.stringify({ ttlMillis: 1_000 + 15 * 60_000, value: resolution(didA) })
      ).byteLength;
      cache = new DidResolverCacheLevel({
        location      : '__TESTDATA__/DID_RESOLVERCACHE_LRU',
        maxBytes      : bytesPerEntry * 2,
        touchInterval : '1ms',
      });
      await cache.clear();

      try {
        await cache.set(didA, resolution(didA));
        nowSpy.mockReturnValue(2_000);
        await cache.set(didB, resolution(didB));
        nowSpy.mockReturnValue(3_000);
        await cache.getRetained(didA);
        nowSpy.mockReturnValue(4_000);
        await cache.set(didC, resolution(didC));

        expect(await cache.getRetained(didA)).toEqual(resolution(didA));
        expect(await cache.getRetained(didB)).toBeUndefined();
        expect(await cache.getRetained(didC)).toEqual(resolution(didC));
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('updates a pinned result without making it eligible for eviction', async () => {
      const nowSpy = spyOn(Date, 'now').mockReturnValue(1_000);
      const location = '__TESTDATA__/DID_RESOLVERCACHE_PINNED';
      const options = { location, maxBytes: 1, maxIdle: '1m' };
      const pinnedDid = 'did:example:pinned';
      const pinnedResult = resolution(pinnedDid);
      const refreshedResult = {
        ...pinnedResult,
        didDocumentMetadata: { versionId: '2' },
      };
      cache = new DidResolverCacheLevel(options);
      await cache.clear();
      await cache.pin(pinnedDid, pinnedResult);
      await cache.set(pinnedDid, refreshedResult);
      await cache.close();

      try {
        nowSpy.mockReturnValue(120_000);
        cache = new DidResolverCacheLevel(options);
        await cache.open();
        await cache.set('did:example:evict-me', resolution('did:example:evict-me'));

        expect(await cache.getRetained(pinnedDid)).toEqual(refreshedResult);
        expect(await cache.getRetained('did:example:evict-me')).toBeUndefined();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('pins an existing result without replacing it with the fallback', async () => {
      cache = new DidResolverCacheLevel({ location: '__TESTDATA__/DID_RESOLVERCACHE_PIN_EXISTING' });
      await cache.clear();
      const did = 'did:example:already-cached';
      const existing = resolution(did);
      const fallback = resolution('did:example:older-local-copy');
      await cache.set(did, existing);

      await cache.pin(did, fallback);

      expect(await cache.getRetained(did)).toEqual(existing);
    });

    it('keeps legacy entries readable and records their next use', async () => {
      const baseTime = 100_000_000;
      const nowSpy = spyOn(Date, 'now').mockReturnValue(baseTime);
      const location = '__TESTDATA__/DID_RESOLVERCACHE_LEGACY';
      const options = { location, maxIdle: '1d', touchInterval: '1ms' };
      const did = 'did:example:legacy';
      const result = resolution(did);
      cache = new DidResolverCacheLevel(options);
      await cache.clear();
      await cache['cache'].put(did, JSON.stringify({
        ttlMillis : baseTime - 365 * 24 * 60 * 60_000,
        value     : result,
      }));
      await cache.close();

      try {
        cache = new DidResolverCacheLevel(options);
        await cache.open();
        expect(await cache.getRetained(did)).toEqual(result);
        await cache.close();

        nowSpy.mockReturnValue(baseTime + 23 * 60 * 60_000);
        cache = new DidResolverCacheLevel(options);
        await cache.open();
        expect(await cache.getRetained(did)).toEqual(result);
        await cache.close();

        nowSpy.mockReturnValue(baseTime + 25 * 60 * 60_000);
        cache = new DidResolverCacheLevel(options);
        await cache.open();
        expect(await cache.getRetained(did)).toEqual(result);
      } finally {
        nowSpy.mockRestore();
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
