import type { RequireOnly } from '@enbox/common';

import type { AgentDataStore } from './store-data.js';
import type { AgentKeyManager } from './types/key-manager.js';
import type { DidMethodCreateOptions } from './did-api.js';
import type { EnboxPlatformAgent } from './types/agent.js';
import type { IdentityMetadata, PortableIdentity } from './types/identity.js';

import { isPortableDid } from '@enbox/dids';
import { logger } from '@enbox/common';

import { BearerIdentity } from './bearer-identity.js';
import { InMemoryIdentityStore } from './store-identity.js';
import { publishServiceConfig } from './service-config.js';

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

    return identities.filter(identity => typeof identity !== 'undefined') as BearerIdentity[];
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
  public getDwnEndpoints({ didUri }: { didUri: string; }): Promise<string[]> {
    return this.agent.dwn.getDwnEndpointUrlsForTarget(didUri);
  }

  /**
   * Sets the DWN endpoints for the given DID.
   *
   * When `announce` is not `false` (the default), a service-config
   * announcement record is published after the DID document is updated, so
   * connected apps observing this identity learn of the endpoint change
   * promptly instead of waiting out their resolver-cache TTL (see
   * {@link publishServiceConfig}). The announcement is best-effort — a failure
   * to publish it never fails the endpoint update itself.
   *
   * @param didUri - The DID URI to set the DWN endpoints for.
   * @param endpoints - The array of DWN endpoints to set.
   * @param announce - Whether to publish a service-config announcement. Defaults to `true`.
   * @throws An error if the DID is not found, or if an update cannot be performed.
   */
  public async setDwnEndpoints({ didUri, endpoints, announce = true }: {
    didUri: string;
    endpoints: string[];
    announce?: boolean;
  }): Promise<void> {
    const bearerDid = await this.agent.did.get({ didUri });
    if (!bearerDid) {
      throw new Error(`AgentIdentityApi: Failed to set DWN endpoints due to DID not found: ${didUri}`);
    }

    const portableDid = await bearerDid.export();
    const dwnService = portableDid.document.service?.find(service => service.id.endsWith('dwn'));
    if (dwnService) {
      // Update the existing DWN Service with the provided endpoints
      dwnService.serviceEndpoint = endpoints;
    } else {

      // create a DWN Service to add to the DID document
      const newDwnService = {
        id              : 'dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : endpoints,
      };

      // if no other services exist, create a new array with the DWN service
      if (portableDid.document.service) {
        // push the new DWN service to the existing services
        portableDid.document.service.push(newDwnService);
      } else {
        // no other services exist, create a new array with the DWN service
        portableDid.document.service = [newDwnService];
      }
    }

    await this.agent.did.update({ portableDid, tenant: this.agent.agentDid.uri });

    // `did.update` refreshes the resolver cache with the new document, but the
    // sync engine memoizes resolved endpoints separately (a short-TTL sync
    // targets cache). Invalidate it so an added/removed DWN endpoint takes
    // effect on the next sync tick instead of waiting out that TTL.
    this.agent.sync.invalidateSyncTargets();

    if (announce) {
      // Publish the change so connected apps re-resolve now rather than on
      // resolver-cache expiry. Best-effort: the DID document is already the
      // authoritative record, and sync reconciles the announcement later, so a
      // publish failure must not fail the endpoint update.
      try {
        await this.publishServiceConfig({ didUri });
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(`AgentIdentityApi: Failed to publish service-config announcement for ${didUri}: ${detail}`);
      }
    }
  }

  /**
   * Publishes a service-config announcement record for the given identity from
   * its current DWN endpoint set.
   *
   * This is the wallet-side half of the endpoint-change trigger: it installs
   * the service-config protocol on the identity's DWN (idempotent), writes or
   * updates the single announcement record, and best-effort delivers it to the
   * identity's remote DWN endpoints. Connected apps that requested the
   * service-config protocol replicate the record via sync and re-resolve this
   * DID's endpoints in response.
   *
   * The DID document remains authoritative; the announcement is only a prompt
   * signal. Callers that change endpoints via {@link setDwnEndpoints} get this
   * automatically unless they pass `announce: false`.
   *
   * @param didUri - The identity DID to publish a service-config record for.
   */
  public async publishServiceConfig({ didUri }: { didUri: string }): Promise<void> {
    await publishServiceConfig(this.agent, didUri);
  }

  /**
   * Forces the agent to re-resolve a DID's DWN service endpoints from its DID
   * document, bypassing the resolver cache, and invalidates the sync engine's
   * memoized endpoint list.
   *
   * Use this on a connected identity whose DWN endpoints may have changed out
   * of band (for example, the wallet owner added or removed a DWN): the agent
   * would otherwise keep using the cached endpoint set until the resolver TTL
   * expires. After this resolves, subsequent DWN operations and the next sync
   * tick target the freshly resolved endpoints.
   *
   * @param didUri - The DID URI whose DWN endpoints should be re-resolved.
   * @returns The freshly resolved DWN endpoint URLs.
   */
  public async refreshDwnEndpoints({ didUri }: { didUri: string }): Promise<string[]> {
    await this.agent.did.refreshResolution(didUri);
    this.agent.sync.invalidateSyncTargets();
    return this.getDwnEndpoints({ didUri });
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