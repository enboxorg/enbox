import type { ProgressToken } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { Level } from 'level';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { SyncLinkController } from '../src/sync-link-controller.js';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

const DID = 'did:example:alice';
const REMOTE = 'https://dwn.example.com';
const LINK_KEY = `${DID}^${REMOTE}^projection-id^owner-epoch`;

function tokenIn(streamId: string, epoch: string, position: string): ProgressToken {
  return { epoch, messageCid: `cid-${position}`, position, streamId };
}

function activateTestLink(engine: SyncEngineLevel): SyncLinkController {
  return (engine as any).activateLink(LINK_KEY, {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    connectivity       : 'online',
    projectionId       : 'projection-id',
    pull               : {},
    push               : {},
    remoteEndpoint     : REMOTE,
    scope              : { kind: 'full' },
    status             : 'live',
    tenantDid          : DID,
  });
}

describe('SyncEngineLevel — live-pull generation fencing', () => {
  let db: Level<string, string>;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-live-pull-fencing-spec');
  });

  afterEach(async () => {
    await db.clear();
    sinon.restore();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should fence subscription callbacks issued before a pull-runtime reset', async () => {
    const engine = new SyncEngineLevel({ db });
    const controller = activateTestLink(engine);
    const handlers: Array<(message: unknown) => Promise<void>> = [];
    (engine as any)._agent = {
      dwn : { processRequest: sinon.stub().resolves({ message: {} }) },
      rpc : {
        sendDwnRequest: sinon.stub().callsFake(async (request: any) => {
          handlers.push(request.subscription.handler);
          return { status: { code: 200 }, subscription: { close: sinon.stub().resolves() } };
        }),
      },
    };
    sinon.stub((engine as any).ledger, 'persistCheckpoint').resolves();
    const repairing = sinon.stub((engine as any)._linkRecoveryCoordinator, 'transitionToRepairing').resolves();
    const target = {
      authorization      : { kind: 'owner' as const },
      authorizationEpoch : 'owner-epoch',
      did                : DID,
      dwnUrl             : REMOTE,
      linkKey            : LINK_KEY,
      projectionId       : 'projection-id',
      scope              : { kind: 'full' as const },
    };

    expect(await (engine as any).openLivePullSubscription(target, controller)).toBe(true);
    const staleHandler = handlers[0];

    // A repair resets the pull runtime, re-establishes the boundary on a new
    // stream domain, and reopens the subscription.
    controller.resetPullRuntime();
    controller.link.pull.contiguousAppliedToken = tokenIn('stream-2', 'epoch-2', '1');
    await controller.closeLiveSubscription();
    expect(await (engine as any).openLivePullSubscription(target, controller)).toBe(true);
    const freshHandler = handlers[1];

    // An EOSE from the superseded subscription carries a cursor from the old
    // stream domain: it must be discarded, not treated as a domain mismatch
    // that sends the freshly repaired link straight back into repair.
    await staleHandler({ type: 'eose', cursor: tokenIn('stream-1', 'epoch-1', '9') });
    expect(repairing.notCalled).toBe(true);
    expect(controller.link.pull.receivedToken).toBeUndefined();

    // The replacement subscription's callbacks flow normally.
    await freshHandler({ type: 'eose', cursor: tokenIn('stream-2', 'epoch-2', '2') });
    expect(controller.link.pull.receivedToken).toEqual(tokenIn('stream-2', 'epoch-2', '2'));

    await controller.shutdown();
  });
});
