import type { PermissionsApi } from './types/permissions.js';
import type { SyncEndpointStore } from './sync-endpoint-store.js';
import type { NonEmptyStringArray, SyncAuthorization, SyncIdentityOptions, SyncScope } from './types/sync.js';

import { DwnInterface } from './types/dwn.js';
import { computeAuthorizationEpoch, computeProjectionId, syncScopeFromProtocols } from './types/sync.js';
import { permissionGrantIdsFromEntries, resolveMessagesScopes, toSyncAuthorizationGrants } from './sync-permission-grants.js';

/** The endpoint-discovery surface required to resolve sync targets. */
export interface SyncEndpointDiscovery {
  readonly isRemoteMode: boolean;
  readonly localDwnEndpoint?: string;
  getRemoteDwnEndpointUrls(did: string): Promise<string[]>;
}

/** A canonical replication target for one identity, endpoint, scope, and authorization epoch. */
export type SyncTarget = {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  projectionId: string;
  scope: SyncScope;
  authorization: SyncAuthorization;
  authorizationEpoch: string;
  permissionGrantIds?: NonEmptyStringArray;
};

/** Scope and authorization details shared by every endpoint for an identity. */
export type SyncTargetResolution = Pick<
  SyncTarget,
  'authorization' | 'authorizationEpoch' | 'delegateDid' | 'permissionGrantIds' | 'scope'
>;

export type SyncTargetResolverParams = {
  endpointStore: SyncEndpointStore;
  getEndpointDiscovery: () => SyncEndpointDiscovery;
  permissionsApi: PermissionsApi;
};

/**
 * Resolves registered identity options into backend-neutral sync targets.
 *
 * Cache, retry, logging, and lifecycle policy remain with the enclosing sync
 * engine; this class owns only endpoint and authorization resolution.
 */
export class SyncTargetResolver {
  private readonly _endpointStore: SyncEndpointStore;
  private readonly _getEndpointDiscovery: () => SyncEndpointDiscovery;
  private readonly _permissionsApi: PermissionsApi;

  constructor({ endpointStore, getEndpointDiscovery, permissionsApi }: SyncTargetResolverParams) {
    this._endpointStore = endpointStore;
    this._getEndpointDiscovery = getEndpointDiscovery;
    this._permissionsApi = permissionsApi;
  }

  /** Resolve and deduplicate every remote endpoint for an identity. */
  public async getEndpointUrls(did: string): Promise<string[]> {
    let supplementalEndpoint = await this._endpointStore.get();
    const endpointDiscovery = this._getEndpointDiscovery();
    const activeLocalEndpoint = endpointDiscovery.localDwnEndpoint;
    if (
      supplementalEndpoint !== undefined
      && endpointDiscovery.isRemoteMode
      && (activeLocalEndpoint === undefined ||
        normalizeDwnEndpoint(activeLocalEndpoint) === normalizeDwnEndpoint(supplementalEndpoint))
    ) {
      // After the session-boundary flip, the persisted handoff endpoint is
      // the agent's local side. It must never also be scheduled as a remote
      // replication target, regardless of the configured discovery strategy.
      supplementalEndpoint = undefined;
    }

    let resolvedEndpoints: string[];
    try {
      resolvedEndpoints = await endpointDiscovery.getRemoteDwnEndpointUrls(did);
    } catch (error: unknown) {
      if (supplementalEndpoint === undefined) {
        throw error;
      }
      resolvedEndpoints = [];
    }

    const endpointsByKey = new Map<string, string>();
    for (const endpoint of [supplementalEndpoint, ...resolvedEndpoints]) {
      if (endpoint === undefined) {
        continue;
      }

      let key = endpoint;
      try {
        key = normalizeDwnEndpoint(endpoint);
      } catch {
        // Endpoint validation still occurs at the transport boundary. This key
        // is only used to avoid duplicating an equivalent supplemental URL.
      }
      if (!endpointsByKey.has(key)) {
        endpointsByKey.set(key, endpoint);
      }
    }

    return [...endpointsByKey.values()];
  }

  /** Build every canonical target for one identity and endpoint. */
  public async buildTargetsForEndpoint(did: string, dwnUrl: string, options: SyncIdentityOptions): Promise<SyncTarget[]> {
    const requestedScope = syncScopeFromProtocols(options.protocols);
    const resolutions = await this.buildTargetResolutions(did, requestedScope, options);

    return Promise.all(resolutions.map(async (resolution) => ({
      did,
      dwnUrl,
      projectionId: await computeProjectionId(did, resolution.scope),
      ...resolution,
    })));
  }

  /** Resolve the scopes and authorization epochs represented by identity options. */
  public async buildTargetResolutions(
    did: string,
    requestedScope: SyncScope,
    options: SyncIdentityOptions,
  ): Promise<SyncTargetResolution[]> {
    const { delegateDid } = options;

    if (delegateDid === undefined) {
      return [{
        scope              : requestedScope,
        authorization      : { kind: 'owner' },
        authorizationEpoch : await computeAuthorizationEpoch({ kind: 'owner' }),
      }];
    }

    const resolvedScopes = await resolveMessagesScopes({
      did,
      delegateDid,
      requestedScope,
      messageType    : DwnInterface.MessagesQuery,
      permissionsApi : this._permissionsApi,
    });

    return Promise.all(resolvedScopes.map(async ({ scope, permissionGrants }) => {
      const permissionGrantIds = permissionGrantIdsFromEntries(permissionGrants);
      if (permissionGrantIds === undefined) {
        throw new Error(`SyncEngineLevel: delegate ${delegateDid} has no active sync grants for ${did}.`);
      }

      return {
        scope,
        delegateDid,
        authorization: {
          kind: 'delegate' as const,
          delegateDid,
          permissionGrantIds,
        },
        authorizationEpoch: await computeAuthorizationEpoch({
          kind   : 'delegate' as const,
          delegateDid,
          grants : toSyncAuthorizationGrants(permissionGrants),
        }),
        permissionGrantIds,
      };
    }));
  }
}

/** Normalize equivalent DWN endpoint URLs while preserving the legacy error policy. */
export function normalizeDwnEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('SyncEngineLevel: drain endpoint must be a valid URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('SyncEngineLevel: drain endpoint must use http or https.');
  }

  url.hash = '';
  url.search = '';
  const normalized = url.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}
