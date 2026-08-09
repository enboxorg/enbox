import type { RequireOnly } from '@enbox/common';
import type { DidDocumentMetadata, DidResolutionResult, DwnEndpointResolution } from '@enbox/dids';

import type { AgentDataStore } from './store-data.js';
import type { AgentKeyManager } from './types/key-manager.js';
import type { DidMethodCreateOptions } from './did-api.js';
import type { EnboxPlatformAgent } from './types/agent.js';
import type { IdentityMetadata, PortableIdentity } from './types/identity.js';

import { logger } from '@enbox/common';
import { Did, DidDht, DidErrorCode, getDwnEndpointStatus, isPortableDid, replaceDwnServiceEndpointUrls, resolveDwnEndpointStatus } from '@enbox/dids';

import { BearerIdentity } from './bearer-identity.js';
import { InMemoryIdentityStore } from './store-identity.js';
import { publishServiceConfigNotice } from './service-config.js';

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
  /**
   * Holds the instance of a `EnboxPlatformAgent` that represents the current execution context for
   * the `AgentIdentityApi`. This agent is used to interact with other Enbox agent components. It's
   * vital to ensure this instance is set to correctly contextualize operations within the broader
   * Enbox Agent framework.
   */
  private _agent?: EnboxPlatformAgent<TKeyManager>;

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

    // set the tenant of the portable identity to the agent's tenant
    portableIdentity.metadata.tenant = this.tenant;

    // Import the PortableDid to the Agent's DID store.
    const storedDid = await this.agent.did.import({
      portableDid : portableIdentity.portableDid,
      tenant      : portableIdentity.metadata.tenant
    });

    // Verify the DID is present in the Agent's DID store.
    if (!storedDid) {
      throw new Error(`AgentIdentityApi: Failed to import Identity: ${portableIdentity.metadata.uri}`);
    }

    // Create the BearerIdentity object.
    const identity = new BearerIdentity({ did: storedDid, metadata: portableIdentity.metadata });

    // Store the Identity metadata in the Agent's Identity store.
    await this._store.set({
      id                : identity.did.uri,
      data              : identity.metadata,
      agent             : this.agent,
      tenant            : identity.metadata.tenant,
      preventDuplicates : true,
      useCache          : true
    });

    return identity;
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
  }

  /**
   * Returns the DWN endpoints for the given DID.
   *
   * @param didUri - The DID URI to get the DWN endpoints for.
   * @returns An array of DWN endpoints.
   * @throws An error if the DID is not found, or no DWN service exists.
   */
  public async getDwnEndpoints({ didUri, refresh = false }: {
    didUri: string;
    refresh?: boolean;
  }): Promise<string[]> {
    const result = await this.getDwnEndpointStatus({ didUri, refresh });
    if (result.status !== 'ready') {
      throw new Error(result.message);
    }
    return result.endpoints;
  }

  /** Return the DID-advertised DWN endpoint state without substituting a local or default node. */
  public getDwnEndpointStatus({ didUri, refresh = false }: {
    didUri: string;
    refresh?: boolean;
  }): Promise<DwnEndpointResolution> {
    const resolver = refresh
      ? { resolve: async (): Promise<DidResolutionResult> => this.agent.did.refreshResolution(didUri) }
      : this.agent.did;
    return resolveDwnEndpointStatus(didUri, resolver);
  }

  /**
   * Sets the DWN endpoints for the given DID.
   *
   * @param didUri - The DID URI to set the DWN endpoints for.
   * @param endpoints - The array of DWN endpoints to set.
   * @throws An error if the DID is not found, or if an update cannot be performed.
   */
  public async setDwnEndpoints({ didUri, endpoints }: { didUri: string; endpoints: string[] }): Promise<void> {
    const bearerDid = await this.agent.did.get({ didUri });
    if (!bearerDid) {
      throw new Error(`AgentIdentityApi: Failed to set DWN endpoints due to DID not found: ${didUri}`);
    }
    if (Did.parse(didUri)?.method !== DidDht.methodName) {
      throw new Error(`AgentIdentityApi: Setting DWN endpoints is only supported for did:dht DIDs: ${didUri}`);
    }

    const portableDid = await bearerDid.export();
    portableDid.document = replaceDwnServiceEndpointUrls(portableDid.document, endpoints);
    const requested = getDwnEndpointStatus(didUri, portableDid.document);
    if (requested.status !== 'ready') {
      throw new Error(requested.message);
    }

    const resolution = await this.agent.did.refreshResolution(didUri);
    const isNotFound = resolution.didResolutionMetadata.error === DidErrorCode.NotFound;
    if (!isNotFound && (resolution.didResolutionMetadata.error !== undefined || resolution.didDocument === null)) {
      throw new Error(
        resolution.didResolutionMetadata.errorMessage
        ?? `AgentIdentityApi: Unable to resolve DID before updating endpoints: ${didUri}`
      );
    }

    const publicDocument = replaceDwnServiceEndpointUrls(
      resolution.didDocument ?? portableDid.document,
      requested.endpoints,
    );

    const current = resolution.didDocument === null
      ? undefined
      : getDwnEndpointStatus(didUri, resolution.didDocument);
    const publishRequired = isNotFound
      || current?.status !== 'ready'
      || current.endpoints.join('\n') !== requested.endpoints.join('\n');
    let publishedMetadata: DidDocumentMetadata | undefined;
    if (publishRequired) {
      bearerDid.document = publicDocument;
      publishedMetadata = (await DidDht.publish({ did: bearerDid })).didDocumentMetadata;
      if (publishedMetadata.published === false) {
        throw new Error(`AgentIdentityApi: Failed to publish updated DWN endpoints for '${didUri}'.`);
      }
    }

    try {
      await this.agent.did.update({
        portableDid,
        tenant  : this.agent.agentDid.uri,
        publish : false,
      });
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message.includes('No changes detected'))) {
        throw error;
      }
    }

    if (publishedMetadata !== undefined) {
      await this.agent.did.cacheResolution(didUri, {
        didDocument           : publicDocument,
        didDocumentMetadata   : publishedMetadata,
        didResolutionMetadata : {},
      });

      await publishServiceConfigNotice({
        agent            : this.agent,
        currentEndpoints : requested.endpoints,
        formerEndpoints  : current?.status === 'ready' ? current.endpoints : [],
        ownerDid         : didUri,
      }).catch((error: unknown): void => {
        logger.error(`AgentIdentityApi: Failed to announce DWN endpoint change for '${didUri}': ${String(error)}`);
      });
    }

    const syncOptions = await this.agent.sync.getIdentityOptions(didUri);
    if (syncOptions !== undefined) {
      await this.agent.sync.updateIdentityOptions({ did: didUri, options: syncOptions });
    }
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
