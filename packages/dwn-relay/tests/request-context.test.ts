import type { GenericMessage } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';

import { requestContext } from '../src/request-context.js';

describe('requestContext', () => {
  it('should return undefined outside of a run scope', () => {
    expect(requestContext.getStore()).toBeUndefined();
  });

  it('should store and retrieve the message within a run scope', async () => {
    const message = {
      descriptor: {
        interface        : 'Records',
        method           : 'Read',
        messageTimestamp : '2026-01-01T00:00:00.000000Z',
        filter           : { recordId: 'test-record' },
      },
      authorization: { signature: { signatures: [{ protected: 'test', signature: 'test' }] } },
    } as unknown as GenericMessage;

    await requestContext.run(message, async () => {
      expect(requestContext.getStore()).toBe(message);
    });
  });

  it('should isolate contexts between concurrent runs', async () => {
    const msg1 = { descriptor: { method: 'msg1' } } as unknown as GenericMessage;
    const msg2 = { descriptor: { method: 'msg2' } } as unknown as GenericMessage;

    await Promise.all([
      requestContext.run(msg1, async () => {
        await new Promise(r => setTimeout(r, 10));
        expect(requestContext.getStore()).toBe(msg1);
      }),
      requestContext.run(msg2, async () => {
        await new Promise(r => setTimeout(r, 10));
        expect(requestContext.getStore()).toBe(msg2);
      }),
    ]);
  });

  it('should return undefined after the run scope ends', async () => {
    const message = { descriptor: { method: 'test' } } as unknown as GenericMessage;
    await requestContext.run(message, async () => {
      // inside scope
    });
    expect(requestContext.getStore()).toBeUndefined();
  });
});
