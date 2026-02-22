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
