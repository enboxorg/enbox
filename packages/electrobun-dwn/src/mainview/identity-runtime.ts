import type { DidResolutionLike } from './utils/identity-helpers.js';
import type { ProfileSchemaMap } from '@enbox/protocols';
import type { Repository } from '@enbox/api';
import type { AuthState, IdentityInfo, PortableIdentity } from '@enbox/auth';

import { AuthManager } from '@enbox/auth';
import { DwnApi } from '@enbox/api/advanced';
import { ProfileDefinition, ProfileProtocol, SocialGraphDefinition } from '@enbox/protocols';
import { repository, TypedEnbox } from '@enbox/api';

import { getAppStore } from './state/app-store.js';
import { createResolutionErrorResult, errorMessage, normalizeEndpointList, normalizeOptionalString } from './utils/identity-helpers.js';

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

export type ProtocolDefinitionLike = {
  protocol: string;
  [key: string]: unknown;
};

export type InstalledProtocolsSnapshot = {
  did: string;
  protocols: string[];
};

export type EnsureProtocolInstalledResult = {
  did: string;
  protocol: string;
  alreadyInstalled: boolean;
  status: {
    code: number;
    detail: string;
    [key: string]: unknown;
  };
};

export type EditableProfileImageSnapshot = {
  recordId: string;
  blob: Blob;
  dataFormat?: string;
};

export type EditableProfileLinkSnapshot = {
  id: string;
  title: string;
  url: string;
  icon?: string;
  sortOrder?: number;
};

export type EditableDidProfileSnapshot = {
  did: string;
  profile: {
    displayName: string;
    bio?: string;
    tagline?: string;
    location?: string;
    website?: string;
    pronouns?: string;
  };
  avatar?: EditableProfileImageSnapshot;
  hero?: EditableProfileImageSnapshot;
  links: EditableProfileLinkSnapshot[];
};

export type EditableDidProfileInput = {
  didUri: string;
  profile: {
    displayName: string;
    bio?: string;
    tagline?: string;
    location?: string;
    website?: string;
    pronouns?: string;
  };
  avatar?: {
    mode: 'keep' | 'replace' | 'remove';
    file?: Blob;
  };
  hero?: {
    mode: 'keep' | 'replace' | 'remove';
    file?: Blob;
  };
  links: Array<{
    id?: string;
    title: string;
    url: string;
    icon?: string;
    sortOrder?: number;
  }>;
};

export type SaveDidProfileResult = {
  did: string;
  status: {
    code: number;
    detail: string;
    [key: string]: unknown;
  };
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
  listInstalledProtocols(): Promise<InstalledProtocolsSnapshot>;
  ensureProtocolInstalled(definition: ProtocolDefinitionLike): Promise<EnsureProtocolInstalledResult>;
  getDidProfile(didUri: string): Promise<EditableDidProfileSnapshot>;
  saveDidProfile(input: EditableDidProfileInput): Promise<SaveDidProfileResult>;
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
      didMethod  : 'dht',
      metadata   : { name: options.name?.trim() || 'Identity' },
      didOptions : {
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
      didUri           : didUri.trim(),
      name             : identity?.name ?? 'Identity',
      portableIdentity : exported,
      json             : JSON.stringify(exported, null, 2),
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
      didUri: options.didUri.trim(),
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

  async listInstalledProtocols(): Promise<InstalledProtocolsSnapshot> {
    const { did, dwn } = await this._createConnectedDwnApi();
    const response = await dwn.protocols.query({});

    if (response.status.code >= 300) {
      throw new Error(response.status.detail || `Failed to query installed protocols (${response.status.code}).`);
    }

    const protocols = Array.from(
      new Set(
        response.protocols
          .map((protocol) => protocol.definition?.protocol)
          .filter((protocolUri): protocolUri is string => typeof protocolUri === 'string' && protocolUri.trim().length > 0)
          .map((protocolUri) => protocolUri.trim()),
      ),
    );

    return { did, protocols };
  }

  async ensureProtocolInstalled(definition: ProtocolDefinitionLike): Promise<EnsureProtocolInstalledResult> {
    const protocolUri = typeof definition?.protocol === 'string'
      ? definition.protocol.trim()
      : '';

    if (!protocolUri) {
      throw new Error('Protocol definition is missing a protocol URI.');
    }

    const { did, dwn } = await this._createConnectedDwnApi();
    const queryResponse = await dwn.protocols.query({
      filter: { protocol: protocolUri },
    });

    if (queryResponse.status.code >= 300) {
      throw new Error(queryResponse.status.detail || `Failed to check protocol installation (${queryResponse.status.code}).`);
    }

    if (queryResponse.protocols.length > 0) {
      return {
        did,
        protocol         : protocolUri,
        alreadyInstalled : true,
        status           : { code: 200, detail: 'Already installed' },
      };
    }

    const configureResponse = await dwn.protocols.configure({ definition });
    if (configureResponse.status.code >= 300) {
      throw new Error(configureResponse.status.detail || `Failed to install protocol (${configureResponse.status.code}).`);
    }

    return {
      did,
      protocol         : protocolUri,
      alreadyInstalled : false,
      status           : configureResponse.status,
    };
  }

  async getDidProfile(didUri: string): Promise<EditableDidProfileSnapshot> {
    const normalizedDidUri = didUri.trim();
    if (!normalizedDidUri) {
      throw new Error('A DID is required to load a profile.');
    }

    const { dwn } = await this._createDwnApiForDid(normalizedDidUri);
    const installedResponse = await dwn.protocols.query({
      filter: { protocol: ProfileDefinition.protocol },
    });

    if (installedResponse.status.code >= 300) {
      throw new Error(installedResponse.status.detail || `Failed to check profile protocol installation (${installedResponse.status.code}).`);
    }

    if (installedResponse.protocols.length === 0) {
      return {
        did     : normalizedDidUri,
        profile : { displayName: '' },
        links   : [],
      };
    }

    const profileRepo = this._createProfileRepository(dwn);
    const profileRecord = await profileRepo.profile.get();
    if (!profileRecord) {
      return {
        did     : normalizedDidUri,
        profile : { displayName: '' },
        links   : [],
      };
    }

    const profileData = await profileRecord.data.json<EditableDidProfileSnapshot['profile']>();
    const profileContextId = profileRecord.contextId;
    const avatarRecord = profileContextId ? await profileRepo.profile.avatar.get(profileContextId) : undefined;
    const heroRecord = profileContextId ? await profileRepo.profile.hero.get(profileContextId) : undefined;
    const linkResult = profileContextId ? await profileRepo.profile.link.query(profileContextId) : { records: [] };

    const links = await Promise.all(
      linkResult.records.map(async (record) => {
        const data = await record.data.json<{
          url: string;
          title: string;
          icon?: string;
          sortOrder?: number;
        }>();

        return {
          id        : record.id,
          title     : data.title ?? '',
          url       : data.url ?? '',
          icon      : normalizeOptionalString(data.icon),
          sortOrder : typeof data.sortOrder === 'number' && Number.isFinite(data.sortOrder)
            ? data.sortOrder
            : undefined,
        } satisfies EditableProfileLinkSnapshot;
      }),
    );

    links.sort((left, right) => {
      const leftOrder = typeof left.sortOrder === 'number' ? left.sortOrder : Number.MAX_SAFE_INTEGER;
      const rightOrder = typeof right.sortOrder === 'number' ? right.sortOrder : Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }

      return left.title.localeCompare(right.title);
    });

    return {
      did     : normalizedDidUri,
      profile : {
        displayName : profileData.displayName ?? '',
        bio         : normalizeOptionalString(profileData.bio),
        tagline     : normalizeOptionalString(profileData.tagline),
        location    : normalizeOptionalString(profileData.location),
        website     : normalizeOptionalString(profileData.website),
        pronouns    : normalizeOptionalString(profileData.pronouns),
      },
      avatar: avatarRecord
        ? {
          recordId   : avatarRecord.id,
          blob       : await avatarRecord.data.blob(),
          dataFormat : avatarRecord.dataFormat,
        }
        : undefined,
      hero: heroRecord
        ? {
          recordId   : heroRecord.id,
          blob       : await heroRecord.data.blob(),
          dataFormat : heroRecord.dataFormat,
        }
        : undefined,
      links,
    };
  }

  async saveDidProfile(input: EditableDidProfileInput): Promise<SaveDidProfileResult> {
    const normalizedDidUri = input.didUri.trim();
    if (!normalizedDidUri) {
      throw new Error('A DID is required to save a profile.');
    }

    const profileData = {
      displayName: input.profile.displayName.trim(),
      ...(normalizeOptionalString(input.profile.bio) ? { bio: normalizeOptionalString(input.profile.bio) } : {}),
      ...(normalizeOptionalString(input.profile.tagline) ? { tagline: normalizeOptionalString(input.profile.tagline) } : {}),
      ...(normalizeOptionalString(input.profile.location) ? { location: normalizeOptionalString(input.profile.location) } : {}),
      ...(normalizeOptionalString(input.profile.website) ? { website: normalizeOptionalString(input.profile.website) } : {}),
      ...(normalizeOptionalString(input.profile.pronouns) ? { pronouns: normalizeOptionalString(input.profile.pronouns) } : {}),
    };

    if (!profileData.displayName) {
      throw new Error('Display name is required.');
    }

    await this._ensureProtocolInstalledForDid(normalizedDidUri, SocialGraphDefinition);
    await this._ensureProtocolInstalledForDid(normalizedDidUri, ProfileDefinition);

    const { dwn } = await this._createDwnApiForDid(normalizedDidUri);
    const typed = new TypedEnbox(dwn, ProfileProtocol);
    const profileRepo = repository(typed);

    const profileResult = await profileRepo.profile.set({ data: profileData });
    if (profileResult.status.code >= 300 || !profileResult.record?.contextId) {
      throw new Error(profileResult.status.detail || `Failed to save profile (${profileResult.status.code}).`);
    }

    const profileContextId = profileResult.record.contextId;
    const { records: avatarRecords } = await typed.records.query('profile/avatar', {
      filter: { contextId: profileContextId },
    });
    const { records: heroRecords } = await typed.records.query('profile/hero', {
      filter: { contextId: profileContextId },
    });
    const existingAvatar = avatarRecords[0];
    const existingHero = heroRecords[0];

    await this._saveProfileImageRecord({
      action          : input.avatar?.mode ?? 'keep',
      file            : input.avatar?.file,
      existingRecord  : existingAvatar,
      parentContextId : profileContextId,
      typed,
      path            : 'profile/avatar',
    });
    await this._saveProfileImageRecord({
      action          : input.hero?.mode ?? 'keep',
      file            : input.hero?.file,
      existingRecord  : existingHero,
      parentContextId : profileContextId,
      typed,
      path            : 'profile/hero',
    });

    const { records: existingLinks } = await typed.records.query('profile/link', {
      filter: { contextId: profileContextId },
    });
    const existingLinksById = new Map(existingLinks.map((record) => [record.id, record]));
    const retainedLinkIds = new Set<string>();

    for (const rawLink of input.links) {
      const title = rawLink.title.trim();
      const url = rawLink.url.trim();
      const icon = normalizeOptionalString(rawLink.icon);
      const sortOrder = typeof rawLink.sortOrder === 'number' && Number.isFinite(rawLink.sortOrder)
        ? rawLink.sortOrder
        : undefined;

      if (!title && !url && !icon && sortOrder === undefined) {
        continue;
      }

      if (!title || !url) {
        throw new Error('Each link must include both a title and a URL.');
      }

      const linkData = {
        title,
        url,
        ...(icon ? { icon } : {}),
        ...(sortOrder !== undefined ? { sortOrder } : {}),
      };

      const existingRecord = rawLink.id ? existingLinksById.get(rawLink.id) : undefined;
      if (existingRecord) {
        const updateResult = await existingRecord.update({ data: linkData });
        if (updateResult.status.code >= 300) {
          throw new Error(updateResult.status.detail || `Failed to update link (${updateResult.status.code}).`);
        }

        retainedLinkIds.add(existingRecord.id);
        continue;
      }

      const createResult = await profileRepo.profile.link.create(profileContextId, {
        data: linkData,
      });
      if (createResult.status.code >= 300 || !createResult.record) {
        throw new Error(createResult.status.detail || `Failed to create link (${createResult.status.code}).`);
      }

      retainedLinkIds.add(createResult.record.id);
    }

    for (const existingRecord of existingLinks) {
      if (retainedLinkIds.has(existingRecord.id)) {
        continue;
      }

      const deleteResult = await existingRecord.delete();
      if (deleteResult.status.code >= 300) {
        throw new Error(deleteResult.status.detail || `Failed to delete link (${deleteResult.status.code}).`);
      }
    }

    return {
      did    : normalizedDidUri,
      status : { code: 200, detail: 'Profile saved' },
    };
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
      authState            : auth.state,
      isConnected          : auth.isConnected,
      isLocked             : auth.isLocked,
      isConnecting         : auth.isConnecting,
      activeDid            : activeSession?.did,
      delegateDid          : activeSession?.delegateDid,
      activeManagedDidUri  : activeManagedIdentity?.didUri,
      identities           : mappedIdentities,
      latestRecoveryPhrase : this._latestRecoveryPhrase,
      localDwnEndpoint,
      lastError            : this._lastError,
      lastUpdatedAt        : new Date().toISOString(),
    };
  }

  private async _buildFallbackSnapshot(auth: AuthManager): Promise<IdentityWalletSnapshot> {
    const localDwnEndpoint = await this._readLocalDwnEndpointForSnapshot();
    return {
      authState           : auth.state,
      isConnected         : auth.isConnected,
      isLocked            : auth.isLocked,
      isConnecting        : auth.isConnecting,
      activeDid           : auth.session?.did,
      delegateDid         : auth.session?.delegateDid,
      activeManagedDidUri : undefined,
      identities          : this._cachedIdentities.map((identity) => ({
        ...identity,
        active: false,
      })),
      latestRecoveryPhrase : this._latestRecoveryPhrase,
      localDwnEndpoint,
      lastError            : this._lastError,
      lastUpdatedAt        : new Date().toISOString(),
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
      this._localEndpointProbePromise = (async (): Promise<void> => {
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

  private async _createConnectedDwnApi(): Promise<{ did: string; dwn: DwnApi }> {
    const auth = await this._getAuth();
    await this._ensureConnected();

    const session = auth.session;
    if (!session) {
      throw new Error('No active DID session is available.');
    }

    return {
      did : session.did,
      dwn : new DwnApi({
        agent        : session.agent,
        connectedDid : session.did,
        delegateDid  : session.delegateDid,
      }),
    };
  }

  private async _createDwnApiForDid(didUri: string): Promise<{ did: string; dwn: DwnApi }> {
    const auth = await this._getAuth();
    await this._ensureConnected();

    const session = auth.session;
    if (!session) {
      throw new Error('No active DID session is available.');
    }

    return {
      did : didUri,
      dwn : new DwnApi({
        agent        : session.agent,
        connectedDid : didUri,
      }),
    };
  }

  private async _ensureProtocolInstalledForDid(didUri: string, definition: ProtocolDefinitionLike): Promise<void> {
    const protocolUri = typeof definition?.protocol === 'string'
      ? definition.protocol.trim()
      : '';

    if (!protocolUri) {
      throw new Error('Protocol definition is missing a protocol URI.');
    }

    const { dwn } = await this._createDwnApiForDid(didUri);
    const queryResponse = await dwn.protocols.query({
      filter: { protocol: protocolUri },
    });

    if (queryResponse.status.code >= 300) {
      throw new Error(queryResponse.status.detail || `Failed to check protocol installation (${queryResponse.status.code}).`);
    }

    if (queryResponse.protocols.length > 0) {
      return;
    }

    const configureResponse = await dwn.protocols.configure({ definition });
    if (configureResponse.status.code >= 300) {
      throw new Error(configureResponse.status.detail || `Failed to install protocol (${configureResponse.status.code}).`);
    }
  }

  private _createProfileRepository(dwn: DwnApi): Repository<typeof ProfileDefinition, ProfileSchemaMap> {
    return repository(new TypedEnbox(dwn, ProfileProtocol));
  }

  private async _saveProfileImageRecord({
    action,
    file,
    existingRecord,
    parentContextId,
    typed,
    path,
  }: {
    action: 'keep' | 'replace' | 'remove';
    file?: Blob;
    existingRecord?: {
      id: string;
      dataFormat?: string;
      update: (options: { data: Blob; dataFormat?: string }) => Promise<{ status: { code: number; detail: string } }>;
      delete: () => Promise<{ status: { code: number; detail: string } }>;
    };
    parentContextId: string;
    typed: TypedEnbox<typeof ProfileDefinition, Record<string, unknown>>;
    path: 'profile/avatar' | 'profile/hero';
  }): Promise<void> {
    if (action === 'keep') {
      return;
    }

    if (action === 'remove') {
      if (!existingRecord) {
        return;
      }

      const deleteResult = await existingRecord.delete();
      if (deleteResult.status.code >= 300) {
        throw new Error(deleteResult.status.detail || `Failed to remove ${path} image (${deleteResult.status.code}).`);
      }
      return;
    }

    if (!file) {
      return;
    }

    const normalizedFile = await this._materializeBlob(file);
    const dataFormat = normalizedFile.type || existingRecord?.dataFormat || undefined;
    if (existingRecord) {
      const updateResult = await existingRecord.update({ data: normalizedFile, dataFormat });
      if (updateResult.status.code >= 300) {
        throw new Error(updateResult.status.detail || `Failed to update ${path} image (${updateResult.status.code}).`);
      }
      return;
    }

    const createResult = await typed.records.create(path, {
      data: normalizedFile,
      parentContextId,
      dataFormat,
    });
    if (createResult.status.code >= 300) {
      throw new Error(createResult.status.detail || `Failed to create ${path} image (${createResult.status.code}).`);
    }
  }

  private async _materializeBlob(blob: Blob): Promise<Blob> {
    const bytes = await blob.arrayBuffer();
    return new Blob([bytes], { type: blob.type });
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

  /**
   * Persists the recovery phrase to localStorage so it survives page reloads
   * during the initial setup flow (e.g. the user copies it before confirming).
   * This is intentional for the desktop Electrobun context where localStorage
   * is not shared with other origins. The phrase is cleared explicitly via
   * `clearRecoveryPhrase()` once the user has acknowledged it, or on
   * `disconnect({ clearStorage: true })`.
   */
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

