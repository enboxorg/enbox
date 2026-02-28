import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { encodeDwnDiscoveryPayload } from '@enbox/agent';

import { createMockAgent } from './helpers/mock-agent.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';
import {
  applyLocalDwnDiscovery,
  checkUrlForDwnDiscoveryPayload,
  clearLocalDwnEndpoint,
  persistLocalDwnEndpoint,
  restoreLocalDwnEndpoint,
} from '../src/flows/dwn-discovery.js';

// ─── Helpers ────────────────────────────────────────────────────────

/** Build a fake page URL with a DWN discovery payload in the fragment. */
function buildUrlWithPayload(endpoint: string): string {
  const encoded = encodeDwnDiscoveryPayload({ endpoint });
  return `https://myapp.example.com/callback#${encoded}`;
}

// ─── checkUrlForDwnDiscoveryPayload ─────────────────────────────────

describe('checkUrlForDwnDiscoveryPayload', () => {
  let originalLocation: Location | undefined;
  let originalHistory: History | undefined;

  beforeEach(() => {
    originalLocation = globalThis.location;
    originalHistory = globalThis.history;
  });

  afterEach(() => {
    // Restore globalThis.location
    if (originalLocation !== undefined) {
      Object.defineProperty(globalThis, 'location', {
        value        : originalLocation,
        writable     : true,
        configurable : true,
      });
    } else {
      delete (globalThis as any).location;
    }
    // Restore globalThis.history
    if (originalHistory !== undefined) {
      Object.defineProperty(globalThis, 'history', {
        value        : originalHistory,
        writable     : true,
        configurable : true,
      });
    } else {
      delete (globalThis as any).history;
    }
  });

  test('should return undefined when globalThis.location is undefined', () => {
    // In Bun/Node, globalThis.location is typically undefined
    delete (globalThis as any).location;
    expect(checkUrlForDwnDiscoveryPayload()).toBeUndefined();
  });

  test('should return the endpoint from a valid payload in the URL fragment', () => {
    const url = buildUrlWithPayload('http://127.0.0.1:55557');
    const replaceStateCalls: any[] = [];

    Object.defineProperty(globalThis, 'location', {
      value        : { href: url },
      writable     : true,
      configurable : true,
    });
    Object.defineProperty(globalThis, 'history', {
      value        : { replaceState: (...args: any[]): void => { replaceStateCalls.push(args); } },
      writable     : true,
      configurable : true,
    });

    const result = checkUrlForDwnDiscoveryPayload();
    expect(result).toBe('http://127.0.0.1:55557');

    // Should have cleared the fragment via history.replaceState
    expect(replaceStateCalls).toHaveLength(1);
    expect(replaceStateCalls[0][2]).toBe('https://myapp.example.com/callback');
  });

  test('should return undefined when URL has no fragment', () => {
    Object.defineProperty(globalThis, 'location', {
      value        : { href: 'https://myapp.example.com/page' },
      writable     : true,
      configurable : true,
    });
    Object.defineProperty(globalThis, 'history', {
      value        : { replaceState: (): void => {} },
      writable     : true,
      configurable : true,
    });

    expect(checkUrlForDwnDiscoveryPayload()).toBeUndefined();
  });

  test('should return undefined when fragment contains invalid data', () => {
    Object.defineProperty(globalThis, 'location', {
      value        : { href: 'https://myapp.example.com/page#not-valid-base64url' },
      writable     : true,
      configurable : true,
    });
    Object.defineProperty(globalThis, 'history', {
      value        : { replaceState: (): void => {} },
      writable     : true,
      configurable : true,
    });

    expect(checkUrlForDwnDiscoveryPayload()).toBeUndefined();
  });

  test('should not clear fragment when history.replaceState is unavailable', () => {
    const url = buildUrlWithPayload('http://localhost:3000');

    Object.defineProperty(globalThis, 'location', {
      value        : { href: url },
      writable     : true,
      configurable : true,
    });
    // No history object
    delete (globalThis as any).history;

    const result = checkUrlForDwnDiscoveryPayload();
    expect(result).toBe('http://localhost:3000');
  });
});

// ─── persistLocalDwnEndpoint / clearLocalDwnEndpoint ────────────────

describe('persistLocalDwnEndpoint / clearLocalDwnEndpoint', () => {
  test('should persist and retrieve an endpoint', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnEndpoint(storage, 'http://127.0.0.1:55557');
    expect(await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT)).toBe('http://127.0.0.1:55557');
  });

  test('should clear a persisted endpoint', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnEndpoint(storage, 'http://127.0.0.1:55557');
    await clearLocalDwnEndpoint(storage);
    expect(await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT)).toBeNull();
  });
});

// ─── restoreLocalDwnEndpoint ────────────────────────────────────────

describe('restoreLocalDwnEndpoint', () => {
  test('should return false when no endpoint is stored', async () => {
    const storage = new MemoryStorage();
    const agent = createMockAgent();

    const result = await restoreLocalDwnEndpoint(agent, storage);
    expect(result).toBe(false);
  });

  test('should return true and inject endpoint when stored and agent accepts it', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, 'http://127.0.0.1:55557');

    const setCalls: string[] = [];
    const agent = createMockAgent({
      dwnSetCachedLocalDwnEndpoint: async (endpoint): Promise<boolean> => {
        setCalls.push(endpoint);
        return true;
      },
    });

    const result = await restoreLocalDwnEndpoint(agent, storage);
    expect(result).toBe(true);
    expect(setCalls).toEqual(['http://127.0.0.1:55557']);

    // Endpoint should still be in storage
    expect(await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT)).toBe('http://127.0.0.1:55557');
  });

  test('should clear stale endpoint from storage when agent rejects it', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, 'http://127.0.0.1:9999');

    const agent = createMockAgent({
      dwnSetCachedLocalDwnEndpoint: async (): Promise<boolean> => false,
    });

    const result = await restoreLocalDwnEndpoint(agent, storage);
    expect(result).toBe(false);

    // Stale endpoint should be removed
    expect(await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT)).toBeNull();
  });
});

// ─── applyLocalDwnDiscovery ─────────────────────────────────────────

describe('applyLocalDwnDiscovery', () => {
  let originalLocation: Location | undefined;
  let originalHistory: History | undefined;

  beforeEach(() => {
    originalLocation = globalThis.location;
    originalHistory = globalThis.history;
  });

  afterEach(() => {
    if (originalLocation !== undefined) {
      Object.defineProperty(globalThis, 'location', {
        value        : originalLocation,
        writable     : true,
        configurable : true,
      });
    } else {
      delete (globalThis as any).location;
    }
    if (originalHistory !== undefined) {
      Object.defineProperty(globalThis, 'history', {
        value        : originalHistory,
        writable     : true,
        configurable : true,
      });
    } else {
      delete (globalThis as any).history;
    }
  });

  test('should return false when no URL payload and no stored endpoint', async () => {
    delete (globalThis as any).location;

    const storage = new MemoryStorage();
    const agent = createMockAgent();

    const result = await applyLocalDwnDiscovery(agent, storage);
    expect(result).toBe(false);
  });

  test('should inject and persist a fresh endpoint from the URL fragment', async () => {
    const url = buildUrlWithPayload('http://127.0.0.1:55557');

    Object.defineProperty(globalThis, 'location', {
      value        : { href: url },
      writable     : true,
      configurable : true,
    });
    Object.defineProperty(globalThis, 'history', {
      value        : { replaceState: (): void => {} },
      writable     : true,
      configurable : true,
    });

    const storage = new MemoryStorage();
    const setCalls: string[] = [];
    const agent = createMockAgent({
      dwnSetCachedLocalDwnEndpoint: async (endpoint): Promise<boolean> => {
        setCalls.push(endpoint);
        return true;
      },
    });

    const result = await applyLocalDwnDiscovery(agent, storage);
    expect(result).toBe(true);
    expect(setCalls).toEqual(['http://127.0.0.1:55557']);

    // Endpoint should be persisted in storage
    expect(await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT)).toBe('http://127.0.0.1:55557');
  });

  test('should fall back to stored endpoint when URL fragment has no payload', async () => {
    delete (globalThis as any).location;

    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, 'http://127.0.0.1:3000');

    const setCalls: string[] = [];
    const agent = createMockAgent({
      dwnSetCachedLocalDwnEndpoint: async (endpoint): Promise<boolean> => {
        setCalls.push(endpoint);
        return true;
      },
    });

    const result = await applyLocalDwnDiscovery(agent, storage);
    expect(result).toBe(true);
    expect(setCalls).toEqual(['http://127.0.0.1:3000']);
  });

  test('should prefer fresh URL payload over stored endpoint', async () => {
    const url = buildUrlWithPayload('http://127.0.0.1:55557');

    Object.defineProperty(globalThis, 'location', {
      value        : { href: url },
      writable     : true,
      configurable : true,
    });
    Object.defineProperty(globalThis, 'history', {
      value        : { replaceState: (): void => {} },
      writable     : true,
      configurable : true,
    });

    const storage = new MemoryStorage();
    // Pre-populate with a different endpoint
    await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, 'http://127.0.0.1:3000');

    const setCalls: string[] = [];
    const agent = createMockAgent({
      dwnSetCachedLocalDwnEndpoint: async (endpoint): Promise<boolean> => {
        setCalls.push(endpoint);
        return true;
      },
    });

    const result = await applyLocalDwnDiscovery(agent, storage);
    expect(result).toBe(true);
    // Should have used the fresh URL endpoint, not the stored one
    expect(setCalls).toEqual(['http://127.0.0.1:55557']);
    // Storage should be updated to the new endpoint
    expect(await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT)).toBe('http://127.0.0.1:55557');
  });

  test('should fall through to stored endpoint when fresh URL endpoint is rejected', async () => {
    const url = buildUrlWithPayload('http://127.0.0.1:55557');

    Object.defineProperty(globalThis, 'location', {
      value        : { href: url },
      writable     : true,
      configurable : true,
    });
    Object.defineProperty(globalThis, 'history', {
      value        : { replaceState: (): void => {} },
      writable     : true,
      configurable : true,
    });

    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, 'http://127.0.0.1:3000');

    let callCount = 0;
    const agent = createMockAgent({
      dwnSetCachedLocalDwnEndpoint: async (endpoint): Promise<boolean> => {
        callCount++;
        // Reject the first (fresh URL) call, accept the second (stored) call
        if (endpoint === 'http://127.0.0.1:55557') { return false; }
        return true;
      },
    });

    const result = await applyLocalDwnDiscovery(agent, storage);
    expect(result).toBe(true);
    // Called twice: once for fresh URL, once for stored
    expect(callCount).toBe(2);
  });

  test('should return false when both fresh URL and stored endpoints are rejected', async () => {
    const url = buildUrlWithPayload('http://127.0.0.1:55557');

    Object.defineProperty(globalThis, 'location', {
      value        : { href: url },
      writable     : true,
      configurable : true,
    });
    Object.defineProperty(globalThis, 'history', {
      value        : { replaceState: (): void => {} },
      writable     : true,
      configurable : true,
    });

    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, 'http://127.0.0.1:3000');

    const agent = createMockAgent({
      dwnSetCachedLocalDwnEndpoint: async (): Promise<boolean> => false,
    });

    const result = await applyLocalDwnDiscovery(agent, storage);
    expect(result).toBe(false);

    // The stale stored endpoint should be removed
    expect(await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT)).toBeNull();
  });
});
