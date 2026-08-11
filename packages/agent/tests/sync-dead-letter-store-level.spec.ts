import type { AbstractLevel } from 'abstract-level';

import type { DeadLetterEntry } from '../src/types/sync.js';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncDeadLetterStoreLevel } from '../src/sync-dead-letter-store-level.js';

describe('SyncDeadLetterStoreLevel', () => {
  let db: Level<string, string>;
  let store: SyncDeadLetterStoreLevel;

  beforeAll(() => {
    db = new Level<string, string>(`__TESTDATA__/sync-dead-letter-store-level/${crypto.randomUUID()}`);
    store = new SyncDeadLetterStoreLevel(db);
  });

  afterEach(async () => {
    await db.sublevel('deadLetters').clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('preserves the existing compound key and serialized entry format', async () => {
    const entry = deadLetter();

    await store.put(entry);

    const key = `${entry.tenantDid}|${entry.messageCid}|${entry.remoteEndpoint}`;
    expect(await db.sublevel('deadLetters').get(key)).toBe(JSON.stringify(entry));
    expect(await store.get(entry.tenantDid, entry.messageCid, entry.remoteEndpoint)).toEqual(entry);
    expect(await store.get(entry.tenantDid, entry.messageCid, 'https://another.example')).toBeUndefined();
  });

  it('keeps exact tenant and remote identities independent during deletion', async () => {
    const aliceA = deadLetter();
    const aliceB = deadLetter({ remoteEndpoint: 'https://b.example' });
    const bobA = deadLetter({ tenantDid: 'did:example:bob' });
    await Promise.all([store.put(aliceA), store.put(aliceB), store.put(bobA)]);

    expect(await store.deleteExact(aliceA.tenantDid, aliceA.messageCid, aliceA.remoteEndpoint)).toEqual(identityOf(aliceA));

    expect(await store.getForTenant(aliceA.tenantDid)).toEqual([aliceB]);
    expect(await store.getForTenant(bobA.tenantDid)).toEqual([bobA]);
    expect(await store.deleteForMessage(aliceA.messageCid, aliceA.remoteEndpoint)).toEqual([identityOf(bobA)]);
    expect(await store.deleteForMessage(aliceA.messageCid, aliceA.remoteEndpoint)).toEqual([]);
    expect(await store.getAll()).toEqual([aliceB]);
  });

  it('deletes only the requested tenant while retaining unrelated failures', async () => {
    const alice = deadLetter();
    const bob = deadLetter({ messageCid: 'bob-cid', tenantDid: 'did:example:bob' });
    await Promise.all([store.put(alice), store.put(bob)]);

    expect(await store.deleteForTenant(alice.tenantDid)).toEqual([identityOf(alice)]);

    expect(await store.getForTenant(alice.tenantDid)).toEqual([]);
    expect(await store.getForTenant(bob.tenantDid)).toEqual([bob]);
  });

  it('isolates a tenant scan from corrupt entries owned by another tenant', async () => {
    const alice = deadLetter();
    await store.put(alice);
    await db.sublevel('deadLetters').put('did:example:bob|cid|https://dwn.example', '{malformed');

    expect(await store.getForTenant(alice.tenantDid)).toEqual([alice]);
  });

  it('surfaces corrupt persisted entries', async () => {
    const entry = deadLetter();
    const key = `${entry.tenantDid}|${entry.messageCid}|${entry.remoteEndpoint}`;
    await db.sublevel('deadLetters').put(key, '{malformed');

    await expect(store.get(entry.tenantDid, entry.messageCid, entry.remoteEndpoint)).rejects.toThrow();
    await expect(store.getAll()).rejects.toThrow();
    expect(await store.clear()).toEqual([identityOf(entry)]);
    expect(await store.getAll()).toEqual([]);
  });

  it('does not project a malformed key with an empty remote endpoint', async () => {
    await db.sublevel('deadLetters').put('did:example:alice|cid|', '{}');

    expect(await store.clear()).toEqual([]);
    expect(await store.getAll()).toEqual([]);
  });

  it('surfaces unexpected storage errors', async () => {
    const expectedError = new Error('read failed');
    const failingStore = new SyncDeadLetterStoreLevel({
      sublevel: (): { get: () => Promise<never> } => ({
        get: (): Promise<never> => Promise.reject(expectedError),
      }),
    } as unknown as AbstractLevel<string | Buffer | Uint8Array>);

    await expect(failingStore.get('did:example:alice', 'cid', 'https://dwn.example')).rejects.toBe(expectedError);
  });
});

function deadLetter(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  return {
    errorCode      : 'Invalid',
    errorDetail    : 'terminal failure',
    failedAt       : '2026-01-01T00:00:00.000Z',
    messageCid     : 'shared-cid',
    protocol       : 'https://protocol.example',
    remoteEndpoint : 'https://a.example',
    tenantDid      : 'did:example:alice',
    ...overrides,
  };
}

function identityOf(entry: DeadLetterEntry): Pick<DeadLetterEntry, 'messageCid' | 'remoteEndpoint' | 'tenantDid'> {
  const { messageCid, remoteEndpoint, tenantDid } = entry;
  return { messageCid, remoteEndpoint, tenantDid };
}
