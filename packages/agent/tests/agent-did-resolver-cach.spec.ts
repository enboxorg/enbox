import type { DidResolutionResult } from '@enbox/dids';
import type { SinonStub } from 'sinon';

import sinon from 'sinon';

import { AgentDidResolverCache } from '../src/agent-did-resolver-cache.js';
import { logger } from '@enbox/common';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { BearerDid, DidJwk } from '@enbox/dids';

describe('AgentDidResolverCache', () => {
  let resolverCache: AgentDidResolverCache;
  let testHarness: PlatformAgentTestHarness;

  const stubCacheEntry = (
    didUri: string,
    ttlMillis: number,
    value: DidResolutionResult,
  ): SinonStub => sinon.stub(resolverCache['cache'], 'get').callsFake((key: string): Promise<string> => {
    if (key === didUri) {
      return Promise.resolve(JSON.stringify({ ttlMillis, value }));
    }
    return Promise.reject({ notFound: true });
  });

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn'
    });

    resolverCache = new AgentDidResolverCache({ agent: testHarness.agent, location: '__TESTDATA__/did_cache' });
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

  it('coalesces concurrent refreshes of the stale agent DID', async () => {
    const did = testHarness.agent.agentDid.uri;
    const cachedResult = {
      didDocument           : { id: did },
      didDocumentMetadata   : {},
      didResolutionMetadata : {},
    };
    stubCacheEntry(did, Date.now() - 1000, cachedResult);
    const refreshSpy = sinon.stub(testHarness.agent.did, 'refreshResolution').callsFake(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return cachedResult;
    });
    const getManagedDidSpy = sinon.spy(testHarness.agent.did, 'get');
    sinon.stub(testHarness.agent.did, 'update').resolves();

    const results = await Promise.all([
      resolverCache.get(did),
      resolverCache.get(did)
    ]);

    expect(refreshSpy.callCount).toBe(1);
    expect(getManagedDidSpy.callCount).toBe(0);
    expect(results).toEqual([cachedResult, cachedResult]);
  });

  it('should not resolve a DID if the ttl has not elapsed', async () => {
    const did = testHarness.agent.agentDid.uri;
    stubCacheEntry(did, Date.now() + 1000, { didDocument: { id: did } });
    const refreshSpy = sinon.spy(testHarness.agent.did, 'refreshResolution');

    await resolverCache.get(did);

    expect(refreshSpy.callCount).toBe(0);
  });

  it('leaves stale non-managed DIDs for the universal resolver refresh path', async () => {
    const did = await DidJwk.create();
    const cachedResult = {
      didDocument           : { id: did.uri },
      didDocumentMetadata   : {},
      didResolutionMetadata : {},
    };
    stubCacheEntry(did.uri, Date.now() - 1000, cachedResult);
    const refreshSpy = sinon.spy(testHarness.agent.did, 'refreshResolution').withArgs(did.uri);
    sinon.stub(testHarness.agent.did, 'get').resolves(undefined);

    expect(await resolverCache.get(did.uri)).toBeUndefined();
    expect(await resolverCache.getRetained(did.uri)).toEqual(cachedResult);

    expect(refreshSpy.callCount).toBe(0);
  });

  it('should resolve and update if the DID is managed by the agent', async () => {
    const did = await DidJwk.create();

    stubCacheEntry(did.uri, Date.now() - 1000, { didDocument: { id: did.uri } });
    const refreshSpy = sinon.stub(testHarness.agent.did, 'refreshResolution').withArgs(did.uri).resolves({
      didDocument           : did.document,
      didDocumentMetadata   : {},
      didResolutionMetadata : {},
    });
    const didApiStub = sinon.stub(testHarness.agent.did, 'get');
    const updateSpy = sinon.stub(testHarness.agent.did, 'update').resolves();
    didApiStub.withArgs({ didUri: did.uri, tenant: testHarness.agent.agentDid.uri }).resolves(new BearerDid({
      uri        : did.uri,
      document   : { id: did.uri },
      metadata   : { },
      keyManager : testHarness.agent.keyManager
    }));

    await resolverCache.get(did.uri),

    expect(refreshSpy.callCount).toBe(1);
    expect(updateSpy.callCount).toBe(1);
  });

  it('should log an error if an update is attempted and fails', async () => {
    const did = await DidJwk.create();

    stubCacheEntry(did.uri, Date.now() - 1000, { didDocument: { id: did.uri } });
    const refreshSpy = sinon.stub(testHarness.agent.did, 'refreshResolution').withArgs(did.uri).resolves({
      didDocument           : did.document,
      didDocumentMetadata   : {},
      didResolutionMetadata : {},
    });
    const didApiStub = sinon.stub(testHarness.agent.did, 'get');
    const updateSpy = sinon.stub(testHarness.agent.did, 'update').rejects(new Error('Some Error'));
    const consoleErrorSpy = sinon.stub(logger, 'error');
    didApiStub.withArgs({ didUri: did.uri, tenant: testHarness.agent.agentDid.uri }).resolves(new BearerDid({
      uri        : did.uri,
      document   : { id: did.uri },
      metadata   : { },
      keyManager : testHarness.agent.keyManager
    }));

    await resolverCache.get(did.uri),

    expect(refreshSpy.callCount).toBe(1);
    expect(updateSpy.callCount).toBe(1);
    expect(consoleErrorSpy.callCount).toBe(1);
  });

  it('does not cache notFound records', async () => {
    const did = testHarness.agent.agentDid.uri;
    const getStub = sinon.stub(resolverCache['cache'], 'get').rejects({ notFound: true });

    const result = await resolverCache.get(did);

    // get should be called once, and resolve should be called once
    expect(getStub.callCount).toBe(1);
    expect(result).toBeUndefined();
  });

  it('throws if the error is anything other than a notFound error', async () => {
    const did = testHarness.agent.agentDid.uri;
    sinon.stub(resolverCache['cache'], 'get').rejects(new Error('Some Error'));

    try {
      await resolverCache.get(did);
      throw new Error('Should have thrown');
    } catch (error: any) {
      expect(error.message).toBe('Some Error');
    }
  });

  it('throws if the agent is not initialized', async () => {
    // close existing DB
    await resolverCache['cache'].close();

    // set resolver cache without an agent
    resolverCache = new AgentDidResolverCache({ location: '__TESTDATA__/did_cache' });

    try {
      // attempt to access the agent property
      resolverCache.agent;

      throw new Error('Should have thrown');
    } catch (error: any) {
      expect(error.message).toBe('Agent not initialized');
    }

    // set the agent property
    resolverCache.agent = testHarness.agent;

    // should not throw
    resolverCache.agent;
  });
});
