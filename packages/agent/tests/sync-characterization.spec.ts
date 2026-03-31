import sinon from 'sinon';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

type CapturedSubscriptionHandler = ((msg: any) => Promise<void>) | undefined;

type LiveMockAgent = {
  agent: any;
  getLocalHandler: () => CapturedSubscriptionHandler;
  getRemoteHandler: () => CapturedSubscriptionHandler;
  processRequestStub: sinon.SinonStub;
  rpcStub: sinon.SinonStub;
};

function createLiveMockAgent(): LiveMockAgent {
  let localHandler: CapturedSubscriptionHandler;
  let remoteHandler: CapturedSubscriptionHandler;

  const processRequestStub = sinon.stub().callsFake(async (request: any) => {
    if (request.subscriptionHandler) {
      localHandler = request.subscriptionHandler;
      return {
        reply   : { status: { code: 200, detail: 'OK' }, subscription: { close: sinon.stub().resolves() } },
        message : { descriptor: {} },
      };
    }

    return { message: { descriptor: {} } };
  });
  const rpcStub = sinon.stub().callsFake(async (request: any) => {
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
        processRequest    : processRequestStub,
        processRawMessage : sinon.stub().resolves({ status: { code: 202 } }),
      },
      rpc: { sendDwnRequest: rpcStub },
    } as any,
    getLocalHandler  : (): CapturedSubscriptionHandler => localHandler,
    getRemoteHandler : (): CapturedSubscriptionHandler => remoteHandler,
    processRequestStub,
    rpcStub,
  };
}

describe('SyncEngineLevel — characterization tests', () => {
  let db: Level<string, string>;

  beforeAll(async () => {
    db = new Level<string, string>('__TESTDATA__/sync-characterization-spec');
  });

  afterEach(async () => {
    sinon.restore();
    await db.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('does not mutate state when a late pull callback fires after stopSync()', async () => {
    const { agent, getRemoteHandler } = createLiveMockAgent();
    const engine = new SyncEngineLevel({ db, agent });

    const link = {
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scopeId        : 'scope-1',
      scope          : { kind: 'protocol', protocol: 'https://proto.example.com' },
      status         : 'initializing',
      pull           : {},
      connectivity   : 'unknown',
      needsReconcile : false,
      protocol       : 'https://proto.example.com',
    } as any;

    const saveLinkStub = sinon.stub().resolves();
    const setStatusStub = sinon.stub().callsFake(async (l: any, status: string): Promise<void> => {
      l.status = status;
    });

    sinon.stub(engine, 'sync').resolves();
    sinon.stub(engine as any, 'getSyncTargets').resolves([
      { did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', protocol: 'https://proto.example.com' },
    ]);
    sinon.stub(engine as any, 'openLocalPushSubscription').resolves();
    (engine as any)._ledger = {
      getOrCreateLink : sinon.stub().resolves(link),
      saveLink        : saveLinkStub,
      setStatus       : setStatusStub,
    };

    await engine.startSync({ mode: 'live', interval: '30s' });

    const handler = getRemoteHandler();
    expect(handler).toBeDefined();

    const savesBeforeStop = saveLinkStub.callCount;
    await engine.stopSync();

    expect((engine as any)._activeLinks.size).toBe(0);

    await handler!({
      type   : 'eose',
      cursor : { streamId: 's1', epoch: 'e1', position: '1', messageCid: 'cid-1' },
    });

    expect(saveLinkStub.callCount).toBe(savesBeforeStop);
    expect((engine as any)._connectivityState).not.toBe('online');
  });

  it('does not enqueue push work when a late local callback fires after stopSync()', async () => {
    const { agent, getLocalHandler } = createLiveMockAgent();
    const engine = new SyncEngineLevel({ db, agent });

    const link = {
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scopeId        : 'scope-1',
      scope          : { kind: 'protocol', protocol: 'https://proto.example.com' },
      status         : 'initializing',
      pull           : {},
      connectivity   : 'unknown',
      needsReconcile : false,
      protocol       : 'https://proto.example.com',
    } as any;

    sinon.stub(engine, 'sync').resolves();
    sinon.stub(engine as any, 'getSyncTargets').resolves([
      { did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', protocol: 'https://proto.example.com' },
    ]);
    sinon.stub(engine as any, 'openLivePullSubscription').resolves();
    (engine as any)._ledger = {
      getOrCreateLink : sinon.stub().resolves(link),
      saveLink        : sinon.stub().resolves(),
      setStatus       : sinon.stub().callsFake(async (l: any, status: string): Promise<void> => {
        l.status = status;
      }),
    };

    await engine.startSync({ mode: 'live', interval: '30s' });

    const handler = getLocalHandler();
    expect(handler).toBeDefined();

    await engine.stopSync();

    await handler!({
      type   : 'event',
      cursor : { streamId: 's1', epoch: 'e1', position: '1', messageCid: 'cid-1' },
      event  : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
    });

    expect((engine as any)._pushRuntimes.size).toBe(0);
  });

  it('schedules reconciliation on startup when a link is already marked needsReconcile', async () => {
    const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
    const { agent } = createLiveMockAgent();
    const engine = new SyncEngineLevel({ db, agent });

    const link = {
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scopeId        : 'scope-1',
      scope          : { kind: 'protocol', protocol: 'https://proto.example.com' },
      status         : 'initializing',
      pull           : {},
      connectivity   : 'unknown',
      needsReconcile : true,
      protocol       : 'https://proto.example.com',
    } as any;

    sinon.stub(engine, 'sync').resolves();
    sinon.stub(engine as any, 'getSyncTargets').resolves([
      { did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', protocol: 'https://proto.example.com' },
    ]);
    sinon.stub(engine as any, 'openLivePullSubscription').resolves();
    sinon.stub(engine as any, 'openLocalPushSubscription').resolves();
    const reconcileStub = sinon.stub(engine as any, 'reconcileLink').resolves();
    (engine as any)._ledger = {
      getOrCreateLink : sinon.stub().resolves(link),
      setStatus       : sinon.stub().callsFake(async (l: any, status: string): Promise<void> => {
        l.status = status;
      }),
      saveLink: sinon.stub().resolves(),
    };

    await engine.startSync({ mode: 'live', interval: '30s' });
    await clock.tickAsync(1_000);

    expect(reconcileStub.calledOnce).toBe(true);
    expect(reconcileStub.firstCall.args[0]).toBe('did:example:alice^https://dwn.example.com^scope-1');

    await engine.stopSync();
    clock.restore();
  });

  it('routes ProgressGap startup failures into repair using scopeId-based link identity', async () => {
    const { agent } = createLiveMockAgent();
    const engine = new SyncEngineLevel({ db, agent });

    const link = {
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scopeId        : 'scope-1',
      scope          : { kind: 'protocol', protocol: 'https://proto.example.com' },
      status         : 'initializing',
      pull           : {},
      connectivity   : 'unknown',
      needsReconcile : false,
      protocol       : 'https://proto.example.com',
    } as any;

    sinon.stub(engine, 'sync').resolves();
    sinon.stub(engine as any, 'getSyncTargets').resolves([
      { did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', protocol: 'https://proto.example.com' },
    ]);
    sinon.stub(engine as any, 'openLivePullSubscription').rejects({
      isProgressGap : true,
      gapInfo       : { latestAvailable: { streamId: 's1', epoch: 'e1', position: '7', messageCid: 'cid-7' } },
    });
    const transitionStub = sinon.stub(engine as any, 'transitionToRepairing').resolves();
    (engine as any)._ledger = {
      getOrCreateLink : sinon.stub().resolves(link),
      setStatus       : sinon.stub().resolves(),
      saveLink        : sinon.stub().resolves(),
    };

    await engine.startSync({ mode: 'live', interval: '30s' });

    expect(transitionStub.calledOnce).toBe(true);
    expect(transitionStub.firstCall.args[0]).toBe('did:example:alice^https://dwn.example.com^scope-1');
    expect(transitionStub.firstCall.args[1]).toBe(link);
  });

  it('schedules reconciliation when EOSE arrives for a live dirty link', async () => {
    const { agent, getRemoteHandler } = createLiveMockAgent();
    const engine = new SyncEngineLevel({ db, agent });

    const link = {
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scopeId        : 'scope-1',
      scope          : { kind: 'protocol', protocol: 'https://proto.example.com' },
      status         : 'live',
      pull           : {},
      connectivity   : 'unknown',
      needsReconcile : true,
      protocol       : 'https://proto.example.com',
    } as any;

    const saveLinkStub = sinon.stub().resolves();
    sinon.stub(engine as any, 'scheduleReconcile').callsFake((): void => {});
    sinon.stub(engine, 'sync').resolves();
    sinon.stub(engine as any, 'getSyncTargets').resolves([
      { did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', protocol: 'https://proto.example.com' },
    ]);
    sinon.stub(engine as any, 'openLocalPushSubscription').resolves();
    (engine as any)._ledger = {
      getOrCreateLink : sinon.stub().resolves(link),
      saveLink        : saveLinkStub,
      setStatus       : sinon.stub().callsFake(async (l: any, status: string): Promise<void> => {
        l.status = status;
      }),
    };

    await engine.startSync({ mode: 'live', interval: '30s' });

    const handler = getRemoteHandler();
    expect(handler).toBeDefined();

    await handler!({
      type   : 'eose',
      cursor : { streamId: 's1', epoch: 'e1', position: '5', messageCid: 'cid-5' },
    });

    expect((engine as any).scheduleReconcile.called).toBe(true);
    expect((engine as any).scheduleReconcile.lastCall.args[0]).toBe('did:example:alice^https://dwn.example.com^scope-1');
    expect((engine as any).scheduleReconcile.lastCall.args[1]).toBe(500);

    await engine.stopSync();
  });
});
