/**
 * Protocol definition fetching and caching utilities for {@link AgentDwnApi}.
 *
 * Extracted from `dwn-api.ts` to keep protocol-resolution logic in its own
 * module.
 *
 * @module
 */

import type { DidUrlDereferencer } from '@enbox/dids';
import type { PublicKeyJwk } from '@enbox/crypto';
import type { TtlCache } from '@enbox/common';
import type {
  ProtocolDefinition,
  ProtocolsQueryReply,
  RecordsQueryReply,
} from '@enbox/dwn-sdk-js';

import type {
  DwnInterface,
  DwnMessage,
  DwnMessageReply,
  DwnSigner,
  MessageHandler,
} from './types/dwn.js';

import { KeyDerivationScheme } from '@enbox/dwn-sdk-js';

import { getDwnServiceEndpointUrls } from './utils.js';
import { DwnInterface as DwnInterfaceEnum, dwnMessageConstructors } from './types/dwn.js';

// ---------------------------------------------------------------------------
// Dependency signatures — keep the extracted code free of `this` references.
// ---------------------------------------------------------------------------

/** Callback to obtain a DWN signer for a given DID. */
type GetSignerFn = (author: string) => Promise<DwnSigner>;

/** Callback to send a raw DWN request to a remote endpoint. */
type SendDwnRpcRequestFn = <T extends DwnInterface>(params: {
  targetDid: string;
  dwnEndpointUrls: string[];
  message: DwnMessage[T];
  data?: Blob;
  subscriptionHandler?: MessageHandler[T];
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
): Promise<ProtocolDefinition | undefined> {
  const cacheKey = `${tenantDid}~${protocolUri}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const signer = await getSigner(tenantDid);
  const protocolsQuery = await dwnMessageConstructors[
    DwnInterfaceEnum.ProtocolsQuery
  ].create({
    filter: { protocol: protocolUri },
    signer,
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
 * anonymously.
 *
 * @param targetDid - The remote DWN owner
 * @param protocolUri - The protocol URI to look up
 * @param didDereferencer - A DID URL dereferencer for resolving service endpoints
 * @param sendDwnRpcRequest - Callback to send the RPC query
 * @param cache - The shared protocol definition cache
 * @returns The protocol definition
 * @throws If the protocol cannot be fetched
 */
export async function fetchRemoteProtocolDefinition(
  targetDid: string,
  protocolUri: string,
  didDereferencer: DidUrlDereferencer,
  sendDwnRpcRequest: SendDwnRpcRequestFn,
  cache: TtlCache<string, ProtocolDefinition>,
): Promise<ProtocolDefinition> {
  const cacheKey = `remote~${targetDid}~${protocolUri}`;
  const cached = cache.get(cacheKey);
  if (cached) { return cached; }

  const protocolsQuery = await dwnMessageConstructors[
    DwnInterfaceEnum.ProtocolsQuery
  ].create({
    filter: { protocol: protocolUri },
  });

  const reply = await sendDwnRpcRequest({
    targetDid,
    dwnEndpointUrls : await getDwnServiceEndpointUrls(targetDid, didDereferencer),
    message         : protocolsQuery.message,
  }) as ProtocolsQueryReply;

  if (reply.status.code !== 200 || !reply.entries?.length) {
    throw new Error(
      `AgentDwnApi: Failed to fetch protocol '${protocolUri}' from ` +
      `'${targetDid}'. The recipient may not have the protocol installed.`
    );
  }

  const definition = reply.entries[0].descriptor.definition;
  cache.set(cacheKey, definition);
  return definition;
}

/**
 * Extracts the `derivedPublicKey` from an existing `ProtocolContext`-encrypted
 * record in a context on a remote DWN.
 *
 * This key allows an external author to encrypt new records in the same
 * context without knowing the context private key.
 *
 * @param targetDid      - The DWN owner's DID
 * @param protocolUri    - The protocol URI to search
 * @param rootContextId  - The root context ID
 * @param requesterDid   - The DID of the requester (used for signing the query)
 * @param didDereferencer - A DID URL dereferencer for resolving service endpoints
 * @param getSigner      - Callback to obtain the signer for `requesterDid`
 * @param sendDwnRpcRequest - Callback to send the RPC query
 * @returns The rootKeyId and derivedPublicKey, or `undefined` if no
 *          `ProtocolContext` record exists yet
 */
export async function extractDerivedPublicKey(
  targetDid: string,
  protocolUri: string,
  rootContextId: string,
  requesterDid: string,
  didDereferencer: DidUrlDereferencer,
  getSigner: GetSignerFn,
  sendDwnRpcRequest: SendDwnRpcRequestFn,
): Promise<{ rootKeyId: string; derivedPublicKey: PublicKeyJwk } | undefined> {
  const signer = await getSigner(requesterDid);

  // Query the target's DWN for any record in this context
  const recordsQuery = await dwnMessageConstructors[DwnInterfaceEnum.RecordsQuery].create({
    signer,
    filter: {
      protocol  : protocolUri,
      contextId : rootContextId,
    },
  });

  const dwnEndpointUrls = await getDwnServiceEndpointUrls(targetDid, didDereferencer);
  const queryReply = await sendDwnRpcRequest<DwnInterfaceEnum.RecordsQuery>({
    targetDid,
    dwnEndpointUrls,
    message: recordsQuery.message,
  }) as RecordsQueryReply;

  if (queryReply.status.code !== 200 || !queryReply.entries?.length) {
    return undefined;
  }

  // Search entries for one with a ProtocolContext recipient entry
  // that includes derivedPublicKey
  for (const entry of queryReply.entries) {
    if (entry.encryption?.recipients) {
      const contextEntry = entry.encryption.recipients.find(
        (r: { header: { derivationScheme: string; derivedPublicKey?: PublicKeyJwk } }) =>
          r.header.derivationScheme === KeyDerivationScheme.ProtocolContext && r.header.derivedPublicKey
      );
      if (contextEntry?.header.derivedPublicKey) {
        return {
          rootKeyId        : contextEntry.header.kid,
          derivedPublicKey : contextEntry.header.derivedPublicKey,
        };
      }
    }
  }

  return undefined;
}
