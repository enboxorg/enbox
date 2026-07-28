/**
 * Typed application protocol registration and auth-request projection.
 *
 * An application manifest keeps each {@link TypedProtocol} together with the
 * permission policy used for delegated connect. Runtime codecs remain on the
 * application side; {@link getApplicationProtocolRequests} projects only raw
 * definitions and permissions across the auth/connect boundary.
 */

import type { Permission, ProtocolRequest } from '@enbox/auth';

import { definitionsEqual } from './typed-enbox.js';
import { isTypedProtocol } from './define-protocol.js';
import type { TypedProtocol } from './protocol-types.js';

/** One typed protocol registered by an application. */
export type ApplicationManifestProtocol<Protocol extends TypedProtocol = TypedProtocol> = {
  /** Typed protocol retained for application APIs and future readiness checks. */
  readonly protocol: Protocol;

  /**
   * Delegated permissions requested for this protocol. Omit to use auth's
   * default `read`, `write`, and `delete` policy.
   */
  readonly permissions?: readonly Permission[];
};

/** A direct typed-protocol shorthand or an entry with explicit permissions. */
export type ApplicationManifestProtocolInput<Protocol extends TypedProtocol = TypedProtocol> =
  | Protocol
  | ApplicationManifestProtocol<Protocol>;

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
    : Input extends ApplicationManifestProtocol<infer Protocol>
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
      const duplicate = definitionsEqual(previous.protocol.definition, protocol.definition);
      const reason = duplicate ? 'duplicate protocol URI' : 'conflicting definitions for protocol URI';
      throw new TypeError(
        `defineApplicationManifest: ${reason} '${protocolUri}' at indexes ${previous.index} and ${index}.`,
      );
    }
    seen.set(protocolUri, { index, protocol });

    const permissions = registration?.permissions === undefined
      ? undefined
      : Object.freeze(copyPermissionPolicy(registration.permissions, index));
    const entry = permissions === undefined
      ? { protocol }
      : { permissions, protocol };
    normalized.push(Object.freeze(entry));
  }

  return Object.freeze({
    protocols: Object.freeze(normalized),
  }) as ApplicationManifest<NormalizedManifestProtocols<Inputs>>;
}

/**
 * Projects a typed application manifest into dependency-neutral auth protocol
 * requests for a delegated connect or refresh call.
 *
 * The returned array and explicit permission arrays are fresh mutable copies.
 * Runtime codecs are never included. Owner/vault callers should not pass these
 * requests to `connect()` because a non-empty protocol list intentionally
 * selects auth's delegated-handler route.
 */
export function getApplicationProtocolRequests(
  application: ApplicationManifest,
): ProtocolRequest[] {
  return application.protocols.map(({ permissions, protocol }) => {
    if (permissions === undefined) {
      return protocol.definition;
    }

    return {
      definition  : protocol.definition,
      permissions : [...permissions],
    };
  });
}

/** Whether an input uses the explicit application-manifest entry shape. */
function isApplicationManifestProtocol(
  input: ApplicationManifestProtocolInput,
): input is ApplicationManifestProtocol {
  return Object.hasOwn(input, 'protocol');
}

/** Validate and copy one explicit permission policy without mutating caller-owned input. */
function copyPermissionPolicy(value: unknown, protocolIndex: number): Permission[] {
  const path = `protocols[${protocolIndex}].permissions`;
  if (!Array.isArray(value)) {
    throw new TypeError(`defineApplicationManifest: ${path} must be an array.`);
  }

  const permissions: Permission[] = [];
  const firstIndexes = new Map<Permission, number>();
  for (const [permissionIndex, permission] of value.entries()) {
    if (!isPermission(permission)) {
      throw new TypeError(
        `defineApplicationManifest: ${path}[${permissionIndex}] has unsupported permission ` +
        `'${String(permission)}'. Supported permissions: read, write, delete.`,
      );
    }

    const firstIndex = firstIndexes.get(permission);
    if (firstIndex !== undefined) {
      throw new TypeError(
        `defineApplicationManifest: ${path} contains duplicate permission '${permission}' ` +
        `at indexes ${firstIndex} and ${permissionIndex}.`,
      );
    }

    firstIndexes.set(permission, permissionIndex);
    permissions.push(permission);
  }

  return permissions;
}

function isPermission(value: unknown): value is Permission {
  return value === 'read' || value === 'write' || value === 'delete';
}
