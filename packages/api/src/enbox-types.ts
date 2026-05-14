/**
 * Public type surface for the {@link Enbox} class.
 *
 * Session and connect types are derived from
 * {@link AgentSessionPrimitives} in `@enbox/agent`, so the minimal session
 * shape lives in one place and downstream packages stay in sync.
 *
 * @module
 */

import type { AgentSessionPrimitives } from '@enbox/agent';
import type { AuthManager } from '@enbox/auth/auth-manager';
import type { DidMethodResolver } from '@enbox/dids';
import type { AuthManagerOptions, AuthSession, ConnectOptions } from '@enbox/auth';

import type { DwnReaderApi } from './dwn-reader-api.js';
import type { Enbox } from './enbox.js';

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
 * Contains only a read-only `dwn` property — no `did`, `vc`, or `agent`.
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
export type EnboxParams = Omit<AgentSessionPrimitives, 'did'> & {
  /** The DID of the tenant under which all DID, DWN, and VC requests are being performed. */
  connectedDid: string;
};

/**
 * Session-shaped parameters accepted by {@link Enbox.fromSession} and
 * {@link Enbox.connect}.
 *
 * This is an alias for {@link AgentSessionPrimitives} so callers can pass an
 * `AuthSession` from `@enbox/auth`, an `AgentSession` from `@enbox/agent`, or
 * any compatible custom session without duplicating field declarations.
 */
export type EnboxSessionParams = AgentSessionPrimitives;

/** Legacy object wrapper for passing a session into {@link Enbox.connect}. */
export type EnboxSessionWrapper = {
  /** An active agent/auth session. */
  session: EnboxSessionParams;
};

/** Existing connection inputs that can be adapted synchronously. */
export type EnboxConnectionInput = EnboxParams | EnboxSessionParams | EnboxSessionWrapper;

/**
 * High-level connection options for {@link Enbox.connect}.
 *
 * Options are split internally between `AuthManager.create()` and
 * `auth.connect()`. For advanced flows, pass an explicit `connect` object to
 * control the exact `AuthManager.connect()` options.
 */
export type EnboxConnectOptions = AuthManagerOptions & ConnectOptions & {
  /** Explicit options to pass to `AuthManager.connect()`. */
  connect?: ConnectOptions;
};

/** The result of a high-level asynchronous {@link Enbox.connect} call. */
export type EnboxConnectResult = {
  /** The AuthManager that owns the session lifecycle. */
  auth: AuthManager;

  /** The high-level Enbox API instance. */
  enbox: Enbox;

  /** The active session returned by `AuthManager.connect()`. */
  session: AuthSession;
};
