import type { FollowedSyncProjection, FollowedSyncSource, SyncEngine, SyncEvent, SyncEventListener } from '@enbox/agent';

import { FollowedContextProjection } from '../src/followed-context-projection.js';
import sinon from 'sinon';
import { ContextNotReadyError, ContextRetiredError } from '../src/context-errors.js';
import { describe, expect, it } from 'bun:test';

const rootModule = 'https://example.com/notebook';
const consumerModule = 'https://example.com/realtime';
const projection: FollowedSyncProjection = {
  attachmentPath : 'page',
  module         : consumerModule,
  modulePaths    : ['page/live', 'page/live/session'],
  moduleRole     : 'notebook:notebook/page/editor',
};

function source(): FollowedSyncSource {
  return {
    acceptanceId   : 'acceptance-one', actorDid       : 'did:example:member', contextId      : 'notebook/page',
    id             : 'role-one', module         : rootModule, modulePaths    : ['notebook/page', 'notebook/page/delta'],
    moduleRole     : 'notebook/page/editor', remoteEndpoint : 'https://owner.example',
    roles          : ['notebook/page/editor'], sourceDid      : 'did:example:owner',
  };
}

function fixture(verified = false, options: { beforeRead?(): void } = {}): {
  binding: FollowedContextProjection;
  capture: sinon.SinonSpy;
  ensure: sinon.SinonStub;
  get: sinon.SinonSpy;
  listeners: Set<SyncEventListener>;
  markPending: sinon.SinonSpy;
  publish(): void;
  root: FollowedSyncSource;
  session: AbortController;
  state: { current?: FollowedSyncSource };
} {
  const root = source();
  const state = { current: { ...root, ...(verified ? { projections: [projection] } : {}) } as FollowedSyncSource | undefined };
  const listeners = new Set<SyncEventListener>();
  const get = sinon.spy(async (): Promise<FollowedSyncSource | undefined> => {
    options.beforeRead?.();
    return state.current;
  });
  const ensure = sinon.stub().callsFake(async (): Promise<FollowedSyncSource> => state.current!);
  const session = new AbortController();
  const capture = sinon.spy();
  const markPending = sinon.spy(async (): Promise<boolean> => true);
  const sync = {
    ensureFollowedSourceModules   : ensure,
    getFollowedSource             : get,
    markFollowedSourcePullPending : markPending,
    on                            : (listener: SyncEventListener): (() => void) => {
      listeners.add(listener);
      return (): void => { listeners.delete(listener); };
    },
  } as unknown as SyncEngine;
  const binding = new FollowedContextProjection({ module: consumerModule, onCapture: capture, signal: session.signal, source: root, sync });
  const publish = (): void => {
    const event: SyncEvent = {
      type                       : 'followed-context:change', actorDid                   : root.actorDid, contextId                  : root.contextId,
      followedSourceAcceptanceId : state.current?.acceptanceId ?? root.acceptanceId,
      followedSourceId           : state.current?.id, module                     : root.module, tenantDid                  : root.sourceDid,
    };
    for (const listener of listeners) { listener(event); }
  };
  return { binding, capture, ensure, get, listeners, markPending, publish, root, session, state };
}

async function settled(predicate: () => boolean): Promise<void> {
  for (let pass = 0; pass < 100 && !predicate(); pass++) { await Promise.resolve(); }
  expect(predicate()).toBe(true);
}

describe('FollowedContextProjection', () => {
  it('is inert until an operation requests verified consumer access', async () => {
    const test = fixture();
    expect(test.get.callCount).toBe(0);
    expect(test.ensure.callCount).toBe(0);
    expect(test.listeners.size).toBe(0);
    await expect(test.binding.assertActive()).rejects.toBeInstanceOf(ContextNotReadyError);
    expect(test.ensure.calledOnceWith(test.root, [consumerModule])).toBe(true);
    expect(test.binding.signal.aborted).toBe(false);
    expect(test.session.signal.aborted).toBe(false);
    test.session.abort();
  });

  it('reads the captured role lazily even when execution context was requested before verification', async () => {
    const test = fixture(true);
    const execution = test.binding.executionContext;
    expect(test.get.callCount).toBe(0);
    expect(() => execution.moduleRole).toThrow(ContextNotReadyError);
    await execution.assertActive();
    expect(execution.moduleRole).toBe(projection.moduleRole);
    test.session.abort();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['object', { kind: 'provider-failure' }],
    ['string', 'provider-failure'],
  ] as const)('preserves an exact %s preparation failure instead of reporting readiness', async (_label, reason) => {
    const test = fixture();
    test.ensure.callsFake(async (): Promise<FollowedSyncSource> => { throw reason; });
    const [outcome] = await Promise.allSettled([test.binding.waitUntilReady()]);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') { expect(outcome.reason).toBe(reason); }
    expect(test.capture.callCount).toBe(0);
    expect(test.binding.signal.aborted).toBe(false);
    test.session.abort();
  });

  it('keeps the first settled provider failure when the caller aborts before the await resumes', async () => {
    const test = fixture();
    const caller = new AbortController();
    const failure = { kind: 'first-provider-failure' };
    const laterAbort = new Error('later caller abort');
    let rejectPrepare!: (reason: unknown) => void;
    test.ensure.returns(new Promise<FollowedSyncSource>((_resolve, reject): void => { rejectPrepare = reject; }));
    const waiting = test.binding.waitUntilReady(caller.signal);
    await settled(() => test.ensure.called);
    rejectPrepare(failure);
    // prepare() has a finally reaction before the readiness gate's rejection handler.
    queueMicrotask((): void => { queueMicrotask((): void => caller.abort(laterAbort)); });
    const [outcome] = await Promise.allSettled([waiting]);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') { expect(outcome.reason).toBe(failure); }
    expect(caller.signal.reason).toBe(laterAbort);
    test.session.abort();
  });

  it('preserves a non-Error caller cancellation reason', async () => {
    const test = fixture();
    const caller = new AbortController();
    const reason = { kind: 'caller-cancelled' };
    const waiting = test.binding.waitUntilReady(caller.signal);
    caller.abort(reason);
    const [outcome] = await Promise.allSettled([waiting]);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') { expect(outcome.reason).toBe(reason); }
    expect(test.session.signal.aborted).toBe(false);
    test.session.abort();
  });

  it('does not redeliver a wake to a waiter added reentrantly during that notification', async () => {
    let addWaiter = false;
    let second: Promise<void> | undefined;
    const test = fixture(false, {
      beforeRead: (): void => {
        if (addWaiter) {
          addWaiter = false;
          second = test.binding.waitUntilReady();
        }
      },
    });
    let finishPrepare!: (value: FollowedSyncSource) => void;
    test.ensure.returns(new Promise<FollowedSyncSource>((resolve): void => { finishPrepare = resolve; }));
    const first = test.binding.waitUntilReady();
    // Let the initial read finish while the optional provider remains unavailable.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    test.get.resetHistory();
    addWaiter = true;
    test.publish();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(second).toBeDefined();
    expect(test.get.callCount).toBe(2);
    const reason = new Error('close both waiters');
    test.session.abort(reason);
    const outcomes = await Promise.allSettled([first, second!]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected']);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') { expect(outcome.reason).toBe(reason); }
    }
    finishPrepare(test.root);
  });

  it('opens consumer observations after a root catalog wake verifies the projection', async () => {
    const test = fixture();
    const waiting = test.binding.waitUntilReady();
    await settled(() => test.ensure.called);
    test.state.current = { ...test.root, projections: [projection] };
    test.publish();
    await waiting;
    expect(test.capture.calledOnceWith(projection)).toBe(true);
    expect(test.binding.executionContext.moduleRole).toBe('notebook:notebook/page/editor');
    expect(test.binding.executionContext.tenantDid).toBe(test.root.sourceDid);
    expect(test.binding.executionContext.remoteEndpoint).toBe(test.root.remoteEndpoint);
    expect(test.binding.executionContext.followedSourceModule).toBe(rootModule);
    expect(test.root.projections).toBeUndefined();
    expect(test.capture.firstCall.args[1]).toBe(test.state.current);
    await test.binding.executionContext.invalidateReplica!();
    expect(test.markPending.calledOnceWith(test.state.current, consumerModule)).toBe(true);
    test.session.abort();
  });

  it('retires only the consumer binding when its verified projection changes', async () => {
    const test = fixture(true);
    await test.binding.assertActive();
    test.state.current = { ...test.root, projections: [{ ...projection, modulePaths: ['page/live'] }] };
    test.publish();
    await settled(() => test.binding.signal.aborted);
    await expect(test.binding.assertActive()).rejects.toBeInstanceOf(ContextRetiredError);
    expect(test.session.signal.aborted).toBe(false);
    expect(test.state.current.acceptanceId).toBe(test.root.acceptanceId);
    test.session.abort();
  });

  it('does not revive a captured binding after its projection disappears and returns', async () => {
    const test = fixture(true);
    await test.binding.assertActive();
    test.state.current = { ...test.root };
    test.publish();
    await settled(() => test.binding.signal.aborted);
    test.state.current = { ...test.root, projections: [projection] };
    test.publish();
    await expect(test.binding.assertActive()).rejects.toBeInstanceOf(ContextRetiredError);
    expect(test.capture.callCount).toBe(1);
    test.session.abort();
  });

  it('rejects an opening consumer observation when its root is forgotten', async () => {
    const test = fixture();
    const waiting = test.binding.waitUntilReady();
    await settled(() => test.ensure.called);
    test.state.current = undefined;
    test.publish();
    await expect(waiting).rejects.toBeInstanceOf(ContextRetiredError);
    expect(test.listeners.size).toBe(0);
    expect(test.capture.callCount).toBe(0);
  });

  it('fences a pending opening from a replacement acceptance of the same role record', async () => {
    const test = fixture();
    const waiting = test.binding.waitUntilReady();
    await settled(() => test.ensure.called);
    test.state.current = { ...test.root, acceptanceId: 'acceptance-two', projections: [projection] };
    test.publish();
    await expect(waiting).rejects.toBeInstanceOf(ContextRetiredError);
    expect(test.capture.callCount).toBe(0);
  });

  it('ends a pending consumer observation with its caller without retiring root access', async () => {
    const test = fixture();
    const caller = new AbortController();
    const reason = new Error('consumer view closed');
    const waiting = test.binding.waitUntilReady(caller.signal);
    caller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(test.binding.signal.aborted).toBe(false);
    expect(test.session.signal.aborted).toBe(false);
    test.session.abort();
  });
});
