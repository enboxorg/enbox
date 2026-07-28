import { describe, expect, it } from 'bun:test';

import { WebSocketConnectionLimiter } from '../../src/connection/websocket-connection-limiter.js';

describe('WebSocketConnectionLimiter', () => {
  it('rejects invalid limits', () => {
    const invalidLimits = [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN];

    for (const invalidLimit of invalidLimits) {
      expect(() => new WebSocketConnectionLimiter(invalidLimit, 1)).toThrow(RangeError);
      expect(() => new WebSocketConnectionLimiter(1, invalidLimit)).toThrow(RangeError);
    }
  });

  it('enforces total and per-peer limits', () => {
    const limiter = new WebSocketConnectionLimiter(3, 2);

    expect(limiter.reserve('192.0.2.1').status).toBe('accepted');
    expect(limiter.reserve('192.0.2.1').status).toBe('accepted');
    expect(limiter.reserve('192.0.2.1')).toEqual({ reason: 'peer-limit', status: 'rejected' });

    expect(limiter.reserve('192.0.2.2').status).toBe('accepted');
    expect(limiter.reserve('192.0.2.3')).toEqual({ reason: 'total-limit', status: 'rejected' });
    expect(limiter.count).toBe(3);
  });

  it('releases capacity exactly once', () => {
    const limiter = new WebSocketConnectionLimiter(1, 1);
    const result = limiter.reserve('192.0.2.1');
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('expected the connection reservation to be accepted');
    }

    expect(limiter.count).toBe(1);
    expect(limiter.reserve('192.0.2.1').status).toBe('rejected');

    result.release();
    result.release();
    expect(limiter.count).toBe(0);

    expect(limiter.reserve('192.0.2.1').status).toBe('accepted');
    expect(limiter.count).toBe(1);
  });
});
