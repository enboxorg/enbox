import type { KeyValueStore } from '@enbox/common';

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
