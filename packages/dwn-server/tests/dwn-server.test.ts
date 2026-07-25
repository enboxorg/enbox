import type { Dwn } from '@enbox/dwn-sdk-js';

import { WebSocket } from 'ws';
import { describe, expect, it } from 'bun:test';

import { config } from '../src/config.js';
import { DwnServer } from '../src/dwn-server.js';
import { getTestDwn } from './test-dwn.js';
import { LocalNodePairingManager } from '../src/local-node-pairing.js';

async function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout((): void => reject(new Error('WebSocket open timeout')), 3000);
    socket.onopen = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    socket.onerror = (error): void => {
      clearTimeout(timeout);
      reject(error);
    };
  });
}

async function waitForWebSocketClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout((): void => reject(new Error('WebSocket close timeout')), 3000);
    socket.onclose = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    socket.onerror = (error): void => {
      clearTimeout(timeout);
      reject(error);
    };
  });
}

async function expectWebSocketRejection(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout((): void => reject(new Error('WebSocket rejection timeout')), 3000);
    socket.onopen = (): void => {
      clearTimeout(timeout);
      reject(new Error('WebSocket opened during server shutdown'));
    };
    socket.onerror = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    socket.onclose = (): void => {
      clearTimeout(timeout);
      resolve();
    };
  });
}

describe('DwnServer', () => {
  const dwnServerConfig = { ...config, port: 0 };
  let dwn: Dwn;

  it('starts with injected dwn', async () => {
    ({ dwn } = await getTestDwn());

    const dwnServer = new DwnServer({ config: dwnServerConfig, dwn });
    await dwnServer.start();

    const port = dwnServer.httpServer.port;
    expect(typeof port).toBe('number');

    await dwnServer.stop();
  });

  it('stops accepting WebSocket upgrades as soon as shutdown begins', async () => {
    ({ dwn } = await getTestDwn({ withEvents: true }));
    const dwnServer = new DwnServer({ config: dwnServerConfig, dwn });
    await dwnServer.start();
    const wsUrl = `ws://127.0.0.1:${dwnServer.httpServer.port}`;

    const stopping = dwnServer.stop();
    await expectWebSocketRejection(new WebSocket(wsUrl));
    await stopping;
  });

  describe('webSocketSupport config', () => {
    it('should start without websocket support if disabled', async () => {
      ({ dwn } = await getTestDwn({ withEvents: true }));
      const withoutSocketServer = new DwnServer({
        dwn,
        config: {
          ...dwnServerConfig,
          webSocketSupport: false,
        }
      });

      await withoutSocketServer.start();
      expect(typeof withoutSocketServer.httpServer.port).toBe('number');

      await withoutSocketServer.stop();
      console.log('server Stop');
    });

    it('should start with websocket support if enabled', async () => {
      ({ dwn } = await getTestDwn({ withEvents: true }));
      const withSocketServer = new DwnServer({
        dwn,
        config: {
          ...dwnServerConfig,
          webSocketSupport: true,
        }
      });

      await withSocketServer.start();
      const socket = new WebSocket(`ws://127.0.0.1:${withSocketServer.httpServer.port}`);
      await waitForWebSocketOpen(socket);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      socket.terminate();

      await withSocketServer.stop();
      console.log('server Stop');
    });
  });

  describe('local node profile', () => {
    it('should expose the injected local node pairing manager', async () => {
      ({ dwn } = await getTestDwn());
      const localNodePairingManager = new LocalNodePairingManager();
      const server = new DwnServer({
        dwn,
        localNodePairingManager,
        config: {
          ...dwnServerConfig,
          hostname                : '127.0.0.1',
          localNodeProfileEnabled : true,
        }
      });

      try {
        await server.start();
        expect(server.localNodePairingManager).toBe(localNodePairingManager);
      } finally {
        await server.stop();
      }
    });

    it('should reject non-loopback bind hostnames', async () => {
      ({ dwn } = await getTestDwn());
      const server = new DwnServer({
        dwn,
        config: {
          ...dwnServerConfig,
          hostname                : '0.0.0.0',
          localNodeProfileEnabled : true,
        }
      });

      try {
        await expect(server.start()).rejects.toThrow('DwnServer local node profile requires a loopback bind hostname.');
      } finally {
        await dwn.close();
      }
    });

    it('should close live WebSocket connections when a local-node pairing token is revoked', async () => {
      ({ dwn } = await getTestDwn({ withEvents: true }));
      const localNodePairingManager = new LocalNodePairingManager();
      const token = localNodePairingManager.createSession('https://paired.example');
      const server = new DwnServer({
        dwn,
        localNodePairingManager,
        config: {
          ...dwnServerConfig,
          hostname                : '127.0.0.1',
          localNodeProfileEnabled : true,
          webSocketSupport        : true,
        }
      });

      try {
        await server.start();
        const socket = new WebSocket(`ws://127.0.0.1:${server.httpServer.port}?localNodeToken=${token}`, {
          headers: { Origin: 'https://paired.example' },
        });

        await waitForWebSocketOpen(socket);
        const closed = waitForWebSocketClose(socket);

        expect(await server.revokeLocalNodePairingToken(token)).toBe(true);
        await closed;
        expect(localNodePairingManager.validateSession('https://paired.example', token)).toBe(false);
      } finally {
        await server.stop();
      }
    });
  });
});
