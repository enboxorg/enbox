import type { Dwn, MessageSigner } from '@enbox/dwn-sdk-js';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { ProtocolsConfigure, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { config } from '../src/config.js';
import { createJsonRpcRequest } from '@enbox/dwn-clients';
import { DwnServer } from '../src/dwn-server.js';
import { getTestDwn } from './test-dwn.js';
import { LocalNodePairingManager } from '../src/local-node-pairing.js';
import { RegistrationStore } from '../src/registration/registration-store.js';
import { runServerMigrationsIfNeeded } from '../src/storage.js';

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

async function sendProtocolsConfigure(
  server: DwnServer,
  target: string,
  signer: MessageSigner,
  protocol: string,
): Promise<Response> {
  const configure = await ProtocolsConfigure.create({
    definition: {
      protocol,
      published : true,
      types     : { note: {} },
      structure : { note: {} },
    },
    signer,
  });
  const request = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
    message: configure.toJSON(),
    target,
  });

  return fetch(`http://127.0.0.1:${server.httpServer.port}`, {
    headers : { 'dwn-request': JSON.stringify(request) },
    method  : 'POST',
  });
}

describe('DwnServer', () => {
  const dwnServerConfig = {
    ...config,
    allowOpenTenants          : true,
    allowUnboundedTenantUsage : true,
    port                      : 0,
  };
  let dwn: Dwn;

  it('starts with injected dwn', async () => {
    ({ dwn } = await getTestDwn());

    const dwnServer = new DwnServer({ config: dwnServerConfig, dwn });
    await dwnServer.start();

    const port = dwnServer.httpServer.port;
    expect(typeof port).toBe('number');

    await dwnServer.stop();
  });

  describe('remote exposure policy', () => {
    it('should reject invalid programmatic quota limits before allocating resources', async () => {
      const invalidLimits = [
        { field: 'quotaMaxMessages', value: -1, expected: 'DWN_QUOTA_MAX_MESSAGES' },
        { field: 'quotaMaxStorageBytes', value: Number.MAX_SAFE_INTEGER + 1, expected: 'DWN_QUOTA_MAX_STORAGE_BYTES' },
      ] as const;

      for (const { field, value, expected } of invalidLimits) {
        const server = new DwnServer({
          config: { ...dwnServerConfig, [field]: value },
        });
        await expect(server.start()).rejects.toThrow(expected);
      }
    });

    it('should reject an implicit open tenant gate before listening', async () => {
      ({ dwn } = await getTestDwn());
      const server = new DwnServer({
        dwn,
        config: {
          ...dwnServerConfig,
          allowOpenTenants     : false,
          registrationStoreUrl : undefined,
        },
      });

      try {
        await expect(server.start()).rejects.toThrow(
          'Configure DWN_REGISTRATION_STORE_URL (or DWN_STORAGE), or explicitly set DWN_ALLOW_OPEN_TENANTS=true.',
        );
      } finally {
        await dwn.close();
      }
    });

    it('should not treat a configured registration store as a gate on a prebuilt DWN', async () => {
      ({ dwn } = await getTestDwn());
      const server = new DwnServer({
        dwn,
        config: {
          ...dwnServerConfig,
          allowOpenTenants     : false,
          registrationStoreUrl : 'sqlite://',
        },
      });

      try {
        await expect(server.start()).rejects.toThrow('remote servers require a tenant registration store');
      } finally {
        await dwn.close();
      }
    });

    it('should reject implicit unbounded tenant usage before listening', async () => {
      const server = new DwnServer({
        config: {
          ...dwnServerConfig,
          allowUnboundedTenantUsage : false,
          quotaMaxMessages          : 1,
          quotaMaxStorageBytes      : 0,
        },
      });

      await expect(server.start()).rejects.toThrow('DWN_ALLOW_UNBOUNDED_TENANT_USAGE=true');
    });

    it('should reject finite quotas on a message store without usage totals', async () => {
      const server = new DwnServer({
        config: {
          ...dwnServerConfig,
          messageStore         : 'level://data',
          quotaMaxMessages     : 1,
          quotaMaxStorageBytes : 1,
        },
      });

      await expect(server.start()).rejects.toThrow(
        'finite tenant quotas require DWN_STORAGE_MESSAGES to use a SQL backend that supplies usage totals.',
      );
    });

    it('should reject finite quotas when the server does not own the DWN stores', async () => {
      ({ dwn } = await getTestDwn());
      const server = new DwnServer({
        dwn,
        config: {
          ...dwnServerConfig,
          messageStore         : 'sqlite://unrelated.db',
          quotaMaxMessages     : 1,
          quotaMaxStorageBytes : 1,
        },
      });

      try {
        await expect(server.start()).rejects.toThrow('finite tenant quotas are unavailable with a prebuilt DWN');
      } finally {
        await dwn.close();
      }
    });

    it('should enforce finite quotas without enabling the admin API', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'dwn-quota-no-admin-'));
      const storageUrl = `sqlite://${tmpDir}/dwn.db`;
      const server = new DwnServer({
        config: {
          ...dwnServerConfig,
          adminToken                : undefined,
          allowUnboundedTenantUsage : false,
          dataStore                 : storageUrl,
          messageStore              : storageUrl,
          quotaMaxMessages          : 1,
          quotaMaxStorageBytes      : 1024,
          registrationStoreUrl      : undefined,
          resumableTaskStore        : storageUrl,
          ttlCacheUrl               : storageUrl,
        },
      });

      try {
        await server.start();
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const first = await sendProtocolsConfigure(server, alice.did, alice.signer, 'https://example.com/first');
        expect((await first.json()).result.reply.status.code).toBe(202);

        const second = await sendProtocolsConfigure(server, alice.did, alice.signer, 'https://example.com/second');
        const secondBody = await second.json();
        expect(secondBody.error.message).toContain('TenantMessageQuotaExceeded');
      } finally {
        await server.stop();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should restore persisted tenant quota enforcement without enabling the admin API', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'dwn-persisted-quota-'));
      const storageUrl = `sqlite://${tmpDir}/dwn.db`;
      const serverConfig = {
        ...dwnServerConfig,
        adminToken                : undefined,
        allowOpenTenants          : false,
        allowUnboundedTenantUsage : true,
        dataStore                 : storageUrl,
        messageStore              : storageUrl,
        quotaMaxMessages          : 0,
        quotaMaxStorageBytes      : 0,
        registrationStoreUrl      : storageUrl,
        resumableTaskStore        : storageUrl,
        ttlCacheUrl               : storageUrl,
      };
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const dialect = await runServerMigrationsIfNeeded(serverConfig);
      if (dialect === undefined) {
        throw new Error('expected a SQL server dialect');
      }
      const registrationStore = await RegistrationStore.create(dialect);
      await registrationStore.insertOrUpdateTenantRegistration({ did: alice.did });
      await registrationStore.setQuota({
        did             : alice.did,
        maxMessages     : 1,
        maxStorageBytes : 1024,
      });

      const server = new DwnServer({ config: serverConfig });
      try {
        await server.start();

        const first = await sendProtocolsConfigure(server, alice.did, alice.signer, 'https://example.com/persisted-first');
        expect((await first.json()).result.reply.status.code).toBe(202);

        const second = await sendProtocolsConfigure(server, alice.did, alice.signer, 'https://example.com/persisted-second');
        expect((await second.json()).error.message).toContain('TenantMessageQuotaExceeded');
      } finally {
        await server.stop();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should preserve persisted quota checks when startup is retried', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'dwn-quota-retry-'));
      const registrationUrl = `sqlite://${tmpDir}/registration.db`;
      const serverConfig = {
        ...dwnServerConfig,
        adminToken                : undefined,
        allowOpenTenants          : false,
        allowUnboundedTenantUsage : true,
        dataStore                 : `level://${tmpDir}/data`,
        messageStore              : `level://${tmpDir}/messages`,
        quotaMaxMessages          : 0,
        quotaMaxStorageBytes      : 0,
        registrationStoreUrl      : registrationUrl,
        resumableTaskStore        : `level://${tmpDir}/tasks`,
        ttlCacheUrl               : registrationUrl,
      };
      const dialect = await runServerMigrationsIfNeeded(serverConfig);
      if (dialect === undefined) {
        throw new Error('expected a SQL server dialect');
      }
      const registrationStore = await RegistrationStore.create(dialect);
      await registrationStore.insertOrUpdateTenantRegistration({ did: 'did:test:quota-retry' });
      await registrationStore.setQuota({
        did             : 'did:test:quota-retry',
        maxMessages     : 1,
        maxStorageBytes : 1,
      });

      const server = new DwnServer({ config: serverConfig });
      try {
        await expect(server.start()).rejects.toThrow('finite tenant quotas require DWN_STORAGE_MESSAGES');
        await expect(server.start()).rejects.toThrow('finite tenant quotas require DWN_STORAGE_MESSAGES');
      } finally {
        await server.dwn?.close();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
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
          allowOpenTenants          : false,
          allowUnboundedTenantUsage : false,
          hostname                  : '127.0.0.1',
          localNodeProfileEnabled   : true,
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
