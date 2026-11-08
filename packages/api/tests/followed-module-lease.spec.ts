import type { FollowedModuleScope, FollowedSyncSource, SyncEngine, SyncEvent, SyncEventListener } from '@enbox/agent';

import { FollowedModuleLease } from '../src/followed-module-lease.js';
import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';
import { ContextNotReadyError, ContextRetiredError } from '../src/context-errors.js';

const rootModule = 'https://example.com/notebook';
const consumerModule = 'https://example.com/realtime';
const rootScope: FollowedModuleScope = {
  contextPath : 'notebook/page',
  modulePaths : ['notebook/page', 'notebook/page/delta'],
  moduleRole  : 'notebook/page/editor',
};
const consumerScope: FollowedModuleScope = {
  contextPath : 'page',
  modulePaths : ['page/live', 'page/live/session'],
  moduleRole  : 'notebook:notebook/page/editor',
};
const sessions: AbortController[] = [];

function fixture(verified = false): {
  binding: FollowedModuleLease;
  capture: sinon.SinonStub;
  get: sinon.SinonStub;
  listeners: Set<SyncEventListener>;
  markPending: sinon.SinonStub;
  publish(affectedModules?: readonly string[]): void;
  pull: sinon.SinonStub;
  root: FollowedModuleLease;
  session: AbortController;
  source: FollowedSyncSource;
  state: { current?: FollowedSyncSource };
} {
  const source: FollowedSyncSource = {
    acceptanceId   : 'acceptance-one',
    actorDid       : 'did:example:member',
    contextId      : 'notebook-record/page-record',
    id             : 'role-one',
    modules        : { [rootModule]: rootScope, [consumerModule]: null },
    remoteEndpoint : 'https://owner.example',
    roles          : [rootScope.moduleRole],
    rootModule,
    sourceDid      : 'did:example:owner',
  };
  const state = { current: structuredClone(source) as FollowedSyncSource | undefined };
  if (verified) { state.current!.modules[consumerModule] = structuredClone(consumerScope); }
  const listeners = new Set<SyncEventListener>();
  const get = sinon.stub().callsFake(async (): Promise<FollowedSyncSource | undefined> => state.current);
  const capture = sinon.stub().resolves();
  const markPending = sinon.stub().resolves(true);
  const pull = sinon.stub().resolves(true);
  const session = new AbortController();
  sessions.push(session);
  const sync = {
    getFollowedSource             : get,
    markFollowedSourcePullPending : markPending,
    on                            : (listener: SyncEventListener): (() => void) => {
      listeners.add(listener);
      return (): void => { listeners.delete(listener); };
    },
    pullFollowedSource: pull,
  } as unknown as SyncEngine;
  const root = new FollowedModuleLease({ module: rootModule, signal: session.signal, source, sync });
  const binding = new FollowedModuleLease({ module: consumerModule, onCapture: capture, root, signal: session.signal, source, sync });
  const publish = (affectedModules?: readonly string[]): void => {
    const event: SyncEvent = {
      type                       : 'followed-context:change',
      actorDid                   : source.actorDid,
      affectedModules,
      contextId                  : source.contextId,
      followedSourceAcceptanceId : state.current?.acceptanceId ?? source.acceptanceId,
      followedSourceId           : state.current?.id,
      module                     : rootModule,
      tenantDid                  : source.sourceDid,
    };
    for (const listener of [...listeners]) { listener(event); }
  };
  return { binding, capture, get, listeners, markPending, publish, pull, root, session, source, state };
}

async function settled(predicate: () => boolean): Promise<void> {
  for (let pass = 0; pass < 100 && !predicate(); pass++) { await Promise.resolve(); }
  expect(predicate()).toBe(true);
}

describe('FollowedModuleLease', () => {
  afterEach(() => {
    for (const session of sessions.splice(0)) { session.abort(); }
  });

  it('keeps unavailable consumer operations inert and immediately not-ready while root reads remain usable', async () => {
    const test = fixture();
    expect(test.get.callCount).toBe(0);
    expect(test.listeners.size).toBe(0);
    await expect(test.binding.assertActive()).rejects.toBeInstanceOf(ContextNotReadyError);
    expect(test.capture.callCount).toBe(0);
    expect(test.binding.signal.aborted).toBe(false);
    await test.root.assertActive();
    expect(test.root.executionContext().moduleRole).toBe(rootScope.moduleRole);
  });

  it('uses the same lease for root records and role-less membership removal', async () => {
    const test = fixture();
    const records = test.root.executionContext();
    const membership = test.root.executionContext(false);
    await records.assertActive();
    await membership.assertActive();
    expect(records.moduleRole).toBe(rootScope.moduleRole);
    expect(records.followedSourceId).toBe(test.source.id);
    expect(membership.moduleRole).toBeUndefined();
    expect(membership.followedSourceId).toBeUndefined();
    expect(membership.tenantDid).toBe(test.source.sourceDid);
    expect(membership.remoteEndpoint).toBe(test.source.remoteEndpoint);
    expect(membership.contextId).toBe(test.source.contextId);
    test.state.current = undefined;
    await expect(membership.assertActive()).rejects.toBeInstanceOf(ContextRetiredError);
    expect(test.root.signal.aborted).toBe(true);
  });

  it('captures a consumer added after root acceptance using the current verified source', async () => {
    const test = fixture();
    const execution = test.binding.executionContext();
    expect(() => execution.moduleRole).toThrow(ContextNotReadyError);
    test.state.current!.modules[consumerModule] = consumerScope;
    await execution.assertActive();
    expect(test.capture.calledOnceWith(consumerScope, test.state.current)).toBe(true);
    expect(execution.moduleRole).toBe(consumerScope.moduleRole);
    expect(test.source.modules[consumerModule]).toBeNull();
    await execution.invalidateReplica!();
    expect(test.markPending.calledOnceWith(test.state.current, consumerModule)).toBe(true);
  });

  it('coalesces simultaneous consumer captures and fences a scope changed during verification', async () => {
    const test = fixture(true);
    let finish!: () => void;
    test.capture.returns(new Promise<void>(resolve => { finish = resolve; }));
    const first = test.binding.assertActive();
    const second = test.binding.assertActive();
    const completed = Promise.allSettled([first, second]);
    await settled(() => test.capture.called);
    expect(test.capture.callCount).toBe(1);
    test.state.current!.modules[consumerModule] = { ...consumerScope, modulePaths: ['page/live'] };
    finish();
    for (const outcome of await completed) {
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') { expect(outcome.reason).toBeInstanceOf(ContextRetiredError); }
    }
    await test.root.assertActive();
  });

  it.each([
    ['undefined', undefined], ['null', null], ['object', { kind: 'metadata-failure' }], ['string', 'metadata-failure'],
  ] as const)('preserves an exact %s metadata failure and permits a later retry', async (_label, reason) => {
    const test = fixture(true);
    test.capture.onFirstCall().callsFake(async (): Promise<void> => { throw reason; });
    const [outcome] = await Promise.allSettled([test.binding.assertActive()]);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') { expect(outcome.reason).toBe(reason); }
    expect(test.binding.signal.aborted).toBe(false);
    await test.binding.assertActive();
    expect(test.capture.callCount).toBe(2);
  });

  it('permanently retires a removed consumer even when the identical scope is restored before a read', async () => {
    const test = fixture(true);
    await test.binding.assertActive();
    test.state.current!.modules[consumerModule] = null;
    test.publish([consumerModule]);
    test.state.current!.modules[consumerModule] = consumerScope;
    test.publish([consumerModule]);
    await expect(test.binding.assertActive()).rejects.toBeInstanceOf(ContextRetiredError);
    await test.root.assertActive();
    expect(test.root.signal.aborted).toBe(false);
    expect(test.capture.callCount).toBe(1);
  });

  it('retires root and all consumer handles on a new acceptance of the same role record', async () => {
    const test = fixture(true);
    await test.binding.assertActive();
    test.state.current = { ...test.state.current!, acceptanceId: 'acceptance-two' };
    test.publish();
    expect(test.root.signal.aborted).toBe(true);
    expect(test.binding.signal.aborted).toBe(true);
    expect(test.listeners.size).toBe(0);
    await expect(test.root.assertActive()).rejects.toBeInstanceOf(ContextRetiredError);
  });

  it('detects silent root disappearance without waiting for a sync notification', async () => {
    const test = fixture(true);
    await test.binding.assertActive();
    test.state.current = undefined;
    await expect(test.binding.assertActive()).rejects.toBeInstanceOf(ContextRetiredError);
    expect(test.root.signal.aborted).toBe(true);
    expect(test.listeners.size).toBe(0);
  });

  it('keeps an admitted lease retryable after a transient source-store failure', async () => {
    const test = fixture(true);
    await test.binding.assertActive();
    const failure = new Error('store temporarily unavailable');
    test.get.onCall(test.get.callCount).rejects(failure);
    await expect(test.binding.assertActive()).rejects.toBe(failure);
    expect(test.root.signal.aborted).toBe(false);
    expect(test.binding.signal.aborted).toBe(false);
    await test.binding.assertActive();
  });

  it.each([rootModule, consumerModule])('refreshes and invalidates the exact selected module %s', async module => {
    const test = fixture(true);
    const lease = module === rootModule ? test.root : test.binding;
    await lease.refresh();
    await lease.executionContext().invalidateReplica!();
    expect(test.pull.calledOnceWith(test.state.current, module)).toBe(true);
    expect(test.markPending.calledOnceWith(test.state.current, module)).toBe(true);
    test.pull.resolves(false);
    await expect(lease.refresh()).rejects.toBeInstanceOf(ContextNotReadyError);
    expect(lease.signal.aborted).toBe(false);
  });

  it('checks authority again after a refresh fails', async () => {
    const test = fixture(true);
    test.pull.callsFake(async (): Promise<boolean> => {
      test.state.current = undefined;
      throw new Error('late transport error');
    });
    await expect(test.binding.refresh()).rejects.toBeInstanceOf(ContextRetiredError);
  });

  it('ends a stalled source lookup promptly with its session and never captures late evidence', async () => {
    const test = fixture(true);
    let finish!: (source: FollowedSyncSource) => void;
    test.get.returns(new Promise<FollowedSyncSource>(resolve => { finish = resolve; }));
    const reading = test.binding.assertActive();
    await settled(() => test.get.called);
    const reason = { kind: 'session-ended' };
    test.session.abort(reason);
    await expect(reading).rejects.toBe(reason);
    expect(test.listeners.size).toBe(0);
    finish(test.state.current!);
    await Promise.resolve();
    expect(test.capture.callCount).toBe(0);
  });

  it('ends a stalled metadata capture promptly with its session and discards late verification', async () => {
    const test = fixture(true);
    let finish!: () => void;
    test.capture.returns(new Promise<void>(resolve => { finish = resolve; }));
    let outcome: PromiseSettledResult<void> | undefined;
    const reading = test.binding.assertActive();
    void Promise.allSettled([reading]).then(([result]): void => { outcome = result; });
    await settled(() => test.capture.called);
    const reason = new Error('session ended during metadata verification');
    test.session.abort(reason);
    for (let pass = 0; pass < 100 && outcome === undefined; pass++) { await Promise.resolve(); }
    // Release the provider even on failure so the regression cannot hang the suite.
    const cancelledPromptly = outcome !== undefined;
    finish();
    await Promise.allSettled([reading]);
    expect(cancelledPromptly).toBe(true);
    expect(outcome?.status).toBe('rejected');
    if (outcome?.status === 'rejected') { expect(outcome.reason).toBe(reason); }
    expect(test.listeners.size).toBe(0);
    expect(() => test.binding.executionContext().moduleRole).toThrow(ContextNotReadyError);
  });

  it('releases authority watches at session end, independently of transport views', async () => {
    const test = fixture(true);
    await test.root.assertActive();
    await test.binding.assertActive();
    expect(test.listeners.size).toBe(2);
    test.session.abort();
    expect(test.listeners.size).toBe(0);
    expect(test.root.signal.aborted).toBe(true);
    expect(test.binding.signal.aborted).toBe(true);
  });
});
