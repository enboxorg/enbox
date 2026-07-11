import type { AgentKeyManager } from './types/key-manager.js';
import type { BearerDid } from '@enbox/dids';
import type { EnboxPlatformAgent } from './types/agent.js';
import type { EnboxRpc } from '@enbox/dwn-clients';
import type { LocalDwnStrategy } from './local-dwn.js';
import type { ProgressToken } from '@enbox/dwn-sdk-js';
import type { SecretStore } from './secret-store.js';
import type { DidInterface, DidRequest, DidResponse } from './did-api.js';
import type { DwnInterface, DwnResponse, ProcessDwnRequest, SendDwnRequest } from './types/dwn.js';
import type { ProcessVcRequest, SendVcRequest, VcResponse } from './types/vc.js';
import type { SyncEjectionSnapshot, SyncEngine, SyncScope } from './types/sync.js';

import { AgentCryptoApi } from './crypto-api.js';
import { AgentDidApi } from './did-api.js';
import { AgentDwnApi } from './dwn-api.js';
import { AgentIdentityApi } from './identity-api.js';
import { AgentPermissionsApi } from './permissions-api.js';
import { DEFAULT_LOCAL_DWN_STRATEGY } from './local-dwn.js';
import { DwnDidStore } from './store-did.js';
import { DwnIdentityStore } from './store-identity.js';
import { DwnKeyStore } from './store-key.js';
import { EnboxRpcClient } from '@enbox/dwn-clients';
import { HdIdentityVault } from './hd-identity-vault.js';
import { lexicographicalCompare } from './types/sync.js';
import { LocalKeyManager } from './local-key-manager.js';
import { Replication } from '@enbox/dwn-sdk-js';
import { DidDht, DidJwk } from '@enbox/dids';
import { InMemorySecretStore, VaultBackedSecretStore } from './secret-store.js';

/**
 * Initialization parameters for {@link EnboxUserAgent}, including an optional recovery phrase that
 * can be used to derive keys to encrypt the vault and generate a DID.
 */
export type AgentInitializeParams = {
  /**
    * The password used to secure the Agent vault.
    *
    * The password selected should be strong and securely managed to prevent unauthorized access.
    */
   password: string;

  /**
   * An optional recovery phrase used to deterministically generate the cryptographic keys for the
   * Agent vault.
   *
   * Supplying this phrase enables the vault's contents to be restored or replicated across devices.
   * If omitted, a new phrase is generated, which should be securely recorded for future recovery needs.
   */
   recoveryPhrase?: string;

  /**
   * Optional dwnEndpoints to register didService endpoints during EnboxUserAgent initialization
   *
   * The dwnEndpoints are used to register DWN endpoints against the agent DID created during
   * EnboxUserAgent.initialize() =>  DidDht.create(). This allows the
   * agent to properly recover connectedDids from DWN. Also, this pattern can be used on the server
   * side in place of the agentDid-->connectedDids pattern.
   */
   dwnEndpoints?: string[];
 };

export type AgentStartParams = {
  /**
   * The password used to unlock the previously initialized Agent vault.
   */
  password: string;
 };

export type AgentParams<TKeyManager extends AgentKeyManager = LocalKeyManager> = {
  /** Optional. The Decentralized Identifier (DID) representing this Enbox User Agent. */
  agentDid?: BearerDid;
  /** Encrypted vault used for managing the Agent's DID and associated keys. */
  agentVault: HdIdentityVault;
  /** Provides cryptographic capabilties like signing, encryption, hashing and key derivation. */
  cryptoApi: AgentCryptoApi;
  /** Specifies the local path to be used by the Agent's persistent data stores. */
  dataPath?: string;
  /** Facilitates DID operations including create, update, and resolve. */
  didApi: AgentDidApi<TKeyManager>;
  /** Facilitates DWN operations including processing and sending requests. */
  dwnApi: AgentDwnApi;
  /** Facilitates decentralized Identity operations including create, import, and export. */
  identityApi: AgentIdentityApi<TKeyManager>;
  /** Responsible for securely managing the cryptographic keys of the agent. */
  keyManager: TKeyManager;
  /** Facilitates fetching, requesting, creating, revoking and validating revocation status of permissions */
  permissionsApi: AgentPermissionsApi;
  /** Remote procedure call (RPC) client used to communicate with other Enbox services. */
  rpcClient: EnboxRpc;
  /** Vault-backed secret store for classified credentials. */
  secretsApi?: SecretStore;
  /** Facilitates data synchronization of DWN records between nodes. */
  syncApi: SyncEngine;
};

export type CreateUserAgentParams = Partial<AgentParams> & {
  localDwnStrategy?: LocalDwnStrategy;

  /**
   * When set, the agent operates in "remote mode": no in-process DWN is
   * created. All `processRequest()` calls are routed through RPC to
   * this endpoint instead.
   *
   * Typically set by `AuthManager.create()` after standalone discovery
   * determines that a local DWN server is running.
   */
  localDwnEndpoint?: string;
};

export type LocalReplicaDrainTargetProof = {
  tenantDid: string;
  scope: SyncScope;
  pushCheckpoint?: ProgressToken;
  localFingerprint: string;
  remoteFingerprint: string;
};

export type LocalReplicaDrainProof = SyncEjectionSnapshot & {
  targets: [LocalReplicaDrainTargetProof, ...LocalReplicaDrainTargetProof[]];
};

export type LocalReplicaDrainInspectionResult =
  | { valid: true }
  | { valid: false; reason: string };

export type InspectLocalReplicaDrainProofOptions = {
  dataPath?: string;
  proof: LocalReplicaDrainProof;
};

type ClosableStore = {
  close(): Promise<void>;
};

class LocalReplicaDrainProofMismatch extends Error { }

export class EnboxUserAgent<TKeyManager extends AgentKeyManager = LocalKeyManager> implements EnboxPlatformAgent<TKeyManager> {
  public crypto: AgentCryptoApi;
  public did: AgentDidApi<TKeyManager>;
  public dwn: AgentDwnApi;
  public identity: AgentIdentityApi<TKeyManager>;
  public keyManager: TKeyManager;
  public permissions: AgentPermissionsApi;
  public rpc: EnboxRpc;
  public secrets: SecretStore;
  public sync: SyncEngine;
  public vault: HdIdentityVault;

  private _agentDid?: BearerDid;

  constructor(params: AgentParams<TKeyManager>) {
    this._agentDid = params.agentDid;
    this.crypto = params.cryptoApi;
    this.did = params.didApi;
    this.dwn = params.dwnApi;
    this.identity = params.identityApi;
    this.keyManager = params.keyManager;
    this.permissions = params.permissionsApi;
    this.rpc = params.rpcClient;
    this.secrets = params.secretsApi ?? new InMemorySecretStore();
    this.sync = params.syncApi;
    this.vault = params.agentVault;

    // Set this agent to be the default agent.
    this.did.agent = this;
    this.dwn.agent = this;
    this.identity.agent = this;
    this.keyManager.agent = this;
    this.permissions.agent = this;
    this.sync.agent = this;
  }

  get agentDid(): BearerDid {
    if (this._agentDid === undefined) {
      throw new Error(
        'EnboxUserAgent: The "agentDid" property is not set. Ensure the agent is properly ' +
        'initialized and a DID is assigned.'
      );
    }
    return this._agentDid;
  }

  set agentDid(did: BearerDid) {
    this._agentDid = did;
  }

  /**
   * If any of the required agent components are not provided, instantiate default implementations.
   */
  public static async create({
    dataPath = 'DATA/AGENT',
    localDwnStrategy,
    localDwnEndpoint,
    agentDid, agentVault, cryptoApi, didApi, dwnApi, identityApi, keyManager, permissionsApi, rpcClient, secretsApi, syncApi
  }: CreateUserAgentParams = {}
  ): Promise<EnboxUserAgent> {

    if (agentVault === undefined || secretsApi === undefined) {
      const { LevelStore } = await import('@enbox/common/level-store');

      agentVault ??= new HdIdentityVault({
        keyDerivationWorkFactor : 210_000,
        store                   : new LevelStore<string, string>({ location: `${dataPath}/VAULT_STORE` })
      });

      secretsApi ??= new VaultBackedSecretStore({
        vault : agentVault,
        store : new LevelStore<string, string>({ location: `${dataPath}/SECRET_STORE` }),
      });
    }

    cryptoApi ??= new AgentCryptoApi();

    if (didApi === undefined) {
      const { AgentDidResolverCache } = await import('./agent-did-resolver-cache.js');

      didApi = new AgentDidApi({
        didMethods    : [DidDht, DidJwk],
        resolverCache : new AgentDidResolverCache({ location: `${dataPath}/DID_RESOLVERCACHE` }),
        store         : new DwnDidStore()
      });
    }

    if (!dwnApi) {
      if (localDwnEndpoint) {
        // Remote mode: no in-process DWN. All operations route through
        // RPC to the local DWN server.
        dwnApi = new AgentDwnApi({
          localDwnEndpoint,
          localDwnStrategy: localDwnStrategy ?? DEFAULT_LOCAL_DWN_STRATEGY,
        });
      } else {
        // Local mode: create an in-process DWN with LevelDB stores.
        dwnApi = new AgentDwnApi({
          dwn              : await AgentDwnApi.createDwn({ dataPath, didResolver: didApi }),
          localDwnStrategy : localDwnStrategy ?? DEFAULT_LOCAL_DWN_STRATEGY,
        });
      }
    }
    if (localDwnStrategy) {
      dwnApi.setLocalDwnStrategy(localDwnStrategy);
    }

    identityApi ??= new AgentIdentityApi({ store: new DwnIdentityStore() });

    keyManager ??= new LocalKeyManager({ keyStore: new DwnKeyStore() });

    permissionsApi ??= new AgentPermissionsApi();

    rpcClient ??= new EnboxRpcClient();

    if (syncApi === undefined) {
      const { SyncEngineLevel } = await import('./sync-engine-level.js');
      syncApi = new SyncEngineLevel({ dataPath });
    }

    // Instantiate the Agent using the provided or default components.
    return new EnboxUserAgent({
      agentDid,
      agentVault,
      cryptoApi,
      didApi,
      dwnApi,
      identityApi,
      keyManager,
      permissionsApi,
      rpcClient,
      secretsApi,
      syncApi,
    });
  }

  /**
   * Verifies that a retired in-process replica still matches the exact state
   * proven by a completed local-node drain. This method never mutates or
   * deletes replica data; any mismatch or inspection failure is reported as
   * an invalid proof so callers can safely fall back to local mode.
   */
  public static async inspectLocalReplicaDrainProof({
    dataPath = 'DATA/AGENT',
    proof,
  }: InspectLocalReplicaDrainProofOptions): Promise<LocalReplicaDrainInspectionResult> {
    const invalidReason = EnboxUserAgent.invalidLocalReplicaDrainProofReason(proof);
    if (invalidReason !== undefined) {
      return { valid: false, reason: `malformed local replica drain proof: ${invalidReason}` };
    }

    const stores: ClosableStore[] = [];
    let result: LocalReplicaDrainInspectionResult;

    try {
      const { SyncEngineLevel } = await import('./sync-engine-level.js');
      const syncEngine = new SyncEngineLevel({ dataPath });
      stores.push(syncEngine);

      const snapshot = await syncEngine.getEjectionSnapshot();
      EnboxUserAgent.assertLocalReplicaSyncSnapshot(proof, snapshot);

      const { MessageStoreLevel, ResumableTaskStoreLevel } = await import('@enbox/dwn-sdk-js/stores/level');
      const messageStore = new MessageStoreLevel({ location: `${dataPath}/DWN_MESSAGESTORE` });
      const resumableTaskStore = new ResumableTaskStoreLevel({ location: `${dataPath}/DWN_RESUMABLETASKSTORE` });
      stores.push(messageStore, resumableTaskStore);

      await messageStore.open();
      await resumableTaskStore.open();

      for (const target of proof.targets) {
        const fingerprintScopes = EnboxUserAgent.fingerprintScopesForSyncScope(target.scope);
        const fingerprint = await messageStore.fingerprint(target.tenantDid, fingerprintScopes);
        if (fingerprint !== target.localFingerprint) {
          throw new LocalReplicaDrainProofMismatch(
            `local replica fingerprint changed for tenant '${target.tenantDid}'`,
          );
        }

        const bounds = await messageStore.logBounds(target.tenantDid);
        EnboxUserAgent.assertLocalReplicaFeedHead(target, bounds?.latest);
      }

      const hasPendingTask = await EnboxUserAgent.hasIteratorEntry(resumableTaskStore.db.iterator({ limit: 1 }));
      if (hasPendingTask) {
        throw new LocalReplicaDrainProofMismatch('local replica has a pending resumable task');
      }

      result = { valid: true };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      result = {
        valid  : false,
        reason : error instanceof LocalReplicaDrainProofMismatch
          ? detail
          : `unable to inspect local replica drain proof: ${detail}`,
      };
    }

    stores.reverse();
    const closeResults = await Promise.allSettled(stores.map((store): Promise<void> => store.close()));
    const closeFailure = closeResults.find((closeResult): closeResult is PromiseRejectedResult => closeResult.status === 'rejected');
    if (closeFailure !== undefined) {
      const detail = closeFailure.reason instanceof Error ? closeFailure.reason.message : String(closeFailure.reason);
      return { valid: false, reason: `unable to close local replica proof stores: ${detail}` };
    }

    return result;
  }

  private static invalidLocalReplicaDrainProofReason(proof: LocalReplicaDrainProof): string | undefined {
    if (typeof proof !== 'object' || proof === null) {
      return 'proof must be an object';
    }
    if (typeof proof.replicaId !== 'string' || proof.replicaId.length === 0) {
      return 'replicaId must be a non-empty string';
    }
    if (
      typeof proof.registrationFingerprint !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(proof.registrationFingerprint)
    ) {
      return 'registrationFingerprint must be a SHA-256 base64url value';
    }
    if (!Array.isArray(proof.targets) || proof.targets.length === 0) {
      return 'targets must be a non-empty array';
    }

    const targetKeys = new Set<string>();
    for (const target of proof.targets) {
      const targetReason = EnboxUserAgent.invalidLocalReplicaDrainTargetProofReason(target);
      if (targetReason !== undefined) {
        return targetReason;
      }

      const targetKey = EnboxUserAgent.localReplicaDrainTargetKey(target);
      if (targetKeys.has(targetKey)) {
        return `duplicate target for tenant '${target.tenantDid}' and scope`;
      }
      targetKeys.add(targetKey);
    }
  }

  private static invalidLocalReplicaDrainTargetProofReason(
    target: LocalReplicaDrainTargetProof,
  ): string | undefined {
    if (typeof target !== 'object' || target === null) {
      return 'target must be an object';
    }
    if (typeof target.tenantDid !== 'string' || !/^did:[a-z0-9]+:[^\s]+$/.test(target.tenantDid)) {
      return 'target tenantDid must be a DID URI';
    }

    const scopeReason = EnboxUserAgent.invalidLocalReplicaDrainScopeReason(target.scope);
    if (scopeReason !== undefined) {
      return `target for tenant '${target.tenantDid}' has invalid scope: ${scopeReason}`;
    }

    const fingerprintPattern = /^[0-9a-f]{64}$/;
    if (typeof target.localFingerprint !== 'string' || !fingerprintPattern.test(target.localFingerprint)) {
      return `target for tenant '${target.tenantDid}' has an invalid localFingerprint`;
    }
    if (typeof target.remoteFingerprint !== 'string' || !fingerprintPattern.test(target.remoteFingerprint)) {
      return `target for tenant '${target.tenantDid}' has an invalid remoteFingerprint`;
    }
    if (target.localFingerprint !== target.remoteFingerprint) {
      return `target for tenant '${target.tenantDid}' fingerprints do not prove parity`;
    }

    const checkpoint: unknown = target.pushCheckpoint;
    if (checkpoint !== undefined) {
      if (typeof checkpoint !== 'object' || checkpoint === null || Array.isArray(checkpoint)) {
        return `target for tenant '${target.tenantDid}' has an invalid pushCheckpoint`;
      }

      const { streamId, epoch, position, messageCid } = checkpoint as Record<string, unknown>;
      if (
        typeof streamId !== 'string'
        || streamId.length === 0
        || typeof epoch !== 'string'
        || epoch.length === 0
        || typeof position !== 'string'
        || !/^(?:0|[1-9]\d*)$/.test(position)
        || (messageCid !== undefined && (typeof messageCid !== 'string' || messageCid.length === 0))
      ) {
        return `target for tenant '${target.tenantDid}' has an invalid pushCheckpoint`;
      }
    }
  }

  private static localReplicaDrainTargetKey(target: LocalReplicaDrainTargetProof): string {
    return JSON.stringify([
      target.tenantDid,
      target.scope.kind,
      target.scope.kind === 'protocolSet' ? target.scope.protocols : [],
    ]);
  }

  private static invalidLocalReplicaDrainScopeReason(scope: SyncScope): string | undefined {
    if (typeof scope !== 'object' || scope === null) {
      return 'scope must be an object';
    }
    if (scope.kind === 'full') {
      return Object.keys(scope).length === 1 ? undefined : 'full scope must contain only kind';
    }
    if (scope.kind !== 'protocolSet' || !Array.isArray(scope.protocols) || scope.protocols.length === 0) {
      return 'scope must be full or a non-empty protocol set';
    }
    const scopeKeys = Object.keys(scope);
    if (scopeKeys.length !== 2 || scopeKeys.some((key: string): boolean => key !== 'kind' && key !== 'protocols')) {
      return 'protocol-set scope must contain only kind and protocols';
    }
    if (scope.protocols.some((protocol: unknown): boolean => typeof protocol !== 'string' || protocol.length === 0)) {
      return 'protocols must contain non-empty strings';
    }

    const canonicalProtocols = [...new Set(scope.protocols)].sort(lexicographicalCompare);
    if (
      canonicalProtocols.length !== scope.protocols.length
      || canonicalProtocols.some((protocol: string, index: number): boolean => protocol !== scope.protocols[index])
    ) {
      return 'protocols must be sorted and duplicate-free';
    }
  }

  private static async hasIteratorEntry<T>(iterator: AsyncGenerator<T>): Promise<boolean> {
    try {
      return !(await iterator.next()).done;
    } finally {
      await iterator.return(undefined);
    }
  }

  private static assertLocalReplicaSyncSnapshot(
    proof: LocalReplicaDrainProof,
    snapshot: SyncEjectionSnapshot,
  ): void {
    if (snapshot.replicaId !== proof.replicaId) {
      throw new LocalReplicaDrainProofMismatch('local replica ID does not match the drain proof');
    }
    if (snapshot.registrationFingerprint !== proof.registrationFingerprint) {
      throw new LocalReplicaDrainProofMismatch('local sync registrations changed after the drain');
    }
  }

  private static assertLocalReplicaFeedHead(
    target: LocalReplicaDrainTargetProof,
    feedHead: ProgressToken | undefined,
  ): void {
    if (target.pushCheckpoint === undefined) {
      if (feedHead !== undefined) {
        throw new LocalReplicaDrainProofMismatch(
          `local replica feed is no longer empty for tenant '${target.tenantDid}'`,
        );
      }
      return;
    }

    if (feedHead === undefined) {
      throw new LocalReplicaDrainProofMismatch(
        `local replica feed is empty for checkpointed tenant '${target.tenantDid}'`,
      );
    }
    if (
      feedHead.streamId !== target.pushCheckpoint.streamId
      || feedHead.epoch !== target.pushCheckpoint.epoch
    ) {
      throw new LocalReplicaDrainProofMismatch(
        `local replica feed domain changed for tenant '${target.tenantDid}'`,
      );
    }
    if (feedHead.position !== target.pushCheckpoint.position) {
      throw new LocalReplicaDrainProofMismatch(
        `local replica feed head changed for tenant '${target.tenantDid}'`,
      );
    }
  }

  private static fingerprintScopesForSyncScope(scope: SyncScope): string[] {
    if (scope.kind === 'full') {
      return [Replication.globalDomain];
    }

    const protocols = new Set(scope.protocols);
    return [...protocols].flatMap((protocol: string): string[] => [
      Replication.protocolDomain(protocol),
      ...Replication.taggedCoreProtocolDomains(protocol, protocols),
    ]);
  }

  public async firstLaunch(): Promise<boolean> {
    // Check whether data vault is already initialize
    return await this.vault.isInitialized() === false;
  }

  /**
   * Initializes the User Agent with a password, and optionally a recovery phrase.
   *
   * This method is typically called once, the first time the Agent is launched, and is responsible
   * for setting up the agent's operational environment, cryptographic key material, and readiness
   * for processing requests.
   *
   * The password is used to secure the Agent vault, and the recovery phrase is used to derive the
   * cryptographic keys for the vault. If a recovery phrase is not provided, a new recovery phrase
   * will be generated and returned. The password should be chosen and entered by the end-user.
   */
  public async initialize({ password, recoveryPhrase, dwnEndpoints }: AgentInitializeParams): Promise<string> {
    // Initialize the Agent vault.
    recoveryPhrase = await this.vault.initialize({ password, recoveryPhrase, dwnEndpoints });

    return recoveryPhrase;
  }

  async processDidRequest<T extends DidInterface>(
    request: DidRequest<T>
  ): Promise<DidResponse<T>> {
    return this.did.processRequest(request);
  }

  public async processDwnRequest<T extends DwnInterface>(
    request: ProcessDwnRequest<T>
  ): Promise<DwnResponse<T>> {
    return this.dwn.processRequest(request);
  }

  public async processVcRequest(_request: ProcessVcRequest): Promise<VcResponse> {
    throw new Error('Not implemented');
  }

  public async sendDidRequest<T extends DidInterface>(
    _request: DidRequest<T>
  ): Promise<DidResponse<T>> {
    throw new Error('Not implemented');
  }

  public async sendDwnRequest<T extends DwnInterface>(
    request: SendDwnRequest<T>
  ): Promise<DwnResponse<T>> {
    return this.dwn.sendRequest(request);
  }

  public async sendVcRequest(_request: SendVcRequest): Promise<VcResponse> {
    throw new Error('Not implemented');
  }

  public async start({ password }: AgentInitializeParams): Promise<void> {
    // If the Agent vault is locked, unlock it.
    if (this.vault.isLocked()) {
      await this.vault.unlock({ password });
    }

    // Set the Agent's DID.
    this.agentDid = await this.vault.getDid();
  }

  /**
   * Releases every resource the agent holds so the process can exit and the
   * same data path can be reopened: stops sync (subscriptions and timers),
   * closes the sync engine's store, drains the process-wide RPC socket pool
   * (WebSocket heartbeats otherwise keep the event loop alive), locks the
   * vault, and closes the in-process DWN's stores, the DID resolver cache,
   * and the vault and secret stores.
   *
   * Each step is best-effort so a partially torn-down agent cannot block
   * shutdown. The agent must not be used afterwards — create a new agent to
   * reopen the same data path.
   *
   * @param options.syncStopTimeoutMs - How long to wait for in-flight sync
   *   work to settle before force-stopping. Defaults to 2000.
   */
  public async shutdown(options: { syncStopTimeoutMs?: number } = {}): Promise<void> {
    const { syncStopTimeoutMs = 2000 } = options;

    try {
      await this.sync.stopSync(syncStopTimeoutMs);
    } catch {
      // Best-effort — sync may never have been started.
    }

    try {
      await this.sync.close();
    } catch {
      // Best-effort.
    }

    try {
      await this.rpc.close();
    } catch {
      // Best-effort.
    }

    try {
      await this.vault.lock();
    } catch {
      // Vault may already be locked or uninitialised — safe to ignore.
    }

    try {
      await this.dwn.close();
    } catch {
      // Best-effort — remote-mode agents have no in-process DWN.
    }

    try {
      await this.did.close();
    } catch {
      // Best-effort — the resolver cache may be in-memory.
    }

    try {
      await this.vault.close();
    } catch {
      // Best-effort.
    }

    try {
      await this.secrets.close();
    } catch {
      // Best-effort — the secret store may share the vault's store.
    }
  }
}
