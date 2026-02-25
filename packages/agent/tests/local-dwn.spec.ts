import type { Web5Rpc } from '@enbox/dwn-clients';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  LocalDwnDiscovery,
  localDwnHostCandidates,
  localDwnPortCandidates,
  localDwnServerName,
} from '../src/local-dwn.js';

describe('LocalDwnDiscovery', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should return the endpoint when a local DWN server is found on the first candidate', async () => {
    const rpcClient = {
      getServerInfo: sinon.stub().resolves({ server: localDwnServerName }),
    } as unknown as Web5Rpc;

    const discovery = new LocalDwnDiscovery(rpcClient);
    const endpoint = await discovery.getEndpoint();

    expect(endpoint).toBe(`http://${localDwnHostCandidates[0]}:${localDwnPortCandidates[0]}`);
    expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(1);
  });

  it('should return undefined when no local DWN server is reachable', async () => {
    const rpcClient = {
      getServerInfo: sinon.stub().rejects(new Error('connection refused')),
    } as unknown as Web5Rpc;

    const discovery = new LocalDwnDiscovery(rpcClient);
    const endpoint = await discovery.getEndpoint();

    expect(endpoint).toBeUndefined();
    // Should have probed all host/port combinations.
    const expectedCalls = localDwnPortCandidates.length * localDwnHostCandidates.length;
    expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(expectedCalls);
  });

  it('should skip servers that do not identify as @enbox/dwn-server', async () => {
    const rpcClient = {
      getServerInfo: sinon.stub().resolves({ server: 'some-other-server' }),
    } as unknown as Web5Rpc;

    const discovery = new LocalDwnDiscovery(rpcClient);
    const endpoint = await discovery.getEndpoint();

    expect(endpoint).toBeUndefined();
  });

  it('should cache a positive result and return it without re-probing', async () => {
    const rpcClient = {
      getServerInfo: sinon.stub().resolves({ server: localDwnServerName }),
    } as unknown as Web5Rpc;

    const discovery = new LocalDwnDiscovery(rpcClient);
    const first = await discovery.getEndpoint();
    const second = await discovery.getEndpoint();

    expect(first).toBe(second);
    // Only one getServerInfo call — the second call was served from cache.
    expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(1);
  });

  it('should cache a negative result and return undefined without re-probing', async () => {
    const rpcClient = {
      getServerInfo: sinon.stub().rejects(new Error('connection refused')),
    } as unknown as Web5Rpc;

    const discovery = new LocalDwnDiscovery(rpcClient);
    const first = await discovery.getEndpoint();
    const second = await discovery.getEndpoint();

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    // Only probed once — the second call was served from cache.
    const expectedCalls = localDwnPortCandidates.length * localDwnHostCandidates.length;
    expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(expectedCalls);
  });

  it('should re-probe after the cache TTL expires', async () => {
    const rpcClient = {
      getServerInfo: sinon.stub().resolves({ server: localDwnServerName }),
    } as unknown as Web5Rpc;

    // Use a 0ms TTL so the cache expires immediately.
    const discovery = new LocalDwnDiscovery(rpcClient, 0);
    await discovery.getEndpoint();
    await discovery.getEndpoint();

    // Both calls triggered a probe because the cache expired immediately.
    expect((rpcClient.getServerInfo as sinon.SinonStub).callCount).toBe(2);
  });

  it('should strip trailing slashes from the discovered endpoint', async () => {
    // Simulate a port where the endpoint might logically have a trailing slash.
    // The normalizeBaseUrl function inside LocalDwnDiscovery handles this.
    // Since getServerInfo doesn't return the URL (we construct it), the trailing
    // slash only matters if someone appends one manually — but we verify the
    // returned URL is clean.
    const rpcClient = {
      getServerInfo: sinon.stub().resolves({ server: localDwnServerName }),
    } as unknown as Web5Rpc;

    const discovery = new LocalDwnDiscovery(rpcClient);
    const endpoint = await discovery.getEndpoint();

    expect(endpoint).not.toMatch(/\/$/);
  });
});
