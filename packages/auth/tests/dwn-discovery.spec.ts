import type { ServerInfo } from '@enbox/dwn-clients';

import { describe, expect, test } from 'bun:test';

import { createMockAgent } from './helpers/mock-agent.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';
import {
  applyLocalDwnDiscovery,
  clearLocalDwnEndpoint,
  discoverLocalDwn,
  discoverLocalDwnPairing,
  initiateLocalDwnPairing,
  persistLocalDwnPairingRecord,
  pollLocalDwnPairing,
  probeLocalDwn,
  readLocalDwnPairingRecord,
  requestLocalDwnPairing,
  restoreLocalDwnEndpoint,
} from '../src/discovery.js';

const localNodeInfo: ServerInfo = {
  localNode    : true,
  localPairing : {
    pairUrl         : 'http://127.0.0.1:55500/local/pair',
    pollUrlTemplate : 'http://127.0.0.1:55500/local/pair/{requestId}',
  },
  maxFileSize              : 10_000_000,
  registrationRequirements : [],
  server                   : '@enbox/dwn-server',
  sdkVersion               : '0.0.1',
  url                      : 'http://127.0.0.1:55500',
  version                  : '0.0.1',
  webSocketSupport         : true,
};

const pairingRecord = {
  createdAt    : 123,
  endpoint     : 'http://127.0.0.1:55500',
  pairedOrigin : 'https://app.example',
  token        : 'paired-token',
  version      : 1 as const,
};

let originalLocation: Location | undefined;
let originalNavigator: Navigator | undefined;
let originalIsSecureContext: boolean | undefined;

describe('local-node pairing storage', () => {
  test('persists and reads a versioned pairing record', async () => {
    const storage = new MemoryStorage();

    await persistLocalDwnPairingRecord(storage, {
      ...pairingRecord,
      endpoint: `${pairingRecord.endpoint}/`,
    });

    const raw = await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(pairingRecord);
    expect(await readLocalDwnPairingRecord(storage)).toEqual(pairingRecord);
  });

  test('clears legacy endpoint-only values', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, pairingRecord.endpoint);

    expect(await readLocalDwnPairingRecord(storage)).toBeUndefined();
    expect(await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT)).toBeNull();
  });

  test('clears stale pairing records during passive discovery', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnPairingRecord(storage, pairingRecord);

    const result = await discoverLocalDwnPairing(storage, async (url, init): Promise<Response> => {
      if (url.toString().endsWith('/info')) {
        return jsonResponse(localNodeInfo);
      }

      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer paired-token');
      return jsonResponse({ error: 'Unauthorized' }, 401);
    });

    expect(result).toBeUndefined();
    expect(await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT)).toBeNull();
  });

  test('returns valid stored pairing during passive discovery', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnPairingRecord(storage, pairingRecord);
    const fetchFn = async (url: string | URL | Request): Promise<Response> => {
      return url.toString().endsWith('/info')
        ? jsonResponse(localNodeInfo)
        : jsonResponse({ localNode: true, paired: true });
    };

    const result = await discoverLocalDwnPairing(storage, fetchFn);

    expect(result).toEqual(pairingRecord);

    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      configurable : true,
      value        : fetchFn,
      writable     : true,
    });

    try {
      expect(await discoverLocalDwn(storage)).toBe(pairingRecord.endpoint);
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable : true,
        value        : originalFetch,
        writable     : true,
      });
    }
  });

  test('restores stored pairing endpoint into an agent', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnPairingRecord(storage, pairingRecord);
    const endpoints: string[] = [];
    const agent = createMockAgent({
      dwnSetCachedLocalDwnEndpoint: async (endpoint): Promise<boolean> => {
        endpoints.push(endpoint);
        return true;
      },
    });

    expect(await restoreLocalDwnEndpoint(agent, storage)).toBe(true);
    expect(await applyLocalDwnDiscovery(agent, storage)).toBe(true);
    expect(endpoints).toEqual([pairingRecord.endpoint, pairingRecord.endpoint]);
  });

  test('clears stored pairing when an agent rejects the endpoint', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnPairingRecord(storage, pairingRecord);
    const agent = createMockAgent({
      dwnSetCachedLocalDwnEndpoint: async (): Promise<boolean> => false,
    });

    expect(await restoreLocalDwnEndpoint(agent, storage)).toBe(false);
    expect(await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT)).toBeNull();
  });
});

describe('probeLocalDwn', () => {
  test('returns unsupported in insecure browser contexts', async () => {
    setBrowserGlobals({
      href            : 'http://app.example',
      isSecureContext : false,
      userAgent       : 'Mozilla/5.0 Chrome/120.0',
    });

    try {
      const result = await probeLocalDwn({
        fetch: async (): Promise<Response> => {
          throw new Error('should not fetch');
        },
      });

      expect(result).toEqual({ reason: 'insecure-context', status: 'unsupported' });
    } finally {
      restoreBrowserGlobals();
    }
  });

  test('returns not-found when no candidate port responds', async () => {
    const result = await probeLocalDwn({
      fetch: async (): Promise<Response> => {
        throw new Error('connection refused');
      },
      portCandidates : [55500],
      scanPorts      : true,
    });

    expect(result).toEqual({ status: 'not-found' });
  });

  test('returns found-unpaired for an unpaired local node', async () => {
    const requestedUrls: string[] = [];
    const result = await probeLocalDwn({
      fetch: async (url): Promise<Response> => {
        requestedUrls.push(url.toString());
        return jsonResponse(localNodeInfo);
      },
      portCandidates : [55500],
      scanPorts      : true,
    });

    expect(requestedUrls).toEqual(['http://127.0.0.1:55500/info']);
    expect(result).toEqual({
      endpoint   : 'http://127.0.0.1:55500',
      serverInfo : localNodeInfo,
      status     : 'found-unpaired',
    });
  });

  test('returns paired when a stored token is accepted', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnPairingRecord(storage, pairingRecord);

    const result = await probeLocalDwn({
      fetch: async (url, init): Promise<Response> => {
        if (url.toString().endsWith('/info')) {
          return jsonResponse(localNodeInfo);
        }

        expect(url.toString()).toBe('http://127.0.0.1:55500/local/status');
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer paired-token');
        expect((init?.headers as Record<string, string>).origin).toBe('https://app.example');
        return jsonResponse({ localNode: true, paired: true });
      },
      origin: 'https://app.example',
      storage,
    });

    expect(result).toEqual({
      endpoint   : pairingRecord.endpoint,
      pairing    : pairingRecord,
      serverInfo : localNodeInfo,
      status     : 'paired',
    });
  });

  test('does not scan ports when scanPorts is false', async () => {
    let fetchCount = 0;

    const result = await probeLocalDwn({
      fetch: async (): Promise<Response> => {
        fetchCount++;
        return jsonResponse(localNodeInfo);
      },
      scanPorts: false,
    });

    expect(result).toEqual({ status: 'not-found' });
    expect(fetchCount).toBe(0);
  });

  test('returns unsupported for Safari user agents', async () => {
    setBrowserGlobals({
      href            : 'https://app.example',
      isSecureContext : true,
      userAgent       : 'Mozilla/5.0 Version/17.0 Safari/605.1.15',
    });

    try {
      const result = await probeLocalDwn({
        fetch: async (): Promise<Response> => {
          throw new Error('should not fetch');
        },
      });

      expect(result).toEqual({ reason: 'safari', status: 'unsupported' });
    } finally {
      restoreBrowserGlobals();
    }
  });

  test('clears stored pairing when probe revalidation fails', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnPairingRecord(storage, pairingRecord);

    const result = await probeLocalDwn({
      fetch: async (url): Promise<Response> => {
        return url.toString().endsWith('/info')
          ? jsonResponse(localNodeInfo)
          : jsonResponse({ error: 'Unauthorized' }, 401);
      },
      portCandidates: [],
      storage,
    });

    expect(result).toEqual({ status: 'not-found' });
    expect(await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT)).toBeNull();
  });
});

describe('requestLocalDwnPairing', () => {
  test('initiates, polls, and persists an approved pairing token', async () => {
    const storage = new MemoryStorage();
    let pollCount = 0;

    const result = await requestLocalDwnPairing({
      fetch: async (url, init): Promise<Response> => {
        const href = url.toString();

        if (href.endsWith('/info')) {
          return jsonResponse(localNodeInfo);
        }

        if (href.endsWith('/local/pair') && init?.method === 'POST') {
          expect((init.headers as Record<string, string>).origin).toBe('https://app.example');
          return jsonResponse({ requestId: 'request-1', status: 'pending' });
        }

        if (href.endsWith('/local/pair/request-1')) {
          pollCount++;
          return pollCount === 1
            ? jsonResponse({ origin: 'https://app.example', status: 'pending' })
            : jsonResponse({ origin: 'https://app.example', status: 'approved', token: 'new-token' });
        }

        throw new Error(`unexpected fetch ${href}`);
      },
      origin         : 'https://app.example',
      pollIntervalMs : 0,
      portCandidates : [55500],
      storage,
      timeoutMs      : 100,
    });

    expect(result).toEqual({
      endpoint : 'http://127.0.0.1:55500',
      pairing  : {
        createdAt    : expect.any(Number),
        endpoint     : 'http://127.0.0.1:55500',
        pairedOrigin : 'https://app.example',
        token        : 'new-token',
        version      : 1,
      },
      serverInfo : localNodeInfo,
      status     : 'paired',
    });

    expect(await readLocalDwnPairingRecord(storage)).toEqual((result as any).pairing);
  });

  test('returns rate-limited when pairing initiation is rate limited', async () => {
    const storage = new MemoryStorage();

    const result = await requestLocalDwnPairing({
      fetch: async (url): Promise<Response> => {
        return url.toString().endsWith('/info')
          ? jsonResponse(localNodeInfo)
          : jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '9' });
      },
      endpoint: pairingRecord.endpoint,
      storage,
    });

    expect(result).toEqual({ retryAfterSec: 9, status: 'rate-limited' });
  });

  test('returns denied and expired terminal pairing statuses', async () => {
    const storage = new MemoryStorage();
    const denied = await requestLocalDwnPairing({
      fetch    : pairingFetch({ status: 'denied' }),
      endpoint : pairingRecord.endpoint,
      storage,
    });
    const expired = await requestLocalDwnPairing({
      fetch    : pairingFetch({ status: 'expired' }),
      endpoint : pairingRecord.endpoint,
      storage,
    });

    expect(denied).toEqual({
      endpoint : pairingRecord.endpoint,
      origin   : 'https://app.example',
      status   : 'denied',
    });
    expect(expired).toEqual({
      endpoint : pairingRecord.endpoint,
      origin   : 'https://app.example',
      status   : 'expired',
    });
  });

  test('returns timeout when pairing remains pending', async () => {
    const storage = new MemoryStorage();

    const result = await requestLocalDwnPairing({
      endpoint       : pairingRecord.endpoint,
      fetch          : pairingFetch({ status: 'pending' }),
      pollIntervalMs : 0,
      storage,
      timeoutMs      : 0,
    });

    expect(result).toEqual({
      endpoint  : pairingRecord.endpoint,
      pollUrl   : 'http://127.0.0.1:55500/local/pair/request-1',
      requestId : 'request-1',
      status    : 'timeout',
    });
  });

  test('throws when approved pairing omits token', async () => {
    const storage = new MemoryStorage();

    await expect(requestLocalDwnPairing({
      endpoint : pairingRecord.endpoint,
      fetch    : pairingFetch({ status: 'approved' }),
      storage,
    })).rejects.toThrow('approved pairing did not include a token');
  });
});

describe('pairing HTTP helpers', () => {
  test('uses fallback pairing URLs when /info omits localPairing', async () => {
    const serverInfo = {
      ...localNodeInfo,
      localPairing: undefined,
    };
    const fetchUrls: string[] = [];

    const initiated = await initiateLocalDwnPairing({
      endpoint : pairingRecord.endpoint,
      fetch    : async (url): Promise<Response> => {
        fetchUrls.push(url.toString());
        return jsonResponse({ requestId: 'fallback-request', status: 'pending' });
      },
      serverInfo,
    });

    expect(fetchUrls).toEqual(['http://127.0.0.1:55500/local/pair']);
    expect(initiated).toEqual({
      endpoint  : pairingRecord.endpoint,
      pollUrl   : 'http://127.0.0.1:55500/local/pair/fallback-request',
      requestId : 'fallback-request',
      serverInfo,
      status    : 'pending',
    });
  });

  test('rejects malformed initiate and poll responses', async () => {
    await expect(initiateLocalDwnPairing({
      endpoint   : pairingRecord.endpoint,
      fetch      : async (): Promise<Response> => jsonResponse({ requestId: 1, status: 'pending' }),
      serverInfo : localNodeInfo,
    })).rejects.toThrow('malformed pairing response');

    await expect(pollLocalDwnPairing({
      endpoint : pairingRecord.endpoint,
      fetch    : async (): Promise<Response> => jsonResponse({ status: 'pending' }),
      pollUrl  : 'http://127.0.0.1:55500/local/pair/request-1',
    })).rejects.toThrow('malformed pairing poll response');
  });

  test('rejects non-OK initiate and poll responses', async () => {
    await expect(initiateLocalDwnPairing({
      endpoint   : pairingRecord.endpoint,
      fetch      : async (): Promise<Response> => jsonResponse({ error: 'boom' }, 500),
      serverInfo : localNodeInfo,
    })).rejects.toThrow('pairing request failed with HTTP 500');

    await expect(pollLocalDwnPairing({
      endpoint : pairingRecord.endpoint,
      fetch    : async (): Promise<Response> => jsonResponse({ error: 'boom' }, 500),
      pollUrl  : 'http://127.0.0.1:55500/local/pair/request-1',
    })).rejects.toThrow('pairing poll failed with HTTP 500');
  });
});

describe('clearLocalDwnEndpoint', () => {
  test('removes the persisted pairing key', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnPairingRecord(storage, pairingRecord);

    await clearLocalDwnEndpoint(storage);

    expect(await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT)).toBeNull();
  });
});

function jsonResponse(body: unknown, status: number = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    status,
  });
}

function pairingFetch(result: { status: 'pending' | 'approved' | 'denied' | 'expired' }): typeof fetch {
  return async (url): Promise<Response> => {
    const href = url.toString();
    if (href.endsWith('/info')) {
      return jsonResponse(localNodeInfo);
    }

    if (href.endsWith('/local/pair')) {
      return jsonResponse({ requestId: 'request-1', status: 'pending' });
    }

    return jsonResponse({
      origin : 'https://app.example',
      status : result.status,
    });
  };
}

function setBrowserGlobals(params: {
  href: string;
  isSecureContext: boolean;
  userAgent: string;
}): void {
  originalLocation ??= globalThis.location;
  originalNavigator ??= globalThis.navigator;
  originalIsSecureContext ??= globalThis.isSecureContext;

  Object.defineProperty(globalThis, 'location', {
    configurable : true,
    value        : { href: params.href },
    writable     : true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable : true,
    value        : { userAgent: params.userAgent },
    writable     : true,
  });
  Object.defineProperty(globalThis, 'isSecureContext', {
    configurable : true,
    value        : params.isSecureContext,
    writable     : true,
  });
}

function restoreBrowserGlobals(): void {
  if (originalLocation !== undefined) {
    Object.defineProperty(globalThis, 'location', {
      configurable : true,
      value        : originalLocation,
      writable     : true,
    });
  } else {
    delete (globalThis as { location?: Location }).location;
  }

  if (originalNavigator !== undefined) {
    Object.defineProperty(globalThis, 'navigator', {
      configurable : true,
      value        : originalNavigator,
      writable     : true,
    });
  } else {
    delete (globalThis as { navigator?: Navigator }).navigator;
  }

  if (originalIsSecureContext !== undefined) {
    Object.defineProperty(globalThis, 'isSecureContext', {
      configurable : true,
      value        : originalIsSecureContext,
      writable     : true,
    });
  } else {
    delete (globalThis as { isSecureContext?: boolean }).isSecureContext;
  }
  originalLocation = undefined;
  originalNavigator = undefined;
  originalIsSecureContext = undefined;
}
