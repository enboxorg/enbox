import type { AbstractLevel } from 'abstract-level';
import type { BearerIdentity } from './bearer-identity.js';
import type { DidResolverCache } from '@enbox/dids';
import type { Dwn } from '@enbox/dwn-sdk-js';
import type { EnboxPlatformAgent } from './types/agent.js';
import type { KeyValueStore } from '@enbox/common';

import { Level } from 'level';
import { DataStoreLevel, EventEmitterEventLog, MessageStoreLevel, ResumableTaskStoreLevel, StateIndexLevel } from '@enbox/dwn-sdk-js';
import { DidDht, DidJwk, DidResolverCacheMemory } from '@enbox/dids';
import { LevelStore, MemoryStore } from '@enbox/common';

import { AgentCryptoApi } from './crypto-api.js';
import { AgentDidApi } from './did-api.js';
import { AgentDidResolverCache } from './agent-did-resolver-cache.js';
import { AgentDwnApi } from './dwn-api.js';
import { AgentIdentityApi } from './identity-api.js';
import { AgentPermissionsApi } from './permissions-api.js';
import { EnboxRpcClient } from '@enbox/dwn-clients';
import { HdIdentityVault } from './hd-identity-vault.js';
import { LocalKeyManager } from './local-key-manager.js';
import { SyncEngineLevel } from './sync-engine-level.js';
import { DwnDidStore, InMemoryDidStore } from './store-did.js';
import { DwnIdentityStore, InMemoryIdentityStore } from './store-identity.js';
import { DwnKeyStore, InMemoryKeyStore } from './store-key.js';

type StoreSetupResult = {
  agentVault: HdIdentityVault;
  didApi: AgentDidApi;
  didResolverCache: DidResolverCache;
  identityApi: AgentIdentityApi<LocalKeyManager>;
  keyManager: LocalKeyManager;
  permissionsApi: AgentPermissionsApi;
  vaultStore: KeyValueStore<string, string>;
};

type PlatformAgentTestHarnessParams = {
  agent: EnboxPlatformAgent<LocalKeyManager>

  agentStores: 'dwn' | 'memory';
  didResolverCache: DidResolverCache;
  dwn: Dwn;
  dwnDataStore: DataStoreLevel;
  dwnStateIndex: StateIndexLevel;
  dwnMessageStore: MessageStoreLevel;
  dwnResumableTaskStore: ResumableTaskStoreLevel;
  syncStore: AbstractLevel<string | Buffer | Uint8Array>;
  vaultStore: KeyValueStore<string, string>;
  dwnStores: {
    keyStore: DwnKeyStore;
    identityStore: DwnIdentityStore;
    didStore: DwnDidStore;
    clear: () => void;
  }
};

export class PlatformAgentTestHarness {
  public agent: EnboxPlatformAgent<LocalKeyManager>;

  public agentStores: 'dwn' | 'memory';
  public didResolverCache: DidResolverCache;
  public dwn: Dwn;
  public dwnDataStore: DataStoreLevel;
  public dwnStateIndex: StateIndexLevel;
  public dwnMessageStore: MessageStoreLevel;
  public dwnResumableTaskStore: ResumableTaskStoreLevel;
  public syncStore: AbstractLevel<string | Buffer | Uint8Array>;
  public vaultStore: KeyValueStore<string, string>;

  /**
   * Custom DWN Stores for `keyStore`, `identityStore` and `didStore`.
   * This allows us to clear the store cache between tests
   */
  public dwnStores: {
    keyStore: DwnKeyStore;
    identityStore: DwnIdentityStore;
    didStore: DwnDidStore;
    /** clears the protocol initialization caches */
    clear: () => void;
  };

  constructor(params: PlatformAgentTestHarnessParams) {
    this.agent = params.agent;
    this.agentStores = params.agentStores;
    this.didResolverCache = params.didResolverCache;
    this.dwn = params.dwn;
    this.dwnDataStore = params.dwnDataStore;
    this.dwnStateIndex = params.dwnStateIndex;
    this.dwnMessageStore = params.dwnMessageStore;
    this.syncStore = params.syncStore;
    this.vaultStore = params.vaultStore;
    this.dwnResumableTaskStore = params.dwnResumableTaskStore;
    this.dwnStores = params.dwnStores;
  }

  public async clearStorage(): Promise<void> {
    // first stop any ongoing sync operations
    await this.agent.sync.stopSync();

    // @ts-expect-error since normally this property shouldn't be set to undefined.
    this.agent.agentDid = undefined;
    await this.didResolverCache.clear();
    await this.dwnDataStore.clear();
    await this.dwnStateIndex.clear();
    await this.dwnMessageStore.clear();
    await this.dwnResumableTaskStore.clear();
    await this.syncStore.clear();
    await this.vaultStore.clear();
    (this.agent.vault as any)['_cachedInitialized'] = undefined;
    await this.agent.permissions.clear();
    this.dwnStores.clear();

    // Reset the indexes and caches for the Agent's DWN data stores.
    // if (this.agentStores === 'dwn') {
    //   const { didApi, identityApi } = PlatformAgentTestHarness.useDiskStores({ testDataLocation: '__TESTDATA__', agent: this.agent });
    //   this.agent.crypto = cryptoApi;
    //   this.agent.did = didApi;
    //   this.agent.identity = identityApi;
    // }

    // Easiest way to start with fresh in-memory stores is to re-instantiate Agent components.
    if (this.agentStores === 'memory') {
      const { didApi, identityApi, permissionsApi, keyManager } = PlatformAgentTestHarness.useMemoryStores({ agent: this.agent });
      this.agent.did = didApi;
      this.agent.identity = identityApi;
      this.agent.keyManager = keyManager;
      this.agent.permissions = permissionsApi;
    }
  }

  /**
   * Clear only DWN-level stores (data, messages, state index, resumable tasks,
   * sync, permissions) and the DWN-backed store caches — but preserve the
   * agent DID, vault, and all key/DID/identity material.
   *
   * Use this in `beforeEach` when `createAgentDid()` (and optionally
   * `createIdentity()`) was called once in `beforeAll` to avoid expensive
   * DID re-creation on every test.
   */
  public async clearDwnStores(): Promise<void> {
    await this.syncStore.clear();
    await this.dwnDataStore.clear();
    await this.dwnStateIndex.clear();
    await this.dwnMessageStore.clear();
    await this.dwnResumableTaskStore.clear();
    await this.agent.permissions.clear();
    this.dwnStores.clear();
  }

  public async closeStorage(): Promise<void> {
    await this.didResolverCache.close();
    await this.dwnDataStore.close();
    await this.dwnStateIndex.close();
    await this.dwnMessageStore.close();
    await this.dwnResumableTaskStore.close();
    await this.syncStore.close();
    await this.vaultStore.close();
  }

  public async createAgentDid(): Promise<void> {
    // Create a DID for the Agent with Ed25519 (signing) and X25519 (keyAgreement).
    // X25519 is required by DwnKeyStore for JWE record-level encryption.
    // Must be published so the DWN can resolve it for JWS signature verification.
    this.agent.agentDid = await DidDht.create({
      options: {
        publish             : true,
        gatewayUri          : process.env.DID_DHT_GATEWAY_URI ?? 'http://localhost:7527',
        verificationMethods : [
          {
            algorithm : 'Ed25519',
            id        : 'sig',
            purposes  : ['assertionMethod', 'authentication']
          },
          {
            algorithm : 'X25519',
            id        : 'enc',
            purposes  : ['keyAgreement']
          }
        ]
      }
    });
  }

  public async createIdentity({ name, testDwnUrls }: {
    name: string;
    testDwnUrls: string[];
  }): Promise<BearerIdentity> {
    const bearerIdentity = await this.agent.identity.create({
      didMethod  : 'dht',
      didOptions : {
        services: [
          {
            id              : 'dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : testDwnUrls,
          }
        ],
        verificationMethods: [
          {
            algorithm : 'Ed25519',
            id        : 'sig',
            purposes  : ['assertionMethod', 'authentication']
          },
          {
            algorithm : 'X25519',
            id        : 'enc',
            purposes  : ['keyAgreement']
          }
        ]
      },
      metadata: { name }
    });

    return bearerIdentity;
  }

  public static async setup({ agentClass, agentStores, testDataLocation }: {
    agentClass: new (params: any) => EnboxPlatformAgent<LocalKeyManager>
    agentStores?: 'dwn' | 'memory';
    testDataLocation?: string;
  }): Promise<PlatformAgentTestHarness> {
    agentStores ??= 'memory';
    testDataLocation ??= '__TESTDATA__';

    const testDataPath = (path: string): string => `${testDataLocation}/${path}`;

    // Instantiate Agent's Crypto API.
    const cryptoApi = new AgentCryptoApi();

    // Instantiate Agent's RPC Client.
    const rpcClient = new EnboxRpcClient();

    const dwnStores = {
      keyStore      : new DwnKeyStore(),
      identityStore : new DwnIdentityStore(),
      didStore      : new DwnDidStore(),
      clear         : ():void => {
        dwnStores.keyStore['_protocolInitializedCache']?.clear();
        dwnStores.identityStore['_protocolInitializedCache']?.clear();
        dwnStores.didStore['_protocolInitializedCache']?.clear();
      }
    };

    const {
      agentVault,
      didApi,
      identityApi,
      keyManager,
      didResolverCache,
      vaultStore,
      permissionsApi
    } = (agentStores === 'memory')
      ? PlatformAgentTestHarness.useMemoryStores()
      : PlatformAgentTestHarness.useDiskStores({ testDataLocation, stores: dwnStores });

    // Instantiate custom stores to use with DWN instance.
    // Note: There is no in-memory store for DWN, so we always use LevelDB-based disk stores.
    const dwnDataStore = new DataStoreLevel({ blockstoreLocation: testDataPath('DWN_DATASTORE') });
    const dwnStateIndex = new StateIndexLevel({ location: testDataPath('DWN_STATEINDEX') });
    const dwnEventLog = new EventEmitterEventLog();
    const dwnResumableTaskStore = new ResumableTaskStoreLevel({ location: testDataPath('DWN_RESUMABLETASKSTORE') });

    const dwnMessageStore = new MessageStoreLevel({
      blockstoreLocation : testDataPath('DWN_MESSAGESTORE'),
      indexLocation      : testDataPath('DWN_MESSAGEINDEX')
    });

    // Instantiate DWN instance using the custom stores.
    const dwn = await AgentDwnApi.createDwn({
      dataPath           : testDataLocation,
      dataStore          : dwnDataStore,
      didResolver        : didApi,
      stateIndex         : dwnStateIndex,
      eventLog           : dwnEventLog,
      messageStore       : dwnMessageStore,
      resumableTaskStore : dwnResumableTaskStore
    });

    // Instantiate Agent's DWN API using the custom DWN instance.
    // Disable local DWN discovery so tests don't accidentally probe localhost.
    const dwnApi = new AgentDwnApi({ dwn, localDwnStrategy: 'off' });

    // Instantiate Agent's Sync API using a custom LevelDB-backed store.
    const syncStore = new Level(testDataPath('SYNC_STORE'));
    const syncApi = new SyncEngineLevel({ db: syncStore });

    // Create EnboxPlatformAgent instance
    const agent = new agentClass({
      agentVault,
      cryptoApi,
      didApi,
      dwnApi,
      identityApi,
      keyManager,
      permissionsApi,
      rpcClient,
      syncApi,
    });

    return new PlatformAgentTestHarness({
      agent,
      agentStores,
      didResolverCache,
      dwn,
      dwnDataStore,
      dwnStateIndex,
      dwnMessageStore,
      dwnResumableTaskStore,
      dwnStores,
      syncStore,
      vaultStore
    });
  }

  private static useDiskStores({ agent, testDataLocation, stores }: {
    agent?: EnboxPlatformAgent<LocalKeyManager>;
    stores: {
      keyStore: DwnKeyStore;
      identityStore: DwnIdentityStore;
      didStore: DwnDidStore;
    }
    testDataLocation: string;
  }): StoreSetupResult {
    const testDataPath = (path: string): string => `${testDataLocation}/${path}`;

    const vaultStore = new LevelStore<string, string>({ location: testDataPath('VAULT_STORE') });
    const agentVault = new HdIdentityVault({ keyDerivationWorkFactor: 1, store: vaultStore });

    const { didStore, identityStore, keyStore } = stores;

    // Setup DID Resolver Cache
    const didResolverCache = new AgentDidResolverCache({
      location: testDataPath('DID_RESOLVERCACHE')
    });

    const didApi = new AgentDidApi({
      agent         : agent,
      didMethods    : [DidDht, DidJwk],
      resolverCache : didResolverCache,
      store         : didStore
    });

    const identityApi = new AgentIdentityApi<LocalKeyManager>({ agent, store: identityStore });

    const keyManager = new LocalKeyManager({ agent, keyStore: keyStore });

    const permissionsApi = new AgentPermissionsApi({ agent });

    return { agentVault, didApi, didResolverCache, identityApi, keyManager, permissionsApi, vaultStore };
  }

  private static useMemoryStores({ agent }: { agent?: EnboxPlatformAgent<LocalKeyManager> } = {}): StoreSetupResult {
    const vaultStore = new MemoryStore<string, string>();
    const agentVault = new HdIdentityVault({ keyDerivationWorkFactor: 1, store: vaultStore });

    // Setup DID Resolver Cache
    const didResolverCache = new DidResolverCacheMemory();

    const didApi = new AgentDidApi({
      agent         : agent,
      didMethods    : [DidDht, DidJwk],
      resolverCache : didResolverCache,
      store         : new InMemoryDidStore()
    });

    const keyManager = new LocalKeyManager({ agent, keyStore: new InMemoryKeyStore() });

    const identityApi = new AgentIdentityApi<LocalKeyManager>({ agent, store: new InMemoryIdentityStore() });

    const permissionsApi = new AgentPermissionsApi({ agent });

    return { agentVault, didApi, didResolverCache, identityApi, keyManager, permissionsApi, vaultStore };
  }
}