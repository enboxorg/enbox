import { Level } from 'level';
import { describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

describe('SyncEngineLevel ejection snapshots', () => {
  it('preserves the replica ID across reopen and rotates it after a full clear', async () => {
    const dataPath = '__TESTDATA__/sync-ejection-snapshot/reopen';
    let engine = new SyncEngineLevel({ dataPath });
    await engine.clear();

    const initial = await engine.getEjectionSnapshot();
    expect(await engine.getEjectionSnapshot()).toEqual(initial);
    await engine.close();

    engine = new SyncEngineLevel({ dataPath });
    const reopened = await engine.getEjectionSnapshot();
    expect(reopened).toEqual(initial);

    await engine.clear();
    const rotated = await engine.getEjectionSnapshot();
    expect(rotated.replicaId).not.toBe(initial.replicaId);
    expect(rotated.registrationFingerprint).toBe(initial.registrationFingerprint);

    await engine.clear();
    await engine.close();
  });

  it('uses a distinct replica ID for each sync-store path', async () => {
    const first = new SyncEngineLevel({ dataPath: '__TESTDATA__/sync-ejection-snapshot/first' });
    const second = new SyncEngineLevel({ dataPath: '__TESTDATA__/sync-ejection-snapshot/second' });
    await Promise.all([first.clear(), second.clear()]);

    const [firstSnapshot, secondSnapshot] = await Promise.all([
      first.getEjectionSnapshot(),
      second.getEjectionSnapshot(),
    ]);

    expect(firstSnapshot.replicaId).not.toBe(secondSnapshot.replicaId);
    expect(firstSnapshot.registrationFingerprint).toBe(secondSnapshot.registrationFingerprint);

    await Promise.all([first.clear(), second.clear()]);
    await Promise.all([first.close(), second.close()]);
  });

  it('fingerprints sorted canonical identity options and changes with topology', async () => {
    const db = new Level<string, string>('__TESTDATA__/sync-ejection-snapshot/topology');
    const engine = new SyncEngineLevel({ db });
    await engine.clear();
    const registrations = db.sublevel('registeredIdentities');
    const empty = await engine.getEjectionSnapshot();

    await registrations.put('did:example:b', JSON.stringify({
      protocols   : ['https://protocol.example/z', 'https://protocol.example/a', 'https://protocol.example/z'],
      delegateDid : 'did:example:delegate',
    }));
    await registrations.put('did:example:a', JSON.stringify({ protocols: 'all' }));
    const firstTopology = await engine.getEjectionSnapshot();
    expect(firstTopology.replicaId).toBe(empty.replicaId);
    expect(firstTopology.registrationFingerprint).not.toBe(empty.registrationFingerprint);

    await registrations.clear();
    await registrations.put('did:example:a', JSON.stringify({ protocols: 'all' }));
    await registrations.put('did:example:b', JSON.stringify({
      delegateDid : 'did:example:delegate',
      protocols   : ['https://protocol.example/a', 'https://protocol.example/z'],
    }));
    const canonicalEquivalent = await engine.getEjectionSnapshot();
    expect(canonicalEquivalent).toEqual(firstTopology);

    await registrations.put('did:example:c', JSON.stringify({ protocols: 'all' }));
    const changedTopology = await engine.getEjectionSnapshot();
    expect(changedTopology.replicaId).toBe(firstTopology.replicaId);
    expect(changedTopology.registrationFingerprint).not.toBe(firstTopology.registrationFingerprint);

    await engine.clear();
    await engine.close();
  });
});
