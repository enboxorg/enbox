import type {
  DidDhtCreateOptions,
  DidDocument,
  DidJwkCreateOptions,
  DidMetadata,
  DidMethodApi,
  DidResolutionOptions,
  DidResolutionResult,
  DidResolverCache,
  DidVerificationMethod,
  DidWebCreateOptions,
  PortableDid,
} from '@enbox/dids';

import { BearerDid, Did, DidDht, DidDhtUtils, DidResolverCacheMemory, utils as didUtils, UniversalResolver } from '@enbox/dids';
import { canonicalize, Ed25519 } from '@enbox/crypto';

import type { AgentDataStore } from './store-data.js';
import type { AgentKeyManager } from './types/key-manager.js';
import type { EnboxPlatformAgent, ResponseStatus } from './types/agent.js';

import { InMemoryDidStore } from './store-did.js';

export enum DidInterface {
  Create = 'Create',
  // Deactivate = 'Deactivate',
  Resolve = 'Resolve',
  // Update  = 'Update'
}

/** Publication succeeded, but the agent could not durably reconcile its local DID store. */
export class DidUpdateLocalCommitError extends Error {
  public readonly code = 'DID_UPDATE_LOCAL_COMMIT_FAILED';
  public readonly didUri: string;
  public readonly published: boolean;

  public constructor({ cause, didUri, published }: {
    cause: unknown;
    didUri: string;
    published: boolean;
  }) {
    super(`AgentDidApi: DID document was published but local storage reconciliation failed: ${didUri}`, { cause });
    this.name = 'DidUpdateLocalCommitError';
    this.didUri = didUri;
    this.published = published;
  }
}

export interface DidMessageParams {
  [DidInterface.Create]: DidCreateParams;
  // [DidInterface.Deactivate]: DidDeactivateParams;
  [DidInterface.Resolve]: DidResolveParams;
  // [DidInterface.Update]: DidUpdateParams;
}

export interface DidMessageResult {
  [DidInterface.Create]: DidCreateResult;
  // [DidInterface.Deactivate]: DidDeactivateResult;
  [DidInterface.Resolve]: DidResolveResult;
  // [DidInterface.Update]: DidUpdateResult;
}

export type DidCreateResult = {
  uri: string;
  document: DidDocument;
  metadata: DidMetadata;
};

export type DidResolveResult = DidResolutionResult;

export type DidRequest<T extends DidInterface> = {
  messageType: T;
  messageParams: DidMessageParams[T];
};

export type DidResolveParams = {
  didUri: string;
  options?: DidResolutionOptions;
};

export type DidUpdateParams = {
  force?: boolean;
  tenant?: string;
  portableDid: PortableDid;
  publish?: boolean;
};

export type DidImportParams = {
  portableDid: PortableDid;
  tenant?: string;
};

export type DidMutationContext = {
  /** Update without re-entering the per-DID mutation queue. */
  update(params: DidUpdateParams): Promise<BearerDid>;
};

export type DidResponse<T extends DidInterface> = ResponseStatus & {
  result?: DidMessageResult[T];
};

export interface DidCreateParams<
  TKeyManager = AgentKeyManager,
  TMethod extends keyof DidMethodCreateOptions<TKeyManager> = keyof DidMethodCreateOptions<TKeyManager>
> {
  method: TMethod;
  options?: DidMethodCreateOptions<TKeyManager>[TMethod];
  store?: boolean;
  tenant?: string;
}

export interface DidMethodCreateOptions<TKeyManager> {
  dht: DidDhtCreateOptions<TKeyManager>;
  jwk: DidJwkCreateOptions<TKeyManager>;
  web: DidWebCreateOptions<TKeyManager>;
}

export interface DidApiParams {
  didMethods: DidMethodApi[];

  agent?: EnboxPlatformAgent;

  /**
   * An optional `DidResolverCache` instance used for caching resolved DID documents.
   *
   * Providing a cache implementation can significantly enhance resolution performance by avoiding
   * redundant resolutions for previously resolved DIDs. If omitted, the default is an in-memory cache.
   * This allows for quick and offline access to the internal DIDs used by the agent.
   */
  resolverCache?: DidResolverCache;

  store?: AgentDataStore<PortableDid>;
}

type DidResolutionSnapshot = {
  generation: number;
  result: DidResolutionResult;
};

type DidImportTransaction = {
  bearerDid: BearerDid;
  newlyImportedKeyUris: string[];
};

export function isDidRequest<T extends DidInterface>(
  didRequest: DidRequest<DidInterface>, messageType: T
): didRequest is DidRequest<T> {
  return didRequest.messageType === messageType;
}

/**
 * This API is used to manage and interact with DIDs within the Enbox Agent framework.
 *
 * If a DWN Data Store is used, the DID information is stored under DID's own tenant by default.
 * If a tenant property is passed, that tenant will be used to store the DID information.
 */
export class AgentDidApi<TKeyManager extends AgentKeyManager = AgentKeyManager> extends UniversalResolver {
  /**
   * Holds the instance of a `EnboxPlatformAgent` that represents the current execution context for
   * the `AgentDidApi`. This agent is used to interact with other Enbox agent components. It's vital
   * to ensure this instance is set to correctly contextualize operations within the broader Enbox
   * Agent framework.
   */
  private _agent?: EnboxPlatformAgent;

  private readonly _didMethods: Map<string, DidMethodApi> = new Map();

  private readonly _store: AgentDataStore<PortableDid>;

  /** Coalesces explicit, cache-bypassing refreshes for the same DID. */
  private readonly _refreshResolutionInFlight = new Map<string, Promise<DidResolutionSnapshot>>();

  /** Prevents a refresh started before an update from overwriting the update's cache result. */
  private readonly _resolutionGeneration = new Map<string, number>();

  /** Serializes authoritative local DID mutations and resolution reconciliation per DID. */
  private readonly _didMutationTails = new Map<string, Promise<void>>();

  /** Serializes KMS ownership changes across different DIDs. */
  private _keyMutationTail: Promise<void> = Promise.resolve();

  /** Same-process ownership index; durable tenant scans cover pre-existing records. */
  private readonly _managedKeyOwners = new Map<string, Set<string>>();

  constructor({ agent, didMethods, resolverCache, store }: DidApiParams) {
    if (!didMethods) {
      throw new TypeError(`AgentDidApi: Required parameter missing: 'didMethods'`);
    }

    // Initialize the DID resolver with the given DID methods and resolver cache, or use a default
    // in-memory cache if none is provided.
    super({
      didResolvers : didMethods,
      cache        : resolverCache ?? new DidResolverCacheMemory()
    });

    this._agent = agent;

    // If `store` is not given, use an in-memory store by default.
    this._store = store ?? new InMemoryDidStore();

    for (const didMethod of didMethods) {
      this._didMethods.set(didMethod.methodName, didMethod);
    }
  }

  /**
   * Retrieves the `EnboxPlatformAgent` execution context.
   *
   * @returns The `EnboxPlatformAgent` instance that represents the current execution context.
   * @throws Will throw an error if the `agent` instance property is undefined.
   */
  get agent(): EnboxPlatformAgent {
    if (this._agent === undefined) {
      throw new Error('AgentDidApi: Unable to determine agent execution context.');
    }

    return this._agent;
  }

  set agent(agent: EnboxPlatformAgent) {
    this._agent = agent;

    // Agent-aware resolver caches should receive the agent context when available.
    if ('agent' in this.cache) {
      this.cache.agent = agent;
    }
  }

  public async create({
    method, tenant, options, store
  }: DidCreateParams<TKeyManager>): Promise<BearerDid> {
    // Get the DID method implementation, which also verifies the method is supported.
    const didMethod = this.getMethod(method);

    // Create the DID and store the generated keys in the Agent's key manager.
    const bearerDid = await didMethod.create({ keyManager: this.agent.keyManager, options });

    // Persist the DID to the store, by default, unless the `store` option is set to false.
    if (store ?? true) {
      // Data stored in the Agent's DID store must be in PortableDid format.
      const { uri, document, metadata } = bearerDid;
      const portableDid: PortableDid = { uri, document, metadata };

      // Unless an existing `tenant` is specified, a record that includes the DID's URI, document,
      // and metadata will be stored under a new tenant controlled by the newly created DID.
      await this._store.set({
        id                : portableDid.uri,
        data              : portableDid,
        agent             : this.agent,
        tenant            : tenant ?? portableDid.uri,
        preventDuplicates : false,
        useCache          : true
      });
      await this._setManagedKeyOwnership({
        didUri   : portableDid.uri,
        document : portableDid.document,
        tenant   : tenant ?? portableDid.uri,
      });
    }

    // Only advertise the new document through the resolver cache after required durable storage
    // succeeds. A failed create must not leave a cache-only managed DID.
    this._resolutionGeneration.set(
      bearerDid.uri,
      (this._resolutionGeneration.get(bearerDid.uri) ?? 0) + 1
    );
    try {
      await this.cache.set(bearerDid.uri, {
        didDocument           : bearerDid.document,
        didDocumentMetadata   : bearerDid.metadata,
        didResolutionMetadata : {},
      });
    } catch {
      // The method publication and DID store are authoritative; cache writes are best-effort.
    }

    return bearerDid;
  }

  public async export({ didUri, tenant }: {
    didUri: string;
    tenant?: string;
  }): Promise<PortableDid> {
    // Attempt to retrieve the DID from the agent's DID store.
    const bearerDid = await this.get({ didUri, tenant });

    if (!bearerDid) {
      throw new Error(`AgentDidApi: Failed to export due to DID not found: ${didUri}`);
    }

    // If the DID was found, return the DID in a portable format, and if supported by the Agent's
    // key manager, the private key material.
    const portableDid = await bearerDid.export();

    return portableDid;
  }

  public async get({ didUri, tenant }: {
    didUri: string,
    tenant?: string
  }): Promise<BearerDid | undefined> {
    const portableDid = await this._store.get({ id: didUri, agent: this.agent, tenant, useCache: true });

    if (!portableDid) {return undefined;}

    const bearerDid = await BearerDid.import({ portableDid, keyManager: this.agent.keyManager });

    return bearerDid;
  }

  public async getSigningMethod({ didUri, methodId }: {
    didUri: string;
    methodId?: string;
  }): Promise<DidVerificationMethod> {
    // Verify the DID method is supported.
    const parsedDid = Did.parse(didUri);
    if (!parsedDid) {
      throw new Error(`Invalid DID URI: ${didUri}`);
    }

    // Get the DID method implementation, which also verifies the method is supported.
    const didMethod = this.getMethod(parsedDid.method);

    // Resolve the DID document.
    const { didDocument, didResolutionMetadata } = await this.resolve(didUri);
    if (!didDocument) {
      throw new Error(`DID resolution failed for '${didUri}': ${JSON.stringify(didResolutionMetadata)}`);
    }

    // Retrieve the method-specific verification method to be used for signing operations.
    const verificationMethod = await didMethod.getSigningMethod({ didDocument, methodId });

    return verificationMethod;
  }

  /**
   * Resolve a DID from its method-specific source, bypassing any cached document, then write a
   * successful result through to the resolver cache. Concurrent refreshes of the same DID share
   * one underlying resolution.
   *
   * Unlike passing ad-hoc resolution options to {@link resolve}, this method renews the cache TTL.
   */
  public async refreshResolution(didUri: string): Promise<DidResolutionResult> {
    const { result } = await this._refreshResolutionSnapshot(didUri);
    return result;
  }

  /**
   * Freshly resolve a managed DID and conditionally reconcile its durable snapshot.
   * A concurrent authoritative mutation wins: reconciliation retries instead of
   * overwriting the newer document with an earlier resolution result.
   */
  public async refreshResolutionAndReconcile({ didUri, tenant }: {
    didUri: string;
    tenant?: string;
  }): Promise<DidResolutionResult> {
    while (true) {
      const snapshot = await this._refreshResolutionSnapshot(didUri);
      const { result } = snapshot;
      const didDocument = result.didDocument;
      if (result.didResolutionMetadata.error !== undefined || didDocument === null) {
        return result;
      }

      const reconciled = await this._withDidMutation(didUri, async (): Promise<boolean> => {
        return this._withKeyMutation(async (): Promise<boolean> => {
          if ((this._resolutionGeneration.get(didUri) ?? 0) !== snapshot.generation) {
            return false;
          }

          const stored = await this._store.get({
            id       : didUri,
            agent    : this.agent,
            tenant,
            useCache : true,
          });
          if ((this._resolutionGeneration.get(didUri) ?? 0) !== snapshot.generation) {
            return false;
          }
          if (stored === undefined) {
            return true;
          }
          if (
            canonicalize(stored.document) === canonicalize(didDocument)
            && canonicalize(stored.metadata) === canonicalize(result.didDocumentMetadata)
          ) {
            await this._setManagedKeyOwnership({ didUri, document: stored.document, tenant: tenant ?? didUri });
            return true;
          }

          await this._store.set({
            id   : didUri,
            data : {
              uri      : didUri,
              document : structuredClone(didDocument),
              metadata : structuredClone(result.didDocumentMetadata),
            },
            agent          : this.agent,
            tenant         : tenant ?? didUri,
            updateExisting : true,
            useCache       : true,
          });
          await this._setManagedKeyOwnership({ didUri, document: didDocument, tenant: tenant ?? didUri });
          return (this._resolutionGeneration.get(didUri) ?? 0) === snapshot.generation;
        });
      });

      if (reconciled) {
        return result;
      }
    }
  }

  /** Return one generation-stable, cache-bypassing resolution snapshot. */
  private async _refreshResolutionSnapshot(didUri: string): Promise<DidResolutionSnapshot> {
    const inFlight = this._refreshResolutionInFlight.get(didUri);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const refresh = (async (): Promise<DidResolutionSnapshot> => {
      while (true) {
        const generation = this._resolutionGeneration.get(didUri) ?? 0;
        const result = await super.resolve(didUri, {});

        // A publication or local authoritative mutation won the race. Resolve
        // again so this caller and every coalesced caller receive current state,
        // rather than merely suppressing a stale cache write.
        if ((this._resolutionGeneration.get(didUri) ?? 0) !== generation) {
          continue;
        }

        if (result.didResolutionMetadata.error === undefined && result.didDocument !== null) {
          try {
            await this.cache.set(didUri, result);
          } catch {
            // A resolver-cache write is an optimization. The fresh authoritative result remains valid.
          }
        }

        // Cache writes may yield. Recheck the generation before exposing the
        // result, and repair any stale write by resolving the new generation.
        if ((this._resolutionGeneration.get(didUri) ?? 0) !== generation) {
          continue;
        }

        return { generation, result };
      }
    })();

    this._refreshResolutionInFlight.set(didUri, refresh);
    try {
      return await refresh;
    } finally {
      this._refreshResolutionInFlight.delete(didUri);
    }
  }

  /** Run one per-DID mutation turn and always release following callers. */
  private async _withDidMutation<TResult>(didUri: string, operation: () => Promise<TResult>): Promise<TResult> {
    const previous = this._didMutationTails.get(didUri) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => turn);
    this._didMutationTails.set(didUri, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this._didMutationTails.get(didUri) === tail) {
        this._didMutationTails.delete(didUri);
      }
    }
  }

  /** Run one global KMS ownership turn and always release following callers. */
  private async _withKeyMutation<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const previous = this._keyMutationTail;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    this._keyMutationTail = previous.then(() => turn);

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Run a read/merge/write transaction in the core per-DID mutation queue.
   * Callers must use the supplied non-reentrant `update` operation rather than
   * invoking {@link update} from inside the callback.
   *
   * @internal
   */
  public async runMutation<TResult>({ didUri, operation }: {
    didUri: string;
    operation: (context: DidMutationContext) => Promise<TResult>;
  }): Promise<TResult> {
    return this._withDidMutation(didUri, () => operation({
      update: async (params): Promise<BearerDid> => {
        if (params.portableDid.uri !== didUri) {
          throw new Error(`AgentDidApi: Mutation for '${didUri}' cannot update '${params.portableDid.uri}'.`);
        }
        return this._update(params);
      },
    }));
  }

  public async update(params: DidUpdateParams): Promise<BearerDid> {
    return this._withDidMutation(params.portableDid.uri, () => this._update(params));
  }

  /** Perform an update while the caller holds the DID mutation turn. */
  private async _update(params: DidUpdateParams): Promise<BearerDid> {
    return this._withKeyMutation(() => this._performUpdate(params));
  }

  /** Perform an update while the caller holds both DID and KMS mutation turns. */
  private async _performUpdate({ force = false, tenant, portableDid, publish = true }:
    DidUpdateParams
  ): Promise<BearerDid> {

    // Check if the DID exists in the store.
    const existingDid = await this.get({ didUri: portableDid.uri, tenant: tenant ?? portableDid.uri });
    if (!existingDid) {
      throw new Error(`AgentDidApi: Could not update, DID not found: ${portableDid.uri}`);
    }

    // If the document has not changed, abort the update.
    if (!force && canonicalize(portableDid.document) === canonicalize(existingDid.document)) {
      throw new Error('AgentDidApi: No changes detected, update aborted');
    }

    const parsedDid = Did.parse(portableDid.uri);
    if (publish && parsedDid?.method !== 'dht') {
      throw new Error(`AgentDidApi: DID method does not support publishing document updates: ${portableDid.uri}`);
    }

    // If private keys are present in the PortableDid, import the key material into the Agent's key
    // manager. At least one verification method must be controlled locally; public-only methods
    // controlled elsewhere remain part of the authoritative DID document.
    // NOTE: We currently do not delete the previous keys from the document.
    // TODO: Add support for deleting the keys no longer present in the document.
    const bearerDid = await BearerDid.import({ keyManager: this.agent.keyManager, portableDid });

    let published = false;
    if (publish) {
      // currently only supporting DHT as a publishable method.
      // TODO: abstract this into the didMethod class so that other publishable methods can be supported.
      const registrationResult = await DidDht.publish({ did: bearerDid });
      if (
        registrationResult.didDocumentMetadata.published !== true
        || registrationResult.didDocument === null
      ) {
        throw new Error(`AgentDidApi: Failed to publish DID document: ${bearerDid.uri}`);
      }
      bearerDid.document = registrationResult.didDocument;
      bearerDid.metadata = registrationResult.didDocumentMetadata;
      published = true;

      // Publication is authoritative even if the subsequent local store write fails. Advance the
      // generation before any await so a pre-publication refresh cannot overwrite this result.
      this._resolutionGeneration.set(
        bearerDid.uri,
        (this._resolutionGeneration.get(bearerDid.uri) ?? 0) + 1
      );
      try {
        await this.cache.set(bearerDid.uri, {
          didDocument           : bearerDid.document,
          didDocumentMetadata   : bearerDid.metadata,
          didResolutionMetadata : {},
        });
      } catch {
        await this.cache.delete(bearerDid.uri).catch((): void => {});
      }
    }

    // Commit local state only after an authoritative publication succeeds. This prevents the
    // resolver cache and DID store from claiming endpoints that were never published.
    const { uri, document, metadata } = bearerDid;
    const portableDidWithoutKeys: PortableDid = { uri, document, metadata };
    try {
      await this._store.set({
        id             : uri,
        data           : portableDidWithoutKeys,
        agent          : this.agent,
        tenant         : tenant ?? uri,
        updateExisting : true,
        useCache       : true
      });
      await this._setManagedKeyOwnership({ didUri: uri, document, tenant: tenant ?? uri });
    } catch (cause: unknown) {
      if (published) {
        throw new DidUpdateLocalCommitError({ cause, didUri: uri, published: true });
      }
      throw cause;
    }

    if (!published) {
      this._resolutionGeneration.set(uri, (this._resolutionGeneration.get(uri) ?? 0) + 1);
    }
    try {
      await this.cache.set(uri, { didDocument: document, didResolutionMetadata: { }, didDocumentMetadata: metadata });
    } catch {
      // Publication and durable DID storage are authoritative; cache writes are best-effort.
    }

    return bearerDid;
  }

  public async import(params: DidImportParams): Promise<BearerDid> {
    return this._withDidMutation(params.portableDid.uri, async () => {
      return this._withKeyMutation(async () => {
        const transaction = await this._import(params);
        return transaction.bearerDid;
      });
    });
  }

  /**
   * Import a DID and run a caller-owned durable commit in the same mutation turn.
   * If that commit fails, only state created by this import is rolled back.
   *
   * @internal
   */
  public async importWithCommit<TResult>({ commit, ...params }: DidImportParams & {
    commit: (bearerDid: BearerDid) => Promise<TResult>;
  }): Promise<TResult> {
    return this._withDidMutation(params.portableDid.uri, async () => {
      return this._withKeyMutation(async () => {
        const transaction = await this._import(params);
        try {
          return await commit(transaction.bearerDid);
        } catch (cause: unknown) {
          try {
            await this._rollbackImport({
              transaction,
              tenant: params.tenant ?? params.portableDid.uri,
            });
          } catch (rollbackCause: unknown) {
            throw new AggregateError(
              [cause, rollbackCause],
              `AgentDidApi: Import commit and rollback both failed: ${params.portableDid.uri}`
            );
          }
          throw cause;
        }
      });
    });
  }

  /** Import a DID while the caller holds the DID mutation turn. */
  private async _import({ portableDid, tenant }: DidImportParams): Promise<DidImportTransaction> {
    const keysToImport = await this._preflightImport(portableDid, tenant);
    const newlyImportedKeyUris: string[] = [];
    let bearerDid: BearerDid;
    try {
      for (const { key, keyUri } of keysToImport) {
        await this.agent.keyManager.importKey({ key });
        newlyImportedKeyUris.push(keyUri);
      }

      // Keys were imported explicitly above so their ownership can be tracked
      // precisely for rollback. BearerDid performs document/control validation
      // without receiving caller-supplied keys that it could import implicitly.
      bearerDid = await BearerDid.import({
        keyManager  : this.agent.keyManager,
        portableDid : { ...portableDid, privateKeys: undefined },
      });

      // A newly imported DID may be the signer needed to inspect its own tenant partition, so the
      // durable reference scan must happen after its key is available. The global KMS mutation
      // fence keeps another DID import/delete from racing this check, and any keys imported by this
      // transaction are removed if an existing managed DID already references them.
      const otherManagedKeyUris = await this._getManagedKeyReferences({
        excludeDidUri : portableDid.uri,
        tenant        : tenant ?? portableDid.uri,
      });
      const locallyControlledKeyUris = new Set<string>();
      for (const verificationMethod of didUtils.getVerificationMethods({ didDocument: portableDid.document })) {
        if (verificationMethod.publicKeyJwk === undefined) {
          continue;
        }
        locallyControlledKeyUris.add(
          await this.agent.keyManager.getKeyUri({ key: verificationMethod.publicKeyJwk })
        );
      }
      for (const suppliedKey of portableDid.privateKeys ?? []) {
        locallyControlledKeyUris.add(await this.agent.keyManager.getKeyUri({ key: suppliedKey }));
      }
      for (const keyUri of locallyControlledKeyUris) {
        if (!otherManagedKeyUris.has(keyUri)) {
          continue;
        }
        const hasPrivateKey = await this.agent.keyManager.exportKey({ keyUri })
          .then((key) => 'd' in key && typeof key.d === 'string')
          .catch(() => false);
        if (hasPrivateKey) {
          throw new Error(`AgentDidApi: Key '${keyUri}' is already referenced by another managed DID.`);
        }
      }
    } catch (cause: unknown) {
      await this._rollbackImportedKeys(newlyImportedKeyUris);
      throw cause;
    }

    // Only the DID URI, document, and metadata are stored in the Agent's DID store.
    const { uri, document, metadata } = bearerDid;
    const portableDidWithoutKeys: PortableDid = { uri, document, metadata };

    // Store the DID in the agent's DID store.
    // Unless an existing `tenant` is specified, a record that includes the DID's URI, document,
    // and metadata will be stored under a new tenant controlled by the imported DID.
    try {
      await this._store.set({
        id                : portableDidWithoutKeys.uri,
        data              : portableDidWithoutKeys,
        agent             : this.agent,
        tenant            : tenant ?? portableDidWithoutKeys.uri,
        preventDuplicates : true,
        useCache          : true
      });
      await this._setManagedKeyOwnership({ didUri: uri, document, tenant: tenant ?? uri });
    } catch (cause: unknown) {
      await this._rollbackImportedKeys(newlyImportedKeyUris);
      throw cause;
    }

    // Do not let a caller-supplied portable snapshot enter routing state unless its durable import
    // completed successfully.
    this._resolutionGeneration.set(uri, (this._resolutionGeneration.get(uri) ?? 0) + 1);
    try {
      await this.cache.set(uri, {
        didDocument           : document,
        didDocumentMetadata   : metadata,
        didResolutionMetadata : {},
      });
    } catch {
      // Durable DID storage is authoritative; cache writes are best-effort.
    }

    return { bearerDid, newlyImportedKeyUris };
  }

  /** Validate key/document integrity without mutating the configured KMS. */
  private async _preflightImport(portableDid: PortableDid, tenant?: string): Promise<{
    key: NonNullable<PortableDid['privateKeys']>[number];
    keyUri: string;
  }[]> {
    if (portableDid.document.id !== portableDid.uri) {
      throw new Error(
        `AgentDidApi: Portable DID document id '${portableDid.document.id}' does not match '${portableDid.uri}'.`
      );
    }

    const verificationMethods = didUtils.getVerificationMethods({ didDocument: portableDid.document });
    if (verificationMethods.length === 0) {
      throw new Error(`AgentDidApi: DID '${portableDid.uri}' has no verification methods.`);
    }

    const verificationKeyUris = new Set<string>();
    for (const verificationMethod of verificationMethods) {
      if (verificationMethod.publicKeyJwk === undefined) {
        throw new Error(`Verification method '${verificationMethod.id}' does not contain a public key in JWK format`);
      }
      verificationKeyUris.add(await this.agent.keyManager.getKeyUri({ key: verificationMethod.publicKeyJwk }));
    }

    const suppliedKeyEntries: {
      key: NonNullable<PortableDid['privateKeys']>[number];
      keyUri: string;
    }[] = [];
    for (const key of portableDid.privateKeys ?? []) {
      if (!('d' in key) || typeof key.d !== 'string') {
        throw new Error(`AgentDidApi: Supplied key for '${portableDid.uri}' does not contain private key material.`);
      }
      const keyUri = await this.agent.keyManager.getKeyUri({ key });
      suppliedKeyEntries.push({ key, keyUri });
    }

    // A did:jwk delegate carries one deterministic X25519 companion used for DWN key agreement,
    // even though did:jwk can only advertise its Ed25519 verification method. Accept that narrow
    // transport key only when both its URI and private material match conversion of a supplied,
    // authoritative Ed25519 private key. Arbitrary extra keys remain rejected before KMS mutation.
    const allowsDerivedX25519Companion = Did.parse(portableDid.uri)?.method === 'jwk';
    const derivedX25519Keys = new Map<string, NonNullable<PortableDid['privateKeys']>[number]>();
    if (allowsDerivedX25519Companion) {
      for (const { key, keyUri } of suppliedKeyEntries) {
        if (key.crv !== 'Ed25519' || !verificationKeyUris.has(keyUri)) {
          continue;
        }
        const computedPublicKey = await Ed25519.computePublicKey({ key });
        const computedPublicKeyUri = await this.agent.keyManager.getKeyUri({ key: computedPublicKey });
        if (computedPublicKeyUri !== keyUri) {
          throw new Error(
            `AgentDidApi: Supplied Ed25519 private key does not control authoritative key '${keyUri}'.`
          );
        }
        const derivedKey = await Ed25519.convertPrivateKeyToX25519({ privateKey: key });
        const derivedKeyUri = await this.agent.keyManager.getKeyUri({ key: derivedKey });
        derivedX25519Keys.set(derivedKeyUri, derivedKey);
      }
    }

    const suppliedKeys = new Map<string, NonNullable<PortableDid['privateKeys']>[number]>();
    const suppliedVerificationKeyUris = new Set<string>();
    for (const { key, keyUri } of suppliedKeyEntries) {
      if (verificationKeyUris.has(keyUri)) {
        suppliedVerificationKeyUris.add(keyUri);
      } else {
        const derivedKey = derivedX25519Keys.get(keyUri);
        const isDerivedCompanion = derivedKey !== undefined
          && key.kty === 'OKP'
          && key.crv === 'X25519'
          && derivedKey.d === key.d
          && derivedKey.x === key.x;
        if (!isDerivedCompanion) {
          throw new Error(`AgentDidApi: Supplied private key '${keyUri}' does not match the authoritative DID document.`);
        }
      }
      suppliedKeys.set(keyUri, key);
    }

    // Same-process ownership is safe to inspect before key mutation. The durable tenant scan is
    // performed after import because a new DID's private key is required to query its own DWN.
    const storageTenant = tenant ?? portableDid.uri;
    const otherManagedKeyUris = this._getIndexedKeyReferences({
      excludeDidUri : portableDid.uri,
      tenant        : storageTenant,
    });
    await this._assertDhtIdentityKeyControl({
      portableDid,
      verificationMethods,
      suppliedKeyUris: suppliedVerificationKeyUris,
      otherManagedKeyUris,
    });
    for (const keyUri of suppliedKeys.keys()) {
      if (otherManagedKeyUris.has(keyUri)) {
        throw new Error(`AgentDidApi: Key '${keyUri}' is already referenced by another managed DID.`);
      }
    }

    let controlsVerificationMethod = false;
    for (const keyUri of verificationKeyUris) {
      if (suppliedVerificationKeyUris.has(keyUri)) {
        controlsVerificationMethod = true;
        continue;
      }
      const hasPrivateKey = await this.agent.keyManager.exportKey({ keyUri })
        .then((key) => 'd' in key && typeof key.d === 'string')
        .catch(() => false);
      controlsVerificationMethod ||= hasPrivateKey && !otherManagedKeyUris.has(keyUri);
    }
    if (!controlsVerificationMethod) {
      throw new Error(`AgentDidApi: No supplied or existing private key controls '${portableDid.uri}'.`);
    }

    const keysToImport: {
      key: NonNullable<PortableDid['privateKeys']>[number];
      keyUri: string;
    }[] = [];
    for (const [keyUri, key] of suppliedKeys) {
      const publicKeyExists = await this.agent.keyManager.getPublicKey({ keyUri })
        .then(() => true)
        .catch(() => false);
      if (!publicKeyExists) {
        keysToImport.push({ key, keyUri });
        continue;
      }
      const existingPrivateKey = await this.agent.keyManager.exportKey({ keyUri })
        .then((existingKey) => 'd' in existingKey && typeof existingKey.d === 'string' ? existingKey : undefined)
        .catch(() => undefined);
      if (existingPrivateKey === undefined) {
        throw new Error(`AgentDidApi: Existing key '${keyUri}' is public-only and cannot control '${portableDid.uri}'.`);
      }
      if (existingPrivateKey.d !== key.d) {
        throw new Error(`AgentDidApi: Existing key '${keyUri}' has different private key material.`);
      }
    }
    return keysToImport;
  }

  /** Require the private, URI-bound `#0` identity key needed for every did:dht publication. */
  private async _assertDhtIdentityKeyControl({
    portableDid, verificationMethods, suppliedKeyUris, otherManagedKeyUris,
  }: {
    portableDid: PortableDid;
    verificationMethods: DidVerificationMethod[];
    suppliedKeyUris: Set<string>;
    otherManagedKeyUris: Set<string>;
  }): Promise<void> {
    if (Did.parse(portableDid.uri)?.method !== DidDht.methodName) {
      return;
    }

    const identityMethod = verificationMethods.find((method) => method.id.split('#').pop() === '0');
    if (identityMethod?.publicKeyJwk === undefined) {
      throw new Error(`AgentDidApi: did:dht DID '${portableDid.uri}' must contain an identity key at '#0'.`);
    }

    const [identityKeyUri, expectedIdentityKey] = await Promise.all([
      this.agent.keyManager.getKeyUri({ key: identityMethod.publicKeyJwk }),
      DidDhtUtils.identifierToIdentityKey({ didUri: portableDid.uri }),
    ]);
    const expectedIdentityKeyUri = await this.agent.keyManager.getKeyUri({ key: expectedIdentityKey });
    if (identityKeyUri !== expectedIdentityKeyUri) {
      throw new Error(`AgentDidApi: did:dht identity key '#0' does not match '${portableDid.uri}'.`);
    }
    if (otherManagedKeyUris.has(identityKeyUri)) {
      throw new Error(`AgentDidApi: did:dht identity key '${identityKeyUri}' is already referenced by another managed DID.`);
    }

    const hasPrivateIdentityKey = suppliedKeyUris.has(identityKeyUri)
      || await this.agent.keyManager.exportKey({ keyUri: identityKeyUri })
        .then((key) => 'd' in key && typeof key.d === 'string')
        .catch(() => false);
    if (!hasPrivateIdentityKey) {
      throw new Error(`AgentDidApi: No private did:dht identity key '#0' controls '${portableDid.uri}'.`);
    }
  }

  /** Return key URIs referenced by every other managed DID in one tenant partition. */
  private async _getManagedKeyReferences({ excludeDidUri, tenant }: {
    excludeDidUri: string;
    tenant: string;
  }): Promise<Set<string>> {
    const references = this._getIndexedKeyReferences({ excludeDidUri, tenant });
    const managedDids = await this._store.list({ agent: this.agent, tenant });
    for (const managedDid of managedDids) {
      if (managedDid.uri === excludeDidUri) {
        continue;
      }
      const verificationMethods = didUtils.getVerificationMethods({ didDocument: managedDid.document });
      for (const verificationMethod of verificationMethods) {
        if (verificationMethod.publicKeyJwk !== undefined) {
          references.add(await this.agent.keyManager.getKeyUri({ key: verificationMethod.publicKeyJwk }));
        }
      }
    }
    return references;
  }

  /** Return same-process key ownership held by a different managed DID. */
  private _getIndexedKeyReferences({ excludeDidUri, tenant }: {
    excludeDidUri: string;
    tenant?: string;
  }): Set<string> {
    const excludedOwner = tenant === undefined
      ? undefined
      : this._getManagedKeyOwner({ didUri: excludeDidUri, tenant });
    const references = new Set<string>();
    for (const [keyUri, owners] of this._managedKeyOwners) {
      if ([...owners].some((owner) => owner !== excludedOwner)) {
        references.add(keyUri);
      }
    }
    return references;
  }

  /** Replace one DID's same-process ownership entries from its committed document. */
  private async _setManagedKeyOwnership({ didUri, document, tenant }: {
    didUri: string;
    document: DidDocument | undefined;
    tenant: string;
  }): Promise<void> {
    const owner = this._getManagedKeyOwner({ didUri, tenant });
    for (const [keyUri, owners] of this._managedKeyOwners) {
      owners.delete(owner);
      if (owners.size === 0) {
        this._managedKeyOwners.delete(keyUri);
      }
    }
    if (document === undefined) {
      return;
    }
    const verificationMethods = didUtils.getVerificationMethods({ didDocument: document });
    for (const verificationMethod of verificationMethods) {
      if (verificationMethod.publicKeyJwk === undefined) {
        continue;
      }
      const keyUri = await this.agent.keyManager.getKeyUri({ key: verificationMethod.publicKeyJwk });
      const privateKey = await this.agent.keyManager.exportKey({ keyUri })
        .then((key) => 'd' in key && typeof key.d === 'string' ? key : undefined)
        .catch(() => undefined);
      if (privateKey === undefined) {
        continue;
      }
      const owners = this._managedKeyOwners.get(keyUri) ?? new Set<string>();
      owners.add(owner);
      this._managedKeyOwners.set(keyUri, owners);

      // did:jwk delegates may carry their deterministic X25519 key off-document. Index its URI
      // directly from the already-exported authoritative Ed25519 private key so tenant-partition
      // ownership is retained without probing a possibly absent KMS entry (which can rebuild
      // persistent-store indexes on a negative lookup).
      if (Did.parse(didUri)?.method === 'jwk' && privateKey.crv === 'Ed25519') {
        const derivedKey = await Ed25519.convertPrivateKeyToX25519({ privateKey });
        const derivedKeyUri = await this.agent.keyManager.getKeyUri({ key: derivedKey });
        const derivedOwners = this._managedKeyOwners.get(derivedKeyUri) ?? new Set<string>();
        derivedOwners.add(owner);
        this._managedKeyOwners.set(derivedKeyUri, derivedOwners);
      }
    }
  }

  /** Identify one durable DID record independently from copies in other tenant partitions. */
  private _getManagedKeyOwner({ didUri, tenant }: { didUri: string; tenant: string }): string {
    return `${tenant}\u0000${didUri}`;
  }

  /** Remove only keys whose import succeeded in the current transaction. */
  private async _rollbackImportedKeys(keyUris: string[]): Promise<void> {
    const failures: unknown[] = [];
    for (const keyUri of [...keyUris].reverse()) {
      try {
        await this.agent.keyManager.deleteKey({ keyUri });
      } catch (cause: unknown) {
        const stillExists = await this.agent.keyManager.getPublicKey({ keyUri })
          .then(() => true)
          .catch(() => false);
        if (stillExists) {
          failures.push(cause);
        }
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'AgentDidApi: Failed to roll back imported keys.');
    }
  }

  /** Roll back the managed DID snapshot and transaction-owned keys. */
  private async _rollbackImport({ transaction, tenant }: {
    transaction: DidImportTransaction;
    tenant: string;
  }): Promise<void> {
    const didUri = transaction.bearerDid.uri;
    const deleted = await this._store.delete({ id: didUri, agent: this.agent, tenant });
    if (!deleted) {
      throw new Error(
        `AgentDidApi: Failed to roll back imported DID '${didUri}'; durable state was not deleted and keys were retained.`
      );
    }
    await this._setManagedKeyOwnership({ didUri, document: undefined, tenant });
    this._resolutionGeneration.set(didUri, (this._resolutionGeneration.get(didUri) ?? 0) + 1);
    const failures: unknown[] = [];
    try {
      await this.cache.delete(didUri);
    } catch (cause: unknown) {
      failures.push(new Error(
        `AgentDidApi: Resolver cache still contains rolled-back DID '${didUri}'.`,
        { cause }
      ));
    }
    try {
      await this._rollbackImportedKeys(transaction.newlyImportedKeyUris);
    } catch (cause: unknown) {
      failures.push(cause);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `AgentDidApi: Import rollback left partial state for '${didUri}'.`);
    }
  }

  public async delete({ didUri, tenant, deleteKey = true }: {
    didUri: string;
    tenant?: string;
    deleteKey?: boolean;
  }): Promise<void> {
    return this._withDidMutation(didUri, () => {
      return this._withKeyMutation(() => this._delete({ didUri, tenant, deleteKey }));
    });
  }

  /** Purge a DID while the caller holds the DID mutation turn. */
  private async _delete({ didUri, tenant, deleteKey }: {
    didUri: string;
    tenant?: string;
    deleteKey: boolean;
  }): Promise<void> {
    const portableDid = await this._store.get({ id: didUri, agent: this.agent, tenant, useCache: false });
    if (!portableDid) {
      throw new Error('AgentDidApi: Could not delete, DID not found');
    }

    const storageTenant = tenant ?? this.agent.agentDid.uri;
    const referencedByOtherDids = await this._getManagedKeyReferences({
      excludeDidUri : didUri,
      tenant        : storageTenant,
    });

    // Delete durable DID data before associated private keys so a failed store
    // mutation never leaves a managed document whose signing key was removed.
    const deleted = await this._store.delete({ id: didUri, agent: this.agent, tenant });
    if (!deleted) {
      throw new Error(`AgentDidApi: Failed to delete durable DID state: ${didUri}`);
    }
    await this._setManagedKeyOwnership({ didUri, document: undefined, tenant: storageTenant });
    this._resolutionGeneration.set(didUri, (this._resolutionGeneration.get(didUri) ?? 0) + 1);
    const cleanupFailures: unknown[] = [];
    try {
      await this.cache.delete(didUri);
    } catch (cause: unknown) {
      cleanupFailures.push(new Error(
        `AgentDidApi: Resolver cache still contains deleted DID '${didUri}'.`,
        { cause }
      ));
    }

    if (deleteKey) {
      try {
        await this._deleteKeys({ portableDid, referencedByOtherDids });
      } catch (cause: unknown) {
        cleanupFailures.push(cause);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, `AgentDidApi: DID deletion left partial state for '${didUri}'.`);
    }
  }

  public async deleteKeys({ portableDid, tenant }: {
    portableDid: PortableDid;
    tenant?: string;
  }): Promise<void> {
    return this._withKeyMutation(async () => {
      const referencedByOtherDids = this._getIndexedKeyReferences({
        excludeDidUri : portableDid.uri,
        tenant        : tenant ?? portableDid.uri,
      });
      await this._deleteKeys({ portableDid, referencedByOtherDids });
    });
  }

  /** Delete locally controlled keys while the caller holds the KMS mutation turn. */
  private async _deleteKeys({ portableDid, referencedByOtherDids }: {
    portableDid: PortableDid;
    referencedByOtherDids: Set<string>;
  }): Promise<void> {
    const localPrivateKeyUris = new Set<string>();
    for (const verificationMethod of portableDid.document.verificationMethod || []) {
      if (!verificationMethod.publicKeyJwk) {
        continue;
      }
      const keyUri = await this.agent.keyManager.getKeyUri({ key: verificationMethod.publicKeyJwk });
      try {
        const key = await this.agent.keyManager.exportKey({ keyUri });
        if ('d' in key && typeof key.d === 'string') {
          localPrivateKeyUris.add(keyUri);
          if (Did.parse(portableDid.uri)?.method === 'jwk' && key.crv === 'Ed25519') {
            const derivedKey = await Ed25519.convertPrivateKeyToX25519({ privateKey: key });
            const derivedKeyUri = await this.agent.keyManager.getKeyUri({ key: derivedKey });
            const hasDerivedPrivateKey = await this.agent.keyManager.exportKey({ keyUri: derivedKeyUri })
              .then((candidate) => 'd' in candidate && typeof candidate.d === 'string')
              .catch(() => false);
            if (hasDerivedPrivateKey) {
              localPrivateKeyUris.add(derivedKeyUri);
            }
          }
        }
      } catch {
        // Public-only and externally controlled verification methods are part
        // of the authoritative document but are not owned by this agent.
      }
    }

    for (const keyUri of localPrivateKeyUris) {
      if (referencedByOtherDids.has(keyUri)) {
        continue;
      }
      try {
        await this.agent.keyManager.deleteKey({ keyUri });
      } catch (cause: unknown) {
        const stillExists = await this.agent.keyManager.getPublicKey({ keyUri })
          .then(() => true)
          .catch(() => false);
        if (stillExists) {
          throw cause;
        }
        // A concurrent or prior purge already removed the key.
      }
    }
  }

  public async processRequest<T extends DidInterface>(
    request: DidRequest<T>
  ): Promise<DidResponse<T>> {
    // Process Create DID request.
    if (isDidRequest(request, DidInterface.Create)) {
      try {
        const bearerDid = await this.create({ ...request.messageParams });
        const response: DidResponse<typeof request.messageType> = {
          result: {
            uri      : bearerDid.uri,
            document : bearerDid.document,
            metadata : bearerDid.metadata,
          },
          ok     : true,
          status : { code: 201, message: 'Created' }
        };
        return response;

      } catch (error: any) {
        return {
          ok     : false,
          status : { code: 500, message: error.message ?? 'Unknown error occurred' }
        };
      }
    }

    // Process Resolve DID request.
    if (isDidRequest(request, DidInterface.Resolve)) {
      const { didUri, options } = request.messageParams;
      const resolutionResult = await this.resolve(didUri, options);
      const response: DidResponse<typeof request.messageType> = {
        result : resolutionResult,
        ok     : true,
        status : { code: 200, message: 'OK' }
      };
      return response;
    }

    throw new Error(`AgentDidApi: Unsupported request type: ${request.messageType}`);
  }

  private getMethod(methodName: string): DidMethodApi {
    const didMethodApi = this._didMethods.get(methodName);

    if (didMethodApi === undefined) {
      throw new Error(`DID Method not supported: ${methodName}`);
    }

    return didMethodApi;
  }
}
