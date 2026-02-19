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

  it('closes all connections on `closeAll`', async () => {

    await JsonRpcSocket.connect(wsUrl);
    expect((connectionManager as any).connections.size).toBe(1);

    await JsonRpcSocket.connect(wsUrl);
    expect((connectionManager as any).connections.size).toBe(2);

    await connectionManager.closeAll();
    expect((connectionManager as any).connections.size).toBe(0);
  });
});
