import type { ProgressToken } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import sinon from 'sinon';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { buildLinkKey } from '../src/sync-link-key.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';

const DID = 'did:example:seam-alice';
const REMOTE = 'https://seam.dwn.example.com';

function token(position: number): ProgressToken {
  return { epoch: 'epoch', position: String(position), streamId: 'stream' };
}

describe('SyncEngineLevel — reconciled push-checkpoint seam', () => {
  let db: Level<string, string>;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-push-checkpoint-seam-spec');
  });

  afterEach(async () => {
    sinon.restore();
    await db.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('applies a reconciler advance to the authoritative controller ledger and persists the final checkpoint', async () => {
    const engine = new SyncEngineLevel({ db });
    const identity = {
      authorization      : { kind: 'owner' as const },
      authorizationEpoch : 'owner-epoch',
      remoteEndpoint     : REMOTE,
      scope              : { kind: 'full' as const },
      tenantDid          : DID,
    };

    const created = await (engine as any).ledger.getOrCreateLink(identity);
    const linkKey = buildLinkKey(DID, REMOTE, created.projectionId, created.authorizationEpoch);
    const controller = (engine as any).activateLink(linkKey, created);
    const target = {
      authorization      : identity.authorization,
      authorizationEpoch : identity.authorizationEpoch,
      did                : DID,
      dwnUrl             : REMOTE,
      projectionId       : created.projectionId,
      scope              : identity.scope,
    };
    expect(await (engine as any).getOrCreateReplicationLink(target)).toBe(controller.link);

    // Position 1 is in flight and unacked (a stalled delivery); position 2
    // is acked but held — the successor gate cannot prove the gap below it.
    controller.trackPushDelivery(token(1));
    const acked = controller.trackPushDelivery(token(2));
    expect(controller.ackPushDelivery(acked)).toBe(0);
    expect(controller.link.push.contiguousAppliedToken).toBeUndefined();

    // Reconciliation advances the controller-owned checkpoint through
    // position 1, releasing the held live acknowledgement at position 2.
    controller.link.push.contiguousAppliedToken = token(1);
    await (engine as any).commitReconciledCheckpoint(controller.link, 'push');

    // The stalled position was pruned, the held ack was released, and one
    // authoritative checkpoint landed in both the session and durable store.
    expect(controller.pushInflightCount).toBe(0);
    expect(controller.link.push.contiguousAppliedToken?.position).toBe('2');

    const persisted = await (engine as any).ledger.getOrCreateLink(identity);
    expect(persisted.push.contiguousAppliedToken?.position).toBe('2');

    await controller.dispose();
  });

  it('serializes ordinary reconciliation through the active controller mailbox', async () => {
    const engine = new SyncEngineLevel({ db });
    const identity = {
      authorization      : { kind: 'owner' as const },
      authorizationEpoch : 'owner-epoch',
      remoteEndpoint     : REMOTE,
      scope              : { kind: 'full' as const },
      tenantDid          : DID,
    };
    const link = await (engine as any).ledger.getOrCreateLink(identity);
    const linkKey = buildLinkKey(DID, REMOTE, link.projectionId, link.authorizationEpoch);
    const controller = (engine as any).activateLink(linkKey, link);
    const target = {
      authorization      : identity.authorization,
      authorizationEpoch : identity.authorizationEpoch,
      did                : DID,
      dwnUrl             : REMOTE,
      projectionId       : link.projectionId,
      scope              : identity.scope,
    };

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const gate = controller.enqueue(async (): Promise<void> => blocked, 'flush');
    const reconcile = sinon.stub((engine as any)._durableFeedReconciler, 'reconcile').resolves({ converged: true });

    const result = (engine as any).reconcileTarget(target);
    await Promise.resolve();
    expect(reconcile.notCalled).toBe(true);

    release();
    await Promise.all([gate, result]);
    expect(reconcile.calledOnce).toBe(true);
    expect(reconcile.firstCall.args[1]).toBe(controller.link);

    await controller.dispose();
  });
});
