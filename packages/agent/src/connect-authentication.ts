/** Owner authentication for Connect, independent of DWN delegation and sessions. */

import type { BearerDid } from '@enbox/dids';
import type { EnboxPlatformAgent } from './types/agent.js';
import type { ConnectRequest, PreparedOwnerAuthenticationProof } from '@enbox/connect';

import { DidJwk } from '@enbox/dids';
import { assertConnectAuthenticationParams, assertExpectedProviderDid, prepareOwnerAuthenticationProof } from '@enbox/connect';

/** Parameters shared by owner authentication and combined Connect approval. */
export type CreateConnectAuthenticationProofParams = {
  agent: EnboxPlatformAgent;
  providerDid: string;
  /** The original request opened by the transport, without metadata rewriting. */
  request: ConnectRequest;
  /**
   * Origin established independently by the popup transport or service-owned
   * relay policy. Never derive this from request.authentication.audience.
   * Owner authentication requires HTTPS, including local development.
   */
  verifiedRequesterOrigin: string;
};

/** Identity-only approval; its envelope signer is ephemeral and receives no grants. */
export type ConnectAuthenticationApprovalResult = {
  authenticationProof: string;
  responseSigner: BearerDid;
};

/**
 * Sign a requested authentication proof using the selected locally owned
 * identity's authentication key. No private keys are exported or delegated.
 *
 * The verified origin constrains the intended authentication audience. Relay
 * callers must establish requester trust before invoking this helper.
 */
export async function createConnectAuthenticationProof(
  params: CreateConnectAuthenticationProofParams,
): Promise<string> {
  return (await prepareConnectAuthenticationProof(params)).sign();
}

/** Validate and snapshot authentication before any combined delegation mutation. */
export async function prepareConnectAuthenticationProof(
  params: CreateConnectAuthenticationProofParams,
): Promise<PreparedOwnerAuthenticationProof> {
  const { agent, providerDid, verifiedRequesterOrigin } = params;
  const request = structuredClone(params.request);
  assertExpectedProviderDid(request, providerDid);
  if (request.authentication === undefined) {
    throw new Error('Connect authentication: the request did not ask for an owner authentication proof.');
  }
  assertConnectAuthenticationParams(request.authentication);
  assertVerifiedConnectRequesterOrigin(verifiedRequesterOrigin);
  if (new URL(request.authentication.audience).origin !== verifiedRequesterOrigin) {
    throw new Error('Connect authentication: the audience does not match the verified requester origin.');
  }

  const identity = await agent.identity.get({ didUri: providerDid });
  if (identity?.did.uri !== providerDid || identity.metadata.connectedDid !== undefined) {
    throw new Error('Connect authentication: the selected DID is not a locally owned identity.');
  }
  return prepareOwnerAuthenticationProof({ request, owner: identity.did });
}

/**
 * Approve an identity-only Connect request without creating a delegate,
 * installing modules, writing DWN grants, or opening an AgentSession.
 */
export async function executeConnectAuthentication(
  params: CreateConnectAuthenticationProofParams,
): Promise<ConnectAuthenticationApprovalResult> {
  const snapshot = { ...params, request: structuredClone(params.request) };
  if (snapshot.request.requestType !== 'authenticate' || snapshot.request.permissionRequests.length !== 0 ||
      snapshot.request.delegateDid !== undefined || snapshot.request.requestedSessionTtlSeconds !== undefined) {
    throw new Error('Connect authentication: identity-only approval requires an authentication-only request.');
  }
  const authenticationProof = await createConnectAuthenticationProof(snapshot);
  // This key signs only the transport envelope; it never becomes a data
  // delegate, is not imported into the agent, and is never returned as credentials.
  const responseSigner = await DidJwk.create();
  return { authenticationProof, responseSigner };
}

/** Validate transport-origin syntax; HTTP supports delegation, while authentication separately requires HTTPS. */
export function assertVerifiedConnectRequesterOrigin(origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('Connect: verified requester origin must be a canonical HTTP(S) origin.');
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== origin) {
    throw new Error('Connect: verified requester origin must be a canonical HTTP(S) origin.');
  }
}
