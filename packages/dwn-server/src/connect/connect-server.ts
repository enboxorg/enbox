import type { Dialect } from '@enbox/dwn-sql-store';

import { CryptoUtils } from '@enbox/crypto';

import { SqlTtlCache } from './sql-ttl-cache.js';

/**
 * The Connect Request object.
 */
export type ConnectRequest = any; // TODO: define type in common repo for reuse (https://github.com/enboxorg/enbox/issues/138)

/**
 * The Connect Response object.
 */
export type ConnectResponse = any; // TODO: define type in common repo for reuse (https://github.com/enboxorg/enbox/issues/138)

/**
 * The result of the setConnectRequest() method.
 */
export type SetConnectRequestResult = {
  /**
   * The Request URI that the wallet should use to retrieve the request object.
   */
  request_uri: string;

  /**
   * The time in seconds that the Request URI is valid for.
   */
  expires_in: number;
};

/**
 * The Connect Server is responsible for handling the DWeb Connect flow.
 */
export class ConnectServer {
  public static readonly ttlInSeconds = 600;

  private baseUrl: string;
  private cache: SqlTtlCache;

  /**
   * Creates a new instance of the Connect Server.
   * @param params.baseUrl The the base URL of the connect server including the port.
   *                       This is given to the Identity Provider (wallet) to fetch the Connect Request object.
   * @param params.sqlDialect The SQL dialect to use for the TTL cache. Must point to a database
   *                          where server migrations have already been run.
   */
  public static async create({ baseUrl, sqlDialect }: {
    baseUrl: string;
    sqlDialect: Dialect;
  }): Promise<ConnectServer> {
    const connectServer = new ConnectServer({ baseUrl });

    // Initialize TTL cache.
    connectServer.cache = await SqlTtlCache.create(sqlDialect);

    return connectServer;
  }

  private constructor({ baseUrl }: {
    baseUrl: string;
  }) {
    this.baseUrl = baseUrl;
  }

  /**
   * Stores the given Connect Request object, which is also an OAuth 2 Pushed Authorization Request (PAR) object.
   * This is the initial call to the connect server to start the DWeb Connect flow.
   */
  public async setConnectRequest(request: ConnectRequest): Promise<SetConnectRequestResult> {
    // Generate a request URI
    const requestId = CryptoUtils.randomUuid();
    const request_uri = `${this.baseUrl}/connect/authorize/${requestId}.jwt`;

    // Store the Request Object.
    this.cache.insert(`request:${requestId}`, request, ConnectServer.ttlInSeconds);

    return {
      request_uri,
      expires_in: ConnectServer.ttlInSeconds,
    };
  }

  /**
   * Returns the Connect Request object. The request ID can only be used once.
   */
  public async getConnectRequest(requestId: string): Promise<ConnectRequest | undefined> {
    const request = await this.cache.get(`request:${requestId}`);

    // Delete the Request Object from cache once it has been retrieved.
    // IMPORTANT: only delete if the object exists, otherwise there could be a race condition
    // where the object does not exist in this call but becomes available immediately after,
    // we would end up deleting it before it is successfully retrieved.
    if (request !== undefined) {
      this.cache.delete(`request:${requestId}`);
    }

    return request;
  }

  /**
   * Sets the Connect Response object.
   */
  public async setConnectResponse(state: string, response: ConnectResponse): Promise<any> {
    this.cache.insert(`response:${state}`, response, ConnectServer.ttlInSeconds);
  }

  /**
   * Gets the Connect Response object. The `state` string can only be used once.
   */
  public async getConnectResponse(state: string): Promise<ConnectResponse | undefined> {
    const response = await this.cache.get(`response:${state}`);

    // Delete the Response object from the cache once it has been retrieved.
    // IMPORTANT: only delete if the object exists, otherwise there could be a race condition
    // where the object does not exist in this call but becomes available immediately after,
    // we would end up deleting it before it is successfully retrieved.
    if (response !== undefined) {
      this.cache.delete(`response:${state}`);
    }

    return response;
  }

  /**
   * Stops the TTL cache cleanup timer. Must be called during shutdown to
   * prevent leaked timers.
   */
  public close(): void {
    this.cache.close();
  }
}
