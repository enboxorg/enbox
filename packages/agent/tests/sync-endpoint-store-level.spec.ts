import type { AbstractLevel } from 'abstract-level';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncEndpointStoreLevel } from '../src/sync-endpoint-store-level.js';

describe('SyncEndpointStoreLevel', () => {
  let db: Level<string, string>;
  let store: SyncEndpointStoreLevel;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-endpoint-store-level-spec');
    store = new SyncEndpointStoreLevel(db);
  });

  afterEach(async () => {
    await db.clear();
    await db.sublevel('registeredIdentities').clear();
    await db.sublevel('syncMetadata').clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should preserve the existing Level representation when setting and getting an endpoint', async () => {
    const endpoint = 'https://dwn.example.com';

    await store.set(endpoint);

    expect(await store.get()).toBe(endpoint);
    expect(await db.sublevel('syncMetadata').get('supplementalDwnEndpoint')).toBe(endpoint);
  });

  it('should return undefined when no endpoint exists', async () => {
    expect(await store.get()).toBeUndefined();
  });

  it('should surface unexpected storage errors', async () => {
    const expectedError = new Error('read failed');
    const failingDb = {
      sublevel: () => ({
        get: (): Promise<never> => Promise.reject(expectedError),
      }),
    } as unknown as AbstractLevel<string | Buffer | Uint8Array>;
    const failingStore = new SyncEndpointStoreLevel(failingDb);

    await expect(failingStore.get()).rejects.toBe(expectedError);
  });

  it('should preserve an empty stored endpoint', async () => {
    await db.sublevel('syncMetadata').put('supplementalDwnEndpoint', '');

    expect(await store.get()).toBe('');
  });

  it('should replace an existing endpoint', async () => {
    await store.set('https://old.example.com');
    await store.set('https://new.example.com');

    expect(await store.get()).toBe('https://new.example.com');
  });

  it('should clear endpoint state without clearing sibling sync state', async () => {
    await store.set('https://dwn.example.com');
    await db.sublevel('registeredIdentities').put('did:example:alice', JSON.stringify({ protocols: 'all' }));

    await store.clear();

    expect(await store.get()).toBeUndefined();
    expect(await db.sublevel('registeredIdentities').get('did:example:alice')).toBe(JSON.stringify({ protocols: 'all' }));
  });
});
