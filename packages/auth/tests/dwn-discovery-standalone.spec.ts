/**
 * Tests for discoverLocalDwn() — the standalone pre-agent discovery function.
 *
 * Needs module-level mocking of EnboxRpcClient (from @enbox/dwn-clients)
 * so we keep it in a dedicated file to avoid polluting other tests.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';

// ── Module-level mock for EnboxRpcClient ────────────────────────
const actualDwnClients = await import('@enbox/dwn-clients');

/** Stub that controls what getServerInfo returns. */
let mockGetServerInfo = mock(async (_url: string) => ({
  server                   : '@enbox/dwn-server',
  registrationRequirements : [],
  maxFileSize              : 10_000_000,
  sdkVersion               : '0.0.1',
  url                      : 'http://127.0.0.1:55557',
  version                  : '0.0.1',
  webSocketSupport         : true,
}));

mock.module('@enbox/dwn-clients', () => ({
  ...actualDwnClients,
  EnboxRpcClient: class MockEnboxRpcClient {
    getServerInfo = mockGetServerInfo;
  },
}));

// Import AFTER mocks are registered.
const { discoverLocalDwn } = await import('../src/flows/dwn-discovery.js');

// ── Helpers ─────────────────────────────────────────────────────
let originalLocation: Location | undefined;
let originalHistory: History | undefined;

function setFakeLocation(href: string): void {
  Object.defineProperty(globalThis, 'location', {
    value: {
      href,
      origin       : new URL(href).origin,
      hash         : new URL(href).hash,
      replaceState : (): void => {},
    },
    writable     : true,
    configurable : true,
  });
  Object.defineProperty(globalThis, 'history', {
    value        : { replaceState: (): void => {} },
    writable     : true,
    configurable : true,
  });
}

function clearLocation(): void {
  if (originalLocation !== undefined) {
    Object.defineProperty(globalThis, 'location', {
      value: originalLocation, writable: true, configurable: true,
    });
  } else {
    delete (globalThis as any).location;
  }
  if (originalHistory !== undefined) {
    Object.defineProperty(globalThis, 'history', {
      value: originalHistory, writable: true, configurable: true,
    });
  } else {
    delete (globalThis as any).history;
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe('discoverLocalDwn', () => {
  beforeEach(() => {
    originalLocation = globalThis.location;
    originalHistory = globalThis.history;
    // Reset mock to default success behavior.
    mockGetServerInfo = mock(async () => ({
      server                   : '@enbox/dwn-server',
      registrationRequirements : [],
      maxFileSize              : 10_000_000,
      sdkVersion               : '0.0.1',
      url                      : 'http://127.0.0.1:55557',
      version                  : '0.0.1',
      webSocketSupport         : true,
    }));
  });

  afterEach(() => {
    clearLocation();
  });

  test('returns undefined when no discovery channels find an endpoint', async () => {
    // No URL fragment, no persisted endpoint.
    delete (globalThis as any).location;
    const storage = new MemoryStorage();
    const result = await discoverLocalDwn(storage);
    expect(result).toBeUndefined();
  });

  test('discovers endpoint from URL fragment and persists it', async () => {
    const { encodeDwnDiscoveryPayload } = await import('@enbox/agent');
    const endpoint = 'http://127.0.0.1:55557';
    const encoded = encodeDwnDiscoveryPayload({ endpoint });
    setFakeLocation(`https://myapp.example.com/callback#${encoded}`);

    const storage = new MemoryStorage();
    const result = await discoverLocalDwn(storage);

    expect(result).toBe(endpoint);
    // Should have been persisted.
    const persisted = await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT);
    expect(persisted).toBe(endpoint);
  });

  test('returns undefined when URL fragment endpoint fails validation', async () => {
    const { encodeDwnDiscoveryPayload } = await import('@enbox/agent');
    const endpoint = 'http://127.0.0.1:55557';
    const encoded = encodeDwnDiscoveryPayload({ endpoint });
    setFakeLocation(`https://myapp.example.com/callback#${encoded}`);

    // Make validation fail.
    mockGetServerInfo = mock(async () => { throw new Error('unreachable'); });

    const storage = new MemoryStorage();
    const result = await discoverLocalDwn(storage);
    expect(result).toBeUndefined();
  });

  test('restores endpoint from storage and validates it', async () => {
    delete (globalThis as any).location;
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, 'http://127.0.0.1:55557');

    const result = await discoverLocalDwn(storage);
    expect(result).toBe('http://127.0.0.1:55557');
  });

  test('clears stale endpoint from storage when validation fails', async () => {
    delete (globalThis as any).location;
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, 'http://127.0.0.1:55557');

    // Make validation fail.
    mockGetServerInfo = mock(async () => { throw new Error('server down'); });

    const result = await discoverLocalDwn(storage);
    expect(result).toBeUndefined();
    // Stale endpoint should have been cleared.
    const persisted = await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT);
    expect(persisted).toBeNull();
  });

  test('returns undefined when server name does not match', async () => {
    delete (globalThis as any).location;
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, 'http://127.0.0.1:55557');

    // Server is reachable but is not ours.
    mockGetServerInfo = mock(async () => ({
      server                   : 'some-other-server',
      registrationRequirements : [],
      maxFileSize              : 10_000_000,
      sdkVersion               : '0.0.1',
      url                      : 'http://127.0.0.1:55557',
      version                  : '0.0.1',
      webSocketSupport         : true,
    }));

    const result = await discoverLocalDwn(storage);
    expect(result).toBeUndefined();
  });

  test('URL fragment takes priority over persisted endpoint', async () => {
    const { encodeDwnDiscoveryPayload } = await import('@enbox/agent');
    const freshEndpoint = 'http://127.0.0.1:55558';
    const encoded = encodeDwnDiscoveryPayload({ endpoint: freshEndpoint });
    setFakeLocation(`https://myapp.example.com/callback#${encoded}`);

    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, 'http://127.0.0.1:55557');

    const result = await discoverLocalDwn(storage);
    // Should use the fresh endpoint from URL fragment, not the cached one.
    expect(result).toBe(freshEndpoint);
  });
});
