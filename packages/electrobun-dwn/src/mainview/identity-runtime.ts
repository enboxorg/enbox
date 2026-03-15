import { AuthManager } from '../../../auth/dist/esm/auth-manager.js';
import type { AuthState, IdentityInfo, PortableIdentity } from '@enbox/auth';
import { getAppStore } from './state/app-store.js';

const defaultDwnEndpoint = 'https://enbox-dwn.fly.dev';
const localEndpointCacheMs = 5_000;

export const identityRuntimeWindowKey = '__identityRuntime';
export const identityWalletEventName = 'identity-wallet-changed';

export type ManagedIdentitySnapshot = IdentityInfo & {
  active: boolean;
  connectedTargetDid: string;
  kind: 'local' | 'delegated';
};

export type IdentityWalletSnapshot = {
  authState: AuthState;
  isConnected: boolean;
  isLocked: boolean;
  isConnecting: boolean;
  activeDid?: string;
  delegateDid?: string;
  activeManagedDidUri?: string;
  identities: ManagedIdentitySnapshot[];
  latestRecoveryPhrase?: string;
  localDwnEndpoint?: string;
  lastError?: string;
  lastUpdatedAt: string;
};

type DidResolutionLike = {
  didDocument: Record<string, unknown> | null;
  didDocumentMetadata: Record<string, unknown>;
  didResolutionMetadata: Record<string, unknown>;
};

export type IdentityDetails = {
  identity: ManagedIdentitySnapshot;
  managedDidResolution: DidResolutionLike;
  connectedDidResolution?: DidResolutionLike;
  dwnEndpoints: string[];
  syncOptions?: Record<string, unknown>;
};

export type ExportedIdentity = {
  didUri: string;
  name: string;
  portableIdentity: PortableIdentity;
  json: string;
};

export interface IdentityRuntime {
  initialize(): Promise<IdentityWalletSnapshot>;
  refresh(): Promise<IdentityWalletSnapshot>;
  connectLocal(options?: {
    password?: string;
    name?: string;
    dwnEndpoints?: string[];
    recoveryPhrase?: string;
  }): Promise<IdentityWalletSnapshot>;
  createDid(options?: {
    password?: string;
    name?: string;
    dwnEndpoints?: string[];
  }): Promise<IdentityWalletSnapshot>;
  importFromPhrase(options: {
    recoveryPhrase: string;
    password: string;
    dwnEndpoints?: string[];
  }): Promise<IdentityWalletSnapshot>;
  importFromPortable(options: {
    portableIdentity: PortableIdentity;
    password?: string;
    dwnEndpoints?: string[];
  }): Promise<IdentityWalletSnapshot>;
  switchDid(didUri: string): Promise<IdentityWalletSnapshot>;
  renameDid(options: {
    didUri: string;
    name: string;
    password?: string;
  }): Promise<IdentityWalletSnapshot>;
  deleteDid(options: {
    didUri: string;
    password?: string;
  }): Promise<IdentityWalletSnapshot>;
  exportDid(didUri: string): Promise<ExportedIdentity>;
  getDidDetails(didUri: string): Promise<IdentityDetails>;
  resolveDid(didUri: string): Promise<DidResolutionLike>;
  setDidEndpoints(options: {
    didUri: string;
    endpoints: string[];
    password?: string;
  }): Promise<IdentityWalletSnapshot>;
  lock(): Promise<IdentityWalletSnapshot>;
  unlock(password: string): Promise<IdentityWalletSnapshot>;
  disconnect(clearStorage?: boolean): Promise<IdentityWalletSnapshot>;
  clearRecoveryPhrase(): Promise<IdentityWalletSnapshot>;
}

type IdentityRuntimeHostWindow = Window & {
  __identityRuntime?: IdentityRuntime;
};

class IdentityRuntimeController implements IdentityRuntime {
  private static readonly identityCacheStorageKey = 'identity-wallet-identities';
  private static readonly recoveryPhraseStorageKey = 'identity-wallet-recovery-phrase';

  private _auth?: AuthManager;
  private _authPromise?: Promise<AuthManager>;
  private _restoreAttempted = false;
  private _latestRecoveryPhrase?: string = this._loadStoredRecoveryPhrase();
  private _lastError?: string;
  private _localEndpoint?: string;
  private _localEndpointFetchedAt = 0;
  private _localEndpointProbePromise?: Promise<void>;
  private _listenerWired = false;
  private _cachedIdentities: ManagedIdentitySnapshot[] = this._loadCachedIdentities();

  async initialize(): Promise<IdentityWalletSnapshot> {
    const auth = await this._getAuth();
    if (!this._restoreAttempted) {
      this._restoreAttempted = true;
      if (!auth.isLocked) {
        try {
          await auth.restoreSession();
        } catch (error) {
          this._lastError = errorMessage(error);
        }
      } else {
        // Locked vault is an expected state reflected in UI controls; avoid noisy warnings.
        this._lastError = undefined;
      }
    }

    return this._refreshAndEmit();
  }

  async refresh(): Promise<IdentityWalletSnapshot> {
    return this._refreshAndEmit();
  }

  async connectLocal(options: {
    password?: string;
    name?: string;
    dwnEndpoints?: string[];
    recoveryPhrase?: string;
  } = {}): Promise<IdentityWalletSnapshot> {
    const auth = await this._getAuth();
    const dwnEndpoints = await this._resolvePreferredDwnEndpoints(options.dwnEndpoints);
    const session = await auth.connect({
      password       : options.password,
      recoveryPhrase : options.recoveryPhrase,
      dwnEndpoints,
      metadata       : { name: options.name?.trim() || 'Default' },
    });

    this._lastError = undefined;
    const recoveryPhrase = session.recoveryPhrase?.trim() || options.recoveryPhrase?.trim();
    if (recoveryPhrase) {
      this._setLatestRecoveryPhrase(recoveryPhrase);
    }
    return this._refreshAndEmit();
  }

  async createDid(options: {
    password?: string;
    name?: string;
    dwnEndpoints?: string[];
  } = {}): Promise<IdentityWalletSnapshot> {
    const auth = await this._getAuth();

    if (auth.state === 'uninitialized') {
      return this.connectLocal(options);
    }

    if (auth.isLocked) {
      if (!options.password) {
        throw new Error('A PIN or password is required to unlock the vault.');
      }

      await auth.agent.start({ password: options.password });
    } else if (!this._hasAgentDid()) {
      await auth.agent.start({ password: options.password ?? '' });
    }

    const dwnEndpoints = await this._resolvePreferredDwnEndpoints(options.dwnEndpoints);
    const identity = await auth.agent.identity.create({
      didMethod : 'dht',
      metadata  : { name: options.name?.trim() || 'Identity' },
      didOptions: {
        services: [
          {
            id              : 'dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : dwnEndpoints,
            enc             : '#enc',
            sig             : '#sig',
          }
        ],
        verificationMethods: [
          {
            algorithm : 'Ed25519',
            id        : 'sig',
            purposes  : ['assertionMethod', 'authentication'],
          },
          {
            algorithm : 'X25519',
            id        : 'enc',
            purposes  : ['keyAgreement'],
          },
        ],
      },
    });

    await auth.switchIdentity(identity.did.uri);
    this._lastError = undefined;
    return this._refreshAndEmit();
  }

  async importFromPhrase(options: {
    recoveryPhrase: string;
    password: string;
    dwnEndpoints?: string[];
  }): Promise<IdentityWalletSnapshot> {
    const auth = await this._getAuth();
    const dwnEndpoints = await this._resolvePreferredDwnEndpoints(options.dwnEndpoints);
    await auth.importFromPhrase({
      recoveryPhrase : options.recoveryPhrase.trim(),
      password       : options.password,
      dwnEndpoints,
    });

    this._lastError = undefined;
    this._setLatestRecoveryPhrase(options.recoveryPhrase);
    return this._refreshAndEmit();
  }

  async importFromPortable(options: {
    portableIdentity: PortableIdentity;
    password?: string;
    dwnEndpoints?: string[];
  }): Promise<IdentityWalletSnapshot> {
    const auth = await this._getAuth();
    const isFirstLaunch = await auth.agent.firstLaunch();
    await this._prepareAgentForPortableImport(options.password, options.dwnEndpoints);
    await auth.importFromPortable({
      portableIdentity: options.portableIdentity,
    });

    this._lastError = undefined;
    if (isFirstLaunch) {
      this._setLatestRecoveryPhrase(undefined);
    }
    return this._refreshAndEmit();
  }

  async switchDid(didUri: string): Promise<IdentityWalletSnapshot> {
    const auth = await this._getAuth();
    await this._ensureConnected();
    await auth.switchIdentity(didUri.trim());
    this._lastError = undefined;
    return this._refreshAndEmit();
  }

  async renameDid(options: {
    didUri: string;
    name: string;
    password?: string;
  }): Promise<IdentityWalletSnapshot> {
    const auth = await this._getAuth();
    await this._ensureAgentReady(options.password);
    await auth.agent.identity.setMetadataName({
      didUri : options.didUri.trim(),
      name   : options.name.trim(),
    });

    this._lastError = undefined;
    return this._refreshAndEmit();
  }

  async deleteDid(options: {
    didUri: string;
    password?: string;
  }): Promise<IdentityWalletSnapshot> {
    const auth = await this._getAuth();
    await this._ensureAgentReady(options.password);

    const didUri = options.didUri.trim();
    const targetIdentity = await auth.agent.identity.get({ didUri });
    const activeSession = auth.session;
    if (activeSession && targetIdentity) {
      const connectedTargetDid = targetIdentity.metadata.connectedDid ?? targetIdentity.did.uri;
      const deletingActiveIdentity =
        activeSession.did === connectedTargetDid ||
        activeSession.delegateDid === targetIdentity.did.uri ||
        activeSession.did === targetIdentity.did.uri;

      if (deletingActiveIdentity) {
        await auth.disconnect();
      }
    }

    await auth.deleteIdentity(didUri);

    const remaining = await auth.listIdentities();
    if (remaining.length > 0 && !auth.session && auth.state !== 'locked') {
      await auth.switchIdentity(remaining[0].didUri);
    }

    this._lastError = undefined;
    return this._refreshAndEmit();
  }

  async exportDid(didUri: string): Promise<ExportedIdentity> {
    const auth = await this._getAuth();
    await this._ensureAgentReady();
    const exported = await auth.exportIdentity(didUri.trim());
    const identities = await auth.listIdentities();
    const identity = identities.find(({ didUri: managedDidUri }) => managedDidUri === didUri.trim());

    return {
      didUri: didUri.trim(),
      name: identity?.name ?? 'Identity',
      portableIdentity: exported,
      json: JSON.stringify(exported, null, 2),
    };
  }

  async getDidDetails(didUri: string): Promise<IdentityDetails> {
    const auth = await this._getAuth();
    await this._ensureAgentReady();

    const snapshot = await this._buildSnapshot(auth);
    const identity = snapshot.identities.find((managedIdentity) => managedIdentity.didUri === didUri.trim());
    if (!identity) {
      throw new Error(`Identity not found: ${didUri}`);
    }

    const managedDidResolution = await this.resolveDid(identity.didUri);
    const connectedDidResolution = identity.connectedDid
      ? await this.resolveDid(identity.connectedDid)
      : undefined;

    const dwnEndpoints = await auth.agent.identity.getDwnEndpoints({ didUri: identity.didUri });
    const connectedTargetDid = identity.connectedDid ?? identity.didUri;
    const syncOptions = await auth.agent.sync.getIdentityOptions(connectedTargetDid);

    return {
      identity,
      managedDidResolution,
      connectedDidResolution,
      dwnEndpoints,
      syncOptions: (syncOptions as Record<string, unknown> | undefined),
    };
  }

  async resolveDid(didUri: string): Promise<DidResolutionLike> {
    const auth = await this._getAuth();
    await this._ensureAgentReady();
    try {
      const resolution = await auth.agent.did.resolve(didUri.trim());
      return {
        didDocument           : (resolution.didDocument as Record<string, unknown> | null) ?? null,
        didDocumentMetadata   : (resolution.didDocumentMetadata as Record<string, unknown>) ?? {},
        didResolutionMetadata : (resolution.didResolutionMetadata as Record<string, unknown>) ?? {},
      };
    } catch (error) {
      return createResolutionErrorResult(errorMessage(error));
    }
  }

  async setDidEndpoints(options: {
    didUri: string;
    endpoints: string[];
    password?: string;
  }): Promise<IdentityWalletSnapshot> {
    const auth = await this._getAuth();
    await this._ensureAgentReady(options.password);
    const endpoints = normalizeEndpointList(options.endpoints);
    if (endpoints.length === 0) {
      throw new Error('At least one DWN endpoint is required.');
    }

    await auth.agent.identity.setDwnEndpoints({
      didUri    : options.didUri.trim(),
      endpoints,
    });

    this._lastError = undefined;
    return this._refreshAndEmit();
  }

  async lock(): Promise<IdentityWalletSnapshot> {
    const auth = await this._getAuth();
    await auth.lock();
    this._lastError = undefined;
    return this._refreshAndEmit();
  }

  async unlock(password: string): Promise<IdentityWalletSnapshot> {
    const auth = await this._getAuth();
    const restored = await auth.restoreSession({ password });
    if (!restored) {
      await auth.connect({ password });
    }

    this._lastError = undefined;
    return this._refreshAndEmit();
  }

  async disconnect(clearStorage = false): Promise<IdentityWalletSnapshot> {
    const auth = await this._getAuth();
    await auth.disconnect({ clearStorage });
    if (clearStorage) {
      this._setLatestRecoveryPhrase(undefined);
    }
    this._lastError = undefined;
    return this._refreshAndEmit();
  }

  async clearRecoveryPhrase(): Promise<IdentityWalletSnapshot> {
    this._setLatestRecoveryPhrase(undefined);
    return this._refreshAndEmit();
  }

  private async _getAuth(): Promise<AuthManager> {
    if (this._auth) {
      return this._auth;
    }

    if (!this._authPromise) {
      this._authPromise = AuthManager.create({
        sync             : '15s',
        localDwnStrategy : 'prefer',
      }).then((auth) => {
        this._auth = auth;
        this._wireAuthListeners(auth);
        return auth;
      });
    }

    return this._authPromise;
  }

  private _wireAuthListeners(auth: AuthManager): void {
    if (this._listenerWired) {
      return;
    }

    this._listenerWired = true;
    const observedEvents = [
      'state-change',
      'session-start',
      'session-end',
      'identity-added',
      'identity-removed',
      'vault-locked',
      'vault-unlocked',
      'local-dwn-available',
      'local-dwn-unavailable',
    ] as const;

    for (const eventName of observedEvents) {
      auth.on(eventName, () => {
        void this._refreshAndEmit();
      });
    }
  }

  private async _refreshAndEmit(): Promise<IdentityWalletSnapshot> {
    const auth = await this._getAuth();
    const appStore = getAppStore();

    try {
      const snapshot = await this._buildSnapshot(auth);
      appStore.identity.setSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      this._lastError = errorMessage(error);
      const fallbackSnapshot = await this._buildFallbackSnapshot(auth);
      appStore.identity.setSnapshot(fallbackSnapshot);
      return fallbackSnapshot;
    }
  }

  private async _buildSnapshot(auth: AuthManager): Promise<IdentityWalletSnapshot> {
    const activeSession = auth.session;

    let mappedIdentities = this._cachedIdentities;
    if (this._hasAgentDid()) {
      const identities = await auth.listIdentities();
      mappedIdentities = identities.map((identity): ManagedIdentitySnapshot => {
        const connectedTargetDid = identity.connectedDid ?? identity.didUri;
        const active = activeSession
          ? activeSession.did === connectedTargetDid || activeSession.delegateDid === identity.didUri
          : false;

        return {
          ...identity,
          active,
          connectedTargetDid,
          kind: identity.connectedDid ? 'delegated' : 'local',
        };
      });

      this._cachedIdentities = mappedIdentities;
      this._persistCachedIdentities(mappedIdentities);
    } else {
      mappedIdentities = mappedIdentities.map((identity) => ({
        ...identity,
        active: false,
      }));
    }

    const activeManagedIdentity = mappedIdentities.find((identity) => identity.active);

    const localDwnEndpoint = await this._readLocalDwnEndpointForSnapshot();
    return {
      authState: auth.state,
      isConnected: auth.isConnected,
      isLocked: auth.isLocked,
      isConnecting: auth.isConnecting,
      activeDid: activeSession?.did,
      delegateDid: activeSession?.delegateDid,
      activeManagedDidUri: activeManagedIdentity?.didUri,
      identities: mappedIdentities,
      latestRecoveryPhrase: this._latestRecoveryPhrase,
      localDwnEndpoint,
      lastError: this._lastError,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  private async _buildFallbackSnapshot(auth: AuthManager): Promise<IdentityWalletSnapshot> {
    const localDwnEndpoint = await this._readLocalDwnEndpointForSnapshot();
    return {
      authState: auth.state,
      isConnected: auth.isConnected,
      isLocked: auth.isLocked,
      isConnecting: auth.isConnecting,
      activeDid: auth.session?.did,
      delegateDid: auth.session?.delegateDid,
      activeManagedDidUri: undefined,
      identities: this._cachedIdentities.map((identity) => ({
        ...identity,
        active: false,
      })),
      latestRecoveryPhrase: this._latestRecoveryPhrase,
      localDwnEndpoint,
      lastError: this._lastError,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  private async _readLocalDwnEndpoint(): Promise<string | undefined> {
    const now = Date.now();
    if (now - this._localEndpointFetchedAt < localEndpointCacheMs) {
      return this._localEndpoint;
    }

    this._localEndpointFetchedAt = now;
    const auth = await this._getAuth();
    this._localEndpoint = auth.localDwnEndpoint;

    return this._localEndpoint;
  }

  private async _readLocalDwnEndpointForSnapshot(): Promise<string | undefined> {
    const now = Date.now();
    if (now - this._localEndpointFetchedAt < localEndpointCacheMs) {
      return this._localEndpoint;
    }

    if (!this._localEndpointProbePromise) {
      this._localEndpointFetchedAt = now;
      this._localEndpointProbePromise = (async () => {
        try {
          const auth = await this._getAuth();
          this._localEndpoint = auth.localDwnEndpoint;
        } finally {
          this._localEndpointFetchedAt = Date.now();
          this._localEndpointProbePromise = undefined;
          void this._refreshAndEmit();
        }
      })();
    }

    return this._localEndpoint;
  }

  private async _resolvePreferredDwnEndpoints(preferred?: string[]): Promise<string[]> {
    const normalizedPreferred = normalizeEndpointList(preferred);
    if (normalizedPreferred.length > 0) {
      return normalizedPreferred;
    }

    const localEndpoint = await this._readLocalDwnEndpoint();
    if (localEndpoint) {
      return [localEndpoint];
    }

    const auth = await this._getAuth();
    const sessionDid = auth.session?.did;
    if (sessionDid) {
      try {
        const endpoints = await auth.agent.dwn.getDwnEndpointUrlsForTarget(sessionDid);
        const normalizedSessionEndpoints = normalizeEndpointList(endpoints);
        if (normalizedSessionEndpoints.length > 0) {
          return normalizedSessionEndpoints;
        }
      } catch {
        // Fall through to default endpoint.
      }
    }

    return [defaultDwnEndpoint];
  }

  private async _ensureConnected(password?: string): Promise<void> {
    const auth = await this._getAuth();
    if (auth.session) {
      return;
    }

    if (auth.isLocked && !password) {
      throw new Error('Vault is locked. Unlock with your PIN or password first.');
    }

    const restored = await auth.restoreSession({ password });
    if (!restored) {
      await auth.connect({ password });
    }
  }

  private async _ensureAgentReady(password?: string): Promise<void> {
    const auth = await this._getAuth();
    if (auth.state === 'uninitialized') {
      throw new Error('Initialize a local DID first before managing identities.');
    }

    if (auth.isLocked) {
      if (!password) {
        throw new Error('A PIN or password is required to unlock the vault.');
      }
      const restored = await auth.restoreSession({ password });
      if (!restored) {
        await auth.connect({ password });
      }
    } else if (!this._hasAgentDid()) {
      if (!password) {
        throw new Error('A PIN or password is required to unlock the vault.');
      }
      await auth.agent.start({ password });
    }
  }

  private async _prepareAgentForPortableImport(password?: string, dwnEndpoints?: string[]): Promise<void> {
    const auth = await this._getAuth();
    const agent = auth.agent;
    const isFirstLaunch = await agent.firstLaunch();
    if (isFirstLaunch) {
      if (!password) {
        throw new Error('A PIN or password is required before importing a portable DID.');
      }

      const preferredEndpoints = await this._resolvePreferredDwnEndpoints(dwnEndpoints);
      await agent.initialize({
        password,
        dwnEndpoints: preferredEndpoints,
      });
      await agent.start({ password });
      return;
    }

    if (agent.vault.isLocked()) {
      if (!password) {
        throw new Error('A PIN or password is required to unlock the vault before importing.');
      }
      await agent.start({ password });
      return;
    }

    if (!this._hasAgentDid()) {
      if (!password) {
        throw new Error('A PIN or password is required to unlock the vault before importing.');
      }
      await agent.start({ password });
    }
  }

  private _hasAgentDid(): boolean {
    if (!this._auth) {
      return false;
    }

    try {
      void this._auth.agent.agentDid.uri;
      return true;
    } catch {
      return false;
    }
  }

  private _setLatestRecoveryPhrase(recoveryPhrase?: string): void {
    const normalizedRecoveryPhrase = typeof recoveryPhrase === 'string'
      ? recoveryPhrase.trim()
      : '';

    if (!normalizedRecoveryPhrase) {
      this._latestRecoveryPhrase = undefined;
      this._persistRecoveryPhrase(undefined);
      return;
    }

    this._latestRecoveryPhrase = normalizedRecoveryPhrase;
    this._persistRecoveryPhrase(normalizedRecoveryPhrase);
  }

  private _persistRecoveryPhrase(recoveryPhrase?: string): void {
    if (typeof globalThis.localStorage === 'undefined') {
      return;
    }

    try {
      if (!recoveryPhrase) {
        globalThis.localStorage.removeItem(IdentityRuntimeController.recoveryPhraseStorageKey);
        return;
      }

      globalThis.localStorage.setItem(
        IdentityRuntimeController.recoveryPhraseStorageKey,
        recoveryPhrase,
      );
    } catch {
      // Best-effort persistence only.
    }
  }

  private _loadStoredRecoveryPhrase(): string | undefined {
    if (typeof globalThis.localStorage === 'undefined') {
      return undefined;
    }

    try {
      const rawValue = globalThis.localStorage.getItem(IdentityRuntimeController.recoveryPhraseStorageKey);
      const normalizedValue = rawValue?.trim() ?? '';
      return normalizedValue.length > 0 ? normalizedValue : undefined;
    } catch {
      return undefined;
    }
  }

  private _persistCachedIdentities(identities: ManagedIdentitySnapshot[]): void {
    if (typeof globalThis.localStorage === 'undefined') {
      return;
    }

    try {
      globalThis.localStorage.setItem(
        IdentityRuntimeController.identityCacheStorageKey,
        JSON.stringify(identities),
      );
    } catch {
      // Best-effort cache persistence only.
    }
  }

  private _loadCachedIdentities(): ManagedIdentitySnapshot[] {
    if (typeof globalThis.localStorage === 'undefined') {
      return [];
    }

    try {
      const raw = globalThis.localStorage.getItem(IdentityRuntimeController.identityCacheStorageKey);
      if (!raw) {
        return [];
      }

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter((entry): entry is ManagedIdentitySnapshot =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as { didUri?: unknown }).didUri === 'string' &&
          typeof (entry as { name?: unknown }).name === 'string' &&
          typeof (entry as { connectedTargetDid?: unknown }).connectedTargetDid === 'string' &&
          typeof (entry as { kind?: unknown }).kind === 'string' &&
          typeof (entry as { active?: unknown }).active === 'boolean',
        )
        .map((entry) => ({
          ...entry,
          kind: entry.kind === 'delegated' ? 'delegated' : 'local',
        }));
    } catch {
      return [];
    }
  }
}

export function ensureIdentityRuntime(runtimeWindow: IdentityRuntimeHostWindow): IdentityRuntime {
  if (!runtimeWindow[identityRuntimeWindowKey]) {
    runtimeWindow[identityRuntimeWindowKey] = new IdentityRuntimeController();
  }

  return runtimeWindow[identityRuntimeWindowKey]!;
}

function normalizeEndpointList(endpoints?: string[]): string[] {
  if (!Array.isArray(endpoints)) {
    return [];
  }

  return Array.from(
    new Set(
      endpoints
        .map((endpoint) => endpoint.trim())
        .filter((endpoint) => endpoint.length > 0),
    ),
  );
}

function createResolutionErrorResult(message: string): DidResolutionLike {
  return {
    didDocument: null,
    didDocumentMetadata: {},
    didResolutionMetadata: {
      error: 'resolutionError',
      message,
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
