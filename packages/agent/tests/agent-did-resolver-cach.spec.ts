import type { AgentDidResolverCache } from '../src/agent-did-resolver-cache.js';
import type { DidResolutionResult } from '@enbox/dids';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DidDht, DidJwk, setDwnServiceEndpointUrls } from '@enbox/dids';

import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';

describe('AgentDidResolverCache', () => {
  let resolverCache: AgentDidResolverCache;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn',
    });
    // Use the exact cache installed on AgentDidApi. A separate cache would not exercise the
    // production recursion boundary between cache.get() and the cache-bypassing core refresh.
    resolverCache = testHarness.didResolverCache as AgentDidResolverCache;
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.createAgentDid();
  });

  async function createManagedDid(): Promise<{ didUri: string; result: DidResolutionResult }> {
    const identity = await testHarness.agent.identity.create({
      didMethod : 'jwk',
      metadata  : { name: 'Managed cache test' },
    });
    return {
      didUri : identity.did.uri,
      result : {
        didDocument           : identity.did.document,
        didDocumentMetadata   : identity.did.metadata,
        didResolutionMetadata : {},
      },
    };
  }

  async function putRawCacheEntry(
    didUri: string,
    result: DidResolutionResult,
    ttlMillis: number,
  ): Promise<void> {
    await resolverCache['cache'].put(didUri, JSON.stringify({ ttlMillis, value: result }));
  }

  it('refreshes an expired managed DID through the method resolver once and renews its TTL', async () => {
    const { didUri, result: staleResult } = await createManagedDid();
    staleResult.didDocument!.alsoKnownAs = ['https://stale.example'];
    await putRawCacheEntry(didUri, staleResult, Date.now() - 1);
    const methodResolve = sinon.spy(DidJwk, 'resolve');

    const [first, second] = await Promise.all([
      testHarness.agent.did.resolve(didUri),
      testHarness.agent.did.resolve(didUri),
    ]);

    expect(methodResolve.calledOnceWithExactly(didUri, {})).toBe(true);
    expect(first.didDocument?.alsoKnownAs).toBeUndefined();
    expect(second).toEqual(first);

    const refreshedEntry = JSON.parse(await resolverCache['cache'].get(didUri));
    expect(refreshedEntry.ttlMillis).toBeGreaterThan(Date.now());

    await testHarness.agent.did.resolve(didUri);
    expect(methodResolve.callCount).toBe(1);
  });

  it('does not reconcile an expired entry over a concurrent authoritative DID update', async () => {
    const identity = await testHarness.agent.identity.create({
      didMethod  : 'dht',
      metadata   : { name: 'Managed cache race' },
      didOptions : {
        publish  : false,
        services : [{
          id              : 'dwn',
          type            : 'DecentralizedWebNode',
          serviceEndpoint : ['https://before.example/dwn'],
        }],
      },
    });
    const staleResult: DidResolutionResult = {
      didDocument           : identity.did.document,
      didDocumentMetadata   : identity.did.metadata,
      didResolutionMetadata : {},
    };
    await putRawCacheEntry(identity.did.uri, staleResult, Date.now() - 1);
    const resolvedBefore = setDwnServiceEndpointUrls({
      didDocument : identity.did.document,
      endpoints   : ['https://resolved-before.example/dwn'],
    });
    const publishedDocument = setDwnServiceEndpointUrls({
      didDocument : identity.did.document,
      endpoints   : ['https://published.example/dwn'],
    });
    let releaseOld!: () => void;
    let markResolveStarted!: () => void;
    const oldResolutionGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const resolveStarted = new Promise<void>((resolve) => { markResolveStarted = resolve; });
    const resolve = sinon.stub(DidDht, 'resolve');
    resolve.onFirstCall().callsFake(async () => {
      markResolveStarted();
      await oldResolutionGate;
      return {
        didDocument           : resolvedBefore,
        didDocumentMetadata   : { published: true, versionId: 'before' },
        didResolutionMetadata : {},
      };
    });
    resolve.onSecondCall().resolves({
      didDocument           : publishedDocument,
      didDocumentMetadata   : { published: true, versionId: 'published' },
      didResolutionMetadata : {},
    });
    sinon.stub(DidDht, 'publish').resolves({
      didDocument             : publishedDocument,
      didDocumentMetadata     : { published: true, versionId: 'published' },
      didRegistrationMetadata : {},
    });

    const refreshing = resolverCache.get(identity.did.uri);
    await resolveStarted;
    const portableDid = await identity.did.export();
    portableDid.document = publishedDocument;
    await testHarness.agent.did.update({
      portableDid,
      tenant: testHarness.agent.agentDid.uri,
    });
    releaseOld();

    await expect(refreshing).resolves.toMatchObject({ didDocument: publishedDocument });
    expect(resolve.callCount).toBe(2);
    const stored = await testHarness.agent.did.get({
      didUri : identity.did.uri,
      tenant : testHarness.agent.agentDid.uri,
    });
    expect(stored?.document).toEqual(publishedDocument);
    const cached = JSON.parse(await resolverCache['cache'].get(identity.did.uri));
    expect(cached.value.didDocument).toEqual(publishedDocument);
  });

  it('does not refresh a cache entry whose TTL has not elapsed', async () => {
    const { didUri, result } = await createManagedDid();
    await putRawCacheEntry(didUri, result, Date.now() + 60_000);
    const refresh = sinon.spy(testHarness.agent.did, 'refreshResolutionAndReconcile');

    await resolverCache.get(didUri);

    expect(refresh.notCalled).toBe(true);
  });

  it('evicts an expired DID that is not managed by the agent', async () => {
    const did = await DidJwk.create();
    const result: DidResolutionResult = {
      didDocument           : did.document,
      didDocumentMetadata   : did.metadata,
      didResolutionMetadata : {},
    };
    await putRawCacheEntry(did.uri, result, Date.now() - 1);
    const nextTick = sinon.spy(resolverCache['cache'], 'nextTick');
    const refresh = sinon.spy(testHarness.agent.did, 'refreshResolutionAndReconcile');

    const cached = await resolverCache.get(did.uri);

    expect(cached).toBeUndefined();
    expect(refresh.notCalled).toBe(true);
    expect(nextTick.calledOnce).toBe(true);
  });

  it('retains stale managed DID data without repeating failed refreshes on sequential reads', async () => {
    const { didUri, result } = await createManagedDid();
    await putRawCacheEntry(didUri, result, Date.now() - 1);
    const refresh = sinon.stub(testHarness.agent.did, 'refreshResolutionAndReconcile').rejects(new Error('offline'));

    const first = await resolverCache.get(didUri);
    const second = await resolverCache.get(didUri);
    const third = await resolverCache.get(didUri);

    expect(first).toEqual(result);
    expect(second).toEqual(result);
    expect(third).toEqual(result);
    expect(refresh.calledOnce).toBe(true);
    expect(resolverCache['_failedRefreshRetryAfter'].get(didUri)).toBeGreaterThan(Date.now());
  });

  it('retries after the failure delay and adopts the recovered resolution', async () => {
    const { didUri, result: staleResult } = await createManagedDid();
    staleResult.didDocument!.alsoKnownAs = ['https://stale.example'];
    await putRawCacheEntry(didUri, staleResult, Date.now() - 1);

    const freshResult = structuredClone(staleResult);
    freshResult.didDocument!.alsoKnownAs = ['https://fresh.example'];
    let now = Date.now();
    sinon.stub(Date, 'now').callsFake(() => now);
    const refresh = sinon.stub(testHarness.agent.did, 'refreshResolutionAndReconcile');
    refresh.onFirstCall().rejects(new Error('offline'));
    refresh.onSecondCall().callsFake(async () => {
      await resolverCache.set(didUri, freshResult);
      return freshResult;
    });

    expect(await resolverCache.get(didUri)).toEqual(staleResult);
    const retryAfter = resolverCache['_failedRefreshRetryAfter'].get(didUri)!;

    now = retryAfter - 1;
    expect(await resolverCache.get(didUri)).toEqual(staleResult);
    expect(refresh.calledOnce).toBe(true);

    now = retryAfter;
    expect(await resolverCache.get(didUri)).toEqual(freshResult);
    expect(refresh.callCount).toBe(2);
    expect(resolverCache['_failedRefreshRetryAfter'].has(didUri)).toBe(false);

    expect(await resolverCache.get(didUri)).toEqual(freshResult);
    expect(refresh.callCount).toBe(2);
  });

  it('clears failed-refresh retry state when cache entries are replaced or removed', async () => {
    const { didUri, result } = await createManagedDid();

    resolverCache['_failedRefreshRetryAfter'].set(didUri, Date.now() + 60_000);
    await resolverCache.set(didUri, result);
    expect(resolverCache['_failedRefreshRetryAfter'].has(didUri)).toBe(false);

    resolverCache['_failedRefreshRetryAfter'].set(didUri, Date.now() + 60_000);
    await resolverCache.delete(didUri);
    expect(resolverCache['_failedRefreshRetryAfter'].has(didUri)).toBe(false);

    resolverCache['_failedRefreshRetryAfter'].set(didUri, Date.now() + 60_000);
    await resolverCache.clear();
    expect(resolverCache['_failedRefreshRetryAfter'].size).toBe(0);
  });

  it('does not cache notFound records', async () => {
    const did = testHarness.agent.agentDid.uri;
    const get = sinon.stub(resolverCache['cache'], 'get').rejects({ notFound: true });

    const result = await resolverCache.get(did);

    expect(get.calledOnce).toBe(true);
    expect(result).toBeUndefined();
  });

  it('throws cache errors other than notFound', async () => {
    const did = testHarness.agent.agentDid.uri;
    sinon.stub(resolverCache['cache'], 'get').rejects(new Error('cache unavailable'));

    await expect(resolverCache.get(did)).rejects.toThrow('cache unavailable');
  });

  it('throws if the agent is not initialized', () => {
    const originalAgent = resolverCache.agent;
    resolverCache['_agent'] = undefined;

    expect(() => resolverCache.agent).toThrow('Agent not initialized');

    resolverCache.agent = originalAgent;
    expect(resolverCache.agent).toBe(originalAgent);
  });
});
