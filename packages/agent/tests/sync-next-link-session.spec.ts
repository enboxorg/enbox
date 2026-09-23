import type { ProgressToken } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import type { SyncTarget } from '../src/sync-target-resolver.js';

import { SyncNextLinkSession } from '../src/sync-next/link-session.js';
import { syncNextLogicalTargetId } from '../src/sync-next/ledger-key.js';

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
  endpoint: {
    block: sinon.SinonStub;
    clear: sinon.SinonStub;
    run: sinon.SinonStub;
  };
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
    endpoint: {
      block : sinon.stub(),
      clear : sinon.stub(),
      run   : sinon.stub().callsFake(async (operation) => operation()),
    },
    pullPage: {
      consume: sinon.stub().resolves({
        hasMore          : false,
        materializedCids : [],
        quarantined      : 0,
      }),
    },
    pushPage: {
      consume: sinon.stub().resolves({
        delivered : 0,
        hasMore   : false,
        retained  : 0,
      }),
      retryDelivery: sinon.stub().resolves({ kind: 'settled' }),
    },
    quarantine: {
      retryOne: sinon.stub().resolves(overrides.quarantine?.length
        ? { progressed: false, remaining: overrides.quarantine.length }
        : { progressed: false, remaining: 0 }),
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
    parts.endpoint,
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
      hasMore          : true,
      materializedCids : [],
      quarantined      : 0,
    });
    parts.pullPage.consume.onSecondCall().resolves({
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
        hasMore          : false,
        materializedCids : [],
        quarantined      : 0,
      };
    });
    parts.pullPage.consume.onSecondCall().resolves({
      hasMore          : false,
      materializedCids : [],
      quarantined      : 0,
    });
    const link = session(parts);
    const covering = link.cover('pull');
    await clock.tickAsync(0);

    link.request('pull');
    firstPage.resolve();
    await clock.tickAsync(1);
    await covering;

    expect(parts.pullPage.consume.callCount).toBe(2);
    await link.dispose();
  });

  it('should not become current before a drained page reaches the pushed wake cursor', async () => {
    const clock = sinon.useFakeTimers();
    const parts = fixture();
    parts.pullPage.consume.onFirstCall().resolves({
      handledThrough   : token('1'),
      hasMore          : false,
      materializedCids : [],
      quarantined      : 0,
    });
    parts.pullPage.consume.onSecondCall().resolves({
      handledThrough   : token('2'),
      hasMore          : false,
      materializedCids : [],
      quarantined      : 0,
    });
    const link = session(parts);

    link.request('pull', true, token('2'));
    link.request('pull', true, token('1'));
    await clock.tickAsync(0);
    expect(link.isPullCurrent).toBe(false);
    expect(parts.pullPage.consume.callCount).toBe(1);

    await clock.tickAsync(1_001);
    expect(parts.pullPage.consume.callCount).toBe(2);
    expect(link.isPullCurrent).toBe(true);
    await link.dispose();
  });

  it('should resolve a covering run after one drained watermark page', async () => {
    const parts = fixture();
    parts.pullPage.consume.resolves({
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
    parts.pullPage.consume.resolves({ aborted: true });
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
      lastAttemptAt : '2026-09-22T00:00:00.000Z',
      messageCid    : 'other-link-pending',
      outcome       : { blockScope: 'endpoint', reason: 'transport' },
      source        : token('1'),
    };
    const parts = fixture({ delivery: [block] });
    const link = session(parts);

    link.request('push');
    await clock.tickAsync(0);

    expect(parts.pushPage.consume.calledOnce).toBe(true);
    expect(parts.pushPage.consume.firstCall.args[1].endpointBlock).toEqual(block.outcome);
    await link.dispose();
  });

  it('should honor a persisted Retry-After before the first delivery retry', async () => {
    const clock = sinon.useFakeTimers({ now: Date.parse('2026-09-22T12:00:00.000Z') });
    const pending = {
      lastAttemptAt : '2026-09-22T12:00:00.000Z',
      messageCid    : 'rate-limited',
      outcome       : {
        blockScope : 'endpoint',
        reason     : 'transport',
        retryAt    : Date.parse('2026-09-22T12:01:00.000Z'),
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

  it('should retry the least recently attempted delivery first', async () => {
    const newer = {
      lastAttemptAt : '2026-09-22T12:00:00.000Z',
      messageCid    : 'newer',
      outcome       : { reason: 'transport' },
      source        : token('2'),
    };
    const older = { ...newer, lastAttemptAt: '2026-09-22T11:00:00.000Z', messageCid: 'older' };
    const parts = fixture({ delivery: [newer, older] });
    const link = session(parts);

    link.request('push');
    await new Promise(resolve => { setTimeout(resolve, 5); });

    expect(parts.pushPage.retryDelivery.firstCall.args[1]).toBe(older);
    await link.dispose();
  });

  it('should service quarantine while fresh pull pages continue', async () => {
    const pending = {
      lastAttemptAt : '2026-09-22T00:00:00.000Z',
      messageCid    : 'pending',
      source        : token('1'),
    };
    const parts = fixture({ quarantine: [pending] });
    parts.pullPage.consume.resolves({
      hasMore          : true,
      materializedCids : [],
      quarantined      : 1,
    });
    const link = session(parts);

    link.start();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(parts.pullPage.consume.called).toBe(true);
    expect(parts.quarantine.retryOne.called).toBe(true);
    expect(parts.quarantine.retryOne.firstCall.args[3]).toBe(true);
    await link.dispose();
  });

  it('should reject a covering run that observes drain with unresolved obligations', async () => {
    const parts = fixture({ quarantine: [{
      lastAttemptAt : '2026-09-22T00:00:00.000Z',
      messageCid    : 'pending',
    }] });
    const link = session(parts);

    await expect(link.cover('pull')).rejects.toThrow('unresolved obligations');
    await link.dispose();
  });

  it('should give retained sparse obligations one finite retry before declaring incomplete', async () => {
    const pending = {
      lastAttemptAt : '2026-09-22T00:00:00.000Z',
      messageCid    : 'pending',
      source        : token('1'),
    };
    const parts = fixture({ quarantine: [pending] });
    parts.quarantine.retryOne.resolves({ progressed: true, remaining: 0 });
    const link = session(parts);

    await expect(link.cover('pull')).resolves.toBeUndefined();

    expect(parts.quarantine.retryOne.calledOnce).toBe(true);
    expect(parts.quarantine.retryOne.firstCall.args[3]).toBe(false);
    await link.dispose();
  });

  it('should force one deferred quarantine retry after the feed drains', async () => {
    const parts = fixture({ quarantine: [{ messageCid: 'deferred', source: token('1') }] });
    parts.quarantine.retryOne.onFirstCall().resolves({ deferred: true, progressed: false, remaining: 1 });
    parts.quarantine.retryOne.onSecondCall().resolves({ progressed: true, remaining: 0 });
    const link = session(parts);

    await expect(link.cover('pull')).resolves.toBeUndefined();

    expect(parts.quarantine.retryOne.callCount).toBe(2);
    expect(parts.quarantine.retryOne.firstCall.args[3]).toBe(false);
    expect(parts.quarantine.retryOne.secondCall.args[3]).toBe(true);
    await link.dispose();
  });

  it('should not force deferred quarantine while feed pages still advance', async () => {
    const parts = fixture({ quarantine: [{ messageCid: 'deferred', source: token('1') }] });
    parts.pullPage.consume.onFirstCall().resolves({
      hasMore          : true,
      materializedCids : [],
      quarantined      : 0,
    });
    parts.quarantine.retryOne.onFirstCall().resolves({ deferred: true, progressed: false, remaining: 1 });
    parts.quarantine.retryOne.onSecondCall().resolves({ deferred: true, progressed: false, remaining: 1 });
    parts.quarantine.retryOne.onThirdCall().resolves({ progressed: false, remaining: 1 });
    const link = session(parts);

    await expect(link.cover('pull')).rejects.toThrow('unresolved obligations');

    expect(parts.quarantine.retryOne.getCalls().map(call => call.args[3])).toEqual([false, false, true]);
    await link.dispose();
  });

  it('should stop a covering sparse pass at the first unresolved receipt', async () => {
    const pending = [
      { lastAttemptAt: '2026-09-22T00:00:00.000Z', messageCid: 'pending-1', source: token('1') },
      { lastAttemptAt: '2026-09-22T00:00:00.000Z', messageCid: 'pending-2', source: token('2') },
    ];
    const parts = fixture({ quarantine: pending });
    parts.quarantine.retryOne.resolves({ progressed: false, remaining: 2 });
    const link = session(parts);

    await expect(link.cover('pull')).rejects.toThrow('unresolved obligations');

    expect(parts.quarantine.retryOne.calledOnce).toBe(true);
    await link.dispose();
  });

  it('should settle consecutive recoverable receipts in one bounded covering pass', async () => {
    const pending = [
      { lastAttemptAt: '2026-09-22T00:00:00.000Z', messageCid: 'pending-1', source: token('1') },
      { lastAttemptAt: '2026-09-22T00:00:00.000Z', messageCid: 'pending-2', source: token('2') },
    ];
    const parts = fixture({ quarantine: pending });
    parts.quarantine.retryOne.onFirstCall().resolves({ progressed: true, remaining: 1 });
    parts.quarantine.retryOne.onSecondCall().resolves({ progressed: true, remaining: 0 });
    const link = session(parts);

    await expect(link.cover('pull')).resolves.toBeUndefined();

    expect(parts.quarantine.retryOne.callCount).toBe(2);
    await link.dispose();
  });

  it('should settle consecutive recoverable deliveries in one bounded covering pass', async () => {
    const first = {
      lastAttemptAt : '2026-09-22T00:00:00.000Z',
      messageCid    : 'pending-1',
      outcome       : { reason: 'transport' },
      source        : token('1'),
    };
    const second = {
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
      hasMore          : false,
      materializedCids : ['shared-cid'],
      quarantined      : 0,
    });
    const link = session(parts);

    await expect(link.cover('pull')).resolves.toBeUndefined();

    expect(parts.ledger.settleQuarantineForLogicalTarget.calledOnceWithExactly(
      syncNextLogicalTargetId('did:example:alice', 'projection'),
      ['shared-cid'],
    )).toBe(true);
    await link.dispose();
  });

});
