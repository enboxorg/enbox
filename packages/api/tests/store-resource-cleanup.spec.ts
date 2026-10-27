import type { StoreScope } from '../src/store/scope.js';
import type { ConnectionSnapshot, ConnectionStore } from '../src/connection-store.js';
import type { ExpandableRecordView, RecordViewState } from '../src/record-view.js';

import sinon from 'sinon';
import { describe, expect, it } from 'bun:test';

import { createApplication } from '../src/store/application.js';
import { createCollectionResource } from '../src/store/resource.js';
import { defineStore } from '../src/store/definition.js';
import { StoreRetiredError } from '../src/store/scope.js';

function deferred<Value>(): { promise: Promise<Value>; resolve(value: Value): void; reject(reason: unknown): void } {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((accept, fail): void => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function view(close: () => Promise<void>): ExpandableRecordView<string> {
  const state = Object.freeze({ status: 'ready' as const, records: Object.freeze(['row']), hasMore: false, current: false });
  return {
    getSnapshot : (): RecordViewState<string> => state,
    subscribe   : (): (() => void) => (): void => {},
    ready       : async () => state,
    refresh     : async () => state,
    loadMore    : async (): Promise<void> => {},
    close,
  };
}

function applicationFixture(open: () => Promise<ExpandableRecordView<string>>): {
  application: ReturnType<typeof createApplication>;
  resource: ReturnType<typeof createCollectionResource<string>>;
  closeResource(): void | Promise<void>;
  disposals(): number;
} {
  let releaseResource!: () => void | Promise<void>;
  let disposals = 0;
  const snapshot: ConnectionSnapshot = Object.freeze({ phase: 'disconnected' });
  const current = async (): Promise<ConnectionSnapshot> => snapshot;
  const connection: ConnectionStore = {
    getSnapshot         : (): ConnectionSnapshot => snapshot,
    subscribe           : (): (() => void) => (): void => {},
    initialize          : current,
    connect             : current,
    connectVault        : current,
    refresh             : current,
    refreshDwnEndpoints : current,
    retryRemote         : current,
    disconnect          : current,
    dispose             : async (): Promise<void> => { disposals += 1; },
  };
  // This feature owns injected native views; its scope has no SDK operations to authorize.
  const feature = defineStore({
    protocols : {},
    create    : ({ signal, onClose }) => {
      const scope: StoreScope = {
        signal,
        assertCurrent: (): void => {
          if (signal.aborted) { throw new StoreRetiredError(); }
        },
        getEnbox : (): never => { throw new Error('Cleanup fixture supplies native views directly.'); },
        onClose  : (close): (() => void) => {
          let registered = true;
          releaseResource = close;
          onClose(() => { if (registered) { return close(); } });
          return (): void => { registered = false; };
        },
      };
      return createCollectionResource(scope, open);
    },
  });
  const application = createApplication({ stores: { feature }, connection: () => connection });
  return {
    application,
    resource      : application.store(feature),
    closeResource : (): void | Promise<void> => releaseResource(),
    disposals     : (): number => disposals,
  };
}

function nextTurn(): Promise<void> { return new Promise((resolve): void => { setImmediate(resolve); }); }

function failures(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(failures) : [error];
}

describe('store resource cleanup completion', () => {
  it('propagates cleanup failures from a view returned after application retirement', async () => {
    const warning = sinon.stub(console, 'warn');
    const opening = deferred<ExpandableRecordView<string>>();
    const failure = new Error('Late native close failed');
    const native = view(async (): Promise<never> => { throw failure; });
    const test = applicationFixture(() => opening.promise);
    const release = test.resource.retain();
    try {
      await nextTurn();
      const outcome = test.application.dispose().catch((error: unknown): unknown => error);
      opening.resolve(native);
      const error = await outcome;
      expect(error).toBeInstanceOf(AggregateError);
      expect(failures(error)).toContain(failure);
      expect(test.disposals()).toBe(1);
    } finally {
      opening.resolve(native);
      release();
      await test.application.dispose().catch((): void => {});
      warning.restore();
    }
  });

  it('waits for every native close after a separate close rejects and shares reentrant completion', async () => {
    const warning = sinon.stub(console, 'warn');
    const failedClose = deferred<void>();
    const slowClose = deferred<void>();
    const failure = new Error('First native close failed');
    let reentered: void | Promise<void> = undefined;
    const first = view(() => failedClose.promise);
    const second = view((): Promise<void> => { reentered = test.closeResource(); return slowClose.promise; });
    let opens = 0;
    const test = applicationFixture(async () => ++opens === 1 ? first : second);
    const release = test.resource.retain();
    let settled = false;
    let disposal: Promise<unknown> | undefined;
    try {
      await test.resource.ready();
      await test.resource.retry();
      disposal = test.application.dispose().then((): undefined => { settled = true; return undefined; }, (error: unknown): unknown => {
        settled = true; return error;
      });
      const completion = test.closeResource();
      await nextTurn();
      failedClose.reject(failure);
      await nextTurn();

      expect(settled).toBe(false);
      expect(test.disposals()).toBe(0);
      expect(reentered).toBe(completion);
      expect(test.closeResource()).toBe(completion);

      slowClose.resolve();
      const error = await disposal;
      expect(error).toBeInstanceOf(AggregateError);
      expect(failures(error)).toContain(failure);
      expect(test.disposals()).toBe(1);
    } finally {
      slowClose.resolve();
      failedClose.resolve();
      release();
      await disposal;
      await test.application.dispose().catch((): void => {});
      warning.restore();
    }
  });

  it('retains earlier cleanup failures while a late opening supplies another native close', async () => {
    const warning = sinon.stub(console, 'warn');
    const failedClose = deferred<void>();
    const lateOpening = deferred<ExpandableRecordView<string>>();
    const lateClose = deferred<void>();
    const failure = new Error('Retired native close failed');
    const first = view(() => failedClose.promise);
    const late = view(() => lateClose.promise);
    let opens = 0;
    const test = applicationFixture(async () => ++opens === 1 ? first : lateOpening.promise);
    const release = test.resource.retain();
    let settled = false;
    let disposal: Promise<unknown> | undefined;
    let retry: Promise<unknown> | undefined;
    try {
      await test.resource.ready();
      retry = test.resource.retry().catch((error: unknown): unknown => error);
      await nextTurn();
      expect(opens).toBe(2);
      disposal = test.application.dispose().then((): undefined => { settled = true; return undefined; }, (error: unknown): unknown => {
        settled = true; return error;
      });
      failedClose.reject(failure);
      await nextTurn();
      expect(settled).toBe(false);
      expect(test.disposals()).toBe(0);
      lateOpening.resolve(late);
      await nextTurn();
      expect(settled).toBe(false);
      expect(test.disposals()).toBe(0);
      lateClose.resolve();

      const error = await disposal;
      expect(error).toBeInstanceOf(AggregateError);
      expect(failures(error)).toContain(failure);
      expect(test.disposals()).toBe(1);
      expect(await retry).toBeInstanceOf(StoreRetiredError);
    } finally {
      failedClose.resolve();
      lateOpening.resolve(late);
      lateClose.resolve();
      release();
      await retry;
      await disposal;
      await test.application.dispose().catch((): void => {});
      warning.restore();
    }
  });
});
