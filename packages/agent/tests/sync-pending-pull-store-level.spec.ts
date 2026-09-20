import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { ReplicationLinkState } from '../src/types/sync.js';

import { SyncPendingPullStoreLevel } from '../src/sync-pending-pull-store-level.js';

function link(remoteEndpoint = 'https://a.example'): ReplicationLinkState {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    connectivity       : 'unknown',
    projectionId       : 'projection-a',
    pull               : { version: 2 },
    push               : {},
    remoteEndpoint,
    scope              : { kind: 'full' },
    status             : 'live',
    tenantDid          : 'did:example:alice',
  };
}

describe('SyncPendingPullStoreLevel', () => {
  let db: Level<string, string>;
  let store: SyncPendingPullStoreLevel;

  beforeAll(() => {
    db = new Level<string, string>(`__TESTDATA__/sync-pending-pull-store-level/${crypto.randomUUID()}`);
    store = new SyncPendingPullStoreLevel(db);
  });

  afterEach(async () => {
    await db.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should retain the exact link, feed position, signed entry, and typed outcome', async () => {
    const state = await store.nextState(link(), {
      entry: {
        isLatestBaseState : true,
        message           : { descriptor: { interface: 'Protocols', method: 'Configure' } } as never,
        messageCid        : 'cid-7',
        seq               : '7',
      },
      outcome: {
        kind    : 'Deferred',
        detail  : 'parent unavailable',
        missing : [{ type: 'Parent', protocol: 'https://example.com/protocol', recordId: 'parent-a' }],
        reason  : 'dependency',
      },
      source: { epoch: 'epoch-a', messageCid: 'cid-7', position: '7', streamId: 'stream-a' },
    });
    await store.put(state);

    expect(await store.getForLink(link())).toEqual([state]);
  });

  it('should isolate the same CID across exact endpoint links', async () => {
    const first = link('https://a.example');
    const second = link('https://b.example');
    for (const candidate of [first, second]) {
      const state = await store.nextState(candidate, {
        entry   : { isLatestBaseState: false, messageCid: 'shared-cid', seq: '4' },
        outcome : { kind: 'Deferred', reason: 'storage' },
        source  : { epoch: 'epoch-a', messageCid: 'shared-cid', position: '4', streamId: 'stream-a' },
      });
      await store.put(state);
    }

    expect((await store.getForLink(first)).map(({ remoteEndpoint }) => remoteEndpoint)).toEqual(['https://a.example']);
    expect((await store.getForLink(second)).map(({ remoteEndpoint }) => remoteEndpoint)).toEqual(['https://b.example']);
  });

  it('should retain the first timestamp while incrementing retry attempts', async () => {
    const activeLink = link();
    const input = {
      entry   : { isLatestBaseState: false, messageCid: 'cid-1', seq: '1' },
      outcome : { kind: 'Deferred' as const, reason: 'storage' as const },
      source  : { epoch: 'epoch-a', messageCid: 'cid-1', position: '1', streamId: 'stream-a' },
    };
    const first = await store.nextState(activeLink, input);
    await store.put(first);
    const second = await store.nextState(activeLink, input);

    expect(second.attempts).toBe(2);
    expect(second.firstPendingAt).toBe(first.firstPendingAt);
  });
});
