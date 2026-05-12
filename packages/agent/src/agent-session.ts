import type { EnboxAgent } from './types/agent.js';

/** Lightweight metadata about the identity bound to an agent session. */
export interface AgentSessionIdentity {
  /** The DID URI for this identity. */
  didUri: string;

  /** Human-readable name. */
  name: string;

  /** Present when this identity is a delegate of another DID. */
  connectedDid?: string;
}

/** Parameters used to construct an {@link AgentSession}. */
export type AgentSessionParams = {
  /** The authenticated Enbox agent managing keys, DIDs, and DWN access. */
  agent: EnboxAgent;

  /** The DID URI of the connected identity. */
  did: string;

  /** The delegate DID URI, present when connected via delegated wallet access. */
  delegateDid?: string;

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
  public readonly agent: EnboxAgent;

  /** The DID URI of the connected identity. */
  public readonly did: string;

  /** The delegate DID URI, present when connected via delegated wallet access. */
  public readonly delegateDid?: string;

  /** The BIP-39 recovery phrase, present only on first-time local connect. */
  public readonly recoveryPhrase?: string;

  /** Metadata about the connected identity. */
  public readonly identity: AgentSessionIdentity;

  public constructor(params: AgentSessionParams) {
    this.agent = params.agent;
    this.did = params.did;
    this.delegateDid = params.delegateDid;
    this.recoveryPhrase = params.recoveryPhrase;
    this.identity = params.identity;
  }
}
