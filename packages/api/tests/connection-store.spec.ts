import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import type { AuthState, ConnectionStatus } from '@enbox/auth';

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
    });
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
      fake.emitter.emit('connection-expired', { status: { ...ACTIVE_STATUS, state: 'expired', secondsUntilExpiry: -10 } });
      expect(store.getSnapshot().walletReapprovalRequired).toBe(true);

      fake.refresh.callsFake(async (): Promise<AuthSession> => fake.session as AuthSession);

      const snapshot = await store.refresh({ protocols: PROTOCOLS });

      expect(snapshot.phase).toBe('connected');
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

    it('should follow a session started directly on the AuthManager', async () => {
      const fake = createFakeAuth();
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.initialize();
      expect(store.getSnapshot().phase).toBe('disconnected');

      const session = createSession({ name: 'Switched identity' });
      fake.session = session;
      fake.emitter.emit('session-start', {
        session: { did: session.did, delegateDid: undefined, identity: session.identity },
      });

      const snapshot = store.getSnapshot();
      expect(snapshot.phase).toBe('connected');
      expect(snapshot.session).toBe(session);
      expect(snapshot.identityName).toBe('Switched identity');
    });

    it('should synthesize a session from the event payload when the manager has not installed one yet', async () => {
      const fake = createFakeAuth();
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.initialize();

      fake.emitter.emit('session-start', {
        session: { did: OWNER_DID, delegateDid: undefined, identity: { didUri: OWNER_DID, name: 'Event identity' } },
      });

      const snapshot = store.getSnapshot();
      expect(snapshot.phase).toBe('connected');
      expect(snapshot.session?.did).toBe(OWNER_DID);
      expect(snapshot.identityName).toBe('Event identity');
      expect(snapshot.enbox).toBeInstanceOf(Enbox);
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
      fake.connect.returns(new Promise((_resolve, reject) => { rejectConnect = reject; }));
      fake.disconnect.resolves();
      const store = createConnectionStore({ auth: asAuth(fake) });

      const connectPromise = store.connect({ protocols: PROTOCOLS });
      expect(store.getSnapshot().phase).toBe('connecting');

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
  });
});
