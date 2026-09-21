import type { ProgressToken } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import type { SyncTarget } from '../src/sync-target-resolver.js';

import { SyncNextIncompleteError, SyncNextLinkSession } from '../src/sync-next/link-session.js';

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

function head(position = '2'): ProgressToken {
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
  deliveryRetry: { retry: sinon.SinonStub };
  ledger: {
    getDeliveryForLink: sinon.SinonStub;
    getQuarantineForLogicalTarget: sinon.SinonStub;
    settleQuarantineForLogicalTarget: sinon.SinonStub;
  };
  pullPage: { consume: sinon.SinonStub };
  pushPage: { consume: sinon.SinonStub };
  quarantineRetry: { retry: sinon.SinonStub };
  report: sinon.SinonStub;
} {
  return {
    deliveryRetry : { retry: sinon.stub().resolves({ kind: 'settled' }) },
    ledger        : {
      getDeliveryForLink               : sinon.stub().resolves(overrides.delivery ?? []),
      getQuarantineForLogicalTarget    : sinon.stub().resolves(overrides.quarantine ?? []),
      settleQuarantineForLogicalTarget : sinon.stub().resolves(),
    },
    pullPage: {
      consume: sinon.stub().resolves({
        capturedHead     : head(),
        handledThrough   : head(),
        hasMore          : false,
        materializedCids : [],
        quarantined      : 0,
      }),
    },
    pushPage: {
      consume: sinon.stub().resolves({
        capturedHead   : head(),
        delivered      : 0,
        handledThrough : head(),
        hasMore        : false,
        retained       : 0,
      }),
    },
    quarantineRetry : { retry: sinon.stub().resolves({ kind: 'settled' }) },
    report          : sinon.stub(),
  };
}

function session(parts: ReturnType<typeof fixture>): SyncNextLinkSession {
  return new SyncNextLinkSession(
    target(),
    parts.ledger as never,
    parts.pullPage as never,
    parts.pushPage as never,
    parts.quarantineRetry as never,
    parts.deliveryRetry as never,
    parts.report,
  );
}

describe('SyncNextLinkSession', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should release between covering pages and reuse one captured head', async () => {
    const clock = sinon.useFakeTimers();
    const parts = fixture();
    parts.pullPage.consume.onFirstCall().resolves({
      capturedHead     : head('5'),
      handledThrough   : head('1'),
      hasMore          : true,
      materializedCids : [],
      quarantined      : 0,
    });
    parts.pullPage.consume.onSecondCall().resolves({
      capturedHead     : head('5'),
      handledThrough   : head('5'),
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
    expect(parts.pullPage.consume.firstCall.args[1].head).toBeUndefined();
    expect(parts.pullPage.consume.secondCall.args[1].head).toEqual(head('5'));
    await link.dispose();
  });

  it('should stop a cancelled covering run before requesting its next page', async () => {
    const parts = fixture();
    let current = true;
    parts.pullPage.consume.callsFake(async () => {
      current = false;
      return {
        capturedHead     : head('5'),
        handledThrough   : head('1'),
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

  it('should service quarantine while fresh pull pages continue', async () => {
    const pending = { attempts: 1, messageCid: 'pending', source: head('1') };
    const parts = fixture({ quarantine: [pending] });
    parts.pullPage.consume.resolves({
      capturedHead     : head('100'),
      handledThrough   : head('1'),
      hasMore          : true,
      materializedCids : [],
      quarantined      : 0,
    });
    const link = session(parts);

    link.start();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(parts.pullPage.consume.called).toBe(true);
    expect(parts.quarantineRetry.retry.called).toBe(true);
    await link.dispose();
  });

  it('should reject a covering run that reaches head with unresolved obligations', async () => {
    const parts = fixture({ quarantine: [{ messageCid: 'pending' }] });
    const link = session(parts);

    await expect(link.cover('pull')).rejects.toBeInstanceOf(SyncNextIncompleteError);
    await link.dispose();
  });

  it('should give captured sparse obligations one finite retry before declaring incomplete', async () => {
    const pending = { attempts: 1, messageCid: 'pending', source: head('1') };
    const parts = fixture({ quarantine: [pending] });
    parts.ledger.getQuarantineForLogicalTarget.onFirstCall().resolves([pending]);
    parts.ledger.getQuarantineForLogicalTarget.onSecondCall().resolves([pending]);
    parts.ledger.getQuarantineForLogicalTarget.onThirdCall().resolves([]);
    const link = session(parts);

    await expect(link.cover('pull')).resolves.toBeUndefined();

    expect(parts.quarantineRetry.retry.calledOnce).toBe(true);
    await link.dispose();
  });

  it('should settle duplicate exact-source quarantine when another link materializes the CID', async () => {
    const parts = fixture();
    parts.pullPage.consume.resolves({
      capturedHead     : head(),
      handledThrough   : head(),
      hasMore          : false,
      materializedCids : ['shared-cid'],
      quarantined      : 0,
    });
    const link = session(parts);

    await expect(link.cover('pull')).resolves.toBeUndefined();

    expect(parts.ledger.settleQuarantineForLogicalTarget.calledOnceWithExactly(
      'did:example:alice^projection',
      'shared-cid',
    )).toBe(true);
    await link.dispose();
  });

  it('should not retry one poison quarantine row on every continuous feed page', async () => {
    const pending = { attempts: 1, messageCid: 'pending', source: head('1') };
    const parts = fixture({ quarantine: [pending] });
    parts.pullPage.consume.resolves({
      capturedHead     : head('100'),
      handledThrough   : head('1'),
      hasMore          : true,
      materializedCids : [],
      quarantined      : 0,
    });
    parts.quarantineRetry.retry.resolves({ kind: 'pending' });
    const link = session(parts);

    link.start();
    await new Promise(resolve => setTimeout(resolve, 25));

    expect(parts.pullPage.consume.callCount).toBeGreaterThan(1);
    expect(parts.quarantineRetry.retry.callCount).toBe(1);
    await link.dispose();
  });
});
