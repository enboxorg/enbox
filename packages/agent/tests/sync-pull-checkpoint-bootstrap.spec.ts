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
  persistCheckpoint: SinonStub;
  queryDurableFeed: SinonStub;
  sendDwnRequest: SinonStub;
  target: Record<string, unknown>;
};

function tokenIn(streamId: string, epoch: string, position: string): ProgressToken {
  return { epoch, messageCid: `cid-${position}`, position, streamId };
}

function createEngineFixture(db: Level<string, string>, subscribeReply: Record<string, unknown>): EngineFixture {
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
  const processRequest = sinon.stub().resolves({ message: {} });
  const sendDwnRequest = sinon.stub().resolves({
    status       : { code: 200 },
    subscription : { close: sinon.stub().resolves() },
    ...subscribeReply,
  });
  (engine as any)._agent = { dwn: { processRequest }, rpc: { sendDwnRequest } };
  const persistCheckpoint = sinon.stub((engine as any).ledger, 'persistCheckpoint').resolves();
  const queryDurableFeed = sinon.stub(engine as any, 'queryDurableFeed').resolves({ status: { code: 200 }, fingerprint: 'feed-print' });
  const target = {
    authorization      : { kind: 'owner' as const },
    authorizationEpoch : 'owner-epoch',
    did                : DID,
    dwnUrl             : REMOTE,
    linkKey            : LINK_KEY,
    projectionId       : 'projection-id',
    scope              : { kind: 'full' as const },
  };
  return { controller, engine, persistCheckpoint, queryDurableFeed, sendDwnRequest, target };
}

function openSubscription(fixture: EngineFixture): Promise<boolean> {
  return (fixture.engine as any).openLivePullSubscription(fixture.target, fixture.controller);
}

describe('SyncEngineLevel — pull checkpoint bootstrap from subscribe replies', () => {
  let db: Level<string, string>;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-pull-checkpoint-bootstrap-spec');
  });

  afterEach(async () => {
    await db.clear();
    sinon.restore();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should adopt the reply head when the reply fingerprint matches the local feed', async () => {
    const head = tokenIn('stream-1', 'epoch-1', '7');
    const fixture = createEngineFixture(db, { fingerprint: 'feed-print', head });
    const { controller } = fixture;

    expect(await openSubscription(fixture)).toBe(true);

    expect(controller.link.pull.contiguousAppliedToken).toEqual(head);
    expect(fixture.persistCheckpoint.calledOnceWith(controller.link, 'pull')).toBe(true);
    expect(fixture.queryDurableFeed.calledOnce).toBe(true);

    await controller.dispose();
  });

  it('should leave the checkpoint untouched when the fingerprints differ', async () => {
    const fixture = createEngineFixture(db, { fingerprint: 'other-print', head: tokenIn('stream-1', 'epoch-1', '7') });
    const { controller } = fixture;

    expect(await openSubscription(fixture)).toBe(true);

    expect(controller.link.pull.contiguousAppliedToken).toBeUndefined();
    expect(fixture.persistCheckpoint.notCalled).toBe(true);

    await controller.dispose();
  });

  it('should not probe the local feed when the reply carries no snapshot fields', async () => {
    const fixture = createEngineFixture(db, {});
    const { controller } = fixture;

    expect(await openSubscription(fixture)).toBe(true);

    expect(fixture.queryDurableFeed.notCalled).toBe(true);
    expect(controller.link.pull.contiguousAppliedToken).toBeUndefined();
    expect(fixture.persistCheckpoint.notCalled).toBe(true);

    await controller.dispose();
  });

  it('should not probe the local feed when the reply head is not a valid progress token', async () => {
    const fixture = createEngineFixture(db, { fingerprint: 'feed-print', head: { epoch: '', position: '', streamId: '' } });
    const { controller } = fixture;

    expect(await openSubscription(fixture)).toBe(true);

    expect(fixture.queryDurableFeed.notCalled).toBe(true);
    expect(controller.link.pull.contiguousAppliedToken).toBeUndefined();

    await controller.dispose();
  });

  it('should not bootstrap a link that already holds a pull checkpoint', async () => {
    const existing = tokenIn('stream-1', 'epoch-1', '3');
    const fixture = createEngineFixture(db, { fingerprint: 'feed-print', head: tokenIn('stream-1', 'epoch-1', '7') });
    const { controller } = fixture;
    controller.link.pull.contiguousAppliedToken = existing;

    expect(await openSubscription(fixture)).toBe(true);

    expect(fixture.queryDurableFeed.notCalled).toBe(true);
    expect(controller.link.pull.contiguousAppliedToken).toEqual(existing);
    expect(fixture.persistCheckpoint.notCalled).toBe(true);

    await controller.dispose();
  });

  it('should skip adoption when the local probe reports a failure status', async () => {
    const fixture = createEngineFixture(db, { fingerprint: 'feed-print', head: tokenIn('stream-1', 'epoch-1', '7') });
    const { controller } = fixture;
    fixture.queryDurableFeed.resolves({ status: { code: 500, detail: 'boom' } });

    expect(await openSubscription(fixture)).toBe(true);

    expect(controller.link.pull.contiguousAppliedToken).toBeUndefined();
    expect(fixture.persistCheckpoint.notCalled).toBe(true);

    await controller.dispose();
  });

  it('should keep the subscription open when the local probe throws', async () => {
    const fixture = createEngineFixture(db, { fingerprint: 'feed-print', head: tokenIn('stream-1', 'epoch-1', '7') });
    const { controller } = fixture;
    fixture.queryDurableFeed.rejects(new Error('probe failed'));

    expect(await openSubscription(fixture)).toBe(true);

    expect(controller.link.pull.contiguousAppliedToken).toBeUndefined();
    expect(fixture.persistCheckpoint.notCalled).toBe(true);

    await controller.dispose();
  });

  it('should skip adoption when the pull generation reset while the probe was in flight', async () => {
    const fixture = createEngineFixture(db, { fingerprint: 'feed-print', head: tokenIn('stream-1', 'epoch-1', '7') });
    const { controller } = fixture;
    fixture.queryDurableFeed.callsFake(async () => {
      controller.resetPullGeneration();
      return { status: { code: 200 }, fingerprint: 'feed-print' };
    });

    expect(await openSubscription(fixture)).toBe(true);

    expect(controller.link.pull.contiguousAppliedToken).toBeUndefined();
    expect(fixture.persistCheckpoint.notCalled).toBe(true);

    await controller.dispose();
  });

  it('should not clobber a checkpoint committed by a live delivery during the probe', async () => {
    const delivered = tokenIn('stream-1', 'epoch-1', '9');
    const fixture = createEngineFixture(db, { fingerprint: 'feed-print', head: tokenIn('stream-1', 'epoch-1', '7') });
    const { controller } = fixture;
    fixture.queryDurableFeed.callsFake(async () => {
      controller.link.pull.contiguousAppliedToken = delivered;
      return { status: { code: 200 }, fingerprint: 'feed-print' };
    });

    expect(await openSubscription(fixture)).toBe(true);

    expect(controller.link.pull.contiguousAppliedToken).toEqual(delivered);
    expect(fixture.persistCheckpoint.notCalled).toBe(true);

    await controller.dispose();
  });
});
