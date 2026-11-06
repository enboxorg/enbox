/**
 * Cross-cutting constants that are shared between modules which cannot directly
 * import each other without creating circular dependencies.
 */

/**
 * Well-known module path for permission grant revocation records.
 * Defined here (rather than on `PermissionsModule`) to avoid circular
 * dependencies between `grant-authorization.ts` and `modules/permissions.ts`.
 */
export const PERMISSIONS_REVOCATION_PATH = 'grant/revocation';

/**
 * The DWN Permissions module URI.
 */
export const PERMISSIONS_MODULE_URI = 'https://identity.foundation/dwn/permissions';

/**
 * The DWN Encryption module URI.
 */
export const ENCRYPTION_MODULE_URI = 'https://identity.foundation/dwn/modules/encryption';
export const ENCRYPTION_MODULE_GRANT_KEY_PATH = 'grantKey';
export const ENCRYPTION_MODULE_WRAPPED_GRANT_KEY_PATH = 'wrappedGrantKey';

/**
 * Reserved virtual module path root for source-module-native encryption
 * control records.
 */
export const ENCRYPTION_CONTROL_ROOT_PATH = '$encryption';

/**
 * Reserved module path for role-audience public keys and owner seals.
 */
export const ENCRYPTION_CONTROL_AUDIENCE_PATH = `${ENCRYPTION_CONTROL_ROOT_PATH}/audience`;

/**
 * Reserved module path for role-audience key deliveries.
 */
export const ENCRYPTION_CONTROL_DELIVERY_PATH = `${ENCRYPTION_CONTROL_ROOT_PATH}/delivery`;

/**
 * Fixed JSON schema URI for source-module audience control records.
 */
export const ENCRYPTION_CONTROL_AUDIENCE_SCHEMA_URI = 'https://identity.foundation/dwn/json-schemas/encryption/audience.json';

/**
 * Fixed JSON schema URI for source-module delivery control records.
 */
export const ENCRYPTION_CONTROL_DELIVERY_SCHEMA_URI = 'https://identity.foundation/dwn/json-schemas/encryption/delivery.json';

/**
 * Reserved encryption control module paths.
 */
export const ENCRYPTION_CONTROL_PATHS = [
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
] as const;

export type EncryptionControlPath = typeof ENCRYPTION_CONTROL_PATHS[number];

/**
 * Returns true when the module path is one of the exact reserved encryption
 * control paths.
 */
export function isEncryptionControlPath(modulePath: string | undefined): modulePath is EncryptionControlPath {
  return modulePath !== undefined &&
    (ENCRYPTION_CONTROL_PATHS as readonly string[]).includes(modulePath);
}
