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
  const linkKey = 'did:example:alice^https://dwn.example.com^projection-1^authorization-1';
  const scope = { kind: 'protocolSet', protocols: ['https://proto.example.com'] };
  const target = {
    did                : 'did:example:alice',
    dwnUrl             : 'https://dwn.example.com',
    scope,
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'authorization-1',
  };

  const makeLink = (overrides: Record<string, unknown> = {}): any => ({
    tenantDid          : 'did:example:alice',
    remoteEndpoint     : 'https://dwn.example.com',
    projectionId       : 'projection-1',
    authorizationEpoch : 'authorization-1',
    authorization      : { kind: 'owner' },
    scope,
    status             : 'initializing',
    pull               : {},
    connectivity       : 'unknown',
    ...overrides,
  });

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

    const link = makeLink();

    const saveLinkStub = sinon.stub().resolves();
    const setStatusStub = sinon.stub().callsFake(async (l: any, status: string): Promise<void> => {
      l.status = status;
    });

    sinon.stub(engine, 'sync').resolves();
    sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
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

    const link = makeLink();

    sinon.stub(engine, 'sync').resolves();
    sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
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

  it('routes ProgressGap startup failures into repair using projection authorization link identity', async () => {
    const { agent } = createLiveMockAgent();
    const engine = new SyncEngineLevel({ db, agent });

    const link = makeLink();

    sinon.stub(engine, 'sync').resolves();
    sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
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
    expect(transitionStub.firstCall.args[0]).toBe(linkKey);
    expect(transitionStub.firstCall.args[1]).toBe(link);
  });

});
