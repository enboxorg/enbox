import type { SinonStub } from 'sinon';

import type { ProgressToken } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { Level } from 'level';
import { Message } from '@enbox/dwn-sdk-js';
import { SubscriptionHandlerTerminalError } from '@enbox/dwn-clients';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { SyncLinkController } from '../src/sync-link-controller.js';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

import { deferred } from './utils/deferred.js';

const DID = 'did:example:alice';
const REMOTE = 'https://dwn.example.com';
const LINK_KEY = `${DID}^${REMOTE}^projection-id^owner-epoch`;

type EngineFixture = {
  controller: SyncLinkController;
  engine: SyncEngineLevel;
  handlers: Array<(message: unknown) => Promise<void>>;
  processRequest: SinonStub;
  resume: SinonStub;
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
  const resume = sinon.stub((engine as any)._linkRecoveryCoordinator, 'resume').resolves();
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
  return { controller, engine, handlers, processRequest, repairing, resume, sendDwnRequest, target };
}

function openSubscription(fixture: EngineFixture): Promise<boolean> {
  return (fixture.engine as any).openLivePullSubscription(fixture.target, fixture.controller);
}

describe('SyncEngineLevel — replication generation fencing', () => {
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

  it('should fence subscription callbacks issued before a replication-generation reset', async () => {
    const fixture = createEngineFixture(db);
    const { controller } = fixture;

    expect(await openSubscription(fixture)).toBe(true);
    const staleHandler = fixture.handlers[0];

    // A repair resets the replication generation and reopens the subscription.
    controller.resetReplicationGeneration();
    await controller.closeLiveSubscription();
    expect(await openSubscription(fixture)).toBe(true);
    controller.markReplicationReady();
    const freshHandler = fixture.handlers[1];
    const cursor = tokenIn('durable-stream', 'durable-epoch', '1');
    fixture.resume.callsFake(async (): Promise<void> => {
      controller.executor.consumePending('pull');
      controller.link.pull.contiguousAppliedToken = cursor;
      (fixture.engine as any).markPullCurrent(controller, controller.replicationGeneration);
    });
    const event = {
      type  : 'event',
      cursor,
      event : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
    };

    await staleHandler(event);
    expect(fixture.repairing.notCalled).toBe(true);
    expect(fixture.resume.notCalled).toBe(true);

    // The replacement subscription's callbacks flow normally.
    await freshHandler(event);
    expect(fixture.resume.calledOnceWithExactly(controller)).toBe(true);
    expect(controller.link.pull.contiguousAppliedToken).toEqual(cursor);

    await controller.dispose();
  });

  it('should not install a subscription whose replication generation reset while the request was in flight', async () => {
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
    // A repair or pause resets the replication generation while the subscribe RPC is
    // pending: the eventual subscription belongs to a superseded replication generation
    // and must be closed, not installed as a permanently fenced slot that
    // blocks the replacement.
    fixture.controller.resetReplicationGeneration();
    releaseRequest.resolve();

    expect(await opening).toBe(false);
    expect(close.calledOnce).toBe(true);
    expect(fixture.controller.hasLiveSubscription).toBe(false);

    await fixture.controller.dispose();
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
    await (engine as any).markLinkLive(fixture.target, controller, controller.replicationGeneration);
    expect(controller.link.status).toBe('paused');

    await controller.dispose();
  });

  it('should not release replacement reconciliation when a pause lands during live-status persistence', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    controller.link.status = 'initializing';
    const livePersistenceStarted = deferred();
    const releaseLivePersistence = deferred();
    sinon.stub((engine as any).replicationLinkStore, 'setStatus').callsFake(async (link: any, status: string): Promise<void> => {
      link.status = status;
      if (status === 'live') {
        livePersistenceStarted.resolve();
        await releaseLivePersistence.promise;
      }
    });

    const openingGeneration = controller.replicationGeneration;
    const markingLive = (engine as any).markLinkLive(fixture.target, controller, openingGeneration);
    await livePersistenceStarted.promise;

    await (engine as any)._linkRecoveryCoordinator.transitionToPaused(LINK_KEY, controller.link);
    controller.executor.request('pull');
    releaseLivePersistence.resolve();
    await markingLive;

    expect(controller.link.status).toBe('paused');
    expect(controller.executor.hasPending('pull')).toBe(true);

    await controller.dispose();
    expect(controller.executor.hasPending('pull')).toBe(false);
  });

  it('should swallow a superseded attempt failure but propagate a current-replication-generation failure', async () => {
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
    fixture.controller.resetReplicationGeneration();
    releaseRequest.resolve();
    // The superseded attempt's rejection retires that attempt; it is not this
    // link's failure.
    expect(await opening).toBe(false);

    // The same failure in the current replication generation still surfaces.
    fixture.sendDwnRequest.rejects(new Error('transport failed'));
    await expect(openSubscription(fixture)).rejects.toThrow('transport failed');

    await fixture.controller.dispose();
  });

  it('should not let a superseded attempt close the replacement subscription pair', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    const replacementClose = sinon.stub().resolves();
    sinon.stub(engine as any, 'openLivePullSubscription').callsFake(async (): Promise<boolean> => {
      // A repair supersedes the attempt and its replacement replication generation
      // attaches a fresh pair before the old attempt resumes.
      controller.resetReplicationGeneration();
      controller.setLiveSubscription({ close: replacementClose });
      controller.setLocalSubscription({ close: replacementClose });
      return false;
    });

    const result = await (engine as any).openLinkSubscriptions(fixture.target, controller, controller.replicationGeneration);

    expect(result).toBe('inactive');
    expect(replacementClose.notCalled).toBe(true);
    expect(controller.hasLiveSubscription).toBe(true);
    expect(controller.hasLocalSubscription).toBe(true);

    await controller.dispose();
  });

  it('should open only the remote half for a role link', async () => {
    const fixture = createEngineFixture(db);
    const roleAuthorization = {
      kind         : 'role' as const,
      actorDid     : 'did:example:member',
      protocolRole : 'notebook/viewer',
      roleRecordId : 'role-a',
    };
    fixture.controller.link.authorization = roleAuthorization;
    fixture.target.authorization = roleAuthorization;
    const pullOpen = sinon.stub(fixture.engine as any, 'openLivePullSubscription').resolves(true);
    const localOpen = sinon.spy(fixture.engine as any, 'openLocalPushSubscription');

    const result = await (fixture.engine as any).openLinkSubscriptions(
      fixture.target,
      fixture.controller,
      fixture.controller.replicationGeneration,
    );

    expect(result).toBe('readyForLive');
    expect(pullOpen.calledOnce).toBe(true);
    expect(localOpen.notCalled).toBe(true);
    await fixture.controller.dispose();
  });

  it('should stop the pair when a pause lands between the pull and local halves', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    controller.link.status = 'initializing';
    const openReplicationGeneration = controller.replicationGeneration;
    sinon.stub(engine as any, 'openLivePullSubscription').callsFake(async (): Promise<boolean> => {
      // A terminal callback queued at attachment pauses the link before the
      // caller resumes — the pause bumps the replication generation and closes the pair.
      await (engine as any)._linkRecoveryCoordinator.transitionToPaused(LINK_KEY, controller.link);
      return true;
    });
    const localOpen = sinon.spy(engine as any, 'openLocalPushSubscription');

    const result = await (engine as any).openLinkSubscriptions(fixture.target, controller, openReplicationGeneration);

    expect(result).toBe('inactive');
    expect(localOpen.notCalled).toBe(true);
    expect(controller.hasLocalSubscription).toBe(false);
    expect(controller.link.status).toBe('paused');

    await controller.dispose();
  });

  it('should fence local subscription callbacks issued before a replication-generation reset', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    const localHandlers: Array<(message: unknown) => Promise<void>> = [];
    const close = sinon.stub().resolves();
    fixture.processRequest.callsFake(async (request: any) => {
      localHandlers.push(request.subscriptionHandler);
      return { reply: { status: { code: 200 }, subscription: { close } } };
    });

    expect(await (engine as any).openLocalPushSubscription(fixture.target, controller)).toBe(true);
    // A repair resets the replication generation and reopens the local subscription.
    controller.resetReplicationGeneration();
    await controller.closeLocalSubscription();
    expect(await (engine as any).openLocalPushSubscription(fixture.target, controller)).toBe(true);
    controller.markReplicationReady();

    const message = { type: 'event' };
    await localHandlers[0](message);
    await localHandlers[1](message);

    // The superseded callback cannot wake durable reconciliation. The replacement
    // replication generation contributes one coalesced push request.
    expect(fixture.resume.calledOnceWithExactly(controller)).toBe(true);
    expect(controller.executor.hasPending('push')).toBe(true);

    await controller.dispose();
  });

  it('should refuse a local install that resolves while pause awaits a subscription close', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    controller.link.status = 'initializing';
    const releaseLiveClose = deferred();
    controller.setLiveSubscription({ close: sinon.stub().callsFake(() => releaseLiveClose.promise) });
    const subscribeStarted = deferred();
    const releaseSubscribe = deferred();
    const localClose = sinon.stub().resolves();
    fixture.processRequest.callsFake(async () => {
      subscribeStarted.resolve();
      await releaseSubscribe.promise;
      return { reply: { status: { code: 200 }, subscription: { close: localClose } } };
    });

    const opening = (engine as any).openLocalPushSubscription(fixture.target, controller);
    await subscribeStarted.promise;
    const pausing = (engine as any)._linkRecoveryCoordinator.transitionToPaused(LINK_KEY, controller.link);
    // The pause is blocked awaiting the pull subscription's close when the
    // pending local subscribe resolves: the attach must be refused by the
    // pause's already-published replication generation, not slip into the slot
    // the close operation has already inspected.
    releaseSubscribe.resolve();
    expect(await opening).toBe(false);
    expect(localClose.calledOnce).toBe(true);

    releaseLiveClose.resolve();
    await pausing;
    expect(controller.hasLocalSubscription).toBe(false);
    expect(controller.link.status).toBe('paused');

    await controller.dispose();
  });

  it('should keep a link paused during opening in the identity keep-set instead of failing it', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    controller.link.status = 'initializing';
    sinon.stub(engine as any, 'getOrCreateReplicationLink').resolves(controller.link);
    sinon.stub(engine as any, 'activateLink').returns(controller);
    // This test emulates the ORIGINAL initializing call, whose own
    // activateLink registers the controller; the fixture's pre-registration
    // would instead trip the owned-link idempotence guard and skip opening.
    (engine as any)._linkControllers.delete(LINK_KEY);
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

    await controller.dispose();
  });

  it('should establish and re-establish the wake subscription without a replay cursor', async () => {
    const fixture = createEngineFixture(db);
    fixture.controller.link.pull.contiguousAppliedToken = tokenIn('durable-stream', 'durable-epoch', '9');

    expect(await openSubscription(fixture)).toBe(true);

    expect(fixture.processRequest.firstCall.args[0].messageParams.cursor).toBeUndefined();
    const factory = fixture.sendDwnRequest.firstCall.args[0].subscription.resubscribeFactory;
    await factory(tokenIn('transport-stream', 'transport-epoch', '99'));
    expect(fixture.processRequest.secondCall.args[0].messageParams.cursor).toBeUndefined();
    expect(fixture.controller.link.pull.contiguousAppliedToken).toEqual(
      tokenIn('durable-stream', 'durable-epoch', '9'),
    );

    await fixture.controller.dispose();
  });

  it('should admit a current socket event and persist its cursor before completing the handler', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    expect(await openSubscription(fixture)).toBe(true);
    controller.markReplicationReady();
    controller.markPullCurrent(controller.replicationGeneration);

    const message = {
      descriptor: {
        interface        : 'Protocols',
        method           : 'Configure',
        messageTimestamp : '2026-08-12T00:00:00.000000Z',
      },
    };
    const messageCid = await Message.getCid(message as any);
    const cursor: ProgressToken = {
      epoch    : 'event-epoch',
      messageCid,
      position : '10',
      streamId : 'event-stream',
    };
    const admitRemoteFeedPage = sinon.stub(engine as any, 'admitRemoteFeedPage').resolves({
      admittedCids : [messageCid],
      kind         : 'processed',
    });
    const persistStarted = deferred();
    const releasePersist = deferred();
    const persistCheckpoint = sinon.stub().callsFake(async (): Promise<void> => {
      persistStarted.resolve();
      await releasePersist.promise;
    });
    (engine as any)._replicationLinkStore = { persistCheckpoint };

    const event = {
      type              : 'event',
      cursor,
      encodedData       : 'AQ',
      event             : { message },
      isLatestBaseState : true,
      messageCid,
      seq               : '10',
    };
    let settled = false;
    const handled = fixture.handlers[0](event).then((): void => { settled = true; });
    await persistStarted.promise;

    expect(settled).toBe(false);
    expect(controller.isPullCurrent).toBe(false);
    expect(admitRemoteFeedPage.calledOnce).toBe(true);
    expect(admitRemoteFeedPage.firstCall.args[1]).toEqual([{
      encodedData       : 'AQ',
      isLatestBaseState : true,
      message,
      messageCid,
      seq               : '10',
    }]);
    expect(fixture.resume.notCalled).toBe(true);

    releasePersist.resolve();
    await handled;

    expect(settled).toBe(true);
    expect(controller.isPullCurrent).toBe(true);
    expect(controller.link.pull.contiguousAppliedToken).toEqual(cursor);
    expect(persistCheckpoint.calledOnceWithExactly(controller.link, 'pull')).toBe(true);

    admitRemoteFeedPage.resetHistory();
    persistCheckpoint.resetHistory();
    const transitions: boolean[] = [];
    const unsubscribe = engine.on((syncEvent): void => {
      if (syncEvent.type === 'pull:currentness-change') {
        transitions.push(syncEvent.to);
      }
    });
    await fixture.handlers[0](event);

    expect(admitRemoteFeedPage.notCalled).toBe(true);
    expect(persistCheckpoint.notCalled).toBe(true);
    expect(fixture.resume.notCalled).toBe(true);
    expect(fixture.repairing.notCalled).toBe(true);
    expect(controller.isPullCurrent).toBe(true);
    expect(transitions).toEqual([]);
    unsubscribe();
    await controller.dispose();
  });

  it('should end a live subscription when an event is deferred', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    fixture.repairing.callsFake(async (activeController: SyncLinkController): Promise<void> => {
      activeController.resetReplicationGeneration();
    });
    expect(await openSubscription(fixture)).toBe(true);
    controller.markReplicationReady();
    controller.markPullCurrent(controller.replicationGeneration);

    const message = {
      descriptor: {
        interface        : 'Protocols',
        method           : 'Configure',
        messageTimestamp : '2026-08-12T00:00:00.000000Z',
      },
    };
    const messageCid = await Message.getCid(message as any);
    const cursor: ProgressToken = {
      epoch    : 'event-epoch',
      messageCid,
      position : '10',
      streamId : 'event-stream',
    };
    sinon.stub(engine as any, 'admitRemoteFeedPage').resolves({
      admittedCids : [],
      detail       : 'waiting for replication support',
      kind         : 'deferred',
      messageCid,
    });
    const persistCheckpoint = sinon.stub().resolves();
    (engine as any)._replicationLinkStore = { persistCheckpoint };
    const warn = sinon.stub(console, 'warn');

    const handledError = await fixture.handlers[0]({
      type              : 'event',
      cursor,
      event             : { message },
      isLatestBaseState : true,
      messageCid,
    }).then(
      (): undefined => undefined,
      (error: unknown): unknown => error,
    );

    expect(handledError).toBeInstanceOf(SubscriptionHandlerTerminalError);
    expect((handledError as Error).message).toContain('waiting for replication support');
    expect(warn.calledOnce).toBe(true);
    expect(warn.firstCall.args[0]).toContain('live pull delivery');
    expect(warn.firstCall.args[0]).toContain('deferred');
    expect(persistCheckpoint.notCalled).toBe(true);
    expect(controller.link.pull.contiguousAppliedToken).toBeUndefined();
    expect(fixture.repairing.calledOnceWithExactly(controller)).toBe(true);
    expect(controller.isPullCurrent).toBe(false);
    await controller.dispose();
  });

  it('should end a live subscription when durable fallback stops before its event', async () => {
    const fixture = createEngineFixture(db);
    const { controller } = fixture;
    expect(await openSubscription(fixture)).toBe(true);
    controller.markReplicationReady();
    controller.link.pull.contiguousAppliedToken = tokenIn('event-stream', 'event-epoch', '9');
    fixture.resume.callsFake(async (): Promise<void> => {
      controller.executor.consumePending('pull');
    });

    const cursor = tokenIn('event-stream', 'event-epoch', '10');
    const handledError = await fixture.handlers[0]({
      type              : 'event',
      cursor,
      event             : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
      isLatestBaseState : true,
    }).then(
      (): undefined => undefined,
      (error: unknown): unknown => error,
    );

    expect(handledError).toBeInstanceOf(SubscriptionHandlerTerminalError);
    expect((handledError as Error).message).toContain('durable pull did not settle socket event');
    expect(controller.link.pull.contiguousAppliedToken).toEqual(tokenIn('event-stream', 'event-epoch', '9'));
    expect(fixture.resume.calledOnceWithExactly(controller)).toBe(true);
    expect(fixture.repairing.calledOnceWithExactly(controller)).toBe(true);
    await controller.dispose();
  });

  it('should leave a failed socket event and its queued successor uncommitted', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    fixture.repairing.callsFake(async (activeController: SyncLinkController): Promise<void> => {
      activeController.resetReplicationGeneration();
    });
    expect(await openSubscription(fixture)).toBe(true);
    controller.markReplicationReady();
    controller.markPullCurrent(controller.replicationGeneration);

    const message = {
      descriptor: {
        interface        : 'Protocols',
        method           : 'Configure',
        messageTimestamp : '2026-08-12T00:00:00.000000Z',
      },
    };
    const messageCid = await Message.getCid(message as any);
    const cursor: ProgressToken = {
      epoch    : 'event-epoch',
      messageCid,
      position : '10',
      streamId : 'event-stream',
    };
    sinon.stub(engine as any, 'admitRemoteFeedPage').resolves({ admittedCids: [], kind: 'processed' });
    const persistStarted = deferred();
    const rejectPersist = deferred();
    (engine as any)._replicationLinkStore = {
      persistCheckpoint: sinon.stub().callsFake(async (): Promise<void> => {
        persistStarted.resolve();
        await rejectPersist.promise;
        throw new Error('storage unavailable');
      }),
    };

    const handled = fixture.handlers[0]({
      type              : 'event',
      cursor,
      event             : { message },
      isLatestBaseState : true,
      messageCid,
    });
    const handledError = handled.then(
      (): undefined => undefined,
      (error: unknown): unknown => error,
    );
    await persistStarted.promise;
    const successor = fixture.handlers[0]({
      type              : 'event',
      cursor            : { ...cursor, position: '11' },
      event             : { message },
      isLatestBaseState : true,
      messageCid,
    });
    rejectPersist.resolve();

    expect(await handledError).toBeInstanceOf(SubscriptionHandlerTerminalError);
    await successor;
    expect(controller.link.pull.contiguousAppliedToken).toBeUndefined();
    expect((engine as any).admitRemoteFeedPage.calledOnce).toBe(true);
    expect(fixture.repairing.calledOnceWithExactly(controller)).toBe(true);
    expect(controller.isPullCurrent).toBe(false);
    await controller.dispose();
  });

  it('should refresh delegated role authorization for each foreign-context subscription request', async () => {
    const fixture = createEngineFixture(db);
    const grantA = { recordId: 'grant-a' };
    const grantB = { recordId: 'grant-b' };
    const getPermissionForRequest = sinon.stub();
    getPermissionForRequest.onFirstCall().resolves({ message: grantA });
    getPermissionForRequest.onSecondCall().resolves({ message: grantB });
    (fixture.engine as any)._permissionsApi = { getPermissionForRequest };
    fixture.sendDwnRequest.resolves({
      roleRecordId : 'role-a',
      status       : { code: 200 },
      subscription : { close: sinon.stub().resolves() },
    });
    const delegateDid = 'did:example:device';
    const roleAuthorization = {
      kind         : 'role' as const,
      actorDid     : 'did:example:member',
      protocolRole : 'notebook/viewer',
      roleRecordId : 'role-a',
    };
    fixture.controller.link.authorization = roleAuthorization;
    fixture.controller.link.delegateDid = delegateDid;
    fixture.controller.link.scope = {
      kind          : 'context',
      protocol      : 'https://example.com/notebooks',
      contextId     : 'notebook-a',
      protocolPaths : ['notebook/page'],
    };
    Object.assign(fixture.target, {
      authorization : roleAuthorization,
      delegateDid,
      scope         : fixture.controller.link.scope,
    });

    expect(await openSubscription(fixture)).toBe(true);
    const factory = fixture.sendDwnRequest.firstCall.args[0].subscription.resubscribeFactory;
    await factory();

    const [initial, resumed] = fixture.processRequest.args.map(([request]) => request);
    expect(initial).toMatchObject({
      author        : roleAuthorization.actorDid,
      target        : DID,
      granteeDid    : delegateDid,
      messageParams : {
        filters: [{
          interface       : 'Records',
          protocol        : fixture.controller.link.scope.protocol,
          protocolPath    : 'notebook/page',
          contextIdPrefix : 'notebook-a',
        }],
        protocolRole   : roleAuthorization.protocolRole,
        delegatedGrant : grantA,
      },
    });
    expect(resumed.messageParams.delegatedGrant).toBe(grantB);
    expect(getPermissionForRequest.callCount).toBe(2);
    expect(getPermissionForRequest.alwaysCalledWithMatch({ forceRefresh: true })).toBe(true);
    expect(fixture.sendDwnRequest.firstCall.args[0].targetDid).toBe(DID);
    await fixture.controller.dispose();
  });

  it('should admit a current role event without querying the durable feed', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    const roleAuthorization = {
      kind         : 'role' as const,
      actorDid     : 'did:example:member',
      protocolRole : 'notebook/page/editor',
      roleRecordId : 'role-a',
    };
    controller.link.authorization = roleAuthorization;
    controller.link.delegateDid = 'did:example:delegate';
    controller.link.scope = {
      kind          : 'context',
      protocol      : 'https://example.com/notebooks',
      contextId     : 'notebook-a/page-a',
      protocolPaths : ['notebook/page/delta'],
    };
    controller.markReplicationReady();
    controller.markPullCurrent(controller.replicationGeneration);

    const message = {
      recordId   : 'delta-a',
      contextId  : 'notebook-a/page-a/delta-a',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        messageTimestamp : '2026-08-12T00:00:00.000000Z',
        protocol         : controller.link.scope.protocol,
        protocolPath     : 'notebook/page/delta',
      },
    };
    const initialWrite = { ...message, recordId: 'delta-initial' };
    const messageCid = await Message.getCid(message as any);
    const cursor: ProgressToken = {
      epoch    : 'event-epoch',
      messageCid,
      position : '10',
      streamId : 'event-stream',
    };
    const admitRemoteFeedPage = sinon.stub(engine as any, 'admitRemoteFeedPage').resolves({
      admittedCids : [messageCid],
      kind         : 'processed',
    });
    const persistCheckpoint = sinon.stub().resolves();
    (engine as any)._replicationLinkStore = { persistCheckpoint };

    await (engine as any).handleLivePullMessage({
      controller,
      did        : DID,
      dwnUrl     : REMOTE,
      eventScope : {},
      isStale    : (): boolean => false,
      link       : controller.link,
      linkKey    : LINK_KEY,
    }, {
      type              : 'event',
      cursor,
      encodedData       : 'AQ',
      event             : { initialWrite, message },
      isLatestBaseState : true,
      messageCid,
    });

    expect(admitRemoteFeedPage.calledOnce).toBe(true);
    expect(admitRemoteFeedPage.firstCall.args[0]).toMatchObject({
      authorization : roleAuthorization,
      delegateDid   : controller.link.delegateDid,
      did           : DID,
      dwnUrl        : REMOTE,
      scope         : controller.link.scope,
    });
    expect(admitRemoteFeedPage.firstCall.args[1][0]).toMatchObject({
      encodedData       : 'AQ',
      initialWrite,
      isLatestBaseState : true,
      message,
      messageCid,
      seq               : cursor.position,
    });
    expect(fixture.resume.notCalled).toBe(true);
    expect(controller.link.pull.contiguousAppliedToken).toEqual(cursor);
    await controller.dispose();
  });

  it('should reject and close a role subscription resolved through a replacement role record', async () => {
    const fixture = createEngineFixture(db);
    const close = sinon.stub().resolves();
    const roleAuthorization = {
      kind         : 'role' as const,
      actorDid     : 'did:example:member',
      protocolRole : 'notebook/viewer',
      roleRecordId : 'role-a',
    };
    fixture.controller.link.authorization = roleAuthorization;
    fixture.target.authorization = roleAuthorization;
    fixture.sendDwnRequest.resolves({
      roleRecordId : 'role-b',
      status       : { code: 200 },
      subscription : { close },
    });

    await expect(openSubscription(fixture)).rejects.toThrow('changed from role-a to role-b');

    expect(close.calledOnce).toBe(true);
    expect(fixture.controller.hasLiveSubscription).toBe(false);
    await fixture.controller.dispose();
  });
});

describe('SyncEngineLevel — transport lifecycle connectivity', () => {
  let db: Level<string, string>;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-transport-attachment-spec');
  });

  afterEach(async () => {
    await db.clear();
    sinon.restore();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should report the link offline while the socket is down and online after verified resubscription', async () => {
    const fixture = createEngineFixture(db);
    const { controller } = fixture;
    controller.setLocalSubscription({ close: async (): Promise<void> => {} });

    expect(await openSubscription(fixture)).toBe(true);
    controller.markReplicationReady();
    controller.markPullCurrent(controller.replicationGeneration);
    const handler = fixture.handlers[0];
    const events: string[] = [];
    const unsubscribe = fixture.engine.on((event): void => {
      if (event.type === 'pull:currentness-change') {
        events.push(`pull:${event.to}`);
      } else if (event.type === 'link:connectivity-change') {
        events.push(`connectivity:${event.to}`);
      }
    });

    // The transport lost its socket: report this exact link offline even
    // though its logical subscription handle remains.
    await handler({ type: 'disconnected' });
    expect(controller.hasLiveSubscription).toBe(true);
    expect(controller.link.connectivity).toBe('offline');

    await handler({ type: 'reconnecting', attempt: 1 });
    events.splice(0);

    // The transport reports reconnected only after verified resubscription.
    await handler({ type: 'reconnected' });
    expect(controller.link.connectivity).toBe('online');
    expect(fixture.resume.calledOnceWithExactly(controller)).toBe(true);
    expect(controller.executor.hasPending('pull')).toBe(true);
    expect(controller.executor.hasPending('push')).toBe(true);
    expect(controller.isPullCurrent).toBe(false);
    expect(events).toEqual(['pull:false', 'connectivity:online']);

    unsubscribe();
    await controller.dispose();
  });

  it('should ignore transport lifecycle events from a superseded subscription', async () => {
    const fixture = createEngineFixture(db);
    const { controller } = fixture;

    expect(await openSubscription(fixture)).toBe(true);
    const staleHandler = fixture.handlers[0];

    // A repair resets the replication generation and reopens the subscription.
    controller.resetReplicationGeneration();
    await controller.closeLiveSubscription();
    expect(await openSubscription(fixture)).toBe(true);
    expect(controller.link.connectivity).toBe('online');

    // A late disconnect from the superseded subscription must not mark the
    // replacement replication generation offline.
    await staleHandler({ type: 'disconnected' });
    expect(controller.link.connectivity).toBe('online');

    await controller.dispose();
  });

  it('should ignore EOSE cursors because durable queries own pull progress', async () => {
    const fixture = createEngineFixture(db);
    fixture.controller.link.pull.contiguousAppliedToken = tokenIn('durable-stream', 'durable-epoch', '4');

    expect(await openSubscription(fixture)).toBe(true);
    fixture.controller.markReplicationReady();
    await fixture.handlers[0]({ type: 'eose', cursor: tokenIn('event-stream', 'event-epoch', '20') });

    expect(fixture.resume.notCalled).toBe(true);
    expect(fixture.controller.link.pull.contiguousAppliedToken).toEqual(
      tokenIn('durable-stream', 'durable-epoch', '4'),
    );
    await fixture.controller.dispose();
  });

  it('should pause terminal subscription authorization failures', async () => {
    const fixture = createEngineFixture(db);
    expect(await openSubscription(fixture)).toBe(true);

    await fixture.handlers[0]({
      type  : 'error',
      error : { code: 'GrantAuthorizationGrantRevoked' },
    });

    expect(fixture.controller.link.status).toBe('paused');
    expect(fixture.repairing.notCalled).toBe(true);
    await fixture.controller.dispose();
  });

  it('should repair retryable subscription failures', async () => {
    const fixture = createEngineFixture(db);
    expect(await openSubscription(fixture)).toBe(true);
    await fixture.handlers[0]({
      type  : 'error',
      error : { code: 'SubscriptionRecoveryFailed' },
    });

    expect(fixture.repairing.calledOnceWithExactly(fixture.controller)).toBe(true);
    await fixture.controller.dispose();
  });

});
