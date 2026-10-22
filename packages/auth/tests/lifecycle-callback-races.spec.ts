import type { EnboxUserAgent } from '@enbox/agent';
import type { RegistrationOptions } from '../src/types.js';

import { DwnRegistrar } from '@enbox/dwn-clients';
import { describe, expect, spyOn, test } from 'bun:test';

import { AuthEventEmitter } from '../src/events.js';
import { AuthManager } from '../src/auth-manager.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { PasswordProvider } from '../src/password-provider.js';
import { STORAGE_KEYS } from '../src/types.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function completesWithin(promise: Promise<void>, timeoutMs = 1000): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => { resolve(false); }, timeoutMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createTestManager(params: {
  agent: EnboxUserAgent;
  storage: MemoryStorage;
  passwordProvider?: PasswordProvider;
  registration?: RegistrationOptions;
}): AuthManager {
  const manager = Object.create(AuthManager.prototype) as AuthManager;
  const internals = manager as any;
  internals._userAgent = params.agent;
  internals._emitter = new AuthEventEmitter();
  internals._storage = params.storage;
  internals._session = undefined;
  internals._state = 'uninitialized';
  internals._isConnecting = false;
  internals._isShutDown = false;
  internals._isShuttingDown = false;
  internals._lifecycleController = new AbortController();
  internals._lifecycleCommitTail = Promise.resolve();
  internals._shutdownPromise = undefined;
  internals._passwordProvider = params.passwordProvider;
  internals._registration = params.registration;
  internals._defaultDwnEndpoints = ['https://dwn.example.com'];
  return manager;
}

async function expectNoSessionPersistence(
  manager: AuthManager,
  storage: MemoryStorage,
): Promise<void> {
  expect(manager.session).toBeUndefined();
  for (const key of [
    STORAGE_KEYS.PREVIOUSLY_CONNECTED,
    STORAGE_KEYS.ACTIVE_IDENTITY,
    STORAGE_KEYS.DELEGATE_DID,
    STORAGE_KEYS.CONNECTED_DID,
  ]) {
    expect(await storage.get(key)).toBeNull();
  }
}

describe('AuthManager lifecycle callback races', () => {
  test('lock invalidates a connection while its terminal vault readiness check is pending', async () => {
    const checking = createDeferred<void>();
    const release = createDeferred<void>();
    const storage = new MemoryStorage();
    const agent = createMockAgent({
      vaultGetDid: async () => {
        checking.resolve();
        await release.promise;
        return { uri: 'did:dht:testagent', metadata: {} };
      },
    });
    const manager = await AuthManager.create({ agent, storage });
    let sessionStarts = 0;
    manager.on('session-start', (): void => { sessionStarts++; });
    const connection = captureRejection(manager.connectVault({ password: 'test-password', sync: 'off' }));
    await checking.promise;
    const locking = manager.lock();
    release.resolve();
    const error = await connection;
    await locking;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('invalidated');
    expect(sessionStarts).toBe(0);
    expect(manager.state).toBe('locked');
    await expectNoSessionPersistence(manager, storage);
  });

  test('lock completes while connectVault waits for its password provider', async () => {
    const providerStarted = createDeferred<void>();
    const password = createDeferred<string>();
    const storage = new MemoryStorage();
    let startCalls = 0;
    const agent = createMockAgent({
      firstLaunch  : async (): Promise<boolean> => false,
      start        : async (): Promise<void> => { startCalls++; },
      identityList : async () => [createMockIdentity()],
    });
    const passwordProvider = PasswordProvider.fromCallback(async (): Promise<string> => {
      providerStarted.resolve();
      return password.promise;
    });
    const manager = createTestManager({ agent, storage, passwordProvider });

    const connectErrorPromise = captureRejection(manager.connectVault({ sync: 'off' }));
    await providerStarted.promise;
    const teardownPromise = manager.lock();
    const teardownCompletedBeforePassword = await completesWithin(teardownPromise);
    password.resolve('test-password');
    const connectError = await connectErrorPromise;
    await teardownPromise;

    expect(teardownCompletedBeforePassword).toBe(true);
    expect(connectError).toBeInstanceOf(Error);
    expect((connectError as Error).message).toContain('invalidated');
    expect(startCalls).toBe(0);
    expect(manager.state).toBe('locked');
    await expectNoSessionPersistence(manager, storage);
  });

  test('shutdown completes while connectHeadless waits for its password provider', async () => {
    const providerStarted = createDeferred<void>();
    const password = createDeferred<string>();
    const storage = new MemoryStorage();
    let startCalls = 0;
    const agent = createMockAgent({
      firstLaunch  : async (): Promise<boolean> => false,
      start        : async (): Promise<void> => { startCalls++; },
      identityList : async () => [createMockIdentity()],
    });
    const passwordProvider = PasswordProvider.fromCallback(async (): Promise<string> => {
      providerStarted.resolve();
      return password.promise;
    });
    const manager = createTestManager({ agent, storage, passwordProvider });

    const connectErrorPromise = captureRejection(manager.connectHeadless());
    await providerStarted.promise;
    const teardownPromise = manager.shutdown();
    const teardownCompletedBeforePassword = await completesWithin(teardownPromise);
    password.resolve('test-password');
    const connectError = await connectErrorPromise;
    await teardownPromise;

    expect(teardownCompletedBeforePassword).toBe(true);
    expect(connectError).toBeInstanceOf(Error);
    expect((connectError as Error).message).toContain('invalidated');
    expect(startCalls).toBe(0);
    expect(manager.state).toBe('locked');
    await expectNoSessionPersistence(manager, storage);
  });

  test('disconnect completes while restoreSession waits for onPasswordRequired', async () => {
    const callbackStarted = createDeferred<void>();
    const password = createDeferred<string>();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, 'did:dht:testuser123');
    let startCalls = 0;
    const agent = createMockAgent({
      firstLaunch  : async (): Promise<boolean> => false,
      start        : async (): Promise<void> => { startCalls++; },
      identityList : async () => [createMockIdentity()],
    });
    const manager = createTestManager({ agent, storage });

    const restoreErrorPromise = captureRejection(manager.restoreSession({
      onPasswordRequired: async (): Promise<string> => {
        callbackStarted.resolve();
        return password.promise;
      },
    }));
    await callbackStarted.promise;
    const teardownPromise = manager.disconnect();
    const teardownCompletedBeforePassword = await completesWithin(teardownPromise);
    password.resolve('test-password');
    const restoreError = await restoreErrorPromise;
    await teardownPromise;

    expect(teardownCompletedBeforePassword).toBe(true);
    expect(restoreError).toBeInstanceOf(Error);
    expect((restoreError as Error).message).toContain('invalidated');
    expect(startCalls).toBe(0);
    expect(manager.state).toBe('unlocked');
    await expectNoSessionPersistence(manager, storage);
  });

  test('clearStorage disconnect prevents provider-auth mutations after pending UI resumes', async () => {
    const providerStarted = createDeferred<void>();
    const providerResult = createDeferred<{ code: string; state: string }>();
    const storage = new MemoryStorage();
    let registrationTokensEmitted = false;

    const agent = createMockAgent({
      firstLaunch      : async (): Promise<boolean> => true,
      identityList     : async () => [createMockIdentity()],
      rpcGetServerInfo : async () => ({
        registrationRequirements : ['provider-auth-v0'],
        providerAuth             : {
          authorizeUrl : 'https://provider.example.com/authorize',
          tokenUrl     : 'https://provider.example.com/token',
          refreshUrl   : 'https://provider.example.com/refresh',
        },
        maxFileSize: 10_000_000,
      }),
    });
    const exchangeAuthCode = spyOn(DwnRegistrar, 'exchangeAuthCode').mockResolvedValue({
      registrationToken : 'new-token',
      refreshToken      : 'new-refresh-token',
      expiresIn         : 3600,
    });
    const registerTenantWithToken = spyOn(DwnRegistrar, 'registerTenantWithToken').mockResolvedValue();
    exchangeAuthCode.mockClear();
    registerTenantWithToken.mockClear();
    const manager = createTestManager({
      agent,
      storage,
      registration: {
        persistTokens          : true,
        onRegistrationTokens   : () => { registrationTokensEmitted = true; },
        onProviderAuthRequired : async (params) => {
          providerStarted.resolve();
          const result = await providerResult.promise;
          return { ...result, state: params.state };
        },
      },
    });

    try {
      const connectErrorPromise = captureRejection(manager.connectVault({
        password : 'test-password',
        sync     : 'off',
      }));
      await providerStarted.promise;

      const teardownPromise = manager.disconnect({ clearStorage: true });
      const teardownCompletedBeforeProvider = await completesWithin(teardownPromise);
      providerResult.resolve({ code: 'auth-code', state: 'ignored' });
      const connectError = await connectErrorPromise;
      await teardownPromise;

      expect(teardownCompletedBeforeProvider).toBe(true);
      expect(connectError).toBeInstanceOf(Error);
      expect((connectError as Error).message).toContain('invalidated');
      expect(registrationTokensEmitted).toBe(false);
      expect(exchangeAuthCode).not.toHaveBeenCalled();
      expect(registerTenantWithToken).not.toHaveBeenCalled();
      expect(await storage.get(STORAGE_KEYS.REGISTRATION_TOKENS)).toBeNull();
      expect(await agent.secrets.get(STORAGE_KEYS.REGISTRATION_TOKENS)).toBeUndefined();
      await expectNoSessionPersistence(manager, storage);
    } finally {
      exchangeAuthCode.mockRestore();
      registerTenantWithToken.mockRestore();
    }
  });
});
