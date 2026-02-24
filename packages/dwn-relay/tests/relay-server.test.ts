import type { DwnServerConfig } from '@enbox/dwn-server';

import { join } from 'path';
import { mkdtempSync } from 'fs';
import sinon from 'sinon';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'bun:test';

import { defaultDwnServerConfig } from '@enbox/dwn-server';
import { getTestRelayConfig } from './test-utils.js';
import { RelayDataStore } from '../src/stores/relay-data-store.js';
import { RelayServer } from '../src/relay-server.js';

/**
 * Create a server config that uses Level stores in a temp directory.
 * This avoids SQL migration overhead and database connections.
 */
function getTestServerConfig(): DwnServerConfig {
  const tmp = mkdtempSync(join(tmpdir(), 'relay-test-'));
  return {
    ...defaultDwnServerConfig,
    logLevel           : 'SILENT',
    forwardingEnabled  : true,
    deliveryEnabled    : false,
    webSocketSupport   : false,
    messageStore       : `level://${join(tmp, 'messages')}`,
    dataStore          : `level://${join(tmp, 'data')}`,
    stateIndex         : `level://${join(tmp, 'state')}`,
    resumableTaskStore : `level://${join(tmp, 'tasks')}`,
    port               : 0, // Let OS pick an available port
  };
}

describe('RelayServer', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('create', () => {
    it('should create with default relay config', async () => {
      const server = await RelayServer.create({
        relayConfig  : getTestRelayConfig(),
        serverConfig : getTestServerConfig(),
      });
      expect(server).toBeDefined();
      expect(server.relayConfig).toBeDefined();
      expect(server.relayConfig.dataRetention).toBeDefined();
      await server.stop();
    });

    it('should accept custom relay config', async () => {
      const config = getTestRelayConfig();
      config.dataRetention = '24h';
      const server = await RelayServer.create({
        relayConfig  : config,
        serverConfig : getTestServerConfig(),
      });
      expect(server.relayConfig.dataRetention).toBe('24h');
      await server.stop();
    });
  });

  describe('wiring', () => {
    it('should create a RelayDataStore wrapping the real DataStore', async () => {
      const server = await RelayServer.create({
        relayConfig  : getTestRelayConfig(),
        serverConfig : getTestServerConfig(),
      });
      expect(server.relayDataStore).toBeInstanceOf(RelayDataStore);
      await server.stop();
    });

    it('should create an EvictionManager at construction time', async () => {
      const server = await RelayServer.create({
        relayConfig  : getTestRelayConfig(),
        serverConfig : getTestServerConfig(),
      });
      expect(server.evictionManager).toBeDefined();
      await server.stop();
    });

    it('should have syncEngine undefined before start()', async () => {
      const server = await RelayServer.create({
        relayConfig  : getTestRelayConfig(),
        serverConfig : getTestServerConfig(),
      });
      expect(server.syncEngine).toBeUndefined();
      await server.stop();
    });
  });

  describe('accessors', () => {
    it('should expose server and relayDataStore', async () => {
      const server = await RelayServer.create({
        relayConfig  : getTestRelayConfig(),
        serverConfig : getTestServerConfig(),
      });
      expect(server.server).toBeDefined();
      expect(server.relayDataStore).toBeDefined();
      await server.stop();
    });
  });

  describe('stop', () => {
    it('should stop without error even if never started', async () => {
      const server = await RelayServer.create({
        relayConfig  : getTestRelayConfig(),
        serverConfig : getTestServerConfig(),
      });
      await server.stop();
    });
  });
});
