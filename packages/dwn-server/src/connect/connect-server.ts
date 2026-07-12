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

  private readonly baseUrl: string;
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

    // Store the Request Object. Awaited so the returned `request_uri` is a
    // durability barrier: the wallet may dereference the pointer the moment
    // the PAR response lands, and an in-flight insert would read as 404.
    await this.cache.insert(`request:${requestId}`, request, ConnectServer.ttlInSeconds);

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
      // Awaited so the single-use guarantee holds: an unawaited delete
      // leaves a window where a concurrent fetch reads the pointer twice.
      await this.cache.delete(`request:${requestId}`);

      // Record that the wallet has claimed this request so the requesting
      // app can show live progress ("phone connected") while it waits for
      // the approval. The marker is observational only — it is keyed by the
      // request ID the app already holds, reveals nothing about the request
      // (which is deleted above), and is read non-destructively.
      await this.cache.insert(`claimed:${requestId}`, { claimedAt: Date.now() }, ConnectServer.ttlInSeconds);
    }

    return request;
  }

  /**
   * Whether the Connect Request with the given ID has been claimed
   * (retrieved by a wallet). Non-consuming: apps poll this while waiting
   * for the wallet response.
   */
  public async isConnectRequestClaimed(requestId: string): Promise<boolean> {
    return (await this.cache.get(`claimed:${requestId}`)) !== undefined;
  }

  /**
   * Sets the Connect Response object.
   */
  public async setConnectResponse(state: string, response: ConnectResponse): Promise<any> {
    // Awaited so the callback's 201 means the app's next token poll can see
    // the response.
    await this.cache.insert(`response:${state}`, response, ConnectServer.ttlInSeconds);
  }

  /**
   * Records the requesting app's completion signal for `state`: it fetched
   * and successfully opened the wallet's response. Observational only — the
   * marker is keyed by the same opaque `state` correlator as the token
   * route, reveals nothing about the session (whose objects are already
   * consumed by this point), and is read non-destructively so the wallet can
   * flip its pairing screen to a confirmed "connected" state.
   */
  public async setConnectComplete(state: string): Promise<void> {
    await this.cache.insert(`complete:${state}`, { completedAt: Date.now() }, ConnectServer.ttlInSeconds);
  }

  /**
   * Whether the requesting app has signalled completion for `state`.
   * Non-consuming: wallets poll this after posting their response.
   */
  public async isConnectComplete(state: string): Promise<boolean> {
    return (await this.cache.get(`complete:${state}`)) !== undefined;
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
      await this.cache.delete(`response:${state}`);
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
