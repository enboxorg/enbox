/**
 * Public type surface for the {@link Enbox} class.
 *
 * Session types are derived from {@link AgentSessionPrimitives} in
 * `@enbox/agent`, so the minimal shape lives in one place and downstream
 * packages stay in sync.
 *
 * @module
 */

import type { AgentSessionPrimitives } from '@enbox/agent';
import type { DidMethodResolver } from '@enbox/dids';

import type { DwnReaderApi } from './dwn-reader-api.js';

/**
 * Options for creating an anonymous (read-only) Enbox instance via {@link Enbox.anonymous}.
 *
 * @beta
 */
export type EnboxAnonymousOptions = {
  /** Override the default DID method resolvers. Defaults to `[DidDht, DidJwk, DidKey, DidWeb]`. */
  didResolvers?: DidMethodResolver[];
};

/**
 * The result of calling {@link Enbox.anonymous}.
 *
 * Contains only a read-only `dwn` property — no `did` or `agent`.
 *
 * @beta
 */
export type EnboxAnonymousApi = {
  /** A read-only DWN API for querying public data on remote DWNs. */
  dwn: DwnReaderApi;
};

/**
 * Parameters for constructing an {@link Enbox} instance.
 *
 * These are the minimal primitives needed to interact with the DWN network.
 * Typically obtained from an agent session via `@enbox/auth`.
 *
 * Built on {@link AgentSessionPrimitives}: same `agent`/`delegateDid` shape,
 * with `did` renamed to `connectedDid` to mirror the constructor parameter
 * name used throughout `@enbox/api` for the tenant DID.
 */
export type EnboxParams = Omit<AgentSessionPrimitives, 'did' | 'signal'> & {
  /** The DID of the tenant under which all DID and DWN requests are being performed. */
  connectedDid: string;

  /** Optional owning-session lifetime. Aborting it fences session-scoped resources. */
  signal?: AbortSignal;
};

/**
 * Session-shaped parameters accepted by {@link Enbox.fromSession}.
 *
 * Alias for {@link AgentSessionPrimitives} so callers can pass an
 * `AuthSession` from `@enbox/auth`, an `AgentSession` from `@enbox/agent`, or
 * any compatible custom session without duplicating field declarations.
 */
export type EnboxSessionParams = AgentSessionPrimitives;
