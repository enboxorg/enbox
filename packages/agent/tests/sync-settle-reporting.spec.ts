import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { SyncRunFailedError } from '../src/sync-runtime-errors.js';

describe('SyncEngineLevel settle failure handling', () => {
  afterEach(() => {
    sinon.restore();
  });

  it.each([
    { detailsReported: true, expectedLogs: 0, label: 'does not repeat reported endpoint details' },
    { detailsReported: false, expectedLogs: 1, label: 'reports an otherwise unobserved failure' },
  ])('$label', async ({ detailsReported, expectedLogs }) => {
    const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
    const internal = syncEngine as any;
    const error = new SyncRunFailedError('one endpoint failed', { detailsReported });
    sinon.stub(internal._runCoordinator, 'settle').rejects(error);
    sinon.stub(internal, 'reinitializeOrphanedLinkTargets').resolves(false);
    const report = sinon.stub(console, 'error');

    await internal.runSettleCheck({ disposed: false });

    expect(report.callCount).toBe(expectedLogs);
    if (expectedLogs > 0) {
      expect(report.calledWithExactly('SyncEngineLevel: Error during durable feed settle check', error)).toBe(true);
    }
  });

  it('continues unrelated link recovery after reported endpoint failures', async () => {
    const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
    const internal = syncEngine as any;
    const error = new SyncRunFailedError('one endpoint failed', { detailsReported: true });
    const orphanedTarget = {
      did                : 'did:example:orphaned',
      dwnUrl             : 'https://healthy.example',
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      projectionId       : 'projection-id',
    };
    sinon.stub(internal._runCoordinator, 'settle').rejects(error);
    sinon.stub(internal, 'getSyncTargets').resolves([orphanedTarget]);
    const initialize = sinon.stub(internal, 'initializeLinkTarget').resolves();
    internal._linkControllers.set('paused-role', {
      link: {
        authorization : { kind: 'role', actorDid: 'did:example:actor' },
        status        : 'paused',
      },
    });
    sinon.stub(internal, 'isIdentityPaused').returns(false);
    const refresh = sinon.stub(internal, 'scheduleFollowedSourceRefresh');
    const report = sinon.stub(console, 'error');

    await internal.runSettleCheck(internal._runtime);

    expect(initialize.calledOnceWithExactly(orphanedTarget)).toBe(true);
    expect(refresh.calledOnce).toBe(true);
    expect(report.notCalled).toBe(true);
  });
});
