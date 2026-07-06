/**
 * @enbox/cli — CLI helpers for Enbox apps.
 *
 * Provides Node/Bun-specific connect handlers while re-exporting the high-level
 * Enbox API and auth session primitives for terminal applications.
 *
 * @packageDocumentation
 */

export {
  Enbox,
  defineProtocol,
  repository,
} from '@enbox/api';

export type {
  EnboxAnonymousOptions,
  EnboxConnectOptions,
  EnboxConnectResult,
  EnboxParams,
  EnboxSessionParams,
} from '@enbox/api';

export {
  AuthManager,
  AuthSession,
  normalizeProtocolRequests,
  WalletConnect,
} from '@enbox/auth';

export type {
  AuthEvent,
  AuthEventHandler,
  AuthManagerOptions,
  AuthState,
  ConnectHandler,
  ConnectOptions,
  ConnectResult,
  DisconnectOptions,
  HandlerConnectOptions,
  ImportFromPortableOptions,
  Permission,
  PortableIdentity,
  ProtocolRequest,
  RegistrationOptions,
  StorageAdapter,
  SyncOption,
  VaultConnectOptions,
  WalletConnectOptions,
} from '@enbox/auth';

export { CliConnectHandler, DEFAULT_CLI_WALLET_URL } from './cli-connect-handler.js';
export type { BrowserOpenFunction, CliConnectHandlerOptions, PromptFunction, QrRenderer } from './cli-connect-handler.js';
