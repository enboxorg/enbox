import type { ContextFollowIntent } from '../src/shared-context-protocol.js';
import type { ContextFollowingOptions, ContextFollowRecord } from '../src/context-following.js';
import type { ExpandableRecordView, RecordViewState } from '../src/record-view.js';
import type { FollowedSyncSource, FollowedSyncSourceInput } from '@enbox/agent';

import { ContextFollowing } from '../src/context-following.js';
import { ContextRetiredError } from '../src/context-errors.js';
import { followedSyncSourceActiveEqual } from '@enbox/agent';
import sinon from 'sinon';
import { Time } from '@enbox/dwn-sdk-js';
import { describe, expect, it } from 'bun:test';

const actorDid = 'did:example:member';
const ownerDid = 'did:example:owner';
const protocol = 'https://example.com/notes';
const roles: readonly [string, ...string[]] = ['page/editor', 'page/viewer'];

function decision(index: number, value: Partial<ContextFollowIntent> = {}): ContextFollowRecord {
  return {
    id        : `intent-${index}`,
    timestamp : `2026-01-01T00:00:00.${String(index).padStart(6, '0')}Z`,
    value     : { contextId: 'page-1', following: true, group: 'default', ownerDid, ...value },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done): void => { resolve = done; });
  return { promise, resolve };
}

async function settled(predicate: () => boolean): Promise<void> {
  for (let pass = 0; pass < 100 && !predicate(); pass++) { await Promise.resolve(); }
  expect(predicate()).toBe(true);
}

class IntentView implements ExpandableRecordView<ContextFollowRecord> {
  public closed = false;
  public next?: readonly ContextFollowRecord[];
  public readonly listeners = new Set<(state: RecordViewState<ContextFollowRecord>) => void>();
  private _state: RecordViewState<ContextFollowRecord>;

  public constructor(records: readonly ContextFollowRecord[] = [], hasMore = false) {
    this._state = { current: true, hasMore, records, status: 'ready' };
  }

  public getSnapshot = (): RecordViewState<ContextFollowRecord> => this._state;
  public subscribe = (listener: (state: RecordViewState<ContextFollowRecord>) => void): (() => void) => {
    this.listeners.add(listener);
    return (): void => { this.listeners.delete(listener); };
  };

  public async ready(): Promise<Extract<RecordViewState<ContextFollowRecord>, { status: 'ready' }>> {
    if (this._state.status === 'error') { throw this._state.error; }
    if (this._state.status !== 'ready') { throw new Error('View is unavailable.'); }
    return this._state;
  }

  public async refresh(): Promise<Extract<RecordViewState<ContextFollowRecord>, { status: 'ready' }>> {
    return this.ready();
  }

  public async loadMore(): Promise<void> {
    this.publish(this.next ?? this._state.records);
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
  }

  public publish(records: readonly ContextFollowRecord[], hasMore = false): void {
    this._state = { current: true, hasMore, records, status: 'ready' };
    for (const listener of this.listeners) { listener(this._state); }
  }

  public fail(error: Error): void {
    this._state = { ...this._state, current: false, error, status: 'error' };
    for (const listener of this.listeners) { listener(this._state); }
  }
}

function fixture(initial: ContextFollowRecord[] = []): {
  append: sinon.SinonSpy<[ContextFollowIntent, string?], Promise<ContextFollowRecord>>;
  coordinator: ContextFollowing;
  entries: ContextFollowRecord[];
  follow: sinon.SinonStub<[FollowedSyncSourceInput], Promise<FollowedSyncSource>>;
  openView: sinon.SinonStub<[AbortSignal], Promise<ExpandableRecordView<ContextFollowRecord>>>;
  options: ContextFollowingOptions;
  sources: Map<string, FollowedSyncSource>;
} {
  const entries = [...initial];
  const sources = new Map<string, FollowedSyncSource>();
  let acceptance = 0;
  const follow = sinon.stub<[FollowedSyncSourceInput], Promise<FollowedSyncSource>>().callsFake(async (input): Promise<FollowedSyncSource> => {
    const existing = [...sources.values()].find((source): boolean => source.contextId === input.contextId);
    if (existing !== undefined) { return existing; }
    const source: FollowedSyncSource = {
      ...input,
      acceptanceId   : `accepted-${++acceptance}`,
      id             : `role-${input.contextId}`,
      protocolPaths  : ['page'],
      protocolRole   : input.roles[0],
      remoteEndpoint : 'https://owner.example',
    };
    sources.set(source.id, source);
    return source;
  });
  const append = sinon.spy(async (value: ContextFollowIntent, after?: string): Promise<ContextFollowRecord> => {
    const row = { ...decision(entries.length + 1, value), ...(after === undefined ? {} : { timestamp: Time.createTimestampAfter(after) }) };
    entries.push(row);
    return row;
  });
  const openView = sinon.stub<[AbortSignal], Promise<ExpandableRecordView<ContextFollowRecord>>>()
    .callsFake(async (): Promise<ExpandableRecordView<ContextFollowRecord>> => new IntentView(entries));
  const options: ContextFollowingOptions = {
    actorDid,
    append,
    openView,
    protocol,
    read       : async (): Promise<readonly ContextFollowRecord[]> => [...entries],
    roleGroups : { default: roles },
    sync       : {
      deleteFollowedSource: async (source): Promise<void> => {
        const current = sources.get(source.id);
        if (current !== undefined && followedSyncSourceActiveEqual(current, source)) { sources.delete(source.id); }
      },
      followSource        : follow,
      getFollowedSource   : async (id): Promise<FollowedSyncSource | undefined> => sources.get(id),
      listFollowedSources : async (): Promise<FollowedSyncSource[]> => [...sources.values()],
    },
  };
  return { append, coordinator: new ContextFollowing(options), entries, follow, openView, options, sources };
}

describe('ContextFollowing', () => {
  const request = { group: 'default', id: 'page-1', ownerDid };

  it('persists verified intent once and restores it on a fresh device', async () => {
    const first = fixture();
    const source = await first.coordinator.follow(request);
    expect(first.entries[0]?.value).toEqual({ contextId: 'page-1', following: true, group: 'default', ownerDid });
    expect(await first.coordinator.follow(request)).toBe(source);
    expect(first.append.callCount).toBe(1);
    expect(first.follow.callCount).toBe(2);
    const fresh = fixture(first.entries);
    await fresh.coordinator.restore();
    expect(fresh.sources.size).toBe(1);
    expect(fresh.append.callCount).toBe(0);
    expect(first.openView.callCount + fresh.openView.callCount).toBe(0);
  });

  it.each(['new', 'existing', 'retired facade'] as const)('limits rollback after failed persistence (%s)', async (state) => {
    const test = fixture();
    const lifetime = new AbortController();
    test.options.signal = lifetime.signal;
    if (state === 'existing') {
      await test.follow({ actorDid, contextId: request.id, protocol, roles: [...roles], sourceDid: ownerDid });
    }
    const failure = new Error('write denied');
    test.options.append = async (): Promise<ContextFollowRecord> => {
      if (state === 'retired facade') { lifetime.abort(); }
      throw failure;
    };
    await expect(test.coordinator.follow(request)).rejects.toBe(failure);
    const accepted = await test.follow.firstCall.returnValue;
    expect([...test.sources.values()]).toEqual(state === 'new' ? [] : [accepted]);
    expect(test.entries).toHaveLength(0);
  });

  it('preserves both errors when saving and retiring a new acceptance fail', async () => {
    const test = fixture();
    const writeFailure = new Error('write denied');
    const retirementFailure = new Error('source store unavailable');
    test.options.append = async (): Promise<ContextFollowRecord> => { throw writeFailure; };
    test.options.sync.deleteFollowedSource = async (): Promise<void> => { throw retirementFailure; };
    await expect(test.coordinator.follow(request)).rejects.toMatchObject({
      name   : 'AggregateError',
      errors : [writeFailure, retirementFailure],
    });
    expect(test.sources.size).toBe(1);
    expect(test.entries).toHaveLength(0);
  });

  it.each(['before', 'after'] as const)('handles a registry read failure %s successful intent persistence', async (phase) => {
    const test = fixture();
    const failure = new Error('journal unavailable');
    test.options.read = async (): Promise<readonly ContextFollowRecord[]> => {
      if (test.follow.called && (phase === 'before' || test.append.called)) { throw failure; }
      return [...test.entries];
    };
    await expect(test.coordinator.follow(request)).rejects.toBe(failure);
    expect(test.sources.size).toBe(phase === 'before' ? 0 : 1);
    expect(test.entries).toHaveLength(phase === 'before' ? 0 : 1);
    if (phase === 'after') { expect(test.entries[0]?.value.following).toBe(true); }
  });

  it('supplies the known winning timestamp when superseding a future-dated forget', async () => {
    const previous = { ...decision(1, { following: false }), timestamp: '2099-01-01T00:00:00.000000Z' };
    const test = fixture([previous]);
    await test.coordinator.follow(request);
    expect(test.append.firstCall.args[1]).toBe(previous.timestamp);
    expect(test.entries.at(-1)!.timestamp > previous.timestamp).toBe(true);
    expect(test.entries.at(-1)?.value.following).toBe(true);
  });

  it('preserves offline intent and never treats omitted records as a forget', async () => {
    const test = fixture([decision(1)]);
    test.follow.onFirstCall().rejects(new Error('owner offline'));
    await test.coordinator.restore();
    expect(test.entries).toHaveLength(1);
    expect(test.sources.size).toBe(0);
    await test.coordinator.restore();
    test.entries.length = 0;
    await test.coordinator.restore();
    expect(test.sources.size).toBe(1);
    expect(test.append.callCount).toBe(0);
  });

  it('applies the newest explicit forget and fences stale member handles', async () => {
    const test = fixture();
    const first = await test.coordinator.follow(request);
    await test.coordinator.forget(first);
    expect(test.entries.at(-1)?.value.following).toBe(false);
    expect(test.sources.size).toBe(0);
    const next = await test.coordinator.follow(request);
    const writes = test.append.callCount;
    await test.coordinator.forget(first);
    expect(test.append.callCount).toBe(writes);
    expect(test.sources.get(next.id)).toBe(next);
    const timestamp = Time.createTimestampAfter(test.entries.at(-1)!.timestamp);
    test.entries.push({ ...decision(99), id: 'a', timestamp }, { ...decision(99, { following: false }), id: 'z', timestamp });
    await test.coordinator.restore();
    expect(test.sources.size).toBe(0);
  });

  it('keeps failed leave intent and records successful leave even after its role event retires the source', async () => {
    const test = fixture();
    const source = await test.coordinator.follow(request);
    const failure = new Error('role delete denied');
    await expect(test.coordinator.forget(source, async (): Promise<void> => { throw failure; })).rejects.toBe(failure);
    expect(test.entries).toHaveLength(1);
    await test.coordinator.forget(source, async (): Promise<void> => { test.sources.delete(source.id); });
    expect(test.entries.at(-1)?.value.following).toBe(false);
  });

  it('rechecks the exact acceptance before writing forget after an asynchronous read', async () => {
    const test = fixture();
    const source = await test.coordinator.follow(request);
    test.options.read = async (): Promise<readonly ContextFollowRecord[]> => {
      test.sources.set(source.id, { ...source, acceptanceId: 'new-acceptance' });
      return test.entries;
    };
    await test.coordinator.forget(source);
    expect(test.append.callCount).toBe(1);
    expect(test.sources.get(source.id)?.acceptanceId).toBe('new-acceptance');
  });

  it.each(['follow', 'forget'] as const)('honors a newer %s received during leave without appending another decision', async (choice) => {
    const test = fixture();
    const source = await test.coordinator.follow(request);
    await test.coordinator.forget(source, async (): Promise<void> => {
      test.entries.push({
        ...decision(99, { following: choice === 'follow' }),
        timestamp: Time.createTimestampAfter(test.entries.at(-1)!.timestamp),
      });
    });
    expect(test.append.callCount).toBe(1);
    expect(test.sources.size).toBe(choice === 'follow' ? 1 : 0);
    expect(test.entries.at(-1)?.value.following).toBe(choice === 'follow');
  });

  it('retires a role replacement that arrives while explicit forget is persisted', async () => {
    const test = fixture();
    const source = await test.coordinator.follow(request);
    const append = test.options.append;
    test.options.append = async (intent, after): Promise<ContextFollowRecord> => {
      test.sources.delete(source.id);
      test.sources.set('role-replacement', { ...source, id: 'role-replacement', protocolRole: 'page/viewer' });
      return append(intent, after);
    };
    await test.coordinator.forget(source);
    expect(test.entries.at(-1)?.value.following).toBe(false);
    expect(test.sources.size).toBe(0);
  });

  it.each(['forgotten', 'forgotten again', 'followed again'] as const)('rechecks a source rotated during exact deletion when intent is %s', async (intent) => {
    const test = fixture();
    const source = await test.coordinator.follow(request);
    const replacement = { ...source, id: 'new-role', protocolRole: 'page/viewer' };
    const remove = test.options.sync.deleteFollowedSource;
    let deletions = 0;
    test.options.sync.deleteFollowedSource = async (expected): Promise<void> => {
      if (deletions++ === 0) {
        test.sources.delete(source.id);
        test.sources.set(replacement.id, replacement);
        if (intent !== 'forgotten') {
          test.entries.push({
            ...decision(99, { following: intent === 'followed again' }),
            timestamp: Time.createTimestampAfter(test.entries.at(-1)!.timestamp),
          });
        }
      }
      await remove(expected);
    };
    await test.coordinator.forget(source);
    expect(deletions).toBe(intent === 'followed again' ? 1 : 2);
    expect(test.sources.get(replacement.id)).toBe(intent === 'followed again' ? replacement : undefined);
  });

  it.each(['forgotten', 'same group', 'different group'] as const)('checks a late restoration when newer intent is %s', async (change) => {
    const test = fixture([decision(1)]);
    test.options.roleGroups = { default: roles, viewers: ['page/viewer'] };
    const wait = deferred<void>();
    test.follow.callsFake(async (input): Promise<FollowedSyncSource> => {
      await wait.promise;
      const source: FollowedSyncSource = {
        ...input, acceptanceId   : 'late', id             : 'role-page-1', protocolPaths  : ['page'],
        protocolRole   : roles[0], remoteEndpoint : 'https://owner.example',
      };
      test.sources.set(source.id, source);
      return source;
    });
    const restoring = test.coordinator.restore();
    await settled((): boolean => test.follow.calledOnce);
    test.entries.push(decision(2, {
      following : change !== 'forgotten',
      group     : change === 'different group' ? 'viewers' : 'default',
    }));
    wait.resolve();
    await restoring;
    expect(test.sources.size).toBe(change === 'same group' ? 1 : 0);
    expect(test.append.callCount).toBe(0);
  });

  it('does not overwrite a newer forget while an explicit follow is verifying', async () => {
    const test = fixture();
    const wait = deferred<FollowedSyncSource>();
    test.follow.callsFake(async (): Promise<FollowedSyncSource> => {
      const source = await wait.promise;
      test.sources.set(source.id, source);
      return source;
    });
    const opening = test.coordinator.follow(request);
    await settled((): boolean => test.follow.calledOnce);
    test.entries.push(decision(1, { following: false }));
    wait.resolve({
      acceptanceId   : 'late', actorDid, contextId      : 'page-1', id             : 'role-page-1', protocol,
      protocolPaths  : ['page'], protocolRole   : roles[0], remoteEndpoint : 'https://owner.example', roles          : [...roles], sourceDid      : ownerDid,
    });
    await expect(opening).rejects.toBeInstanceOf(ContextRetiredError);
    expect(test.sources.size).toBe(0);
    expect(test.append.callCount).toBe(0);
  });

  it('shares the journal observer, drains all pages, and releases it with the last lease', async () => {
    const test = fixture([decision(1), decision(2, { following: false })]);
    const view = new IntentView([test.entries[0]!], true);
    view.next = test.entries;
    test.openView.resolves(view);
    const error = sinon.spy();
    const first = await test.coordinator.observe(error);
    const second = await test.coordinator.observe(error);
    await settled((): boolean => !view.getSnapshot().hasMore);
    expect(test.follow.callCount).toBe(0);
    await first.close();
    expect(view.closed).toBe(false);
    await second.close();
    expect(view.closed).toBe(true);
    expect(view.listeners.size).toBe(0);
    expect(test.openView.callCount).toBe(1);
    expect(error.called).toBe(false);
  });

  it('defers retry wakes during journal opening until the initial view is available', async () => {
    const test = fixture([decision(1)]);
    const pending = deferred<ExpandableRecordView<ContextFollowRecord>>();
    test.openView.returns(pending.promise);
    const error = sinon.spy();
    const opening = test.coordinator.observe(error);
    test.coordinator.retry();
    await settled((): boolean => test.openView.calledOnce);
    expect(error.called).toBe(false);
    expect(test.follow.called).toBe(false);
    pending.resolve(new IntentView(test.entries));
    const lease = await opening;
    await settled((): boolean => test.sources.size === 1);
    expect(error.called).toBe(false);
    await lease.close();
  });

  it('retains a retry requested while journal readiness is pending even when that read fails', async () => {
    const test = fixture([decision(1)]);
    const view = new IntentView(test.entries);
    const read = view.ready.bind(view);
    const ready = sinon.stub(view, 'ready').callsFake(read);
    const pending = deferred<void>();
    const failure = new Error('journal read interrupted');
    ready.onFirstCall().callsFake(async (): ReturnType<IntentView['ready']> => {
      await pending.promise;
      throw failure;
    });
    test.openView.resolves(view);
    const error = sinon.spy();
    const lease = await test.coordinator.observe(error);
    try {
      await settled((): boolean => ready.calledOnce);
      test.coordinator.retry();
      pending.resolve();
      await settled((): boolean => test.sources.size === 1);
      expect(test.follow.calledOnce).toBe(true);
      expect(error.calledOnceWithExactly(failure)).toBe(true);
    } finally {
      pending.resolve();
      await lease.close();
    }
  });

  it('does not wait for an unavailable owner when opening an observation and retries on reacquisition', async () => {
    const test = fixture([decision(1)]);
    const wait = deferred<void>();
    test.follow.callsFake(async (): Promise<FollowedSyncSource> => {
      await wait.promise;
      throw new Error('owner unavailable');
    });
    const error = sinon.spy();
    const lease = await test.coordinator.observe(error);
    await settled((): boolean => test.follow.calledOnce);
    await lease.close();
    const view = await test.openView.firstCall.returnValue;
    expect((view as IntentView).closed).toBe(true);
    wait.resolve();
    const next = await test.coordinator.observe(error);
    await settled((): boolean => test.follow.callCount === 2);
    await next.close();
    expect(error.called).toBe(false);
  });

  it('retries unavailable authority on a sync recovery wake without rewriting intent', async () => {
    const test = fixture([decision(1)]);
    test.follow.onFirstCall().rejects(new Error('owner unavailable'));
    const lease = await test.coordinator.observe((): void => {});
    await settled((): boolean => test.follow.callCount === 1);
    test.coordinator.retry();
    await settled((): boolean => test.sources.size === 1);
    expect(test.follow.callCount).toBe(2);
    expect(test.append.callCount).toBe(0);
    await lease.close();
    test.coordinator.retry();
    expect(test.openView.callCount).toBe(1);
  });

  it('coalesces retry wakes behind an active lookup so a queued forget is not delayed by duplicate lookups', async () => {
    const test = fixture([decision(1)]);
    test.options.roleGroups = { default: roles, viewers: ['page/viewer'] };
    const source = await test.coordinator.follow(request);
    test.follow.resetHistory();
    test.entries.push(decision(2, { group: 'viewers' }));
    const wait = deferred<void>();
    test.follow.callsFake(async (): Promise<FollowedSyncSource> => {
      await wait.promise;
      throw new Error('owner unavailable');
    });
    const error = sinon.spy();
    const lease = await test.coordinator.observe(error);
    try {
      await settled((): boolean => test.follow.calledOnce);
      for (let wake = 0; wake < 3; wake++) {
        test.coordinator.retry();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const forgetting = test.coordinator.forget(source);
      wait.resolve();
      await forgetting;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(test.follow.callCount).toBe(1);
      expect(test.sources.size).toBe(0);
      expect(test.entries.at(-1)?.value.following).toBe(false);
      expect(error.called).toBe(false);
    } finally {
      wait.resolve();
      await lease.close();
    }
  });

  it('closes a late native view after caller abort and reports registry errors separately', async () => {
    const test = fixture();
    const abort = new AbortController();
    const pending = deferred<ExpandableRecordView<ContextFollowRecord>>();
    test.openView.returns(pending.promise);
    const error = sinon.spy();
    const opening = test.coordinator.observe(error, abort.signal);
    abort.abort(new Error('gone'));
    const view = new IntentView();
    pending.resolve(view);
    await expect(opening).rejects.toThrow('gone');
    expect(view.closed).toBe(true);
    const live = new IntentView();
    test.openView.resolves(live);
    const lease = await test.coordinator.observe(error);
    const failure = new Error('registry unavailable');
    live.fail(failure);
    await settled((): boolean => error.called);
    expect(error.firstCall.args[0]).toBe(failure);
    await lease.close();
  });
});
