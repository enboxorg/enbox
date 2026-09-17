import { afterEach, describe, expect, it } from 'bun:test';

import { executeUnlessAborted } from '../../src/utils/abort.js';
import sinon from 'sinon';

describe('executeUnlessAborted', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('returns the operation result without a signal', async () => {
    await expect(executeUnlessAborted(Promise.resolve('complete'), undefined)).resolves.toBe('complete');
  });

  it('rejects with an already-aborted signal reason even when the operation is settled', async () => {
    const controller = new AbortController();
    const reason = new Error('already stopped');
    controller.abort(reason);

    await expect(executeUnlessAborted(Promise.resolve('complete'), controller.signal)).rejects.toBe(reason);
  });

  it('rejects with the signal reason without cancelling the underlying operation', async () => {
    const controller = new AbortController();
    const reason = new Error('stopped');
    let resolveOperation!: (value: string) => void;
    const operation = new Promise<string>(resolve => {
      resolveOperation = resolve;
    });
    const result = executeUnlessAborted(operation, controller.signal);

    controller.abort(reason);
    await expect(result).rejects.toBe(reason);

    resolveOperation('complete');
    await expect(operation).resolves.toBe('complete');
  });

  it('removes its abort listener when the operation settles first', async () => {
    const controller = new AbortController();
    const addListener = sinon.spy(controller.signal, 'addEventListener');
    const removeListener = sinon.spy(controller.signal, 'removeEventListener');

    await expect(executeUnlessAborted(Promise.resolve('complete'), controller.signal)).resolves.toBe('complete');

    expect(addListener.calledOnce).toBe(true);
    expect(removeListener.calledOnce).toBe(true);
    expect(removeListener.firstCall.args[0]).toBe('abort');
    expect(removeListener.firstCall.args[1]).toBe(addListener.firstCall.args[1]);
  });
});
