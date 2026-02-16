import type { Dwn } from '@enbox/dwn-sdk-js';

import { expect } from 'chai';

import { config } from '../src/config.js';
import { DwnServer } from '../src/dwn-server.js';
import { getTestDwn } from './test-dwn.js';

describe('DwnServer', function () {
  const dwnServerConfig = { ...config, port: 0 };
  let dwn: Dwn;

  it('starts with injected dwn', async function () {
    dwn = await getTestDwn();

    const dwnServer = new DwnServer({ config: dwnServerConfig, dwn });
    await dwnServer.start();

    const port = dwnServer.httpServer.port;
    expect(port).to.be.a('number');

    await dwnServer.stop();
  });

  describe('webSocketSupport config', function() {
    it('should start without websocket support if disabled', async function() {
      dwn = await getTestDwn({ withEvents: true });
      const withoutSocketServer = new DwnServer({
        dwn,
        config: {
          ...dwnServerConfig,
          webSocketSupport: false,
        }
      });

      await withoutSocketServer.start();
      expect(withoutSocketServer.httpServer.port).to.be.a('number');

      await withoutSocketServer.stop();
      console.log('server Stop');
    });

    it('should start with websocket support if enabled', async function() {
      dwn = await getTestDwn({ withEvents: true });
      const withSocketServer = new DwnServer({
        dwn,
        config: {
          ...dwnServerConfig,
          webSocketSupport: true,
        }
      });

      await withSocketServer.start();
      // With Bun, WebSocket support is built into the same server — no separate wsServer object.
      expect(withSocketServer.httpServer.port).to.be.a('number');

      await withSocketServer.stop();
      console.log('server Stop');
    });
  });
});
