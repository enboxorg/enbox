/**
 * AuthSession represents an active, authenticated session with a specific identity.
 * @module
 */

import type { EnboxAgent } from '@enbox/agent';

import type { IdentityInfo } from './types.js';

/**
 * An active, authenticated session bound to a specific identity.
 *
 * The session exposes the authenticated **agent**, **did**, and
 * **delegateDid** — the primitives needed to interact with the DWN
 * network. Consumers that use `@enbox/api` can construct an `Enbox`
 * instance from these properties:
 *
 * ```ts
 * import { Enbox } from '@enbox/api';
 *
 * const session = await auth.connect();
 * const enbox = Enbox.connect({
 *   agent: session.agent,
 *   connectedDid: session.did,
 *   delegateDid: session.delegateDid,
 * });
 * ```
 */
export class AuthSession {
  /** The authenticated Enbox agent managing keys, DIDs, and DWN access. */
  readonly agent: EnboxAgent;

  /** The DID URI of the connected identity. */
  readonly did: string;

  /**
   * The delegate DID URI, present when connected via wallet connect.
   * This is the locally-created DID that holds delegated permissions
   * from the wallet's identity.
   */
  readonly delegateDid?: string;

  /**
   * The BIP-39 recovery phrase, present only on first-time local connect.
   * Should be shown to the user for backup and then discarded from memory.
   */
  readonly recoveryPhrase?: string;

  /** Metadata about the connected identity. */
  readonly identity: IdentityInfo;

  constructor(params: {
    agent: EnboxAgent;
    did: string;
    delegateDid?: string;
    recoveryPhrase?: string;
    identity: IdentityInfo;
  }) {
    this.agent = params.agent;
    this.did = params.did;
    this.delegateDid = params.delegateDid;
    this.recoveryPhrase = params.recoveryPhrase;
    this.identity = params.identity;
  }
}
