import { DwnServerError, DwnServerErrorCode } from '../dwn-error.js';

/**
 * Interface for validating provider auth registration tokens.
 * DWN server operators implement this to integrate with their auth service.
 *
 * The token is intentionally opaque — it could be a JWT, blind RSA token,
 * ecash token, or any other format. The plugin is responsible for all
 * validation logic.
 */
export interface ProviderAuthPlugin {
  /**
   * Validate a registration token presented during DID registration.
   *
   * @param token - The opaque registration token from the client
   * @returns Validation result with optional account metadata
   */
  validateRegistrationToken(token: string): Promise<ProviderAuthValidationResult>;
}

/**
 * Result of validating a provider auth registration token.
 */
export type ProviderAuthValidationResult = {
  /** Whether the token is valid and the registration should proceed. */
  isValid : boolean;

  /**
   * Optional account identifier that this DID registration is associated with.
   * Omit for privacy-preserving providers where DID-to-account correlation
   * should not be stored.
   */
  accountId? : string;

  /**
   * Optional provider-defined metadata to store with the tenant registration.
   * Can include plan details, quotas, or any other provider-specific data.
   * Stored as JSON in the registeredTenants table.
   */
  metadata? : Record<string, unknown>;

  /** Error detail message when isValid is false. */
  detail? : string;
};

/**
 * Load a ProviderAuthPlugin from a file path.
 * The module must export a default class or object that implements ProviderAuthPlugin.
 *
 * Follows the same pattern as the existing PluginLoader.
 */
export async function loadProviderAuthPlugin(pluginPath: string): Promise<ProviderAuthPlugin> {
  let module: any;
  try {
    module = await import(pluginPath);
  } catch (error) {
    throw new DwnServerError(
      DwnServerErrorCode.ProviderAuthPluginLoadFailed,
      `Failed to load provider auth plugin at ${pluginPath}: ${(error as Error).message}`,
    );
  }

  const plugin = module.default;
  if (plugin === undefined) {
    throw new DwnServerError(
      DwnServerErrorCode.ProviderAuthPluginLoadFailed,
      `Provider auth plugin at ${pluginPath} does not have a default export.`,
    );
  }

  // Support both class (instantiate) and plain object exports.
  const instance: ProviderAuthPlugin = typeof plugin === 'function'
    ? new plugin() as ProviderAuthPlugin
    : plugin as ProviderAuthPlugin;

  if (typeof instance.validateRegistrationToken !== 'function') {
    throw new DwnServerError(
      DwnServerErrorCode.ProviderAuthPluginLoadFailed,
      `Provider auth plugin at ${pluginPath} does not implement validateRegistrationToken().`,
    );
  }

  return instance;
}
