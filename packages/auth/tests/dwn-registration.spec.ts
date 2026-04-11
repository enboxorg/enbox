import { describe, expect, mock, test } from 'bun:test';

import { createMockAgent } from './helpers/mock-agent.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';

import {
  loadTokensFromSecretStore,
  loadTokensFromStorage,
  registerWithDwnEndpoints,
  saveTokensToSecretStore,
  saveTokensToStorage,
} from '../src/registration.js';

import type { RegistrationTokenData } from '../src/types.js';

// We mock @enbox/dwn-clients so no real HTTP requests are made.
const mockRegisterTenant = mock(async () => {});
const mockRegisterTenantWithToken = mock(async () => {});
const mockExchangeAuthCode = mock(async () => ({
  registrationToken : 'new-token',
  refreshToken      : 'new-refresh',
  expiresIn         : 3600,
}));
const mockRefreshRegistrationToken = mock(async () => ({
  registrationToken : 'refreshed-token',
  refreshToken      : 'refreshed-refresh',
  expiresIn         : 3600,
}));

// Load the actual module first so we can spread non-mocked exports.
const actualDwnClients = await import('@enbox/dwn-clients');
mock.module('@enbox/dwn-clients', () => ({
  ...actualDwnClients,
  DwnRegistrar: {
    registerTenant           : mockRegisterTenant,
    registerTenantWithToken  : mockRegisterTenantWithToken,
    exchangeAuthCode         : mockExchangeAuthCode,
    refreshRegistrationToken : mockRefreshRegistrationToken,
  },
}));

describe('registerWithDwnEndpoints', () => {
  test('skips registration when server has no requirements', async () => {
    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
      }),
    });

    let successCalled = false;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
      },
      {
        onSuccess : () => { successCalled = true; },
        onFailure : () => {},
      },
    );

    expect(successCalled).toBe(true);
    // No registration calls should have been made
    expect(mockRegisterTenant.mock.calls.length).toBe(0);
  });

  test('registers via PoW when server requires it and no provider auth callback', async () => {
    mockRegisterTenant.mockClear();

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['proof-of-work-sha256-v0', 'terms-of-service'],
        maxFileSize              : 10_000_000,
      }),
    });

    let successCalled = false;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
      },
      {
        onSuccess : () => { successCalled = true; },
        onFailure : () => {},
      },
    );

    expect(successCalled).toBe(true);
    // Should register both agent DID and connected DID via PoW
    expect(mockRegisterTenant.mock.calls.length).toBe(2);
    expect(mockRegisterTenant.mock.calls[0]).toEqual(['https://dwn1.example.com', 'did:dht:agent1']);
    expect(mockRegisterTenant.mock.calls[1]).toEqual(['https://dwn1.example.com', 'did:dht:user1']);
  });

  test('deduplicates DIDs when agent DID equals connected DID', async () => {
    mockRegisterTenant.mockClear();

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['proof-of-work-sha256-v0'],
        maxFileSize              : 10_000_000,
      }),
    });

    let successCalled = false;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:same',
        connectedDid : 'did:dht:same',
      },
      {
        onSuccess : () => { successCalled = true; },
        onFailure : () => {},
      },
    );

    expect(successCalled).toBe(true);
    // Only one registration call since DIDs are the same
    expect(mockRegisterTenant.mock.calls.length).toBe(1);
  });

  test('uses provider auth when server supports it and callback is provided', async () => {
    mockRegisterTenantWithToken.mockClear();
    mockExchangeAuthCode.mockClear();

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['provider-auth-v0'],
        providerAuth             : {
          authorizeUrl : 'https://auth.example.com/authorize',
          tokenUrl     : 'https://auth.example.com/token',
          refreshUrl   : 'https://auth.example.com/refresh',
        },
        maxFileSize: 10_000_000,
      }),
    });

    let successCalled = false;
    let capturedTokens: Record<string, RegistrationTokenData> | undefined;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
      },
      {
        onSuccess              : () => { successCalled = true; },
        onFailure              : () => {},
        onProviderAuthRequired : async (params) => ({
          code  : 'auth-code-123',
          state : params.state,
        }),
        onRegistrationTokens: (tokens) => { capturedTokens = tokens; },
      },
    );

    expect(successCalled).toBe(true);

    // Should have exchanged auth code
    expect(mockExchangeAuthCode.mock.calls.length).toBe(1);
    expect(mockExchangeAuthCode.mock.calls[0][0]).toBe('https://auth.example.com/token');
    expect(mockExchangeAuthCode.mock.calls[0][1]).toBe('auth-code-123');

    // Should have registered both DIDs with token
    expect(mockRegisterTenantWithToken.mock.calls.length).toBe(2);

    // Tokens should have been emitted
    expect(capturedTokens).toBeDefined();
    expect(capturedTokens!['https://dwn1.example.com']).toBeDefined();
    expect(capturedTokens!['https://dwn1.example.com'].registrationToken).toBe('new-token');
    expect(capturedTokens!['https://dwn1.example.com'].tokenUrl).toBe('https://auth.example.com/token');
    expect(capturedTokens!['https://dwn1.example.com'].refreshUrl).toBe('https://auth.example.com/refresh');
  });

  test('uses existing valid registration token instead of re-authing', async () => {
    mockRegisterTenantWithToken.mockClear();
    mockExchangeAuthCode.mockClear();

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['provider-auth-v0'],
        providerAuth             : {
          authorizeUrl : 'https://auth.example.com/authorize',
          tokenUrl     : 'https://auth.example.com/token',
        },
        maxFileSize: 10_000_000,
      }),
    });

    const authCallCount = { value: 0 };
    let successCalled = false;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
      },
      {
        onSuccess              : () => { successCalled = true; },
        onFailure              : () => {},
        onProviderAuthRequired : async (params) => {
          authCallCount.value++;
          return { code: 'code', state: params.state };
        },
        registrationTokens: {
          'https://dwn1.example.com': {
            registrationToken : 'existing-token',
            tokenUrl          : 'https://auth.example.com/token',
            expiresAt         : Date.now() + 60_000, // valid for 60s
          },
        },
      },
    );

    expect(successCalled).toBe(true);
    // Should NOT have called onProviderAuthRequired since we have a valid token
    expect(authCallCount.value).toBe(0);
    // Should NOT have exchanged auth code
    expect(mockExchangeAuthCode.mock.calls.length).toBe(0);
    // Should have registered using the existing token
    expect(mockRegisterTenantWithToken.mock.calls.length).toBe(2);
    expect(mockRegisterTenantWithToken.mock.calls[0][2]).toBe('existing-token');
  });

  test('refreshes expired token when refresh URL and token are available', async () => {
    mockRegisterTenantWithToken.mockClear();
    mockRefreshRegistrationToken.mockClear();
    mockExchangeAuthCode.mockClear();

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['provider-auth-v0'],
        providerAuth             : {
          authorizeUrl : 'https://auth.example.com/authorize',
          tokenUrl     : 'https://auth.example.com/token',
          refreshUrl   : 'https://auth.example.com/refresh',
        },
        maxFileSize: 10_000_000,
      }),
    });

    let capturedTokens: Record<string, RegistrationTokenData> | undefined;
    let successCalled = false;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
      },
      {
        onSuccess              : () => { successCalled = true; },
        onFailure              : () => {},
        onProviderAuthRequired : async (params) => ({
          code: 'code', state: params.state,
        }),
        registrationTokens: {
          'https://dwn1.example.com': {
            registrationToken : 'expired-token',
            refreshToken      : 'refresh-tok',
            tokenUrl          : 'https://auth.example.com/token',
            refreshUrl        : 'https://auth.example.com/refresh',
            expiresAt         : Date.now() - 1000, // expired
          },
        },
        onRegistrationTokens: (tokens) => { capturedTokens = tokens; },
      },
    );

    expect(successCalled).toBe(true);
    // Should have called refresh
    expect(mockRefreshRegistrationToken.mock.calls.length).toBe(1);
    expect(mockRefreshRegistrationToken.mock.calls[0][0]).toBe('https://auth.example.com/refresh');
    expect(mockRefreshRegistrationToken.mock.calls[0][1]).toBe('refresh-tok');
    // Should NOT have called the full auth flow
    expect(mockExchangeAuthCode.mock.calls.length).toBe(0);
    // Should have registered with the refreshed token
    expect(mockRegisterTenantWithToken.mock.calls.length).toBe(2);
    expect(mockRegisterTenantWithToken.mock.calls[0][2]).toBe('refreshed-token');
    // Updated tokens should be emitted
    expect(capturedTokens!['https://dwn1.example.com'].registrationToken).toBe('refreshed-token');
  });

  test('re-auths when expired token has no refresh URL', async () => {
    mockRegisterTenantWithToken.mockClear();
    mockRefreshRegistrationToken.mockClear();
    mockExchangeAuthCode.mockClear();

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['provider-auth-v0'],
        providerAuth             : {
          authorizeUrl : 'https://auth.example.com/authorize',
          tokenUrl     : 'https://auth.example.com/token',
        },
        maxFileSize: 10_000_000,
      }),
    });

    let successCalled = false;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
      },
      {
        onSuccess              : () => { successCalled = true; },
        onFailure              : () => {},
        onProviderAuthRequired : async (params) => ({
          code: 'new-code', state: params.state,
        }),
        registrationTokens: {
          'https://dwn1.example.com': {
            registrationToken : 'expired-token',
            tokenUrl          : 'https://auth.example.com/token',
            expiresAt         : Date.now() - 1000, // expired, no refresh
          },
        },
      },
    );

    expect(successCalled).toBe(true);
    // Should NOT have called refresh (no refreshUrl)
    expect(mockRefreshRegistrationToken.mock.calls.length).toBe(0);
    // Should have done full auth flow
    expect(mockExchangeAuthCode.mock.calls.length).toBe(1);
  });

  test('detects CSRF state mismatch', async () => {
    mockExchangeAuthCode.mockClear();

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['provider-auth-v0'],
        providerAuth             : {
          authorizeUrl : 'https://auth.example.com/authorize',
          tokenUrl     : 'https://auth.example.com/token',
        },
        maxFileSize: 10_000_000,
      }),
    });

    let failureError: unknown;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
      },
      {
        onSuccess              : () => {},
        onFailure              : (error: unknown) => { failureError = error; },
        onProviderAuthRequired : async () => ({
          code  : 'code',
          state : 'wrong-state', // intentionally wrong
        }),
      },
    );

    // Should have called onFailure with CSRF error
    expect(failureError).toBeDefined();
    expect((failureError as Error).message).toContain('state mismatch');
  });

  test('calls onFailure when registration throws', async () => {
    mockRegisterTenant.mockClear();
    mockRegisterTenant.mockImplementationOnce(async () => {
      throw new Error('Network error');
    });

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['proof-of-work-sha256-v0'],
        maxFileSize              : 10_000_000,
      }),
    });

    let failureError: unknown;
    let successCalled = false;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
      },
      {
        onSuccess : () => { successCalled = true; },
        onFailure : (error: unknown) => { failureError = error; },
      },
    );

    expect(successCalled).toBe(false);
    expect(failureError).toBeDefined();
    expect((failureError as Error).message).toBe('Network error');
  });

  test('registers with multiple DWN endpoints', async () => {
    mockRegisterTenant.mockClear();
    mockRegisterTenant.mockImplementation(async () => {});

    const getServerInfoCalls: string[] = [];
    const agent = createMockAgent({
      rpcGetServerInfo: async (url: string) => {
        getServerInfoCalls.push(url);
        return {
          registrationRequirements : ['proof-of-work-sha256-v0'],
          maxFileSize              : 10_000_000,
        };
      },
    });

    let successCalled = false;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com', 'https://dwn2.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
      },
      {
        onSuccess : () => { successCalled = true; },
        onFailure : () => {},
      },
    );

    expect(successCalled).toBe(true);
    expect(getServerInfoCalls).toEqual(['https://dwn1.example.com', 'https://dwn2.example.com']);
    // 2 DIDs x 2 endpoints = 4 registration calls
    expect(mockRegisterTenant.mock.calls.length).toBe(4);
  });

  test('falls back to PoW when provider auth is supported but no callback', async () => {
    mockRegisterTenant.mockClear();
    mockRegisterTenant.mockImplementation(async () => {});
    mockRegisterTenantWithToken.mockClear();

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['provider-auth-v0'],
        providerAuth             : {
          authorizeUrl : 'https://auth.example.com/authorize',
          tokenUrl     : 'https://auth.example.com/token',
        },
        maxFileSize: 10_000_000,
      }),
    });

    let successCalled = false;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
      },
      {
        onSuccess : () => { successCalled = true; },
        onFailure : () => {},
        // No onProviderAuthRequired — should fall back to PoW
      },
    );

    expect(successCalled).toBe(true);
    // Should have used PoW fallback
    expect(mockRegisterTenant.mock.calls.length).toBe(2);
    expect(mockRegisterTenantWithToken.mock.calls.length).toBe(0);
  });

  test('constructs correct authorize URL with query separator', async () => {
    mockExchangeAuthCode.mockClear();

    // Test with URL that already has query params (should use &)
    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['provider-auth-v0'],
        providerAuth             : {
          authorizeUrl : 'https://auth.example.com/authorize?foo=bar',
          tokenUrl     : 'https://auth.example.com/token',
        },
        maxFileSize: 10_000_000,
      }),
    });

    let capturedParams: any;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
      },
      {
        onSuccess              : () => {},
        onFailure              : () => {},
        onProviderAuthRequired : async (params) => {
          capturedParams = params;
          return { code: 'code', state: params.state };
        },
      },
    );

    // Should use & since the URL already has ?
    expect(capturedParams.authorizeUrl).toContain('?foo=bar&redirect_uri=');
    expect(capturedParams.dwnEndpoint).toBe('https://dwn1.example.com');
    expect(capturedParams.state).toBeDefined();
  });

  test('token without expiresAt is treated as non-expired', async () => {
    mockRegisterTenantWithToken.mockClear();
    mockExchangeAuthCode.mockClear();

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['provider-auth-v0'],
        providerAuth             : {
          authorizeUrl : 'https://auth.example.com/authorize',
          tokenUrl     : 'https://auth.example.com/token',
        },
        maxFileSize: 10_000_000,
      }),
    });

    const authCallCount = { value: 0 };
    let successCalled = false;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:same',
        connectedDid : 'did:dht:same',
      },
      {
        onSuccess              : () => { successCalled = true; },
        onFailure              : () => {},
        onProviderAuthRequired : async (params) => {
          authCallCount.value++;
          return { code: 'code', state: params.state };
        },
        registrationTokens: {
          'https://dwn1.example.com': {
            registrationToken : 'no-expiry-token',
            tokenUrl          : 'https://auth.example.com/token',
            // expiresAt is undefined — never expires
          },
        },
      },
    );

    expect(successCalled).toBe(true);
    // Should not have re-authed
    expect(authCallCount.value).toBe(0);
    expect(mockExchangeAuthCode.mock.calls.length).toBe(0);
    // Should use the existing token
    expect(mockRegisterTenantWithToken.mock.calls.length).toBe(1);
    expect(mockRegisterTenantWithToken.mock.calls[0][2]).toBe('no-expiry-token');
  });
});

// ─── Token Storage Helpers ───────────────────────────────────────

describe('loadTokensFromStorage', () => {
  test('returns empty record when no tokens are stored', async () => {
    const storage = new MemoryStorage();
    const tokens = await loadTokensFromStorage(storage);
    expect(tokens).toEqual({});
  });

  test('parses stored JSON tokens', async () => {
    const storage = new MemoryStorage();
    const expected: Record<string, RegistrationTokenData> = {
      'https://dwn1.example.com': {
        registrationToken : 'tok-1',
        tokenUrl          : 'https://auth.example.com/token',
        expiresAt         : Date.now() + 60_000,
      },
    };
    await storage.set(STORAGE_KEYS.REGISTRATION_TOKENS, JSON.stringify(expected));

    const tokens = await loadTokensFromStorage(storage);
    expect(tokens).toEqual(expected);
  });

  test('returns empty record when stored value is corrupt JSON', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.REGISTRATION_TOKENS, '{bad json!!!');

    const tokens = await loadTokensFromStorage(storage);
    expect(tokens).toEqual({});
  });

  test('returns empty record when storage.get throws', async () => {
    const storage = new MemoryStorage();
    storage.get = async (): Promise<string | null> => { throw new Error('disk error'); };

    const tokens = await loadTokensFromStorage(storage);
    expect(tokens).toEqual({});
  });
});

describe('saveTokensToStorage', () => {
  test('serialises tokens to JSON in storage', async () => {
    const storage = new MemoryStorage();
    const tokens: Record<string, RegistrationTokenData> = {
      'https://dwn1.example.com': {
        registrationToken : 'tok-1',
        refreshToken      : 'ref-1',
        tokenUrl          : 'https://auth.example.com/token',
        refreshUrl        : 'https://auth.example.com/refresh',
        expiresAt         : 1_700_000_000_000,
      },
    };

    await saveTokensToStorage(storage, tokens);

    const raw = await storage.get(STORAGE_KEYS.REGISTRATION_TOKENS);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(tokens);
  });

  test('overwrites previously stored tokens', async () => {
    const storage = new MemoryStorage();
    await saveTokensToStorage(storage, {
      'https://old.example.com': {
        registrationToken : 'old-tok',
        tokenUrl          : 'https://old.example.com/token',
      },
    });

    const newTokens: Record<string, RegistrationTokenData> = {
      'https://new.example.com': {
        registrationToken : 'new-tok',
        tokenUrl          : 'https://new.example.com/token',
      },
    };
    await saveTokensToStorage(storage, newTokens);

    const raw = await storage.get(STORAGE_KEYS.REGISTRATION_TOKENS);
    expect(JSON.parse(raw!)).toEqual(newTokens);
  });
});

// ─── persistTokens Integration ───────────────────────────────────

describe('registerWithDwnEndpoints with persistTokens', () => {
  test('loads tokens from storage when persistTokens is true', async () => {
    mockRegisterTenantWithToken.mockClear();
    mockExchangeAuthCode.mockClear();

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['provider-auth-v0'],
        providerAuth             : {
          authorizeUrl : 'https://auth.example.com/authorize',
          tokenUrl     : 'https://auth.example.com/token',
        },
        maxFileSize: 10_000_000,
      }),
    });

    // Pre-populate storage with a valid token.
    const storage = new MemoryStorage();
    const storedTokens: Record<string, RegistrationTokenData> = {
      'https://dwn1.example.com': {
        registrationToken : 'stored-token',
        tokenUrl          : 'https://auth.example.com/token',
        expiresAt         : Date.now() + 60_000,
      },
    };
    await storage.set(STORAGE_KEYS.REGISTRATION_TOKENS, JSON.stringify(storedTokens));

    let successCalled = false;
    const authCallCount = { value: 0 };
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
        storage,
      },
      {
        onSuccess              : () => { successCalled = true; },
        onFailure              : () => {},
        onProviderAuthRequired : async (params) => {
          authCallCount.value++;
          return { code: 'code', state: params.state };
        },
        persistTokens: true,
      },
    );

    expect(successCalled).toBe(true);
    // Should NOT have run the auth flow — used stored token
    expect(authCallCount.value).toBe(0);
    expect(mockExchangeAuthCode.mock.calls.length).toBe(0);
    // Should have registered using the stored token
    expect(mockRegisterTenantWithToken.mock.calls.length).toBe(2);
    expect(mockRegisterTenantWithToken.mock.calls[0][2]).toBe('stored-token');
  });

  test('saves new tokens to storage after registration', async () => {
    mockRegisterTenantWithToken.mockClear();
    mockExchangeAuthCode.mockClear();
    mockExchangeAuthCode.mockImplementation(async () => ({
      registrationToken : 'fresh-token',
      refreshToken      : 'fresh-refresh',
      expiresIn         : 7200,
    }));

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['provider-auth-v0'],
        providerAuth             : {
          authorizeUrl : 'https://auth.example.com/authorize',
          tokenUrl     : 'https://auth.example.com/token',
          refreshUrl   : 'https://auth.example.com/refresh',
        },
        maxFileSize: 10_000_000,
      }),
    });

    const storage = new MemoryStorage();
    let successCalled = false;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
        storage,
      },
      {
        onSuccess              : () => { successCalled = true; },
        onFailure              : () => {},
        onProviderAuthRequired : async (params) => ({
          code: 'auth-code', state: params.state,
        }),
        persistTokens: true,
      },
    );

    expect(successCalled).toBe(true);

    // Verify tokens were persisted to storage.
    const raw = await storage.get(STORAGE_KEYS.REGISTRATION_TOKENS);
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!) as Record<string, RegistrationTokenData>;
    expect(persisted['https://dwn1.example.com']).toBeDefined();
    expect(persisted['https://dwn1.example.com'].registrationToken).toBe('fresh-token');
    expect(persisted['https://dwn1.example.com'].refreshToken).toBe('fresh-refresh');
    expect(persisted['https://dwn1.example.com'].tokenUrl).toBe('https://auth.example.com/token');
    expect(persisted['https://dwn1.example.com'].refreshUrl).toBe('https://auth.example.com/refresh');
  });

  test('still invokes onRegistrationTokens callback when persistTokens is true', async () => {
    mockRegisterTenant.mockClear();
    mockRegisterTenant.mockImplementation(async () => {});

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['proof-of-work-sha256-v0'],
        maxFileSize              : 10_000_000,
      }),
    });

    const storage = new MemoryStorage();
    let callbackTokens: Record<string, RegistrationTokenData> | undefined;
    let successCalled = false;

    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
        storage,
      },
      {
        onSuccess            : () => { successCalled = true; },
        onFailure            : () => {},
        onRegistrationTokens : (tokens) => { callbackTokens = tokens; },
        persistTokens        : true,
      },
    );

    expect(successCalled).toBe(true);
    // The callback should still be invoked
    expect(callbackTokens).toBeDefined();
  });

  test('ignores explicit registrationTokens when persistTokens is true', async () => {
    mockRegisterTenantWithToken.mockClear();
    mockExchangeAuthCode.mockClear();

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['provider-auth-v0'],
        providerAuth             : {
          authorizeUrl : 'https://auth.example.com/authorize',
          tokenUrl     : 'https://auth.example.com/token',
        },
        maxFileSize: 10_000_000,
      }),
    });

    // Storage has a different token than the explicit one.
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.REGISTRATION_TOKENS, JSON.stringify({
      'https://dwn1.example.com': {
        registrationToken : 'from-storage',
        tokenUrl          : 'https://auth.example.com/token',
        expiresAt         : Date.now() + 60_000,
      },
    }));

    let successCalled = false;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
        storage,
      },
      {
        onSuccess              : () => { successCalled = true; },
        onFailure              : () => {},
        onProviderAuthRequired : async (params) => ({
          code: 'code', state: params.state,
        }),
        // This should be ignored when persistTokens is true
        registrationTokens: {
          'https://dwn1.example.com': {
            registrationToken : 'from-explicit',
            tokenUrl          : 'https://auth.example.com/token',
            expiresAt         : Date.now() + 60_000,
          },
        },
        persistTokens: true,
      },
    );

    expect(successCalled).toBe(true);
    // Should have used the token from storage, not the explicit one
    expect(mockRegisterTenantWithToken.mock.calls[0][2]).toBe('from-storage');
  });

  test('does not save to storage when persistTokens is false', async () => {
    mockRegisterTenant.mockClear();
    mockRegisterTenant.mockImplementation(async () => {});

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['proof-of-work-sha256-v0'],
        maxFileSize              : 10_000_000,
      }),
    });

    const storage = new MemoryStorage();
    let successCalled = false;

    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
        storage,
      },
      {
        onSuccess     : () => { successCalled = true; },
        onFailure     : () => {},
        persistTokens : false,
      },
    );

    expect(successCalled).toBe(true);
    // Storage should be empty — no auto-save
    const raw = await storage.get(STORAGE_KEYS.REGISTRATION_TOKENS);
    expect(raw).toBeNull();
  });

  test('does not save to storage when persistTokens is true but no storage provided', async () => {
    mockRegisterTenant.mockClear();
    mockRegisterTenant.mockImplementation(async () => {});

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['proof-of-work-sha256-v0'],
        maxFileSize              : 10_000_000,
      }),
    });

    let successCalled = false;

    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
        // No storage provided
      },
      {
        onSuccess     : () => { successCalled = true; },
        onFailure     : () => {},
        persistTokens : true,
      },
    );

    // Should still succeed — just without persistence
    expect(successCalled).toBe(true);
  });

  test('handles storage load failure gracefully during registration', async () => {
    mockRegisterTenant.mockClear();
    mockRegisterTenant.mockImplementation(async () => {});

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['proof-of-work-sha256-v0'],
        maxFileSize              : 10_000_000,
      }),
    });

    const storage = new MemoryStorage();
    storage.get = async (): Promise<string | null> => { throw new Error('disk read error'); };

    let successCalled = false;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
        storage,
      },
      {
        onSuccess     : () => { successCalled = true; },
        onFailure     : () => {},
        persistTokens : true,
      },
    );

    // Should still succeed — loadTokensFromStorage returns {} on error
    expect(successCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  SecretStore helpers
// ---------------------------------------------------------------------------

describe('SecretStore token helpers', () => {
  test('saveTokensToSecretStore and loadTokensFromSecretStore round-trip', async () => {
    const { InMemorySecretStore } = await import('@enbox/agent');
    const secretStore = new InMemorySecretStore();

    const tokens: Record<string, RegistrationTokenData> = {
      'https://dwn1.example.com': {
        registrationToken : 'reg-abc',
        refreshToken      : 'refresh-xyz',
        expiresAt         : Date.now() + 60_000,
        tokenUrl          : 'https://auth.example.com/token',
        refreshUrl        : 'https://auth.example.com/refresh',
      },
    };

    await saveTokensToSecretStore(secretStore, tokens);
    const loaded = await loadTokensFromSecretStore(secretStore);

    expect(loaded).toEqual(tokens);
  });

  test('loadTokensFromSecretStore returns empty object when no tokens stored', async () => {
    const { InMemorySecretStore } = await import('@enbox/agent');
    const secretStore = new InMemorySecretStore();

    const loaded = await loadTokensFromSecretStore(secretStore);
    expect(loaded).toEqual({});
  });

  test('loadTokensFromSecretStore returns empty object on corrupt data', async () => {
    const { InMemorySecretStore } = await import('@enbox/agent');
    const secretStore = new InMemorySecretStore();

    // Store invalid JSON bytes.
    await secretStore.put('enbox:auth:registrationTokens', new Uint8Array([0xFF, 0xFE]));

    const loaded = await loadTokensFromSecretStore(secretStore);
    expect(loaded).toEqual({});
  });

  test('loadTokensFromSecretStore returns empty object when secretStore.get throws', async () => {
    const throwingStore = {
      async put(): Promise<void> { /* no-op */ },
      async get(): Promise<Uint8Array | undefined> { throw new Error('vault is locked'); },
      async delete(): Promise<boolean> { return false; },
    };

    const loaded = await loadTokensFromSecretStore(throwingStore);
    expect(loaded).toEqual({});
  });

  test('registerWithDwnEndpoints persists to secretStore when provided', async () => {
    mockRegisterTenant.mockClear();
    mockRegisterTenant.mockImplementation(async () => {});

    const agent = createMockAgent({
      rpcGetServerInfo: async () => ({
        registrationRequirements : ['proof-of-work-sha256-v0'],
        maxFileSize              : 10_000_000,
      }),
    });

    const { InMemorySecretStore } = await import('@enbox/agent');
    const secretStore = new InMemorySecretStore();

    // Pre-populate tokens in the secret store.
    const seedTokens: Record<string, RegistrationTokenData> = {
      'https://dwn1.example.com': {
        registrationToken : 'pre-existing',
        expiresAt         : Date.now() + 60_000,
      },
    };
    await saveTokensToSecretStore(secretStore, seedTokens);

    let successCalled = false;
    await registerWithDwnEndpoints(
      {
        userAgent    : agent,
        dwnEndpoints : ['https://dwn1.example.com'],
        agentDid     : 'did:dht:agent1',
        connectedDid : 'did:dht:user1',
        secretStore,
      },
      {
        onSuccess     : () => { successCalled = true; },
        onFailure     : () => {},
        persistTokens : true,
      },
    );

    expect(successCalled).toBe(true);

    // Tokens should have been persisted back to the secret store.
    const persisted = await loadTokensFromSecretStore(secretStore);
    expect(persisted['https://dwn1.example.com']).toBeDefined();
    expect(persisted['https://dwn1.example.com'].registrationToken).toBe('pre-existing');
  });
});
