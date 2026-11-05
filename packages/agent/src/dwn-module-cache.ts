/**
 * Module definition fetching and caching utilities for {@link AgentDwnApi}.
 *
 * Extracted from `dwn-api.ts` to keep module-resolution logic in its own
 * module.
 *
 * @module
 */

import type { TtlCache } from '@enbox/common';
import type {
  ModuleDefinition,
  ModulesQueryReply,
} from '@enbox/dwn-sdk-js';

import type {
  DwnInterface,
  DwnMessage,
  DwnMessageReply,
  DwnSigner,
  MessageHandler,
} from './types/dwn.js';

import { DwnInterface as DwnInterfaceEnum, dwnMessageConstructors } from './types/dwn.js';

type RemoteModuleDefinitionFailure = 'not-found' | 'no-endpoint' | 'rejected';

/** Typed remote module lookup failure used by audience-delivery policy. */
export class RemoteModuleDefinitionError extends Error {
  public readonly failure: RemoteModuleDefinitionFailure;
  public readonly statusCode?: number;

  public constructor(message: string, failure: RemoteModuleDefinitionFailure, statusCode?: number) {
    super(message);
    this.name = 'RemoteModuleDefinitionError';
    this.failure = failure;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Dependency signatures — keep the extracted code free of `this` references.
// ---------------------------------------------------------------------------

/** Callback to resolve DWN endpoint URLs for a target DID (with local discovery). */
type GetDwnEndpointUrlsFn = (targetDid: string) => Promise<string[]>;

/** Callback to obtain a DWN signer for a given DID. */
type GetSignerFn = (author: string) => Promise<DwnSigner>;

/** Callback to send a raw DWN request to a remote endpoint. */
type SendDwnRpcRequestFn = <T extends DwnInterface>(params: {
  targetDid: string;
  dwnEndpointUrls: string[];
  message: DwnMessage[T];
  data?: Blob;
  subscriptionHandler?: MessageHandler[T];
  verifyResponse: boolean;
}) => Promise<DwnMessageReply[T]>;

/** Optional delegated authorization for querying an unpublished module. */
export type RemoteModuleQueryAuthorization = {
  permissionGrantId: string;
  signer: DwnSigner;
};

/** Minimal DWN interface needed for local `processMessage` calls. */
interface DwnNode {
  processMessage(tenant: string, message: unknown, options?: unknown): Promise<any>;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Fetches a module definition from the **local** DWN, backed by a TTL cache.
 *
 * @param tenantDid - The DID whose DWN to query
 * @param moduleUri - The module URI to look up
 * @param dwn - The local DWN instance
 * @param getSigner - Callback to obtain the signer for `tenantDid`
 * @param cache - The shared module definition cache
 * @returns The module definition, or `undefined` if not installed
 */
export async function getModuleDefinition(
  tenantDid: string,
  moduleUri: string,
  dwn: DwnNode,
  getSigner: GetSignerFn,
  cache: TtlCache<string, ModuleDefinition>,
  granteeDid?: string,
  permissionGrantId?: string,
): Promise<ModuleDefinition | undefined> {
  const authorizationScope = granteeDid === undefined
    ? 'owner'
    : `delegate~${granteeDid}~${permissionGrantId ?? 'no-grant'}`;
  const cacheKey = `local~${authorizationScope}~${tenantDid}~${moduleUri}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // When operating as a delegate, the tenant's private signing key is not
  // available locally. Sign the ModulesQuery with the delegate's key
  // and include the permissionGrantId so the local DWN authorises the
  // query against the unpublished module.
  const signerDid = granteeDid ?? tenantDid;
  const signer = await getSigner(signerDid);
  const modulesQuery = await dwnMessageConstructors[
    DwnInterfaceEnum.ModulesQuery
  ].create({
    filter: { module: moduleUri },
    signer,
    ...(permissionGrantId ? { permissionGrantId } : {}),
  });

  const reply = await dwn.processMessage(
    tenantDid, modulesQuery.message,
  );
  if (reply.status.code !== 200 || !reply.entries?.length) {
    return undefined;
  }

  const definition = reply.entries[0].descriptor.definition;
  cache.set(cacheKey, definition);
  return definition;
}

/**
 * Fetches a module definition from a **remote** DWN.
 *
 * Public modules use an anonymous `ModulesQuery`. Unpublished modules
 * require the caller to provide a delegate signer and covering query grant.
 * The returned configuration must carry a valid signature made directly by
 * the target DID before its definition can enter the cache.
 *
 * @param targetDid - The remote DWN owner
 * @param moduleUri - The module URI to look up
 * @param getDwnEndpointUrls - Callback to resolve DWN endpoint URLs (with local discovery)
 * @param sendDwnRpcRequest - Callback to send the RPC query
 * @param cache - The shared module definition cache
 * @returns The module definition
 * @throws If the module cannot be fetched
 */
export async function fetchRemoteModuleDefinition(
  targetDid: string,
  moduleUri: string,
  getDwnEndpointUrls: GetDwnEndpointUrlsFn,
  sendDwnRpcRequest: SendDwnRpcRequestFn,
  cache: TtlCache<string, ModuleDefinition>,
  cacheNamespace = 'remote',
  authorization?: RemoteModuleQueryAuthorization,
): Promise<ModuleDefinition> {
  const authorizationScope = authorization === undefined
    ? cacheNamespace
    : `${cacheNamespace}~${authorization.signer.keyId}~${authorization.permissionGrantId}`;
  const cacheKey = `${authorizationScope}~${targetDid}~${moduleUri}`;
  const cached = cache.get(cacheKey);
  if (cached) { return cached; }

  const modulesQuery = await dwnMessageConstructors[
    DwnInterfaceEnum.ModulesQuery
  ].create({
    filter: { module: moduleUri },
    ...(authorization === undefined ? {} : {
      permissionGrantId : authorization.permissionGrantId,
      signer            : authorization.signer,
    }),
  });

  const dwnEndpointUrls = await getDwnEndpointUrls(targetDid);
  if (dwnEndpointUrls.length === 0) {
    throw new RemoteModuleDefinitionError(
      `AgentDwnApi: DID '${targetDid}' has no DWN endpoint from which to fetch module '${moduleUri}'.`,
      'no-endpoint',
    );
  }

  const reply = await sendDwnRpcRequest({
    targetDid,
    dwnEndpointUrls,
    message        : modulesQuery.message,
    verifyResponse : true,
  }) as ModulesQueryReply;

  const definition = reply.entries?.[0]?.descriptor.definition;
  if (reply.status.code === 200 && definition !== undefined) {
    cache.set(cacheKey, definition);
    return definition;
  }
  if (reply.status.code === 200) {
    throw new RemoteModuleDefinitionError(
      `AgentDwnApi: Failed to fetch module '${moduleUri}' from ` +
      `'${targetDid}'. The recipient may not have the module installed.`,
      'not-found',
    );
  }
  throw new RemoteModuleDefinitionError(
    `AgentDwnApi: Failed to fetch module '${moduleUri}' from '${targetDid}': ${reply.status.detail}`,
    'rejected',
    reply.status.code,
  );
}
