import sinon from 'sinon';

import { Level } from 'level';
import { describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

describe('SyncEngineLevel drain coverage', () => {
  it('fails when one of two registered identities resolves no active projection', async () => {
    const endpoint = 'https://dwn.example';
    const coveredDid = 'did:example:covered';
    const missingDid = 'did:example:missing';
    const db = new Level<string, string>('__TESTDATA__/sync-drain-coverage');
    const syncEngine = new SyncEngineLevel({ db });
    await syncEngine.clear();
    const registrations = db.sublevel('registeredIdentities');
    await registrations.put(coveredDid, JSON.stringify({ protocols: 'all' }));
    await registrations.put(missingDid, JSON.stringify({ protocols: 'all' }));

    sinon.stub(syncEngine as any, 'buildSyncTargetsForEndpoint').callsFake(async (did: string): Promise<any[]> => {
      if (did === missingDid) {
        return [];
      }
      return [{
        authorization      : { kind: 'owner' },
        authorizationEpoch : 'owner-epoch',
        did,
        dwnUrl             : endpoint,
        scope              : { kind: 'full' },
      }];
    });
    sinon.stub(syncEngine as any, 'drainSyncTarget').callsFake(async (target: any): Promise<any> => ({
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      scope          : target.scope,
      completed      : true,
      cancelled      : false,
      converged      : true,
    }));

    const result = await syncEngine.drainTo(endpoint);

    expect(result.completed).toBe(false);
    expect(result.targets).toHaveLength(2);
    expect(result.targets).toContainEqual({
      tenantDid      : coveredDid,
      remoteEndpoint : endpoint,
      scope          : { kind: 'full' },
      completed      : true,
      cancelled      : false,
      converged      : true,
    });
    expect(result.targets).toContainEqual({
      tenantDid      : missingDid,
      remoteEndpoint : endpoint,
      scope          : { kind: 'full' },
      completed      : false,
      cancelled      : false,
      converged      : false,
      error          : 'registered identity resolved no active sync projections',
    });

    sinon.restore();
    await syncEngine.clear();
    await syncEngine.close();
  });
});
