import type { DwnProtocolDefinition, EnboxUserAgent } from '@enbox/agent';

import { describe, expect, test } from 'bun:test';

import { AuthManager } from '../src/auth-manager.js';
import { Convert } from '@enbox/common';
import { MemoryStorage } from '../src/storage/storage.js';
import { PasswordProvider } from '../src/password-provider.js';
import { STORAGE_KEYS } from '../src/types.js';
import { ConnectDeniedError, isConnectDeniedError } from '../src/errors.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

/**
 * A minimal non-empty protocols array suitable for routing to the
 * handler flow. Use this instead of `[]` — empty arrays no longer count
 * as a handler signal (see {@link AuthManager._isVaultConnect}).
 */
const HANDLER_PROTOCOLS: DwnProtocolDefinition[] = [
  {
    protocol  : 'https://example.com/handler-routing',
    published : true,
    types     : {},
    structure : {},
  },
];

/** Builds a parseable delegated permission-grant message for validation tests. */
function createGrantMessage({
  grantId = 'grant-1',
  grantor = 'did:dht:owner456',
  grantee,
  scope,
}: {
  grantId?: string;
  grantor?: string;
  grantee: string;
  scope: Record<string, unknown>;
}): any {
  return {
    recordId    : grantId,
    contextId   : grantId,
    encodedData : Convert.object({
      dateExpires : '2040-01-01T00:00:00.000000Z',
      delegated   : true,
      scope,
    }).toBase64Url(),
    descriptor: {
      interface    : 'Records',
      method       : 'Write',
      protocol     : 'https://identity.foundation/dwn/permissions',
      protocolPath : 'grant',
      recipient    : grantee,
      dateCreated  : '2026-01-01T00:00:00.000000Z',
      dataFormat   : 'application/json',
      dataCid      : 'bafytest',
      dataSize     : 100,
    },
    authorization: {
      signature: {
        signatures: [{
          protected: Convert.object({ kid: `${grantor}#key-1` }).toBase64Url(),
        }],
      },
    },
  };
}

/**
 * Construct an AuthManager instance with a pre-built mock agent.
 *
 * We use `Object.create()` + manual assignment to bypass the private
 * constructor and `EnboxUserAgent.create()` call, testing orchestration
 * logic in isolation.
 */
function createTestManager(
  agent: EnboxUserAgent,
  overrides: {
    storage?: MemoryStorage;
    password?: string;
    passwordProvider?: PasswordProvider;
    sync?: any;
    identitySyncProtocols?: 'all' | [string, ...string[]];
    dwnEndpoints?: string[];
    initialState?: string;
  } = {},
): AuthManager {
  const storage = overrides.storage ?? new MemoryStorage();

  // Use the static create path with a module mock — but that requires
  // mocking EnboxUserAgent.create. Instead, craft the instance manually.
  const manager = Object.create(AuthManager.prototype) as any;
  manager._userAgent = agent;
  manager._emitter = new (require('../src/events.js').AuthEventEmitter)();
  manager._storage = storage;
  manager._session = undefined;
  manager._sessionLifetime = undefined;
  manager._state = overrides.initialState ?? 'uninitialized';
  manager._isConnecting = false;
  manager._isShutDown = false;
  manager._isShuttingDown = false;
  manager._lifecycleGeneration = 0;
  manager._lifecycleCommitTail = Promise.resolve();
  manager._shutdownPromise = undefined;
  manager._defaultPassword = overrides.password;
  manager._passwordProvider = overrides.passwordProvider;
  manager._defaultSync = overrides.sync;
  manager._defaultIdentitySyncProtocols = overrides.identitySyncProtocols;
  manager._defaultDwnEndpoints = overrides.dwnEndpoints;

  return manager as AuthManager;
}

describe('AuthManager', () => {
  describe('property getters', () => {
    test('state returns current auth state', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent, { initialState: 'locked' });
      expect(manager.state).toBe('locked');
    });

    test('isConnected returns true when state is connected', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent, { initialState: 'connected' });
      expect(manager.isConnected).toBe(true);
    });

    test('isConnected returns false when not connected', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent, { initialState: 'unlocked' });
      expect(manager.isConnected).toBe(false);
    });

    test('isLocked delegates to vault manager', () => {
      const agent = createMockAgent({ vaultIsLocked: () => true });
      const manager = createTestManager(agent);
      expect(manager.isLocked).toBe(true);
    });

    test('isConnecting returns false initially', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);
      expect(manager.isConnecting).toBe(false);
    });

    test('session returns undefined when not connected', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);
      expect(manager.session).toBeUndefined();
    });

    test('vault returns the underlying identity vault', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);
      expect(manager.vault).toBe(agent.vault);
    });

    test('agent returns the user agent', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);
      expect(manager.agent).toBe(agent);
    });

    test('localDwnEndpoint returns undefined when not set', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);
      expect(manager.localDwnEndpoint).toBeUndefined();
    });
  });

  describe('connect()', () => {
    test('calls vaultConnect and sets state to connected', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);

      const session = await manager.connect({ password: 'test' });

      expect(session.did).toBe('did:dht:testuser123');
      expect(manager.state).toBe('connected');
      expect(manager.session).toBe(session);
      expect(manager.isConnected).toBe(true);
    });

    test('resets isConnecting after successful connect', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);

      await manager.connect({ password: 'test' });
      expect(manager.isConnecting).toBe(false);
    });

    test('resets isConnecting after failed connect', async () => {
      const agent = createMockAgent({
        firstLaunch : async () => false,
        start       : async () => { throw new Error('start failed'); },
      });
      const manager = createTestManager(agent);

      try {
        await manager.connect({ password: 'test' });
      } catch { /* expected */ }

      expect(manager.isConnecting).toBe(false);
    });

  });

  describe('connectVault()', () => {
    test('calls vaultConnect directly and sets state to connected', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);

      const session = await manager.connectVault({ password: 'test' });

      expect(session.did).toBe('did:dht:testuser123');
      expect(manager.state).toBe('connected');
      expect(manager.session).toBe(session);
    });

    test('installs the session before publishing the session-start wake', async () => {
      const agent = createMockAgent({
        firstLaunch    : async () => true,
        initialize     : async () => 'recovery phrase words',
        identityList   : async () => [],
        identityCreate : async () => createMockIdentity(),
      });
      const manager = createTestManager(agent);
      let sessionStarts = 0;
      let sessionAtEvent = manager.session;
      let stateAtEvent = manager.state;
      manager.on('session-start', (): void => {
        sessionStarts++;
        sessionAtEvent = manager.session;
        stateAtEvent = manager.state;
      });

      const session = await manager.connectVault({ password: 'test', createIdentity: true });

      expect(session.recoveryPhrase).toBe('recovery phrase words');
      expect(sessionStarts).toBe(1);
      expect(sessionAtEvent).toBe(session);
      expect(stateAtEvent).toBe('connected');
    });

    test('works without any options', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);

      const session = await manager.connectVault();

      expect(session.did).toBe('did:dht:testuser123');
      expect(manager.isConnected).toBe(true);
    });
  });

  describe('restoreFromPhrase()', () => {
    test.each(['connect', 'connectVault'] as const)('rejects recoveryPhrase passed to %s before session or vault work', async (method) => {
      const storage = new MemoryStorage();
      let storageReads = 0;
      let resetCalls = 0;
      storage.get = async (): Promise<null> => {
        storageReads++;
        return null;
      };
      const agent = createMockAgent({
        firstLaunch                          : async () => false,
        vaultResetPasswordWithRecoveryPhrase : async () => { resetCalls++; },
      });
      const manager = createTestManager(agent, { storage });

      await expect((manager[method] as any).call(manager, {
        recoveryPhrase : 'test phrase',
        password       : 'pass',
      })).rejects.toThrow('accepted only by restoreFromPhrase');

      expect(storageReads).toBe(0);
      expect(resetCalls).toBe(0);
    });

    test.each([
      { label: 'missing options', options: undefined, error: 'options must be an object' },
      { label: 'blank phrase', options: { recoveryPhrase: '  ', password: 'pass' }, error: 'recoveryPhrase must be a non-empty string' },
      { label: 'empty endpoints', options: { recoveryPhrase: 'phrase', password: 'pass', dwnEndpoints: [] }, error: 'dwnEndpoints must be a non-empty array' },
      { label: 'invalid endpoints', options: { recoveryPhrase: 'phrase', password: 'pass', dwnEndpoints: ['ftp://dwn.example'] }, error: 'dwnEndpoints must be a non-empty array' },
    ])('rejects $label before vault work', async ({ options, error }) => {
      let firstLaunchCalls = 0;
      let resetCalls = 0;
      const agent = createMockAgent({
        firstLaunch: async () => {
          firstLaunchCalls++;
          return false;
        },
        vaultResetPasswordWithRecoveryPhrase: async () => { resetCalls++; },
      });
      const manager = createTestManager(agent);

      await expect(manager.restoreFromPhrase(options as any)).rejects.toThrow(error);

      expect(firstLaunchCalls).toBe(0);
      expect(resetCalls).toBe(0);
    });

    test('restores a fresh vault without creating an identity by default', async () => {
      let createCallCount = 0;
      const agent = createMockAgent({
        firstLaunch    : async () => true,
        identityList   : async () => [],
        identityCreate : async () => {
          createCallCount += 1;
          return createMockIdentity();
        },
      });
      const manager = createTestManager(agent);

      const session = await manager.restoreFromPhrase({
        recoveryPhrase : 'test phrase',
        password       : 'pass',
        sync           : 'off',
      });

      expect(session.did).toBe('did:dht:testagent');
      expect(createCallCount).toBe(0);
      expect(manager.state).toBe('connected');
    });

    test('can opt into identity creation for combined onboarding flows', async () => {
      let createCallCount = 0;
      const agent = createMockAgent({
        firstLaunch    : async () => true,
        identityList   : async () => [],
        identityCreate : async () => {
          createCallCount += 1;
          return createMockIdentity();
        },
      });
      const manager = createTestManager(agent);

      const session = await manager.restoreFromPhrase({
        recoveryPhrase : 'test phrase',
        password       : 'pass',
        sync           : 'off',
        createIdentity : true,
      });

      expect(session.did).toBe('did:dht:testuser123');
      expect(createCallCount).toBe(1);
    });

    test('resets the password for an existing vault with the same phrase', async () => {
      const resetCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch                          : async () => false,
        identityList                         : async () => [createMockIdentity()],
        vaultResetPasswordWithRecoveryPhrase : async (params) => { resetCalls.push(params); },
      });
      const manager = createTestManager(agent);

      const session = await manager.restoreFromPhrase({
        recoveryPhrase : 'test phrase',
        password       : 'new-password',
        sync           : 'off',
      });

      expect(resetCalls).toEqual([{
        recoveryPhrase              : 'test phrase',
        password                    : 'new-password',
        deferDwnEndpointReplacement : true,
      }]);
      expect(session.did).toBe('did:dht:testuser123');
    });
  });

  describe('connect() with handler', () => {
    test('accepts a non-empty narrowed grant bundle from the provided handler', async () => {
      const delegateIdentity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate123' },
        metadata : { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner456' },
      });

      const agent = createMockAgent({
        firstLaunch    : async () => false,
        identityList   : async () => [],
        identityImport : async () => delegateIdentity,
        syncSync       : async () => {},
      });

      const mockHandler = {
        requestAccess: async (): Promise<any> => ({
          delegatePortableDid : { uri: 'did:jwk:delegate123', document: {}, privateKeys: [] },
          delegateGrants      : [createGrantMessage({
            grantee : 'did:jwk:delegate123',
            scope   : { interface: 'Records', method: 'Write', protocol: 'https://example.com/handler-routing' },
          })],
          connectedDid: 'did:dht:owner456',
        }),
      };

      const manager = createTestManager(agent);
      (manager as any)._connectHandler = mockHandler;

      const session = await manager.connect({ protocols: HANDLER_PROTOCOLS });

      expect(session.did).toBe('did:dht:owner456');
      expect(manager.isConnected).toBe(true);
    });

    test('rejects an empty grant bundle for non-empty permission requests', async () => {
      const agent = createMockAgent({ firstLaunch: async () => false, identityList: async () => [] });
      const handler = {
        requestAccess: async (): Promise<any> => ({
          delegatePortableDid : { uri: 'did:jwk:delegate123', document: {}, privateKeys: [] },
          connectedDid        : 'did:dht:owner456',
          delegateGrants      : [],
        }),
      };

      const manager = createTestManager(agent);
      await expect(manager.connect({ connectHandler: handler, protocols: HANDLER_PROTOCOLS }))
        .rejects.toThrow('returned no grants');
    });

    test('rejects grants issued to a DID other than the delegate DID', async () => {
      const agent = createMockAgent({ firstLaunch: async () => false, identityList: async () => [] });
      const handler = {
        requestAccess: async (): Promise<any> => ({
          delegatePortableDid : { uri: 'did:jwk:delegate123', document: {}, privateKeys: [] },
          connectedDid        : 'did:dht:owner456',
          delegateGrants      : [createGrantMessage({
            grantee : 'did:jwk:someone-else',
            scope   : { interface: 'Records', method: 'Write', protocol: 'https://example.com/handler-routing' },
          })],
        }),
      };

      const manager = createTestManager(agent);
      await expect(manager.connect({ connectHandler: handler, protocols: HANDLER_PROTOCOLS }))
        .rejects.toThrow('Revoke the approved session in your wallet');
    });

    test('rejects grants issued by a DID other than the connected DID', async () => {
      const agent = createMockAgent({ firstLaunch: async () => false, identityList: async () => [] });
      const handler = {
        requestAccess: async (): Promise<any> => ({
          delegatePortableDid : { uri: 'did:jwk:delegate123', document: {}, privateKeys: [] },
          connectedDid        : 'did:dht:owner456',
          delegateGrants      : [createGrantMessage({
            grantor : 'did:dht:someone-else',
            grantee : 'did:jwk:delegate123',
            scope   : { interface: 'Records', method: 'Write', protocol: 'https://example.com/handler-routing' },
          })],
        }),
      };

      const manager = createTestManager(agent);
      await expect(manager.connect({ connectHandler: handler, protocols: HANDLER_PROTOCOLS }))
        .rejects.toThrow('connected DID');
    });

    test('rejects grants broader than the requested permission scopes', async () => {
      const agent = createMockAgent({ firstLaunch: async () => false, identityList: async () => [] });
      const handler = {
        requestAccess: async (): Promise<any> => ({
          delegatePortableDid : { uri: 'did:jwk:delegate123', document: {}, privateKeys: [] },
          connectedDid        : 'did:dht:owner456',
          delegateGrants      : [createGrantMessage({
            grantee : 'did:jwk:delegate123',
            scope   : { interface: 'Records', method: 'Write', protocol: 'https://example.com/other-protocol' },
          })],
        }),
      };

      const manager = createTestManager(agent);
      await expect(manager.connect({ connectHandler: handler, protocols: HANDLER_PROTOCOLS }))
        .rejects.toThrow('outside the requested permission scope');
    });

    test('accepts session revocation grants declared in sessionRevocations', async () => {
      const delegateIdentity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate123' },
        metadata : { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner456' },
      });
      const agent = createMockAgent({
        firstLaunch    : async () => false,
        identityList   : async () => [],
        identityImport : async () => delegateIdentity,
        syncSync       : async () => {},
      });
      const handler = {
        requestAccess: async (): Promise<any> => ({
          delegatePortableDid : { uri: 'did:jwk:delegate123', document: {}, privateKeys: [] },
          connectedDid        : 'did:dht:owner456',
          delegateGrants      : [
            createGrantMessage({
              grantId : 'session-grant',
              grantee : 'did:jwk:delegate123',
              scope   : { interface: 'Records', method: 'Write', protocol: 'https://example.com/handler-routing' },
            }),
            createGrantMessage({
              grantId : 'revocation-grant',
              grantee : 'did:jwk:delegate123',
              scope   : {
                interface : 'Records',
                method    : 'Write',
                protocol  : 'https://identity.foundation/dwn/permissions',
                contextId : 'session-grant',
              },
            }),
          ],
          sessionRevocations: [{ grantId: 'session-grant', revocationGrantId: 'revocation-grant' }],
        }),
      };

      const manager = createTestManager(agent);
      const session = await manager.connect({ connectHandler: handler, protocols: HANDLER_PROTOCOLS });
      expect(session.did).toBe('did:dht:owner456');
    });

    test('rejects a bundle containing only session revocation grants', async () => {
      const agent = createMockAgent({ firstLaunch: async () => false, identityList: async () => [] });
      const handler = {
        requestAccess: async (): Promise<any> => ({
          delegatePortableDid : { uri: 'did:jwk:delegate123', document: {}, privateKeys: [] },
          connectedDid        : 'did:dht:owner456',
          delegateGrants      : [createGrantMessage({
            grantId : 'revocation-grant',
            grantee : 'did:jwk:delegate123',
            scope   : {
              interface : 'Records',
              method    : 'Write',
              protocol  : 'https://identity.foundation/dwn/permissions',
              contextId : 'session-grant',
            },
          })],
          sessionRevocations: [{ grantId: 'session-grant', revocationGrantId: 'revocation-grant' }],
        }),
      };

      const manager = createTestManager(agent);
      await expect(manager.connect({ connectHandler: handler, protocols: HANDLER_PROTOCOLS }))
        .rejects.toThrow('returned no grants');
    });

    test('per-call connectHandler overrides default handler', async () => {
      const delegateIdentity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate789' },
        metadata : { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner999' },
      });

      const agent = createMockAgent({
        firstLaunch    : async () => false,
        identityList   : async () => [],
        identityImport : async () => delegateIdentity,
        syncSync       : async () => {},
      });

      const perCallHandler = {
        requestAccess: async (): Promise<any> => ({
          delegatePortableDid : { uri: 'did:jwk:delegate789', document: {}, privateKeys: [] },
          delegateGrants      : [createGrantMessage({
            grantor : 'did:dht:owner999',
            grantee : 'did:jwk:delegate789',
            scope   : { interface: 'Records', method: 'Write', protocol: 'https://example.com/handler-routing' },
          })],
          connectedDid: 'did:dht:owner999',
        }),
      };

      const manager = createTestManager(agent);

      const session = await manager.connect({
        protocols      : HANDLER_PROTOCOLS,
        connectHandler : perCallHandler,
      });

      expect(session.did).toBe('did:dht:owner999');
    });

    test('throws when no handler is provided', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [],
      });

      const manager = createTestManager(agent);

      await expect(
        manager.connect({ protocols: HANDLER_PROTOCOLS })
      ).rejects.toThrow('No connect handler provided');
    });

    test('handler-missing fails fast BEFORE initializing the vault on disk', async () => {
      // Regression for the #2 block-on bug: `_handlerConnect` used to call
      // `ensureVaultReady()` before checking for a handler, leaving the
      // vault on-disk locked with the insecure default password when the
      // handler-missing error fired. The check now runs first so misuse
      // can't mutate disk state.
      let initializeCalled = false;
      const agent = createMockAgent({
        firstLaunch  : async () => true,
        initialize   : async () => { initializeCalled = true; return 'phrase'; },
        identityList : async () => [],
      });

      const manager = createTestManager(agent);

      await expect(
        manager.connect({ protocols: HANDLER_PROTOCOLS })
      ).rejects.toThrow('No connect handler provided');

      expect(initializeCalled).toBe(false);
    });

    test('throws when handler returns undefined (user denied)', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [],
      });

      const mockHandler = {
        requestAccess: async (): Promise<undefined> => undefined,
      };

      const manager = createTestManager(agent);
      (manager as any)._connectHandler = mockHandler;

      await expect(
        manager.connect({ protocols: HANDLER_PROTOCOLS })
      ).rejects.toThrow('denied or cancelled');
    });

    test('denial rejects with a typed ConnectDeniedError and preserves the message', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [],
      });

      const mockHandler = {
        requestAccess: async (): Promise<undefined> => undefined,
      };

      const manager = createTestManager(agent);
      (manager as any)._connectHandler = mockHandler;

      let caught: unknown;
      try {
        await manager.connect({ protocols: HANDLER_PROTOCOLS });
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ConnectDeniedError);
      expect(isConnectDeniedError(caught)).toBe(true);
      expect((caught as Error).message).toBe('[@enbox/auth] Connect was denied or cancelled by the user.');
    });

    test('allows sync off for handler connect without throwing', async () => {
      const delegateIdentity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate123' },
        metadata : { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner456' },
      });

      const agent = createMockAgent({
        firstLaunch    : async () => false,
        identityList   : async () => [],
        identityImport : async () => delegateIdentity,
        syncSync       : async () => {},
      });

      const mockHandler = {
        requestAccess: async (): Promise<any> => ({
          delegatePortableDid : { uri: 'did:jwk:delegate123', document: {}, privateKeys: [] },
          delegateGrants      : [createGrantMessage({
            grantee : 'did:jwk:delegate123',
            scope   : { interface: 'Records', method: 'Write', protocol: 'https://example.com/handler-routing' },
          })],
          connectedDid: 'did:dht:owner456',
        }),
      };

      const manager = createTestManager(agent);
      (manager as any)._connectHandler = mockHandler;
      (manager as any)._defaultSync = 'off';

      const session = await manager.connect({ protocols: HANDLER_PROTOCOLS });
      expect(session.did).toBe('did:dht:owner456');
    });
  });

  describe('in-memory cache cleanup on reconnect', () => {
    test('clears previous delegate keys on successful reconnect', async () => {
      const clearCalls: (string | undefined)[] = [];
      const oldIdentity = createMockIdentity({
        did      : { uri: 'did:delegate:old' },
        metadata : { name: 'Old', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected' },
      });
      const newIdentity = createMockIdentity({
        did      : { uri: 'did:delegate:new' },
        metadata : { name: 'New', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected' },
      });
      let identities = [oldIdentity];
      const storage = new MemoryStorage();
      const agent = createMockAgent({
        firstLaunch                    : async () => false,
        identityList                   : async () => identities,
        dwnClearDelegateDecryptionKeys : (did?: string) => { clearCalls.push(did); },
      });
      const manager = createTestManager(agent, { storage });

      // First connect — no previous session, so no clear.
      await manager.connect({ password: 'test' });
      expect(clearCalls).toHaveLength(0);

      // Simulate a fresh wallet connect having replaced the delegate, then
      // reconnect — the previous delegate's in-memory keys must be cleared.
      identities = [oldIdentity, newIdentity];
      await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:delegate:new');
      await manager.connect({ password: 'test' });
      expect(clearCalls).toHaveLength(1);
      expect(clearCalls[0]).toBe('did:delegate:old');
    });

    test('does not clear delegate keys when connect fails', async () => {
      const clearCalls: (string | undefined)[] = [];
      const agent = createMockAgent({
        firstLaunch                    : async () => false,
        identityList                   : async () => [], // no identities → first launch
        start                          : async () => { throw new Error('vault unlock failed'); },
        dwnClearDelegateDecryptionKeys : (did?: string) => { clearCalls.push(did); },
      });
      const manager = createTestManager(agent);

      await expect(manager.connect({ password: 'test' })).rejects.toThrow();

      // Keys should NOT have been cleared since the connect failed —
      // a prior active session's keys must survive.
      expect(clearCalls).toHaveLength(0);
    });

    test('does not wipe newly imported keys on first delegated connect', async () => {
      const clearCalls: (string | undefined)[] = [];
      const agent = createMockAgent({
        firstLaunch                    : async () => false,
        identityList                   : async () => [createMockIdentity()],
        dwnClearDelegateDecryptionKeys : (did?: string) => { clearCalls.push(did); },
      });
      const manager = createTestManager(agent);

      // First connect with no prior session — clear should not be called,
      // preserving any keys the connect flow just imported.
      await manager.connect({ password: 'test' });
      expect(clearCalls).toHaveLength(0);
    });
  });

  describe('concurrency guard', () => {
    test('throws when connect is called concurrently', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        start        : async () => { await new Promise((r) => setTimeout(r, 50)); },
      });
      const manager = createTestManager(agent);

      // Start first connect
      const firstConnect = manager.connect({ password: 'test' });

      // Second connect should throw
      await expect(manager.connect({ password: 'test' })).rejects.toThrow(
        'A connection attempt is already in progress'
      );

      await firstConnect;
    });

    test('throws when restoreSession is called during connect', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        start        : async () => { await new Promise((r) => setTimeout(r, 50)); },
      });
      const manager = createTestManager(agent);

      const firstConnect = manager.connect({ password: 'test' });

      await expect(manager.restoreSession()).rejects.toThrow(
        'A connection attempt is already in progress'
      );

      await firstConnect;
    });
  });

  describe('restoreSession()', () => {
    test('returns undefined when no previous session', async () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);

      const session = await manager.restoreSession();
      expect(session).toBeUndefined();
    });

    test('restores session and sets state to connected', async () => {
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent, { storage });
      let sessionAtEvent = manager.session;
      manager.on('session-start', (): void => { sessionAtEvent = manager.session; });

      const session = await manager.restoreSession();
      expect(session).toBeDefined();
      expect(manager.state).toBe('connected');
      expect(sessionAtEvent).toBe(session);
    });

  });

  describe('restoreSession() identity selection', () => {
    test('prefers the persisted active identity over other connected identities', async () => {
      const staleIdentity = createMockIdentity({
        did      : { uri: 'did:jwk:stale-delegate' },
        metadata : { name: 'Stale', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner456' },
      });
      const activeIdentity = createMockIdentity({
        did      : { uri: 'did:jwk:fresh-delegate' },
        metadata : { name: 'Fresh', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner456' },
      });
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
      // Production persists the owner DID in ACTIVE_IDENTITY and the
      // delegate's own DID in DELEGATE_DID.
      await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, 'did:dht:owner456');
      await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:fresh-delegate');

      const agent = createMockAgent({
        firstLaunch               : async () => false,
        identityGet               : async (params: any) => (params?.didUri === 'did:jwk:fresh-delegate' ? activeIdentity : undefined),
        identityConnectedIdentity : async () => staleIdentity,
        identityList              : async () => [staleIdentity, activeIdentity],
      });

      const manager = createTestManager(agent, { storage });
      const session = await manager.restoreSession();

      expect(session?.delegateDid).toBe('did:jwk:fresh-delegate');
    });
  });

  describe('disconnect()', () => {
    test('stops sync before sending session revocations', async () => {
      const order: string[] = [];
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
      await storage.set(STORAGE_KEYS.SESSION_REVOCATIONS, JSON.stringify([{ grantId: 'g1', revocationGrantId: 'r1' }]));

      const delegateIdentity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate123' },
        metadata : { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner456' },
      });
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [delegateIdentity],
        syncStopSync : async () => { order.push('stopSync'); },
      });
      // Disconnect reads revocation grants through the agent's DWN API.
      (agent as any).dwn.processRequest = async (params: any): Promise<any> => {
        order.push(`dwn:${params.messageType}`);
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      };

      const manager = createTestManager(agent, { storage });
      const session = await manager.connect({ password: 'test' });
      expect(session.signal.aborted).toBe(false);
      order.length = 0; // observe only the disconnect sequence

      await manager.disconnect();

      expect(session.signal.aborted).toBe(true);
      const stopIndex = order.indexOf('stopSync');
      const firstReadIndex = order.indexOf('dwn:RecordsRead');
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(firstReadIndex).toBeGreaterThan(stopIndex);
    });

    test('clean disconnect removes the delegate identity locally', async () => {
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
      const delegateIdentity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate123' },
        metadata : { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner456' },
      });
      const deletedDids: string[] = [];
      const deletedIdentities: string[] = [];
      const agent = createMockAgent({
        firstLaunch    : async () => false,
        identityList   : async () => [delegateIdentity],
        identityGet    : async () => delegateIdentity,
        didDelete      : async (params: any) => { deletedDids.push(params.didUri); },
        identityDelete : async (params: any) => { deletedIdentities.push(params.didUri); },
      });
      const manager = createTestManager(agent, { storage });
      await manager.connect({ password: 'test' });

      await manager.disconnect();

      expect(deletedDids).toContain('did:jwk:delegate123');
      expect(deletedIdentities).toContain('did:jwk:delegate123');
    });

    test('disconnect keeps the delegate identity while revocations are queued for retry', async () => {
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
      await storage.set(STORAGE_KEYS.SESSION_REVOCATIONS, JSON.stringify([{ grantId: 'g1', revocationGrantId: 'r1' }]));
      const delegateIdentity = createMockIdentity({
        did      : { uri: 'did:jwk:delegate123' },
        metadata : { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner456' },
      });
      const deletedIdentities: string[] = [];
      const agent = createMockAgent({
        firstLaunch    : async () => false,
        identityList   : async () => [delegateIdentity],
        identityGet    : async () => delegateIdentity,
        identityDelete : async (params: any) => { deletedIdentities.push(params.didUri); },
      });
      // The revocation read returns 202, so every revocation fails and
      // lands in the retry queue — the delegate must remain usable.
      (agent as any).dwn.processRequest = async (): Promise<any> => ({ reply: { status: { code: 202, detail: 'Accepted' } } });

      const manager = createTestManager(agent, { storage });
      await manager.connect({ password: 'test' });

      await manager.disconnect();

      expect(deletedIdentities).toHaveLength(0);
      expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).not.toBeNull();
    });

    test('clean disconnect removes session markers', async () => {
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
      await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, 'did:test');
      await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:delegate');
      await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:connected');

      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent, { storage });
      await manager.connect({ password: 'test' });

      await manager.disconnect();

      expect(manager.state).toBe('unlocked');
      expect(manager.session).toBeUndefined();
      expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBeNull();
      expect(await storage.get(STORAGE_KEYS.ACTIVE_IDENTITY)).toBeNull();
    });

    test('clean disconnect clears the runtime delegate decryption key cache', async () => {
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      let clearCalled = false;
      const agent = createMockAgent({
        firstLaunch                    : async () => false,
        identityList                   : async () => [createMockIdentity()],
        dwnClearDelegateDecryptionKeys : () => { clearCalled = true; },
      });
      const manager = createTestManager(agent, { storage });
      await manager.connect({ password: 'test' });

      await manager.disconnect();

      expect(clearCalled).toBe(true);
    });

    test('clean disconnect removes delegate context keys and multi-party protocols from storage', async () => {
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
      await storage.set(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS, JSON.stringify([{ protocol: 'test', contextId: 'c1' }]));
      await storage.set(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS, JSON.stringify(['https://test.xyz']));

      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent, { storage });
      await manager.connect({ password: 'test' });

      await manager.disconnect();

      expect(await storage.get(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS)).toBeNull();
      expect(await storage.get(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS)).toBeNull();
    });

    test('clean disconnect clears delegate context keys from SecretStore', async () => {
      const { Convert } = await import('@enbox/common');
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });

      await agent.secrets.put(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS, Convert.string('[]').toUint8Array());

      const manager = createTestManager(agent, { storage });
      await manager.connect({ password: 'test' });
      await manager.disconnect();

      expect(await agent.secrets.get(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS)).toBeUndefined();
    });

    test('nuclear disconnect clears delegate decryption key cache', async () => {
      let clearCalled = false;
      const agent = createMockAgent({
        firstLaunch                    : async () => false,
        identityList                   : async () => [createMockIdentity()],
        dwnClearDelegateDecryptionKeys : () => { clearCalled = true; },
      });
      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      await manager.disconnect({ clearStorage: true });

      expect(clearCalled).toBe(true);
    });

    test('nuclear disconnect clears all storage including SecretStore', async () => {
      const { Convert } = await import('@enbox/common');
      const storage = new MemoryStorage();

      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });

      // Pre-populate SecretStore with secret types.
      await agent.secrets.put(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS, Convert.string('[]').toUint8Array());
      await agent.secrets.put(STORAGE_KEYS.REGISTRATION_TOKENS, Convert.string('{}').toUint8Array());

      const manager = createTestManager(agent, { storage });
      await manager.connect({ password: 'test' });

      await manager.disconnect({ clearStorage: true });

      expect(manager.state).toBe('unlocked');
      expect(manager.session).toBeUndefined();

      // All secrets must be wiped.
      expect(await agent.secrets.get(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS)).toBeUndefined();
      expect(await agent.secrets.get(STORAGE_KEYS.REGISTRATION_TOKENS)).toBeUndefined();
    });

    test('emits session-end event with DID', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      const events: any[] = [];
      manager.on('session-end', (payload) => { events.push(payload); });

      await manager.disconnect();

      expect(events).toHaveLength(1);
      expect(events[0].did).toBe('did:dht:testuser123');
    });

    test('disconnect with no active session does not emit session-end', async () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);
      const events: any[] = [];
      manager.on('session-end', (payload) => { events.push(payload); });

      await manager.disconnect();

      expect(events).toHaveLength(0);
    });

    test('disconnect calls sync.stopSync when available', async () => {
      const stopCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        syncStopSync : async (timeout) => { stopCalls.push(timeout); },
      });

      // Add the sync.stopSync in the format the disconnect code checks
      (agent as any).sync.stopSync = async (timeout: number): Promise<void> => { stopCalls.push(timeout); };

      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      await manager.disconnect({ timeout: 5000 });

      expect(stopCalls).toHaveLength(1);
      expect(stopCalls[0]).toBe(5000);
    });
  });

  describe('events', () => {
    test('on() subscribes to auth events', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);
      const states: any[] = [];

      manager.on('state-change', (payload) => { states.push(payload); });

      await manager.connect({ password: 'test' });

      expect(states.length).toBeGreaterThan(0);
      expect(states[states.length - 1].current).toBe('connected');
    });

    test('on() returns unsubscribe function', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);

      const unsub = manager.on('state-change', () => {});
      expect(typeof unsub).toBe('function');
      unsub();
    });
  });

  describe('listIdentities()', () => {
    test('returns mapped identity info', async () => {
      const agent = createMockAgent({
        identityList: async () => [
          createMockIdentity({ did: { uri: 'did:1' }, metadata: { name: 'Alice', tenant: 't1' } }),
          createMockIdentity({ did: { uri: 'did:2' }, metadata: { name: 'Bob', tenant: 't2', connectedDid: 'did:ext' } }),
        ],
      });
      const manager = createTestManager(agent);

      const identities = await manager.listIdentities();
      expect(identities).toHaveLength(2);
      expect(identities[0]).toEqual({ didUri: 'did:1', name: 'Alice', connectedDid: undefined });
      expect(identities[1]).toEqual({ didUri: 'did:2', name: 'Bob', connectedDid: 'did:ext' });
    });
  });

  describe('switchIdentity()', () => {
    test('disconnects current session and switches to new identity', async () => {
      const identity = createMockIdentity({ did: { uri: 'did:new' }, metadata: { name: 'New', tenant: 'did:dht:testagent' } });
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        identityGet  : async () => identity,
      });
      const manager = createTestManager(agent);
      const previousSession = await manager.connect({ password: 'test' });
      expect(previousSession.signal.aborted).toBe(false);

      const session = await manager.switchIdentity('did:new');
      expect(previousSession.signal.aborted).toBe(true);
      expect(session.signal.aborted).toBe(false);
      expect(session.did).toBe('did:new');
      expect(manager.state).toBe('connected');
    });

    test('throws when identity not found', async () => {
      const agent = createMockAgent({
        identityGet: async () => undefined,
      });
      const manager = createTestManager(agent);

      await expect(manager.switchIdentity('did:nonexistent')).rejects.toThrow(
        'Identity not found: did:nonexistent'
      );
    });

    test('handles wallet-connected identity', async () => {
      const identity = createMockIdentity({
        did      : { uri: 'did:delegate' },
        metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:external' },
      });
      const agent = createMockAgent({ identityGet: async () => identity });
      const manager = createTestManager(agent);

      const session = await manager.switchIdentity('did:delegate');
      expect(session.did).toBe('did:external');
      expect(session.delegateDid).toBe('did:delegate');
    });

    test('emits session-start event', async () => {
      const identity = createMockIdentity();
      const agent = createMockAgent({ identityGet: async () => identity });
      const manager = createTestManager(agent);
      const events: Record<string, never>[] = [];
      manager.on('session-start', (event): void => { events.push(event); });

      const session = await manager.switchIdentity('did:dht:testuser123');

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({});
      expect(manager.session).toBe(session);
    });

    for (const teardown of ['lock', 'disconnect', 'shutdown'] as const) {
      test(`does not install a switched session after ${teardown} invalidates the lookup`, async () => {
        let resolveIdentity!: (identity: ReturnType<typeof createMockIdentity>) => void;
        let markLookupStarted!: () => void;
        const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve; });
        const identityResult = new Promise<ReturnType<typeof createMockIdentity>>((resolve) => {
          resolveIdentity = resolve;
        });
        const identity = createMockIdentity();
        const agent = createMockAgent({
          identityGet: async () => {
            markLookupStarted();
            return identityResult;
          },
        });
        const manager = createTestManager(agent);
        let sessionStarts = 0;
        manager.on('session-start', () => { sessionStarts++; });

        const switchPromise = manager.switchIdentity(identity.did.uri);
        await lookupStarted;
        const teardownPromise = manager[teardown]();
        resolveIdentity(identity);

        await expect(switchPromise).rejects.toThrow('invalidated');
        await teardownPromise;
        expect(manager.session).toBeUndefined();
        expect(manager.state).toBe(teardown === 'disconnect' ? 'unlocked' : 'locked');
        expect(sessionStarts).toBe(0);
      });
    }

    test('starts sync with a bare-interval settle-check cadence', async () => {
      const syncCalls: any[] = [];
      const identity = createMockIdentity();
      const agent = createMockAgent({
        identityGet   : async () => identity,
        syncStartSync : async (params) => { syncCalls.push(params); },
      });
      const manager = createTestManager(agent, { sync: '10s' });

      await manager.switchIdentity('did:dht:testuser123');

      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].interval).toBe('10s');
    });

    test('skips sync when off', async () => {
      const syncCalls: any[] = [];
      const identity = createMockIdentity();
      const agent = createMockAgent({
        identityGet   : async () => identity,
        syncStartSync : async (params) => { syncCalls.push(params); },
      });
      const manager = createTestManager(agent, { sync: 'off' });

      await manager.switchIdentity('did:dht:testuser123');

      expect(syncCalls).toHaveLength(0);
    });
  });

  describe('deleteIdentity()', () => {
    test('deletes DID and identity', async () => {
      const didDeleteCalls: any[] = [];
      const identityDeleteCalls: any[] = [];
      const identity = createMockIdentity();

      const agent = createMockAgent({
        identityGet    : async () => identity,
        didDelete      : async (params) => { didDeleteCalls.push(params); },
        identityDelete : async (params) => { identityDeleteCalls.push(params); },
      });
      const manager = createTestManager(agent);

      await manager.deleteIdentity('did:dht:testuser123');

      expect(didDeleteCalls).toHaveLength(1);
      expect(didDeleteCalls[0].deleteKey).toBe(true);
      expect(identityDeleteCalls).toHaveLength(1);
    });

    test('disconnects active identity before deleting', async () => {
      const identity = createMockIdentity();
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [identity],
        identityGet  : async () => identity,
      });
      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      await manager.deleteIdentity('did:dht:testuser123');

      expect(manager.session).toBeUndefined();
    });

    test('throws when identity not found', async () => {
      const agent = createMockAgent({ identityGet: async () => undefined });
      const manager = createTestManager(agent);

      await expect(manager.deleteIdentity('did:nonexistent')).rejects.toThrow(
        'Identity not found: did:nonexistent'
      );
    });

    test('emits identity-removed event', async () => {
      const identity = createMockIdentity();
      const agent = createMockAgent({ identityGet: async () => identity });
      const manager = createTestManager(agent);
      const events: any[] = [];
      manager.on('identity-removed', (payload) => { events.push(payload); });

      await manager.deleteIdentity('did:dht:testuser123');

      expect(events).toHaveLength(1);
      expect(events[0].didUri).toBe('did:dht:testuser123');
    });

    test('throws when DID deletion fails to prevent orphaned keys', async () => {
      const identity = createMockIdentity();
      const agent = createMockAgent({
        identityGet : async () => identity,
        didDelete   : async () => { throw new Error('DID delete failed'); },
      });
      const manager = createTestManager(agent);

      // DID deletion failure must propagate — otherwise the identity
      // record is deleted while cryptographic keys remain as orphans.
      await expect(
        manager.deleteIdentity('did:dht:testuser123')
      ).rejects.toThrow('DID delete failed');
    });
  });

  describe('exportIdentity()', () => {
    test('delegates to agent.identity.export', async () => {
      const exportData = { portableDid: { uri: 'did:test' } } as any;
      const agent = createMockAgent({
        identityExport: async () => exportData,
      });
      const manager = createTestManager(agent);

      const result = await manager.exportIdentity('did:test');
      expect(result).toBe(exportData);
    });
  });

  describe('importFromPortable()', () => {
    test('calls importFromPortable flow and sets state', async () => {
      const agent = createMockAgent({
        identityImport: async () => createMockIdentity(),
      });
      const manager = createTestManager(agent);

      const session = await manager.importFromPortable({
        portableIdentity: {} as any,
      });

      expect(session.did).toBe('did:dht:testuser123');
      expect(manager.state).toBe('connected');
    });
  });

  describe('lock()', () => {
    test('aborts the session before waiting for sync to stop', async () => {
      let releaseStop!: () => void;
      const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        syncStopSync : async () => stopGate,
      });
      const manager = createTestManager(agent);
      const session = await manager.connect({ password: 'test' });

      const lockPromise = manager.lock();

      expect(session.signal.aborted).toBe(true);
      releaseStop();
      await lockPromise;
    });

    test('stops sync, clears session, locks vault, transitions to locked', async () => {
      const lockCalls: any[] = [];
      const stopCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        vaultLock    : async () => { lockCalls.push('locked'); },
      });
      (agent as any).sync.stopSync = async (timeout: number): Promise<void> => { stopCalls.push(timeout); };

      const manager = createTestManager(agent);
      const session = await manager.connect({ password: 'test' });
      expect(manager.state).toBe('connected');
      expect(session.signal.aborted).toBe(false);

      await manager.lock();

      expect(session.signal.aborted).toBe(true);
      expect(manager.state).toBe('locked');
      expect(manager.session).toBeUndefined();
      expect(lockCalls).toHaveLength(1);
      expect(stopCalls).toHaveLength(1);
    });

    test('finishes local session teardown before surfacing a sync stop failure', async () => {
      const vaultLocks: string[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        syncStopSync : async () => { throw new Error('sync stop failed'); },
        vaultLock    : async () => { vaultLocks.push('locked'); },
      });
      const manager = createTestManager(agent);
      const session = await manager.connect({ password: 'test' });
      const sessionEnds: string[] = [];
      manager.on('session-end', ({ did }): void => { sessionEnds.push(did); });

      await expect(manager.lock()).rejects.toThrow('sync stop failed');

      expect(session.signal.aborted).toBe(true);
      expect(manager.session).toBeUndefined();
      expect(manager.state).toBe('locked');
      expect(vaultLocks).toEqual(['locked']);
      expect(sessionEnds).toEqual([session.did]);
    });

    test('emits session-end event when session was active', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      const events: any[] = [];
      manager.on('session-end', (payload) => { events.push(payload); });

      await manager.lock();

      expect(events).toHaveLength(1);
      expect(events[0].did).toBe('did:dht:testuser123');
    });

    test('does not emit session-end when no active session', async () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent, { initialState: 'unlocked' });
      const events: any[] = [];
      manager.on('session-end', (payload) => { events.push(payload); });

      await manager.lock();

      expect(events).toHaveLength(0);
      expect(manager.state).toBe('locked');
    });

    test('emits vault-locked event', async () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent, { initialState: 'unlocked' });
      const events: any[] = [];
      manager.on('vault-locked', (payload) => { events.push(payload); });

      await manager.lock();

      expect(events).toHaveLength(1);
    });

    test('uses custom timeout for sync stop', async () => {
      const stopCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      (agent as any).sync.stopSync = async (timeout: number): Promise<void> => { stopCalls.push(timeout); };

      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      await manager.lock({ timeout: 5000 });

      expect(stopCalls).toHaveLength(1);
      expect(stopCalls[0]).toBe(5000);
    });

    test('preserves session storage markers for subsequent restore', async () => {
      const storage = new MemoryStorage();
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent, { storage });
      await manager.connect({ password: 'test' });

      // Verify markers exist after connect
      expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBe('true');

      await manager.lock();

      // Markers should still be present (unlike disconnect)
      expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBe('true');
    });
  });

  describe('switchIdentity() — sync registration', () => {
    test('calls sync.registerIdentity with explicit local identity scope for the target identity', async () => {
      const registerCalls: any[] = [];
      const identity = createMockIdentity();
      const agent = createMockAgent({
        identityGet          : async () => identity,
        syncRegisterIdentity : async (params) => { registerCalls.push(params); },
        syncStartSync        : async () => {},
      });
      const manager = createTestManager(agent, {
        sync                  : '10s',
        identitySyncProtocols : ['https://proto.example/profile'],
      });

      await manager.switchIdentity('did:dht:testuser123');

      expect(registerCalls).toHaveLength(1);
      expect(registerCalls[0].did).toBe('did:dht:testuser123');
      expect(registerCalls[0].options.protocols).toEqual(['https://proto.example/profile']);
    });

    test('leaves local identity sync registration to the application when no explicit scope is configured', async () => {
      const registerCalls: any[] = [];
      const unregisterCalls: string[] = [];
      const identity = createMockIdentity();
      const agent = createMockAgent({
        identityGet            : async () => identity,
        syncRegisterIdentity   : async (params) => { registerCalls.push(params); },
        syncUnregisterIdentity : async (did) => { unregisterCalls.push(did); },
        syncStartSync          : async () => {},
      });
      const manager = createTestManager(agent, { sync: '10s' });

      await manager.switchIdentity('did:dht:testuser123');

      expect(registerCalls).toHaveLength(0);
      expect(unregisterCalls).toHaveLength(0);
    });

    test('unregisters sync for delegate with zero grants', async () => {
      const registerCalls: any[] = [];
      const unregisterCalls: string[] = [];
      const identity = createMockIdentity({
        did      : { uri: 'did:delegate' },
        metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:external' },
      });
      const agent = createMockAgent({
        identityGet            : async () => identity,
        syncRegisterIdentity   : async (params) => { registerCalls.push(params); },
        syncUnregisterIdentity : async (did) => { unregisterCalls.push(did); },
        syncStartSync          : async () => {},
      });
      const manager = createTestManager(agent, {
        sync                  : '10s',
        identitySyncProtocols : ['https://proto.example/profile'],
      });

      await manager.switchIdentity('did:delegate');

      // Zero grants — should unregister (not register) to clear stale scope.
      expect(registerCalls).toHaveLength(0);
      expect(unregisterCalls).toHaveLength(1);
      expect(unregisterCalls[0]).toBe('did:external');
    });

    test('registers with all for delegate with unscoped grant', async () => {
      const registerCalls: any[] = [];
      const identity = createMockIdentity({
        did      : { uri: 'did:delegate' },
        metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:external' },
      });
      const agent = createMockAgent({
        identityGet          : async () => identity,
        syncRegisterIdentity : async (params) => { registerCalls.push(params); },
        syncStartSync        : async () => {},
        // Return an unscoped grant (no protocol in scope).
        processDwnRequest    : async (params: any) => {
          if (params?.messageType === 'RecordsQuery') {
            return {
              reply: {
                status  : { code: 200, detail: 'OK' },
                entries : [{
                  recordId    : 'grant-unrestricted',
                  contextId   : 'grant-unrestricted',
                  encodedData : btoa(JSON.stringify({
                    dateExpires : '2040-01-01T00:00:00.000Z',
                    scope       : { interface: 'Messages', method: 'Read' },
                    delegated   : true,
                  })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
                  descriptor: {
                    interface    : 'Records',
                    method       : 'Write',
                    protocol     : 'https://identity.foundation/dwn/permissions',
                    protocolPath : 'grant',
                    recipient    : 'did:delegate',
                    dateCreated  : '2025-01-01T00:00:00.000000Z',
                    dataFormat   : 'application/json',
                    dataCid      : 'bafytest',
                    dataSize     : 100,
                  },
                  authorization: {
                    signature: {
                      signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:dht:owner#sig' })) }],
                    },
                  },
                }],
              },
            };
          }
          return { reply: { status: { code: 202, detail: 'Accepted' } } };
        },
      });
      const manager = createTestManager(agent, {
        sync                  : '10s',
        identitySyncProtocols : ['https://proto.example/profile'],
      });

      await manager.switchIdentity('did:delegate');

      expect(registerCalls).toHaveLength(1);
      expect(registerCalls[0].options.protocols).toBe('all');
    });

    test('rethrows I/O errors from unregisterIdentity', async () => {
      const identity = createMockIdentity({
        did      : { uri: 'did:delegate' },
        metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:external' },
      });
      const agent = createMockAgent({
        identityGet            : async () => identity,
        syncUnregisterIdentity : async () => { throw new Error('LEVEL_IO_ERROR'); },
        syncStartSync          : async () => {},
      });
      const manager = createTestManager(agent, { sync: '10s' });

      await expect(manager.switchIdentity('did:delegate')).rejects.toThrow('LEVEL_IO_ERROR');
    });

    test('handles already-registered identity gracefully', async () => {
      const updateCalls: any[] = [];
      const identity = createMockIdentity();
      const agent = createMockAgent({
        identityGet               : async () => identity,
        syncRegisterIdentity      : async () => { throw new Error('Identity already registered'); },
        syncUpdateIdentityOptions : async (params) => { updateCalls.push(params); },
        syncStartSync             : async () => {},
      });
      const manager = createTestManager(agent, {
        sync                  : '10s',
        identitySyncProtocols : ['https://proto.example/profile'],
      });

      // Should not throw — falls back to updateIdentityOptions.
      const session = await manager.switchIdentity('did:dht:testuser123');
      expect(session.did).toBe('did:dht:testuser123');
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].did).toBe('did:dht:testuser123');
    });

    test('repairs registration but does not start sync when sync is off', async () => {
      const registerCalls: any[] = [];
      const syncStartCalls: any[] = [];
      const identity = createMockIdentity();
      const agent = createMockAgent({
        identityGet          : async () => identity,
        syncRegisterIdentity : async (params) => { registerCalls.push(params); },
        syncStartSync        : async (params) => { syncStartCalls.push(params); },
      });
      const manager = createTestManager(agent, {
        sync                  : 'off',
        identitySyncProtocols : ['https://proto.example/profile'],
      });

      await manager.switchIdentity('did:dht:testuser123');

      // Registration still happens (to keep on-disk state correct).
      expect(registerCalls).toHaveLength(1);
      // But sync does not start.
      expect(syncStartCalls).toHaveLength(0);
    });

    test('unregisters delegate with zero grants even when sync is off', async () => {
      const unregisterCalls: string[] = [];
      const registerCalls: any[] = [];
      const identity = createMockIdentity({
        did      : { uri: 'did:delegate' },
        metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:external' },
      });
      const agent = createMockAgent({
        identityGet            : async () => identity,
        syncRegisterIdentity   : async (params) => { registerCalls.push(params); },
        syncUnregisterIdentity : async (did) => { unregisterCalls.push(did); },
      });
      const manager = createTestManager(agent, { sync: 'off' });

      await manager.switchIdentity('did:delegate');

      // Zero grants → should unregister stale scope even with sync off.
      expect(registerCalls).toHaveLength(0);
      expect(unregisterCalls).toHaveLength(1);
      expect(unregisterCalls[0]).toBe('did:external');
    });
  });

  describe('state machine', () => {
    test('state changes emit state-change events', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);
      const transitions: any[] = [];
      manager.on('state-change', (payload) => { transitions.push(payload); });

      await manager.connect({ password: 'test' });

      expect(transitions.some((t) => t.current === 'connected')).toBe(true);
    });

    test('same state does not emit event', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent, { initialState: 'connected' });
      const transitions: any[] = [];
      manager.on('state-change', (payload) => { transitions.push(payload); });

      // Connect again — state is already 'connected', so the final
      // _setState('connected') should be a no-op.
      await manager.connect({ password: 'test' });

      // Should not have emitted a connected→connected transition
      const connectToConnect = transitions.filter(
        (t) => t.previous === 'connected' && t.current === 'connected'
      );
      expect(connectToConnect).toHaveLength(0);
    });
  });

  describe('connectHeadless()', () => {
    test('unlocks vault and returns session without sync', async () => {
      const startCalls: any[] = [];
      const syncCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch   : async () => false,
        start         : async (params) => { startCalls.push(params); },
        identityList  : async () => [createMockIdentity()],
        syncStartSync : async (params) => { syncCalls.push(params); },
      });
      const manager = createTestManager(agent);
      let sessionStarts = 0;
      manager.on('session-start', (): void => { sessionStarts++; });

      const session = await manager.connectHeadless({ password: 'my-password' });

      expect(session.did).toBe('did:dht:testuser123');
      expect(manager.state).toBe('connected');
      expect(manager.session).toBe(session);
      // Agent was started with the password
      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('my-password');
      // Sync was NOT started
      expect(syncCalls).toHaveLength(0);
      // Headless setup does not publish session-start.
      expect(sessionStarts).toBe(0);
    });

    test('throws when no password is provided and no default', async () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);

      await expect(manager.connectHeadless()).rejects.toThrow(
        'connectHeadless() requires a password'
      );
    });

    test('uses default password when no override', async () => {
      const startCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent, { password: 'default-pw' });

      await manager.connectHeadless();

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('default-pw');
    });

    test('initialises vault on first launch', async () => {
      const initCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => true,
        initialize   : async (params) => { initCalls.push(params); return 'phrase'; },
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);

      await manager.connectHeadless({ password: 'new-pw' });

      expect(initCalls).toHaveLength(1);
      expect(initCalls[0].password).toBe('new-pw');
    });

    test('throws when no identities exist', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [],
      });
      const manager = createTestManager(agent);

      await expect(manager.connectHeadless({ password: 'pw' })).rejects.toThrow(
        'No identities found in vault'
      );
    });

    test('prefers previously-active identity', async () => {
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, 'did:dht:second');

      const identities = [
        createMockIdentity({ did: { uri: 'did:dht:first' }, metadata: { name: 'First', tenant: 't1' } }),
        createMockIdentity({ did: { uri: 'did:dht:second' }, metadata: { name: 'Second', tenant: 't2' } }),
      ];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => identities,
      });
      const manager = createTestManager(agent, { storage });

      const session = await manager.connectHeadless({ password: 'pw' });

      expect(session.did).toBe('did:dht:second');
    });

    test('falls back to first identity when saved identity not found', async () => {
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, 'did:dht:gone');

      const identities = [
        createMockIdentity({ did: { uri: 'did:dht:first' }, metadata: { name: 'First', tenant: 't1' } }),
      ];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => identities,
      });
      const manager = createTestManager(agent, { storage });

      const session = await manager.connectHeadless({ password: 'pw' });

      expect(session.did).toBe('did:dht:first');
    });

    test('handles wallet-connected identity (connectedDid)', async () => {
      const identity = createMockIdentity({
        did      : { uri: 'did:dht:delegate' },
        metadata : { name: 'Wallet', tenant: 't1', connectedDid: 'did:dht:external' },
      });
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [identity],
      });
      const manager = createTestManager(agent);

      const session = await manager.connectHeadless({ password: 'pw' });

      expect(session.did).toBe('did:dht:external');
      expect(session.delegateDid).toBe('did:dht:delegate');
    });

    test('does not persist session markers', async () => {
      const storage = new MemoryStorage();
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent, { storage });

      await manager.connectHeadless({ password: 'pw' });

      // No persistence markers should be set
      expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBeNull();
    });

    test('emits vault-unlocked event', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);
      const events: any[] = [];
      manager.on('vault-unlocked', (payload) => { events.push(payload); });

      await manager.connectHeadless({ password: 'pw' });

      expect(events).toHaveLength(1);
    });
  });

  describe('shutdown()', () => {
    test('stops sync, locks vault, closes storage and sync engine', async () => {
      const stopCalls: any[] = [];
      const lockCalls: any[] = [];
      const syncCloseCalls: any[] = [];
      const storageCloseCalls: any[] = [];

      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        vaultLock    : async () => { lockCalls.push('locked'); },
      });
      (agent as any).sync.stopSync = async (timeout: number): Promise<void> => { stopCalls.push(timeout); };
      (agent as any).sync.close = async (): Promise<void> => { syncCloseCalls.push('closed'); };

      const storage = new MemoryStorage();
      (storage as any).close = async (): Promise<void> => { storageCloseCalls.push('closed'); };

      const manager = createTestManager(agent, { storage });
      const session = await manager.connect({ password: 'test' });
      expect(session.signal.aborted).toBe(false);

      await manager.shutdown();

      expect(session.signal.aborted).toBe(true);
      expect(stopCalls).toHaveLength(1);
      expect(stopCalls[0]).toBe(2000); // default timeout
      expect(lockCalls).toHaveLength(1);
      expect(syncCloseCalls).toHaveLength(1);
      expect(storageCloseCalls).toHaveLength(1);
      expect(manager.state).toBe('locked');
      expect(manager.session).toBeUndefined();
    });

    test('emits session-end when session was active', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      const events: any[] = [];
      manager.on('session-end', (payload) => { events.push(payload); });

      await manager.shutdown();

      expect(events).toHaveLength(1);
      expect(events[0].did).toBe('did:dht:testuser123');
    });

    test('does not emit session-end when no active session', async () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent, { initialState: 'unlocked' });
      const events: any[] = [];
      manager.on('session-end', (payload) => { events.push(payload); });

      await manager.shutdown();

      expect(events).toHaveLength(0);
    });

    test('is idempotent — second call is a no-op', async () => {
      const stopCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      (agent as any).sync.stopSync = async (timeout: number): Promise<void> => { stopCalls.push(timeout); };

      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      await manager.shutdown();
      await manager.shutdown(); // second call

      // stopSync called only once
      expect(stopCalls).toHaveLength(1);
    });

    test('uses custom timeout', async () => {
      const stopCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      (agent as any).sync.stopSync = async (timeout: number): Promise<void> => { stopCalls.push(timeout); };

      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      await manager.shutdown({ timeout: 5000 });

      expect(stopCalls[0]).toBe(5000);
    });

    test('handles sync.close throwing gracefully', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      // Make close throw — shutdown should still succeed (best-effort).
      (agent as any).sync.close = async (): Promise<void> => { throw new Error('db already closed'); };

      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      // Should not throw
      await manager.shutdown();
      expect(manager.state).toBe('locked');
    });

    test('handles missing storage.close gracefully', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      // MemoryStorage has no close() by default — should not throw
      await manager.shutdown();
      expect(manager.state).toBe('locked');
    });

    test('handles sync.stopSync failure gracefully', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      (agent as any).sync.stopSync = async (): Promise<void> => { throw new Error('sync error'); };

      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      // Should not throw
      await manager.shutdown();
      expect(manager.state).toBe('locked');
    });

    test('handles vault lock failure gracefully', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        vaultLock    : async () => { throw new Error('vault error'); },
      });
      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      // Should not throw
      await manager.shutdown();
      expect(manager.state).toBe('locked');
    });

    test('works from uninitialized state', async () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);

      // Should not throw even with no session/vault
      await manager.shutdown();
      expect(manager.state).toBe('locked');
    });
  });

  describe('passwordProvider integration', () => {
    test('connect() uses provider when no explicit password', async () => {
      const startCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => 'provider-pw');
      const manager = createTestManager(agent, { passwordProvider: provider });

      await manager.connect();

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('provider-pw');
    });

    test('connect() prefers explicit password over provider', async () => {
      const startCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => 'provider-pw');
      const manager = createTestManager(agent, { passwordProvider: provider });

      await manager.connect({ password: 'explicit-pw' });

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('explicit-pw');
    });

    test('connect() prefers defaultPassword over provider', async () => {
      const startCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => 'provider-pw');
      const manager = createTestManager(agent, { password: 'default-pw', passwordProvider: provider });

      await manager.connect();

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('default-pw');
    });

    test('connect() passes create reason on first launch', async () => {
      const reasons: string[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => true,
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async (ctx) => {
        reasons.push(ctx.reason);
        return 'pw';
      });
      const manager = createTestManager(agent, { passwordProvider: provider });

      await manager.connect();

      expect(reasons).toEqual(['create']);
    });

    test('connect() passes unlock reason on subsequent launch', async () => {
      const reasons: string[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async (ctx) => {
        reasons.push(ctx.reason);
        return 'pw';
      });
      const manager = createTestManager(agent, { passwordProvider: provider });

      await manager.connect();

      expect(reasons).toEqual(['unlock']);
    });

    test('connectHeadless() uses provider when no explicit password', async () => {
      const startCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => 'headless-pw');
      const manager = createTestManager(agent, { passwordProvider: provider });

      await manager.connectHeadless();

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('headless-pw');
    });

    test('connectHeadless() throws when provider also fails', async () => {
      const agent = createMockAgent();
      const provider = PasswordProvider.fromCallback(async () => {
        throw new Error('provider failed');
      });
      const manager = createTestManager(agent, { passwordProvider: provider });

      await expect(manager.connectHeadless()).rejects.toThrow(
        'provider failed'
      );
    });

    test('restoreSession() uses provider when no explicit password', async () => {
      const startCalls: any[] = [];
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => 'restore-pw');
      const manager = createTestManager(agent, { storage, passwordProvider: provider });

      await manager.restoreSession();

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('restore-pw');
    });

    test('restoreSession() prefers onPasswordRequired over provider', async () => {
      const startCalls: any[] = [];
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => 'provider-pw');
      const manager = createTestManager(agent, { storage, passwordProvider: provider });

      await manager.restoreSession({
        onPasswordRequired: async () => 'callback-pw',
      });

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('callback-pw');
    });

    test('connect() falls back to insecure default when provider fails', async () => {
      const startCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => {
        throw new Error('provider failed');
      });
      const manager = createTestManager(agent, { passwordProvider: provider });

      await manager.connect();

      // Falls back to insecure-static-phrase
      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('insecure-static-phrase');
    });

    test('walletConnect() uses provider', async () => {
      const startCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => 'wallet-pw');
      const manager = createTestManager(agent, { passwordProvider: provider });

      // walletConnect requires specific options — we mock the flow
      // by testing that the password resolution happens before the
      // walletConnect flow starts (which we can verify via start() calls)
      try {
        await manager.walletConnect({
          displayName        : 'Test',
          connectServerUrl   : 'https://relay.example.com',
          permissionRequests : [],
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        });
      } catch {
        // walletConnect flow will fail since we're using mocks,
        // but the password resolution should have happened
      }

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('wallet-pw');
    });
  });
});
