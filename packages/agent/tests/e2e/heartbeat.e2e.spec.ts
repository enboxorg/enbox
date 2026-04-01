/**
 * E2E: WebSocket heartbeat against a real DWN server.
 *
 * Proves the full JsonRpcSocket heartbeat cycle (rpc.ping -> server -> pong)
 * works end-to-end. Uses a 5s interval instead of the default 30s to keep
 * the test under 30 seconds while exercising real timers and transport.
 *
 * Requires: DWN server running on localhost:3000 (or TEST_DWN_URL).
 */
import { JsonRpcSocket } from '@enbox/dwn-clients';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { testDwnUrl } from '../utils/test-config.js';

const wsUrl = testDwnUrl.replace('http', 'ws');

describe('E2E: WebSocket heartbeat', () => {
  let client: JsonRpcSocket;

  beforeAll(async () => {
    client = await JsonRpcSocket.connect(wsUrl, {
      heartbeatInterval : 5_000,
      heartbeatTimeout  : 3_000,
    });
  });

  afterAll(() => {
    client?.close();
  });

  it('should maintain a healthy connection through multiple heartbeat cycles', async () => {
    expect(client.isConnected).toBe(true);

    // Wait for 2+ full heartbeat cycles (5s interval * 2 = 10s + margin).
    await new Promise(r => setTimeout(r, 12_000));

    // Connection should still be alive — the server responded to rpc.ping.
    expect(client.isConnected).toBe(true);
  }, 20_000);

  it('should have cleared awaitingPong after each cycle', () => {
    // After the previous test waited 12s, at least 2 pong responses arrived.
    expect((client as any)._awaitingPong).toBe(false);
  });
});
