import type { EnboxPlatformAgent } from './types/agent.js';

/** Lightweight metadata about the identity bound to an agent session. */
export interface AgentSessionIdentity {
  /** The DID URI for this identity. */
  didUri: string;

  /** Human-readable name. */
  name: string;

  /** Present when this identity is a delegate of another DID. */
  connectedDid?: string;
}

/**
 * The minimal session shape shared across higher-level packages.
 *
 * Every Enbox session — whether produced by `@enbox/agent`, `@enbox/auth`, or
 * a custom flow — has at least these primitives. `@enbox/api` and other
 * downstream packages depend on this base type rather than re-declaring the
 * same fields, so any change to the session shape happens in one place.
 *
 * `agent` is typed as {@link EnboxPlatformAgent} rather than the narrow
 * `EnboxAgent` because every real session is bound to a platform-shaped
 * agent (vault, sync, secrets are required for session lifecycle). This
 * lets consumers like `@enbox/api` bind sync-backed contexts and delivery
 * state without a runtime guard or unsafe cast.
 */
export type AgentSessionPrimitives = {
  /** The authenticated Enbox agent managing keys, DIDs, and DWN access. */
  agent: EnboxPlatformAgent;

  /** The DID URI of the connected identity. */
  did: string;

  /** The delegate DID URI, present when connected via delegated wallet access. */
  delegateDid?: string;

  /**
   * Aborted when the session is no longer authorized for application work.
   * The session's lifecycle owner aborts this signal on lock, disconnect,
   * shutdown, or replacement by another identity.
   */
  signal: AbortSignal;
};

/** Parameters used to construct an {@link AgentSession}. */
export type AgentSessionParams = AgentSessionPrimitives & {
  /** The BIP-39 recovery phrase, present only on first-time local connect. */
  recoveryPhrase?: string;

  /** Metadata about the connected identity. */
  identity: AgentSessionIdentity;
};

/**
 * An active session bound to an agent and connected DID.
 *
 * This type intentionally lives in `@enbox/agent` so higher-level packages can
 * share the session shape without depending on the auth orchestration package.
 */
export class AgentSession {
  /** The authenticated Enbox agent managing keys, DIDs, and DWN access. */
  public readonly agent: EnboxPlatformAgent;

  /** The DID URI of the connected identity. */
  public readonly did: string;

  /** The delegate DID URI, present when connected via delegated wallet access. */
  public readonly delegateDid?: string;

  /** The BIP-39 recovery phrase, present only on first-time local connect. */
  public readonly recoveryPhrase?: string;

  /** Metadata about the connected identity. */
  public readonly identity: AgentSessionIdentity;

  /** Aborted when this session is locked, disconnected, shut down, or replaced. */
  public readonly signal: AbortSignal;

  public constructor(params: AgentSessionParams) {
    if (params.signal === undefined) {
      throw new TypeError('AgentSession: signal is required so the lifecycle owner can end the session.');
    }

    this.agent = params.agent;
    this.did = params.did;
    this.delegateDid = params.delegateDid;
    this.recoveryPhrase = params.recoveryPhrase;
    this.identity = params.identity;
    this.signal = params.signal;
  }
}
