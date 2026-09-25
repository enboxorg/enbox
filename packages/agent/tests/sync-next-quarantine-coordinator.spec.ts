import type { SyncNextQuarantineEntry } from '../src/sync-next/types.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { SyncNextQuarantineRetry } from '../src/sync-next/quarantine-retry.js';

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
  authorizationEpoch : 'owner-epoch',
  encryptedPayload   : 'encrypted',
  lastAttemptAt      : '2026-09-22T00:00:00.000Z',
  messageCid         : 'cid',
  projectionId       : 'projection',
  remoteEndpoint     : 'https://first.example',
  source             : { epoch: 'epoch', position: '1', streamId: 'stream' },
  tenantDid          : 'did:example:alice',
};

describe('SyncNextQuarantineRetry coordination', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should allow only one binding to retry a logical receipt before global backoff', async () => {
    sinon.useFakeTimers({ now: Date.parse('2026-09-22T12:00:00.000Z') });
    let stored = entry;
    const ledger = {
      getQuarantineForLogicalTarget : sinon.stub().callsFake(async () => [stored]),
      updateQuarantine              : sinon.stub().callsFake(async () => {
        stored = { ...stored, lastAttemptAt: new Date().toISOString() };
      }),
    };
    const quarantine = new SyncNextQuarantineRetry({} as never, ledger as never);
    const retry = sinon.stub(quarantine, 'retry').callsFake(async () => {
      await ledger.updateQuarantine();
      return false;
    });

    const [first, second] = await Promise.all([
      quarantine.retryOne(target('https://first.example')),
      quarantine.retryOne(target('https://second.example')),
    ]);

    expect(retry.calledOnce).toBe(true);
    expect([first.progressed, second.progressed]).toEqual([false, false]);
    expect([first.remaining, second.remaining].sort()).toEqual([1, 1]);
  });

  it('should back off a corrupt or unreadable row instead of hot-looping the failure', async () => {
    sinon.useFakeTimers({ now: Date.parse('2026-09-22T12:00:00.000Z') });
    let stored = entry;
    const ledger = {
      getQuarantineForLogicalTarget : sinon.stub().callsFake(async () => [stored]),
      updateQuarantine              : sinon.stub().callsFake(async () => {
        stored = { ...stored, lastAttemptAt: new Date().toISOString() };
      }),
    };
    const quarantine = new SyncNextQuarantineRetry({} as never, ledger as never);
    const retry = sinon.stub(quarantine, 'retry').rejects(new Error('ciphertext is corrupt'));

    await expect(quarantine.retryOne(target('https://first.example'))).rejects.toThrow('ciphertext is corrupt');
    const deferred = await quarantine.retryOne(target('https://second.example'));

    expect(deferred).toEqual({ deferred: true, progressed: false, remaining: 1 });
    expect(retry.calledOnce).toBe(true);
  });
});
