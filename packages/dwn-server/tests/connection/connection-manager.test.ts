import type { Dwn } from '@enbox/dwn-sdk-js';

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { config } from '../../src/config.js';
import { getTestDwn } from '../test-dwn.js';
import { HttpApi } from '../../src/http-api.js';
import { InMemoryConnectionManager } from '../../src/connection/connection-manager.js';
import { JsonRpcSocket } from '@enbox/dwn-clients';
import { WsApi } from '../../src/ws-api.js';

describe('InMemoryConnectionManager', () => {
  let dwn: Dwn;
  let connectionManager: InMemoryConnectionManager;
  let httpApi: HttpApi;
  let wsApi: WsApi;
  let wsUrl: string;

  beforeEach(async () => {
    dwn = await getTestDwn({ withEvents: true });
    connectionManager = new InMemoryConnectionManager(dwn);
    httpApi = await HttpApi.create(config, dwn);
    await httpApi.start(0);
    wsUrl = `ws://127.0.0.1:${httpApi.server.port}`;
    wsApi = new WsApi(httpApi, dwn, connectionManager);
    wsApi.start();
  });

  afterEach(async () => {
    await connectionManager.closeAll();
    await dwn.close();
    await httpApi.close();
    await wsApi.close();
    mock.restore();
  });

  it('adds connection to the connections and removes it if that connection is closed', async () => {
    const connection = await JsonRpcSocket.connect(wsUrl);
    expect((connectionManager as any).connections.size).toBe(1);
    connection.close();

    await new Promise((resolve) => setTimeout(resolve, 5)); // wait for close event to be fired
    expect((connectionManager as any).connections.size).toBe(0);
  });

  it('returns zero subscription count when no subscriptions exist', () => {
    expect(connectionManager.getSubscriptionCount()).toBe(0);
  });

  it('returns the total subscription count across all connections', async () => {
    // Connect a client and subscribe to something.
    const alice = await (await import('@enbox/dwn-sdk-js')).TestDataGenerator.generateDidKeyPersona();
    await (await import('@enbox/dwn-sdk-js')).TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const { message } = await (await import('@enbox/dwn-sdk-js')).TestDataGenerator.generateRecordsSubscribe({
      author : alice,
      filter : { schema: 'foo/bar' },
    });

    const { v4: uuidv4 } = await import('uuid');
    const { createJsonRpcSubscriptionRequest } = await import('@enbox/dwn-clients');

    const connection = await JsonRpcSocket.connect(wsUrl);
    const requestId = uuidv4();
    const subscriptionId = uuidv4();
    const dwnRequest = createJsonRpcSubscriptionRequest(
      requestId, 'rpc.subscribe.dwn.processMessage',
      { message, target: alice.did },
      subscriptionId,
    );

    const { response, close } = await connection.subscribe(dwnRequest, () => {});
    expect(response.error).toBeUndefined();

    // Give server a moment to register the subscription.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connectionManager.getSubscriptionCount()).toBeGreaterThanOrEqual(1);

    await close();
  });

  it('closes all connections on `closeAll`', async () => {

    await JsonRpcSocket.connect(wsUrl);
    expect((connectionManager as any).connections.size).toBe(1);

    await JsonRpcSocket.connect(wsUrl);
    expect((connectionManager as any).connections.size).toBe(2);

    await connectionManager.closeAll();
    expect((connectionManager as any).connections.size).toBe(0);
  });
});
