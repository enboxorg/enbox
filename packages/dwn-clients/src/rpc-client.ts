import type { JsonRpcResponse } from './json-rpc.js';
import type { DwnRpc, DwnRpcRequest, DwnRpcResponse } from './dwn-rpc-types.js';
import type { DwnServerInfoRpc, ServerInfo } from './server-info-types.js';

import { createJsonRpcRequest } from './json-rpc.js';
import { CryptoUtils } from '@enbox/crypto';
import { HttpDwnRpcClient } from './http-dwn-rpc-client.js';
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

export interface EnboxRpc extends DwnRpc, DidRpc, DwnServerInfoRpc {}

/**
 * Client used to communicate with Dwn Servers
 */
export class EnboxRpcClient implements EnboxRpc {
  private transportClients: Map<string, EnboxRpc>;

  constructor(clients: EnboxRpc[] = []) {
    this.transportClients = new Map();

    // include http and socket clients as default.
    // can be overwritten for 'http:', 'https:', 'ws: or ':wss' if instantiated with other clients.
    clients = [new HttpEnboxRpcClient(), new WebSocketEnboxRpcClient(), ...clients];

    for (const client of clients) {
      for (const transportScheme of client.transportProtocols) {
        this.transportClients.set(transportScheme, client);
      }
    }
  }

  get transportProtocols(): string[] {
    return Array.from(this.transportClients.keys());
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

    const transportClient = this.transportClients.get(url.protocol);
    if (!transportClient) {
      const error = new Error(`no ${url.protocol} transport client available`);
      error.name = 'NO_TRANSPORT_CLIENT';

      throw error;
    }

    return transportClient.sendDwnRequest(request);
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
}

export class HttpEnboxRpcClient extends HttpDwnRpcClient implements EnboxRpc {
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
  async sendDidRequest(_request: DidRpcRequest): Promise<DidRpcResponse> {
    throw new Error(`not implemented for transports [${this.transportProtocols.join(', ')}]`);
  }

  async getServerInfo(_dwnUrl: string): Promise<ServerInfo> {
    throw new Error(`not implemented for transports [${this.transportProtocols.join(', ')}]`);
  }
}
