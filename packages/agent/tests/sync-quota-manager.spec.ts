import type { SinonStub } from 'sinon';

import type { SyncQuotaManagerOperations } from '../src/sync-quota-manager.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';
import type { SyncQuotaBlockState, SyncQuotaStore } from '../src/sync-quota-store.js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { SyncQuotaManager } from '../src/sync-quota-manager.js';

type SyncQuotaOperationStubs = {
  [Method in keyof SyncQuotaManagerOperations]: SinonStub;
};

type SyncQuotaManagerHarness = {
  manager: SyncQuotaManager;
  operations: SyncQuotaOperationStubs;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

describe('SyncQuotaManager', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('persists quota failures, advances backoff, and emits the folded transition', async () => {
    const clock = sinon.useFakeTimers({ now: Date.parse('2026-01-01T00:00:00.000Z') });
    const { manager, operations } = createHarness();

    try {
      const first = await manager.transitionPushResult(target(), {
        failed    : [{ cid: 'cid-1', detail: 'over quota', quotaBlocked: true }],
        succeeded : [],
      });

      expect(first).toEqual({
        nextQuotaProbeAt  : '2026-01-01T00:00:30.000Z',
        quotaBlocked      : true,
        retryableFailures : [],
        terminalFailures  : [],
      });
      expect(await manager.getState(target(), 'cid-1')).toMatchObject({
        attempts       : 1,
        firstBlockedAt : '2026-01-01T00:00:00.000Z',
        lastBlockedAt  : '2026-01-01T00:00:00.000Z',
        nextProbeAt    : '2026-01-01T00:00:30.000Z',
      });

      await clock.tickAsync(1_000);
      await manager.transitionPushResult(target(), {
        failed    : [{ cid: 'cid-1', quotaBlocked: true }],
        succeeded : [],
      });

      expect(await manager.getState(target(), 'cid-1')).toMatchObject({
        attempts       : 2,
        firstBlockedAt : '2026-01-01T00:00:00.000Z',
        lastBlockedAt  : '2026-01-01T00:00:01.000Z',
        nextProbeAt    : '2026-01-01T00:01:01.000Z',
      });
      expect(operations.onQuotaBlocked.calledTwice).toBe(true);
    } finally {
      clock.restore();
    }
  });

  it('gives acknowledgements precedence and partitions terminal from retryable failures', async () => {
    const { manager, operations } = createHarness();
    await manager.recordBlock(target(), 'blocked-cid', undefined, 'over quota');

    const transition = await manager.transitionPushResult(target(), {
      acknowledged : [{ cid: 'blocked-cid', resolution: 'superseded' }],
      failed       : [
        { cid: 'blocked-cid', quotaBlocked: true },
        { cid: 'terminal-cid', kind: 'Invalid', terminal: true },
        { cid: 'retry-cid', kind: 'Deferred' },
      ],
      succeeded: [],
    });

    expect(transition).toEqual({
      quotaBlocked      : false,
      retryableFailures : [{ cid: 'retry-cid', kind: 'Deferred' }],
      terminalFailures  : [{ cid: 'terminal-cid', kind: 'Invalid', terminal: true }],
    });
    expect(await manager.getActiveBlocksForTarget(target())).toEqual([]);
    expect(await manager.getStatesForTarget(target())).toEqual([
      { messageCid: 'blocked-cid', state: expect.objectContaining({ supersededAt: expect.any(String) }) },
    ]);
    expect(operations.clearFailedMessage.calledOnceWith(target(), 'blocked-cid')).toBe(true);
    expect(operations.recordTerminalFailure.calledOnce).toBe(true);
    expect(operations.onQuotaCleared.calledOnceWith(target(), 'blocked-cid', 'superseded')).toBe(true);
  });

  it('does not recreate a block when an acknowledgement wins an in-flight probe race', async () => {
    const transportStarted = deferred<void>();
    const releaseTransport = deferred<void>();
    const { manager, operations } = createHarness();
    await manager.recordBlock(target(), 'cid-1', undefined, 'over quota');
    operations.pushMessages.callsFake(async () => {
      transportStarted.resolve();
      await releaseTransport.promise;
      return { failed: [{ cid: 'cid-1', quotaBlocked: true }], succeeded: [] };
    });

    const probing = manager.probeBlocksForTarget(target(), true);
    await transportStarted.promise;
    await manager.transitionPushResult(target(), { failed: [], succeeded: ['cid-1'] });
    releaseTransport.resolve();
    await probing;

    expect(await manager.getState(target(), 'cid-1')).toBeUndefined();
    expect(operations.onQuotaBlocked.called).toBe(false);
    expect(operations.onQuotaCleared.calledOnceWith(target(), 'cid-1', 'applied')).toBe(true);
  });

  it('deduplicates concurrent probes and identity-safely removes the settled run', async () => {
    const transportStarted = deferred<void>();
    const releaseTransport = deferred<void>();
    const { manager, operations } = createHarness();
    await manager.recordBlock(target(), 'cid-1', undefined, 'over quota');
    operations.pushMessages.callsFake(async () => {
      transportStarted.resolve();
      await releaseTransport.promise;
      return { failed: [], succeeded: ['cid-1'] };
    });

    const first = manager.probeBlocksForTarget(target(), true);
    const second = manager.probeBlocksForTarget(target(), true);
    await transportStarted.promise;
    releaseTransport.resolve();
    await Promise.all([first, second]);

    expect(operations.pushMessages.calledOnce).toBe(true);
    expect((manager as unknown as { _probes: Map<string, Promise<void>> })._probes.size).toBe(0);
    expect(await manager.getState(target(), 'cid-1')).toBeUndefined();
  });

  it('rechecks topology generation before atomically pruning stale link rows', async () => {
    const { manager } = createHarness();
    const current = target();
    const stale = target({ authorizationEpoch: 'stale-epoch' });
    const otherTenant = target({ did: 'did:example:bob' });
    await Promise.all([
      manager.recordBlock(current, 'current-cid', undefined, undefined),
      manager.recordBlock(stale, 'stale-cid', undefined, undefined),
      manager.recordBlock(otherTenant, 'other-cid', undefined, undefined),
    ]);

    await manager.pruneForCurrentTargets([current], () => false);
    expect(await manager.getAllStates()).toHaveLength(3);

    await manager.pruneForCurrentTargets([current], () => true);

    expect((await manager.getAllStates()).map(({ messageCid }) => messageCid).sort()).toEqual([
      'current-cid',
      'other-cid',
    ]);
  });

  it('only explains exact local-only inventory differences represented by durable omissions', async () => {
    const { manager, operations } = createHarness();
    await manager.recordBlock(target(), 'blocked-cid', undefined, undefined);
    operations.collectLocalFeedCids.resolves(new Set(['blocked-cid']));
    operations.collectRemoteFeedCids.resolves(new Set());

    expect(await manager.isFeedDivergenceExplained(target(), {})).toBe(true);

    operations.collectRemoteFeedCids.resolves(new Set(['unexpected-remote-cid']));
    expect(await manager.isFeedDivergenceExplained(target(), {})).toBe(false);
  });
});

function createHarness(): SyncQuotaManagerHarness {
  const operations = createOperations();
  const store = new MemoryQuotaStore();
  return {
    manager: new SyncQuotaManager({ operations, store }),
    operations,
  };
}

function createOperations(): SyncQuotaOperationStubs {
  return {
    clearFailedMessage    : sinon.stub().resolves(),
    collectLocalFeedCids  : sinon.stub().resolves(new Set<string>()),
    collectRemoteFeedCids : sinon.stub().resolves(new Set<string>()),
    getGeneration         : sinon.stub().returns(0),
    getLocalMessage       : sinon.stub().resolves(undefined),
    onQuotaBlocked        : sinon.stub(),
    onQuotaCleared        : sinon.stub(),
    pushEntries           : sinon.stub().resolves({ failed: [], succeeded: [] }),
    pushMessages          : sinon.stub().resolves({ failed: [], succeeded: [] }),
    recordTerminalFailure : sinon.stub().resolves(),
  } satisfies SyncQuotaManagerOperations;
}

function target(overrides: Partial<SyncTarget> = {}): SyncTarget {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    did                : 'did:example:alice',
    dwnUrl             : 'https://dwn.example',
    projectionId       : 'projection',
    scope              : { kind: 'full' },
    ...overrides,
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

class MemoryQuotaStore implements SyncQuotaStore {
  private readonly _states = new Map<string, SyncQuotaBlockState>();

  public async clear(): Promise<void> {
    this._states.clear();
  }

  public async delete(tenantDid: string, linkKey: string, messageCid: string): Promise<boolean> {
    return this._states.delete(MemoryQuotaStore.key(tenantDid, linkKey, messageCid));
  }

  public async deleteMany(states: SyncQuotaBlockState[]): Promise<void> {
    for (const state of states) {
      await this.delete(state.tenantDid, state.linkKey, state.messageCid);
    }
  }

  public async deleteForTenant(tenantDid: string): Promise<void> {
    for (const state of await this.getAll()) {
      if (state.tenantDid === tenantDid) {
        await this.delete(state.tenantDid, state.linkKey, state.messageCid);
      }
    }
  }

  public async get(tenantDid: string, linkKey: string, messageCid: string): Promise<SyncQuotaBlockState | undefined> {
    const state = this._states.get(MemoryQuotaStore.key(tenantDid, linkKey, messageCid));
    return state === undefined ? undefined : structuredClone(state);
  }

  public async getAll(): Promise<SyncQuotaBlockState[]> {
    return [...this._states.values()].map((state) => structuredClone(state));
  }

  public async getForTenant(tenantDid: string): Promise<SyncQuotaBlockState[]> {
    return (await this.getAll()).filter((state) => state.tenantDid === tenantDid);
  }

  public async put(state: SyncQuotaBlockState): Promise<void> {
    this._states.set(
      MemoryQuotaStore.key(state.tenantDid, state.linkKey, state.messageCid),
      structuredClone(state),
    );
  }

  private static key(tenantDid: string, linkKey: string, messageCid: string): string {
    return `${tenantDid}|${linkKey}|${messageCid}`;
  }
}
