import type { JsonRpcResponse } from './json-rpc.js';
import type { DwnRpc, DwnRpcRequest, DwnRpcResponse } from './dwn-rpc-types.js';
import type { DwnServerInfoCache, ServerInfo } from './server-info-types.js';

import { CryptoUtils } from '@enbox/crypto';
import { DataStream } from '@enbox/dwn-sdk-js';
import { DwnServerInfoCacheMemory } from './dwn-server-info-cache-memory.js';
import { createJsonRpcRequest, parseJson } from './json-rpc.js';

/**
 * HTTP client that can be used to communicate with Dwn Servers
 */
export class HttpDwnRpcClient implements DwnRpc {
  private serverInfoCache: DwnServerInfoCache;
  constructor(serverInfoCache?: DwnServerInfoCache) {
    this.serverInfoCache = serverInfoCache ?? new DwnServerInfoCacheMemory();
  }

  get transportProtocols(): string[] { return ['http:', 'https:']; }

  async sendDwnRequest(request: DwnRpcRequest): Promise<DwnRpcResponse> {
    const requestId = CryptoUtils.randomUuid();
    const jsonRpcRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      target  : request.targetDid,
      message : request.message
    });

    const requestHeaders: Record<string, string> = {
      'dwn-request': JSON.stringify(jsonRpcRequest)
    };

    const fetchOpts: RequestInit = {
      method  : 'POST',
      headers : requestHeaders,
    };

    if (request.data) {
      requestHeaders['content-type'] = 'application/octet-stream';
      fetchOpts.body = request.data;
    }

    const resp = await fetch(request.dwnUrl, fetchOpts);
    let dwnRpcResponse: JsonRpcResponse;

    // When the server streams record data back, the JSON-RPC envelope is in the
    // `dwn-response` header and the body is the raw data stream.  Otherwise the
    // entire JSON-RPC response is the body.
    const hasDataStream = resp.headers.has('dwn-response');

    if (hasDataStream) {
      const jsonRpcResponse = parseJson(resp.headers.get('dwn-response')!) as JsonRpcResponse;

      if (jsonRpcResponse == null) {
        throw new Error(`failed to parse json rpc response. dwn url: ${request.dwnUrl}`);
      }

      dwnRpcResponse = jsonRpcResponse;
    } else {
      const responseBody = await resp.text();
      dwnRpcResponse = JSON.parse(responseBody);
    }

    if (dwnRpcResponse.error) {
      const { code, message } = dwnRpcResponse.error;
      throw new Error(`(${code}) - ${message}`);
    }

    // Materialise the response body before attaching to the reply.
    // Bun (<=1.3.9) has a bug where resp.body.getReader() can intermittently
    // return undefined, crashing DataStream.toBytes() in its finally block.
    // Buffering via arrayBuffer() is a safe workaround.
    // TODO: https://github.com/enboxorg/enbox/issues/90 — remove once Bun ships fix
    const { reply } = dwnRpcResponse.result;
    if (hasDataStream) {
      const bodyBytes = new Uint8Array(await resp.arrayBuffer());
      const dataStream = DataStream.fromBytes(bodyBytes);
      if (reply.record) {
        reply.record.data = dataStream;
      } else if (reply.entry) {
        reply.entry.data = dataStream;
      }
    }

    return reply as DwnRpcResponse;
  }

  async getServerInfo(dwnUrl: string): Promise<ServerInfo> {
    const serverInfo = await this.serverInfoCache.get(dwnUrl);
    if (serverInfo) {
      return serverInfo;
    }

    const url = new URL(dwnUrl);

    // add `/info` to the dwn server url path
    url.pathname.endsWith('/') ? url.pathname += 'info' : url.pathname += '/info';

    try {
      const response = await fetch(url.toString());
      if (response.ok) {
        const results = await response.json() as ServerInfo;

        // explicitly return and cache only the desired properties.
        const serverInfo = {
          registrationRequirements : results.registrationRequirements,
          maxFileSize              : results.maxFileSize,
          webSocketSupport         : results.webSocketSupport,
        };
        this.serverInfoCache.set(dwnUrl, serverInfo);

        return serverInfo;
      } else {
        throw new Error(`HTTP (${response.status}) - ${response.statusText}`);
      }
    } catch (error: any) {
      throw new Error(`Error encountered while processing response from ${url.toString()}: ${error.message}`);
    }
  }
}
