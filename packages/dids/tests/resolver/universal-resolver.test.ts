import type { UnwrapPromise } from '@enbox/common';

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { DidResolutionResult, DidResource } from '../../src/types/did-core.js';

import { DidJwk } from '../../src/methods/did-jwk.js';
import DidJwkResolveTestVector from '../fixtures/web5-spec-vectors/did_jwk/resolve.json' with { type: 'json' };
import { DidResolverCacheMemory } from '../../src/resolver/resolver-cache-memory.js';
import { isDidVerificationMethod } from '../../src/utils.js';
import { UniversalResolver } from '../../src/resolver/universal-resolver.js';
import { DidErrorCode, DidResolutionErrorCause } from '../../src/did-error.js';

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

    describe('retained resolutions', () => {
      const did = 'did:jwk:retained-resolution';
      const retainedResult: DidResolutionResult = {
        didResolutionMetadata : {},
        didDocument           : { id: `${did}#retained` },
        didDocumentMetadata   : {},
      };

      it('uses the last successful result when a refresh cannot reach the network', async () => {
        const nowSpy = spyOn(Date, 'now').mockReturnValue(1_000);
        const cache = new DidResolverCacheMemory({ ttl: '1ms' });
        await cache.set(did, retainedResult);

        try {
          nowSpy.mockReturnValue(1_001);
          const methodResolver = spyOn(DidJwk, 'resolve').mockResolvedValue({
            didResolutionMetadata: {
              error      : DidErrorCode.InternalError,
              errorCause : DidResolutionErrorCause.NetworkUnavailable,
            },
            didDocument         : null,
            didDocumentMetadata : {},
          });
          const resolver = new UniversalResolver({ didResolvers: [DidJwk], cache });

          expect(await resolver.resolve(did)).toEqual(retainedResult);
          expect(methodResolver).toHaveBeenCalledTimes(1);
        } finally {
          nowSpy.mockRestore();
        }
      });

      it('does not hide a definitive resolution failure with a retained result', async () => {
        const nowSpy = spyOn(Date, 'now').mockReturnValue(1_000);
        const cache = new DidResolverCacheMemory({ ttl: '1ms' });
        await cache.set(did, retainedResult);

        try {
          nowSpy.mockReturnValue(1_001);
          const notFoundResult: DidResolutionResult = {
            didResolutionMetadata : { error: DidErrorCode.NotFound },
            didDocument           : null,
            didDocumentMetadata   : {},
          };
          spyOn(DidJwk, 'resolve').mockResolvedValue(notFoundResult);
          const resolver = new UniversalResolver({ didResolvers: [DidJwk], cache });

          expect(await resolver.resolve(did)).toEqual(notFoundResult);
        } finally {
          nowSpy.mockRestore();
        }
      });

      it('replaces a retained result after a successful refresh', async () => {
        const nowSpy = spyOn(Date, 'now').mockReturnValue(1_000);
        const cache = new DidResolverCacheMemory({ ttl: '1ms' });
        await cache.set(did, retainedResult);

        try {
          nowSpy.mockReturnValue(1_001);
          const refreshedResult: DidResolutionResult = {
            didResolutionMetadata : {},
            didDocument           : { id: `${did}#refreshed` },
            didDocumentMetadata   : {},
          };
          spyOn(DidJwk, 'resolve').mockResolvedValue(refreshedResult);
          const resolver = new UniversalResolver({ didResolvers: [DidJwk], cache });

          expect(await resolver.resolve(did)).toEqual(refreshedResult);
          expect(await cache.get(did)).toEqual(refreshedResult);
        } finally {
          nowSpy.mockRestore();
        }
      });
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

    describe('single-flight (in-flight coalescing)', () => {
      it('coalesces concurrent resolutions of the same DID into a single underlying call', async () => {
        const did = 'did:jwk:single-flight-coalesce-1';
        let inFlight = 0;
        let maxConcurrent = 0;

        // Slow resolver: tracks how many simultaneous calls are made.
        const didMethodResolver = spyOn(DidJwk, 'resolve').mockImplementation(async () => {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          inFlight -= 1;
          return {
            didResolutionMetadata : {},
            didDocument           : { id: did },
            didDocumentMetadata   : {},
          };
        });

        const results = await Promise.all([
          didResolver.resolve(did),
          didResolver.resolve(did),
          didResolver.resolve(did),
          didResolver.resolve(did),
        ]);

        expect(didMethodResolver).toHaveBeenCalledTimes(1);
        expect(maxConcurrent).toBe(1);
        for (const r of results) {
          expect(r.didDocument).toEqual({ id: did });
        }
      });

      it('does not coalesce resolutions of different DIDs', async () => {
        const didA = 'did:jwk:single-flight-different-a';
        const didB = 'did:jwk:single-flight-different-b';

        const didMethodResolver = spyOn(DidJwk, 'resolve').mockImplementation(async (uri: string) => ({
          didResolutionMetadata : {},
          didDocument           : { id: uri },
          didDocumentMetadata   : {},
        }));

        await Promise.all([didResolver.resolve(didA), didResolver.resolve(didB)]);

        expect(didMethodResolver).toHaveBeenCalledTimes(2);
      });

      it('serves a follow-up resolution from cache rather than re-issuing the underlying resolve', async () => {
        const did = 'did:jwk:single-flight-cache-followup';

        // Use an in-memory cache (the default `DidResolverCacheNoop` would
        // never serve from cache, defeating this test).
        const cache = new Map<string, DidResolutionResult>();
        const cachingResolver = new UniversalResolver({
          didResolvers : [DidJwk],
          cache        : {
            open   : (): Promise<void> => Promise.resolve(),
            close  : (): Promise<void> => Promise.resolve(),
            get    : (key: string): Promise<DidResolutionResult | undefined> => Promise.resolve(cache.get(key)),
            set    : (key: string, value: DidResolutionResult): Promise<void> => { cache.set(key, value); return Promise.resolve(); },
            delete : (key: string): Promise<void> => { cache.delete(key); return Promise.resolve(); },
            clear  : (): Promise<void> => { cache.clear(); return Promise.resolve(); },
          },
        });

        const didMethodResolver = spyOn(DidJwk, 'resolve').mockResolvedValue({
          didResolutionMetadata : {},
          didDocument           : { id: did },
          didDocumentMetadata   : {},
        });

        await cachingResolver.resolve(did);
        await cachingResolver.resolve(did);

        // First call invokes the resolver and populates the cache; second
        // call returns the cached result without invoking the resolver again.
        expect(didMethodResolver).toHaveBeenCalledTimes(1);
      });

      it('clears the in-flight entry after success so future cache misses re-resolve', async () => {
        const did = 'did:jwk:single-flight-clears-after-success';

        const didMethodResolver = spyOn(DidJwk, 'resolve').mockResolvedValue({
          didResolutionMetadata : {},
          didDocument           : { id: did },
          didDocumentMetadata   : {},
        });

        // Two sequential calls (no concurrency) — with the default no-op
        // cache, both calls must hit the underlying resolver, proving the
        // in-flight entry was cleared after the first resolution settled.
        await didResolver.resolve(did);
        await didResolver.resolve(did);

        expect(didMethodResolver).toHaveBeenCalledTimes(2);
      });

      it('clears the in-flight entry after failure so a retry re-resolves', async () => {
        const did = 'did:jwk:single-flight-clears-after-failure';

        const didMethodResolver = spyOn(DidJwk, 'resolve').mockRejectedValueOnce(
          new Error('transient network error'),
        ).mockResolvedValueOnce({
          didResolutionMetadata : {},
          didDocument           : { id: did },
          didDocumentMetadata   : {},
        });

        await expect(didResolver.resolve(did)).rejects.toThrow('transient network error');

        // The next call should not be poisoned by the failed in-flight entry.
        const result = await didResolver.resolve(did);
        expect(result.didDocument).toEqual({ id: did });
        expect(didMethodResolver).toHaveBeenCalledTimes(2);
      });

      it('all concurrent callers reject with the same error if the underlying resolver fails', async () => {
        const did = 'did:jwk:single-flight-shared-failure';

        const didMethodResolver = spyOn(DidJwk, 'resolve').mockImplementation(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          throw new Error('shared underlying failure');
        });

        const settled = await Promise.allSettled([
          didResolver.resolve(did),
          didResolver.resolve(did),
          didResolver.resolve(did),
        ]);

        expect(didMethodResolver).toHaveBeenCalledTimes(1);
        for (const s of settled) {
          expect(s.status).toBe('rejected');
          if (s.status === 'rejected') {
            expect((s.reason as Error).message).toBe('shared underlying failure');
          }
        }
      });

      it('does NOT coalesce when callers pass per-call options — each gets its own resolution', async () => {
        const did = 'did:jwk:single-flight-bypassed-with-options';

        const seenOptions: any[] = [];
        const didMethodResolver = spyOn(DidJwk, 'resolve').mockImplementation(async (_uri: string, opts?: any) => {
          seenOptions.push(opts);
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          return {
            didResolutionMetadata : {},
            didDocument           : { id: did },
            didDocumentMetadata   : {},
          };
        });

        // Two concurrent callers with different `options` payloads. Single-flight
        // is keyed by DID URI only, so coalescing here would silently hand
        // caller B caller A's options — a real correctness/security hazard if
        // options ever carries a gateway URI, accept header, or signal. The
        // implementation must bypass single-flight when options are present.
        await Promise.all([
          didResolver.resolve(did, { gatewayUri: 'A' } as any),
          didResolver.resolve(did, { gatewayUri: 'B' } as any),
        ]);

        expect(didMethodResolver).toHaveBeenCalledTimes(2);
        expect(seenOptions).toHaveLength(2);
        expect(seenOptions[0]).toEqual({ gatewayUri: 'A' });
        expect(seenOptions[1]).toEqual({ gatewayUri: 'B' });
      });

      it('does not let an optioned caller consume an existing no-options in-flight resolution', async () => {
        const did = 'did:jwk:single-flight-optioned-bypasses-default-inflight';

        const didMethodResolver = spyOn(DidJwk, 'resolve').mockImplementation(async (_uri: string, opts?: any) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          const suffix = opts?.gatewayUri ?? 'default';
          return {
            didResolutionMetadata : {},
            didDocument           : { id: `${did}#${suffix}` },
            didDocumentMetadata   : {},
          };
        });

        const noOptionsPromise = didResolver.resolve(did);
        await Promise.resolve();

        const optionedResult = await didResolver.resolve(did, { gatewayUri: 'optioned' } as any);
        const noOptionsResult = await noOptionsPromise;

        expect(didMethodResolver).toHaveBeenCalledTimes(2);
        expect(noOptionsResult.didDocument).toEqual({ id: `${did}#default` });
        expect(optionedResult.didDocument).toEqual({ id: `${did}#optioned` });
      });

      it('does not let a no-options caller consume an existing optioned resolution', async () => {
        const did = 'did:jwk:single-flight-default-bypasses-optioned-inflight';

        const didMethodResolver = spyOn(DidJwk, 'resolve').mockImplementation(async (_uri: string, opts?: any) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          const suffix = opts?.gatewayUri ?? 'default';
          return {
            didResolutionMetadata : {},
            didDocument           : { id: `${did}#${suffix}` },
            didDocumentMetadata   : {},
          };
        });

        const optionedPromise = didResolver.resolve(did, { gatewayUri: 'optioned' } as any);
        await Promise.resolve();

        const noOptionsResult = await didResolver.resolve(did);
        const optionedResult = await optionedPromise;

        expect(didMethodResolver).toHaveBeenCalledTimes(2);
        expect(optionedResult.didDocument).toEqual({ id: `${did}#optioned` });
        expect(noOptionsResult.didDocument).toEqual({ id: `${did}#default` });
      });

      it('does not serve optioned resolutions from the DID-only cache', async () => {
        const did = 'did:jwk:single-flight-optioned-cache-read-bypass';
        const cache = new Map<string, DidResolutionResult>();
        cache.set(did, {
          didResolutionMetadata : {},
          didDocument           : { id: `${did}#cached-default` },
          didDocumentMetadata   : {},
        });
        const cachingResolver = new UniversalResolver({
          didResolvers : [DidJwk],
          cache        : {
            open   : (): Promise<void> => Promise.resolve(),
            close  : (): Promise<void> => Promise.resolve(),
            get    : (key: string): Promise<DidResolutionResult | undefined> => Promise.resolve(cache.get(key)),
            set    : (key: string, value: DidResolutionResult): Promise<void> => { cache.set(key, value); return Promise.resolve(); },
            delete : (key: string): Promise<void> => { cache.delete(key); return Promise.resolve(); },
            clear  : (): Promise<void> => { cache.clear(); return Promise.resolve(); },
          },
        });
        const didMethodResolver = spyOn(DidJwk, 'resolve').mockResolvedValue({
          didResolutionMetadata : {},
          didDocument           : { id: `${did}#optioned` },
          didDocumentMetadata   : {},
        });

        const result = await cachingResolver.resolve(did, { gatewayUri: 'https://dht.example' } as any);

        expect(didMethodResolver).toHaveBeenCalledTimes(1);
        expect(result.didDocument).toEqual({ id: `${did}#optioned` });
      });

      it('does not write optioned resolutions to the DID-only cache', async () => {
        const did = 'did:jwk:single-flight-optioned-cache-write-bypass';
        const cache = new Map<string, DidResolutionResult>();
        const cachingResolver = new UniversalResolver({
          didResolvers : [DidJwk],
          cache        : {
            open   : (): Promise<void> => Promise.resolve(),
            close  : (): Promise<void> => Promise.resolve(),
            get    : (key: string): Promise<DidResolutionResult | undefined> => Promise.resolve(cache.get(key)),
            set    : (key: string, value: DidResolutionResult): Promise<void> => { cache.set(key, value); return Promise.resolve(); },
            delete : (key: string): Promise<void> => { cache.delete(key); return Promise.resolve(); },
            clear  : (): Promise<void> => { cache.clear(); return Promise.resolve(); },
          },
        });
        const didMethodResolver = spyOn(DidJwk, 'resolve')
          .mockResolvedValueOnce({
            didResolutionMetadata : {},
            didDocument           : { id: `${did}#optioned` },
            didDocumentMetadata   : {},
          })
          .mockResolvedValueOnce({
            didResolutionMetadata : {},
            didDocument           : { id: `${did}#default` },
            didDocumentMetadata   : {},
          });

        await cachingResolver.resolve(did, { gatewayUri: 'https://dht.example' } as any);
        const result = await cachingResolver.resolve(did);

        expect(didMethodResolver).toHaveBeenCalledTimes(2);
        expect(result.didDocument).toEqual({ id: `${did}#default` });
      });

      it('does not poison concurrent callers when cache.set throws after a successful resolution', async () => {
        const did = 'did:jwk:single-flight-cache-set-throws';

        const failingCache = {
          open   : (): Promise<void> => Promise.resolve(),
          close  : (): Promise<void> => Promise.resolve(),
          get    : (): Promise<undefined> => Promise.resolve(undefined),
          set    : (): Promise<void> => Promise.reject(new Error('cache write failed')),
          delete : (): Promise<void> => Promise.resolve(),
          clear  : (): Promise<void> => Promise.resolve(),
        };
        const resolverWithFailingCache = new UniversalResolver({
          didResolvers : [DidJwk],
          cache        : failingCache,
        });

        const didMethodResolver = spyOn(DidJwk, 'resolve').mockImplementation(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          return {
            didResolutionMetadata : {},
            didDocument           : { id: did },
            didDocumentMetadata   : {},
          };
        });

        // Three concurrent callers share one in-flight resolution. The underlying
        // network resolve succeeds; only the cache write fails. All three must
        // receive the successful result — a cache-write error must not cascade
        // across coalesced callers.
        const results = await Promise.all([
          resolverWithFailingCache.resolve(did),
          resolverWithFailingCache.resolve(did),
          resolverWithFailingCache.resolve(did),
        ]);

        expect(didMethodResolver).toHaveBeenCalledTimes(1);
        for (const r of results) {
          expect(r.didDocument).toEqual({ id: did });
          expect(r.didResolutionMetadata.error).toBeUndefined();
        }
      });
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
