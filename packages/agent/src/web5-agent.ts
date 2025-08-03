import {
  Web5Rpc,
  DidRequest,
  VcResponse,
  DidResponse,
  DwnResponse,
  DidInterface,
  DwnInterface,
  SendVcRequest,
  SendDwnRequest,
  ProcessVcRequest,
  ProcessDwnRequest,
  Web5PlatformAgent,
} from './types/agent.js';

import { LevelStore } from '@enbox/common';
import { BearerDid, DidDht, DidJwk, DidResolverCacheLevel } from '@enbox/dids';
import { AgentDidResolverCache } from './agent-did-resolver-cache.js';
import { BearerIdentity } from './bearer-identity.js';
import { AgentDidApi } from './did-api.js';
import { AgentDwnApi } from './dwn-api.js';
import { DwnDidStore } from './store-did.js';
import { DwnKeyStore } from './store-key.js';
import { AgentSyncApi } from './sync-api.js';
import { Web5RpcClient } from './rpc-client.js';
import { AgentCryptoApi } from './crypto-api.js';
import { AgentKeyManager } from './types/key-manager.js';
import { HdIdentityVault } from './hd-identity-vault.js';
import { LocalKeyManager } from './local-key-manager.js';
import { SyncEngineLevel } from './sync-engine-level.js';
import { AgentIdentityApi } from './identity-api.js';
import { DwnIdentityStore } from './store-identity.js';
import { AgentPermissionsApi } from './permissions-api.js';

/**
 * Initialization parameters for {@link Web5Agent}, including an optional recovery phrase that
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
   * Optional dwnEndpoints to register didService endpoints during Web5Agent initialization
   *
   * The dwnEndpoints are used to register DWN endpoints against the agent DID created during
   * Web5Agent.initialize(). This allows the agent to properly recover connectedDids from DWN.
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
  /** Optional. The Decentralized Identifier (DID) representing this Web5 Agent. */
  agentDid?: BearerDid;
  /** Encrypted vault used for managing the Agent's DID and associated keys. */
  agentVault: HdIdentityVault;
  /** Provides cryptographic capabilities like signing, encryption, hashing and key derivation. */
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
  /** Remote procedure call (RPC) client used to communicate with other Web5 services. */
  rpcClient: Web5Rpc;
  /** Facilitates data synchronization of Agent data to and from remote DWNs. */
  syncApi: AgentSyncApi;
};

/**
 * A unified Web5 agent implementation that handles DIDs, DWNs, VCs and identity management.
 * This replaces the previous separate user-agent, identity-agent, and proxy-agent implementations.
 */
export class Web5Agent<TKeyManager extends AgentKeyManager = LocalKeyManager> implements Web5PlatformAgent<TKeyManager> {
  public crypto: AgentCryptoApi;
  public did: AgentDidApi<TKeyManager>;
  public dwn: AgentDwnApi;
  public identity: AgentIdentityApi<TKeyManager>;
  public keyManager: TKeyManager;
  public permissions: AgentPermissionsApi;
  public rpc: Web5Rpc;
  public sync: AgentSyncApi;
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
      throw new Error('Web5Agent: Agent DID is not set.');
    }
    return this._agentDid;
  }

  set agentDid(did: BearerDid) {
    this._agentDid = did;
  }

  /**
   * Creates a new Web5Agent instance with default configurations.
   */
  static async create(options: { agentVault?: HdIdentityVault, dataPath?: string } = {}): Promise<Web5Agent> {
    const { dataPath = 'DATA', agentVault } = options;
    const didApi = new AgentDidApi({
      didResolvers: [DidDht, DidJwk],
      resolverCache: new DidResolverCacheLevel({
        location: `${dataPath}/DID_RESOLVERCACHE`
      })
    });

    const identityApi = new AgentIdentityApi({ store: new DwnIdentityStore() });
    const keyManager = new LocalKeyManager({ keyStore: new DwnKeyStore() });
    const cryptoApi = new AgentCryptoApi({ keyManager });
    const syncApi = new AgentSyncApi({ syncEngine: new SyncEngineLevel({ dataPath }) });
    const rpcClient = new Web5RpcClient();
    const dwnApi = new AgentDwnApi({ dwn: await AgentDwnApi.createDwn({ dataPath, didResolver: didApi }) });
    const permissionsApi = new AgentPermissionsApi();

    const vault = agentVault ?? new HdIdentityVault({
      keyDerivationWorkFactor: 210_000,
      store: new LevelStore({ location: `${dataPath}/VAULT_STORE` })
    });

    // Instantiate the Web5Agent.
    const agent = new Web5Agent({
      agentVault: vault,
      cryptoApi,
      dataPath,
      didApi,
      dwnApi,
      identityApi,
      keyManager,
      permissionsApi,
      rpcClient,
      syncApi
    });

    return agent;
  }

  async firstLaunch(): Promise<boolean> {
    return this.vault.firstLaunch();
  }

  async initialize({ password, recoveryPhrase, dwnEndpoints }: AgentInitializeParams): Promise<string> {
    if (await this.vault.isInitialized()) {
      throw new Error('Web5Agent: Agent vault is already initialized.');
    }

    // Generate recovery phrase if not provided.
    const vault = recoveryPhrase
      ? await HdIdentityVault.create({
        password,
        recoveryPhrase,
        store: this.vault.store,
        keyDerivationWorkFactor: this.vault.keyDerivationWorkFactor
      })
      : await HdIdentityVault.create({
        password,
        store: this.vault.store,
        keyDerivationWorkFactor: this.vault.keyDerivationWorkFactor
      });

    // Store the vault in the agent.
    this.vault = vault;

    // Retrieve the Agent's DID from the vault.
    const portableIdentity = await vault.getStoredIdentity({ didUri: vault.getDid() });
    if (!portableIdentity) {
      throw new Error('Web5Agent: Agent DID not found in vault after initialization.');
    }

    // Import the Agent's DID to the Agent's DID store.
    const bearerDid = await this.did.import({ portableIdentity });
    this.agentDid = bearerDid;

    // Set the Agent's DID in the Agent's DWN, Key Manager, and Identity Manager.
    this.dwn.node.setTenant(bearerDid.uri);
    this.keyManager.setAgent(this);
    this.identity.setTenant({ agent: this, tenant: bearerDid.uri });
    this.sync.setAgent(this);

    // If dwnEndpoints are provided, update the Agent's DID Document with the endpoints.
    if (dwnEndpoints && dwnEndpoints.length > 0) {
      const services: any = [{
        id: 'dwn',
        type: 'DecentralizedWebNode',
        serviceEndpoint: dwnEndpoints,
        enc: '#enc',
        sig: '#sig'
      }];

      await this.did.update({
        portableIdentity: await bearerDid.export(),
        didDocument: { id: bearerDid.uri, service: services }
      });
    }

    return vault.recoveryPhrase!;
  }

  async processDidRequest<T extends DidInterface>(request: DidRequest<T>): Promise<DidResponse<T>> {
    return this.did.processRequest(request);
  }

  async processDwnRequest<T extends DwnInterface>(request: ProcessDwnRequest<T>): Promise<DwnResponse<T>> {
    return this.dwn.processRequest(request);
  }

  async processVcRequest(request: ProcessVcRequest): Promise<VcResponse> {
    // TODO: Implement when VC API is added
    throw new Error('Web5Agent: VC API not yet implemented.');
  }

  async sendDidRequest<T extends DidInterface>(request: DidRequest<T>): Promise<DidResponse<T>> {
    return this.did.processRequest(request);
  }

  async sendDwnRequest<T extends DwnInterface>(request: SendDwnRequest<T>): Promise<DwnResponse<T>> {
    return this.dwn.sendRequest(request);
  }

  async sendVcRequest(request: SendVcRequest): Promise<VcResponse> {
    // TODO: Implement when VC API is added
    throw new Error('Web5Agent: VC API not yet implemented.');
  }

  async start({ password }: AgentStartParams): Promise<void> {
    if (await this.vault.isLocked()) {
      await this.vault.unlock({ password });
    }

    // Retrieve the Agent's DID from the vault.
    const storedDid = this.vault.getDid();
    const portableIdentity = await this.vault.getStoredIdentity({ didUri: storedDid });
    if (!portableIdentity) {
      throw new Error('Web5Agent: Agent DID not found in vault after initialization.');
    }

    // Import the Agent's DID to the Agent's DID store.
    const bearerDid = await this.did.import({ portableIdentity });
    this.agentDid = bearerDid;

    // Set the Agent's DID in the Agent's DWN, Key Manager, and Identity Manager.
    this.dwn.node.setTenant(bearerDid.uri);
    this.keyManager.setAgent(this);
    this.identity.setTenant({ agent: this, tenant: bearerDid.uri });
    this.sync.setAgent(this);
  }
}