import type { AgentKeyManager } from './types/key-manager.js';
import type { BearerDid } from '@enbox/dids';
import type { EnboxPlatformAgent } from './types/agent.js';
import type { EnboxRpc } from '@enbox/dwn-clients';
import type { LocalDwnStrategy } from './local-dwn.js';
import type { SecretStore } from './secret-store.js';
import type { SyncEngine } from './types/sync.js';
import type {
  DecryptRecordDataParams,
  DwnInterface,
  DwnResponse,
  ProcessDwnRequest,
  SendDwnRequest,
} from './types/dwn.js';
import type { DidInterface, DidRequest, DidResponse } from './did-api.js';

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
import { LocalKeyManager } from './local-key-manager.js';
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
      const { AudienceKeyDeliveryStoreLevel } = await import('./audience-key-delivery-store-level.js');
      const audienceKeyDeliveryStore = new AudienceKeyDeliveryStoreLevel(`${dataPath}/AUDIENCE_DELIVERY_STORE`);

      if (localDwnEndpoint) {
        // Remote mode: no in-process DWN. All operations route through
        // RPC to the local DWN server.
        dwnApi = new AgentDwnApi({
          audienceKeyDeliveryStore,
          localDwnEndpoint,
          localDwnStrategy: localDwnStrategy ?? DEFAULT_LOCAL_DWN_STRATEGY,
        });
      } else {
        // Local mode: create an in-process DWN with LevelDB stores. The
        // message log's wake bus is handed to the API so close() releases
        // its BroadcastChannel with the stores.
        const messageLog = await AgentDwnApi.createDefaultMessageLog(dataPath);
        dwnApi = new AgentDwnApi({
          audienceKeyDeliveryStore,
          dwn              : await AgentDwnApi.createDwn({ dataPath, didResolver: didApi, messageLog }),
          wakePublisher    : messageLog.wakePublisher,
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

  public async decryptRecordData(params: DecryptRecordDataParams): Promise<ReadableStream<Uint8Array>> {
    return this.dwn.decryptRecordData(params);
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

  public async sendDwnRequest<T extends DwnInterface>(
    request: SendDwnRequest<T>
  ): Promise<DwnResponse<T>> {
    return this.dwn.sendRequest(request);
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
   * @param options.syncStopTimeoutMs - How long each sync stop/close phase
   *   waits for in-flight work. Defaults to 2000.
   */
  public async shutdown(options: { syncStopTimeoutMs?: number } = {}): Promise<void> {
    const { syncStopTimeoutMs = 2000 } = options;

    try {
      await this.sync.stopSync(syncStopTimeoutMs);
    } catch {
      // Best-effort — sync may never have been started.
    }

    try {
      await this.sync.close({ timeout: syncStopTimeoutMs });
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
