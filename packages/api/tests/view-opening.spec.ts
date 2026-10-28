import { describe, expect, it } from 'bun:test';

import { openView, whileSignalsActive } from '../src/view-opening.js';

describe('openView', () => {
  it('preserves the opening error when cleanup also fails', async () => {
    const openError = new Error('open failed');
    let closeCalls = 0;

    const opening = openView({
      close: async (): Promise<void> => {
        closeCalls += 1;
        throw new Error('close failed');
      },
      open: async (): Promise<void> => { throw openError; },
    }, []);

    await expect(opening).rejects.toBe(openError);
    expect(closeCalls).toBe(1);
  });

  it('preserves the opening error when cleanup throws synchronously', async () => {
    const openError = new Error('open failed');
    let closeCalls = 0;

    const opening = openView({
      close: (): Promise<void> => {
        closeCalls += 1;
        throw new Error('close failed');
      },
      open: async (): Promise<void> => { throw openError; },
    }, []);

    await expect(opening).rejects.toBe(openError);
    expect(closeCalls).toBe(1);
  });
});

describe('whileSignalsActive', () => {
  it('does not dispatch work after its lifetime has already ended', async () => {
    const controller = new AbortController();
    const reason = new Error('Caller ended');
    controller.abort(reason);
    let dispatches = 0;
    await expect(whileSignalsActive(async (): Promise<void> => { dispatches++; }, [controller.signal])).rejects.toBe(reason);
    expect(dispatches).toBe(0);
  });

  it('dispatches synchronously and preserves the operation result', async () => {
    const controller = new AbortController();
    let dispatched = false;
    const result = whileSignalsActive((): Promise<string> => {
      dispatched = true;
      return Promise.resolve('written');
    }, [controller.signal]);
    expect(dispatched).toBe(true);
    expect(await result).toBe('written');
  });

  it.each(['reject', 'throw'] as const)('preserves abort precedence when dispatch also fails through %s', async (failure) => {
    const controller = new AbortController();
    const reason = new Error('Caller ended during dispatch');
    const operationError = new Error('Operation failed');
    const result = whileSignalsActive((): Promise<never> => {
      controller.abort(reason);
      if (failure === 'throw') { throw operationError; }
      return Promise.reject(operationError);
    }, [controller.signal]);
    await expect(result).rejects.toBe(reason);
  });
});
