/**
 * Typed application protocol registration and auth-request projection.
 *
 * An application manifest keeps each {@link TypedProtocol} together with the
 * permission policy used for delegated connect. Runtime codecs remain on the
 * application side; {@link getApplicationProtocolRequests} projects only raw
 * definitions and permissions across the auth/connect boundary.
 */

import type { TypedProtocol } from './protocol-types.js';
import type { Permission, ProtocolRequest } from '@enbox/auth';

import { authoredProtocolDefinitionsEqual } from '@enbox/dwn-sdk-js';
import { isTypedProtocol } from './define-protocol.js';
import { normalizePermissionPolicy } from '@enbox/auth';

/** One typed protocol registered by an application. */
export type ApplicationManifestProtocol<Protocol extends TypedProtocol = TypedProtocol> = {
  /** Typed protocol retained for application APIs and future readiness checks. */
  readonly protocol: Protocol;

  /** Normalized delegated permissions requested for this protocol. */
  readonly permissions: readonly Permission[];
};

type ApplicationManifestProtocolRegistration<Protocol extends TypedProtocol = TypedProtocol> = {
  readonly protocol: Protocol;
  readonly permissions?: readonly Permission[];
};

/** A direct typed-protocol shorthand or an entry with explicit permissions. */
export type ApplicationManifestProtocolInput<Protocol extends TypedProtocol = TypedProtocol> =
  | Protocol
  | ApplicationManifestProtocolRegistration<Protocol>;

/** A stable application-owned registry of typed protocols. */
export type ApplicationManifest<
  Protocols extends readonly ApplicationManifestProtocol[] = readonly ApplicationManifestProtocol[],
> = {
  /** Normalized typed protocol registrations, in declaration order. */
  readonly protocols: Protocols;
};

type TypedProtocolFromInput<Input> =
  Input extends TypedProtocol
    ? Input
    : Input extends ApplicationManifestProtocolRegistration<infer Protocol>
      ? Protocol
      : never;

type NormalizedManifestProtocols<Inputs extends readonly ApplicationManifestProtocolInput[]> = {
  readonly [Index in keyof Inputs]: ApplicationManifestProtocol<TypedProtocolFromInput<Inputs[Index]>>;
};

/** Options accepted by {@link defineApplicationManifest}. */
export type DefineApplicationManifestOptions<
  Inputs extends readonly ApplicationManifestProtocolInput[] = readonly ApplicationManifestProtocolInput[],
> = {
  readonly protocols: Inputs;
};

/**
 * Registers the typed protocols and delegated permission policies for one
 * application.
 *
 * Direct `TypedProtocol` entries use auth's default permissions. Wrap a typed
 * protocol in `{ protocol, permissions }` for an explicit policy. Protocol URIs
 * must be unique; duplicate and conflicting definitions are rejected instead
 * of silently merging permission policies.
 *
 * The returned manifest freezes only its copied containers. Caller-owned typed
 * protocols, definitions, and codecs are retained by reference and are not
 * frozen or otherwise mutated.
 *
 * @example
 * ```ts
 * const application = defineApplicationManifest({
 *   protocols: [
 *     NotesProtocol,
 *     { protocol: PhotosProtocol, permissions: ['read'] },
 *   ],
 * } as const);
 * ```
 */
export function defineApplicationManifest<
  const Inputs extends readonly ApplicationManifestProtocolInput[],
>(
  options: DefineApplicationManifestOptions<Inputs>,
): ApplicationManifest<NormalizedManifestProtocols<Inputs>> {
  const normalized: ApplicationManifestProtocol[] = [];
  const seen = new Map<string, { index: number; protocol: TypedProtocol }>();

  for (const [index, input] of options.protocols.entries()) {
    const registration = isApplicationManifestProtocol(input) ? input : undefined;
    const protocol = registration?.protocol ?? input;
    if (!isTypedProtocol(protocol)) {
      throw new TypeError(`defineApplicationManifest: protocols[${index}] must be a TypedProtocol.`);
    }

    const protocolUri = protocol.definition.protocol;
    const previous = seen.get(protocolUri);
    if (previous !== undefined) {
      const duplicate = authoredProtocolDefinitionsEqual(previous.protocol.definition, protocol.definition);
      const reason = duplicate ? 'duplicate protocol URI' : 'conflicting definitions for protocol URI';
      throw new TypeError(
        `defineApplicationManifest: ${reason} '${protocolUri}' at indexes ${previous.index} and ${index}.`,
      );
    }
    seen.set(protocolUri, { index, protocol });

    const permissions = Object.freeze(normalizePermissionPolicy(
      registration?.permissions,
      `defineApplicationManifest: protocols[${index}].permissions`,
    ));
    normalized.push(Object.freeze({ permissions, protocol }));
  }

  return Object.freeze({
    protocols: Object.freeze(normalized),
  }) as ApplicationManifest<NormalizedManifestProtocols<Inputs>>;
}

/**
 * Projects a typed application manifest into dependency-neutral auth protocol
 * requests for a delegated connect or refresh call.
 *
 * The returned array and permission arrays are fresh mutable copies.
 * Runtime codecs are never included. Owner/vault callers should not pass these
 * requests to `connect()` because a non-empty protocol list intentionally
 * selects auth's delegated-handler route.
 */
export function getApplicationProtocolRequests(
  application: ApplicationManifest,
): ProtocolRequest[] {
  return application.protocols.map(({ permissions, protocol }) => ({
    definition  : protocol.definition,
    permissions : [...permissions],
  }));
}

/** Whether an input uses the explicit application-manifest entry shape. */
function isApplicationManifestProtocol(
  input: ApplicationManifestProtocolInput,
): input is ApplicationManifestProtocolRegistration {
  return Object.hasOwn(input, 'protocol');
}
