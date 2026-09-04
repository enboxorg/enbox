import type { DidResolutionResult } from '../../src/types/did-core.js';
import type { DidResolverCache } from '../../src/types/did-resolution.js';

import { DidJwk } from '../../src/methods/did-jwk.js';
import { DidResolverCacheMemory } from '../../src/resolver/resolver-cache-memory.js';
import { UniversalResolver } from '../../src/resolver/universal-resolver.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

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
      const nowSpy = spyOn(Date, 'now').mockReturnValue(1_000);
      cache = new DidResolverCacheMemory();

      const testDid = 'did:example:alice';

      const testDidResolutionResult = {
        didResolutionMetadata : {},
        didDocument           : { id: 'abc123' },
        didDocumentMetadata   : {}
      };

      // Write an entry into the cache.
      await cache.set(testDid, testDidResolutionResult);

      try {
        nowSpy.mockReturnValue(1_000 + 15 * 60_000 - 1);
        expect(await cache.get(testDid)).toEqual(testDidResolutionResult);

        nowSpy.mockReturnValue(1_000 + 15 * 60_000);
        expect(await cache.get(testDid)).toBeUndefined();
        expect(await cache.getRetained(testDid)).toEqual(testDidResolutionResult);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('uses a custom TTL, when specified', async () => {
      // Drive the cache clock directly so expiry is proven by controlled time advancement
      // rather than racing wall-clock scheduling (a real 5 ms TTL loses under CI load).
      const baseTime = Date.now();
      const nowSpy = spyOn(Date, 'now').mockReturnValue(baseTime);

      try {
        // Instantiate DID resolution cache with custom TTL of 1 minute.
        cache = new DidResolverCacheMemory({ ttl: '1m' });

        const testDid = 'did:example:alice';

        const testDidResolutionResult = {
          didResolutionMetadata : {},
          didDocument           : { id: 'abc123' },
          didDocumentMetadata   : {}
        };

        // Write an entry into the cache.
        await cache.set(testDid, testDidResolutionResult);

        // Confirm a cache hit immediately before the TTL boundary.
        nowSpy.mockReturnValue(baseTime + 60_000 - 1);
        let valueInCache = await cache.get(testDid);
        expect(valueInCache).toEqual(testDidResolutionResult);

        // Confirm a cache miss once the TTL has elapsed.
        nowSpy.mockReturnValue(baseTime + 60_000);
        valueInCache = await cache.get(testDid);
        expect(valueInCache).toBeUndefined();
        expect(await cache.getRetained(testDid)).toEqual(testDidResolutionResult);
      } finally {
        nowSpy.mockRestore();
      }
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

  describe('retention', () => {
    const resolution = (didUri: string): DidResolutionResult => ({
      didResolutionMetadata : {},
      didDocument           : { id: didUri },
      didDocumentMetadata   : {},
    });

    it('evicts an unpinned result after it remains unused for maxIdle', async () => {
      const clock = spyOn(performance, 'now').mockReturnValue(1_000);
      cache = new DidResolverCacheMemory({ maxIdle: '1m' });
      const did = 'did:example:idle';
      await cache.set(did, resolution(did));

      try {
        clock.mockReturnValue(61_000);
        expect(await cache.getRetained(did)).toBeUndefined();
      } finally {
        clock.mockRestore();
      }
    });

    it('renews idle retention when a result is pulled', async () => {
      const clock = spyOn(performance, 'now').mockReturnValue(1_000);
      cache = new DidResolverCacheMemory({ maxIdle: '1m' });
      const did = 'did:example:active';
      const result = resolution(did);
      await cache.set(did, result);

      try {
        clock.mockReturnValue(31_000);
        expect(await cache.getRetained(did)).toEqual(result);

        clock.mockReturnValue(71_000);
        expect(await cache.getRetained(did)).toEqual(result);
      } finally {
        clock.mockRestore();
      }
    });

    it('evicts the least-recently-used result when the byte budget is exceeded', async () => {
      const dateClock = spyOn(Date, 'now').mockReturnValue(1_000);
      const idleClock = spyOn(performance, 'now').mockReturnValue(1_000);
      const didA = 'did:example:aaaa';
      const didB = 'did:example:bbbb';
      const didC = 'did:example:cccc';
      const bytesPerEntry = new TextEncoder().encode(
        didA + JSON.stringify({ ttlMillis: 1_000 + 15 * 60_000, value: resolution(didA) })
      ).byteLength;
      cache = new DidResolverCacheMemory({ maxBytes: bytesPerEntry * 2 });

      try {
        await cache.set(didA, resolution(didA));
        idleClock.mockReturnValue(2_000);
        await cache.set(didB, resolution(didB));
        idleClock.mockReturnValue(3_000);
        await cache.getRetained(didA);
        idleClock.mockReturnValue(4_000);
        await cache.set(didC, resolution(didC));

        expect(await cache.getRetained(didA)).toEqual(resolution(didA));
        expect(await cache.getRetained(didB)).toBeUndefined();
        expect(await cache.getRetained(didC)).toEqual(resolution(didC));
      } finally {
        dateClock.mockRestore();
        idleClock.mockRestore();
      }
    });

    it('updates a pinned result without making it eligible for eviction', async () => {
      const dateClock = spyOn(Date, 'now').mockReturnValue(1_000);
      const idleClock = spyOn(performance, 'now').mockReturnValue(1_000);
      cache = new DidResolverCacheMemory({ maxBytes: 1, maxIdle: '1m' });
      const pinnedDid = 'did:example:pinned';
      const pinnedResult = resolution(pinnedDid);
      const refreshedResult = {
        ...pinnedResult,
        didDocumentMetadata: { versionId: '2' },
      };
      await cache.pin(pinnedDid, pinnedResult);
      await cache.set(pinnedDid, refreshedResult);

      try {
        dateClock.mockReturnValue(120_000);
        idleClock.mockReturnValue(120_000);
        await cache.set('did:example:evict-me', resolution('did:example:evict-me'));

        expect(await cache.getRetained(pinnedDid)).toEqual(refreshedResult);
        expect(await cache.getRetained('did:example:evict-me')).toBeUndefined();
      } finally {
        dateClock.mockRestore();
        idleClock.mockRestore();
      }
    });

    it('pins an existing result without replacing it with the fallback', async () => {
      cache = new DidResolverCacheMemory();
      const did = 'did:example:already-cached';
      const existing = resolution(did);
      const fallback = resolution('did:example:older-local-copy');
      await cache.set(did, existing);

      await cache.pin(did, fallback);

      expect(await cache.getRetained(did)).toEqual(existing);
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
