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
