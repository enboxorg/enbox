import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import type { AuthSessionInfo, AuthState, ConnectionStatus } from '@enbox/auth';

import { AuthManager } from '@enbox/auth/auth-manager';
import { EnboxUserAgent } from '@enbox/agent';
import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { AuthEventEmitter, AuthSession, ConnectDeniedError, isConnectDeniedError } from '@enbox/auth';

import type { ConnectionSnapshot } from '../src/connection-store.js';

import { createConnectionStore } from '../src/connection-store.js';
import { Enbox } from '../src/enbox.js';

const OWNER_DID = 'did:dht:store-owner';
const DELEGATE_DID = 'did:jwk:store-delegate';

const PROTOCOLS = [{
  protocol  : 'https://example.com/connection-store',
  published : true,
  types     : {},
  structure : {},
}];

const ACTIVE_STATUS: ConnectionStatus = {
  state              : 'active',
  connectSessionId   : 'session-1',
  connectedDid       : OWNER_DID,
  delegateDid        : DELEGATE_DID,
  expiresAt          : '2040-01-01T00:00:00.000000Z',
  secondsUntilExpiry : 86_400,
};

/** Duck-typed AuthManager driven by a real AuthEventEmitter. */
type FakeAuthManager = {
  agent: EnboxUserAgent;
  emitter: AuthEventEmitter;
  state: AuthState;
  session: AuthSession | undefined;
  stopMonitorSpy: sinon.SinonSpy;
  on: AuthManager['on'];
  restoreSession: sinon.SinonStub;
  connect: sinon.SinonStub;
  connectVault: sinon.SinonStub;
  refresh: sinon.SinonStub;
  disconnect: sinon.SinonStub;
  shutdown: sinon.SinonStub;
  getConnectionStatus: sinon.SinonStub;
  startConnectionMonitor: sinon.SinonStub;
};

describe('createConnectionStore()', () => {
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : EnboxUserAgent,
      agentStores : 'memory',
    });
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.createAgentDid();
  });

  afterEach(() => {
    sinon.restore();
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  function createFakeAuth(): FakeAuthManager {
    const emitter = new AuthEventEmitter();
    const stopMonitorSpy = sinon.spy();

    const fake: FakeAuthManager = {
      agent                  : testHarness.agent as EnboxUserAgent,
      emitter,
      state                  : 'unlocked',
      session                : undefined,
      stopMonitorSpy,
      on                     : emitter.on.bind(emitter) as AuthManager['on'],
      restoreSession         : sinon.stub().resolves(undefined),
      connect                : sinon.stub().resolves(undefined),
      connectVault           : sinon.stub().resolves(undefined),
      refresh                : sinon.stub().resolves(undefined),
      disconnect             : sinon.stub().resolves(),
      shutdown               : sinon.stub().resolves(),
      getConnectionStatus    : sinon.stub().resolves({ ...ACTIVE_STATUS }),
      startConnectionMonitor : sinon.stub().returns(stopMonitorSpy),
    };
    return fake;
  }

  function asAuth(fake: FakeAuthManager): AuthManager {
    return fake as unknown as AuthManager;
  }

  function createSession(params: { did?: string; delegateDid?: string; name?: string } = {}): AuthSession {
    const did = params.did ?? OWNER_DID;
    return new AuthSession({
      agent       : testHarness.agent as EnboxUserAgent,
      did,
      delegateDid : params.delegateDid,
      identity    : { didUri: did, name: params.name ?? 'Store identity' },
      signal      : new AbortController().signal,
    });
  }

  function sessionInfo(session: AuthSession): AuthSessionInfo {
    return {
      did         : session.did,
      delegateDid : session.delegateDid,
      identity    : session.identity,
      signal      : session.signal,
    };
  }

  describe('snapshot contract', () => {
    it('should start in the initializing phase with a frozen, reference-stable snapshot', () => {
      const store = createConnectionStore({ auth: asAuth(createFakeAuth()) });

      const first = store.getSnapshot();
      const second = store.getSnapshot();

      expect(first.phase).toBe('initializing');
      expect(first).toBe(second);
      expect(Object.isFrozen(first)).toBe(true);
      expect(store.auth).toBeUndefined();
    });

    it('should keep the same snapshot reference and skip notification when nothing changed', async () => {
      const fake = createFakeAuth();
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.initialize();

      let notifications = 0;
      store.subscribe(() => { notifications++; });

      fake.emitter.emit('vault-locked', {});
      const afterFirst = store.getSnapshot();
      fake.emitter.emit('vault-locked', {});

      expect(store.getSnapshot()).toBe(afterFirst);
      expect(store.getSnapshot().vaultLocked).toBe(true);
      expect(notifications).toBe(1);
    });

    it('should not notify a listener after it unsubscribes', async () => {
      const fake = createFakeAuth();
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.initialize();

      let notifications = 0;
      const unsubscribe = store.subscribe(() => { notifications++; });
      fake.emitter.emit('vault-locked', {});
      unsubscribe();
      fake.emitter.emit('vault-unlocked', {});

      expect(notifications).toBe(1);
    });

    it('should finish notifying the current listener snapshot when a listener unsubscribes another', async () => {
      const fake = createFakeAuth();
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.initialize();

      let notifications = 0;
      store.subscribe(() => { unsubscribeSecond(); });
      const unsubscribeSecond = store.subscribe(() => { notifications++; });

      fake.emitter.emit('vault-locked', {});
      fake.emitter.emit('vault-unlocked', {});

      expect(notifications).toBe(1);
    });
  });

  describe('initialize()', () => {
    it('should resolve disconnected when no previous session can be restored', async () => {
      const fake = createFakeAuth();
      const store = createConnectionStore({ auth: asAuth(fake) });

      const snapshot = await store.initialize();

      expect(snapshot.phase).toBe('disconnected');
      expect(snapshot.session).toBeUndefined();
      expect(snapshot.enbox).toBeUndefined();
      expect(snapshot.vaultLocked).toBe(false);
      expect(store.auth).toBe(asAuth(fake));
      expect(fake.restoreSession.calledOnce).toBe(true);
    });

    it('should report a locked vault when restore finds no session and the vault is locked', async () => {
      const fake = createFakeAuth();
      fake.state = 'locked';
      const store = createConnectionStore({ auth: asAuth(fake) });

      const snapshot = await store.initialize();

      expect(snapshot.phase).toBe('disconnected');
      expect(snapshot.vaultLocked).toBe(true);
    });

    it('should restore a previous session into a connected snapshot', async () => {
      const fake = createFakeAuth();
      const session = createSession({ name: 'Restored identity' });
      fake.restoreSession.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ auth: asAuth(fake) });

      const snapshot = await store.initialize();

      expect(snapshot.phase).toBe('connected');
      expect(snapshot.session).toBe(session);
      expect(snapshot.enbox).toBeInstanceOf(Enbox);
      expect(snapshot.identityDid).toBe(OWNER_DID);
      expect(snapshot.identityName).toBe('Restored identity');
      expect(snapshot.error).toBeUndefined();
      // Non-delegated session: no monitor, no delegated connection status.
      expect(snapshot.connection).toBeUndefined();
      expect(fake.startConnectionMonitor.called).toBe(false);
    });

    it('should forward restore options to AuthManager.restoreSession()', async () => {
      const fake = createFakeAuth();
      const onPasswordRequired = async (): Promise<string> => 'pw';
      const store = createConnectionStore({ auth: asAuth(fake), restore: { onPasswordRequired } });

      await store.initialize();

      expect(fake.restoreSession.firstCall.args[0]).toEqual({ onPasswordRequired });
    });

    it('should single-flight concurrent initialize calls onto the same promise', async () => {
      const fake = createFakeAuth();
      let resolveRestore!: (value: undefined) => void;
      fake.restoreSession.returns(new Promise((resolve) => { resolveRestore = resolve; }));
      const store = createConnectionStore({ auth: asAuth(fake) });

      const first = store.initialize();
      const second = store.initialize();

      expect(first).toBe(second);
      resolveRestore(undefined);
      const snapshot = await first;
      expect(snapshot.phase).toBe('disconnected');
      expect(fake.restoreSession.calledOnce).toBe(true);
    });

    it('should not re-run session restore once initialized', async () => {
      const fake = createFakeAuth();
      const store = createConnectionStore({ auth: asAuth(fake) });

      await store.initialize();
      const snapshot = await store.initialize();

      expect(snapshot).toBe(store.getSnapshot());
      expect(fake.restoreSession.calledOnce).toBe(true);
    });

    it('should map a failed bootstrap to the error phase and allow a retry', async () => {
      const fake = createFakeAuth();
      fake.restoreSession.onFirstCall().rejects(new Error('storage exploded'));
      fake.restoreSession.onSecondCall().resolves(undefined);
      const store = createConnectionStore({ auth: asAuth(fake) });

      const failed = await store.initialize();
      expect(failed.phase).toBe('error');
      expect(failed.error?.message).toBe('storage exploded');

      const retried = await store.initialize();
      expect(retried.phase).toBe('disconnected');
      expect(retried.error).toBeUndefined();
      expect(fake.restoreSession.callCount).toBe(2);
    });
  });

  describe('connect() / connectVault()', () => {
    it('should pass through the connecting phase and land connected with a seeded delegated status', async () => {
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ auth: asAuth(fake) });
      const phases: ConnectionSnapshot['phase'][] = [];
      store.subscribe((snapshot) => { phases.push(snapshot.phase); });

      const snapshot = await store.connect({ protocols: PROTOCOLS });

      expect(phases).toEqual(['connecting', 'connected', 'connected']);
      expect(snapshot.phase).toBe('connected');
      expect(snapshot.session).toBe(session);
      expect(snapshot.enbox).toBeInstanceOf(Enbox);
      expect(snapshot.connection?.state).toBe('active');
      expect(snapshot.walletReapprovalRequired).toBeUndefined();
      expect(fake.connect.firstCall.args[0]).toEqual({ protocols: PROTOCOLS });
      expect(fake.startConnectionMonitor.calledOnce).toBe(true);
    });

    it('should forward monitor options and reuse them for the status seed', async () => {
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({
        auth    : asAuth(fake),
        monitor : { checkRevoked: false, expiringSoonThresholdSeconds: 120, intervalMs: 1234 },
      });

      await store.connect({ protocols: PROTOCOLS });

      expect(fake.startConnectionMonitor.firstCall.args[0]).toEqual({
        checkRevoked                 : false,
        expiringSoonThresholdSeconds : 120,
        intervalMs                   : 1234,
      });
      expect(fake.getConnectionStatus.firstCall.args[0]).toEqual({
        checkRevoked                 : false,
        expiringSoonThresholdSeconds : 120,
      });
    });

    it('should not start a monitor when monitoring is disabled but still seed the status', async () => {
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ auth: asAuth(fake), monitor: false });

      const snapshot = await store.connect({ protocols: PROTOCOLS });

      expect(fake.startConnectionMonitor.called).toBe(false);
      expect(snapshot.connection?.state).toBe('active');
    });

    it('should keep the connection field unset for non-delegated vault sessions', async () => {
      const fake = createFakeAuth();
      const session = createSession();
      fake.connectVault.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ auth: asAuth(fake) });

      const snapshot = await store.connectVault({ createIdentity: true });

      expect(snapshot.phase).toBe('connected');
      expect(snapshot.connection).toBeUndefined();
      expect(fake.getConnectionStatus.called).toBe(false);
      expect(fake.connectVault.firstCall.args[0]).toEqual({ createIdentity: true });
    });

    it('should resolve a denied connect as disconnected with a typed ConnectDeniedError', async () => {
      const fake = createFakeAuth();
      fake.connect.rejects(new ConnectDeniedError());
      const store = createConnectionStore({ auth: asAuth(fake) });

      const snapshot = await store.connect({ protocols: PROTOCOLS });

      expect(snapshot.phase).toBe('disconnected');
      expect(snapshot.session).toBeUndefined();
      expect(snapshot.enbox).toBeUndefined();
      expect(isConnectDeniedError(snapshot.error)).toBe(true);
      expect(snapshot.error?.message).toBe('[@enbox/auth] Connect was denied or cancelled by the user.');
    });

    it('should resolve a failed connect as the error phase', async () => {
      const fake = createFakeAuth();
      fake.connect.rejects(new Error('relay unreachable'));
      const store = createConnectionStore({ auth: asAuth(fake) });

      const snapshot = await store.connect({ protocols: PROTOCOLS });

      expect(snapshot.phase).toBe('error');
      expect(snapshot.session).toBeUndefined();
      expect(snapshot.error?.message).toBe('relay unreachable');
      expect(isConnectDeniedError(snapshot.error)).toBe(false);
    });

    it('should clear the previous error when a new attempt starts', async () => {
      const fake = createFakeAuth();
      fake.connect.onFirstCall().rejects(new ConnectDeniedError());
      let resolveSecond!: (session: AuthSession) => void;
      fake.connect.onSecondCall().returns(new Promise((resolve) => { resolveSecond = resolve; }));
      const store = createConnectionStore({ auth: asAuth(fake) });

      await store.connect({ protocols: PROTOCOLS });
      expect(store.getSnapshot().error).toBeDefined();

      const second = store.connect({ protocols: PROTOCOLS });
      expect(store.getSnapshot().phase).toBe('connecting');
      expect(store.getSnapshot().error).toBeUndefined();

      const session = createSession();
      fake.session = session;
      resolveSecond(session);
      await second;
      expect(store.getSnapshot().phase).toBe('connected');
    });

    it('should return the in-flight promise for a second connect call while connecting', async () => {
      const fake = createFakeAuth();
      let resolveConnect!: (session: AuthSession) => void;
      fake.connect.returns(new Promise((resolve) => { resolveConnect = resolve; }));
      const store = createConnectionStore({ auth: asAuth(fake) });

      const first = store.connect({ protocols: PROTOCOLS });
      const second = store.connect({ protocols: PROTOCOLS });

      expect(first).toBe(second);
      const session = createSession();
      fake.session = session;
      resolveConnect(session);
      const snapshot = await first;
      expect(snapshot.phase).toBe('connected');
      expect(fake.connect.calledOnce).toBe(true);
    });
  });

  describe('refresh()', () => {
    async function connectDelegatedStore(fake: FakeAuthManager): Promise<ReturnType<typeof createConnectionStore>> {
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.connect({ protocols: PROTOCOLS });
      return store;
    }

    it('should stay connected and surface the typed error when a refresh is denied', async () => {
      const fake = createFakeAuth();
      const store = await connectDelegatedStore(fake);
      fake.refresh.rejects(new ConnectDeniedError('[@enbox/auth] Refresh was denied or cancelled by the user.'));

      const snapshot = await store.refresh({ protocols: PROTOCOLS });

      expect(snapshot.phase).toBe('connected');
      expect(snapshot.session).toBe(fake.session);
      expect(isConnectDeniedError(snapshot.error)).toBe(true);
      expect(snapshot.error?.message).toBe('[@enbox/auth] Refresh was denied or cancelled by the user.');
    });

    it('should clear the reapproval flag and reseed the status after a successful refresh', async () => {
      const fake = createFakeAuth();
      const store = await connectDelegatedStore(fake);
      const enboxBeforeRefresh = store.getSnapshot().enbox;
      fake.emitter.emit('connection-expired', { status: { ...ACTIVE_STATUS, state: 'expired', secondsUntilExpiry: -10 } });
      expect(store.getSnapshot().walletReapprovalRequired).toBe(true);

      const refreshedSession = createSession({ delegateDid: DELEGATE_DID, name: 'Refreshed identity' });
      fake.refresh.callsFake(async (): Promise<AuthSession> => {
        fake.session = refreshedSession;
        fake.emitter.emit('session-start', { session: sessionInfo(refreshedSession) });
        return refreshedSession;
      });

      const snapshot = await store.refresh({ protocols: PROTOCOLS });

      expect(snapshot.phase).toBe('connected');
      expect(snapshot.session).toBe(refreshedSession);
      expect(snapshot.enbox).not.toBe(enboxBeforeRefresh);
      expect(snapshot.identityName).toBe('Refreshed identity');
      expect(snapshot.walletReapprovalRequired).toBeUndefined();
      expect(snapshot.connection?.state).toBe('active');
      expect(fake.refresh.firstCall.args[0]).toEqual({ protocols: PROTOCOLS });
    });
  });

  describe('auth event wiring', () => {
    it('should flip to disconnected and stop the monitor when the session ends externally', async () => {
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.connect({ protocols: PROTOCOLS });
      expect(store.getSnapshot().phase).toBe('connected');

      fake.session = undefined;
      fake.emitter.emit('session-end', { did: OWNER_DID });

      const snapshot = store.getSnapshot();
      expect(snapshot.phase).toBe('disconnected');
      expect(snapshot.session).toBeUndefined();
      expect(snapshot.enbox).toBeUndefined();
      expect(snapshot.connection).toBeUndefined();
      expect(fake.stopMonitorSpy.calledOnce).toBe(true);
    });

    it('should follow a replacement session that starts while connection status is loading', async () => {
      const fake = createFakeAuth();
      const firstSession = createSession({ delegateDid: DELEGATE_DID, name: 'First identity' });
      const replacementSession = createSession({ did: 'did:dht:replacement', name: 'Replacement identity' });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = firstSession;
        return firstSession;
      });
      let markStatusStarted!: () => void;
      let resolveStatus!: (status: ConnectionStatus) => void;
      const statusStarted = new Promise<void>((resolve) => { markStatusStarted = resolve; });
      fake.getConnectionStatus.callsFake((): Promise<ConnectionStatus> => {
        markStatusStarted();
        return new Promise((resolve) => { resolveStatus = resolve; });
      });
      const store = createConnectionStore({ auth: asAuth(fake) });

      const connecting = store.connect({ protocols: PROTOCOLS });
      await statusStarted;
      fake.session = replacementSession;
      fake.emitter.emit('session-start', { session: sessionInfo(replacementSession) });
      resolveStatus(ACTIVE_STATUS);
      const snapshot = await connecting;

      expect(snapshot.phase).toBe('connected');
      expect(snapshot.session).toBe(replacementSession);
      expect(snapshot.identityName).toBe('Replacement identity');
      expect(snapshot.connection).toBeUndefined();
      expect(fake.stopMonitorSpy.calledOnce).toBe(true);
    });

    it('should follow a session end that lands while connection status is loading', async () => {
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      let markStatusStarted!: () => void;
      let resolveStatus!: (status: ConnectionStatus) => void;
      const statusStarted = new Promise<void>((resolve) => { markStatusStarted = resolve; });
      fake.getConnectionStatus.callsFake((): Promise<ConnectionStatus> => {
        markStatusStarted();
        return new Promise((resolve) => { resolveStatus = resolve; });
      });
      const store = createConnectionStore({ auth: asAuth(fake) });

      const connecting = store.connect({ protocols: PROTOCOLS });
      await statusStarted;
      fake.session = undefined;
      fake.emitter.emit('session-end', { did: session.did });
      resolveStatus(ACTIVE_STATUS);
      const snapshot = await connecting;

      expect(snapshot.phase).toBe('disconnected');
      expect(snapshot.session).toBeUndefined();
      expect(snapshot.enbox).toBeUndefined();
      expect(snapshot.connection).toBeUndefined();
      expect(fake.stopMonitorSpy.calledOnce).toBe(true);
    });

    it('should follow a session started directly on the AuthManager', async () => {
      const fake = createFakeAuth();
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.initialize();
      expect(store.getSnapshot().phase).toBe('disconnected');

      const session = createSession({ name: 'Switched identity' });
      fake.session = session;
      fake.emitter.emit('session-start', { session: sessionInfo(session) });

      const snapshot = store.getSnapshot();
      expect(snapshot.phase).toBe('connected');
      expect(snapshot.session).toBe(session);
      expect(snapshot.identityName).toBe('Switched identity');
    });

    it('should reflect an expiring connection status without requiring reapproval', async () => {
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.connect({ protocols: PROTOCOLS });

      const expiring: ConnectionStatus = { ...ACTIVE_STATUS, state: 'expiring-soon', secondsUntilExpiry: 300 };
      fake.emitter.emit('connection-expiring', { status: expiring });

      const snapshot = store.getSnapshot();
      expect(snapshot.phase).toBe('connected');
      expect(snapshot.connection).toBe(expiring);
      expect(snapshot.walletReapprovalRequired).toBeUndefined();
    });

    it('should require wallet reapproval when the connection expires or is revoked', async () => {
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.connect({ protocols: PROTOCOLS });

      fake.emitter.emit('connection-expired', { status: { ...ACTIVE_STATUS, state: 'revoked' } });

      const snapshot = store.getSnapshot();
      expect(snapshot.connection?.state).toBe('revoked');
      expect(snapshot.walletReapprovalRequired).toBe(true);
    });

    it('should track vault lock state from vault events', async () => {
      const fake = createFakeAuth();
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.initialize();

      fake.emitter.emit('vault-locked', {});
      expect(store.getSnapshot().vaultLocked).toBe(true);

      fake.emitter.emit('vault-unlocked', {});
      expect(store.getSnapshot().vaultLocked).toBe(false);
    });
  });

  describe('disconnect()', () => {
    it('should sign out through the AuthManager and clear the session fields', async () => {
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      fake.disconnect.callsFake(async (): Promise<void> => {
        fake.session = undefined;
      });
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.connect({ protocols: PROTOCOLS });

      const snapshot = await store.disconnect({ clearStorage: true });

      expect(fake.disconnect.firstCall.args[0]).toEqual({ clearStorage: true });
      expect(snapshot.phase).toBe('disconnected');
      expect(snapshot.session).toBeUndefined();
      expect(snapshot.enbox).toBeUndefined();
      expect(snapshot.connection).toBeUndefined();
      expect(fake.stopMonitorSpy.calledOnce).toBe(true);
    });

    it('should supersede an in-flight connect so its late failure is discarded', async () => {
      const fake = createFakeAuth();
      let rejectConnect!: (error: Error) => void;
      let connectStarted!: () => void;
      const started = new Promise<void>((resolve) => { connectStarted = resolve; });
      fake.connect.callsFake((): Promise<AuthSession> => {
        connectStarted();
        return new Promise((_resolve, reject) => { rejectConnect = reject; });
      });
      fake.disconnect.resolves();
      const store = createConnectionStore({ auth: asAuth(fake) });

      const connectPromise = store.connect({ protocols: PROTOCOLS });
      expect(store.getSnapshot().phase).toBe('connecting');
      // Wait until the auth flow is genuinely in flight before superseding it.
      await started;

      const disconnectPromise = store.disconnect();
      const disconnected = await disconnectPromise;
      expect(disconnected.phase).toBe('disconnected');

      // The invalidated connect settles afterwards; its outcome must not
      // overwrite the disconnect (stale generation).
      rejectConnect(new Error('[@enbox/auth] Connection attempt was invalidated by a session lifecycle change.'));
      const connectResult = await connectPromise;
      expect(connectResult.phase).toBe('disconnected');
      expect(store.getSnapshot().phase).toBe('disconnected');
      expect(store.getSnapshot().error).toBeUndefined();
    });
  });

  describe('dispose()', () => {
    it('should stop the connection monitor and detach event subscriptions', async () => {
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.connect({ protocols: PROTOCOLS });
      const before = store.getSnapshot();

      await store.dispose();

      expect(fake.stopMonitorSpy.calledOnce).toBe(true);
      // Detached: later auth events no longer mutate the snapshot.
      fake.emitter.emit('vault-locked', {});
      expect(store.getSnapshot()).toBe(before);
    });

    it('should not shut down a caller-provided AuthManager', async () => {
      const fake = createFakeAuth();
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.initialize();

      await store.dispose();

      expect(fake.shutdown.called).toBe(false);
      expect(store.auth).toBeUndefined();
    });

    it('should shut down a store-created AuthManager', async () => {
      const fake = createFakeAuth();
      sinon.stub(AuthManager, 'create').resolves(asAuth(fake));
      const store = createConnectionStore({ password: 'pw' });
      await store.initialize();

      await store.dispose();

      expect(fake.shutdown.calledOnce).toBe(true);
    });

    it('should not shut down a manager built around a caller-supplied agent', async () => {
      // Mirrors Enbox.connect() ownership: a caller-supplied `agent` keeps
      // its lifecycle with the caller, so dispose() must not lock its vault.
      const fake = createFakeAuth();
      sinon.stub(AuthManager, 'create').resolves(asAuth(fake));
      const store = createConnectionStore({ agent: testHarness.agent as EnboxUserAgent });
      await store.initialize();

      await store.dispose();

      expect(fake.shutdown.called).toBe(false);
    });

    it('should make later actions throw and be idempotent', async () => {
      const fake = createFakeAuth();
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.initialize();

      await store.dispose();
      await store.dispose();

      expect(() => { void store.initialize(); }).toThrow('disposed');
      expect(() => { void store.connect(); }).toThrow('disposed');
      expect(() => { void store.disconnect(); }).toThrow('disposed');
    });
  });

  describe('AuthManager creation', () => {
    it('should lazily create the AuthManager with the forwarded options, stripping store-specific keys', async () => {
      const fake = createFakeAuth();
      const create = sinon.stub(AuthManager, 'create').resolves(asAuth(fake));
      const store = createConnectionStore({
        password : 'pw',
        sync     : 'off',
        monitor  : false,
        restore  : { password: 'restore-pw' },
      });

      expect(create.called).toBe(false);
      await store.initialize();

      expect(create.calledOnce).toBe(true);
      expect(create.firstCall.args[0]).toEqual({ password: 'pw', sync: 'off' });
      expect(fake.restoreSession.firstCall.args[0]).toEqual({ password: 'restore-pw' });
    });

    it('should shut down an orphaned store-owned manager when disposed mid-creation', async () => {
      const fake = createFakeAuth();
      let resolveCreate!: (auth: AuthManager) => void;
      sinon.stub(AuthManager, 'create').returns(new Promise((resolve) => { resolveCreate = resolve; }));
      const store = createConnectionStore({ password: 'pw' });

      const initializePromise = store.initialize();
      const beforeDispose = store.getSnapshot();
      await store.dispose();
      resolveCreate(asAuth(fake));

      // The stale action resolves without mutating the snapshot; the freshly
      // created manager is shut down instead of leaking storage handles.
      const snapshot = await initializePromise;
      expect(snapshot).toBe(beforeDispose);
      expect(fake.shutdown.calledOnce).toBe(true);
      expect(store.auth).toBeUndefined();
    });
  });

  describe('disconnect vs. in-flight bootstrap', () => {
    it('should keep an explicit disconnect authoritative over an initialize awaiting manager creation', async () => {
      // Review finding (high): initialize() gated on AuthManager.create(),
      // disconnect() during the gate. Previously the disconnect resolved
      // without a manager to clear, and the stale initialization then adopted
      // the manager, ran restoreSession(), and its session-start flipped the
      // store back to 'connected' — while persisted session state survived.
      const fake = createFakeAuth();
      const session = createSession({ name: 'Resurrected identity' });
      // Primed to restore a session — if the stale path ever runs restore,
      // the store visibly (and wrongly) reconnects.
      fake.restoreSession.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      let resolveCreate!: (auth: AuthManager) => void;
      const create = sinon.stub(AuthManager, 'create').returns(new Promise((resolve) => { resolveCreate = resolve; }));
      const store = createConnectionStore({ password: 'pw' });

      const initializePromise = store.initialize();
      const disconnectPromise = store.disconnect({ clearStorage: true });
      resolveCreate(asAuth(fake));

      const disconnected = await disconnectPromise;
      const initialized = await initializePromise;
      // Let any stray continuations settle before the final assertions.
      await Promise.resolve();

      expect(disconnected.phase).toBe('disconnected');
      expect(initialized.phase).toBe('disconnected');
      expect(store.getSnapshot().phase).toBe('disconnected');
      expect(store.getSnapshot().session).toBeUndefined();
      // The superseded initialize never ran restore — no resurrection.
      expect(fake.restoreSession.called).toBe(false);
      // The disconnect tore down THROUGH the materialized manager, so
      // AuthManager.disconnect() cleared persisted session state per its
      // options (marker clearing is the auth suite's tested contract).
      expect(fake.disconnect.calledOnce).toBe(true);
      expect(fake.disconnect.firstCall.args[0]).toEqual({ clearStorage: true });
      // The materialized manager was adopted, not leaked or discarded.
      expect(create.calledOnce).toBe(true);
      expect(store.auth).toBe(asAuth(fake));
      expect(fake.shutdown.called).toBe(false);
    });

    it('should let a fresh initialize reuse the adopted manager after the racing disconnect', async () => {
      const fake = createFakeAuth();
      let resolveCreate!: (auth: AuthManager) => void;
      const create = sinon.stub(AuthManager, 'create').returns(new Promise((resolve) => { resolveCreate = resolve; }));
      const store = createConnectionStore({ password: 'pw' });

      const initializePromise = store.initialize();
      const disconnectPromise = store.disconnect();
      resolveCreate(asAuth(fake));
      await disconnectPromise;
      await initializePromise;

      const snapshot = await store.initialize();

      expect(snapshot.phase).toBe('disconnected');
      expect(fake.restoreSession.calledOnce).toBe(true);
      expect(create.calledOnce).toBe(true);
    });

    it('should not resurrect a session when disconnect races an in-flight restoreSession', async () => {
      const fake = createFakeAuth();
      const session = createSession();
      let restoreStarted!: () => void;
      const started = new Promise<void>((resolve) => { restoreStarted = resolve; });
      let resolveRestore!: (value: AuthSession) => void;
      fake.restoreSession.callsFake((): Promise<AuthSession> => {
        restoreStarted();
        return new Promise((resolve) => { resolveRestore = resolve; });
      });
      fake.disconnect.callsFake(async (): Promise<void> => {
        fake.session = undefined;
      });
      const store = createConnectionStore({ auth: asAuth(fake) });

      const initializePromise = store.initialize();
      await started;
      const disconnectPromise = store.disconnect();
      const disconnected = await disconnectPromise;
      // The auth layer would reject the invalidated restore; resolving it
      // with a session is the harsher case — the store must discard it.
      resolveRestore(session);
      const initialized = await initializePromise;
      await Promise.resolve();

      expect(disconnected.phase).toBe('disconnected');
      expect(initialized.phase).toBe('disconnected');
      expect(store.getSnapshot().phase).toBe('disconnected');
      expect(store.getSnapshot().session).toBeUndefined();
      expect(fake.disconnect.calledOnce).toBe(true);
    });

    it('should retry manager creation after a failed bootstrap', async () => {
      const fake = createFakeAuth();
      const create = sinon.stub(AuthManager, 'create');
      create.onFirstCall().rejects(new Error('create exploded'));
      create.onSecondCall().resolves(asAuth(fake));
      const store = createConnectionStore({ password: 'pw' });

      const failed = await store.initialize();
      expect(failed.phase).toBe('error');
      expect(failed.error?.message).toBe('create exploded');

      const retried = await store.initialize();
      expect(retried.phase).toBe('disconnected');
      expect(create.callCount).toBe(2);
    });
  });

  describe('edge and failure branches', () => {
    it('should not re-run restore when initialize() follows an eager connect', async () => {
      const fake = createFakeAuth();
      const session = createSession();
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ auth: asAuth(fake) });

      await store.connect({ protocols: PROTOCOLS });
      const snapshot = await store.initialize();

      expect(snapshot.phase).toBe('connected');
      expect(fake.restoreSession.called).toBe(false);
    });

    it('should keep notifying later listeners when an earlier listener throws', async () => {
      const fake = createFakeAuth();
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.initialize();
      const consoleError = console.error;
      console.error = (): void => {};
      try {
        let notified = 0;
        store.subscribe(() => { throw new Error('listener exploded'); });
        store.subscribe(() => { notified++; });

        fake.emitter.emit('vault-locked', {});

        expect(notified).toBe(1);
        expect(store.getSnapshot().vaultLocked).toBe(true);
      } finally {
        console.error = consoleError;
      }
    });

    it('should stay connected without a status when the connection seed fails', async () => {
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      fake.getConnectionStatus.rejects(new Error('status backend down'));
      const store = createConnectionStore({ auth: asAuth(fake) });

      const snapshot = await store.connect({ protocols: PROTOCOLS });

      expect(snapshot.phase).toBe('connected');
      expect(snapshot.connection).toBeUndefined();
      expect(snapshot.error).toBeUndefined();
    });

    it('should flag wallet reapproval when the seeded status is already terminal', async () => {
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      fake.getConnectionStatus.resolves({ ...ACTIVE_STATUS, state: 'revoked' });
      const store = createConnectionStore({ auth: asAuth(fake) });

      const snapshot = await store.connect({ protocols: PROTOCOLS });

      expect(snapshot.connection?.state).toBe('revoked');
      expect(snapshot.walletReapprovalRequired).toBe(true);
    });

    it('should clear a required reapproval when an active status is observed', async () => {
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.connect({ protocols: PROTOCOLS });
      fake.emitter.emit('connection-expired', { status: { ...ACTIVE_STATUS, state: 'expired' } });
      expect(store.getSnapshot().walletReapprovalRequired).toBe(true);

      fake.emitter.emit('connection-expiring', { status: { ...ACTIVE_STATUS } });

      expect(store.getSnapshot().walletReapprovalRequired).toBeUndefined();
      expect(store.getSnapshot().connection?.state).toBe('active');
    });

    it('should map a failed disconnect without a surviving session to the error phase', async () => {
      const fake = createFakeAuth();
      const session = createSession();
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      fake.disconnect.callsFake(async (): Promise<void> => {
        fake.session = undefined;
        throw new Error('revocation delivery failed');
      });
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.connect({ protocols: PROTOCOLS });

      const snapshot = await store.disconnect();

      expect(snapshot.phase).toBe('error');
      expect(snapshot.error?.message).toBe('revocation delivery failed');
    });

    it('should stay connected when a failed action leaves the auth session intact', async () => {
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      fake.refresh.rejects(new Error('handler transport failed'));
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.connect({ protocols: PROTOCOLS });

      const snapshot = await store.refresh({ protocols: PROTOCOLS });

      expect(snapshot.phase).toBe('connected');
      expect(snapshot.session).toBe(session);
      expect(snapshot.error?.message).toBe('handler transport failed');
    });

    it('should rebuild the connected fields when a failed action reveals a session the store missed', async () => {
      const fake = createFakeAuth();
      const sessionA = createSession({ name: 'Session A' });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = sessionA;
        return sessionA;
      });
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.connect({ protocols: PROTOCOLS });

      const sessionB = createSession({ did: 'did:dht:other-owner', name: 'Session B' });
      fake.refresh.callsFake(async (): Promise<AuthSession> => {
        fake.session = sessionB;
        throw new Error('failed after session switch');
      });

      const snapshot = await store.refresh({ protocols: PROTOCOLS });

      expect(snapshot.phase).toBe('connected');
      expect(snapshot.session).toBe(sessionB);
      expect(snapshot.identityDid).toBe('did:dht:other-owner');
      expect(snapshot.identityName).toBe('Session B');
      expect(snapshot.error?.message).toBe('failed after session switch');
    });

    it('should normalize non-Error rejections into Error instances', async () => {
      const fake = createFakeAuth();
      fake.connect.callsFake((): Promise<AuthSession> => Promise.reject('string rejection'));
      const store = createConnectionStore({ auth: asAuth(fake) });

      const snapshot = await store.connect({ protocols: PROTOCOLS });

      expect(snapshot.phase).toBe('error');
      expect(snapshot.error).toBeInstanceOf(Error);
      expect(snapshot.error?.message).toBe('string rejection');
    });

    it('should resolve dispose() even when the owned manager fails to shut down', async () => {
      const fake = createFakeAuth();
      fake.shutdown.rejects(new Error('shutdown failed'));
      sinon.stub(AuthManager, 'create').resolves(asAuth(fake));
      const store = createConnectionStore({ password: 'pw' });
      await store.initialize();
      const consoleWarn = console.warn;
      console.warn = (): void => {};
      try {
        await store.dispose();
      } finally {
        console.warn = consoleWarn;
      }

      expect(fake.shutdown.calledOnce).toBe(true);
    });

    it('should keep the connected snapshot when the monitor cannot start on an externally started session', async () => {
      const fake = createFakeAuth();
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.initialize();
      fake.startConnectionMonitor.throws(new RangeError('bad interval'));
      const consoleError = console.error;
      console.error = (): void => {};
      try {
        const session = createSession({ delegateDid: DELEGATE_DID });
        fake.session = session;
        fake.emitter.emit('session-start', { session: sessionInfo(session) });
        // Let the rejected commit promise settle through its catch handler.
        await Promise.resolve();

        expect(store.getSnapshot().phase).toBe('connected');
        expect(store.getSnapshot().session).toBe(session);
      } finally {
        console.error = consoleError;
      }
    });
  });
});
