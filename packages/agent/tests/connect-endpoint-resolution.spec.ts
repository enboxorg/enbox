import type { EnboxPlatformAgent } from '../src/types/agent.js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  CONNECT_ENDPOINT_RESOLUTION_TIMEOUT_MS,
  resolveConnectDwnEndpointUrls,
} from '../src/connect-endpoint-resolution.js';

describe('connect endpoint resolution', () => {
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
    await clock.tickAsync(CONNECT_ENDPOINT_RESOLUTION_TIMEOUT_MS);

    expect(await outcome).toEqual(new Error(
      `Connect DWN endpoint resolution for 'did:example:alice' timed out after ${CONNECT_ENDPOINT_RESOLUTION_TIMEOUT_MS}ms.`,
    ));
  });
});
