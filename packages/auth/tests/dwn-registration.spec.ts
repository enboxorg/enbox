import { describe, expect, mock, test } from 'bun:test';

import { createMockAgent } from './helpers/mock-agent.js';
import { registerWithDwnEndpoints } from '../src/flows/dwn-registration.js';

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
