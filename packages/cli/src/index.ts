/**
 * @enbox/cli — CLI helpers for Enbox apps.
 *
 * Provides Node/Bun-specific connect handlers while re-exporting the high-level
 * Enbox API and auth session primitives for terminal applications.
 *
 * @packageDocumentation
 */

export {
  defineApplicationManifest,
  Enbox,
  defineProtocol,
  getApplicationProtocolRequests,
  ProtocolReadinessError,
  recordCodecs,
} from '@enbox/api';

export type {
  ApplicationManifest,
  ApplicationManifestProtocol,
  ApplicationManifestProtocolInput,
  DefineApplicationManifestOptions,
  EnboxAnonymousOptions,
  EnboxConnectOptions,
  EnboxConnectResult,
  EnboxParams,
  EnboxSessionParams,
  EncodedRecordData,
  EnsureProtocolsReadyOptions,
  RecordCodec,
  RecordCodecValue,
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
  ProtocolDefinitionCarrier,
  ProtocolPermissionRequest,
  ProtocolRequest,
  RegistrationOptions,
  StorageAdapter,
  SyncOption,
  VaultConnectOptions,
  WalletConnectOptions,
} from '@enbox/auth';

export {
  CliConnectHandler,
  DEFAULT_CLI_SESSION_TTL_SECONDS,
  DEFAULT_CLI_WALLET_URL,
  WALLET_WELL_KNOWN_PATH,
} from './cli-connect-handler.js';
export type { BrowserOpenFunction, CliConnectHandlerOptions, PromptFunction, QrRenderer } from './cli-connect-handler.js';
