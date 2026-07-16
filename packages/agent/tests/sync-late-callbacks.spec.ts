import sinon from 'sinon';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

type CapturedSubscriptionHandler = ((message: unknown) => Promise<void>) | undefined;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type LiveMockAgent = {
  agent: unknown;
  getLocalHandler: () => CapturedSubscriptionHandler;
  getRemoteHandler: () => CapturedSubscriptionHandler;
};

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createLiveMockAgent(): LiveMockAgent {
  let localHandler: CapturedSubscriptionHandler;
  let remoteHandler: CapturedSubscriptionHandler;

  const processRequestStub = sinon.stub().callsFake(async (request: { subscriptionHandler?: CapturedSubscriptionHandler }) => {
    if (request.subscriptionHandler !== undefined) {
      localHandler = request.subscriptionHandler;
      return {
        reply   : { status: { code: 200, detail: 'OK' }, subscription: { close: sinon.stub().resolves() } },
        message : { descriptor: {} },
      };
    }

    return { message: { descriptor: {} } };
  });
  const rpcStub = sinon.stub().callsFake(async (request: { subscription?: { handler?: CapturedSubscriptionHandler } }) => {
    remoteHandler = request.subscription?.handler;
    return {
      status       : { code: 200, detail: 'OK' },
      subscription : { close: sinon.stub().resolves() },
    };
  });

  return {
    agent: {
      agentDid : 'did:example:agent',
      dwn      : {
        processRawMessage : sinon.stub().resolves({ status: { code: 202 } }),
        processRequest    : processRequestStub,
      },
      rpc: { sendDwnRequest: rpcStub },
    },
    getLocalHandler  : (): CapturedSubscriptionHandler => localHandler,
    getRemoteHandler : (): CapturedSubscriptionHandler => remoteHandler,
  };
}

describe('SyncEngineLevel late subscription callbacks', () => {
  let db: Level<string, string>;
  const scope = { kind: 'protocolSet', protocols: ['https://proto.example.com'] };
  const target = {
    did                : 'did:example:alice',
    dwnUrl             : 'https://dwn.example.com',
    scope,
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'authorization-1',
  };

  const makeLink = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'authorization-1',
    connectivity       : 'unknown',
    projectionId       : 'projection-1',
    pull               : {},
    remoteEndpoint     : 'https://dwn.example.com',
    scope,
    status             : 'initializing',
    tenantDid          : 'did:example:alice',
    ...overrides,
  });

  beforeAll(async () => {
    db = new Level<string, string>('__TESTDATA__/sync-late-callbacks-spec');
  });

  afterEach(async () => {
    sinon.restore();
    await db.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should not mutate state when a late pull callback fires after stopSync()', async () => {
    const { agent, getRemoteHandler } = createLiveMockAgent();
    const engine = new SyncEngineLevel({ db, agent });

    const link = makeLink();

    const persistCheckpointStub = sinon.stub().resolves();
    const setStatusStub = sinon.stub().callsFake(async (linkState: Record<string, unknown>, status: string): Promise<void> => {
      linkState.status = status;
    });

    sinon.stub(engine, 'sync').resolves();
    sinon.stub(engine as never, 'getSyncTargets').resolves([target]);
    sinon.stub(engine as never, 'openLocalPushSubscription').resolves();
    Object.assign(engine, {
      _ledger: {
        getOrCreateLink   : sinon.stub().resolves(link),
        persistCheckpoint : persistCheckpointStub,
        setStatus         : setStatusStub,
      },
    });

    await engine.startSync({ mode: 'live', interval: '30s' });

    const handler = getRemoteHandler();
    expect(handler).toBeDefined();

    const savesBeforeStop = persistCheckpointStub.callCount;
    await engine.stopSync();

    expect(engine['_activeLinks'].size).toBe(0);

    await handler!({
      type   : 'eose',
      cursor : { streamId: 's1', epoch: 'e1', position: '1', messageCid: 'cid-1' },
    });

    expect(persistCheckpointStub.callCount).toBe(savesBeforeStop);
    expect(engine['_connectivityState']).not.toBe('online');
  });

  it('should wait for an in-flight pull callback before stopSync() completes', async () => {
    const { agent, getRemoteHandler } = createLiveMockAgent();
    const engine = new SyncEngineLevel({ db, agent });
    const link = makeLink();
    const handlerStarted = createDeferred();
    const releaseHandler = createDeferred();

    sinon.stub(engine, 'sync').resolves();
    sinon.stub(engine as never, 'getSyncTargets').resolves([target]);
    sinon.stub(engine as never, 'openLocalPushSubscription').resolves();
    sinon.stub(engine as never, 'handleLivePullMessage').callsFake(async (): Promise<void> => {
      handlerStarted.resolve();
      await releaseHandler.promise;
    });
    Object.assign(engine, {
      _ledger: {
        getOrCreateLink   : sinon.stub().resolves(link),
        persistCheckpoint : sinon.stub().resolves(),
        setStatus         : sinon.stub().callsFake(async (linkState: Record<string, unknown>, status: string): Promise<void> => {
          linkState.status = status;
        }),
      },
    });

    await engine.startSync({ mode: 'live', interval: '30s' });

    const handler = getRemoteHandler();
    expect(handler).toBeDefined();
    const handlerPromise = handler!({
      type   : 'eose',
      cursor : { streamId: 's1', epoch: 'e1', position: '1', messageCid: 'cid-1' },
    });
    await handlerStarted.promise;

    let stopCompleted = false;
    const stopPromise = engine.stopSync().then((): void => { stopCompleted = true; });
    await Promise.resolve();

    expect(stopCompleted).toBe(false);
    expect(db.status).toBe('open');

    releaseHandler.resolve();
    await Promise.all([handlerPromise, stopPromise]);

    expect(stopCompleted).toBe(true);
  });

  it('should not enqueue push work when a late local callback fires after stopSync()', async () => {
    const { agent, getLocalHandler } = createLiveMockAgent();
    const engine = new SyncEngineLevel({ db, agent });

    const link = makeLink();

    sinon.stub(engine, 'sync').resolves();
    sinon.stub(engine as never, 'getSyncTargets').resolves([target]);
    sinon.stub(engine as never, 'openLivePullSubscription').resolves();
    Object.assign(engine, {
      _ledger: {
        getOrCreateLink   : sinon.stub().resolves(link),
        persistCheckpoint : sinon.stub().resolves(),
        setStatus         : sinon.stub().callsFake(async (linkState: Record<string, unknown>, status: string): Promise<void> => {
          linkState.status = status;
        }),
      },
    });

    await engine.startSync({ mode: 'live', interval: '30s' });

    const handler = getLocalHandler();
    expect(handler).toBeDefined();

    await engine.stopSync();

    await handler!({
      type   : 'event',
      cursor : { streamId: 's1', epoch: 'e1', position: '1', messageCid: 'cid-1' },
      event  : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
    });

    expect(engine['_pushRuntimes'].size).toBe(0);
  });
});
