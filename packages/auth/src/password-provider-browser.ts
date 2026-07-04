/**
 * Browser-safe password provider helpers.
 *
 * Node-only helpers such as environment and TTY prompting stay on
 * `@enbox/auth`; browser code should use callback-based providers or pass
 * passwords directly to auth methods.
 *
 * @module
 */

import type { PasswordContext } from './password-provider.js';

export type { PasswordContext } from './password-provider.js';

/**
 * A strategy for obtaining a vault password.
 */
export interface PasswordProvider {
  /**
   * Obtain a password.
   *
   * @param context - Why the password is needed.
   * @returns The password string.
   */
  getPassword(context: PasswordContext): Promise<string>;
}

export namespace PasswordProvider {
  /**
   * Create a provider from an arbitrary callback.
   *
   * @param callback - Callback invoked whenever auth needs a password.
   * @returns A password provider that delegates to the callback.
   */
  export function fromCallback(
    callback: (context: PasswordContext) => Promise<string>,
  ): PasswordProvider {
    return {
      getPassword(context: PasswordContext): Promise<string> {
        return callback(context);
      },
    };
  }

  /**
   * Try providers in order until one returns a password.
   *
   * @param providers - Candidate providers.
   * @returns A provider that falls back through the supplied list.
   */
  export function chain(providers: PasswordProvider[]): PasswordProvider {
    if (providers.length === 0) {
      throw new Error('[@enbox/auth] PasswordProvider.chain: at least one provider is required.');
    }

    return {
      async getPassword(context: PasswordContext): Promise<string> {
        let lastError: Error | undefined;

        for (const provider of providers) {
          try {
            return await provider.getPassword(context);
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
          }
        }

        throw lastError ?? new Error('[@enbox/auth] PasswordProvider.chain: all providers failed.');
      },
    };
  }
}
