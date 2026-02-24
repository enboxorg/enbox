import { afterEach, describe, expect, it } from 'bun:test';

import { getRelayConfig, parseDuration } from '../src/config.js';

describe('parseDuration', () => {
  it('should parse milliseconds (no suffix)', () => {
    expect(parseDuration('1000')).toBe(1000);
    expect(parseDuration('0')).toBe(0);
    expect(parseDuration('500')).toBe(500);
  });

  it('should parse explicit ms suffix', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('1000ms')).toBe(1000);
  });

  it('should parse seconds', () => {
    expect(parseDuration('1s')).toBe(1_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('3600s')).toBe(3_600_000);
  });

  it('should parse minutes', () => {
    expect(parseDuration('1m')).toBe(60_000);
    expect(parseDuration('30m')).toBe(1_800_000);
  });

  it('should parse hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('72h')).toBe(259_200_000);
    expect(parseDuration('24h')).toBe(86_400_000);
  });

  it('should parse days', () => {
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('30d')).toBe(2_592_000_000);
  });

  it('should handle fractional values', () => {
    expect(parseDuration('1.5h')).toBe(5_400_000);
    expect(parseDuration('0.5d')).toBe(43_200_000);
  });

  it('should be case-insensitive', () => {
    expect(parseDuration('72H')).toBe(parseDuration('72h'));
    expect(parseDuration('7D')).toBe(parseDuration('7d'));
    expect(parseDuration('30S')).toBe(parseDuration('30s'));
    expect(parseDuration('5M')).toBe(parseDuration('5m'));
  });

  it('should handle whitespace', () => {
    expect(parseDuration(' 72h ')).toBe(259_200_000);
    expect(parseDuration('  1d  ')).toBe(86_400_000);
  });

  it('should throw on invalid format', () => {
    expect(() => parseDuration('')).toThrow('Invalid duration');
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
    expect(() => parseDuration('h')).toThrow('Invalid duration');
    expect(() => parseDuration('10x')).toThrow('Invalid duration');
  });
});

describe('getRelayConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('DWN_RELAY_') || key === 'DWN_BASE_URL') {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('should return sensible defaults', () => {
    const config = getRelayConfig();
    expect(config.dataRetention).toBe('72h');
    expect(config.storageMaxBytes).toBe(0);
    expect(config.ipfsGatewayUrl).toBeUndefined();
    expect(config.syncWorkers).toBe(8);
    expect(config.syncIntervalSeconds).toBe(30);
    expect(config.protocolPolicies).toEqual({});
    expect(config.evictionIntervalSeconds).toBe(60);
    expect(config.evictionHighWaterMark).toBe(0.9);
    expect(config.evictionLowWaterMark).toBe(0.7);
    expect(config.readProxyTimeoutMs).toBe(15000);
    expect(config.readProxyCacheLocally).toBe(true);
  });

  it('should read values from environment variables', () => {
    process.env.DWN_RELAY_DATA_RETENTION = '24h';
    process.env.DWN_RELAY_STORAGE_MAX_BYTES = '50000000000';
    process.env.DWN_RELAY_IPFS_GATEWAY = 'http://localhost:8080';
    process.env.DWN_RELAY_SYNC_WORKERS = '4';
    process.env.DWN_RELAY_SYNC_INTERVAL = '60';
    process.env.DWN_RELAY_EVICTION_INTERVAL = '120';
    process.env.DWN_RELAY_EVICTION_HIGH_WATER = '0.85';
    process.env.DWN_RELAY_EVICTION_LOW_WATER = '0.6';
    process.env.DWN_RELAY_READ_PROXY_TIMEOUT_MS = '10000';
    process.env.DWN_BASE_URL = 'https://relay.example.com';

    const config = getRelayConfig();
    expect(config.dataRetention).toBe('24h');
    expect(config.storageMaxBytes).toBe(50_000_000_000);
    expect(config.ipfsGatewayUrl).toBe('http://localhost:8080');
    expect(config.syncWorkers).toBe(4);
    expect(config.syncIntervalSeconds).toBe(60);
    expect(config.evictionIntervalSeconds).toBe(120);
    expect(config.evictionHighWaterMark).toBe(0.85);
    expect(config.evictionLowWaterMark).toBe(0.6);
    expect(config.readProxyTimeoutMs).toBe(10000);
    expect(config.selfUrl).toBe('https://relay.example.com');
  });

  it('should parse protocol policies from JSON', () => {
    process.env.DWN_RELAY_PROTOCOL_POLICIES = JSON.stringify({
      'https://example.com/chat'  : '7d',
      'https://example.com/media' : '24h',
    });

    const config = getRelayConfig();
    expect(config.protocolPolicies).toEqual({
      'https://example.com/chat'  : '7d',
      'https://example.com/media' : '24h',
    });
  });

  it('should handle invalid protocol policies JSON gracefully', () => {
    process.env.DWN_RELAY_PROTOCOL_POLICIES = 'not valid json';
    const config = getRelayConfig();
    expect(config.protocolPolicies).toEqual({});
  });

  it('should treat DWN_RELAY_READ_PROXY_CACHE=false as false', () => {
    process.env.DWN_RELAY_READ_PROXY_CACHE = 'false';
    const config = getRelayConfig();
    expect(config.readProxyCacheLocally).toBe(false);
  });

  it('should treat any other DWN_RELAY_READ_PROXY_CACHE value as true', () => {
    process.env.DWN_RELAY_READ_PROXY_CACHE = 'true';
    expect(getRelayConfig().readProxyCacheLocally).toBe(true);

    process.env.DWN_RELAY_READ_PROXY_CACHE = '1';
    expect(getRelayConfig().readProxyCacheLocally).toBe(true);
  });
});
