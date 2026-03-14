import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { encodeDwnDiscoveryPayload } from '@enbox/agent';

import { AuthEventEmitter } from '../src/events.js';
import { createMockAgent } from './helpers/mock-agent.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';
import {
  applyLocalDwnDiscovery,
  checkUrlForDwnDiscoveryPayload,
  clearLocalDwnEndpoint,
  persistLocalDwnEndpoint,
  requestLocalDwnDiscovery,
  restoreLocalDwnEndpoint,
} from '../src/discovery.js';

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

  test('should emit local-dwn-available when discovery succeeds via URL fragment', async () => {
    const url = buildUrlWithPayload('http://127.0.0.1:55500');

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
    const emitter = new AuthEventEmitter();
    const events: { endpoint: string }[] = [];
    emitter.on('local-dwn-available', (payload) => { events.push(payload); });

    const agent = createMockAgent({
      dwnSetCachedLocalDwnEndpoint: async (): Promise<boolean> => true,
    });

    await applyLocalDwnDiscovery(agent, storage, emitter);

    expect(events).toHaveLength(1);
    expect(events[0].endpoint).toBe('http://127.0.0.1:55500');
  });

  test('should emit local-dwn-unavailable when no endpoint is found', async () => {
    delete (globalThis as any).location;

    const storage = new MemoryStorage();
    const emitter = new AuthEventEmitter();
    const events: Record<string, never>[] = [];
    emitter.on('local-dwn-unavailable', (payload) => { events.push(payload); });

    const agent = createMockAgent();

    await applyLocalDwnDiscovery(agent, storage, emitter);

    expect(events).toHaveLength(1);
  });

  test('should emit local-dwn-available when restoring from storage', async () => {
    delete (globalThis as any).location;

    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, 'http://127.0.0.1:3000');

    const emitter = new AuthEventEmitter();
    const events: { endpoint: string }[] = [];
    emitter.on('local-dwn-available', (payload) => { events.push(payload); });

    const agent = createMockAgent({
      dwnSetCachedLocalDwnEndpoint: async (): Promise<boolean> => true,
    });

    await applyLocalDwnDiscovery(agent, storage, emitter);

    expect(events).toHaveLength(1);
    expect(events[0].endpoint).toBe('http://127.0.0.1:3000');
  });
});

// ─── requestLocalDwnDiscovery ───────────────────────────────────────

describe('requestLocalDwnDiscovery', () => {
  let originalLocation: Location | undefined;
  let originalOpen: typeof globalThis.open | undefined;

  beforeEach(() => {
    originalLocation = globalThis.location;
    originalOpen = globalThis.open;
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
    if (originalOpen !== undefined) {
      Object.defineProperty(globalThis, 'open', {
        value        : originalOpen,
        writable     : true,
        configurable : true,
      });
    } else {
      delete (globalThis as any).open;
    }
  });

  test('should return false when no location and no callback provided', () => {
    delete (globalThis as any).location;
    delete (globalThis as any).open;

    expect(requestLocalDwnDiscovery()).toBe(false);
  });

  test('should open a dwn://connect URL via globalThis.open', () => {
    const openedUrls: string[] = [];
    Object.defineProperty(globalThis, 'open', {
      value        : (url: string): void => { openedUrls.push(url); },
      writable     : true,
      configurable : true,
    });

    const result = requestLocalDwnDiscovery('https://myapp.com/callback');

    expect(result).toBe(true);
    expect(openedUrls).toHaveLength(1);
    expect(openedUrls[0]).toBe('dwn://connect?callback=https%3A%2F%2Fmyapp.com%2Fcallback');
  });

  test('should default callback to current page URL', () => {
    Object.defineProperty(globalThis, 'location', {
      value        : { href: 'https://myapp.com/dashboard#old' },
      writable     : true,
      configurable : true,
    });

    const openedUrls: string[] = [];
    Object.defineProperty(globalThis, 'open', {
      value        : (url: string): void => { openedUrls.push(url); },
      writable     : true,
      configurable : true,
    });

    const result = requestLocalDwnDiscovery();

    expect(result).toBe(true);
    expect(openedUrls).toHaveLength(1);
    // Should use the page URL without the fragment.
    expect(openedUrls[0]).toBe('dwn://connect?callback=https%3A%2F%2Fmyapp.com%2Fdashboard');
  });

  test('should fall back to location.href when open is unavailable', () => {
    delete (globalThis as any).open;
    const hrefValues: string[] = [];

    Object.defineProperty(globalThis, 'location', {
      value: {
        href : 'https://myapp.com/page',
        set  : undefined,
      },
      writable     : true,
      configurable : true,
    });
    // Override href to be a setter.
    Object.defineProperty(globalThis.location, 'href', {
      set          : (v: string): void => { hrefValues.push(v); },
      get          : (): string => 'https://myapp.com/page',
      configurable : true,
    });

    const result = requestLocalDwnDiscovery('https://myapp.com/callback');

    expect(result).toBe(true);
    expect(hrefValues).toHaveLength(1);
    expect(hrefValues[0]).toContain('dwn://connect');
  });
});
