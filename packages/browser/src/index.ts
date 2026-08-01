/**
 * @enbox/browser — The Enbox browser SDK.
 *
 * For browser-based dapps, this is the only package you need to import.
 * It re-exports the high-level API from `@enbox/api`, the authentication
 * layer from `@enbox/auth`, and provides browser-specific connect handlers.
 *
 * @example Single-import dapp setup
 * ```ts
 * import {
 *   Enbox, BrowserConnectHandler,
 *   defineProtocol, recordCodecs,
 * } from '@enbox/browser';
 *
 * const { enbox, session } = await Enbox.connect({
 *   connectHandler: BrowserConnectHandler({ appName: 'My App' }),
 *   protocols: [MyProtocol],
 * });
 * ```
 *
 * For non-browser environments (Node.js, CLI, desktop), import from
 * `@enbox/api` and `@enbox/auth` directly instead.
 *
 * @packageDocumentation
 */

// ─── Re-exports from @enbox/api ─────────────────────────────────
//
// The high-level Enbox API: DWN records and protocols.

export {
  AudienceDecryptError,
  createConnectionStore,
  defineApplicationManifest,
  DwnResponseError,
  Enbox,
  FollowedSourceNotReadyError,
  defineProtocol,
  getApplicationProtocolRequests,
  ProtocolReadinessError,
  RecordValidationError,
  recordCodecs,
} from '@enbox/api';

export type {
  ApplicationConnectionStore,
  ApplicationConnectionStoreConnectOptions,
  ApplicationConnectionStoreOptions,
  ApplicationConnectionStoreRefreshOptions,
  ApplicationManifest,
  ApplicationManifestProtocol,
  ApplicationManifestProtocolInput,
  AudienceDecryptFailureCause,
  ConnectionPhase,
  ConnectionSnapshot,
  ConnectionSnapshotListener,
  ConnectionStore,
  ConnectionStoreOptions,
  ContextMember,
  ContextMembersApi,
  ContextMaterializedRecord,
  ContextRecord,
  ContextRecordDeleteParams,
  ContextRecordsApi,
  ContextRecordUpdateParams,
  ContextsApi,
  DefineApplicationManifestOptions,
  EnboxAnonymousOptions,
  EnboxConnectOptions,
  EnboxConnectResult,
  EnboxParams,
  EnboxSessionParams,
  EncodedRecordData,
  EnsureProtocolsReadyOptions,
  FollowContextOptions,
  JsonRecordCodecOptions,
  MaterializedRecord,
  MemberContext,
  OwnedContext,
  ProtocolContext,
  ProtocolRolePaths,
  RecordCodec,
  RecordCodecContext,
  RecordCodecValue,
  RecordFilter,
  RecordPage,
  RecordPatch,
  RecordQuery,
  RecordSubscription,
  RecordSubscriptionEvent,
  RecordSubscriptionListener,
  RecordView,
  RecordViewListener,
  RecordViewSnapshot,
  RecordViewState,
  RecordValidationFailure,
  RecordValidator,
  ReplicationCurrentness,
  RoleDeliveryState,
  SyncStatusSnapshot,
} from '@enbox/api';

// ─── Re-exports from @enbox/auth ────────────────────────────────
//
// Authentication lifecycle, session management, connect handlers.

export {
  AuthManager,
  AuthSession,
  ConnectDeniedError,
  SESSION_EXPIRED_ERROR_CODE,
  SESSION_REVOKED_ERROR_CODE,
  computeConnectionStatus,
  isConnectDeniedError,
  isSessionExpiredError,
  isSessionInvalidError,
  normalizeProtocolRequests,
  WalletConnect,
} from '@enbox/auth/browser';

export type {
  AuthEvent,
  AuthEventHandler,
  AuthManagerOptions,
  AuthState,
  ComputeConnectionStatusOptions,
  ConnectionMonitorOptions,
  ConnectionState,
  ConnectionStatus,
  ConnectionStatusGrant,
  ConnectHandler,
  ConnectOptions,
  ConnectResult,
  DisconnectOptions,
  GetConnectionStatusOptions,
  HandlerConnectOptions,
  ImportFromPortableOptions,
  VaultConnectOptions,
  Permission,
  PortableIdentity,
  ProtocolDefinitionCarrier,
  ProtocolPermissionRequest,
  ProtocolRequest,
  RefreshOptions,
  RegistrationOptions,
  StorageAdapter,
  SyncOption,
  WalletConnectOptions,
} from '@enbox/auth/browser';

// ─── Re-exports from @enbox/connect ─────────────────────────────
//
// The connect kernel pieces wallet apps need alongside the popup
// transports: opening/sealing envelopes and the deny token.

export { CONNECT_DENIED_TOKEN, ConnectProvider } from '@enbox/connect';
export type { ConnectApproval, ConnectPermissionRequest, ConnectRequest, ConnectRequestType } from '@enbox/connect';

// ─── Browser-specific exports ───────────────────────────────────
//
// DWeb Connect popup transports, wallet selector, DRL polyfills.

export * from './web-features.js';
export { BrowserConnectHandler, DEFAULT_WALLETS } from './browser-connect-handler.js';
export type { BrowserConnectHandlerOptions, WalletOption } from './browser-connect-handler.js';
export { connectViaPopup, PopupClientTransport, PopupWindowClosedError } from './dweb-connect-client.js';
export type { PopupClientTransportOptions, PopupConnectOptions } from './dweb-connect-client.js';
export { WalletPostMessageTransport } from './dweb-connect-wallet.js';
export type { WalletPostMessageTransportOptions } from './dweb-connect-wallet.js';
export {
  DWEB_CONNECT_ACK_MESSAGE_TYPE,
  DWEB_CONNECT_LOADED_MESSAGE_TYPE,
  DWEB_CONNECT_PATH,
  DWEB_CONNECT_REQUEST_MESSAGE_TYPE,
  DWEB_CONNECT_RESPONSE_MESSAGE_TYPE,
} from './dweb-connect-messages.js';
export type {
  DWebConnectAckMessage,
  DWebConnectLoadedMessage,
  DWebConnectRequestMessage,
  DWebConnectResponseMessage,
} from './dweb-connect-messages.js';
export { fetchWalletWellKnown, probeWalletWellKnown, WALLET_WELL_KNOWN_PATH } from './ui/wallet-well-known.js';
export type { WalletWellKnownDocument } from './ui/wallet-well-known.js';
export { discoverWalletConnectServerUrl, runConnectModal } from './ui/connect-modal.js';
export type { ConnectMethod, ConnectModalDeps, ConnectModalOptions, ConnectModalPalette, ConnectModalTheme } from './ui/connect-modal.js';
export { MAX_PIN_ATTEMPTS, RelayConnectCancelledError, runRelayConnect } from './relay-connect-runner.js';
export type { RelayConnectOptions } from './relay-connect-runner.js';
export { encodeQr, qrToSvg } from './ui/qr.js';
export type { QrCode, QrSvgOptions } from './ui/qr.js';

// ─── Convenience re-exports for dapps ───────────────────────────
//
// So that most browser dapps only need `@enbox/browser` (plus
// `@enbox/protocols` for shared protocol definitions). These surface the
// symbols dapps most commonly reached into sibling packages for; anything
// more specialized is still available by importing the underlying package
// directly.

// Canonical typed record (from @enbox/api).
export { Record } from '@enbox/api';

// Custom storage adapter + DWN registration provider-auth callback shapes
// (from @enbox/auth).
export { BrowserStorage } from '@enbox/auth/browser';
export type { ProviderAuthParams, ProviderAuthResult } from '@enbox/auth/browser';

// Public-profile read/cache layer (from @enbox/protocols): fetch other
// users' published profiles (displayName + avatar/hero) from their DWNs
// with caching, retries, negative caching, and refcounted subscriptions.
// Works over a connected records surface and over `Enbox.anonymous()`.
export { createProfileReader, isRetryableProfileReadStatus } from '@enbox/protocols';
export type {
  ProfileEntryStatus,
  ProfileFieldSnapshot,
  ProfileFieldStatus,
  ProfileImages,
  ProfileReader,
  ProfileReaderFailure,
  ProfileReaderImagesMode,
  ProfileReaderOptions,
  ProfileReaderRecordsSurface,
  ProfileReaderSource,
  ProfileReaderTimers,
  ProfileSnapshot,
  ProfileWatchListener,
  PublicProfile,
} from '@enbox/protocols';

// DWN interface enum for typing agent requests (from @enbox/agent).
export { DwnInterface } from '@enbox/agent';

// Sync-status observability for dapp "remotes" panels (from @enbox/agent).
// Subscribe with `agent.sync.on(event => …)` and snapshot per-remote health
// (healthy / quota-blocked / degraded / offline), including when a
// quota-blocked remote will next be re-probed, via
// `agent.sync.getRemoteSyncStatus()`; resume immediately with
// `agent.sync.retryRemoteNow(tenantDid, remoteEndpoint)`.
export type {
  DeadLetterEntry,
  RemoteSyncState,
  RemoteSyncStatus,
  SyncConnectivityState,
  SyncEngine,
  SyncEvent,
  SyncEventListener,
  SyncHealthSummary,
} from '@enbox/agent';

// Common DWN primitives for record queries, permission scopes, and protocol
// typing (from @enbox/dwn-sdk-js).
export { DateSort, DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';
export type { ProtocolActionRule, ProtocolDefinition } from '@enbox/dwn-sdk-js';
