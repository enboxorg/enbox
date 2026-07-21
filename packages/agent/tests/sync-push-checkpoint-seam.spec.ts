import type { ProgressToken, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import type { SyncDurableFeedQuery } from '../src/sync-durable-feed-reconciler.js';

import { DwnErrorCode } from '@enbox/dwn-sdk-js';
import { Level } from 'level';
import sinon from 'sinon';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { buildLinkKey } from '../src/sync-link-key.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';

const DID = 'did:example:seam-alice';
const REMOTE = 'https://seam.dwn.example.com';

function token(position: number): ProgressToken {
  return { epoch: 'epoch', messageCid: `cid-${position}`, position: String(position), streamId: 'stream' };
}

function event(position: number): Extract<SubscriptionMessage, { type: 'event' }> {
  return {
    cursor : token(position),
    event  : { message: {} as never },
    type   : 'event',
  };
}

describe('SyncEngineLevel — durable push replay seam', () => {
  let db: Level<string, string>;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-push-checkpoint-seam-spec');
  });

  afterEach(async () => {
    sinon.restore();
    await db.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('uses local events only as wakes and durably replays a retryable page from its push checkpoint', async () => {
    const engine = new SyncEngineLevel({ db });
    const identity = {
      authorization      : { kind: 'owner' as const },
      authorizationEpoch : 'owner-epoch',
      remoteEndpoint     : REMOTE,
      scope              : { kind: 'full' as const },
      tenantDid          : DID,
    };
    const link = await (engine as any).replicationLinkStore.getOrCreateLink(identity);
    const durableCursor = token(1);
    link.push.contiguousAppliedToken = durableCursor;
    await (engine as any).replicationLinkStore.persistCheckpoint(link, 'push');
    await (engine as any).replicationLinkStore.setStatus(link, 'live');

    const linkKey = buildLinkKey(DID, REMOTE, link.projectionId, link.authorizationEpoch);
    const controller = (engine as any).activateLink(linkKey, link);
    controller.markReplicationReady();

    const replayQueries: SyncDurableFeedQuery[] = [];
    sinon.stub(engine as any, 'queryDurableFeed').callsFake(async (query: SyncDurableFeedQuery) => {
      replayQueries.push(query);
      return {
        cursor      : token(2),
        drained     : true,
        entries     : [{ messageCid: 'cid-2' }],
        fingerprint : 'local-feed-at-2',
        status      : { code: 200, detail: 'OK' },
      };
    });
    const pushLocalPage = sinon.stub(engine as any, 'pushLocalFeedPage');
    pushLocalPage.onFirstCall().resolves({
      failures           : [{ cid: 'cid-2', detail: 'remote storage unavailable', kind: 'Deferred', reason: 'storage' }],
      hasActionableDiffs : true,
      kind               : 'failed',
    });
    pushLocalPage.onSecondCall().resolves({ hasActionableDiffs: true, kind: 'processed' });
    sinon.stub(engine as any, 'probeQuotaBlocksForTarget').resolves();

    // EOSE is control information, not a push wake.
    await (engine as any).handleLocalPushMessage(
      controller,
      (): boolean => false,
      { cursor: token(98), type: 'eose' },
    );
    expect(replayQueries).toHaveLength(0);

    // The event cursor is deliberately far ahead. It only wakes a durable
    // pass; the pass resumes from the persisted checkpoint instead.
    await (engine as any).handleLocalPushMessage(controller, (): boolean => false, event(99));

    expect(replayQueries.map(({ cursor }) => cursor)).toEqual([durableCursor]);
    expect(pushLocalPage.firstCall.args[1]).toEqual([{ messageCid: 'cid-2' }]);
    expect(controller.link.push.contiguousAppliedToken).toEqual(durableCursor);
    const persistedAfterFailure = await (engine as any).replicationLinkStore.getOrCreateLink(identity);
    expect(persistedAfterFailure.push.contiguousAppliedToken).toEqual(durableCursor);

    // A remote-mode local DWN reconnect may have skipped writes while its
    // socket was down. The reconnect notification is also only a wake: it
    // replays from durable progress rather than trusting transport state.
    await (engine as any).handleLocalPushMessage(
      controller,
      (): boolean => false,
      { type: 'reconnected' },
    );

    expect(replayQueries.map(({ cursor }) => cursor)).toEqual([durableCursor, durableCursor]);
    expect(pushLocalPage.secondCall.args[1]).toEqual([{ messageCid: 'cid-2' }]);
    expect(controller.link.push.contiguousAppliedToken).toEqual(token(2));
    const persistedAfterSuccess = await (engine as any).replicationLinkStore.getOrCreateLink(identity);
    expect(persistedAfterSuccess.push.contiguousAppliedToken).toEqual(token(2));

    await controller.dispose();
  });

  it('repairs a failed local subscription recovery and pauses terminal authorization failures', async () => {
    const engine = new SyncEngineLevel({ db });
    const link = await (engine as any).replicationLinkStore.getOrCreateLink({
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      remoteEndpoint     : REMOTE,
      scope              : { kind: 'full' },
      tenantDid          : DID,
    });
    await (engine as any).replicationLinkStore.setStatus(link, 'live');
    const linkKey = buildLinkKey(DID, REMOTE, link.projectionId, link.authorizationEpoch);
    const controller = (engine as any).activateLink(linkKey, link);
    controller.markReplicationReady();
    const repair = sinon.stub(engine['_linkRecoveryCoordinator'], 'transitionToRepairing').resolves();
    const pause = sinon.stub(engine as any, 'transitionToPaused').resolves();
    sinon.stub(console, 'warn');

    await (engine as any).handleLocalPushMessage(controller, (): boolean => false, {
      cursor : token(2),
      error  : { code: 'SubscriptionRecoveryFailed', detail: 'socket recovery failed' },
      type   : 'error',
    });
    expect(repair.calledOnceWithExactly(controller)).toBe(true);
    expect(pause.notCalled).toBe(true);

    await (engine as any).handleLocalPushMessage(controller, (): boolean => false, {
      cursor : token(2),
      error  : { code: DwnErrorCode.MessagesSubscribeDeliveryAuthorizationFailed, detail: 'grant revoked' },
      type   : 'error',
    });
    expect(pause.calledOnceWithExactly(linkKey, link)).toBe(true);
    expect(repair.calledOnce).toBe(true);

    await controller.dispose();
  });
});
