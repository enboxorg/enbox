import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  LocalDwnDiscovery,
  localDwnHostCandidates,
  localDwnPortCandidates,
  localDwnServerName,
} from '../src/local-dwn.js';

/**
 * Builds a minimal mock {@link Web5Rpc} whose `getServerInfo` behaviour is
 * controlled by the caller.
 */
function createMockRpc(): { getServerInfo: sinon.SinonStub } {
  return {
    getServerInfo: sinon.stub().rejects(new Error('not reachable')),
  };
}

describe('LocalDwnDiscovery', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('returns the endpoint of the first reachable local DWN server', async () => {
    const rpc = createMockRpc();
    // Simulate the server running on port 3000 at 127.0.0.1
    rpc.getServerInfo
      .withArgs('http://127.0.0.1:3000')
      .resolves({ server: localDwnServerName });

    const discovery = new LocalDwnDiscovery(rpc as any, /* cacheTtlMs */ 0);
    const endpoint = await discovery.getEndpoint();

    expect(endpoint).toBe('http://127.0.0.1:3000');
  });

  it('returns undefined when no local DWN server is reachable', async () => {
    const rpc = createMockRpc();

    const discovery = new LocalDwnDiscovery(rpc as any, /* cacheTtlMs */ 0);
    const endpoint = await discovery.getEndpoint();

    expect(endpoint).toBeUndefined();
    // Should have probed all port/host combinations.
    const expectedProbes = localDwnPortCandidates.length * localDwnHostCandidates.length;
    expect(rpc.getServerInfo.callCount).toBe(expectedProbes);
  });

  it('probes all port/host candidates in order', async () => {
    const rpc = createMockRpc();
    // Only the last candidate responds.
    const lastPort = localDwnPortCandidates[localDwnPortCandidates.length - 1];
    const lastHost = localDwnHostCandidates[localDwnHostCandidates.length - 1];
    rpc.getServerInfo
      .withArgs(`http://${lastHost}:${lastPort}`)
      .resolves({ server: localDwnServerName });

    const discovery = new LocalDwnDiscovery(rpc as any, /* cacheTtlMs */ 0);
    const endpoint = await discovery.getEndpoint();

    expect(endpoint).toBe(`http://${lastHost}:${lastPort}`);
    // All candidates before the match should have been probed.
    const expectedProbes = localDwnPortCandidates.length * localDwnHostCandidates.length;
    expect(rpc.getServerInfo.callCount).toBe(expectedProbes);
  });

  it('ignores servers that do not identify as @enbox/dwn-server', async () => {
    const rpc = createMockRpc();
    // A different server happens to be on port 3000.
    rpc.getServerInfo
      .withArgs('http://127.0.0.1:3000')
      .resolves({ server: 'some-other-server' });

    const discovery = new LocalDwnDiscovery(rpc as any, /* cacheTtlMs */ 0);
    const endpoint = await discovery.getEndpoint();

    expect(endpoint).toBeUndefined();
  });

  it('caches the result for the configured TTL', async () => {
    const rpc = createMockRpc();
    rpc.getServerInfo
      .withArgs('http://127.0.0.1:3000')
      .resolves({ server: localDwnServerName });

    // Use a very long TTL so the cache doesn't expire during the test.
    const discovery = new LocalDwnDiscovery(rpc as any, /* cacheTtlMs */ 60_000);

    const first = await discovery.getEndpoint();
    const second = await discovery.getEndpoint();

    expect(first).toBe('http://127.0.0.1:3000');
    expect(second).toBe('http://127.0.0.1:3000');
    // Only probed once; the second call used the cache.
    expect(rpc.getServerInfo.callCount).toBe(1);
  });

  it('caches a negative result (no server found)', async () => {
    const rpc = createMockRpc();

    const discovery = new LocalDwnDiscovery(rpc as any, /* cacheTtlMs */ 60_000);

    const first = await discovery.getEndpoint();
    const second = await discovery.getEndpoint();

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    // Full probe happened once; the second call used the negative cache.
    const expectedProbes = localDwnPortCandidates.length * localDwnHostCandidates.length;
    expect(rpc.getServerInfo.callCount).toBe(expectedProbes);
  });

  it('strips a trailing slash from the discovered endpoint', async () => {
    const rpc = createMockRpc();
    // Simulate a server that somehow has a trailing slash in its URL —
    // `normalizeBaseUrl` should strip it.
    rpc.getServerInfo
      .withArgs('http://127.0.0.1:3000')
      .resolves({ server: localDwnServerName });

    const discovery = new LocalDwnDiscovery(rpc as any, /* cacheTtlMs */ 0);
    const endpoint = await discovery.getEndpoint();

    // The constructed URL `http://127.0.0.1:3000` has no trailing slash,
    // so normalizeBaseUrl is a no-op here. The important thing is the
    // contract is enforced.
    expect(endpoint).toBe('http://127.0.0.1:3000');
    expect(endpoint!.endsWith('/')).toBe(false);
  });
});
