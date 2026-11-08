import type { SyncIdentityOptions } from '../src/types/sync.js';

import { join } from 'node:path';
import { Level } from 'level';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { SYNC_STORE_FORMAT, SYNC_STORE_FORMAT_KEY } from '../src/sync-store-format.js';

describe('SyncEngineLevel persisted format', () => {
  let dataPath: string;
  let db: Level<string, string>;
  let engine: SyncEngineLevel;

  beforeEach(async () => {
    dataPath = await mkdtemp(join(tmpdir(), 'enbox-sync-format-'));
    db = new Level<string, string>(dataPath);
    engine = new SyncEngineLevel({ db });
  });

  afterEach(async () => {
    await engine.close();
    await rm(dataPath, { recursive: true });
  });

  it('initializes an empty store and reopens current registrations', async () => {
    const did = 'did:example:format-owner';
    expect(await engine.getIdentityOptions(did)).toBeUndefined();
    expect(await db.get(SYNC_STORE_FORMAT_KEY)).toBe(SYNC_STORE_FORMAT);

    const options: SyncIdentityOptions = { modules: 'all' };
    await db.sublevel('registeredIdentities').put(did, JSON.stringify(options));
    await engine.close();
    db = new Level<string, string>(dataPath);
    engine = new SyncEngineLevel({ db });

    expect(await engine.getIdentityOptions(did)).toEqual(options);
  });

  it('rejects unmarked persisted state before reading or writing and leaves it untouched', async () => {
    const did = 'did:example:legacy-owner';
    const previous = JSON.stringify({ protocols: ['https://example.com/notes'] });
    await db.sublevel('registeredIdentities').put(did, previous);

    await expect(engine.getIdentityOptions(did)).rejects.toThrow('incompatible persisted sync format');
    await expect(engine.recordDeadLetter({
      messageCid     : 'legacy-message',
      tenantDid      : did,
      remoteEndpoint : 'https://dwn.example.com',
      errorDetail    : 'must not be written',
    })).rejects.toThrow('reinitialize the sync store');

    expect(await db.sublevel('registeredIdentities').get(did)).toBe(previous);
    expect(await db.keys().all()).toHaveLength(1);
  });

  it('rejects an unknown marked format without replacing its marker', async () => {
    await db.put(SYNC_STORE_FORMAT_KEY, 'unsupported-format');

    await expect(engine.listFollowedSources()).rejects.toThrow('incompatible persisted sync format');
    expect(await db.get(SYNC_STORE_FORMAT_KEY)).toBe('unsupported-format');
  });

  it('rejects the former single-module source format without migrating its records', async () => {
    await db.put(SYNC_STORE_FORMAT_KEY, 'modules-v1');
    const previous = JSON.stringify({ module: 'https://example.com/notebook', moduleRole: 'notebook/member' });
    await db.sublevel('followedSyncSources').put('role-a', previous);

    await expect(engine.listFollowedSources()).rejects.toThrow('incompatible persisted sync format');
    expect(await db.get(SYNC_STORE_FORMAT_KEY)).toBe('modules-v1');
    expect(await db.sublevel('followedSyncSources').get('role-a')).toBe(previous);
  });

  it('preserves the format marker when clearing current state', async () => {
    await engine.getIdentityOptions('did:example:format-owner');
    await engine.clear();

    expect(await db.get(SYNC_STORE_FORMAT_KEY)).toBe(SYNC_STORE_FORMAT);
    expect(await db.keys().all()).toEqual([SYNC_STORE_FORMAT_KEY]);
  });

  it('coordinates first use by two engine instances sharing an empty database', async () => {
    const second = new SyncEngineLevel({ db });
    await Promise.all([
      engine.getIdentityOptions('did:example:first'),
      second.getIdentityOptions('did:example:second'),
    ]);

    expect(await db.keys().all()).toEqual([SYNC_STORE_FORMAT_KEY]);
  });
});
