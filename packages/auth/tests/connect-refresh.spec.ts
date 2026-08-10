import type { DwnProtocolDefinition, EnboxUserAgent } from '@enbox/agent';

import type { ConnectHandler, ConnectionStatus } from '../src/types.js';

import sinon from 'sinon';
import { afterEach, describe, expect, test } from 'bun:test';

import { AuthEventEmitter } from '../src/events.js';
import { AuthManager } from '../src/auth-manager.js';
import { AuthSession } from '../src/identity-session.js';
import { Convert } from '@enbox/common';
import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';
import { WalletConnect } from '../src/wallet-connect-client.js';
import { ConnectDeniedError, isConnectDeniedError } from '../src/errors.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

const OWNER_DID = 'did:dht:owner';
const DELEGATE_DID = 'did:dht:delegate';
const PROTOCOLS: DwnProtocolDefinition[] = [{
  protocol  : 'https://example.com/notes',
  published : true,
  types     : {},
  structure : {},
}];

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

class BlockingMemoryStorage extends MemoryStorage {
  public readonly setStarted = createDeferred<void>();
  private readonly _setRelease = createDeferred<void>();

  public releaseSets(): void {
    this._setRelease.resolve();
  }

  public override async set(key: string, value: string): Promise<void> {
    this.setStarted.resolve();
    await this._setRelease.promise;
    await super.set(key, value);
  }
}

function createTestManager(agent: EnboxUserAgent, options: {
  connectHandler?: ConnectHandler;
  delegatedSession?: boolean;
  storage?: MemoryStorage;
} = {}): AuthManager {
  const manager = Object.create(AuthManager.prototype) as AuthManager;
  const internals = manager as any;
  internals._userAgent = agent;
  internals._emitter = new AuthEventEmitter();
  internals._storage = options.storage ?? new MemoryStorage();
  internals._state = options.delegatedSession === false ? 'unlocked' : 'connected';
  internals._isConnecting = false;
  internals._isShutDown = false;
  internals._isShuttingDown = false;
  internals._lifecycleGeneration = 0;
  internals._lifecycleCommitTail = Promise.resolve();
  internals._shutdownPromise = undefined;
  internals._connectHandler = options.connectHandler;
  internals._defaultPassword = 'test-password';
  const sessionLifetime = options.delegatedSession === false ? undefined : new AbortController();
  internals._sessionLifetime = sessionLifetime;
  internals._session = sessionLifetime === undefined
    ? undefined
    : new AuthSession({
      agent,
      did         : OWNER_DID,
      delegateDid : DELEGATE_DID,
      identity    : {
        didUri       : OWNER_DID,
        name         : 'Connected identity',
        connectedDid : OWNER_DID,
      },
      signal: sessionLifetime.signal,
    });

  return manager;
}

function createCoveringGrantMessage(): any {
  return {
    recordId    : 'refresh-grant-1',
    contextId   : 'refresh-grant-1',
    encodedData : Convert.object({
      dateExpires : '2040-01-01T00:00:00.000000Z',
      delegated   : true,
      scope       : {
        interface : 'Records',
        method    : 'Write',
        protocol  : 'https://example.com/notes',
      },
    }).toBase64Url(),
    descriptor: {
      interface    : 'Records',
      method       : 'Write',
      protocol     : 'https://identity.foundation/dwn/permissions',
      protocolPath : 'grant',
      recipient    : DELEGATE_DID,
      dateCreated  : '2026-07-13T00:00:00.000000Z',
      dataFormat   : 'application/json',
      dataCid      : 'bafytest',
      dataSize     : 100,
    },
    authorization: {
      signature: {
        signatures: [{
          protected: Convert.object({ kid: `${OWNER_DID}#key-1` }).toBase64Url(),
        }],
      },
    },
  };
}

function createRefreshResult(overrides: Record<string, unknown> = {}): any {
  return {
    delegatePortableDid: {
      uri      : DELEGATE_DID,
      document : { id: DELEGATE_DID },
      metadata : {},
    },
    delegateGrants     : [createCoveringGrantMessage()],
    connectedDid       : OWNER_DID,
    sessionRevocations : [],
    ...overrides,
  };
}

describe('delegated connection lifecycle', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('AuthManager delegated connection status', () => {
    test('reconciles delegate grants against raw and active owner-partition grants', async () => {
      const queryParams: any[] = [];
      const grant = {
        id             : 'grant-1',
        grantor        : OWNER_DID,
        grantee        : DELEGATE_DID,
        dateExpires    : '2040-01-01T00:00:00.000000Z',
        connectSession : {
          id        : 'session-1',
          createdAt : '2026-07-13T00:00:00.000000Z',
          expiresAt : '2040-01-01T00:00:00.000000Z',
        },
      };
      const agent = createMockAgent({
        permissionsFetchGrants: async (params: any): Promise<any[]> => {
          queryParams.push(params);
          return params.checkRevoked === true ? [] : [{ grant, message: { recordId: grant.id } }];
        },
      });
      const manager = createTestManager(agent);

      const status = await manager.getConnectionStatus();

      expect(status.state).toBe('revoked');
      expect(queryParams).toHaveLength(3);
      for (const params of queryParams) {
        expect(params).toMatchObject({
          author  : DELEGATE_DID,
          grantor : OWNER_DID,
          grantee : DELEGATE_DID,
        });
      }
      expect(queryParams.filter(params => params.target === OWNER_DID)).toHaveLength(2);
      expect(queryParams.filter(params => params.target === DELEGATE_DID)).toHaveLength(1);
      expect(queryParams.some(params => params.checkRevoked === true)).toBe(true);
    });

    test('returns none without an active delegated session', async () => {
      const manager = createTestManager(createMockAgent(), { delegatedSession: false });

      await expect(manager.getConnectionStatus()).resolves.toEqual({ state: 'none' });
    });
  });

  describe('AuthManager.refresh', () => {
    test('re-grants to the local delegate and atomically replaces its authorization lifetime', async () => {
      const identity = createMockIdentity({
        did      : { uri: DELEGATE_DID },
        metadata : { name: 'Delegate', tenant: 'did:dht:agent', connectedDid: OWNER_DID },
      });
      const exportedDelegate = {
        uri         : DELEGATE_DID,
        document    : { id: DELEGATE_DID },
        metadata    : {},
        privateKeys : [],
      };
      const identityImport = sinon.spy(async (): Promise<typeof identity> => identity);
      const identityDelete = sinon.spy(async (): Promise<void> => {});
      const didDelete = sinon.spy(async (): Promise<void> => {});
      const permissionsClear = sinon.spy(async (): Promise<void> => {});
      const syncStart = sinon.spy(async (): Promise<void> => {});
      const syncUnregister = sinon.spy(async (): Promise<void> => {});
      const agent = createMockAgent({
        identityList       : async () => [identity],
        identityImport,
        identityDelete,
        didExport          : async () => exportedDelegate,
        didDelete,
        permissionsClear,
        syncStartSync      : syncStart,
        syncRemoveIdentity : syncUnregister,
      });
      const requestAccess = sinon.spy(async (): Promise<any> => createRefreshResult());
      const manager = createTestManager(agent, { connectHandler: { requestAccess } });
      const originalSession = manager.session!;
      let identityAdded = 0;
      let sessionStarted = 0;
      let sessionAtEvent: AuthSession | undefined;
      let stateAtEvent = manager.state;
      manager.on('identity-added', () => { identityAdded++; });
      manager.on('session-start', () => {
        sessionStarted++;
        sessionAtEvent = manager.session;
        stateAtEvent = manager.state;
      });

      const session = await manager.refresh({ protocols: PROTOCOLS });

      expect(session).not.toBe(originalSession);
      expect(manager.session).toBe(session);
      expect(originalSession.signal.aborted).toBe(true);
      expect(session.signal.aborted).toBe(false);
      expect(sessionAtEvent).toBe(session);
      expect(stateAtEvent).toBe('connected');
      expect(session.did).toBe(OWNER_DID);
      expect(session.delegateDid).toBe(DELEGATE_DID);
      expect(requestAccess.callCount).toBe(1);
      expect(requestAccess.firstCall.args[0]).toMatchObject({ requestType: 'refresh' });
      expect(requestAccess.firstCall.args[0].delegatePortableDid).toBe(exportedDelegate);
      expect(requestAccess.firstCall.args[0].permissionRequests.length).toBeGreaterThan(0);
      expect(identityImport.called).toBe(false);
      expect(identityDelete.called).toBe(false);
      expect(didDelete.called).toBe(false);
      expect(permissionsClear.calledOnce).toBe(true);
      expect(syncUnregister.calledOnceWith(OWNER_DID)).toBe(true);
      expect(syncStart.called).toBe(false);
      expect(identityAdded).toBe(0);
      expect(sessionStarted).toBe(1);
    });

    test('rejects a different connected DID or delegate DID returned by the handler', async () => {
      const identity = createMockIdentity({
        did      : { uri: DELEGATE_DID },
        metadata : { name: 'Delegate', tenant: 'did:dht:agent', connectedDid: OWNER_DID },
      });
      const agent = createMockAgent({ identityList: async () => [identity] });

      const ownerMismatch = createTestManager(agent, {
        connectHandler: {
          requestAccess: async (): Promise<any> => createRefreshResult({ connectedDid: 'did:dht:other-owner' }),
        },
      });
      await expect(ownerMismatch.refresh({ protocols: PROTOCOLS })).rejects.toThrow('expected');

      const delegateMismatch = createTestManager(agent, {
        connectHandler: {
          requestAccess: async (): Promise<any> => createRefreshResult({
            delegatePortableDid: {
              uri      : 'did:dht:other-delegate',
              document : { id: 'did:dht:other-delegate' },
              metadata : {},
            },
          }),
        },
      });
      await expect(delegateMismatch.refresh({ protocols: PROTOCOLS })).rejects.toThrow('expected');
    });

    test('preserves the active delegate identity when grant processing fails', async () => {
      const identity = createMockIdentity({
        did      : { uri: DELEGATE_DID },
        metadata : { name: 'Delegate', tenant: 'did:dht:agent', connectedDid: OWNER_DID },
      });
      const identityDelete = sinon.spy(async (): Promise<void> => {});
      const didDelete = sinon.spy(async (): Promise<void> => {});
      const agent = createMockAgent({
        identityList       : async () => [identity],
        identityDelete,
        didDelete,
        syncRemoveIdentity : async (): Promise<void> => {
          throw new Error('sync store unavailable');
        },
      });
      const manager = createTestManager(agent, {
        connectHandler: { requestAccess: async (): Promise<any> => createRefreshResult() },
      });
      const previousSession = manager.session!;

      await expect(manager.refresh({ protocols: PROTOCOLS })).rejects.toThrow('sync store unavailable');

      expect(manager.session).toBe(previousSession);
      expect(previousSession.signal.aborted).toBe(false);
      expect(manager.state).toBe('connected');
      expect(identityDelete.called).toBe(false);
      expect(didDelete.called).toBe(false);
    });

    test('rejects an empty refresh grant bundle for non-empty protocol requests', async () => {
      const identity = createMockIdentity({
        did      : { uri: DELEGATE_DID },
        metadata : { name: 'Delegate', tenant: 'did:dht:agent', connectedDid: OWNER_DID },
      });
      const manager = createTestManager(createMockAgent({ identityList: async () => [identity] }), {
        connectHandler: {
          requestAccess: async (): Promise<any> => createRefreshResult({ delegateGrants: [] }),
        },
      });
      await expect(manager.refresh({ protocols: PROTOCOLS })).rejects.toThrow('returned no grants');
    });

    test('rejects a denied refresh with a typed ConnectDeniedError and preserves the message', async () => {
      const identity = createMockIdentity({
        did      : { uri: DELEGATE_DID },
        metadata : { name: 'Delegate', tenant: 'did:dht:agent', connectedDid: OWNER_DID },
      });
      const manager = createTestManager(createMockAgent({ identityList: async () => [identity] }), {
        connectHandler: {
          requestAccess: async (): Promise<undefined> => undefined,
        },
      });
      const originalSession = manager.session!;

      let caught: unknown;
      try {
        await manager.refresh({ protocols: PROTOCOLS });
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ConnectDeniedError);
      expect(isConnectDeniedError(caught)).toBe(true);
      expect((caught as Error).message).toBe('[@enbox/auth] Refresh was denied or cancelled by the user.');
      expect(manager.session).toBe(originalSession);
      expect(originalSession.signal.aborted).toBe(false);
    });

    for (const teardown of ['lock', 'disconnect', 'shutdown'] as const) {
      test(`does not resume a handler-wait refresh after ${teardown}`, async () => {
        const identity = createMockIdentity({
          did      : { uri: DELEGATE_DID },
          metadata : { name: 'Delegate', tenant: 'did:dht:agent', connectedDid: OWNER_DID },
        });
        const handlerStarted = createDeferred<void>();
        const handlerResult = createDeferred<any>();
        const processDwnRequest = sinon.spy(async (): Promise<any> => ({
          reply: { status: { code: 202, detail: 'Accepted' } },
        }));
        const processRawMessage = sinon.spy(async (): Promise<any> => ({
          status: { code: 202, detail: 'Accepted' },
        }));
        const permissionsClear = sinon.spy(async (): Promise<void> => {});
        const agent = createMockAgent({
          identityList         : async () => [identity],
          processDwnRequest,
          dwnProcessRawMessage : processRawMessage,
          permissionsClear,
        });
        const manager = createTestManager(agent, {
          connectHandler: {
            requestAccess: async (): Promise<any> => {
              handlerStarted.resolve();
              return handlerResult.promise;
            },
          },
        });

        const refreshPromise = manager.refresh({ protocols: PROTOCOLS });
        await handlerStarted.promise;
        const refreshErrorPromise = refreshPromise.then(
          () => undefined,
          (error: unknown) => error,
        );
        const teardownPromise = manager[teardown]();
        handlerResult.resolve(createRefreshResult());
        const refreshError = await refreshErrorPromise;
        await teardownPromise;

        expect(refreshError).toBeInstanceOf(Error);
        expect((refreshError as Error).message).toContain('invalidated');
        expect(manager.session).toBeUndefined();
        expect(processDwnRequest.called).toBe(false);
        expect(processRawMessage.called).toBe(false);
        expect(permissionsClear.called).toBe(false);
      });
    }

    test('completes terminal refresh finalization before queued disconnect cleanup', async () => {
      const identity = createMockIdentity({
        did      : { uri: DELEGATE_DID },
        metadata : { name: 'Delegate', tenant: 'did:dht:agent', connectedDid: OWNER_DID },
      });
      const storage = new BlockingMemoryStorage();
      const agent = createMockAgent({ identityList: async () => [identity] });
      const manager = createTestManager(agent, {
        connectHandler: { requestAccess: async (): Promise<any> => createRefreshResult() },
        storage,
      });
      const sessionEnds: string[] = [];
      manager.on('session-end', ({ did }) => { sessionEnds.push(did); });

      const refreshPromise = manager.refresh({ protocols: PROTOCOLS });
      await storage.setStarted.promise;
      let disconnectSettled = false;
      const disconnectPromise = manager.disconnect().finally(() => { disconnectSettled = true; });
      await Promise.resolve();

      expect(disconnectSettled).toBe(false);
      storage.releaseSets();

      const refreshedSession = await refreshPromise;
      await disconnectPromise;

      expect(refreshedSession.did).toBe(OWNER_DID);
      expect(refreshedSession.delegateDid).toBe(DELEGATE_DID);
      expect(sessionEnds).toEqual([OWNER_DID]);
      expect(manager.session).toBeUndefined();
      expect(manager.state).toBe('unlocked');
      expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBeNull();
      expect(await storage.get(STORAGE_KEYS.ACTIVE_IDENTITY)).toBeNull();
    });

    test('rejects new connect and refresh attempts as soon as shutdown starts', async () => {
      const shutdownStarted = createDeferred<void>();
      const releaseShutdown = createDeferred<void>();
      const identity = createMockIdentity({
        did      : { uri: DELEGATE_DID },
        metadata : { name: 'Delegate', tenant: 'did:dht:agent', connectedDid: OWNER_DID },
      });
      const requestAccess = sinon.spy(async (): Promise<any> => createRefreshResult());
      const agent = createMockAgent({
        identityList : async () => [identity],
        shutdown     : async (): Promise<void> => {
          shutdownStarted.resolve();
          await releaseShutdown.promise;
        },
      });
      const manager = createTestManager(agent, { connectHandler: { requestAccess } });

      const shutdownPromise = manager.shutdown();
      await shutdownStarted.promise;

      await expect(manager.connect()).rejects.toThrow('shutting down');
      await expect(manager.refresh({ protocols: PROTOCOLS })).rejects.toThrow('shutting down');
      expect(requestAccess.called).toBe(false);

      releaseShutdown.resolve();
      await shutdownPromise;
      expect(manager.state).toBe('locked');
    });

    for (const teardown of ['lock', 'disconnect'] as const) {
      test(`does not run ${teardown} after shutdown has started`, async () => {
        const shutdownStarted = createDeferred<void>();
        const releaseShutdown = createDeferred<void>();
        const agent = createMockAgent({
          shutdown: async (): Promise<void> => {
            shutdownStarted.resolve();
            await releaseShutdown.promise;
          },
        });
        const manager = createTestManager(agent);
        const innerTeardown = sinon.spy(manager as any, teardown === 'lock' ? '_lock' : '_disconnect');

        const shutdownPromise = manager.shutdown();
        await shutdownStarted.promise;
        const teardownPromise = manager[teardown]();
        releaseShutdown.resolve();
        await Promise.all([shutdownPromise, teardownPromise]);

        expect(innerTeardown.called).toBe(false);
        expect(manager.session).toBeUndefined();
        expect(manager.state).toBe('locked');
      });
    }

    test('requires an active delegated session, a handler, and non-empty protocols', async () => {
      const noSession = createTestManager(createMockAgent(), { delegatedSession: false });
      await expect(noSession.refresh({ protocols: PROTOCOLS })).rejects.toThrow('active delegated session');

      const identity = createMockIdentity({
        did      : { uri: DELEGATE_DID },
        metadata : { name: 'Delegate', tenant: 'did:dht:agent', connectedDid: OWNER_DID },
      });
      const noHandler = createTestManager(createMockAgent({ identityList: async () => [identity] }));
      await expect(noHandler.refresh({ protocols: PROTOCOLS })).rejects.toThrow('No connect handler');

      const requestAccess = sinon.spy(async (): Promise<any> => createRefreshResult());
      const emptyProtocols = createTestManager(createMockAgent({ identityList: async () => [identity] }), {
        connectHandler: { requestAccess },
      });
      await expect(emptyProtocols.refresh({ protocols: [] })).rejects.toThrow('at least one protocol');
      expect(requestAccess.called).toBe(false);
    });
  });

  describe('AuthManager initial handler connect lifecycle', () => {
    for (const teardown of ['lock', 'disconnect', 'shutdown'] as const) {
      test(`${teardown} completes during requestAccess and prevents terminal connect side effects`, async () => {
        const handlerStarted = createDeferred<void>();
        const handlerResult = createDeferred<any>();
        const identityImport = sinon.spy(async (): Promise<any> => createMockIdentity());
        const processDwnRequest = sinon.spy(async (): Promise<any> => ({
          reply: { status: { code: 202, detail: 'Accepted' } },
        }));
        const processRawMessage = sinon.spy(async (): Promise<any> => ({
          status: { code: 202, detail: 'Accepted' },
        }));
        const permissionsClear = sinon.spy(async (): Promise<void> => {});
        const clearDelegateDecryptionKeys = sinon.spy((): void => {});
        const syncSetIdentityOptions = sinon.spy(async (): Promise<void> => {});
        const syncStart = sinon.spy(async (): Promise<void> => {});
        const storage = new MemoryStorage();
        const storageSet = sinon.spy(storage, 'set');
        const agent = createMockAgent({
          identityImport,
          processDwnRequest,
          dwnProcessRawMessage           : processRawMessage,
          permissionsClear,
          dwnClearDelegateDecryptionKeys : clearDelegateDecryptionKeys,
          syncSetIdentityOptions,
          syncStartSync                  : syncStart,
        });
        const manager = createTestManager(agent, { delegatedSession: false, storage });
        const requestAccess = async (): Promise<any> => {
          handlerStarted.resolve();
          return handlerResult.promise;
        };
        let sessionStarts = 0;
        manager.on('session-start', () => { sessionStarts++; });

        const connectPromise = manager.connect({
          connectHandler : { requestAccess },
          password       : 'test-password',
          protocols      : PROTOCOLS,
        });
        let connectSettled = false;
        void connectPromise.then(
          () => { connectSettled = true; },
          () => { connectSettled = true; },
        );
        await handlerStarted.promise;

        await manager[teardown]();
        expect(connectSettled).toBe(false);

        const callsAfterTeardown = {
          cacheClear      : clearDelegateDecryptionKeys.callCount,
          grantProcess    : processDwnRequest.callCount,
          grantRawWrite   : processRawMessage.callCount,
          identityImport  : identityImport.callCount,
          permissionClear : permissionsClear.callCount,
          storageSet      : storageSet.callCount,
          syncRegister    : syncSetIdentityOptions.callCount,
          syncStart       : syncStart.callCount,
        };
        handlerResult.resolve(createRefreshResult());

        await expect(connectPromise).rejects.toThrow('invalidated');
        expect(manager.session).toBeUndefined();
        expect(manager.state).toBe(teardown === 'disconnect' ? 'unlocked' : 'locked');
        expect(sessionStarts).toBe(0);
        expect(clearDelegateDecryptionKeys.callCount).toBe(callsAfterTeardown.cacheClear);
        expect(processDwnRequest.callCount).toBe(callsAfterTeardown.grantProcess);
        expect(processRawMessage.callCount).toBe(callsAfterTeardown.grantRawWrite);
        expect(identityImport.callCount).toBe(callsAfterTeardown.identityImport);
        expect(permissionsClear.callCount).toBe(callsAfterTeardown.permissionClear);
        expect(storageSet.callCount).toBe(callsAfterTeardown.storageSet);
        expect(syncSetIdentityOptions.callCount).toBe(callsAfterTeardown.syncRegister);
        expect(syncStart.callCount).toBe(callsAfterTeardown.syncStart);
      });
    }
  });

  describe('AuthManager wallet connect lifecycle', () => {
    test('disconnect completes during initClient and prevents terminal wallet side effects', async () => {
      const initClientStarted = createDeferred<void>();
      const initClientResult = createDeferred<any>();
      sinon.stub(WalletConnect, 'initClient').callsFake(async (): Promise<any> => {
        initClientStarted.resolve();
        return initClientResult.promise;
      });

      const identityImport = sinon.spy(async (): Promise<any> => createMockIdentity());
      const processDwnRequest = sinon.spy(async (): Promise<any> => ({
        reply: { status: { code: 202, detail: 'Accepted' } },
      }));
      const processRawMessage = sinon.spy(async (): Promise<any> => ({
        status: { code: 202, detail: 'Accepted' },
      }));
      const syncSetIdentityOptions = sinon.spy(async (): Promise<void> => {});
      const syncStart = sinon.spy(async (): Promise<void> => {});
      const storage = new MemoryStorage();
      const storageSet = sinon.spy(storage, 'set');
      const agent = createMockAgent({
        identityImport,
        processDwnRequest,
        dwnProcessRawMessage : processRawMessage,
        syncSetIdentityOptions,
        syncStartSync        : syncStart,
      });
      const manager = createTestManager(agent, { delegatedSession: false, storage });
      let sessionStarts = 0;
      manager.on('session-start', () => { sessionStarts++; });

      const walletConnectPromise = manager.walletConnect({
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async (): Promise<string> => '1234',
      });
      let walletConnectSettled = false;
      void walletConnectPromise.then(
        () => { walletConnectSettled = true; },
        () => { walletConnectSettled = true; },
      );
      await initClientStarted.promise;

      await manager.disconnect();
      expect(walletConnectSettled).toBe(false);
      initClientResult.resolve(createRefreshResult({ delegateGrants: [] }));

      await expect(walletConnectPromise).rejects.toThrow('invalidated');
      expect(identityImport.called).toBe(false);
      expect(processDwnRequest.called).toBe(false);
      expect(processRawMessage.called).toBe(false);
      expect(syncSetIdentityOptions.called).toBe(false);
      expect(syncStart.called).toBe(false);
      expect(storageSet.called).toBe(false);
      expect(sessionStarts).toBe(0);
      expect(manager.session).toBeUndefined();
      expect(manager.state).toBe('unlocked');
    });
  });

  describe('AuthManager connection monitor', () => {
    test('serializes polls, emits transitions once, and auto-refreshes an expiring session once', async () => {
      const clock = sinon.useFakeTimers();
      const manager = createTestManager(createMockAgent());
      const status: ConnectionStatus = {
        state              : 'expiring-soon',
        connectSessionId   : 'session-1',
        connectedDid       : OWNER_DID,
        delegateDid        : DELEGATE_DID,
        expiresAt          : '2026-07-13T13:00:00.000000Z',
        secondsUntilExpiry : 600,
      };
      const getStatus = sinon.stub(manager, 'getConnectionStatus').resolves(status);
      const refresh = sinon.stub(manager as any, '_refresh').resolves(manager.session!);
      const emitted: ConnectionStatus[] = [];
      manager.on('connection-expiring', ({ status: eventStatus }) => { emitted.push(eventStatus); });

      const stop = manager.startConnectionMonitor({
        intervalMs  : 1000,
        autoRefresh : { protocols: PROTOCOLS },
      });
      await clock.tickAsync(0);
      await clock.tickAsync(5000);

      expect(getStatus.callCount).toBeGreaterThanOrEqual(2);
      expect(emitted).toEqual([status]);
      expect(refresh.calledOnce).toBe(true);
      stop();
      clock.restore();
    });

    test('reports revoked sessions as invalid but never auto-refreshes them', async () => {
      const clock = sinon.useFakeTimers();
      const manager = createTestManager(createMockAgent());
      const status: ConnectionStatus = {
        state            : 'revoked',
        connectSessionId : 'session-1',
      };
      sinon.stub(manager, 'getConnectionStatus').resolves(status);
      const refresh = sinon.stub(manager as any, '_refresh').resolves(manager.session!);
      const emitted: ConnectionStatus[] = [];
      manager.on('connection-expired', ({ status: eventStatus }) => { emitted.push(eventStatus); });

      const stop = manager.startConnectionMonitor({
        intervalMs  : 1000,
        autoRefresh : { protocols: PROTOCOLS },
      });
      await clock.tickAsync(3000);

      expect(emitted).toEqual([status]);
      expect(refresh.called).toBe(false);
      stop();
      clock.restore();
    });

    test('stopping the monitor invalidates its handler-wait automatic refresh', async () => {
      const identity = createMockIdentity({
        did      : { uri: DELEGATE_DID },
        metadata : { name: 'Delegate', tenant: 'did:dht:agent', connectedDid: OWNER_DID },
      });
      const handlerStarted = createDeferred<void>();
      const handlerResult = createDeferred<any>();
      const onError = sinon.spy((_error: unknown): void => {});
      const processDwnRequest = sinon.spy(async (): Promise<any> => ({
        reply: { status: { code: 202, detail: 'Accepted' } },
      }));
      const permissionsClear = sinon.spy(async (): Promise<void> => {});
      const agent = createMockAgent({
        identityList: async () => [identity],
        processDwnRequest,
        permissionsClear,
      });
      const manager = createTestManager(agent, {
        connectHandler: {
          requestAccess: async (): Promise<any> => {
            handlerStarted.resolve();
            return handlerResult.promise;
          },
        },
      });
      const previousSession = manager.session;
      sinon.stub(manager, 'getConnectionStatus').resolves({
        state            : 'expiring-soon',
        connectSessionId : 'session-1',
      });
      const pollConnectionMonitor = sinon.spy(manager as any, '_pollConnectionMonitor');

      const stop = manager.startConnectionMonitor({
        intervalMs  : 60_000,
        autoRefresh : { protocols: PROTOCOLS },
        onError,
      });
      await handlerStarted.promise;
      stop();
      handlerResult.resolve(createRefreshResult());
      await pollConnectionMonitor.firstCall.returnValue;

      expect(onError.called).toBe(false);
      expect(manager.session).toBe(previousSession);
      expect(processDwnRequest.called).toBe(false);
      expect(permissionsClear.called).toBe(false);
    });

    test('does not overlap slow status polls', async () => {
      const clock = sinon.useFakeTimers();
      const manager = createTestManager(createMockAgent());
      let resolveFirst!: (status: ConnectionStatus) => void;
      const firstPoll = new Promise<ConnectionStatus>((resolve) => { resolveFirst = resolve; });
      const getStatus = sinon.stub(manager, 'getConnectionStatus');
      getStatus.onFirstCall().returns(firstPoll);
      getStatus.onSecondCall().resolves({ state: 'active', connectSessionId: 'session-1' });

      const stop = manager.startConnectionMonitor({ intervalMs: 1000 });
      await clock.tickAsync(3000);
      expect(getStatus.callCount).toBe(1);

      resolveFirst({ state: 'active', connectSessionId: 'session-1' });
      await clock.tickAsync(0);
      await clock.tickAsync(1000);
      expect(getStatus.callCount).toBe(2);
      stop();
      clock.restore();
    });

    test('stops monitoring when locking, disconnecting, or shutting down', async () => {
      const managers = [
        createTestManager(createMockAgent(), { delegatedSession: false }),
        createTestManager(createMockAgent(), { delegatedSession: false }),
        createTestManager(createMockAgent(), { delegatedSession: false }),
      ];
      const stopSpies = managers.map(manager => sinon.spy(manager, 'stopConnectionMonitor'));
      managers.forEach(manager => manager.startConnectionMonitor({ intervalMs: 60_000 }));
      stopSpies.forEach(spy => spy.resetHistory());

      await managers[0].lock();
      await managers[1].disconnect();
      await managers[2].shutdown();

      expect(stopSpies.every(spy => spy.calledOnce)).toBe(true);
    });
  });
});
