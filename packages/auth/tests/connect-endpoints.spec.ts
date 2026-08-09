import type { DidResolutionResult, DwnEndpointResolution } from '@enbox/dids';
import type { DwnSubscriptionMessage, EnboxUserAgent } from '@enbox/agent';

import type { AuthEventMap } from '../src/types.js';

import sinon from 'sinon';

import { afterEach, describe, expect, test } from 'bun:test';

import { DwnEndpointResolutionError, DwnEndpointResolutionErrorCode } from '@enbox/dids';

import { AuthEventEmitter } from '../src/events.js';
import { AuthManager } from '../src/auth-manager.js';
import { SERVICE_CONFIG_PROTOCOL_PATH, SERVICE_CONFIG_PROTOCOL_URI } from '../src/index.js';

const OWNER_DID = 'did:dht:owner';
const DELEGATE_DID = 'did:jwk:delegate';

function ready(endpoints: string[]): DwnEndpointResolution {
  return { status: 'ready', didUri: OWNER_DID, endpoints };
}

function serviceMissing(): DwnEndpointResolution {
  return {
    status : 'service-missing',
    didUri : OWNER_DID,
    error  : new DwnEndpointResolutionError({
      code    : DwnEndpointResolutionErrorCode.ServiceMissing,
      didUri  : OWNER_DID,
      message : `DID '${OWNER_DID}' does not advertise a DecentralizedWebNode service.`,
    }),
  };
}

function resolutionWithEndpoints(endpoints: string[]): DidResolutionResult {
  return {
    didDocument: {
      id      : OWNER_DID,
      service : [{
        id              : `${OWNER_DID}#dwn`,
        type            : 'DecentralizedWebNode',
        serviceEndpoint : endpoints,
      }],
    },
    didDocumentMetadata   : {},
    didResolutionMetadata : {},
  };
}

function createManager(overrides: {
  resolve?: sinon.SinonStub;
  refreshDwnEndpointStatus?: sinon.SinonStub;
  processRequest?: sinon.SinonStub;
  session?: 'delegated' | 'owner' | 'none';
  baseline?: DwnEndpointResolution;
} = {}): { manager: AuthManager; emitter: AuthEventEmitter } {
  const manager = Object.create(AuthManager.prototype) as AuthManager;
  const emitter = new AuthEventEmitter();
  const internals = manager as unknown as Record<string, unknown>;
  const sessionType = overrides.session ?? 'delegated';

  internals._emitter = emitter;
  internals._isShutDown = false;
  internals._isShuttingDown = false;
  internals._serviceConfigWatchGeneration = 0;
  internals._userAgent = {
    did: {
      resolve: overrides.resolve ?? sinon.stub().resolves(resolutionWithEndpoints([])),
    },
    dwn: {
      processRequest: overrides.processRequest ?? sinon.stub(),
    },
    identity: {
      refreshDwnEndpointStatus: overrides.refreshDwnEndpointStatus ?? sinon.stub().resolves(ready([])),
    },
  } as unknown as EnboxUserAgent;
  const session = sessionType === 'none'
    ? undefined
    : {
      did         : OWNER_DID,
      delegateDid : sessionType === 'delegated' ? DELEGATE_DID : undefined,
      signal      : new AbortController().signal,
    };
  internals._session = session;
  if (session !== undefined && overrides.baseline !== undefined) {
    internals._connectionEndpointBaseline = { session, status: overrides.baseline };
  }

  return { manager, emitter };
}

describe('AuthManager.refreshConnection()', () => {
  afterEach(() => sinon.restore());

  test('throws without an active session', async () => {
    const { manager } = createManager({ session: 'none' });
    await expect(manager.refreshConnection()).rejects.toThrow('requires an active session');
  });

  test('emits the freshly resolved status and endpoint delta', async () => {
    const before = ['https://a.example/dwn'];
    const after = ['https://a.example/dwn', 'https://b.example/dwn'];
    const refreshDwnEndpointStatus = sinon.stub().resolves(ready(after));
    const { manager, emitter } = createManager({
      baseline : ready(before),
      resolve  : sinon.stub().resolves(resolutionWithEndpoints(before)),
      refreshDwnEndpointStatus,
    });
    const events: AuthEventMap['connection-endpoints-changed'][] = [];
    emitter.on('connection-endpoints-changed', (event) => events.push(event));

    await expect(manager.refreshConnection()).resolves.toEqual(ready(after));

    expect(refreshDwnEndpointStatus.calledOnceWithExactly({ didUri: OWNER_DID })).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      connectedDid : OWNER_DID,
      endpoints    : after,
      added        : ['https://b.example/dwn'],
      removed      : [],
      current      : ready(after),
    });
  });

  test('returns and emits a typed missing-service status when all endpoints disappear', async () => {
    const before = ['https://a.example/dwn'];
    const missing = serviceMissing();
    const { manager, emitter } = createManager({
      baseline                 : ready(before),
      resolve                  : sinon.stub().resolves(resolutionWithEndpoints(before)),
      refreshDwnEndpointStatus : sinon.stub().resolves(missing),
    });
    const events: AuthEventMap['connection-endpoints-changed'][] = [];
    emitter.on('connection-endpoints-changed', (event) => events.push(event));

    await expect(manager.refreshConnection()).resolves.toEqual(missing);
    expect(events[0]).toMatchObject({
      current   : missing,
      endpoints : [],
      added     : [],
      removed   : before,
    });
  });

  test('does not emit when the endpoint status is unchanged', async () => {
    const endpoints = ['https://a.example/dwn'];
    const { manager, emitter } = createManager({
      baseline                 : ready(endpoints),
      resolve                  : sinon.stub().resolves(resolutionWithEndpoints(endpoints)),
      refreshDwnEndpointStatus : sinon.stub().resolves(ready([...endpoints])),
    });
    const events: AuthEventMap['connection-endpoints-changed'][] = [];
    emitter.on('connection-endpoints-changed', (event) => events.push(event));

    await manager.refreshConnection();

    expect(events).toHaveLength(0);
  });

  test('emits a current status when no per-session baseline survived resolver-cache expiry', async () => {
    const endpoints = ['https://new.example/dwn'];
    const { manager, emitter } = createManager({
      resolve                  : sinon.stub().resolves(resolutionWithEndpoints(endpoints)),
      refreshDwnEndpointStatus : sinon.stub().resolves(ready(endpoints)),
    });
    const events: AuthEventMap['connection-endpoints-changed'][] = [];
    emitter.on('connection-endpoints-changed', (event) => events.push(event));

    await manager.refreshConnection();

    expect(events).toHaveLength(1);
    expect(events[0].current).toEqual(ready(endpoints));
  });
});

describe('AuthManager service-config watch', () => {
  afterEach(() => sinon.restore());

  test('requires an active delegated session', async () => {
    const { manager } = createManager({ session: 'owner' });
    await expect(manager.startServiceConfigWatch()).rejects.toThrow('requires an active delegated session');
  });

  test('subscribes to the protocol, ignores lifecycle frames, and coalesces record events', async () => {
    let handler: ((message: DwnSubscriptionMessage) => void) | undefined;
    const close = sinon.stub().resolves();
    const processRequest = sinon.stub().callsFake(async (request: {
      subscriptionHandler?: (message: DwnSubscriptionMessage) => void;
    }) => {
      handler = request.subscriptionHandler;
      return {
        reply: {
          status       : { code: 200, detail: 'OK' },
          subscription : { close },
        },
      };
    });
    let releaseFirst!: () => void;
    const firstRefresh = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const { manager } = createManager({ processRequest });
    let blockNextRefresh = false;
    const refreshConnection = sinon.stub(manager as any, '_refreshConnection');
    refreshConnection.callsFake(async () => {
      if (blockNextRefresh) {
        blockNextRefresh = false;
        await firstRefresh;
      }
      return ready(['https://fresh.example/dwn']);
    });

    const stop = await manager.startServiceConfigWatch();
    refreshConnection.resetHistory();
    blockNextRefresh = true;

    expect(processRequest.calledOnce).toBe(true);
    expect(processRequest.firstCall.args[0]).toMatchObject({
      author        : DELEGATE_DID,
      target        : OWNER_DID,
      messageType   : 'RecordsSubscribe',
      messageParams : {
        filter: {
          protocol     : SERVICE_CONFIG_PROTOCOL_URI,
          protocolPath : SERVICE_CONFIG_PROTOCOL_PATH,
        },
      },
    });

    handler?.({ type: 'eose', cursor: { streamId: 'stream', epoch: 'epoch', position: '1' } });
    expect(refreshConnection.notCalled).toBe(true);
    handler?.({ type: 'event', cursor: { streamId: 'stream', epoch: 'epoch', position: '2' }, event: {} as never });
    handler?.({ type: 'event', cursor: { streamId: 'stream', epoch: 'epoch', position: '3' }, event: {} as never });
    handler?.({ type: 'event', cursor: { streamId: 'stream', epoch: 'epoch', position: '4' }, event: {} as never });
    expect(refreshConnection.calledOnce).toBe(true);

    releaseFirst();
    await firstRefresh;
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshConnection.callCount).toBe(2);

    stop();
    expect(close.calledOnce).toBe(true);
    handler?.({ type: 'event', cursor: { streamId: 'stream', epoch: 'epoch', position: '5' }, event: {} as never });
    expect(refreshConnection.callCount).toBe(2);
  });

  test('does not retain a failed subscription', async () => {
    const processRequest = sinon.stub().resolves({
      reply: { status: { code: 401, detail: 'Unauthorized' } },
    });
    const { manager } = createManager({ processRequest });

    await expect(manager.startServiceConfigWatch()).rejects.toThrow('401 - Unauthorized');
    expect((manager as unknown as { _serviceConfigWatch?: unknown })._serviceConfigWatch).toBeUndefined();
  });

  test('subscribes before its initial refresh and drains an announcement observed during setup', async () => {
    const close = sinon.stub().resolves();
    const processRequest = sinon.stub().callsFake(async (request: {
      subscriptionHandler?: (message: DwnSubscriptionMessage) => void;
    }) => {
      request.subscriptionHandler?.({
        type   : 'event',
        cursor : { streamId: 'stream', epoch: 'epoch', position: '1' },
        event  : {} as never,
      });
      return {
        reply: {
          status       : { code: 200, detail: 'OK' },
          subscription : { close },
        },
      };
    });
    const { manager } = createManager({ processRequest });
    const refreshConnection = sinon.stub(manager as any, '_refreshConnection')
      .resolves(ready(['https://fresh.example/dwn']));

    const stop = await manager.startServiceConfigWatch();
    await Promise.resolve();

    expect(refreshConnection.callCount).toBe(2);
    expect(refreshConnection.alwaysCalledWithExactly(true)).toBe(true);
    stop();
    expect(close.calledOnce).toBe(true);
  });

  test('fences concurrent starts and closes the superseded subscription', async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const firstReply = new Promise((resolve) => { resolveFirst = resolve; });
    const secondReply = new Promise((resolve) => { resolveSecond = resolve; });
    const processRequest = sinon.stub();
    processRequest.onFirstCall().returns(firstReply);
    processRequest.onSecondCall().returns(secondReply);
    const firstClose = sinon.stub().resolves();
    const secondClose = sinon.stub().resolves();
    const { manager } = createManager({ processRequest });
    sinon.stub(manager as any, '_refreshConnection').resolves(ready(['https://fresh.example/dwn']));

    const firstStart = manager.startServiceConfigWatch();
    await Promise.resolve();
    const secondStart = manager.startServiceConfigWatch();
    await Promise.resolve();

    resolveSecond({
      reply: {
        status       : { code: 200, detail: 'OK' },
        subscription : { close: secondClose },
      },
    });
    const stopSecond = await secondStart;
    resolveFirst({
      reply: {
        status       : { code: 200, detail: 'OK' },
        subscription : { close: firstClose },
      },
    });

    await expect(firstStart).rejects.toThrow('invalidated by a session lifecycle change');
    expect(firstClose.calledOnce).toBe(true);
    expect(secondClose.notCalled).toBe(true);

    stopSecond();
    expect(secondClose.calledOnce).toBe(true);
  });

  test('retries a queued announcement after a transient resolution failure', async () => {
    let handler: ((message: DwnSubscriptionMessage) => void) | undefined;
    const processRequest = sinon.stub().callsFake(async (request: {
      subscriptionHandler?: (message: DwnSubscriptionMessage) => void;
    }) => {
      handler = request.subscriptionHandler;
      return {
        reply: {
          status       : { code: 200, detail: 'OK' },
          subscription : { close: sinon.stub().resolves() },
        },
      };
    });
    const { manager } = createManager({ processRequest });
    let rejectRefresh!: (error: Error) => void;
    const transientFailure = new Promise<DwnEndpointResolution>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    let watchStarted = false;
    let refreshAttempts = 0;
    const refreshConnection = sinon.stub(manager as any, '_refreshConnection');
    refreshConnection.callsFake(async () => {
      if (!watchStarted) {
        return ready(['https://fresh.example/dwn']);
      }
      refreshAttempts++;
      if (refreshAttempts === 1) {
        return transientFailure;
      }
      return ready(['https://fresh.example/dwn']);
    });
    const stop = await manager.startServiceConfigWatch();
    watchStarted = true;
    refreshConnection.resetHistory();

    handler?.({
      type   : 'event',
      cursor : { streamId: 'stream', epoch: 'epoch', position: '1' },
      event  : {} as never,
    });
    handler?.({
      type   : 'event',
      cursor : { streamId: 'stream', epoch: 'epoch', position: '2' },
      event  : {} as never,
    });
    rejectRefresh(new Error('resolver unavailable'));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(refreshConnection.callCount).toBe(2);
    stop();
  });
});
