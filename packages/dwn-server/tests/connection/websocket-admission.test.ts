import type { Dialect } from '@enbox/dwn-sql-store';
import type { Dwn } from '@enbox/dwn-sdk-js';

import { connect } from 'node:net';
import { TestDataGenerator } from '@enbox/dwn-sdk-js';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { config } from '../../src/config.js';
import { getTestDwn } from '../test-dwn.js';
import { HttpApi } from '../../src/http-api.js';
import { RateLimiter } from '../../src/rate-limiter.js';
import { WsApi } from '../../src/ws-api.js';
import { createJsonRpcSubscriptionRequest, JsonRpcErrorCodes, JsonRpcSocket } from '@enbox/dwn-clients';

const SOCKET_TIMEOUT_MS = 3_000;

describe('WebSocket admission', () => {
  let dialect: Dialect;
  let dwn: Dwn;
  let httpApi: HttpApi | undefined;
  let ipRateLimiter: RateLimiter | undefined;
  let sockets: Set<WebSocket>;
  let wsApi: WsApi | undefined;
  let wsUrl: string;

  beforeEach(async () => {
    ({ dialect, dwn } = await getTestDwn({ withEvents: true }));
    httpApi = undefined;
    ipRateLimiter = undefined;
    sockets = new Set();
    wsApi = undefined;
  });

  afterEach(async () => {
    for (const socket of sockets) {
      socket.terminate();
    }
    await wsApi?.close();
    await httpApi?.close();
    ipRateLimiter?.destroy();
    await dwn.close();
  });

  async function startServer(options: {
    ipRateLimitBurst?: number;
    maxConnections: number;
    maxConnectionsPerIp: number;
    maxSubscriptions?: number;
  }): Promise<void> {
    const serverConfig = {
      ...config,
      hostname                               : '127.0.0.1',
      localNodeProfileEnabled                : false,
      webSocketMaxConnections                : options.maxConnections,
      webSocketMaxConnectionsPerIp           : options.maxConnectionsPerIp,
      webSocketMaxSubscriptionsPerConnection : options.maxSubscriptions ?? config.webSocketMaxSubscriptionsPerConnection,
      webSocketSupport                       : true,
    };

    if (options.ipRateLimitBurst !== undefined) {
      ipRateLimiter = new RateLimiter({
        maxTokens  : options.ipRateLimitBurst,
        refillRate : 0.001,
      });
    }

    httpApi = await HttpApi.create(serverConfig, dwn, undefined, undefined, undefined, {
      ipRateLimiter,
      ttlCacheDialect: dialect,
    });

    // Install the open callback before the server can accept an upgrade.
    wsApi = new WsApi(httpApi, dwn);
    await httpApi.start(0);
    wsUrl = `ws://127.0.0.1:${httpApi.server.port}`;
  }

  async function openWebSocket(): Promise<WebSocket> {
    const socket = new WebSocket(wsUrl);
    sockets.add(socket);
    // Rejected upgrades can emit another transport error after the opening
    // promise settles. Keep the test client from treating that cleanup signal
    // as an unhandled EventEmitter error.
    socket.on('error', (): void => {});

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout((): void => {
        reject(new Error('WebSocket open timed out'));
      }, SOCKET_TIMEOUT_MS);

      socket.once('open', (): void => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once('error', (error: Error): void => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    return socket;
  }

  async function closeWebSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout((): void => {
        reject(new Error('WebSocket close timed out'));
      }, SOCKET_TIMEOUT_MS);

      socket.once('close', (): void => {
        clearTimeout(timeout);
        resolve();
      });
      socket.close();
    });
  }

  async function waitForWebSocketTermination(socket: WebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout((): void => reject(new Error('WebSocket termination timed out')), SOCKET_TIMEOUT_MS);
      const finish = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      socket.once('close', finish);
      socket.once('error', finish);
    });
  }

  async function requestUpgradeStatus(options: { forwardedFor?: string; malformed?: boolean } = {}): Promise<number> {
    const url = new URL(wsUrl);

    return new Promise<number>((resolve, reject) => {
      const socket = connect({ host: url.hostname, port: Number.parseInt(url.port, 10) });
      let response = '';
      const timeout = setTimeout((): void => {
        socket.destroy();
        reject(new Error('Malformed WebSocket upgrade response timed out'));
      }, SOCKET_TIMEOUT_MS);

      socket.setEncoding('utf8');
      socket.once('connect', (): void => {
        const headers = [
          'GET / HTTP/1.1',
          `Host: ${url.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          `Sec-WebSocket-Key: ${options.malformed ? 'invalid' : 'dGhlIHNhbXBsZSBub25jZQ=='}`,
          'Sec-WebSocket-Version: 13',
        ];
        if (options.forwardedFor !== undefined) {
          headers.push(`X-Forwarded-For: ${options.forwardedFor}`);
        }
        socket.write([...headers, '', ''].join('\r\n'));
      });
      socket.on('data', (chunk: string): void => {
        response += chunk;
        const statusLineEnd = response.indexOf('\r\n');
        if (statusLineEnd === -1) {
          return;
        }

        clearTimeout(timeout);
        socket.destroy();
        const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(response.slice(0, statusLineEnd));
        if (statusMatch === null) {
          reject(new Error(`Unexpected WebSocket response: ${response.slice(0, statusLineEnd)}`));
          return;
        }
        resolve(Number.parseInt(statusMatch[1], 10));
      });
      socket.once('error', (error: Error): void => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  it('enforces the total connection limit', async () => {
    await startServer({ maxConnections: 2, maxConnectionsPerIp: 3 });

    await openWebSocket();
    await openWebSocket();

    expect(await requestUpgradeStatus()).toBe(503);
  });

  it('does not exceed the total limit during concurrent opens', async () => {
    await startServer({ maxConnections: 2, maxConnectionsPerIp: 3 });

    const attempts = await Promise.allSettled([openWebSocket(), openWebSocket(), openWebSocket()]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
  });

  it('enforces the per-peer connection limit', async () => {
    await startServer({ maxConnections: 3, maxConnectionsPerIp: 1 });

    await openWebSocket();

    expect(await requestUpgradeStatus()).toBe(429);
  });

  it('does not trust forwarded headers for the peer connection limit', async () => {
    await startServer({ maxConnections: 2, maxConnectionsPerIp: 1 });
    await openWebSocket();

    expect(await requestUpgradeStatus({ forwardedFor: '198.51.100.42' })).toBe(429);
  });

  it('restores connection capacity immediately after close', async () => {
    await startServer({ maxConnections: 1, maxConnectionsPerIp: 1 });
    const first = await openWebSocket();

    expect(await requestUpgradeStatus()).toBe(503);

    await closeWebSocket(first);
    const replacement = await openWebSocket();
    expect(replacement.readyState).toBe(WebSocket.OPEN);
  });

  it('rate-limits upgrade attempts by peer IP before admission', async () => {
    await startServer({ ipRateLimitBurst: 1, maxConnections: 2, maxConnectionsPerIp: 2 });
    const first = await openWebSocket();
    await closeWebSocket(first);

    expect(await requestUpgradeStatus()).toBe(429);
  });

  it('rate-limits malformed upgrade attempts before validation', async () => {
    await startServer({ ipRateLimitBurst: 1, maxConnections: 1, maxConnectionsPerIp: 1 });

    expect(await requestUpgradeStatus({ malformed: true })).toBe(400);
    expect(await requestUpgradeStatus({ malformed: true })).toBe(429);
  });

  it('does not reserve connection capacity for an invalid handshake', async () => {
    await startServer({ maxConnections: 1, maxConnectionsPerIp: 1 });

    expect(await requestUpgradeStatus({ malformed: true })).toBe(400);

    const connection = await openWebSocket();
    expect(connection.readyState).toBe(WebSocket.OPEN);
  });

  it('releases connection capacity if socket setup cannot begin', async () => {
    await startServer({ maxConnections: 1, maxConnectionsPerIp: 1 });
    const openHandler = httpApi!.onWebSocketConnection;
    httpApi!.onWebSocketConnection = undefined;
    const failed = new WebSocket(wsUrl);
    sockets.add(failed);

    await waitForWebSocketTermination(failed);
    httpApi!.onWebSocketConnection = openHandler;

    const replacement = await openWebSocket();
    expect(replacement.readyState).toBe(WebSocket.OPEN);
  });

  it('restores per-connection subscription capacity after close', async () => {
    await startServer({ maxConnections: 1, maxConnectionsPerIp: 1, maxSubscriptions: 1 });
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
    const { message } = await TestDataGenerator.generateRecordsSubscribe({
      author : alice,
      filter : { schema: 'example/schema' },
    });
    const connection = await JsonRpcSocket.connect(wsUrl);

    const first = await connection.subscribe(createJsonRpcSubscriptionRequest(
      'first-request',
      'rpc.subscribe.dwn.processMessage',
      { message, target: alice.did },
      'first-subscription',
    ), (): void => {});
    const rejected = await connection.subscribe(createJsonRpcSubscriptionRequest(
      'second-request',
      'rpc.subscribe.dwn.processMessage',
      { message, target: alice.did },
      'second-subscription',
    ), (): void => {});

    expect(first.response.error).toBeUndefined();
    expect(rejected.response.error?.code).toBe(JsonRpcErrorCodes.TooManyRequests);

    await first.close?.();
    const replacement = await connection.subscribe(createJsonRpcSubscriptionRequest(
      'replacement-request',
      'rpc.subscribe.dwn.processMessage',
      { message, target: alice.did },
      'replacement-subscription',
    ), (): void => {});
    expect(replacement.response.error).toBeUndefined();

    await replacement.close?.();
    connection.close();
  });

  it('releases an opening reservation when the DWN rejects the subscription', async () => {
    await startServer({ maxConnections: 1, maxConnectionsPerIp: 1, maxSubscriptions: 1 });
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
    const { message } = await TestDataGenerator.generateRecordsSubscribe({
      author : alice,
      filter : { schema: 'example/schema' },
    });
    const invalidMessage = structuredClone(message);
    invalidMessage.descriptor.filter.schema = 'example/tampered';
    const connection = await JsonRpcSocket.connect(wsUrl);

    const rejected = await connection.subscribe(createJsonRpcSubscriptionRequest(
      'rejected-request',
      'rpc.subscribe.dwn.processMessage',
      { message: invalidMessage, target: alice.did },
      'rejected-subscription',
    ), (): void => {});
    const accepted = await connection.subscribe(createJsonRpcSubscriptionRequest(
      'accepted-request',
      'rpc.subscribe.dwn.processMessage',
      { message, target: alice.did },
      'accepted-subscription',
    ), (): void => {});

    expect(rejected.response.result?.reply.status.code).toBeGreaterThanOrEqual(400);
    expect(accepted.response.error).toBeUndefined();

    await accepted.close?.();
    connection.close();
  });
});
