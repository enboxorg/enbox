import type { SyncQuotaBlockState } from '../src/sync-quota-store.js';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncQuotaStoreLevel } from '../src/sync-quota-store-level.js';

describe('SyncQuotaStoreLevel', () => {
  let db: Level<string, string>;
  let store: SyncQuotaStoreLevel;

  beforeAll(() => {
    db = new Level<string, string>(`__TESTDATA__/sync-quota-store-level/${crypto.randomUUID()}`);
    store = new SyncQuotaStoreLevel(db);
  });

  afterEach(async () => {
    await store.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('preserves the existing compound key and serialized state format', async () => {
    const state = quotaState();

    await store.put(state);

    const key = `${state.tenantDid}|${state.messageCid}|${encodeURIComponent(state.linkKey)}`;
    expect(await db.sublevel('quotaBlocks').get(key)).toBe(JSON.stringify(state));
    expect(await store.get(state.tenantDid, state.linkKey, state.messageCid)).toEqual(state);
    expect(await store.get(state.tenantDid, 'another-link', state.messageCid)).toBeUndefined();
  });

  it('keeps tenant and complete-link identities independent during deletion', async () => {
    const aliceA = quotaState({ messageCid: 'shared-cid' });
    const aliceB = quotaState({ linkKey: 'alice-link-b', messageCid: 'shared-cid' });
    const bob = quotaState({ linkKey: 'bob-link', messageCid: 'shared-cid', tenantDid: 'did:example:bob' });
    await Promise.all([store.put(aliceA), store.put(aliceB), store.put(bob)]);

    expect(await store.delete(aliceA.tenantDid, aliceA.linkKey, aliceA.messageCid)).toBe(true);
    expect(await store.delete(aliceA.tenantDid, aliceA.linkKey, aliceA.messageCid)).toBe(false);
    expect(await store.getForTenant(aliceA.tenantDid)).toEqual([aliceB]);
    expect(await store.getForTenant(bob.tenantDid)).toEqual([bob]);

    await store.deleteForTenant(aliceB.tenantDid);

    expect(await store.getForTenant(aliceB.tenantDid)).toEqual([]);
    expect(await store.getAll()).toEqual([bob]);
  });

  it('deletes an exact set of stale rows without replacing unrelated state', async () => {
    const staleA = quotaState({ messageCid: 'stale-a' });
    const staleB = quotaState({ messageCid: 'stale-b' });
    const current = quotaState({ messageCid: 'current' });
    await Promise.all([store.put(staleA), store.put(staleB), store.put(current)]);

    await store.deleteMany([staleA, staleB]);

    expect(await store.getAll()).toEqual([current]);
  });
});

function quotaState(overrides: Partial<SyncQuotaBlockState> = {}): SyncQuotaBlockState {
  return {
    attempts           : 1,
    authorizationEpoch : 'owner-epoch',
    blockedCid         : 'cid-1',
    firstBlockedAt     : '2026-01-01T00:00:00.000Z',
    lastBlockedAt      : '2026-01-01T00:00:00.000Z',
    linkKey            : 'alice-link-a',
    messageCid         : 'cid-1',
    nextProbeAt        : '2026-01-01T00:00:30.000Z',
    projectionId       : 'projection',
    remoteEndpoint     : 'https://dwn.example',
    source             : 'feed',
    tenantDid          : 'did:example:alice',
    ...overrides,
  };
}
