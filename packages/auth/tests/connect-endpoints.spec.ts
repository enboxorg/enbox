import type { EnboxUserAgent } from '@enbox/agent';

import type { AuthEventMap } from '../src/types.js';

import sinon from 'sinon';
import { afterEach, describe, expect, test } from 'bun:test';

import { AuthEventEmitter } from '../src/events.js';
import { AuthManager } from '../src/auth-manager.js';

const OWNER_DID = 'did:dht:owner';
const DELEGATE_DID = 'did:dht:delegate';

/**
 * Build a minimal AuthManager wired only for the surface `refreshConnection`
 * and `startServiceConfigWatch` touch: the emitter, shutdown flags, an active
 * delegated session, and a stubbable `agent.identity` endpoint surface.
 */
function createManager(overrides: {
  getDwnEndpoints?: sinon.SinonStub;
  refreshDwnEndpoints?: sinon.SinonStub;
  session?: boolean;
} = {}): { manager: AuthManager; emitter: AuthEventEmitter } {
  const manager = Object.create(AuthManager.prototype) as AuthManager;
  const emitter = new AuthEventEmitter();
  const internals = manager as unknown as Record<string, unknown>;

  internals._emitter = emitter;
  internals._isShutDown = false;
  internals._isShuttingDown = false;
  internals._userAgent = {
    identity: {
      getDwnEndpoints     : overrides.getDwnEndpoints ?? sinon.stub().resolves([]),
      refreshDwnEndpoints : overrides.refreshDwnEndpoints ?? sinon.stub().resolves([]),
    },
  } as unknown as EnboxUserAgent;
  internals._session = overrides.session === false
    ? undefined
    : { did: OWNER_DID, delegateDid: DELEGATE_DID };

  return { manager, emitter };
}

describe('AuthManager.refreshConnection()', () => {
  afterEach(() => sinon.restore());

  test('throws when there is no active session', async () => {
    const { manager } = createManager({ session: false });
    await expect(manager.refreshConnection()).rejects.toThrow('requires an active session');
  });

  test('emits connection-endpoints-changed with the added delta when an endpoint is added', async () => {
    const before = ['https://a.example/dwn'];
    const after = ['https://a.example/dwn', 'https://b.example/dwn'];
    const { manager, emitter } = createManager({
      getDwnEndpoints     : sinon.stub().resolves(before),
      refreshDwnEndpoints : sinon.stub().resolves(after),
    });

    const events: AuthEventMap['connection-endpoints-changed'][] = [];
    emitter.on('connection-endpoints-changed', (e) => events.push(e));

    const result = await manager.refreshConnection();

    expect(result).toEqual(after);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({
      connectedDid : OWNER_DID,
      endpoints    : after,
      added        : ['https://b.example/dwn'],
      removed      : [],
    });
  });

  test('emits the removed delta when an endpoint is removed', async () => {
    const before = ['https://a.example/dwn', 'https://b.example/dwn'];
    const after = ['https://a.example/dwn'];
    const { manager, emitter } = createManager({
      getDwnEndpoints     : sinon.stub().resolves(before),
      refreshDwnEndpoints : sinon.stub().resolves(after),
    });

    const events: AuthEventMap['connection-endpoints-changed'][] = [];
    emitter.on('connection-endpoints-changed', (e) => events.push(e));

    await manager.refreshConnection();

    expect(events.length).toBe(1);
    expect(events[0].added).toEqual([]);
    expect(events[0].removed).toEqual(['https://b.example/dwn']);
  });

  test('does not emit when the endpoint set is unchanged', async () => {
    const same = ['https://a.example/dwn'];
    const { manager, emitter } = createManager({
      getDwnEndpoints     : sinon.stub().resolves([...same]),
      refreshDwnEndpoints : sinon.stub().resolves([...same]),
    });

    const events: AuthEventMap['connection-endpoints-changed'][] = [];
    emitter.on('connection-endpoints-changed', (e) => events.push(e));

    const result = await manager.refreshConnection();

    expect(result).toEqual(same);
    expect(events.length).toBe(0);
  });

  test('treats a resolution failure for the prior set as an empty baseline', async () => {
    const after = ['https://a.example/dwn'];
    const { manager, emitter } = createManager({
      getDwnEndpoints     : sinon.stub().rejects(new Error('Failed to dereference')),
      refreshDwnEndpoints : sinon.stub().resolves(after),
    });

    const events: AuthEventMap['connection-endpoints-changed'][] = [];
    emitter.on('connection-endpoints-changed', (e) => events.push(e));

    const result = await manager.refreshConnection();

    expect(result).toEqual(after);
    expect(events[0].added).toEqual(after);
    expect(events[0].removed).toEqual([]);
  });
});

describe('AuthManager.startServiceConfigWatch()', () => {
  afterEach(() => sinon.restore());

  test('throws without an active delegated session', async () => {
    const { manager } = createManager({ session: false });
    await expect(manager.startServiceConfigWatch()).rejects.toThrow('requires an active delegated session');
  });
});
