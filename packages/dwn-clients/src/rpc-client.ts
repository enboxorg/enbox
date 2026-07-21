import type { JsonRpcResponse } from './json-rpc.js';
import type { DwnReplicationApplyRequest, DwnRpc, DwnRpcAuthOptions, DwnRpcRequest, DwnRpcResponse } from './dwn-rpc-types.js';
import type { DwnServerInfoRpc, ServerInfo } from './server-info-types.js';
import type { GenericMessage, ReplicationApplyResult } from '@enbox/dwn-sdk-js';

import { createJsonRpcRequest } from './json-rpc.js';
import { CryptoUtils } from '@enbox/crypto';
import { HttpDwnRpcClient } from './http-dwn-rpc-client.js';
import { normalizeDwnRpcAuthEndpoint } from './rpc-auth.js';
import { SocketUnavailableError } from './dwn-rpc-error.js';
import { WebSocketDwnRpcClient } from './web-socket-clients.js';
import { utf8ByteLength, WS_JSON_RPC_ENVELOPE_BYTES } from './ws-payload-size.js';

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
 * Conservative control-frame budget: the floor of every possible server
 * WebSocket cap. The server derives its `maxPayloadLength` as
 * `encoded(configured record-data cap) + WS_JSON_RPC_ENVELOPE_BYTES`, and the
 * client cannot observe the configured cap — assuming the default would let a
 * frame the server rejects close the pooled socket and disrupt its
 * subscriptions. A frame within the envelope allowance alone fits EVERY
 * configuration; control-plane messages are kilobytes, and anything larger
 * rides HTTP.
 */
const CONTROL_FRAME_BUDGET_BYTES = WS_JSON_RPC_ENVELOPE_BYTES;

/** Fixed-length stand-in for the UUID request id when measuring a frame. */
const FRAME_MEASUREMENT_ID = '00000000-0000-0000-0000-000000000000';

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

    const socketRoute = this.resolveSocketRoute(request, url);
    if (socketRoute !== undefined) {
      return socketRoute;
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
   * Prefer the WebSocket transport for an `http(s)` endpoint when it can
   * serve the request with full reply parity:
   *
   * - a subscription requires the socket transport, so it always routes to
   *   whichever client owns the converted `ws(s)` scheme — including a
   *   caller-supplied transport override;
   * - ordinary-request preference engages only for the built-in transport:
   *   the request must carry no raw data payload and no HTTP-only caller
   *   semantics (`signal`, `timeoutMs`), its wire message must pass the
   *   transport's capability boundary ({@link WebSocketDwnRpcClient.canSendDwnMessage}),
   *   an ALREADY-HEALTHY pooled socket must exist, and the complete frame
   *   must fit the socket budget — anything else falls through to ordinary
   *   scheme routing;
   * - a socket rejection that provably never transmitted the request
   *   ({@link SocketUnavailableError}) retries once over HTTP, preserving
   *   the pre-routing failure profile; every other rejection propagates.
   */
  private resolveSocketRoute(request: DwnRpcRequest, url: URL): Promise<DwnRpcResponse> | undefined {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }

    const socketUrl = new URL(request.dwnUrl);
    socketUrl.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    const socketClient = this.getTransportClient(socketUrl, request.dwnUrl);
    if (socketClient === undefined) {
      return undefined;
    }

    if (request.subscription !== undefined) {
      return socketClient.sendDwnRequest({ ...request, dwnUrl: socketUrl.toString() });
    }

    if (!(socketClient instanceof WebSocketEnboxRpcClient)) {
      return undefined;
    }
    if (request.data !== undefined || request.signal !== undefined || request.timeoutMs !== undefined) {
      return undefined;
    }

    // Classify, measure, and transmit ONE wire representation — a
    // serializable message instance is normalized before its descriptor is
    // consulted, so instance shapes cannot bypass the capability boundary.
    const wireMessage = EnboxRpcClient.toWireDwnMessage(request.message);
    if (!WebSocketDwnRpcClient.canSendDwnMessage(wireMessage)) {
      return undefined;
    }
    if (!socketClient.hasHealthyConnection(socketUrl.toString())) {
      return undefined;
    }

    const frame = createJsonRpcRequest(FRAME_MEASUREMENT_ID, 'dwn.processMessage', {
      target  : request.targetDid,
      message : wireMessage,
    });
    if (utf8ByteLength(JSON.stringify(frame)) > CONTROL_FRAME_BUDGET_BYTES) {
      return undefined;
    }

    const socketRequest: DwnRpcRequest = { ...request, dwnUrl: socketUrl.toString(), message: wireMessage };
    return socketClient.sendDwnRequest(socketRequest).catch((error: unknown) => {
      // The health check is a snapshot: a socket dying between the check and
      // the send surfaces as SocketUnavailableError, which guarantees the
      // request never left — retrying it over HTTP is safe.
      if (error instanceof SocketUnavailableError) {
        return this.sendDwnRequestOverScheme(request, url);
      }
      throw error;
    });
  }

  /**
   * Normalizes a possibly-serializable DWN message instance (an SDK message
   * object exposing `toJSON()`) into the wire representation used for
   * classification, frame measurement, and transmission.
   */
  private static toWireDwnMessage(message: DwnRpcRequest['message']): Partial<GenericMessage> {
    const candidate = message as { toJSON?: () => unknown };
    if (typeof candidate.toJSON === 'function') {
      return candidate.toJSON() as Partial<GenericMessage>;
    }
    return message as Partial<GenericMessage>;
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
