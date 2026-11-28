export { ConnectClient, randomToken, resolveDelegatePortableDid } from './client.js';
export type {
  ConnectClientAuthenticateParams,
  ConnectClientConnectParams,
  ConnectClientOptions,
} from './client.js';
// `openRequest` is deliberately not re-exported: `ConnectProvider.openRequest`
// is the single public spelling of the wallet-side open operation.
export {
  assertConnectPermissionRequests,
  assertConnectRequest,
  assertConnectResponse,
  assertConnectAuthenticationResponse,
  assertValidRedirectUri,
  assertX25519PublicJwk,
  CONNECT_REQUEST_JWE_TYP,
  CONNECT_RESPONSE_JWE_TYP,
  openResponse,
  openAuthenticationResponse,
  REQUEST_KEY_BYTE_LENGTH,
  RESPONSE_SECRET_BYTE_LENGTH,
  sealRequest,
  sealResponse,
  sealAuthenticationResponse,
} from './envelope.js';
export type { OpenConnectResponseOptions } from './envelope.js';
export * from './owner-authentication.js';
export * from './jwt.js';
export * from './provider.js';
export {
  APP_MANIFEST_WELL_KNOWN_PATH,
  assertPendingRedirectSessionMode,
  buildRedirectReturnUri,
  completeRedirectAuthentication,
  completeRedirectConnect,
  DEFAULT_REDIRECT_SESSION_MAX_AGE_MS,
  fetchConnectAppManifest,
  generateRedirectResponseSecret,
  isPendingRedirectSessionExpired,
  isRedirectUriVerifiedInManifest,
  parseRedirectReturnUri,
  prepareRedirectConnectRequest,
} from './redirect.js';
export type {
  CompleteRedirectOptions,
  ConnectAppManifest,
  PendingRedirectConnectSession,
  PreparedRedirectConnect,
  PrepareRedirectConnectParams,
  RedirectReturnPayload,
} from './redirect.js';
export {
  fetchRelayRequest,
  pollRelayComplete,
  postRelayHandshake,
  postRelayResponse,
  RelayClientTransport,
} from './relay-transport.js';
export type { FetchFn, RelayClientTransportOptions } from './relay-transport.js';
export * from './sas.js';
export * from './types.js';
export * from './uri.js';
