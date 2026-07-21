import type { SinonStub } from 'sinon';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { SyncRunCancelledError } from '../src/sync-runtime-errors.js';

import { deferred as createDeferred } from './utils/deferred.js';

function createEngine(registeredDids: string[] = []): { engine: SyncEngineLevel; run: SinonStub } {
  const engine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
  const run = sinon.stub().resolves();
  (engine as any)._runCoordinator = { run };
  (engine as any)._identityStore = {
    get: sinon.stub().callsFake(async (did: string) =>
      registeredDids.includes(did) ? { protocols: 'all' } : undefined),
  };
  return { engine, run };
}

/** Let queued microtasks/timers flush so concurrent `sync()` joins settle. */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('SyncEngineLevel sync() coalescing', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should reject a scoped sync for an unregistered identity', async () => {
    const { engine, run } = createEngine([]);

    await expect(engine.sync('pull', { did: 'did:example:ghost' })).rejects.toThrow('is not registered');
    expect(run.notCalled).toBe(true);
  });

  it('should run immediately when the lock is free', async () => {
    const { engine, run } = createEngine();

    await engine.sync('pull');

    expect(run.calledOnce).toBe(true);
    expect(run.firstCall.args[0]).toBe('pull');
  });

  it('should coalesce callers arriving mid-run into one merged follow-up', async () => {
    const { engine, run } = createEngine(['did:example:alice']);
    const gate = createDeferred();
    run.onFirstCall().callsFake(() => gate.promise);

    const first = engine.sync('pull');
    const second = engine.sync('push', { did: 'did:example:alice' });
    const third = engine.sync('push', { did: 'did:example:alice' });
    await settle();

    expect(run.calledOnce).toBe(true); // the follow-up is queued, not running

    gate.resolve();
    await Promise.all([first, second, third]);

    expect(run.callCount).toBe(2);
    expect(run.secondCall.args[0]).toBe('push');
    expect(run.secondCall.args[1]).toEqual({ did: 'did:example:alice' });
  });

  it('should widen the follow-up when joined requests disagree', async () => {
    const { engine, run } = createEngine(['did:example:alice']);
    const gate = createDeferred();
    run.onFirstCall().callsFake(() => gate.promise);

    const first = engine.sync('pull');
    const scoped = engine.sync('push', { did: 'did:example:alice' });
    const unscoped = engine.sync('pull');
    await settle();

    gate.resolve();
    await Promise.all([first, scoped, unscoped]);

    expect(run.callCount).toBe(2);
    // push + pull joiners widen to both directions; a scoped + an unscoped
    // joiner widen to an unscoped run.
    expect(run.secondCall.args[0]).toBeUndefined();
    expect(run.secondCall.args[1]).toEqual({});
  });

  it('should reject a queued follow-up with SyncRunCancelledError when a runtime transition intervenes', async () => {
    const { engine, run } = createEngine();
    const lifecycle = (engine as any)._lifecycle;

    expect(lifecycle.tryAcquireSync()).toBe(true);
    const queued = engine.sync('pull');
    await settle();
    expect(run.notCalled).toBe(true);

    // stopSync/clear/close funnel through this transition: it bumps the
    // engine runtime and drops the queued join point. The joiner must
    // reject — a resolved sync() always means a covering run completed.
    (engine as any).prepareForSyncRuntimeTransition();
    lifecycle.releaseSync();

    await expect(queued).rejects.toThrow(SyncRunCancelledError);
    expect(run.notCalled).toBe(true);
  });

  it('should start a fresh cycle for a caller arriving after the follow-up began', async () => {
    const { engine, run } = createEngine();
    const firstGate = createDeferred();
    const followUpGate = createDeferred();
    run.onFirstCall().callsFake(() => firstGate.promise);
    run.onSecondCall().callsFake(() => followUpGate.promise);

    const first = engine.sync();
    const joined = engine.sync();
    await settle();

    firstGate.resolve();
    await first;
    await settle(); // the follow-up has now taken the lock and is running

    const late = engine.sync('pull');
    await settle();

    followUpGate.resolve();
    await Promise.all([joined, late]);

    expect(run.callCount).toBe(3);
    expect(run.thirdCall.args[0]).toBe('pull');
  });
});
