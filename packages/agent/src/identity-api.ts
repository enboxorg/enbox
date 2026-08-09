import type { DwnEndpointResolution } from '@enbox/dids';
import type { RequireOnly } from '@enbox/common';

import type { AgentDataStore } from './store-data.js';
import type { AgentKeyManager } from './types/key-manager.js';
import type { DidMethodCreateOptions } from './did-api.js';
import type { EnboxPlatformAgent } from './types/agent.js';
import type { IdentityMetadata, PortableIdentity } from './types/identity.js';

import { BearerIdentity } from './bearer-identity.js';
import { canonicalize } from '@enbox/crypto';
import { DidUpdateLocalCommitError } from './did-api.js';
import { InMemoryIdentityStore } from './store-identity.js';
import { logger } from '@enbox/common';
import { publishServiceConfig } from './service-config.js';
import {
  DwnEndpointResolutionError,
  DwnEndpointResolutionErrorCode,
  extractDwnServiceEndpointUrls,
  isDwnEndpointResolutionError,
  isPortableDid,
  resolveDwnEndpointStatus,
  setDwnServiceEndpointUrls,
} from '@enbox/dids';

export interface IdentityApiParams<TKeyManager extends AgentKeyManager> {
  agent?: EnboxPlatformAgent<TKeyManager>;

  store?: AgentDataStore<IdentityMetadata>;
}

export interface IdentityCreateParams<
  TKeyManager = AgentKeyManager,
  TMethod extends keyof DidMethodCreateOptions<TKeyManager> = keyof DidMethodCreateOptions<TKeyManager>
> {
  metadata: RequireOnly<IdentityMetadata, 'name'>;
  didMethod?: TMethod;
  didOptions?: DidMethodCreateOptions<TKeyManager>[TMethod];
  store?: boolean;
}

export function isPortableIdentity(obj: unknown): obj is PortableIdentity {
  // Validate that the given value is an object that has the necessary properties of PortableIdentity.
  return !(!obj || typeof obj !== 'object' || obj === null)
    && 'did' in obj
    && 'metadata' in obj
    && isPortableDid(obj.did);
}

/**
 * This API is used to manage and interact with Identities within the Enbox Agent framework.
 * An Identity is a DID that is associated with metadata that describes the Identity.
 * Metadata includes A name(label), and whether or not the Identity is connected (delegated to act on the behalf of another DID).
 *
 * A KeyManager is used to manage the cryptographic keys associated with the Identities.
 *
 * The `DidApi` is used internally to create, store, and manage DIDs.
 * When a DWN Data Store is used, the Identity and DID information are stored under the Agent DID's tenant.
 */
export class AgentIdentityApi<TKeyManager extends AgentKeyManager = AgentKeyManager> {
  /** Capability marker for consumers that require authoritative, rollback-safe portable DID import. */
  public readonly supportsAuthoritativeDidImport = true;

  /**
   * Holds the instance of a `EnboxPlatformAgent` that represents the current execution context for
   * the `AgentIdentityApi`. This agent is used to interact with other Enbox agent components. It's
   * vital to ensure this instance is set to correctly contextualize operations within the broader
   * Enbox Agent framework.
   */
  private _agent?: EnboxPlatformAgent<TKeyManager>;

  private readonly _dwnEndpointUpdateTails = new Map<string, Promise<void>>();

  private readonly _identityImportTails = new Map<string, Promise<void>>();

  private readonly _store: AgentDataStore<IdentityMetadata>;

  constructor({ agent, store }: IdentityApiParams<TKeyManager> = {}) {
    this._agent = agent;

    // If `store` is not given, use an in-memory store by default.
    this._store = store ?? new InMemoryIdentityStore();
  }

  /**
   * Retrieves the `EnboxPlatformAgent` execution context.
   *
   * @returns The `EnboxPlatformAgent` instance that represents the current execution context.
   * @throws Will throw an error if the `agent` instance property is undefined.
   */
  get agent(): EnboxPlatformAgent<TKeyManager> {
    if (this._agent === undefined) {
      throw new Error('AgentIdentityApi: Unable to determine agent execution context.');
    }

    return this._agent;
  }

  set agent(agent: EnboxPlatformAgent<TKeyManager>) {
    this._agent = agent;
  }

  get tenant(): string {
    if (!this._agent) {
      throw new Error('AgentIdentityApi: The agent must be set to perform tenant specific actions.');
    }

    return this._agent.agentDid.uri;
  }

  public async create({ metadata, didMethod = 'dht', didOptions, store }:
    IdentityCreateParams<TKeyManager>
  ): Promise<BearerIdentity> {

    const bearerDid = await this.agent.did.create({
      method  : didMethod,
      options : didOptions,
      tenant  : this.tenant,
      store,
    });

    // Create the BearerIdentity object.
    const identity = new BearerIdentity({
      did      : bearerDid,
      metadata : { ...metadata, uri: bearerDid.uri, tenant: this.tenant }
    });

    // Persist the Identity to the store, by default, unless the `store` option is set to false.
    if (store ?? true) {
      await this._store.set({
        id                : identity.did.uri,
        data              : identity.metadata,
        agent             : this.agent,
        tenant            : identity.metadata.tenant,
        preventDuplicates : false,
        useCache          : true
      });
      this.agent.dwn.invalidateLocalManagedDidCache();
    }

    return identity;
  }

  public async export({ didUri }: {
    didUri: string;
  }): Promise<PortableIdentity> {
    const bearerIdentity = await this.get({ didUri });

    if (!bearerIdentity) {
      throw new Error(`AgentIdentityApi: Failed to export due to Identity not found: ${didUri}`);
    }

    // If the Identity was found, return the Identity in a portable format, and if supported by the
    // Agent's key manager, the private key material.
    const portableIdentity = await bearerIdentity.export();

    return portableIdentity;
  }

  public async get({ didUri }: {
    didUri: string;
  }): Promise<BearerIdentity | undefined> {
    const storedIdentity = await this._store.get({ id: didUri, agent: this.agent, useCache: true });

    // If the Identity is not found in the store, return undefined.
    if (!storedIdentity) {return undefined;}

    // Retrieve the DID from the Agent's DID store using the tenant value from the stored
    // Identity's metadata.
    const storedDid = await this.agent.did.get({ didUri, tenant: storedIdentity.tenant });

    // If the Identity is present but the DID is not found, throw an error.
    if (!storedDid) {
      throw new Error(`AgentIdentityApi: Identity is present in the store but DID is missing: ${didUri}`);
    }

    // Create the BearerIdentity object.
    const identity = new BearerIdentity({ did: storedDid, metadata: storedIdentity });

    return identity;
  }

  public async import({ portableIdentity }: {
    portableIdentity: PortableIdentity;
  }): Promise<BearerIdentity> {
    const didUri = portableIdentity.portableDid.uri;
    const previous = this._identityImportTails.get(didUri) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => turn);
    this._identityImportTails.set(didUri, tail);

    await previous;
    try {
      return await this._import({ portableIdentity });
    } finally {
      release();
      if (this._identityImportTails.get(didUri) === tail) {
        this._identityImportTails.delete(didUri);
      }
    }
  }

  /** Import one identity while holding its per-DID integrity turn. */
  private async _import({ portableIdentity }: {
    portableIdentity: PortableIdentity;
  }): Promise<BearerIdentity> {
    const didUri = portableIdentity.portableDid.uri;
    if (portableIdentity.metadata.uri !== didUri) {
      throw new Error(
        `AgentIdentityApi: Identity metadata URI '${portableIdentity.metadata.uri}' does not match DID '${didUri}'.`
      );
    }
    await this._assertIdentityImportAvailable(didUri);

    let resolution;
    try {
      resolution = await this.agent.did.refreshResolution(didUri);
    } catch (cause: unknown) {
      throw new DwnEndpointResolutionError({
        code    : DwnEndpointResolutionErrorCode.DidResolutionFailed,
        didUri,
        message : `Unable to resolve DID '${didUri}' before importing its identity.`,
        cause,
      });
    }
    if (resolution.didResolutionMetadata.error !== undefined || resolution.didDocument === null) {
      throw new Error(
        `AgentIdentityApi: Failed to import because authoritative DID resolution failed for '${didUri}': `
        + JSON.stringify(resolution.didResolutionMetadata)
      );
    }
    await this._assertIdentityImportAvailable(didUri);

    // Reconcile the portable keys with the authoritative public document before
    // importing anything into the KMS or durable stores. Portable snapshots are
    // key transport, not routing authority.
    const metadata: IdentityMetadata = { ...portableIdentity.metadata, tenant: this.tenant };
    const portableDid = {
      ...portableIdentity.portableDid,
      document : resolution.didDocument,
      metadata : resolution.didDocumentMetadata,
    };

    return this.agent.did.importWithCommit({
      portableDid,
      tenant : metadata.tenant,
      commit : async (storedDid): Promise<BearerIdentity> => {
        const identity = new BearerIdentity({ did: storedDid, metadata });
        await this._store.set({
          id                : identity.did.uri,
          data              : identity.metadata,
          agent             : this.agent,
          tenant            : identity.metadata.tenant,
          preventDuplicates : true,
          useCache          : true
        });
        this.agent.dwn.invalidateLocalManagedDidCache();
        return identity;
      },
    });
  }

  /** Reject a duplicate before any key or durable DID mutation begins. */
  private async _assertIdentityImportAvailable(didUri: string): Promise<void> {
    const existing = await this._store.get({ id: didUri, agent: this.agent, useCache: true });
    if (existing !== undefined) {
      throw new Error(`AgentIdentityApi: Identity already exists: ${didUri}`);
    }
  }

  public async list({ tenant }: {
    tenant?: string;
  } = {}): Promise<BearerIdentity[]> {
    // Retrieve the list of Identities from the Agent's Identity store.
    const storedIdentities = await this._store.list({ agent: this.agent, tenant });

    const identities = await Promise.all(storedIdentities.map(metadata => this.get({ didUri: metadata.uri })));

    return identities.filter(identity => identity !== undefined) as BearerIdentity[];
  }

  public async delete({ didUri }:{
    didUri: string;
  }): Promise<void> {
    const storedIdentity = await this._store.get({ id: didUri, agent: this.agent, useCache: true });
    if (!storedIdentity) {
      throw new Error(`AgentIdentityApi: Failed to purge due to Identity not found: ${didUri}`);
    }

    // Delete the Identity from the Agent's Identity store.
    await this._store.delete({ id: didUri, agent: this.agent });
    this.agent.dwn.invalidateLocalManagedDidCache();
  }

  /**
   * Returns the DWN endpoints for the given DID.
   *
   * @param didUri - The DID URI to get the DWN endpoints for.
   * @returns An array of DWN endpoints.
   * @throws An error if the DID is not found, or no DWN service exists.
   */
  public getDwnEndpoints({ didUri }: { didUri: string; }): Promise<string[]> {
    return this.agent.dwn.getRemoteDwnEndpointUrls(didUri);
  }

  /** Force resolution and return a non-throwing, application-facing endpoint status. */
  public refreshDwnEndpointStatus({ didUri }: { didUri: string }): Promise<DwnEndpointResolution> {
    return resolveDwnEndpointStatus(didUri, {
      resolve: async () => {
        const result = await this.agent.did.refreshResolutionAndReconcile({
          didUri,
          tenant: this.tenant,
        });
        if (result.didResolutionMetadata.error === undefined && result.didDocument !== null) {
          this.agent.sync.invalidateSyncTargets();
        }
        return result;
      },
    });
  }

  /**
   * Force resolution of a DID document and return its advertised DWN endpoints.
   *
   * The sync target plan is invalidated only after successful resolution. Expected
   * absence and malformed services are surfaced as typed endpoint-resolution errors.
   */
  public async refreshDwnEndpoints({ didUri }: { didUri: string }): Promise<string[]> {
    const status = await this.refreshDwnEndpointStatus({ didUri });
    if (status.status !== 'ready') {
      throw status.error;
    }
    return status.endpoints;
  }

  /**
   * Sets the DWN endpoints for the given DID.
   *
   * @param didUri - The DID URI to set the DWN endpoints for.
   * @param endpoints - The array of DWN endpoints to set.
   * @param announce - Publish a best-effort endpoint-change prompt after the DID update. Defaults to `true`.
   * @throws An error if the DID is not found, or if an update cannot be performed.
   */
  public async setDwnEndpoints({ didUri, endpoints, announce = true }: {
    didUri: string;
    endpoints: string[];
    announce?: boolean;
  }): Promise<void> {
    const previous = this._dwnEndpointUpdateTails.get(didUri) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => turn);
    this._dwnEndpointUpdateTails.set(didUri, tail);

    await previous;
    try {
      await this._setDwnEndpoints({ didUri, endpoints, announce });
    } finally {
      release();
      if (this._dwnEndpointUpdateTails.get(didUri) === tail) {
        this._dwnEndpointUpdateTails.delete(didUri);
      }
    }
  }

  /** Execute one endpoint update while holding the per-DID update turn. */
  private async _setDwnEndpoints({ didUri, endpoints, announce }: {
    didUri: string;
    endpoints: string[];
    announce: boolean;
  }): Promise<void> {
    let previousEndpoints: string[] = [];
    let publish = false;
    const announcePublishedChange = async (): Promise<void> => {
      if (!announce || !publish) {
        return;
      }
      try {
        await this.publishServiceConfig({ didUri, deliveryEndpoints: previousEndpoints });
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(`AgentIdentityApi: Failed to publish service-config announcement for ${didUri}: ${detail}`);
      }
    };

    try {
      await this.agent.did.runMutation({
        didUri,
        operation: async ({ update }): Promise<void> => {
          const bearerDid = await this.agent.did.get({ didUri, tenant: this.tenant });
          if (!bearerDid) {
            throw new Error(`AgentIdentityApi: Failed to set DWN endpoints due to DID not found: ${didUri}`);
          }

          let resolutionResult;
          try {
            resolutionResult = await this.agent.did.refreshResolution(didUri);
          } catch (cause: unknown) {
            throw new DwnEndpointResolutionError({
              code    : DwnEndpointResolutionErrorCode.DidResolutionFailed,
              didUri,
              message : `Unable to resolve DID '${didUri}' before updating its DWN service.`,
              cause,
            });
          }

          const resolutionError = resolutionResult.didResolutionMetadata.error;
          if (resolutionError !== undefined || resolutionResult.didDocument === null) {
            throw new DwnEndpointResolutionError({
              code    : DwnEndpointResolutionErrorCode.DidResolutionFailed,
              didUri,
              message : `Unable to resolve DID '${didUri}' before updating its DWN service${
                resolutionError === undefined ? '.' : `: ${resolutionError}.`
              }`,
              resolutionError,
            });
          }

          try {
            previousEndpoints = extractDwnServiceEndpointUrls(resolutionResult.didDocument);
          } catch (error: unknown) {
            if (!isDwnEndpointResolutionError(error)) {
              throw error;
            }
          }

          const portableDid = await bearerDid.export();
          const desiredDocument = setDwnServiceEndpointUrls({
            didDocument: resolutionResult.didDocument,
            endpoints,
          });
          const matchesAuthoritativeDocument = canonicalize(desiredDocument) === canonicalize(resolutionResult.didDocument);
          const matchesStoredDocument = canonicalize(desiredDocument) === canonicalize(bearerDid.document);
          if (matchesAuthoritativeDocument && matchesStoredDocument) {
            throw new Error('AgentDidApi: No changes detected, update aborted');
          }

          portableDid.document = desiredDocument;
          portableDid.metadata = resolutionResult.didDocumentMetadata;
          publish = !matchesAuthoritativeDocument;
          await update({
            force  : publish && matchesStoredDocument,
            portableDid,
            publish,
            tenant : this.agent.agentDid.uri,
          });
        },
      });
    } catch (error: unknown) {
      if (error instanceof DidUpdateLocalCommitError && error.published && publish) {
        this.agent.sync.invalidateSyncTargets();
        await announcePublishedChange();
      }
      throw error;
    }

    this.agent.sync.invalidateSyncTargets();
    await announcePublishedChange();
  }

  /**
   * Publish a prompt that tells connected apps to freshly resolve this DID.
   *
   * The record payload is resolved from the DID document and is not treated as
   * an alternate source of endpoint configuration.
   */
  public async publishServiceConfig({ didUri, deliveryEndpoints }: {
    didUri: string;
    deliveryEndpoints?: string[];
  }): Promise<void> {
    await publishServiceConfig({
      agent    : this.agent,
      ownerDid : didUri,
      deliveryEndpoints,
    });
  }

  /**
   * Updates the Identity's metadata name field.
   *
   * @param didUri - The DID URI of the Identity to update.
   * @param name - The new name to set for the Identity.
   *
   * @throws An error if the Identity is not found, name is not provided, or no changes are detected.
   */
  public async setMetadataName({ didUri, name }: { didUri: string; name: string }): Promise<void> {
    if (!name) {
      throw new Error('AgentIdentityApi: Failed to set metadata name due to missing name value.');
    }

    const identity = await this.get({ didUri });
    if (!identity) {
      throw new Error(`AgentIdentityApi: Failed to set metadata name due to Identity not found: ${didUri}`);
    }

    if (identity.metadata.name === name) {
      throw new Error('AgentIdentityApi: No changes detected.');
    }

    // Update the name in the Identity's metadata and store it
    await this._store.set({
      id             : identity.did.uri,
      data           : { ...identity.metadata, name },
      agent          : this.agent,
      tenant         : identity.metadata.tenant,
      updateExisting : true,
      useCache       : true
    });
  }

  /**
   * Returns the connected Identity, if one is available.
   *
   * Accepts optional `connectedDid` parameter to filter the a specific connected identity,
   * if none is provided the first connected identity is returned.
   */
  public async connectedIdentity({ connectedDid }:{ connectedDid?: string } = {}): Promise<BearerIdentity | undefined> {
    const identities = await this.list();
    if (identities.length < 1) {
      return undefined;
    }

    // If a specific connected DID is provided, return the first identity that matches it.
    // Otherwise, return the first connected identity.
    return connectedDid ?
      identities.find(identity => identity.metadata.connectedDid === connectedDid) :
      identities.find(identity => identity.metadata.connectedDid !== undefined);
  }
}
