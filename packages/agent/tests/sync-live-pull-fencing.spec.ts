import type { SinonStub } from 'sinon';

import type { ProgressToken } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { Level } from 'level';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { SyncLinkController } from '../src/sync-link-controller.js';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

const DID = 'did:example:alice';
const REMOTE = 'https://dwn.example.com';
const LINK_KEY = `${DID}^${REMOTE}^projection-id^owner-epoch`;

type EngineFixture = {
  controller: SyncLinkController;
  engine: SyncEngineLevel;
  handlers: Array<(message: unknown) => Promise<void>>;
  processRequest: SinonStub;
  repairing: SinonStub;
  sendDwnRequest: SinonStub;
  target: Record<string, unknown>;
};

function tokenIn(streamId: string, epoch: string, position: string): ProgressToken {
  return { epoch, messageCid: `cid-${position}`, position, streamId };
}

function createEngineFixture(db: Level<string, string>): EngineFixture {
  const engine = new SyncEngineLevel({ db });
  const controller: SyncLinkController = (engine as any).activateLink(LINK_KEY, {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    connectivity       : 'online',
    projectionId       : 'projection-id',
    pull               : {},
    push               : {},
    remoteEndpoint     : REMOTE,
    scope              : { kind: 'full' },
    status             : 'live',
    tenantDid          : DID,
  });
  const handlers: Array<(message: unknown) => Promise<void>> = [];
  const processRequest = sinon.stub().resolves({ message: {} });
  const sendDwnRequest = sinon.stub().callsFake(async (request: any) => {
    handlers.push(request.subscription.handler);
    return { status: { code: 200 }, subscription: { close: sinon.stub().resolves() } };
  });
  (engine as any)._agent = { dwn: { processRequest }, rpc: { sendDwnRequest } };
  sinon.stub((engine as any).ledger, 'persistCheckpoint').resolves();
  const repairing = sinon.stub((engine as any)._linkRecoveryCoordinator, 'transitionToRepairing').resolves();
  const target = {
    authorization      : { kind: 'owner' as const },
    authorizationEpoch : 'owner-epoch',
    did                : DID,
    dwnUrl             : REMOTE,
    linkKey            : LINK_KEY,
    projectionId       : 'projection-id',
    scope              : { kind: 'full' as const },
  };
  return { controller, engine, handlers, processRequest, repairing, sendDwnRequest, target };
}

function openSubscription(fixture: EngineFixture): Promise<boolean> {
  return (fixture.engine as any).openLivePullSubscription(fixture.target, fixture.controller);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('SyncEngineLevel — live-pull generation fencing', () => {
  let db: Level<string, string>;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-live-pull-fencing-spec');
  });

  afterEach(async () => {
    await db.clear();
    sinon.restore();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should fence subscription callbacks issued before a pull-runtime reset', async () => {
    const fixture = createEngineFixture(db);
    const { controller } = fixture;

    expect(await openSubscription(fixture)).toBe(true);
    const staleHandler = fixture.handlers[0];

    // A repair resets the pull runtime, re-establishes the boundary on a new
    // stream domain, and reopens the subscription.
    controller.resetPullRuntime();
    controller.link.pull.contiguousAppliedToken = tokenIn('stream-2', 'epoch-2', '1');
    await controller.closeLiveSubscription();
    expect(await openSubscription(fixture)).toBe(true);
    const freshHandler = fixture.handlers[1];

    // An EOSE from the superseded subscription carries a cursor from the old
    // stream domain: it must be discarded, not treated as a domain mismatch
    // that sends the freshly repaired link straight back into repair.
    await staleHandler({ type: 'eose', cursor: tokenIn('stream-1', 'epoch-1', '9') });
    expect(fixture.repairing.notCalled).toBe(true);
    expect(controller.link.pull.receivedToken).toBeUndefined();

    // The replacement subscription's callbacks flow normally.
    await freshHandler({ type: 'eose', cursor: tokenIn('stream-2', 'epoch-2', '2') });
    expect(controller.link.pull.receivedToken).toEqual(tokenIn('stream-2', 'epoch-2', '2'));

    await controller.shutdown();
  });

  it('should not install a subscription whose pull generation reset while the request was in flight', async () => {
    const fixture = createEngineFixture(db);
    const requestStarted = deferred();
    const releaseRequest = deferred();
    const close = sinon.stub().resolves();
    fixture.sendDwnRequest.callsFake(async (request: any) => {
      fixture.handlers.push(request.subscription.handler);
      requestStarted.resolve();
      await releaseRequest.promise;
      return { status: { code: 200 }, subscription: { close } };
    });

    const opening = openSubscription(fixture);
    await requestStarted.promise;
    // A repair or pause resets the pull runtime while the subscribe RPC is
    // pending: the eventual subscription belongs to a superseded generation
    // and must be closed, not installed as a permanently fenced slot that
    // blocks the replacement.
    fixture.controller.resetPullRuntime();
    releaseRequest.resolve();

    expect(await opening).toBe(false);
    expect(close.calledOnce).toBe(true);
    expect(fixture.controller.hasLiveSubscription).toBe(false);

    await fixture.controller.shutdown();
  });

  it('should abandon an open whose pull generation resets during cursor resolution', async () => {
    const fixture = createEngineFixture(db);
    const cursorStarted = deferred();
    const releaseCursor = deferred();
    sinon.stub(fixture.engine as any, 'getInitialPullCursor').callsFake(async () => {
      cursorStarted.resolve();
      await releaseCursor.promise;
      return undefined;
    });

    const opening = openSubscription(fixture);
    await cursorStarted.promise;
    fixture.controller.resetPullRuntime();
    releaseCursor.resolve();

    expect(await opening).toBe(false);
    expect(fixture.processRequest.notCalled).toBe(true);
    expect(fixture.sendDwnRequest.notCalled).toBe(true);

    await fixture.controller.shutdown();
  });

  it('should leave a link paused when the pause lands while the local subscription is opening', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    controller.link.status = 'initializing';
    const subscribeStarted = deferred();
    const releaseSubscribe = deferred();
    const close = sinon.stub().resolves();
    fixture.processRequest.callsFake(async () => {
      subscribeStarted.resolve();
      await releaseSubscribe.promise;
      return { reply: { status: { code: 200 }, subscription: { close } } };
    });

    const opening = (engine as any).openLocalPushSubscription(fixture.target, controller);
    await subscribeStarted.promise;
    // A terminal authorization failure pauses the link while the local
    // subscribe is pending — the fail-safe must win over the installer.
    await (engine as any)._linkRecoveryCoordinator.transitionToPaused(LINK_KEY, controller.link);
    releaseSubscribe.resolve();

    expect(await opening).toBe(false);
    expect(close.calledOnce).toBe(true);
    expect(controller.hasLocalSubscription).toBe(false);
    expect(controller.link.status).toBe('paused');

    // Completing initialization afterwards must not override the pause.
    await (engine as any).markLinkLive(fixture.target, controller);
    expect(controller.link.status).toBe('paused');

    await controller.shutdown();
  });

  it('should swallow a superseded attempt failure but propagate a current-generation failure', async () => {
    const fixture = createEngineFixture(db);
    const requestStarted = deferred();
    const releaseRequest = deferred();
    fixture.sendDwnRequest.callsFake(async () => {
      requestStarted.resolve();
      await releaseRequest.promise;
      throw new Error('transport failed');
    });

    const opening = openSubscription(fixture);
    await requestStarted.promise;
    fixture.controller.resetPullRuntime();
    releaseRequest.resolve();
    // The superseded attempt's rejection is its own teardown, not this
    // link's failure.
    expect(await opening).toBe(false);

    // The same failure in the current generation still surfaces.
    fixture.sendDwnRequest.rejects(new Error('transport failed'));
    await expect(openSubscription(fixture)).rejects.toThrow('transport failed');

    await fixture.controller.shutdown();
  });

  it('should not let a superseded attempt close the replacement subscription pair', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    const replacementClose = sinon.stub().resolves();
    sinon.stub(engine as any, 'openLivePullSubscription').callsFake(async (): Promise<boolean> => {
      // A repair supersedes the attempt and its replacement generation
      // attaches a fresh pair before the old attempt resumes.
      controller.resetPullRuntime();
      controller.setLiveSubscription({ close: replacementClose });
      controller.setLocalSubscription({ close: replacementClose });
      return false;
    });

    const result = await (engine as any).openLinkSubscriptions(fixture.target, controller);

    expect(result).toBe('inactive');
    expect(replacementClose.notCalled).toBe(true);
    expect(controller.hasLiveSubscription).toBe(true);
    expect(controller.hasLocalSubscription).toBe(true);

    await controller.shutdown();
  });

  it('should stop the pair when a pause lands between the pull and local halves', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    controller.link.status = 'initializing';
    const openGeneration = controller.pullEpoch;
    sinon.stub(engine as any, 'openLivePullSubscription').callsFake(async (): Promise<boolean> => {
      // A terminal callback queued at attachment pauses the link before the
      // caller resumes — the pause bumps the generation and tears down.
      await (engine as any)._linkRecoveryCoordinator.transitionToPaused(LINK_KEY, controller.link);
      return true;
    });
    const localOpen = sinon.spy(engine as any, 'openLocalPushSubscription');

    const result = await (engine as any).openLinkSubscriptions(fixture.target, controller, openGeneration);

    expect(result).toBe('inactive');
    expect(localOpen.notCalled).toBe(true);
    expect(controller.hasLocalSubscription).toBe(false);
    expect(controller.link.status).toBe('paused');

    await controller.shutdown();
  });

  it('should fence local subscription callbacks issued before a generation reset', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    const handleEvent = sinon.stub((engine as any)._livePushCoordinator, 'handleEvent').resolves();
    const localHandlers: Array<(message: unknown) => Promise<void>> = [];
    const close = sinon.stub().resolves();
    fixture.processRequest.callsFake(async (request: any) => {
      localHandlers.push(request.subscriptionHandler);
      return { reply: { status: { code: 200 }, subscription: { close } } };
    });

    expect(await (engine as any).openLocalPushSubscription(fixture.target, controller)).toBe(true);
    // A repair resets the generation and reopens the local subscription.
    controller.resetPullRuntime();
    await controller.closeLocalSubscription();
    expect(await (engine as any).openLocalPushSubscription(fixture.target, controller)).toBe(true);

    const message = { type: 'event' };
    await localHandlers[0](message);
    await localHandlers[1](message);

    // The superseded subscription's callback reports itself stale; the
    // replacement generation's callback flows.
    const staleForOld = handleEvent.firstCall.args[2] as () => boolean;
    const staleForNew = handleEvent.secondCall.args[2] as () => boolean;
    expect(staleForOld()).toBe(true);
    expect(staleForNew()).toBe(false);

    await controller.shutdown();
  });

  it('should keep a link paused during opening in the identity keep-set instead of failing it', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    controller.link.status = 'initializing';
    sinon.stub(engine as any, 'getOrCreateReplicationLink').resolves(controller.link);
    sinon.stub(engine as any, 'activateLink').returns(controller);
    sinon.stub(engine as any, 'openLinkSubscriptions').callsFake(async (): Promise<string> => {
      // A terminal callback pauses the link while the pair is opening.
      await (engine as any)._linkRecoveryCoordinator.transitionToPaused(LINK_KEY, controller.link);
      return 'inactive';
    });

    const result = await (engine as any).initializeLinkTarget({
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      did                : DID,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
    });

    // Failing the initialization would drop the paused link from the
    // identity's keep-set, and the superseded-link prune would then delete
    // the fail-safe pause's durable record.
    expect(result.status).toBe('active');
    expect(controller.link.status).toBe('paused');

    await controller.shutdown();
  });

  it('should discard a stale ProgressGap reply instead of repairing the superseded generation', async () => {
    const fixture = createEngineFixture(db);
    const requestStarted = deferred();
    const releaseRequest = deferred();
    fixture.sendDwnRequest.callsFake(async (request: any) => {
      fixture.handlers.push(request.subscription.handler);
      requestStarted.resolve();
      await releaseRequest.promise;
      return { error: { latestAvailable: tokenIn('stream-1', 'epoch-1', '9') }, status: { code: 410, detail: 'gap' } };
    });

    const opening = openSubscription(fixture);
    await requestStarted.promise;
    fixture.controller.resetPullRuntime();
    releaseRequest.resolve();

    // The 410 belongs to the superseded generation's cursor: resolving false
    // (instead of throwing the ProgressGap) keeps callers from starting
    // another repair for a generation that no longer exists.
    expect(await opening).toBe(false);
    expect(fixture.repairing.notCalled).toBe(true);

    await fixture.controller.shutdown();
  });
});
