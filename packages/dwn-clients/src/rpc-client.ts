import type { JsonRpcResponse } from './json-rpc.js';
import type { ReplicationApplyResult } from '@enbox/dwn-sdk-js';
import type { DwnReplicationApplyRequest, DwnRpc, DwnRpcAuthOptions, DwnRpcRequest, DwnRpcResponse } from './dwn-rpc-types.js';
import type { DwnServerInfoRpc, ServerInfo } from './server-info-types.js';

import { createJsonRpcRequest } from './json-rpc.js';
import { CryptoUtils } from '@enbox/crypto';
import { HttpDwnRpcClient } from './http-dwn-rpc-client.js';
import { normalizeDwnRpcAuthEndpoint } from './rpc-auth.js';
import { WebSocketDwnRpcClient } from './web-socket-clients.js';

/**
 * Interface that can be implemented to communicate with {@link EnboxAgent | Enbox Agent}
 * implementations via JSON-RPC.
 */
export interface DidRpc {
  get transportProtocols(): string[]
  sendDidRequest(request: DidRpcRequest): Promise<DidRpcResponse>
}

export enum DidRpcMethod {
  Create = 'did.create',
  Resolve = 'did.resolve'
}

export type DidRpcRequest = {
  data: string;
  method: DidRpcMethod;
  url: string;
};

export type DidRpcResponse = {
  data?: string;
  ok: boolean;
  status: RpcStatus;
};

export type RpcStatus = {
  code: number;
  message: string;
};

export interface EnboxRpc extends DwnRpc, DidRpc, DwnServerInfoRpc {
  /** Removes a previously registered endpoint bearer token. */
  clearDwnEndpointBearerToken?(dwnUrl: string): void;

  /**
   * Registers a bearer token for one DWN endpoint. Implementations that do
   * not support dynamic transport authentication may omit this method.
   */
  setDwnEndpointBearerToken?(dwnUrl: string, token: string): void;

  /**
   * Releases any persistent transport resources (e.g. pooled WebSocket
   * connections and their heartbeat timers). Called during application
   * shutdown so the process's event loop can drain.
   */
  close(): Promise<void>;
}

export type EnboxRpcClientOptions = {
  auth?: DwnRpcAuthOptions;
};

/**
 * Client used to communicate with Dwn Servers
 */
export class EnboxRpcClient implements EnboxRpc {
  private readonly authenticatedTransportClients: Map<string, EnboxRpc>;
  private readonly endpointBearerTokens = new Map<string, string>();
  private readonly transportClients: Map<string, EnboxRpc>;

  constructor(clients: EnboxRpc[] = [], options: EnboxRpcClientOptions = {}) {
    this.authenticatedTransportClients = new Map();
    this.transportClients = new Map();

    const auth: DwnRpcAuthOptions = {
      getBearerToken: (dwnUrl: string): string | undefined => {
        return this.endpointBearerTokens.get(normalizeDwnRpcAuthEndpoint(dwnUrl))
          ?? options.auth?.getBearerToken?.(dwnUrl);
      },
    };

    // include http and socket clients as default.
    // can be overwritten for 'http:', 'https:', 'ws: or ':wss' if instantiated with other clients.
    const httpClient = new HttpEnboxRpcClient(undefined, undefined, auth);
    const defaultClients: EnboxRpc[] = [
      httpClient,
      new WebSocketEnboxRpcClient(httpClient, auth),
    ];

    for (const client of defaultClients) {
      for (const transportScheme of client.transportProtocols) {
        this.authenticatedTransportClients.set(transportScheme, client);
      }
    }

    clients = [
      ...defaultClients,
      ...clients,
    ];

    for (const client of clients) {
      for (const transportScheme of client.transportProtocols) {
        this.transportClients.set(transportScheme, client);
      }
    }
  }

  get transportProtocols(): string[] {
    return Array.from(this.transportClients.keys());
  }

  /** Removes a dynamically registered bearer token from one normalized endpoint. */
  public clearDwnEndpointBearerToken(dwnUrl: string): void {
    this.endpointBearerTokens.delete(normalizeDwnRpcAuthEndpoint(dwnUrl));
  }

  /** Registers or rotates a bearer token for one normalized DWN endpoint. */
  public setDwnEndpointBearerToken(dwnUrl: string, token: string): void {
    if (token.length === 0) {
      throw new Error('EnboxRpcClient: Endpoint bearer token must not be empty.');
    }

    this.endpointBearerTokens.set(normalizeDwnRpcAuthEndpoint(dwnUrl), token);
  }

  /** Closes every distinct transport client (the same client may serve multiple schemes). */
  async close(): Promise<void> {
    const closed = new Set<EnboxRpc>();
    const clients = [
      ...this.authenticatedTransportClients.values(),
      ...this.transportClients.values(),
    ];
    for (const client of clients) {
      if (closed.has(client)) {
        continue;
      }
      closed.add(client);
      await client.close();
    }
  }

  async sendDidRequest(request: DidRpcRequest): Promise<DidRpcResponse> {
    // URL() will throw if provided `url` is invalid.
    const url = new URL(request.url);

    const transportClient = this.transportClients.get(url.protocol);
    if (!transportClient) {
      const error = new Error(`no ${url.protocol} transport client available`);
      error.name = 'NO_TRANSPORT_CLIENT';

      throw error;
    }

    return transportClient.sendDidRequest(request);
  }

  sendDwnRequest(request: DwnRpcRequest): Promise<DwnRpcResponse> {
    // will throw if url is invalid
    const url = new URL(request.dwnUrl);

    const subscriptionRoute = this.resolveSubscriptionRoute(request, url);
    if (subscriptionRoute !== undefined) {
      return subscriptionRoute;
    }

    return this.sendDwnRequestOverScheme(request, url);
  }

  /** Dispatches a request to the transport that owns its URL scheme. */
  private sendDwnRequestOverScheme(request: DwnRpcRequest, url: URL): Promise<DwnRpcResponse> {
    const transportClient = this.getTransportClient(url, request.dwnUrl);
    if (!transportClient) {
      const error = new Error(`no ${url.protocol} transport client available`);
      error.name = 'NO_TRANSPORT_CLIENT';

      throw error;
    }

    return transportClient.sendDwnRequest(request);
  }

  /**
   * Routes subscriptions declared against an `http(s)` DWN endpoint through
   * the corresponding `ws(s)` transport. Ordinary requests remain on the
   * transport selected by their URL scheme: server info advertises WebSocket
   * subscription support, not parity for every `dwn.processMessage` shape.
   */
  private resolveSubscriptionRoute(request: DwnRpcRequest, url: URL): Promise<DwnRpcResponse> | undefined {
    if (request.subscription === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      return undefined;
    }

    const socketUrl = new URL(request.dwnUrl);
    socketUrl.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    const socketClient = this.getTransportClient(socketUrl, request.dwnUrl);
    if (socketClient === undefined) {
      return undefined;
    }

    return socketClient.sendDwnRequest({ ...request, dwnUrl: socketUrl.toString() });
  }

  applyReplicatedMessage(request: DwnReplicationApplyRequest): Promise<ReplicationApplyResult> {
    const url = new URL(request.dwnUrl);

    const transportClient = this.getTransportClient(url, request.dwnUrl);
    if (!transportClient) {
      const error = new Error(`no ${url.protocol} transport client available`);
      error.name = 'NO_TRANSPORT_CLIENT';

      throw error;
    }

    return transportClient.applyReplicatedMessage(request);
  }

  async getServerInfo(dwnUrl: string): Promise<ServerInfo> {
    // will throw if url is invalid
    const url = new URL(dwnUrl);

    const transportClient = this.transportClients.get(url.protocol);
    if (!transportClient) {
      const error = new Error(`no ${url.protocol} transport client available`);
      error.name = 'NO_TRANSPORT_CLIENT';

      throw error;
    }

    return transportClient.getServerInfo(dwnUrl);
  }

  /** Selects the authenticated built-in transport only for registered endpoints. */
  private getTransportClient(url: URL, dwnUrl: string): EnboxRpc | undefined {
    if (this.endpointBearerTokens.has(normalizeDwnRpcAuthEndpoint(dwnUrl))) {
      return this.authenticatedTransportClients.get(url.protocol);
    }

    return this.transportClients.get(url.protocol);
  }
}

export class HttpEnboxRpcClient extends HttpDwnRpcClient implements EnboxRpc {
  /** HTTP transport holds no persistent connections — nothing to release. */
  public async close(): Promise<void> {
    // no-op: HTTP transport holds no persistent connections to release.
  }

  async sendDidRequest(request: DidRpcRequest): Promise<DidRpcResponse> {
    const requestId = CryptoUtils.randomUuid();
    const jsonRpcRequest = createJsonRpcRequest(requestId, request.method, {
      data: request.data
    });

    const httpRequest = new Request(request.url, {
      method  : 'POST',
      headers : {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(jsonRpcRequest),
    });

    let jsonRpcResponse: JsonRpcResponse;

    try {
      const response = await fetch(httpRequest, { signal: AbortSignal.timeout(30_000) });

      if (response.ok) {
        jsonRpcResponse = await response.json();

        // If the response is an error, throw an error.
        if (jsonRpcResponse.error) {
          const { code, message } = jsonRpcResponse.error;
          throw new Error(`JSON RPC (${code}) - ${message}`);
        }
      } else {
        throw new Error(`HTTP (${response.status}) - ${response.statusText}`);
      }
    } catch (error: any) {
      throw new Error(`Error encountered while processing response from ${request.url}: ${error.message}`);
    }

    return jsonRpcResponse.result as DidRpcResponse;
  }
}

export class WebSocketEnboxRpcClient extends WebSocketDwnRpcClient implements EnboxRpc {
  /** Closes the process-wide WebSocket connection pool. */
  public async close(): Promise<void> {
    await WebSocketDwnRpcClient.closeAllConnections();
  }

  async sendDidRequest(_request: DidRpcRequest): Promise<DidRpcResponse> {
    throw new Error(`not implemented for transports [${this.transportProtocols.join(', ')}]`);
  }
}
