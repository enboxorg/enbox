import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import type { DwnEndpointResolution } from '@enbox/dids';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { AuthState, ConnectionStatus } from '@enbox/auth';
import type {
  ReplicationLinkSnapshot,
  SyncConnectivityState,
  SyncEngine,
  SyncEvent,
  SyncEventListener,
  SyncIdentityOptions,
} from '@enbox/agent';

import { AuthManager } from '@enbox/auth/auth-manager';
import { EnboxUserAgent } from '@enbox/agent';
import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { AuthEventEmitter, AuthSession, ConnectDeniedError, isConnectDeniedError } from '@enbox/auth';

import type { ConnectionSnapshot } from '../src/connection-store.js';

import { createConnectionStore } from '../src/connection-store.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineProtocol } from '../src/define-protocol.js';
import { Enbox } from '../src/enbox.js';
import { ProtocolReadinessError } from '../src/protocol-readiness.js';
import { ServiceConfigProtocol } from '../src/service-config-protocol.js';
import { WalletReapprovalRequiredError } from '../src/typed-enbox.js';

const OWNER_DID = 'did:dht:store-owner';
const DELEGATE_DID = 'did:jwk:store-delegate';

const PROTOCOLS = [{
  protocol  : 'https://example.com/connection-store',
  published : true,
  types     : {},
  structure : {},
}];

const ApplicationDefinition = {
  protocol  : 'https://example.com/connection-store/application',
  published : true,
  types     : {},
  structure : {},
} as const satisfies ProtocolDefinition;

const ApplicationProtocol = defineProtocol(ApplicationDefinition, {});
const APPLICATION = defineApplicationManifest({
  protocols: [{ protocol: ApplicationProtocol, permissions: ['read'] }],
} as const);
const APPLICATION_REQUESTS = [{ definition: ApplicationDefinition, permissions: ['read'] }];

const ACTIVE_STATUS: ConnectionStatus = {
  state              : 'active',
  connectSessionId   : 'session-1',
  connectedDid       : OWNER_DID,
  delegateDid        : DELEGATE_DID,
  expiresAt          : '2040-01-01T00:00:00.000000Z',
  secondsUntilExpiry : 86_400,
};

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error: unknown) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

type FakeSyncStatusEngine = {
  connectivityState: SyncConnectivityState;
  emit(event: SyncEvent): void;
  linkReads: number;
  links: ReplicationLinkSnapshot[];
  listenerCount(): number;
  optionUpdates: { did: string; options: SyncIdentityOptions }[];
  options?: SyncIdentityOptions;
  readLinks(): Promise<ReplicationLinkSnapshot[]>;
  settledLinkReads: number;
  sync: SyncEngine;
};

function createSyncStatusEngine(): FakeSyncStatusEngine {
  const listeners = new Set<SyncEventListener>();
  const state: FakeSyncStatusEngine = {
    connectivityState : 'unknown',
    emit              : (event): void => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    linkReads        : 0,
    links            : [],
    listenerCount    : (): number => listeners.size,
    optionUpdates    : [],
    options          : { protocols: 'all' },
    readLinks        : async (): Promise<ReplicationLinkSnapshot[]> => state.links,
    settledLinkReads : 0,
    sync             : undefined as unknown as SyncEngine,
  };
  state.sync = {
    get connectivityState(): SyncConnectivityState { return state.connectivityState; },
    getIdentityOptions  : async (): Promise<SyncIdentityOptions | undefined> => state.options,
    getReplicationLinks : async (): Promise<ReplicationLinkSnapshot[]> => {
      state.linkReads++;
      try {
        return await state.readLinks();
      } finally {
        state.settledLinkReads++;
      }
    },
    on: (listener: SyncEventListener): (() => void) => {
      listeners.add(listener);
      return (): void => { listeners.delete(listener); };
    },
    setIdentityOptions: async ({ did, options }): Promise<void> => {
      state.optionUpdates.push({ did, options });
      state.options = options;
    },
  } as SyncEngine;
  return state;
}

function syncLink(overrides: Partial<ReplicationLinkSnapshot> = {}): ReplicationLinkSnapshot {
  return {
    tenantDid      : OWNER_DID,
    remoteEndpoint : 'https://dwn.example',
    scope          : { kind: 'full' },
    status         : 'initializing',
    connectivity   : 'unknown',
    isPullCurrent  : false,
    ...overrides,
  };
}

function serviceConfigNotice(author: string = OWNER_DID): SyncEvent {
  return {
    type           : 'delivery:applied',
    tenantDid      : OWNER_DID,
    remoteEndpoint : 'https://dwn.example',
    messageCid     : 'service-config-notice',
    descriptor     : {
      interface    : 'Records',
      method       : 'Write',
      protocol     : ServiceConfigProtocol.definition.protocol,
      protocolPath : 'serviceConfig',
      author,
    },
  };
}

function readyDwn(endpoint = 'https://dwn.example', didUri = OWNER_DID): DwnEndpointResolution {
  return { status: 'ready', didUri, endpoints: [endpoint] };
}

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
  let getDwnEndpointStatus: sinon.SinonStub;

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
    getDwnEndpointStatus = sinon.stub(testHarness.agent.identity, 'getDwnEndpointStatus')
      .callsFake(async ({ didUri }): Promise<DwnEndpointResolution> => readyDwn(undefined, didUri));
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

  function createSession(params: {
    agent?: EnboxUserAgent;
    did?: string;
    delegateDid?: string;
    name?: string;
    signal?: AbortSignal;
  } = {}): AuthSession {
    const did = params.did ?? OWNER_DID;
    return new AuthSession({
      agent       : params.agent ?? testHarness.agent as EnboxUserAgent,
      did,
      delegateDid : params.delegateDid,
      identity    : { didUri: did, name: params.name ?? 'Store identity' },
      signal      : params.signal ?? new AbortController().signal,
    });
  }

  function stubProtocolReadiness(): sinon.SinonStub {
    const fromSession = Enbox.fromSession;
    const ensureReady = sinon.stub().resolves();
    sinon.stub(Enbox, 'fromSession').callsFake((session): Enbox => {
      const enbox = fromSession(session);
      enbox.protocols = { ensureReady };
      return enbox;
    });
    return ensureReady;
  }

  function agentWithSync(sync: SyncEngine): EnboxUserAgent {
    return new Proxy(testHarness.agent as EnboxUserAgent, {
      get: (target, property, receiver): unknown =>
        property === 'sync' ? sync : Reflect.get(target, property, receiver),
    });
  }

  async function connectWithSync(
    engine: FakeSyncStatusEngine,
    params: { did?: string; signal?: AbortSignal } = {},
  ): Promise<{ auth: FakeAuthManager; store: ReturnType<typeof createConnectionStore> }> {
    const session = createSession({ agent: agentWithSync(engine.sync), ...params });
    const auth = createFakeAuth();
    auth.connect.callsFake(async (): Promise<AuthSession> => {
      auth.session = session;
      return session;
    });
    const store = createConnectionStore({ auth: asAuth(auth) });
    await store.connect({ protocols: PROTOCOLS });
    return { auth, store };
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

  describe('sync status', () => {
    it('should project the selected identity without exposing link topology', async () => {
      const engine = createSyncStatusEngine();
      engine.connectivityState = 'offline';
      const { store } = await connectWithSync(engine);
      await waitFor(() => { expect(store.getSnapshot().sync?.state).toBe('syncing'); });
      expect(store.getSnapshot().sync?.connectivity).toBe('offline');
      expect(Object.isFrozen(store.getSnapshot().sync)).toBe(true);

      engine.links = [
        syncLink({
          status         : 'live',
          connectivity   : 'online',
          isPullCurrent  : true,
          lastActivityAt : '2026-07-29T10:00:00.000Z',
        }),
        syncLink({
          remoteEndpoint : 'https://backup.example',
          status         : 'live',
          connectivity   : 'online',
          isPullCurrent  : true,
          lastActivityAt : '2026-07-29T11:00:00.000Z',
        }),
      ];
      engine.emit({
        type           : 'pull:currentness-change',
        tenantDid      : OWNER_DID,
        remoteEndpoint : 'https://dwn.example',
        from           : false,
        to             : true,
      });
      await waitFor(() => { expect(store.getSnapshot().sync?.state).toBe('caught-up'); });

      const caughtUp = store.getSnapshot().sync;
      expect(caughtUp?.connectivity).toBe('online');
      expect(caughtUp?.lastActivityAt).toBe('2026-07-29T11:00:00.000Z');
      expect('links' in (caughtUp as object)).toBe(false);

      const settledReads = engine.settledLinkReads;
      engine.emit({
        type           : 'checkpoint:pull-advance',
        tenantDid      : OWNER_DID,
        remoteEndpoint : 'https://dwn.example',
        position       : '1',
      });
      await waitFor(() => { expect(engine.settledLinkReads).toBeGreaterThan(settledReads); });
      expect(store.getSnapshot().sync).toBe(caughtUp);

      engine.links = [
        syncLink({
          status         : 'live',
          connectivity   : 'offline',
          lastActivityAt : '2026-07-29T11:00:00.000Z',
        }),
        syncLink({ remoteEndpoint: 'https://backup.example', status: 'live', connectivity: 'online' }),
      ];
      engine.emit({
        type           : 'link:connectivity-change',
        tenantDid      : OWNER_DID,
        remoteEndpoint : 'https://dwn.example',
        from           : 'online',
        to             : 'offline',
      });
      await waitFor(() => { expect(store.getSnapshot().sync?.state).toBe('syncing'); });
      expect(store.getSnapshot().sync?.connectivity).toBe('online');

      const mixedRead = engine.settledLinkReads;
      engine.links = [syncLink({ status: 'live', connectivity: 'offline' })];
      engine.emit({
        type           : 'link:connectivity-change',
        tenantDid      : OWNER_DID,
        remoteEndpoint : 'https://backup.example',
        from           : 'online',
        to             : 'offline',
      });
      await waitFor(() => { expect(engine.settledLinkReads).toBeGreaterThan(mixedRead); });
      expect(store.getSnapshot().sync?.connectivity).toBe('offline');

      engine.links = [syncLink({ status: 'paused', connectivity: 'offline' })];
      engine.emit({
        type           : 'link:status-change',
        tenantDid      : OWNER_DID,
        remoteEndpoint : 'https://dwn.example',
        from           : 'live',
        to             : 'paused',
      });
      await waitFor(() => { expect(store.getSnapshot().sync?.state).toBe('error'); });
      expect(store.getSnapshot().sync?.error?.message).toContain('paused');
    });

    it('should treat an identity without a sync registration as locally caught up', async () => {
      const engine = createSyncStatusEngine();
      engine.options = undefined;
      const { store } = await connectWithSync(engine);
      await waitFor(() => { expect(store.getSnapshot().sync?.state).toBe('caught-up'); });

      expect(store.getSnapshot().sync).toEqual({ state: 'caught-up', connectivity: 'unknown' });
      expect(engine.linkReads).toBe(0);

      engine.options = { protocols: 'all' };
      engine.emit({
        type      : 'identity:registration-change',
        tenantDid : OWNER_DID,
        options   : engine.options,
      });
      await waitFor(() => { expect(store.getSnapshot().sync?.state).toBe('syncing'); });
      expect(engine.linkReads).toBe(1);
    });

    it('should surface local status-read failures without losing prior activity', async () => {
      const engine = createSyncStatusEngine();
      engine.links = [syncLink({
        status         : 'live',
        connectivity   : 'online',
        isPullCurrent  : true,
        lastActivityAt : '2026-07-29T11:00:00.000Z',
      })];
      const { store } = await connectWithSync(engine);
      await waitFor(() => { expect(store.getSnapshot().sync?.state).toBe('caught-up'); });

      engine.readLinks = async (): Promise<ReplicationLinkSnapshot[]> => {
        throw new Error('local status unavailable');
      };
      engine.emit({
        type           : 'checkpoint:push-advance',
        tenantDid      : OWNER_DID,
        remoteEndpoint : 'https://dwn.example',
        position       : '2',
      });
      await waitFor(() => { expect(store.getSnapshot().sync?.state).toBe('error'); });

      expect(store.getSnapshot().sync).toMatchObject({
        connectivity   : 'online',
        lastActivityAt : '2026-07-29T11:00:00.000Z',
        error          : { message: 'local status unavailable' },
      });
    });

    it('should ignore other identities and fence replaced and locked sessions', async () => {
      const engine = createSyncStatusEngine();
      let resolveLinks!: (links: ReplicationLinkSnapshot[]) => void;
      engine.readLinks = (): Promise<ReplicationLinkSnapshot[]> => new Promise((resolve) => {
        resolveLinks = resolve;
      });
      const { auth, store } = await connectWithSync(engine);
      await waitFor(() => { expect(engine.linkReads).toBe(1); });
      const readsBeforeOtherIdentity = engine.linkReads;

      engine.emit({
        type           : 'checkpoint:pull-advance',
        tenantDid      : 'did:dht:someone-else',
        remoteEndpoint : 'https://dwn.example',
        position       : '1',
      });
      await Promise.resolve();
      expect(engine.linkReads).toBe(readsBeforeOtherIdentity);

      const replacementEngine = createSyncStatusEngine();
      replacementEngine.options = undefined;
      const replacementLifetime = new AbortController();
      const replacementSession = createSession({
        agent  : agentWithSync(replacementEngine.sync),
        did    : 'did:dht:replacement',
        signal : replacementLifetime.signal,
      });
      auth.session = replacementSession;
      auth.emitter.emit('session-start', {});
      await waitFor(() => { expect(store.getSnapshot().identityDid).toBe(replacementSession.did); });
      await waitFor(() => { expect(store.getSnapshot().sync?.state).toBe('caught-up'); });
      expect(engine.listenerCount()).toBe(0);
      expect(replacementEngine.listenerCount()).toBe(1);

      let notifications = 0;
      store.subscribe(() => { notifications++; });
      const replacementSnapshot = store.getSnapshot();

      resolveLinks([syncLink({ status: 'live', connectivity: 'online', isPullCurrent: true })]);
      await Promise.resolve();
      await Promise.resolve();

      expect(store.getSnapshot()).toBe(replacementSnapshot);
      expect(notifications).toBe(0);

      auth.emitter.emit('vault-locked', {});
      expect(store.getSnapshot().sync).toBeUndefined();
      expect(replacementEngine.listenerCount()).toBe(0);
      expect(notifications).toBe(1);

      const lockedSnapshot = store.getSnapshot();
      replacementLifetime.abort();
      expect(store.getSnapshot()).toBe(lockedSnapshot);
      expect(notifications).toBe(1);
    });

    it('should unbind when the active session ends', async () => {
      const engine = createSyncStatusEngine();
      engine.options = undefined;
      const lifetime = new AbortController();
      const { store } = await connectWithSync(engine, { signal: lifetime.signal });
      await waitFor(() => { expect(store.getSnapshot().sync?.state).toBe('caught-up'); });

      let notifications = 0;
      store.subscribe(() => { notifications++; });
      lifetime.abort();

      expect(store.getSnapshot().sync).toBeUndefined();
      expect(engine.listenerCount()).toBe(0);
      expect(notifications).toBe(1);
    });
  });

  describe('remote DWN status', () => {
    it('should seed from a fresh resolution and retarget sync only for semantic changes', async () => {
      const engine = createSyncStatusEngine();
      const { store } = await connectWithSync(engine);

      expect(store.getSnapshot().remoteDwn).toEqual(readyDwn());
      expect(Object.isFrozen(store.getSnapshot().remoteDwn)).toBe(true);
      expect(Object.isFrozen((store.getSnapshot().remoteDwn as { endpoints: string[] }).endpoints)).toBe(true);
      expect(engine.optionUpdates).toEqual([{ did: OWNER_DID, options: { protocols: 'all' } }]);

      engine.optionUpdates.length = 0;
      getDwnEndpointStatus.resolves(readyDwn('https://new-dwn.example'));
      const changed = await store.refreshDwnEndpoints();

      expect(changed.remoteDwn).toEqual(readyDwn('https://new-dwn.example'));
      expect(engine.optionUpdates).toEqual([{ did: OWNER_DID, options: { protocols: 'all' } }]);

      const stable = store.getSnapshot();
      await store.refreshDwnEndpoints();
      expect(store.getSnapshot()).toBe(stable);
      expect(engine.optionUpdates).toHaveLength(1);
      expect(getDwnEndpointStatus.alwaysCalledWith({ didUri: OWNER_DID, refresh: true })).toBe(true);
    });

    it('should retry unchanged routing after an update failure', async () => {
      const engine = createSyncStatusEngine();
      const setIdentityOptions = sinon.stub(engine.sync, 'setIdentityOptions');
      setIdentityOptions.onFirstCall().rejects(new Error('routing unavailable'));
      setIdentityOptions.onSecondCall().callsFake(async ({ did, options }): Promise<void> => {
        engine.optionUpdates.push({ did, options });
        engine.options = options;
      });
      sinon.stub(console, 'error');

      const { store } = await connectWithSync(engine);
      const initial = store.getSnapshot();
      expect(setIdentityOptions.callCount).toBe(1);

      const retried = await store.refreshDwnEndpoints();
      expect(retried).toBe(initial);
      expect(setIdentityOptions.callCount).toBe(2);

      await store.refreshDwnEndpoints();
      expect(setIdentityOptions.callCount).toBe(2);
    });

    it('should expose missing and failed resolution states without dropping routing on transient failure', async () => {
      const engine = createSyncStatusEngine();
      const { store } = await connectWithSync(engine);
      engine.optionUpdates.length = 0;

      getDwnEndpointStatus.resolves({
        status  : 'service-missing',
        didUri  : OWNER_DID,
        message : `DID '${OWNER_DID}' does not advertise a #dwn service.`,
      });
      await store.refreshDwnEndpoints();
      expect(store.getSnapshot().remoteDwn?.status).toBe('service-missing');
      expect(engine.optionUpdates).toHaveLength(1);

      engine.optionUpdates.length = 0;
      getDwnEndpointStatus.resolves({
        status          : 'resolution-failed',
        didUri          : OWNER_DID,
        message         : 'Resolver unavailable.',
        resolutionError : 'internalError',
      });
      await store.refreshDwnEndpoints();

      expect(store.getSnapshot().remoteDwn).toMatchObject({
        status  : 'resolution-failed',
        message : 'Resolver unavailable.',
      });
      expect(engine.optionUpdates).toHaveLength(0);
    });

    it('should filter and coalesce service-config delivery wakes into fresh resolutions', async () => {
      const engine = createSyncStatusEngine();
      const { store } = await connectWithSync(engine);
      getDwnEndpointStatus.resetHistory();
      engine.optionUpdates.length = 0;

      let resolveFirst!: (status: DwnEndpointResolution) => void;
      const firstRead = new Promise<DwnEndpointResolution>((resolve) => { resolveFirst = resolve; });
      getDwnEndpointStatus.onCall(0).returns(firstRead);
      getDwnEndpointStatus.onCall(1).resolves(readyDwn('https://latest-dwn.example'));

      engine.emit(serviceConfigNotice('did:dht:someone-else'));
      await Promise.resolve();
      expect(getDwnEndpointStatus.callCount).toBe(0);

      engine.emit(serviceConfigNotice());
      await waitFor(() => { expect(getDwnEndpointStatus.callCount).toBe(1); });
      engine.emit(serviceConfigNotice());
      engine.emit(serviceConfigNotice());
      expect(getDwnEndpointStatus.callCount).toBe(1);

      resolveFirst(readyDwn('https://superseded-dwn.example'));
      await waitFor(() => { expect(getDwnEndpointStatus.callCount).toBe(2); });
      await waitFor(() => {
        expect(store.getSnapshot().remoteDwn?.status).toBe('ready');
        expect((store.getSnapshot().remoteDwn as { endpoints: string[] }).endpoints)
          .toEqual(['https://latest-dwn.example']);
      });

      expect(getDwnEndpointStatus.alwaysCalledWith({ didUri: OWNER_DID, refresh: true })).toBe(true);
      expect(engine.optionUpdates).toHaveLength(1);
    });

    it('should discard a late fresh resolution after the exact session aborts', async () => {
      const engine = createSyncStatusEngine();
      const lifetime = new AbortController();
      const { store } = await connectWithSync(engine, { signal: lifetime.signal });
      getDwnEndpointStatus.resetHistory();
      engine.optionUpdates.length = 0;

      let resolveStatus!: (status: DwnEndpointResolution) => void;
      getDwnEndpointStatus.returns(new Promise<DwnEndpointResolution>((resolve) => { resolveStatus = resolve; }));
      engine.emit(serviceConfigNotice());
      await waitFor(() => { expect(getDwnEndpointStatus.calledOnce).toBe(true); });

      lifetime.abort();
      const aborted = store.getSnapshot();
      expect(aborted.remoteDwn).toBeUndefined();
      resolveStatus(readyDwn('https://stale-dwn.example'));
      await Promise.resolve();
      await Promise.resolve();

      expect(store.getSnapshot()).toBe(aborted);
      expect(engine.optionUpdates).toHaveLength(0);
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

  describe('application lifecycle', () => {
    it('should reject an empty application manifest', () => {
      const application = defineApplicationManifest({ protocols: [] });

      expect(() => createConnectionStore({ application })).toThrow(
        'createConnectionStore requires at least one application protocol'
      );
    });

    it('should project the registered manifest through delegated connect, refresh, and opted-in auto-refresh', async () => {
      const ensureReady = stubProtocolReadiness();
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({
        application : APPLICATION,
        auth        : asAuth(fake),
        monitor     : { autoRefresh: {} },
      });

      await store.connect();

      expect(fake.connect.firstCall.args[0]).toEqual({ protocols: APPLICATION_REQUESTS });
      expect(fake.startConnectionMonitor.firstCall.args[0].autoRefresh).toEqual({
        protocols: APPLICATION_REQUESTS,
      });
      expect(ensureReady.firstCall.args[0]).toEqual({ application: APPLICATION, publish: false });

      const refreshedSession = createSession({ delegateDid: DELEGATE_DID, name: 'Refreshed identity' });
      fake.refresh.callsFake(async (): Promise<AuthSession> => {
        fake.session = refreshedSession;
        return refreshedSession;
      });

      await store.refresh();

      expect(fake.refresh.firstCall.args[0]).toEqual({ protocols: APPLICATION_REQUESTS });
      expect(ensureReady.callCount).toBe(2);
    });

    it('should keep hosted readiness opt-in for an owner without a DWN service', async () => {
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Local owner' },
        didMethod : 'jwk',
      });
      const session = new AuthSession({
        agent  : testHarness.agent,
        did    : identity.did.uri,
        identity,
        signal : new AbortController().signal,
      });
      const localAuth = createFakeAuth();
      localAuth.connectVault.callsFake(async (): Promise<AuthSession> => {
        localAuth.session = session;
        return session;
      });
      const localStore = createConnectionStore({ application: APPLICATION, auth: asAuth(localAuth) });

      const connected = await localStore.connectVault();

      expect(connected.phase).toBe('connected');
      expect((await connected.enbox!.using(ApplicationProtocol).verifyInstalled()).status).toBe('up-to-date');
      await localStore.dispose();

      const hostedAuth = createFakeAuth();
      hostedAuth.connectVault.callsFake(async (): Promise<AuthSession> => {
        hostedAuth.session = session;
        return session;
      });
      const hostedStore = createConnectionStore({
        application            : APPLICATION,
        auth                   : asAuth(hostedAuth),
        requireHostedReadiness : true,
      });

      const failed = await hostedStore.connectVault();

      expect(failed.phase).toBe('error');
      expect(failed.error).toBeInstanceOf(ProtocolReadinessError);
      expect(failed.error).toMatchObject({ operation: 'publish' });
      expect(failed.session).toBeUndefined();
    });

    it('should keep a restored session private until application readiness completes', async () => {
      const ensureReady = stubProtocolReadiness();
      let resolveReadiness!: () => void;
      ensureReady.returns(new Promise<void>((resolve) => { resolveReadiness = resolve; }));
      const fake = createFakeAuth();
      const session = createSession();
      fake.restoreSession.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ application: APPLICATION, auth: asAuth(fake) });
      const phases: ConnectionSnapshot['phase'][] = [];
      store.subscribe((snapshot) => { phases.push(snapshot.phase); });

      const initializing = store.initialize();
      await waitFor(() => { expect(ensureReady.calledOnce).toBe(true); });

      expect(store.getSnapshot().phase).toBe('initializing');
      expect(store.getSnapshot().session).toBeUndefined();
      expect(store.getSnapshot().enbox).toBeUndefined();
      expect(phases).not.toContain('connected');

      resolveReadiness();
      const snapshot = await initializing;

      expect(snapshot.phase).toBe('connected');
      expect(snapshot.session).toBe(session);
      expect(snapshot.enbox).toBeInstanceOf(Enbox);
    });

    it('should ready a replacement session instead of failing on the superseded candidate', async () => {
      const ensureReady = stubProtocolReadiness();
      let rejectReadiness!: (error: Error) => void;
      ensureReady.onFirstCall().returns(new Promise<void>((_resolve, reject) => { rejectReadiness = reject; }));
      const fake = createFakeAuth();
      const firstSession = createSession({ name: 'First identity' });
      const replacementSession = createSession({ did: 'did:dht:replacement', name: 'Replacement identity' });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = firstSession;
        return firstSession;
      });
      const store = createConnectionStore({ application: APPLICATION, auth: asAuth(fake) });

      const connecting = store.connect();
      await waitFor(() => { expect(ensureReady.calledOnce).toBe(true); });
      fake.session = replacementSession;
      rejectReadiness(new Error('superseded readiness failed'));
      const snapshot = await connecting;

      expect(snapshot.phase).toBe('connected');
      expect(snapshot.session).toBe(replacementSession);
      expect(ensureReady.callCount).toBe(2);
      expect(fake.disconnect.called).toBe(false);
    });

    it('should fail closed, stop the old monitor, and retain a retryable session when readiness fails', async () => {
      const ensureReady = stubProtocolReadiness();
      const readinessError = new ProtocolReadinessError({
        cause     : new Error('hosted DWN unavailable'),
        operation : 'install',
        protocol  : ApplicationDefinition.protocol,
        targetDid : OWNER_DID,
      });
      ensureReady.onSecondCall().rejects(readinessError);
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ application: APPLICATION, auth: asAuth(fake) });
      await store.connect();

      const replacementSession = createSession({ delegateDid: DELEGATE_DID, name: 'Replacement identity' });
      fake.refresh.callsFake(async (): Promise<AuthSession> => {
        fake.session = replacementSession;
        return replacementSession;
      });

      const snapshot = await store.refresh();

      expect(snapshot.phase).toBe('error');
      expect(snapshot.error).toBe(readinessError);
      expect(snapshot.session).toBeUndefined();
      expect(snapshot.enbox).toBeUndefined();
      expect(fake.session).toBe(replacementSession);
      expect(fake.disconnect.called).toBe(false);
      expect(fake.stopMonitorSpy.calledOnce).toBe(true);
      expect(fake.startConnectionMonitor.calledOnce).toBe(true);

      fake.refresh.rejects(new ConnectDeniedError('Refresh denied'));
      const denied = await store.refresh();
      expect(denied.phase).toBe('disconnected');
      expect(denied.session).toBeUndefined();
      expect(denied.enbox).toBeUndefined();
    });

    it('should hide an aborted previous session while an external replacement is readied', async () => {
      const ensureReady = stubProtocolReadiness();
      let resolveReadiness!: () => void;
      ensureReady.onSecondCall().returns(new Promise<void>((resolve) => { resolveReadiness = resolve; }));
      const fake = createFakeAuth();
      const previousLifetime = new AbortController();
      const previousSession = createSession({ delegateDid: DELEGATE_DID, signal: previousLifetime.signal });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = previousSession;
        return previousSession;
      });
      const store = createConnectionStore({ application: APPLICATION, auth: asAuth(fake) });
      await store.connect();

      const replacementSession = createSession({ delegateDid: DELEGATE_DID, name: 'Replacement identity' });
      previousLifetime.abort();
      fake.session = replacementSession;
      fake.emitter.emit('session-start', {});
      await waitFor(() => { expect(ensureReady.callCount).toBe(2); });

      expect(store.getSnapshot().phase).toBe('connecting');
      expect(store.getSnapshot().session).toBeUndefined();
      expect(store.getSnapshot().enbox).toBeUndefined();

      resolveReadiness();
      await waitFor(() => { expect(store.getSnapshot().session).toBe(replacementSession); });
      expect(store.getSnapshot().phase).toBe('connected');
    });

    it('should not publish a candidate whose lifetime ends during readiness', async () => {
      const ensureReady = stubProtocolReadiness();
      let resolveReadiness!: () => void;
      ensureReady.returns(new Promise<void>((resolve) => { resolveReadiness = resolve; }));
      const fake = createFakeAuth();
      const lifetime = new AbortController();
      const session = createSession({ delegateDid: DELEGATE_DID, signal: lifetime.signal });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ application: APPLICATION, auth: asAuth(fake) });

      const connecting = store.connect();
      await waitFor(() => { expect(ensureReady.calledOnce).toBe(true); });
      lifetime.abort();
      resolveReadiness();
      const snapshot = await connecting;

      expect(snapshot.phase).toBe('disconnected');
      expect(snapshot.session).toBeUndefined();
      expect(snapshot.enbox).toBeUndefined();
      expect(fake.startConnectionMonitor.called).toBe(false);
    });

    it('should surface wallet reapproval without exposing the rejected delegate session', async () => {
      const ensureReady = stubProtocolReadiness();
      ensureReady.rejects(new ProtocolReadinessError({
        cause     : new WalletReapprovalRequiredError(ApplicationDefinition.protocol, 'is stale.'),
        operation : 'install',
        protocol  : ApplicationDefinition.protocol,
        targetDid : OWNER_DID,
      }));
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      fake.disconnect.callsFake(async (): Promise<void> => {
        fake.session = undefined;
      });
      const store = createConnectionStore({ application: APPLICATION, auth: asAuth(fake) });

      const snapshot = await store.connect();

      expect(snapshot.phase).toBe('disconnected');
      expect(snapshot.walletReapprovalRequired).toBe(true);
      expect(snapshot.session).toBeUndefined();
      expect(snapshot.enbox).toBeUndefined();
      expect(fake.disconnect.firstCall.args[0]).toEqual({ clearStorage: false });
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

      expect(phases[0]).toBe('connecting');
      expect(phases.at(-1)).toBe('connected');
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
    it('should report missing protocols without refreshing a store that has no application', async () => {
      const fake = createFakeAuth();
      const store = createConnectionStore({ auth: asAuth(fake) });

      const snapshot = await (store as unknown as {
        refresh(): Promise<ConnectionSnapshot>;
      }).refresh();

      expect(snapshot.phase).toBe('error');
      expect(snapshot.error?.message).toContain('requires protocols when no application manifest is registered');
      expect(fake.refresh.called).toBe(false);
    });

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
        fake.emitter.emit('session-start', {});
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
      fake.emitter.emit('session-start', {});
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
      fake.emitter.emit('session-start', {});

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
    it('should publish disconnecting synchronously, then clear the session fields', async () => {
      const fake = createFakeAuth();
      const session = createSession({ delegateDid: DELEGATE_DID });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      let finishDisconnect!: () => void;
      fake.disconnect.callsFake((): Promise<void> => new Promise((resolve) => {
        finishDisconnect = (): void => {
          fake.session = undefined;
          resolve();
        };
      }));
      const phases: string[] = [];
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.connect({ protocols: PROTOCOLS });
      store.subscribe((next): void => { phases.push(next.phase); });

      const disconnect = store.disconnect({ clearStorage: true });
      const duplicate = store.disconnect({ clearStorage: true });
      const pending = store.getSnapshot();

      expect(duplicate).toBe(disconnect);
      expect(pending.phase).toBe('disconnecting');
      expect(pending.session).toBeUndefined();
      expect(pending.enbox).toBeUndefined();
      expect(phases).toEqual(['disconnecting']);

      finishDisconnect();
      const snapshot = await disconnect;

      expect(fake.disconnect.firstCall.args[0]).toEqual({ clearStorage: true });
      expect(fake.disconnect.calledOnce).toBe(true);
      expect(snapshot.phase).toBe('disconnected');
      expect(fake.stopMonitorSpy.calledOnce).toBe(true);
      expect(phases).toEqual(['disconnecting', 'disconnected']);
    });

    it('should publish disconnecting when the session lifetime is aborted externally', async () => {
      const fake = createFakeAuth();
      const lifetime = new AbortController();
      const session = createSession({ signal: lifetime.signal });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.connect({ protocols: PROTOCOLS });

      lifetime.abort();

      expect(store.getSnapshot().phase).toBe('disconnecting');
      expect(store.getSnapshot().session).toBeUndefined();
      expect(store.getSnapshot().enbox).toBeUndefined();

      fake.session = undefined;
      fake.emitter.emit('session-end', { did: session.did });

      expect(store.getSnapshot().phase).toBe('disconnected');
    });

    it('should keep the connecting phase when refresh aborts the replaced session', async () => {
      const fake = createFakeAuth();
      const lifetime = new AbortController();
      const session = createSession({ signal: lifetime.signal });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      let finishRefresh!: () => void;
      fake.refresh.callsFake((): Promise<AuthSession> => new Promise((resolve) => {
        finishRefresh = (): void => {
          const replacement = createSession({ name: 'Replacement' });
          fake.session = replacement;
          resolve(replacement);
        };
      }));
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.connect({ protocols: PROTOCOLS });

      const refresh = store.refresh({ protocols: PROTOCOLS });
      await waitFor(() => { expect(fake.refresh.calledOnce).toBe(true); });
      lifetime.abort();

      expect(store.getSnapshot().phase).toBe('connecting');

      finishRefresh();
      expect((await refresh).phase).toBe('connected');
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

    it('should not publish a session when disconnect supersedes application readiness', async () => {
      const ensureReady = stubProtocolReadiness();
      let resolveReadiness!: () => void;
      ensureReady.returns(new Promise<void>((resolve) => { resolveReadiness = resolve; }));
      const fake = createFakeAuth();
      const session = createSession();
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      fake.disconnect.callsFake(async (): Promise<void> => {
        fake.session = undefined;
      });
      const store = createConnectionStore({ application: APPLICATION, auth: asAuth(fake) });

      const connectPromise = store.connect();
      await waitFor(() => { expect(ensureReady.calledOnce).toBe(true); });
      const disconnectPromise = store.disconnect();
      const disconnected = await disconnectPromise;
      resolveReadiness();
      const connectResult = await connectPromise;

      expect(disconnected.phase).toBe('disconnected');
      expect(connectResult.phase).toBe('disconnected');
      expect(store.getSnapshot().session).toBeUndefined();
      expect(fake.startConnectionMonitor.called).toBe(false);
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
      let notifications = 0;
      store.subscribe(() => { notifications++; });

      await store.dispose();

      expect(fake.stopMonitorSpy.calledOnce).toBe(true);
      expect(notifications).toBe(0);
      const disposed = store.getSnapshot();
      expect(disposed.sync).toBeUndefined();
      // Detached: later auth events no longer mutate the snapshot.
      fake.emitter.emit('vault-locked', {});
      expect(store.getSnapshot()).toBe(disposed);
      expect(store.getSnapshot()).not.toBe(before);
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
        application            : APPLICATION,
        password               : 'pw',
        requireHostedReadiness : true,
        sync                   : 'off',
        monitor                : false,
        restore                : { password: 'restore-pw' },
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
      const lifetime = new AbortController();
      const session = createSession({ signal: lifetime.signal });
      fake.connect.callsFake(async (): Promise<AuthSession> => {
        fake.session = session;
        return session;
      });
      fake.disconnect.callsFake(async (): Promise<void> => {
        lifetime.abort();
        throw new Error('revocation delivery failed');
      });
      const store = createConnectionStore({ auth: asAuth(fake) });
      await store.connect({ protocols: PROTOCOLS });

      const snapshot = await store.disconnect();

      expect(snapshot.phase).toBe('error');
      expect(snapshot.session).toBeUndefined();
      expect(snapshot.enbox).toBeUndefined();
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
        fake.emitter.emit('session-start', {});
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
