import type { ProgressToken } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import type { SyncTarget } from '../src/sync-target-resolver.js';

import { SyncNextLinkSession } from '../src/sync-next/link-session.js';

function target(): SyncTarget {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    did                : 'did:example:alice',
    dwnUrl             : 'https://dwn.example.com',
    projectionId       : 'projection',
    scope              : { kind: 'full' },
  };
}

function token(position = '2'): ProgressToken {
  return { epoch: 'epoch', position, streamId: 'stream' };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(overrides: {
  delivery?: object[];
  quarantine?: object[];
} = {}): {
  ledger: {
    getDeliveryForLink: sinon.SinonStub;
    getQuarantineForLogicalTarget: sinon.SinonStub;
    settleQuarantineForLogicalTarget: sinon.SinonStub;
  };
  pullPage: { consume: sinon.SinonStub };
  pushPage: { consume: sinon.SinonStub; retryDelivery: sinon.SinonStub };
  quarantine: { retryOne: sinon.SinonStub };
  report: sinon.SinonStub;
} {
  return {
    ledger: {
      getDeliveryForLink               : sinon.stub().resolves(overrides.delivery ?? []),
      getQuarantineForLogicalTarget    : sinon.stub().resolves(overrides.quarantine ?? []),
      settleQuarantineForLogicalTarget : sinon.stub().resolves(),
    },
    pullPage: {
      consume: sinon.stub().resolves({
        handledThrough   : token(),
        hasMore          : false,
        materializedCids : [],
        quarantined      : 0,
      }),
    },
    pushPage: {
      consume: sinon.stub().resolves({
        delivered      : 0,
        handledThrough : token(),
        hasMore        : false,
        retained       : 0,
      }),
      retryDelivery: sinon.stub().resolves({ kind: 'settled' }),
    },
    quarantine: {
      retryOne: sinon.stub().resolves(overrides.quarantine?.length
        ? { kind: 'pending', remaining: overrides.quarantine.length }
        : { kind: 'empty', remaining: 0 }),
    },
    report: sinon.stub(),
  };
}

function session(parts: ReturnType<typeof fixture>): SyncNextLinkSession {
  return new SyncNextLinkSession(
    target(),
    parts.ledger as never,
    parts.pullPage as never,
    parts.pushPage as never,
    parts.quarantine as never,
    parts.report,
  );
}

describe('SyncNextLinkSession', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should release between covering pages until it observes drain', async () => {
    const clock = sinon.useFakeTimers();
    const parts = fixture();
    parts.pullPage.consume.onFirstCall().resolves({
      handledThrough   : token('1'),
      hasMore          : true,
      materializedCids : [],
      quarantined      : 0,
    });
    parts.pullPage.consume.onSecondCall().resolves({
      handledThrough   : token('5'),
      hasMore          : false,
      materializedCids : [],
      quarantined      : 0,
    });
    const link = session(parts);
    const covering = link.cover('pull');

    await clock.tickAsync(0);
    expect(parts.pullPage.consume.callCount).toBe(1);
    await clock.tickAsync(1);
    await covering;

    expect(parts.pullPage.consume.callCount).toBe(2);
    await link.dispose();
  });

  it('should keep a covering run open when a wake arrives during its drained page', async () => {
    const clock = sinon.useFakeTimers();
    const parts = fixture();
    const firstPage = deferred();
    parts.pullPage.consume.onFirstCall().callsFake(async () => {
      await firstPage.promise;
      return {
        handledThrough   : token('1'),
        hasMore          : false,
        materializedCids : [],
        quarantined      : 0,
      };
    });
    parts.pullPage.consume.onSecondCall().resolves({
      handledThrough   : token('2'),
      hasMore          : false,
      materializedCids : [],
      quarantined      : 0,
    });
    const link = session(parts);
    const covering = link.cover('pull');
    await clock.tickAsync(0);

    link.requestPull();
    firstPage.resolve();
    await clock.tickAsync(1);
    await covering;

    expect(parts.pullPage.consume.callCount).toBe(2);
    await link.dispose();
  });

  it('should resolve a covering run after one drained watermark page', async () => {
    const parts = fixture();
    parts.pullPage.consume.resolves({
      handledThrough   : token('1'),
      hasMore          : false,
      materializedCids : [],
      quarantined      : 0,
    });
    const link = session(parts);

    await expect(link.cover('pull')).resolves.toBeUndefined();
    await link.dispose();
  });

  it('should stop a cancelled covering run before requesting its next page', async () => {
    const parts = fixture();
    let current = true;
    parts.pullPage.consume.callsFake(async () => {
      current = false;
      return {
        handledThrough   : token('1'),
        hasMore          : true,
        materializedCids : [],
        quarantined      : 0,
      };
    });
    const link = session(parts);
    await expect(link.cover('pull', (): boolean => current)).rejects.toThrow('Covering sync cancelled');

    expect(parts.pullPage.consume.calledOnce).toBe(true);
    await link.dispose();
  });

  it('should reject instead of hanging when an otherwise-current page loses its link fence', async () => {
    const parts = fixture();
    parts.pullPage.consume.resolves({
      aborted          : true,
      hasMore          : false,
      materializedCids : [],
      quarantined      : 0,
    });
    const link = session(parts);

    await expect(link.cover('pull')).rejects.toThrow('link became stale');
    await link.dispose();
  });

  it('should let pull complete while the same link push is blocked', async () => {
    const clock = sinon.useFakeTimers();
    const parts = fixture();
    const blocked = deferred();
    parts.pushPage.consume.callsFake(async (): Promise<never> => {
      await blocked.promise;
      return undefined as never;
    });
    const link = session(parts);

    link.start();
    await clock.tickAsync(1);

    expect(parts.pullPage.consume.called).toBe(true);
    expect(parts.pushPage.consume.calledOnce).toBe(true);
    blocked.resolve();
    await clock.tickAsync(0);
    await link.dispose();
  });

  it('should apply a retained link block before fresh delivery', async () => {
    const clock = sinon.useFakeTimers();
    const block = {
      attempts   : 1,
      messageCid : 'other-link-pending',
      outcome    : { blockScope: 'endpoint', reason: 'transport' },
      source     : token('1'),
    };
    const parts = fixture({ delivery: [block] });
    const link = session(parts);

    link.requestPush();
    await clock.tickAsync(0);

    expect(parts.pushPage.consume.calledOnce).toBe(true);
    expect(parts.pushPage.consume.firstCall.args[1].endpointBlock).toEqual(block.outcome);
    await link.dispose();
  });

  it('should honor a persisted Retry-After before the first delivery retry', async () => {
    const clock = sinon.useFakeTimers({ now: Date.parse('2026-09-22T12:00:00.000Z') });
    const pending = {
      attempts      : 1,
      lastAttemptAt : '2026-09-22T12:00:00.000Z',
      messageCid    : 'rate-limited',
      outcome       : {
        blockScope : 'endpoint',
        reason     : 'transport',
        retryAfter : '2026-09-22T12:01:00.000Z',
      },
      source: token('1'),
    };
    const parts = fixture({ delivery: [pending] });
    const link = session(parts);

    link.start();
    await clock.tickAsync(59_999);
    expect(parts.pushPage.retryDelivery.notCalled).toBe(true);
    await clock.tickAsync(1);
    link.start();
    await clock.tickAsync(0);
    expect(parts.pushPage.retryDelivery.calledOnce).toBe(true);
    await link.dispose();
  });

  it('should service quarantine while fresh pull pages continue', async () => {
    const pending = { attempts: 1, messageCid: 'pending', source: token('1') };
    const parts = fixture({ quarantine: [pending] });
    parts.pullPage.consume.resolves({
      handledThrough   : token('1'),
      hasMore          : true,
      materializedCids : [],
      quarantined      : 0,
    });
    const link = session(parts);

    link.start();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(parts.pullPage.consume.called).toBe(true);
    expect(parts.quarantine.retryOne.called).toBe(true);
    await link.dispose();
  });

  it('should reject a covering run that observes drain with unresolved obligations', async () => {
    const parts = fixture({ quarantine: [{ messageCid: 'pending' }] });
    const link = session(parts);

    await expect(link.cover('pull')).rejects.toThrow('unresolved obligations');
    await link.dispose();
  });

  it('should give retained sparse obligations one finite retry before declaring incomplete', async () => {
    const pending = { attempts: 1, messageCid: 'pending', source: token('1') };
    const parts = fixture({ quarantine: [pending] });
    parts.quarantine.retryOne.resolves({ kind: 'settled', remaining: 0 });
    const link = session(parts);

    await expect(link.cover('pull')).resolves.toBeUndefined();

    expect(parts.quarantine.retryOne.calledOnce).toBe(true);
    await link.dispose();
  });

  it('should stop a covering sparse pass at the first unresolved receipt', async () => {
    const pending = [
      { attempts: 1, messageCid: 'pending-1', source: token('1') },
      { attempts: 1, messageCid: 'pending-2', source: token('2') },
    ];
    const parts = fixture({ quarantine: pending });
    parts.quarantine.retryOne.resolves({ kind: 'pending', remaining: 2 });
    const link = session(parts);

    await expect(link.cover('pull')).rejects.toThrow('unresolved obligations');

    expect(parts.quarantine.retryOne.calledOnce).toBe(true);
    await link.dispose();
  });

  it('should settle consecutive recoverable receipts in one bounded covering pass', async () => {
    const pending = [
      { attempts: 1, messageCid: 'pending-1', source: token('1') },
      { attempts: 1, messageCid: 'pending-2', source: token('2') },
    ];
    const parts = fixture({ quarantine: pending });
    parts.quarantine.retryOne.onFirstCall().resolves({ kind: 'settled', remaining: 1 });
    parts.quarantine.retryOne.onSecondCall().resolves({ kind: 'settled', remaining: 0 });
    const link = session(parts);

    await expect(link.cover('pull')).resolves.toBeUndefined();

    expect(parts.quarantine.retryOne.callCount).toBe(2);
    await link.dispose();
  });

  it('should settle consecutive recoverable deliveries in one bounded covering pass', async () => {
    const first = {
      attempts      : 1,
      lastAttemptAt : '2026-09-22T00:00:00.000Z',
      messageCid    : 'pending-1',
      outcome       : { reason: 'transport' },
      source        : token('1'),
    };
    const second = {
      attempts      : 1,
      lastAttemptAt : '2026-09-22T00:00:00.000Z',
      messageCid    : 'pending-2',
      outcome       : { reason: 'transport' },
      source        : token('2'),
    };
    const parts = fixture({ delivery: [first, second] });
    let remaining = [first, second];
    parts.ledger.getDeliveryForLink.callsFake(async () => remaining);
    parts.pushPage.retryDelivery.callsFake(async (_target, entry) => {
      remaining = remaining.filter(candidate => candidate.messageCid !== entry.messageCid);
      return { kind: 'settled' };
    });
    const link = session(parts);

    await expect(link.cover('push')).resolves.toBeUndefined();

    expect(parts.pushPage.retryDelivery.callCount).toBe(2);
    await link.dispose();
  });

  it('should settle duplicate exact-source quarantine when another link materializes the CID', async () => {
    const parts = fixture();
    parts.pullPage.consume.resolves({
      handledThrough   : token(),
      hasMore          : false,
      materializedCids : ['shared-cid'],
      quarantined      : 0,
    });
    const link = session(parts);

    await expect(link.cover('pull')).resolves.toBeUndefined();

    expect(parts.ledger.settleQuarantineForLogicalTarget.calledOnceWithExactly(
      'did:example:alice^projection',
      ['shared-cid'],
    )).toBe(true);
    await link.dispose();
  });

});
