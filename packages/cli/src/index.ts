/**
 * @enbox/cli — CLI helpers for Enbox apps.
 *
 * Provides Node/Bun-specific connect handlers while re-exporting the high-level
 * Enbox API and auth session primitives for terminal applications.
 *
 * @packageDocumentation
 */

export * from '@enbox/api';

export * from '@enbox/auth';

export {
  CliConnectHandler,
  DEFAULT_CLI_SESSION_TTL_SECONDS,
  DEFAULT_CLI_WALLET_URL,
  WALLET_WELL_KNOWN_PATH,
} from './cli-connect-handler.js';
export type { BrowserOpenFunction, CliConnectHandlerOptions, PromptFunction, QrRenderer } from './cli-connect-handler.js';
