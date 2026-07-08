import type { ServerInfo } from '@enbox/dwn-clients';

import { describe, expect, test } from 'bun:test';

import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';
import {
  clearLocalDwnEndpoint,
  discoverLocalDwnPairing,
  persistLocalDwnPairingRecord,
  probeLocalDwn,
  readLocalDwnPairingRecord,
  requestLocalDwnPairing,
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
