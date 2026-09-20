import type { GenericMessage, MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

const TENANT = 'did:example:alice';
const REMOTE = 'https://dwn.example';

function message(name: string): GenericMessage {
  return {
    descriptor: {
      interface        : 'Protocols',
      method           : 'Configure',
      messageTimestamp : `2026-01-01T00:00:0${name.length}.000000Z`,
    },
  } as GenericMessage;
}

describe('SyncEngineLevel pull page intake', () => {
  let db: Level<string, string>;

  beforeAll(() => {
    db = new Level<string, string>(`__TESTDATA__/sync-pull-page-intake/${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    sinon.restore();
    await db.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should retain one incomplete root, materialize an independent tail, and resume after restart', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const target = {
      authorization      : { kind: 'owner' as const },
      authorizationEpoch : 'owner-epoch',
      did                : TENANT,
      dwnUrl             : REMOTE,
      projectionId       : 'projection',
      scope              : { kind: 'full' as const },
    };
    const link = await internal.replicationLinkStore.getOrCreateLink({
      tenantDid          : TENANT,
      remoteEndpoint     : REMOTE,
      scope              : target.scope,
      authorization      : target.authorization,
      authorizationEpoch : target.authorizationEpoch,
    });
    const entries: MessagesQueryReplyEntry[] = [
      { isLatestBaseState: true, message: message('large'), messageCid: 'large-cid', seq: '1' },
      { isLatestBaseState: true, message: message('note'), messageCid: 'note-cid', seq: '2' },
    ];
    sinon.stub(internal, 'trackRemoteFeedAppliedCids').resolves();
    sinon.stub(internal, 'admitRemoteFeedEntry').callsFake(async (_target, entry) =>
      entry.messageCid === 'large-cid'
        ? { kind: 'deferred', outcome: { kind: 'Deferred', reason: 'data' } }
        : { kind: 'admitted', appliedCids: ['note-cid'], freshEntries: [] }
    );

    const admitted = await internal.admitRemoteFeedPage(target, entries);
    expect(admitted).toMatchObject({
      admittedCids       : ['note-cid'],
      kind               : 'processed',
      pending            : [{ entry: { messageCid: 'large-cid' } }],
      settledMessageCids : ['note-cid'],
    });
    const checkpoint: ProgressToken = {
      epoch      : 'epoch',
      messageCid : 'note-cid',
      position   : '2',
      streamId   : 'stream',
    };
    expect(await internal.commitPullPage(
      link,
      checkpoint,
      admitted.deadLetters,
      admitted.pending,
      admitted.settledMessageCids,
    )).toBe(true);

    const restarted = new SyncEngineLevel({ db }) as any;
    const restartedLink = await restarted.replicationLinkStore.getOrCreateLink({
      tenantDid          : TENANT,
      remoteEndpoint     : REMOTE,
      scope              : target.scope,
      authorization      : target.authorization,
      authorizationEpoch : target.authorizationEpoch,
    });
    expect(restartedLink.pull.contiguousAppliedToken).toEqual(checkpoint);
    expect(await restarted.replicationLinkStore.getPendingPullsForLink(restartedLink)).toMatchObject([{
      entry      : { message: entries[0]?.message, messageCid: 'large-cid' },
      messageCid : 'large-cid',
      source     : { position: '1' },
    }]);

    sinon.stub(restarted, 'trackRemoteFeedAppliedCids').resolves();
    sinon.stub(restarted, 'admitRemoteFeedEntry').resolves({
      kind         : 'admitted',
      appliedCids  : ['large-cid'],
      freshEntries : [],
    });
    expect(await restarted.retryPendingPulls(target, restartedLink)).toEqual({ pendingCount: 0 });
    expect(await restarted.replicationLinkStore.getPendingPullsForLink(restartedLink)).toEqual([]);
  });

  it('should settle retained work from verified local materialization without revisiting its source endpoint', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const localMessage = message('local');
    const target = {
      authorization      : { kind: 'owner' as const },
      authorizationEpoch : 'owner-epoch',
      did                : TENANT,
      dwnUrl             : REMOTE,
      projectionId       : 'projection',
      scope              : { kind: 'full' as const },
    };
    const getLocal = sinon.stub(internal, 'getLocalMessageForTarget').resolves({ message: localMessage });
    const hydrate = sinon.spy(internal, 'syncEntriesFromFeedEntry');

    const outcome = await internal.admitRemoteFeedEntry(target, {
      isLatestBaseState : false,
      message           : localMessage,
      messageCid        : 'shared-cid',
      seq               : '1',
    }, undefined, { verifyLocalCompletion: true });

    expect(outcome).toEqual({ kind: 'echo' });
    expect(getLocal.calledOnce).toBe(true);
    expect(hydrate.notCalled).toBe(true);
  });
});
