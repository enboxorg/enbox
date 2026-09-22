import type { SyncNextQuarantineEntry } from '../src/sync-next/types.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { SyncNextQuarantineCoordinator } from '../src/sync-next/quarantine-coordinator.js';

function target(dwnUrl: string): SyncTarget {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    did                : 'did:example:alice',
    dwnUrl,
    projectionId       : 'projection',
    scope              : { kind: 'full' },
  };
}

const entry: SyncNextQuarantineEntry = {
  attempts           : 1,
  authorizationEpoch : 'owner-epoch',
  encryptedPayload   : 'encrypted',
  firstPendingAt     : '2026-09-22T00:00:00.000Z',
  lastAttemptAt      : '2026-09-22T00:00:00.000Z',
  logicalTargetId    : 'did:example:alice^projection',
  messageCid         : 'cid',
  outcome            : { reason: 'data' },
  projectionId       : 'projection',
  remoteEndpoint     : 'https://first.example',
  source             : { epoch: 'epoch', position: '1', streamId: 'stream' },
  tenantDid          : 'did:example:alice',
  version            : 1,
};

describe('SyncNextQuarantineCoordinator', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should allow only one binding to retry a logical receipt before global backoff', async () => {
    const ledger = { getQuarantineForLogicalTarget: sinon.stub().resolves([entry]) };
    const retry = { retry: sinon.stub().resolves({ kind: 'pending' }) };
    const coordinator = new SyncNextQuarantineCoordinator(ledger as never, retry as never);

    const [first, second] = await Promise.all([
      coordinator.retryOne(target('https://first.example')),
      coordinator.retryOne(target('https://second.example')),
    ]);

    expect(retry.retry.calledOnce).toBe(true);
    expect([first.kind, second.kind].sort()).toEqual(['deferred', 'pending']);
  });

  it('should back off a corrupt or unreadable row instead of hot-looping the failure', async () => {
    const ledger = { getQuarantineForLogicalTarget: sinon.stub().resolves([entry]) };
    const retry = { retry: sinon.stub().rejects(new Error('ciphertext is corrupt')) };
    const coordinator = new SyncNextQuarantineCoordinator(ledger as never, retry as never);

    await expect(coordinator.retryOne(target('https://first.example'))).rejects.toThrow('ciphertext is corrupt');
    const deferred = await coordinator.retryOne(target('https://second.example'));

    expect(deferred.kind).toBe('deferred');
    expect(retry.retry.calledOnce).toBe(true);
  });
});
