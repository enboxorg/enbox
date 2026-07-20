import type { SyncTarget } from '../src/sync-target-resolver.js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

describe('SyncEngineLevel quota routing', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('resolves admitted CIDs as superseding acknowledgements without directly clearing quota blocks', async () => {
    const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
    const internal = syncEngine as any;
    const target: SyncTarget = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      did                : 'did:example:alice',
      dwnUrl             : 'https://dwn.example',
      projectionId       : 'projection-id',
      scope              : { kind: 'full' },
    };
    const admittedCids = ['dependency-cid', 'successor-cid'];
    sinon.stub(internal, 'clearDeadLetterForTenant').resolves();
    sinon.stub(internal, 'clearDeferredPull').resolves();
    const resolveSuperseded = sinon.stub(
      internal,
      'resolveQuotaBlocksSupersededByAcknowledgement',
    ).resolves();
    const clearBlock = sinon.spy(internal._quotaManager, 'clearBlock');

    await internal.trackRemoteFeedAppliedCids(admittedCids, target);

    expect(resolveSuperseded.callCount).toBe(admittedCids.length);
    expect(resolveSuperseded.firstCall.calledWithExactly(target, admittedCids[0])).toBe(true);
    expect(resolveSuperseded.secondCall.calledWithExactly(target, admittedCids[1])).toBe(true);
    expect(clearBlock.notCalled).toBe(true);
  });
});
