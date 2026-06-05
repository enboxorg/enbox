/**
 * Cross-cutting constants that are shared between modules which cannot directly
 * import each other without creating circular dependencies.
 */

/**
 * Well-known protocol path for permission grant revocation records.
 * Defined here (rather than on `PermissionsProtocol`) to avoid circular
 * dependencies between `grant-authorization.ts` and `protocols/permissions.ts`.
 */
export const PERMISSIONS_REVOCATION_PATH = 'grant/revocation';

/**
 * The DWN Permissions protocol URI.
 */
export const PERMISSIONS_PROTOCOL_URI = 'https://identity.foundation/dwn/permissions';

/**
 * Well-known key-delivery protocol URI used for encrypted context-key records.
 */
export const KEY_DELIVERY_PROTOCOL_URI = 'https://identity.foundation/protocols/key-delivery';

const RECORDS_PRIMARY_PROJECTION_EXCLUDED_PROTOCOLS = new Set<string>([
  KEY_DELIVERY_PROTOCOL_URI,
  PERMISSIONS_PROTOCOL_URI,
]);

/**
 * Returns true for infrastructure protocols whose records are dependencies or
 * authorization metadata, not primary application records for projection roots.
 */
export function isRecordsPrimaryProjectionExcludedProtocol(protocol: string | undefined): boolean {
  return protocol !== undefined &&
    RECORDS_PRIMARY_PROJECTION_EXCLUDED_PROTOCOLS.has(protocol);
}
