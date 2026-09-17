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

  it('should bound endpoint and requester-supplied delegate key resolution', async () => {
    const endpointTimeout = new AbortController();
    const delegateTimeout = new AbortController();
    const timeoutStub = sinon.stub(AbortSignal, 'timeout');
    timeoutStub.onFirstCall().returns(endpointTimeout.signal);
    timeoutStub.onSecondCall().returns(delegateTimeout.signal);
    const endpointAgent = {
      dwn: { getRemoteDwnEndpointUrls: sinon.stub().returns(new Promise<string[]>(() => {})) },
    } as unknown as EnboxPlatformAgent;
    const delegateAgent = {
      did: { resolve: sinon.stub().returns(new Promise(() => {})) },
    } as unknown as EnboxPlatformAgent;

    const outcomes = Promise.all([
      resolveConnectDwnEndpointUrls(endpointAgent, 'did:example:alice')
        .catch((error: unknown) => error),
      resolveConnectDelegateEncryptionKeyInfo(delegateAgent, 'did:dht:delegate')
        .catch((error: unknown) => error),
    ]);
    endpointTimeout.abort(new DOMException('The operation timed out', 'TimeoutError'));
    delegateTimeout.abort(new DOMException('The operation timed out', 'TimeoutError'));
    const [endpointError, delegateError] = await outcomes;

    expect(endpointError).toEqual(new Error(
      `Connect DWN endpoint resolution for 'did:example:alice' timed out after ${CONNECT_DID_RESOLUTION_TIMEOUT_MS}ms.`,
    ));
    expect(delegateError).toEqual(new Error(
      `Connect delegate encryption key resolution for 'did:dht:delegate' timed out after ${CONNECT_DID_RESOLUTION_TIMEOUT_MS}ms.`,
    ));
    expect(timeoutStub.callCount).toBe(2);
    expect(timeoutStub.alwaysCalledWith(CONNECT_DID_RESOLUTION_TIMEOUT_MS)).toBe(true);
  });
});
