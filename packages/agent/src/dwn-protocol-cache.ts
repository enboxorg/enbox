/**
 * Protocol definition fetching and caching utilities for {@link AgentDwnApi}.
 *
 * Extracted from `dwn-api.ts` to keep protocol-resolution logic in its own
 * module.
 *
 * @module
 */

import type { TtlCache } from '@enbox/common';
import type {
  ProtocolDefinition,
  ProtocolsQueryReply,
} from '@enbox/dwn-sdk-js';

import type {
  DwnInterface,
  DwnMessage,
  DwnMessageReply,
  DwnSigner,
  MessageHandler,
} from './types/dwn.js';

import { DwnInterface as DwnInterfaceEnum, dwnMessageConstructors } from './types/dwn.js';

type RemoteProtocolDefinitionFailure = 'not-found' | 'no-endpoint' | 'rejected';

/** Typed remote protocol lookup failure used by audience-delivery policy. */
export class RemoteProtocolDefinitionError extends Error {
  public readonly failure: RemoteProtocolDefinitionFailure;
  public readonly statusCode?: number;

  public constructor(message: string, failure: RemoteProtocolDefinitionFailure, statusCode?: number) {
    super(message);
    this.name = 'RemoteProtocolDefinitionError';
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

/** Minimal DWN interface needed for local `processMessage` calls. */
interface DwnNode {
  processMessage(tenant: string, message: unknown, options?: unknown): Promise<any>;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Fetches a protocol definition from the **local** DWN, backed by a TTL cache.
 *
 * @param tenantDid - The DID whose DWN to query
 * @param protocolUri - The protocol URI to look up
 * @param dwn - The local DWN instance
 * @param getSigner - Callback to obtain the signer for `tenantDid`
 * @param cache - The shared protocol definition cache
 * @returns The protocol definition, or `undefined` if not installed
 */
export async function getProtocolDefinition(
  tenantDid: string,
  protocolUri: string,
  dwn: DwnNode,
  getSigner: GetSignerFn,
  cache: TtlCache<string, ProtocolDefinition>,
  granteeDid?: string,
  permissionGrantId?: string,
): Promise<ProtocolDefinition | undefined> {
  const cacheKey = `${tenantDid}~${protocolUri}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // When operating as a delegate, the tenant's private signing key is not
  // available locally. Sign the ProtocolsQuery with the delegate's key
  // and include the permissionGrantId so the local DWN authorises the
  // query against the unpublished protocol.
  const signerDid = granteeDid ?? tenantDid;
  const signer = await getSigner(signerDid);
  const protocolsQuery = await dwnMessageConstructors[
    DwnInterfaceEnum.ProtocolsQuery
  ].create({
    filter: { protocol: protocolUri },
    signer,
    ...(permissionGrantId ? { permissionGrantId } : {}),
  });

  const reply = await dwn.processMessage(
    tenantDid, protocolsQuery.message,
  );
  if (reply.status.code !== 200 || !reply.entries?.length) {
    return undefined;
  }

  const definition = reply.entries[0].descriptor.definition;
  cache.set(cacheKey, definition);
  return definition;
}

/**
 * Fetches a protocol definition from a **remote** DWN.
 *
 * Uses an unsigned `ProtocolsQuery` since public protocols can be queried
 * anonymously. The returned configuration must carry a valid signature made
 * directly by the target DID before its definition can enter the cache.
 *
 * @param targetDid - The remote DWN owner
 * @param protocolUri - The protocol URI to look up
 * @param getDwnEndpointUrls - Callback to resolve DWN endpoint URLs (with local discovery)
 * @param sendDwnRpcRequest - Callback to send the RPC query
 * @param cache - The shared protocol definition cache
 * @param cacheNamespace - Cache namespace separating paired-local and advertised-remote definitions
 * @returns The protocol definition
 * @throws If the protocol cannot be fetched
 */
export async function fetchRemoteProtocolDefinition(
  targetDid: string,
  protocolUri: string,
  getDwnEndpointUrls: GetDwnEndpointUrlsFn,
  sendDwnRpcRequest: SendDwnRpcRequestFn,
  cache: TtlCache<string, ProtocolDefinition>,
  cacheNamespace = 'remote',
): Promise<ProtocolDefinition> {
  const cacheKey = `${cacheNamespace}~${targetDid}~${protocolUri}`;
  const cached = cache.get(cacheKey);
  if (cached) { return cached; }

  const protocolsQuery = await dwnMessageConstructors[
    DwnInterfaceEnum.ProtocolsQuery
  ].create({
    filter: { protocol: protocolUri },
  });

  const dwnEndpointUrls = await getDwnEndpointUrls(targetDid);
  if (dwnEndpointUrls.length === 0) {
    throw new RemoteProtocolDefinitionError(
      `AgentDwnApi: DID '${targetDid}' has no DWN endpoint from which to fetch protocol '${protocolUri}'.`,
      'no-endpoint',
    );
  }

  const reply = await sendDwnRpcRequest({
    targetDid,
    dwnEndpointUrls,
    message        : protocolsQuery.message,
    verifyResponse : true,
  }) as ProtocolsQueryReply;

  const definition = reply.entries?.[0]?.descriptor.definition;
  if (reply.status.code === 200 && definition !== undefined) {
    cache.set(cacheKey, definition);
    return definition;
  }
  if (reply.status.code === 200) {
    throw new RemoteProtocolDefinitionError(
      `AgentDwnApi: Failed to fetch protocol '${protocolUri}' from ` +
      `'${targetDid}'. The recipient may not have the protocol installed.`,
      'not-found',
    );
  }
  throw new RemoteProtocolDefinitionError(
    `AgentDwnApi: Failed to fetch protocol '${protocolUri}' from '${targetDid}': ${reply.status.detail}`,
    'rejected',
    reply.status.code,
  );
}
