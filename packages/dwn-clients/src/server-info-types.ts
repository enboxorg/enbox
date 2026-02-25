import type { KeyValueStore } from '@enbox/common';

/**
 * Configuration for provider-auth-v0 registration.
 * Present in {@link ServerInfo} when `'provider-auth-v0'` is listed in
 * {@link ServerInfo.registrationRequirements | registrationRequirements}.
 */
export type ProviderAuthInfo = {
  /** URL to redirect user for authentication/signup/payment. Can be on the DWN server or an external domain. */
  authorizeUrl : string;
  /** URL where the wallet exchanges an authorization code for a registration token. */
  tokenUrl : string;
  /** URL to refresh an expired registration token. If absent, tokens do not support refresh. */
  refreshUrl? : string;
  /** URL for user-facing account management dashboard. If absent, no management UI is available. */
  managementUrl? : string;
};

export type ServerInfo = {
  /** the maximum file size the user can request to store */
  maxFileSize: number,
  /**
   * Maximum number of unacknowledged subscription events the server will send
   * before pausing delivery. Clients ****MUST**** send `rpc.ack` to advance the
   * window. When absent, the server does not enforce backpressure.
   */
  maxInFlight?: number,
  /**
   * Provider-auth-v0 configuration. Present when `'provider-auth-v0'` is
   * included in {@link registrationRequirements}.
   */
  providerAuth?: ProviderAuthInfo,
  /**
   * an array of strings representing the server's registration requirements.
   *
   * ie. ['proof-of-work-sha256-v0', 'terms-of-service']
   */
  registrationRequirements: string[],
  /** the DWN server's package name */
  server: string,
  /** the DWN SDK version used by the server */
  sdkVersion: string,
  /** the base URL of the DWN server */
  url: string,
  /** the DWN server version */
  version: string,
  /** whether web socket support is enabled on this server */
  webSocketSupport: boolean,
};

export interface DwnServerInfoCache extends KeyValueStore<string, ServerInfo| undefined> {}

export interface DwnServerInfoRpc {
  /** retrieves the DWN Sever info, used to detect features such as WebSocket Subscriptions */
  getServerInfo(url: string): Promise<ServerInfo>;
}
