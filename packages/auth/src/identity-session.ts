/**
 * AuthSession represents an active, authenticated session with a specific identity.
 * @module
 */

import type { Web5 } from '@enbox/api';

import type { IdentityInfo } from './types.js';

/**
 * An active, authenticated session bound to a specific identity.
 *
 * This is the primary object consumers interact with after connecting.
 * It provides access to the {@link Web5} instance for protocol-scoped
 * DWN operations via `session.web5.using(protocol)`.
 *
 * ```ts
 * const session = await auth.connect();
 * const protocol = session.web5.using(MyProtocol);
 * const { record } = await protocol.records.create('item', { data: { ... } });
 * ```
 */
export class AuthSession {
  /** The Web5 instance for DWN operations. */
  readonly web5: Web5;

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
    web5: Web5;
    did: string;
    delegateDid?: string;
    recoveryPhrase?: string;
    identity: IdentityInfo;
  }) {
    this.web5 = params.web5;
    this.did = params.did;
    this.delegateDid = params.delegateDid;
    this.recoveryPhrase = params.recoveryPhrase;
    this.identity = params.identity;
  }
}
