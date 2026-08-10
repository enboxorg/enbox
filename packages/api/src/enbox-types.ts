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
import type {
  AuthManagerOptions,
  AuthSession,
  HandlerConnectOptions,
  VaultConnectOptions,
} from '@enbox/auth';

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

/**
 * High-level connection options for {@link Enbox.connect}.
 *
 * Composed of two parts:
 *
 * 1. **Manager-wide defaults** ({@link AuthManagerOptions}) — `password`,
 *    `sync`, `dwnEndpoints`, `connectHandler`, etc. Forwarded to
 *    `AuthManager.create()` and reused across reconnects.
 * 2. **Per-call signals** ({@link HandlerConnectOptions} ∪
 *    {@link VaultConnectOptions}) — `protocols`, `createIdentity`,
 *    `metadata`, etc. Forwarded to `AuthManager.connect()` and used to route
 *    handler or local flow.
 *
 * Several fields (`password`, `sync`, `dwnEndpoints`, `connectHandler`)
 * appear on multiple parents. The intersection keeps a single `?:`-typed
 * field; the value flows to both the manager (as a default) and the
 * per-call payload — matching the behavior of restored sessions.
 *
 * Routing between local and handler flow happens at runtime inside
 * `AuthManager.connect`. See `Enbox.connect()` for examples.
 *
 * If you need full control of the exact options forwarded to
 * `AuthManager.connect()`, drop down one layer: create the
 * `AuthManager` yourself and pass its session to `Enbox.fromSession`.
 * Phrase recovery likewise uses `AuthManager.restoreFromPhrase()` followed
 * by `Enbox.fromSession()`.
 */
export type EnboxConnectOptions =
  & AuthManagerOptions
  & HandlerConnectOptions
  & VaultConnectOptions;

/** The result of a high-level asynchronous {@link Enbox.connect} call. */
export type EnboxConnectResult = {
  /** The AuthManager that owns the session lifecycle. */
  auth: AuthManager;

  /** The high-level Enbox API instance. */
  enbox: Enbox;

  /** The active session returned by `AuthManager.connect()`. */
  session: AuthSession;
};
