import type { SyncIdentityStoreEntry } from '../src/sync-identity-store.js';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncIdentityStoreLevel } from '../src/sync-identity-store-level.js';

describe('SyncIdentityStoreLevel', () => {
  let db: Level<string, string>;
  let store: SyncIdentityStoreLevel;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-identity-store-level-spec');
    store = new SyncIdentityStoreLevel(db);
  });

  afterEach(async () => {
    await db.clear();
    await db.sublevel('registeredIdentities').clear();
    await db.sublevel('syncMetadata').clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should preserve the existing Level representation when setting and getting options', async () => {
    const did = 'did:example:alice';
    const options = {
      protocols   : ['https://example.com/protocol'] as [string, ...string[]],
      delegateDid : 'did:example:delegate',
    };

    await store.set(did, options);

    expect(await store.get(did)).toEqual(options);
    expect(await db.sublevel('registeredIdentities').get(did)).toBe(JSON.stringify(options));
  });

  it('should return undefined for a missing identity and remove a stored identity', async () => {
    const did = 'did:example:alice';

    expect(await store.get(did)).toBeUndefined();
    await store.set(did, { protocols: 'all' });
    await store.delete(did);
    expect(await store.get(did)).toBeUndefined();
  });

  it('should preserve the existing missing-value behavior for an empty stored value', async () => {
    await db.sublevel('registeredIdentities').put('did:example:empty', '');

    expect(await store.get('did:example:empty')).toBeUndefined();
  });

  it('should isolate corrupt entries without hiding later valid registrations', async () => {
    const identities = db.sublevel('registeredIdentities');
    await identities.put('did:example:a-corrupt', '{');
    await identities.put('did:example:b-valid', JSON.stringify({ protocols: 'all' }));

    const entries: SyncIdentityStoreEntry[] = [];
    for await (const entry of store.entries()) {
      entries.push(entry);
    }

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ status: 'corrupt', did: 'did:example:a-corrupt' });
    expect(entries[1]).toEqual({ status: 'valid', did: 'did:example:b-valid', options: { protocols: 'all' } });
  });

  it('should clear registrations without clearing sibling sync state', async () => {
    await store.set('did:example:alice', { protocols: 'all' });
    await db.sublevel('syncMetadata').put('cursor', 'retained');

    await store.clear();

    expect(await store.get('did:example:alice')).toBeUndefined();
    expect(await db.sublevel('syncMetadata').get('cursor')).toBe('retained');
  });
});
