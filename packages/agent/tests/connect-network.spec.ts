import type { EnboxPlatformAgent } from '../src/types/agent.js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  CONNECT_DID_RESOLUTION_TIMEOUT_MS,
  resolveConnectDelegateEncryptionKeyInfo,
  resolveConnectDwnEndpointUrls,
} from '../src/connect-network.js';

describe('connect network resolution', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should return resolved remote DWN endpoints', async () => {
    const getRemoteDwnEndpointUrls = sinon.stub().resolves([
      'https://dwn-a.example/',
      'https://dwn-b.example/',
    ]);
    const agent = { dwn: { getRemoteDwnEndpointUrls } } as unknown as EnboxPlatformAgent;

    await expect(resolveConnectDwnEndpointUrls(agent, 'did:example:alice')).resolves.toEqual([
      'https://dwn-a.example/',
      'https://dwn-b.example/',
    ]);
    expect(getRemoteDwnEndpointUrls.calledOnceWith('did:example:alice')).toBe(true);
  });

  it('should preserve endpoint resolution failures', async () => {
    const resolutionError = new Error('DID resolution failed');
    const agent = {
      dwn: { getRemoteDwnEndpointUrls: sinon.stub().rejects(resolutionError) },
    } as unknown as EnboxPlatformAgent;

    await expect(resolveConnectDwnEndpointUrls(agent, 'did:example:alice')).rejects.toBe(resolutionError);
  });

  it('should reject when endpoint resolution exceeds the interactive budget', async () => {
    const clock = sinon.useFakeTimers();
    const agent = {
      dwn: { getRemoteDwnEndpointUrls: sinon.stub().returns(new Promise<string[]>(() => {})) },
    } as unknown as EnboxPlatformAgent;

    const resolution = resolveConnectDwnEndpointUrls(agent, 'did:example:alice');
    const outcome = resolution.catch((error: unknown) => error);
    await clock.tickAsync(CONNECT_DID_RESOLUTION_TIMEOUT_MS);

    expect(await outcome).toEqual(new Error(
      `Connect DWN endpoint resolution for 'did:example:alice' timed out after ${CONNECT_DID_RESOLUTION_TIMEOUT_MS}ms.`,
    ));
  });

  it('should also bound requester-supplied delegate key resolution', async () => {
    const clock = sinon.useFakeTimers();
    const agent = {
      did: { resolve: sinon.stub().returns(new Promise(() => {})) },
    } as unknown as EnboxPlatformAgent;

    const resolution = resolveConnectDelegateEncryptionKeyInfo(agent, 'did:dht:delegate');
    const outcome = resolution.catch((error: unknown) => error);
    await clock.tickAsync(CONNECT_DID_RESOLUTION_TIMEOUT_MS);

    expect(await outcome).toEqual(new Error(
      `Connect delegate encryption key resolution for 'did:dht:delegate' timed out after ${CONNECT_DID_RESOLUTION_TIMEOUT_MS}ms.`,
    ));
  });
});
