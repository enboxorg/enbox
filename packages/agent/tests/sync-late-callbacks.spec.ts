import type { SyncLinkController } from '../src/sync-link-controller.js';

import sinon from 'sinon';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

import { deferred as createDeferred } from './utils/deferred.js';

type CapturedSubscriptionHandler = ((message: unknown) => Promise<void>) | undefined;

type LiveMockAgent = {
  agent: unknown;
  getLocalHandler: () => CapturedSubscriptionHandler;
  getRemoteHandler: () => CapturedSubscriptionHandler;
};

function createLiveMockAgent(): LiveMockAgent {
  let localHandler: CapturedSubscriptionHandler;
  let remoteHandler: CapturedSubscriptionHandler;
  const head = { streamId: 's1', epoch: 'e1', position: '0', messageCid: 'cid-0' };

  const processRequestStub = sinon.stub().callsFake(async (request: { subscriptionHandler?: CapturedSubscriptionHandler }) => {
    if (request.subscriptionHandler !== undefined) {
      localHandler = request.subscriptionHandler;
      return {
        reply: {
          status       : { code: 200, detail: 'OK' },
          subscription : { close: sinon.stub().resolves() },
          fingerprint  : 'feed-fingerprint',
          head,
        },
        message: { descriptor: {} },
      };
    }

    return { message: { descriptor: {} } };
  });
  const rpcStub = sinon.stub().callsFake(async (request: { subscription?: { handler?: CapturedSubscriptionHandler } }) => {
    remoteHandler = request.subscription?.handler;
    return {
      status       : { code: 200, detail: 'OK' },
      subscription : { close: sinon.stub().resolves() },
      fingerprint  : 'feed-fingerprint',
      head,
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
    push               : {},
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
    Object.assign(engine, {
      _replicationLinkStore: {
        getOrCreateLink    : sinon.stub().resolves(link),
        persistCheckpoint  : persistCheckpointStub,
        persistCheckpoints : sinon.stub().resolves(),
        setStatus          : setStatusStub,
      },
    });

    await engine.startSync({ interval: '30s' });

    const handler = getRemoteHandler();
    expect(handler).toBeDefined();
    const [controller] = engine['_linkControllers'].values();
    expect(controller).toBeDefined();
    if (controller === undefined) {
      throw new Error('expected an active replication session');
    }
    const request = sinon.spy(controller.executor, 'request');

    await engine.stopSync();

    expect(engine['_linkControllers'].size).toBe(0);

    await handler!({
      type  : 'event',
      event : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
    });

    expect(request.notCalled).toBe(true);
    expect(engine.connectivityState).not.toBe('online');
  });

  it('should release a pull wake handler before its supervised pass settles and wait on stopSync()', async () => {
    const { agent, getRemoteHandler } = createLiveMockAgent();
    const engine = new SyncEngineLevel({ db, agent });
    const link = makeLink();

    sinon.stub(engine, 'sync').resolves();
    sinon.stub(engine as never, 'getSyncTargets').resolves([target]);
    Object.assign(engine, {
      _replicationLinkStore: {
        getOrCreateLink    : sinon.stub().resolves(link),
        persistCheckpoint  : sinon.stub().resolves(),
        persistCheckpoints : sinon.stub().resolves(),
        setStatus          : sinon.stub().callsFake(async (linkState: Record<string, unknown>, status: string): Promise<void> => {
          linkState.status = status;
        }),
      },
    });

    await engine.startSync({ interval: '30s' });

    const passStarted = createDeferred();
    const releasePass = createDeferred();
    sinon.stub(engine['_linkRecoveryCoordinator'], 'resume').callsFake(async (): Promise<void> => {
      passStarted.resolve();
      await releasePass.promise;
    });

    const handler = getRemoteHandler();
    expect(handler).toBeDefined();
    const handlerPromise = handler!({
      type  : 'event',
      event : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
    });
    await passStarted.promise;

    // Transport acknowledgement is chained to the handler promise, so the
    // handler must settle without joining the potentially multi-page pass.
    await handlerPromise;

    let stopCompleted = false;
    const stopPromise = engine.stopSync().then((): void => { stopCompleted = true; });
    await Promise.resolve();

    expect(stopCompleted).toBe(false);
    expect(db.status).toBe('open');

    releasePass.resolve();
    await stopPromise;

    expect(stopCompleted).toBe(true);
  });

  it('should not enqueue push work when a late local callback fires after stopSync()', async () => {
    const { agent, getLocalHandler } = createLiveMockAgent();
    const engine = new SyncEngineLevel({ db, agent });

    const link = makeLink();

    sinon.stub(engine, 'sync').resolves();
    sinon.stub(engine as never, 'getSyncTargets').resolves([target]);
    sinon.stub(engine as never, 'openLivePullSubscription').callsFake(async (
      _target: unknown,
      controller: SyncLinkController,
      expectedReplicationGeneration: number,
    ): Promise<boolean> => controller.setLiveSubscription(
      { close: sinon.stub().resolves() },
      expectedReplicationGeneration,
      {
        fingerprint : 'feed-fingerprint',
        head        : { streamId: 's1', epoch: 'e1', position: '0', messageCid: 'cid-0' },
      },
    ));
    Object.assign(engine, {
      _replicationLinkStore: {
        getOrCreateLink    : sinon.stub().resolves(link),
        persistCheckpoint  : sinon.stub().resolves(),
        persistCheckpoints : sinon.stub().resolves(),
        setStatus          : sinon.stub().callsFake(async (linkState: Record<string, unknown>, status: string): Promise<void> => {
          linkState.status = status;
        }),
      },
    });

    await engine.startSync({ interval: '30s' });

    const handler = getLocalHandler();
    const [controller] = engine['_linkControllers'].values();
    expect(handler).toBeDefined();
    expect(controller).toBeDefined();
    if (controller === undefined) {
      throw new Error('Expected live sync to activate a link controller');
    }

    const request = sinon.spy(controller.executor, 'request');

    await engine.stopSync();

    await handler!({
      type   : 'event',
      cursor : { streamId: 's1', epoch: 'e1', position: '1', messageCid: 'cid-1' },
      event  : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
    });

    expect(request.called).toBe(false);
    expect(controller.executor.hasPending('push')).toBe(false);
  });

  it('should close a remote subscription that resolves after its link lifetime ends', async () => {
    const requestStarted = createDeferred();
    const releaseRequest = createDeferred();
    const close = sinon.stub().resolves();
    const agent = {
      agentDid : 'did:example:agent',
      dwn      : {
        processRequest: sinon.stub().resolves({ message: { descriptor: {} } }),
      },
      rpc: {
        sendDwnRequest: sinon.stub().callsFake(async () => {
          requestStarted.resolve();
          await releaseRequest.promise;
          return {
            status       : { code: 200, detail: 'OK' },
            subscription : { close },
          };
        }),
      },
    };
    const engine = new SyncEngineLevel({ db, agent: agent as never });
    const linkKey = 'did:example:alice^https://dwn.example.com^projection-1^authorization-1';
    const controller = engine['activateLink'](linkKey, makeLink() as never);

    const opening = (engine as unknown as {
      openLivePullSubscription(
        linkTarget: typeof target & { linkKey: string },
        linkController: typeof controller,
      ): Promise<boolean>;
    }).openLivePullSubscription({ ...target, linkKey }, controller);
    await requestStarted.promise;
    const replacement = engine['activateLink'](linkKey, makeLink({ connectivity: 'online' }) as never);
    releaseRequest.resolve();

    expect(await opening).toBe(false);
    expect(close.calledOnce).toBe(true);
    expect(controller.isActive).toBe(false);
    expect(controller.hasLiveSubscription).toBe(false);
    expect(replacement.hasLiveSubscription).toBe(false);
  });

  it('should close a local subscription that resolves after its link lifetime ends', async () => {
    const requestStarted = createDeferred();
    const releaseRequest = createDeferred();
    const close = sinon.stub().resolves();
    const agent = {
      agentDid : 'did:example:agent',
      dwn      : {
        processRequest: sinon.stub().callsFake(async () => {
          requestStarted.resolve();
          await releaseRequest.promise;
          return {
            reply   : { status: { code: 200, detail: 'OK' }, subscription: { close } },
            message : { descriptor: {} },
          };
        }),
      },
    };
    const engine = new SyncEngineLevel({ db, agent: agent as never });
    const linkKey = 'did:example:alice^https://dwn.example.com^projection-1^authorization-1';
    const controller = engine['activateLink'](linkKey, makeLink() as never);

    const opening = (engine as unknown as {
      openLocalPushSubscription(
        linkTarget: typeof target & { linkKey: string },
        linkController: typeof controller,
      ): Promise<boolean>;
    }).openLocalPushSubscription({ ...target, linkKey }, controller);
    await requestStarted.promise;
    controller.deactivate();
    releaseRequest.resolve();

    expect(await opening).toBe(false);
    expect(close.calledOnce).toBe(true);
    expect(controller.hasLocalSubscription).toBe(false);
  });

  it('should close subscriptions owned by a replaced link controller', async () => {
    const engine = new SyncEngineLevel({ db });
    const linkKey = 'did:example:alice^https://dwn.example.com^projection-1^authorization-1';
    const original = engine['activateLink'](linkKey, makeLink() as never);
    const closeLive = sinon.stub().resolves();
    const closeLocal = sinon.stub().resolves();
    original.setLiveSubscription({ close: closeLive });
    original.setLocalSubscription({ close: closeLocal });

    const replacement = engine['activateLink'](linkKey, makeLink({ connectivity: 'online' }) as never);
    await Promise.resolve();

    expect(original.isActive).toBe(false);
    expect(closeLive.calledOnce).toBe(true);
    expect(closeLocal.calledOnce).toBe(true);
    expect(replacement.isActive).toBe(true);
  });

  it('should not let a stale initialization failure remove its replacement', async () => {
    const engine = new SyncEngineLevel({ db });
    const linkKey = 'did:example:alice^https://dwn.example.com^projection-1^authorization-1';
    const link = makeLink();
    const original = engine['activateLink'](linkKey, link as never);
    const replacement = engine['activateLink'](linkKey, makeLink({ connectivity: 'online' }) as never);

    const result = await (engine as unknown as {
      handleInitializeLinkTargetError(
        syncTarget: typeof target,
        linkState: typeof link,
        linkController: typeof original,
        error: Error,
      ): Promise<{ status: string }>;
    }).handleInitializeLinkTargetError(target, link, original, new Error('stale initialization failed'));

    expect(result.status).toBe('failed');
    expect(engine['_linkControllers'].get(linkKey)).toBe(replacement);
    expect(replacement.isActive).toBe(true);
  });

  it('should cancel a pending initialization retry when a link becomes active', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com^projection-1^authorization-1';
      const initialize = sinon.stub(engine as never, 'initializeLinkTarget').resolves({ status: 'active' });

      (engine as unknown as {
        scheduleLinkInitRetry(syncTarget: typeof target, key: string, delayMs: number): void;
      }).scheduleLinkInitRetry(target, linkKey, 1_000);
      expect(engine['_runtime'].hasTimers((key) => key === `linkInitRetry:${linkKey}`)).toBe(true);

      engine['activateLink'](linkKey, makeLink({ status: 'live' }) as never);
      await clock.tickAsync(1_000);

      expect(engine['_runtime'].hasTimers((key) => key === `linkInitRetry:${linkKey}`)).toBe(false);
      expect(initialize.called).toBe(false);
    } finally {
      clock.restore();
    }
  });

});
