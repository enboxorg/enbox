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

  it('does not attempt to resolve a DID that is already resolving', async () => {
    const did = testHarness.agent.agentDid.uri;
    const getStub = sinon.stub(resolverCache['cache'], 'get').resolves(JSON.stringify({ ttlMillis: Date.now() - 1000, value: { didDocument: { id: did } } }));
    const refreshSpy = sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
      didDocument           : { id: did },
      didDocumentMetadata   : {},
      didResolutionMetadata : {},
    });
    sinon.stub(testHarness.agent.did, 'get').resolves(new BearerDid({
      uri        : did,
      document   : { id: did },
      metadata   : {},
      keyManager : testHarness.agent.keyManager,
    }));
    sinon.stub(testHarness.agent.did, 'update').resolves();

    await Promise.all([
      resolverCache.get(did),
      resolverCache.get(did)
    ]);

    // get should be called twice, but resolve should only be called once
    // because the second call should be blocked by the _resolving Map
    expect(getStub.callCount).toBe(2);
    expect(refreshSpy.callCount).toBe(1);
  });

  it('should not resolve a DID if the ttl has not elapsed', async () => {
    const did = testHarness.agent.agentDid.uri;
    const getStub = sinon.stub(resolverCache['cache'], 'get').resolves(JSON.stringify({ ttlMillis: Date.now() + 1000, value: { didDocument: { id: did } } }));
    const refreshSpy = sinon.spy(testHarness.agent.did, 'refreshResolution');

    await resolverCache.get(did);

    // get should be called once, but resolve should not be called
    expect(getStub.callCount).toBe(1);
    expect(refreshSpy.callCount).toBe(0);
  });

  it('should not call resolve if the DID is not the agent DID or exists as an identity in the agent', async () => {
    const did = await DidJwk.create();
    const getStub = sinon.stub(resolverCache['cache'], 'get').resolves(JSON.stringify({ ttlMillis: Date.now() - 1000, value: { didDocument: { id: did.uri } } }));
    const refreshSpy = sinon.spy(testHarness.agent.did, 'refreshResolution').withArgs(did.uri);
    const nextTickSpy = sinon.stub(resolverCache['cache'], 'nextTick').resolves();

    await resolverCache.get(did.uri),

    // get should be called once, but we do not resolve even though the TTL is expired
    expect(getStub.callCount).toBe(1);
    expect(refreshSpy.callCount).toBe(0);

    // we expect the nextTick of the cache to be called to trigger a delete of the cache item after returning as it's expired
    expect(nextTickSpy.callCount).toBe(1);
  });

  it('should resolve and update if the DID is managed by the agent', async () => {
    const did = await DidJwk.create();

    const getStub = sinon.stub(resolverCache['cache'], 'get').resolves(JSON.stringify({ ttlMillis: Date.now() - 1000, value: { didDocument: { id: did.uri } } }));
    const refreshSpy = sinon.stub(testHarness.agent.did, 'refreshResolution').withArgs(did.uri).resolves({
      didDocument           : did.document,
      didDocumentMetadata   : {},
      didResolutionMetadata : {},
    });
    sinon.stub(resolverCache['cache'], 'nextTick').resolves();
    const didApiStub = sinon.stub(testHarness.agent.did, 'get');
    const updateSpy = sinon.stub(testHarness.agent.did, 'update').resolves();
    didApiStub.withArgs({ didUri: did.uri, tenant: testHarness.agent.agentDid.uri }).resolves(new BearerDid({
      uri        : did.uri,
      document   : { id: did.uri },
      metadata   : { },
      keyManager : testHarness.agent.keyManager
    }));

    await resolverCache.get(did.uri),

    // get should be called once, and we also resolve the DId as it's returned by the identity.get method
    expect(getStub.callCount).toBe(1);
    expect(refreshSpy.callCount).toBe(1);
    expect(updateSpy.callCount).toBe(1);
  });

  it('should log an error if an update is attempted and fails', async () => {
    const did = await DidJwk.create();

    const getStub = sinon.stub(resolverCache['cache'], 'get').resolves(JSON.stringify({ ttlMillis: Date.now() - 1000, value: { didDocument: { id: did.uri } } }));
    const refreshSpy = sinon.stub(testHarness.agent.did, 'refreshResolution').withArgs(did.uri).resolves({
      didDocument           : did.document,
      didDocumentMetadata   : {},
      didResolutionMetadata : {},
    });
    sinon.stub(resolverCache['cache'], 'nextTick').resolves();
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

    // get should be called once, and we also resolve the DId as it's returned by the identity.get method
    expect(getStub.callCount).toBe(1);
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
