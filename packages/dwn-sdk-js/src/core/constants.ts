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
 * The DWN Encryption protocol URI.
 */
export const ENCRYPTION_PROTOCOL_URI = 'https://identity.foundation/dwn/protocols/encryption';

/**
 * Reserved virtual protocol path root for source-protocol-native encryption
 * control records.
 */
export const ENCRYPTION_CONTROL_ROOT_PATH = '$encryption';

/**
 * Reserved protocol path for role-audience public keys and owner seals.
 */
export const ENCRYPTION_CONTROL_AUDIENCE_PATH = `${ENCRYPTION_CONTROL_ROOT_PATH}/audience`;

/**
 * Reserved protocol path for role-audience key deliveries.
 */
export const ENCRYPTION_CONTROL_DELIVERY_PATH = `${ENCRYPTION_CONTROL_ROOT_PATH}/delivery`;

/**
 * Fixed JSON schema URI for source-protocol audience control records.
 */
export const ENCRYPTION_CONTROL_AUDIENCE_SCHEMA_URI = 'https://identity.foundation/dwn/json-schemas/encryption/audience.json';

/**
 * Fixed JSON schema URI for source-protocol delivery control records.
 */
export const ENCRYPTION_CONTROL_DELIVERY_SCHEMA_URI = 'https://identity.foundation/dwn/json-schemas/encryption/delivery.json';

/**
 * Reserved encryption control protocol paths.
 */
export const ENCRYPTION_CONTROL_PATHS = [
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
] as const;

export type EncryptionControlPath = typeof ENCRYPTION_CONTROL_PATHS[number];

export enum EncryptionControlRecordType {
  Audience = 'audience',
  Delivery = 'delivery',
}

/**
 * Returns true when the protocol path is one of the exact reserved encryption
 * control paths.
 */
export function isEncryptionControlPath(protocolPath: string | undefined): protocolPath is EncryptionControlPath {
  return protocolPath !== undefined &&
    (ENCRYPTION_CONTROL_PATHS as readonly string[]).includes(protocolPath);
}

/**
 * Returns the encryption control record type for exact reserved paths.
 */
export function getEncryptionControlRecordType(protocolPath: EncryptionControlPath): EncryptionControlRecordType {
  if (protocolPath === ENCRYPTION_CONTROL_AUDIENCE_PATH) {
    return EncryptionControlRecordType.Audience;
  }

  return EncryptionControlRecordType.Delivery;
}

const RECORDS_PRIMARY_PROJECTION_EXCLUDED_PROTOCOLS = new Set<string>([
  ENCRYPTION_PROTOCOL_URI,
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
