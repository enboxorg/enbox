import { describe, expect, it } from 'bun:test';

import { createLocalNodeDwnServerConfig, defaultLocalNodeHostname } from '../src/local-node-config.js';

describe('createLocalNodeDwnServerConfig', () => {
  it('should enable the local-node profile with loopback defaults', () => {
    const config = createLocalNodeDwnServerConfig({ port: 55500 });

    expect(config.baseUrl).toBe('http://127.0.0.1:55500');
    expect(config.hostname).toBe(defaultLocalNodeHostname);
    expect(config.localNodeProfileEnabled).toBe(true);
    expect(config.localNodeAllowedOrigins).toEqual([]);
    expect(config.forwardingEnabled).toBe(true);
    expect(config.deliveryEnabled).toBe(true);
  });

  it('should apply caller-provided local-node server options', () => {
    const config = createLocalNodeDwnServerConfig({
      allowedOrigins   : ['https://app.example'],
      baseUrl          : 'http://localhost:55501',
      hostname         : 'localhost',
      port             : 55501,
      storageUrl       : 'level://custom-data',
      webSocketSupport : false,
    });

    expect(config.baseUrl).toBe('http://localhost:55501');
    expect(config.dataStore).toBe('level://custom-data');
    expect(config.hostname).toBe('localhost');
    expect(config.localNodeAllowedOrigins).toEqual(['https://app.example']);
    expect(config.messageStore).toBe('level://custom-data');
    expect(config.resumableTaskStore).toBe('level://custom-data');
    expect(config.webSocketSupport).toBe(false);
  });
});
