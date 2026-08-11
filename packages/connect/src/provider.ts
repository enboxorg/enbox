/**
 * Wallet-side (provider) connect envelope handling.
 *
 * `ConnectProvider` covers the kernel's share of the wallet flow: opening and
 * validating a sealed request, sealing the approval ceremony's output into a
 * response addressed to the request's `responseKey`, and producing the deny
 * token. The approval ceremony itself (delegate minting, protocol
 * installation, grant creation, revocation grants) is agent territory — its
 * output plugs in here as a {@link ConnectApproval}.
 *
 * @module
 */

import type { BearerDid } from '@enbox/dids';
import type { ConnectApproval, ConnectRequest, ConnectRequestDecryption, ConnectResponse } from './types.js';

import { CONNECT_DENIED_TOKEN } from './types.js';
import { openRequest, sealResponse } from './envelope.js';

/** Lifetime, in seconds, of a sealed connect response (`exp = iat + 600`). */
export const CONNECT_RESPONSE_TTL_SECONDS = 600;

/**
 * Verifies that an approval uses the wallet profile requested by the client.
 *
 * Provider implementations must call this before performing approval side
 * effects. {@link ConnectProvider.sealApprovedResponse} repeats the check as
 * a final defense, but sealing happens too late to prevent grants created for
 * the wrong profile.
 *
 * @param request - The opened connect request being approved.
 * @param providerDid - The wallet profile selected for approval.
 */
export function assertExpectedProviderDid(
  request: Pick<ConnectRequest, 'expectedProviderDid'>,
  providerDid: string,
): void {
  if (request.expectedProviderDid !== undefined && request.expectedProviderDid !== providerDid) {
    throw new Error(
      `Connect expected wallet profile '${request.expectedProviderDid}', but '${providerDid}' was selected.`
    );
  }
}

/**
 * Wallet-side envelope operations for the connect handshake.
 */
export class ConnectProvider {
  /**
   * Opens a sealed connect request: decrypts with a channel-pinned algorithm
   * allow-list, verifies the envelope header (including the `apv` origin
   * binding on popup channels), verifies the JWT signature, asserts the
   * payload shape, and value-checks the signer against `clientDid`.
   *
   * @param params - The opening parameters.
   * @param params.jwe - The sealed request as a Compact JWE string.
   * @param params.decryption - The channel-specific decryption input.
   * @returns A promise resolving to the validated {@link ConnectRequest} for
   *          display in the consent UI.
   */
  public static async openRequest({ jwe, decryption }: {
    jwe: string;
    decryption: ConnectRequestDecryption;
  }): Promise<ConnectRequest> {
    return await openRequest({ jwe, decryption });
  }

  /**
   * Seals the output of an approved connect ceremony into a response
   * envelope: stamps `aud`/`nonce`/`state` echoes and the `iat`/`exp` window,
   * signs the payload with the wallet's response signer, and encrypts it to
   * the request's `responseKey` (with the PIN wrapper on relay channels).
   *
   * @param params - The sealing parameters.
   * @param params.request - The opened request being approved.
   * @param params.providerDid - The wallet owner's DID that authorised the delegation.
   * @param params.approval - The approval ceremony output to deliver.
   * @param params.signer - The wallet's response signing `did:jwk` (the minted
   *   delegate for wallet-minted sessions, or a fresh DID when the request
   *   pre-supplied its own delegate).
   * @param params.pin - The user-verified PIN on relay channels.
   * @returns A promise resolving to the sealed response as a Compact JWE string.
   */
  public static async sealApprovedResponse({ request, providerDid, approval, signer, pin }: {
    request: ConnectRequest;
    providerDid: string;
    approval: ConnectApproval;
    signer: BearerDid;
    pin?: string;
  }): Promise<string> {
    assertExpectedProviderDid(request, providerDid);

    if (request.delegateDid !== undefined && approval.delegateDid !== request.delegateDid) {
      throw new Error('Connect: approval delegate DID does not match the request-supplied `delegateDid`.');
    }
    if (request.delegateDid !== undefined && approval.delegatePortableDid !== undefined) {
      throw new Error('Connect: approval must not return delegate key material when the request supplied its own `delegateDid`.');
    }
    if (request.delegateDid === undefined && approval.delegatePortableDid === undefined) {
      throw new Error('Connect: approval must include `delegatePortableDid` for wallet-minted delegate sessions.');
    }

    const iat = Math.floor(Date.now() / 1000);
    const response: ConnectResponse = {
      providerDid,
      delegateDid        : approval.delegateDid,
      aud                : request.clientDid,
      iat,
      exp                : iat + CONNECT_RESPONSE_TTL_SECONDS,
      nonce              : request.nonce,
      state              : request.state,
      delegateGrants     : approval.delegateGrants,
      sessionRevocations : approval.sessionRevocations,
      ...(approval.delegatePortableDid !== undefined ? { delegatePortableDid: approval.delegatePortableDid } : {}),
    };

    return await sealResponse({ response, signer, responseKey: request.responseKey, pin });
  }

  /**
   * Returns the opaque deny token a wallet delivers in place of a sealed
   * response when the user rejects the request.
   */
  public static denyToken(): string {
    return CONNECT_DENIED_TOKEN;
  }
}
