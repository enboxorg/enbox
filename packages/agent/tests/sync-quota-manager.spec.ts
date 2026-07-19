import type { SinonStub } from 'sinon';

import type { SyncMessageEntry } from '../src/sync-messages.js';
import type { SyncQuotaManagerOperations } from '../src/sync-quota-manager.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';
import type { SyncQuotaBlockState, SyncQuotaStore } from '../src/sync-quota-store.js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { SyncQuotaManager } from '../src/sync-quota-manager.js';

import { deferred } from './utils/deferred.js';

type SyncQuotaOperationStubs = {
  [Method in keyof SyncQuotaManagerOperations]: SinonStub;
};

type SyncQuotaManagerHarness = {
  manager: SyncQuotaManager;
  operations: SyncQuotaOperationStubs;
  store: MemoryQuotaStore;
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
        acknowledged : [],
        failed       : [{ cid: 'cid-1', detail: 'over quota', quotaBlocked: true }],
        succeeded    : [],
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
        acknowledged : [],
        failed       : [{ cid: 'cid-1', quotaBlocked: true }],
        succeeded    : [],
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
      return { acknowledged: [], failed: [{ cid: 'cid-1', quotaBlocked: true }], succeeded: [] };
    });

    const probing = manager.probeBlocksForTarget(target(), true);
    await transportStarted.promise;
    await manager.transitionPushResult(target(), { acknowledged: [], failed: [], succeeded: ['cid-1'] });
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
      return { acknowledged: [], failed: [], succeeded: ['cid-1'] };
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

  it('abandons a probe when the caller fence trips during the root-message lookup', async () => {
    const lookupStarted = deferred<void>();
    const releaseLookup = deferred<void>();
    const { manager, operations } = createHarness();
    let fenceTripped = false;
    operations.getLocalMessage.callsFake(async () => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return undefined;
    });
    await manager.recordBlock(target(), 'cid-1', undefined, 'over quota');

    const probing = manager.probeBlocksForTarget(target(), true, undefined, (): boolean => !fenceTripped);
    await lookupStarted.promise;
    fenceTripped = true;
    releaseLookup.resolve();
    await probing;

    expect(operations.pushMessages.called).toBe(false);
    expect(operations.pushEntries.called).toBe(false);
    expect(await manager.getState(target(), 'cid-1')).toBeDefined();
  });

  it('abandons a probe when the caller fence trips during the dependency lookup', async () => {
    const dependencyLookupStarted = deferred<void>();
    const releaseDependencyLookup = deferred<void>();
    const { manager, operations } = createHarness();
    let fenceTripped = false;
    operations.getLocalMessage.onFirstCall().resolves(messageEntry('root-cid'));
    operations.getLocalMessage.onSecondCall().callsFake(async () => {
      dependencyLookupStarted.resolve();
      await releaseDependencyLookup.promise;
      return messageEntry('dependency-cid');
    });
    await manager.recordBlock(target(), 'root-cid', undefined, 'over quota', 'feed', 'dependency-cid');

    const probing = manager.probeBlocksForTarget(target(), true, undefined, (): boolean => !fenceTripped);
    await dependencyLookupStarted.promise;
    fenceTripped = true;
    releaseDependencyLookup.resolve();
    await probing;

    expect(operations.getLocalMessage.calledTwice).toBe(true);
    expect(operations.pushMessages.called).toBe(false);
    expect(operations.pushEntries.called).toBe(false);
    expect(await manager.getState(target(), 'root-cid')).toBeDefined();
  });

  it('discards a probe result when the caller fence trips while transport is in flight', async () => {
    const transportStarted = deferred<void>();
    const releaseTransport = deferred<void>();
    const { manager, operations } = createHarness();
    let fenceTripped = false;
    operations.pushMessages.callsFake(async () => {
      transportStarted.resolve();
      await releaseTransport.promise;
      return { acknowledged: [], failed: [], succeeded: ['cid-1'] };
    });
    await manager.recordBlock(target(), 'cid-1', undefined, 'over quota');

    const probing = manager.probeBlocksForTarget(target(), true, undefined, (): boolean => !fenceTripped);
    await transportStarted.promise;
    fenceTripped = true;
    releaseTransport.resolve();
    await probing;

    expect(await manager.getState(target(), 'cid-1')).toBeDefined();
    expect(operations.clearFailedMessage.called).toBe(false);
    expect(operations.onQuotaCleared.called).toBe(false);
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

  it('uses the earliest feed probe and latest grant probe when folding a target schedule', async () => {
    const { manager, store } = createHarness();
    const states = await Promise.all([
      manager.recordBlock(target(), 'feed-early', undefined, undefined),
      manager.recordBlock(target(), 'feed-late', undefined, undefined),
      manager.recordBlock(target(), 'grant-early', undefined, undefined, 'permission-grant'),
      manager.recordBlock(target(), 'grant-late', undefined, undefined, 'permission-grant'),
    ]);
    const nextProbeAts = [
      '2026-01-01T00:04:00.000Z',
      '2026-01-01T00:10:00.000Z',
      '2026-01-01T00:01:00.000Z',
      '2026-01-01T00:07:00.000Z',
    ];
    await Promise.all(states.map((state, index) => store.put({
      ...state,
      nextProbeAt: nextProbeAts[index],
    })));

    expect(await manager.getNextProbeAtForTarget(target())).toBe('2026-01-01T00:04:00.000Z');
  });

  it('treats a feed reconciled to no quota rows as converged when inventories match', async () => {
    const { manager, operations } = createHarness();
    await manager.recordBlock(target(), 'retired-cid', undefined, undefined);
    operations.collectLocalFeedCids.resolves(new Set());
    operations.collectRemoteFeedCids.resolves(new Set());

    expect(await manager.isFeedDivergenceExplained(target(), {})).toBe(true);
    expect(await manager.getStatesForTarget(target())).toEqual([]);
    expect(operations.onQuotaCleared.calledOnceWith(target(), 'retired-cid', 'superseded')).toBe(true);
  });
});

function createHarness(): SyncQuotaManagerHarness {
  const operations = createOperations();
  const store = new MemoryQuotaStore();
  return {
    manager: new SyncQuotaManager({ operations, store }),
    operations,
    store,
  };
}

function createOperations(): SyncQuotaOperationStubs {
  return {
    clearFailedMessage    : sinon.stub().resolves(),
    collectLocalFeedCids  : sinon.stub().resolves(new Set<string>()),
    collectRemoteFeedCids : sinon.stub().resolves(new Set<string>()),
    getLocalMessage       : sinon.stub().resolves(undefined),
    onQuotaBlocked        : sinon.stub(),
    onQuotaCleared        : sinon.stub(),
    pushEntries           : sinon.stub().resolves({ acknowledged: [], failed: [], succeeded: [] }),
    pushMessages          : sinon.stub().resolves({ acknowledged: [], failed: [], succeeded: [] }),
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

function messageEntry(recordId: string): SyncMessageEntry {
  return {
    message: {
      descriptor: {
        interface        : 'Records',
        messageTimestamp : '2026-01-01T00:00:00.000Z',
        method           : 'Delete',
      },
      recordId,
    } as SyncMessageEntry['message'],
  };
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
