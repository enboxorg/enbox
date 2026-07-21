import type { ProgressToken } from '@enbox/dwn-sdk-js';

import { Level } from 'level';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { ReplicationLinkState } from '../src/types/sync.js';

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

    // The store hands out INDEPENDENT copies per read — the exact property
    // this seam must survive. The controller owns one copy; the reconciler
    // operates on another.
    const created = await (engine as any).ledger.getOrCreateLink(identity);
    const controllerLink = JSON.parse(JSON.stringify(created)) as ReplicationLinkState;
    const reconcilerLink = await (engine as any).ledger.getOrCreateLink(identity);
    expect(reconcilerLink).not.toBe(controllerLink);

    const linkKey = buildLinkKey(DID, REMOTE, created.projectionId, created.authorizationEpoch);
    const controller = (engine as any).activateLink(linkKey, controllerLink);
    const target = {
      authorization      : identity.authorization,
      authorizationEpoch : identity.authorizationEpoch,
      did                : DID,
      dwnUrl             : REMOTE,
      projectionId       : created.projectionId,
      scope              : identity.scope,
    };

    // Position 1 is in flight and unacked (a stalled delivery); position 2
    // is acked but held — the successor gate cannot prove the gap below it.
    controller.trackPushDelivery(token(1));
    const acked = controller.trackPushDelivery(token(2));
    expect(controller.ackPushDelivery(acked)).toBe(0);
    expect(controller.link.push.contiguousAppliedToken).toBeUndefined();

    // The reconciler's pass advanced ITS copy through position 1.
    reconcilerLink.push.contiguousAppliedToken = token(1);
    await (engine as any).commitReconciledCheckpoint(reconcilerLink, 'push', target);

    // The stalled position was pruned, the held ack was released, and one
    // authoritative checkpoint landed everywhere: the controller's ledger,
    // the persisted object, and durable storage.
    expect(controller.pushInflightCount).toBe(0);
    expect(controller.link.push.contiguousAppliedToken?.position).toBe('2');
    expect(reconcilerLink.push.contiguousAppliedToken?.position).toBe('2');

    const persisted = await (engine as any).ledger.getOrCreateLink(identity);
    expect(persisted.push.contiguousAppliedToken?.position).toBe('2');

    await controller.dispose();
  });
});
