import { afterEach, describe, expect, it } from 'bun:test';
import sinon from 'sinon';

import { RelayServer } from '../src/relay-server.js';
import { RelayDataStore } from '../src/stores/relay-data-store.js';
import { createMockDataStore, getTestRelayConfig } from './test-utils.js';

describe('RelayServer', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('constructor', () => {
    it('should create with default config', () => {
      const server = new RelayServer();
      expect(server).toBeDefined();
      expect(server.relayConfig).toBeDefined();
      expect(server.relayConfig.dataRetention).toBeDefined();
    });

    it('should accept custom relay config', () => {
      const config = getTestRelayConfig();
      const server = new RelayServer({ relayConfig: config });
      expect(server.relayConfig).toBe(config);
      expect(server.relayConfig.dataRetention).toBe('72h');
    });
  });

  describe('wrapDataStore', () => {
    it('should wrap a DataStore with RelayDataStore', () => {
      const server = new RelayServer({ relayConfig: getTestRelayConfig() });
      const inner = createMockDataStore();
      const wrapped = server.wrapDataStore(inner);

      expect(wrapped).toBeInstanceOf(RelayDataStore);
      expect(server.relayDataStore).toBe(wrapped);
    });

    it('should create an EvictionManager after wrapping', () => {
      const server = new RelayServer({ relayConfig: getTestRelayConfig() });
      expect(server.evictionManager).toBeUndefined();

      const inner = createMockDataStore();
      server.wrapDataStore(inner);

      expect(server.evictionManager).toBeDefined();
    });
  });

  describe('onMessageProcessed', () => {
    it('should not forward non-202 status codes', async () => {
      const config = getTestRelayConfig();
      const server = new RelayServer({ relayConfig: config });

      // Should not throw even with no write forwarder initialized
      await server.onMessageProcessed(
        'did:test:tenant',
        { descriptor: { interface: 'Records', method: 'Write', messageTimestamp: '' } } as any,
        400,
      );
    });

    it('should not forward non-Records interfaces', async () => {
      const config = getTestRelayConfig();
      const server = new RelayServer({ relayConfig: config });

      await server.onMessageProcessed(
        'did:test:tenant',
        { descriptor: { interface: 'Protocols', method: 'Configure', messageTimestamp: '' } } as any,
        202,
      );
    });

    it('should not forward non-Write/Delete methods', async () => {
      const config = getTestRelayConfig();
      const server = new RelayServer({ relayConfig: config });

      await server.onMessageProcessed(
        'did:test:tenant',
        { descriptor: { interface: 'Records', method: 'Read', messageTimestamp: '' } } as any,
        202,
      );
    });
  });

  describe('accessors', () => {
    it('should expose server, syncEngine, readProxy, writeForwarder as initially undefined', () => {
      const server = new RelayServer({ relayConfig: getTestRelayConfig() });
      expect(server.server).toBeDefined(); // DwnServer is always created
      expect(server.syncEngine).toBeUndefined();
      expect(server.readProxy).toBeUndefined();
      expect(server.writeForwarder).toBeUndefined();
    });
  });

  describe('stop', () => {
    it('should stop without error even if never started', async () => {
      const server = new RelayServer({ relayConfig: getTestRelayConfig() });
      // Should not throw
      await server.stop();
    });
  });
});
