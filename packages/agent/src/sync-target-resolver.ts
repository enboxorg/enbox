import type { DwnDataEncodedRecordsWriteMessage } from './types/dwn.js';
import type { FollowedSyncSource } from './followed-sync-source.js';
import type { PermissionsApi } from './types/permissions.js';
import type { SyncEndpointStore } from './sync-endpoint-store.js';
import type {
  NonEmptyStringArray,
  ReplicationLinkState,
  SyncAuthorization,
  SyncIdentityOptions,
  SyncScope,
} from './types/sync.js';

import { DwnInterface } from './types/dwn.js';
import { computeAuthorizationEpoch, computeProjectionId, syncScopeFromProtocols } from './types/sync.js';
import { permissionGrantIdsFromEntries, resolveMessagesScopes, toSyncAuthorizationGrants } from './sync-permission-grants.js';

/** The endpoint-discovery surface required to resolve sync targets. */
export interface SyncEndpointDiscovery {
  readonly isRemoteMode: boolean;
  readonly localDwnEndpoint?: string;
  getRemoteDwnEndpointUrls(did: string): Promise<string[]>;
}

/**
 * A canonical replication target for one identity, endpoint, scope, and
 * authorization epoch.
 *
 * Naming caveat, because it costs readers time: this type and the durable
 * {@link ReplicationLinkState} describe the same tenant and endpoint under
 * different field names — `did` here is `tenantDid` there, and `dwnUrl`
 * here is `remoteEndpoint` there. {@link syncTargetFromLink} is that
 * mapping and nothing more. The names are NOT converged because `did` and
 * `dwnUrl` are also the field names on the push-request
 * types, so renaming only this type's fields would need per-site judgment
 * across ~500 occurrences, many of them in untyped test literals the
 * compiler cannot check.
 */
export type SyncTarget = {
  /** Tenant DID. Same value as `ReplicationLinkState.tenantDid`. */
  did: string;
  /** Remote DWN URL. Same value as `ReplicationLinkState.remoteEndpoint`. */
  dwnUrl: string;
  delegateDid?: string;
  projectionId: string;
  scope: SyncScope;
  authorization: SyncAuthorization;
  authorizationEpoch: string;
  /** Current embedded actor-to-delegate grant. Never persisted on the durable link. */
  authorDelegatedGrant?: DwnDataEncodedRecordsWriteMessage;
  permissionGrantIds?: NonEmptyStringArray;
};

/** Recreate the canonical target represented by one durable link. */
export function syncTargetFromLink(link: ReplicationLinkState): SyncTarget {
  return {
    did                : link.tenantDid,
    dwnUrl             : link.remoteEndpoint,
    delegateDid        : link.delegateDid,
    projectionId       : link.projectionId,
    scope              : link.scope,
    authorization      : link.authorization,
    authorizationEpoch : link.authorizationEpoch,
    permissionGrantIds : link.authorization.kind === 'delegate'
      ? link.authorization.permissionGrantIds
      : undefined,
  };
}

/** Scope and authorization details common to every endpoint for an identity. */
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

    return SyncTargetResolver.deduplicateEndpointUrls([supplementalEndpoint, ...resolvedEndpoints]);
  }

  /** Resolve only DID-advertised endpoints for a foreign authority source. */
  public async getRemoteEndpointUrls(did: string): Promise<string[]> {
    return SyncTargetResolver.deduplicateEndpointUrls(
      await this._getEndpointDiscovery().getRemoteDwnEndpointUrls(did),
    );
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

  /** Build every exact-context target represented by one accepted role record. */
  public async buildTargetsForSource(
    source: FollowedSyncSource,
    delegateDid?: string,
    resolvedEndpoints?: readonly string[],
  ): Promise<SyncTarget[]> {
    const endpoints = resolvedEndpoints ?? await this.getRemoteEndpointUrls(source.sourceDid);
    if (endpoints.length === 0) {
      return [];
    }
    const scope = {
      kind          : 'context' as const,
      protocol      : source.protocol,
      contextId     : source.contextId,
      protocolPaths : source.protocolPaths,
    };

    const authorization: Extract<SyncAuthorization, { kind: 'role' }> = {
      kind         : 'role',
      actorDid     : source.actorDid,
      protocolRole : source.protocolRole,
      roleRecordId : source.id,
    };

    const authorizationEpoch = await computeAuthorizationEpoch(authorization);
    const projectionId = await computeProjectionId(source.sourceDid, scope);
    return endpoints.map((dwnUrl): SyncTarget => ({
      did: source.sourceDid,
      dwnUrl,
      delegateDid,
      projectionId,
      scope,
      authorization,
      authorizationEpoch,
    }));
  }

  /** Attach the current full delegate grant immediately before a role request. */
  public async withCurrentRoleGrant(target: SyncTarget): Promise<SyncTarget> {
    if (target.authorization.kind !== 'role' || target.delegateDid === undefined) {
      return target;
    }

    const { message } = await this._permissionsApi.getPermissionForRequest({
      connectedDid : target.authorization.actorDid,
      delegateDid  : target.delegateDid,
      delegate     : true,
      forceRefresh : true,
      messageType  : DwnInterface.MessagesQuery,
      protocol     : target.scope.kind === 'context' ? target.scope.protocol : undefined,
    });
    return { ...target, authorDelegatedGrant: message };
  }

  /** Resolve the scopes and authorization epochs represented by identity options. */
  public async buildTargetResolutions(
    did: string,
    requestedScope: ReturnType<typeof syncScopeFromProtocols>,
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

  private static deduplicateEndpointUrls(endpoints: (string | undefined)[]): string[] {
    const endpointsByKey = new Map<string, string>();
    for (const endpoint of endpoints) {
      if (endpoint === undefined) {
        continue;
      }

      let key = endpoint;
      try {
        key = normalizeDwnEndpoint(endpoint);
      } catch {
        // Endpoint validation still occurs at the transport boundary. This key
        // is only used to avoid scheduling an equivalent endpoint twice.
      }
      if (!endpointsByKey.has(key)) {
        endpointsByKey.set(key, endpoint);
      }
    }
    return [...endpointsByKey.values()];
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
