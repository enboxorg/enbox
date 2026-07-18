import type { AbstractLevel } from 'abstract-level';

import type { SyncDeferredPullState } from '../src/sync-deferred-pull-store.js';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncDeferredPullStoreLevel } from '../src/sync-deferred-pull-store-level.js';

describe('SyncDeferredPullStoreLevel', () => {
  const messageCid = 'shared-cid';
  const remoteEndpoint = 'https://a.example';
  const tenantDid = 'did:example:alice';

  let db: Level<string, string>;
  let store: SyncDeferredPullStoreLevel;

  beforeAll(() => {
    db = new Level<string, string>(`__TESTDATA__/sync-deferred-pull-store-level/${crypto.randomUUID()}`);
    store = new SyncDeferredPullStoreLevel(db);
  });

  afterEach(async () => {
    await store.clear();
    await db.sublevel('deadLetters').clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('deletes every entry for one tenant without touching other tenants', async () => {
    await store.put(tenantDid, 'cid-1', remoteEndpoint, deferredPull());
    await store.put(tenantDid, 'cid-2', 'https://b.example', deferredPull());
    // Underscores are valid DID characters: a tenant whose DID extends the
    // deleted one must keep its entries.
    await store.put(`${tenantDid}_extra`, 'cid-3', remoteEndpoint, deferredPull());
    await store.put('did:example:bob', 'cid-4', remoteEndpoint, deferredPull());

    await store.deleteTenant(tenantDid);

    expect(await store.get(tenantDid, 'cid-1', remoteEndpoint)).toBeUndefined();
    expect(await store.get(tenantDid, 'cid-2', 'https://b.example')).toBeUndefined();
    expect(await store.get(`${tenantDid}_extra`, 'cid-3', remoteEndpoint)).toBeDefined();
    expect(await store.get('did:example:bob', 'cid-4', remoteEndpoint)).toBeDefined();
  });

  it('preserves the existing compound key and serialized state format', async () => {
    const state = deferredPull();

    await store.put(tenantDid, messageCid, remoteEndpoint, state);

    const key = `${tenantDid}|${messageCid}|${remoteEndpoint}`;
    expect(await db.sublevel('deferredPulls').get(key)).toBe(JSON.stringify(state));
    expect(await store.get(tenantDid, messageCid, remoteEndpoint)).toEqual(state);
    expect(await store.get(tenantDid, messageCid, 'https://another.example')).toBeUndefined();
  });

  it('deletes only the exact tenant, message, and remote entry', async () => {
    const state = deferredPull();
    await Promise.all([
      store.put(tenantDid, messageCid, remoteEndpoint, state),
      store.put(tenantDid, messageCid, 'https://b.example', state),
      store.put('did:example:bob', messageCid, remoteEndpoint, state),
    ]);

    await store.delete(tenantDid, messageCid, remoteEndpoint);
    await store.delete(tenantDid, messageCid, remoteEndpoint);

    expect(await store.get(tenantDid, messageCid, remoteEndpoint)).toBeUndefined();
    expect(await store.get(tenantDid, messageCid, 'https://b.example')).toEqual(state);
    expect(await store.get('did:example:bob', messageCid, remoteEndpoint)).toEqual(state);
  });

  it('clears only deferred-pull state', async () => {
    const state = deferredPull();
    const deadLetters = db.sublevel('deadLetters');
    await store.put(tenantDid, messageCid, remoteEndpoint, state);
    await deadLetters.put('unrelated', 'preserve me');

    await store.clear();

    expect(await store.get(tenantDid, messageCid, remoteEndpoint)).toBeUndefined();
    expect(await deadLetters.get('unrelated')).toBe('preserve me');
  });

  it('surfaces corrupt persisted state', async () => {
    const key = `${tenantDid}|${messageCid}|${remoteEndpoint}`;
    await db.sublevel('deferredPulls').put(key, '{malformed');

    await expect(store.get(tenantDid, messageCid, remoteEndpoint)).rejects.toThrow();
  });

  it('surfaces unexpected storage errors', async () => {
    const expectedError = new Error('read failed');
    const failingStore = new SyncDeferredPullStoreLevel({
      sublevel: (): { get: () => Promise<never> } => ({
        get: (): Promise<never> => Promise.reject(expectedError),
      }),
    } as unknown as AbstractLevel<string | Buffer | Uint8Array>);

    await expect(failingStore.get(tenantDid, messageCid, remoteEndpoint)).rejects.toBe(expectedError);
  });
});

function deferredPull(overrides: Partial<SyncDeferredPullState> = {}): SyncDeferredPullState {
  return {
    attempts        : 1,
    detail          : 'dependency unavailable',
    firstDeferredAt : '2026-01-01T00:00:00.000Z',
    lastDeferredAt  : '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}
