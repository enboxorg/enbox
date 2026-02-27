/**
 * AuthSession represents an active, authenticated session with a specific identity.
 * @module
 */

import type { Web5Agent } from '@enbox/agent';
import { Web5 } from '@enbox/api';

import type { IdentityInfo } from './types.js';

/**
 * An active, authenticated session bound to a specific identity.
 *
 * The session exposes the authenticated **agent**, **connectedDid**, and
 * **delegateDid** — the primitives needed by `@enbox/api` to construct
 * a `Web5` instance. A convenience {@link web5} getter is provided for
 * apps that use `@enbox/api` directly.
 *
 * **Typical usage with `@enbox/api`:**
 * ```ts
 * import { Web5 } from '@enbox/api';
 *
 * const session = await auth.connect();
 * const web5 = new Web5({
 *   agent: session.agent,
 *   connectedDid: session.did,
 *   delegateDid: session.delegateDid,
 * });
 * ```
 *
 * **Or use the convenience getter:**
 * ```ts
 * const session = await auth.connect();
 * const web5 = session.web5; // lazily constructed Web5 instance
 * ```
 */
export class AuthSession {
  /** The authenticated Web5 agent managing keys, DIDs, and DWN access. */
  readonly agent: Web5Agent;

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

  /** Lazily-constructed Web5 instance. */
  private _web5?: Web5;

  constructor(params: {
    agent: Web5Agent;
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

  /**
   * Convenience getter that returns a `Web5` instance from `@enbox/api`.
   *
   * The instance is lazily constructed on first access and cached.
   * This is equivalent to:
   * ```ts
   * new Web5({ agent: session.agent, connectedDid: session.did, delegateDid: session.delegateDid })
   * ```
   *
   * Apps that don't use `@enbox/api` directly (e.g. CLI tools that only
   * need the agent) can ignore this property entirely.
   */
  get web5(): Web5 {
    if (!this._web5) {
      this._web5 = new Web5({
        agent        : this.agent,
        connectedDid : this.did,
        delegateDid  : this.delegateDid,
      });
    }
    return this._web5;
  }
}
