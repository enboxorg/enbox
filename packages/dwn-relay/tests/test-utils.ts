import type { DataStore, DataStoreGetResult, DataStorePutResult } from '@enbox/dwn-sdk-js';
import type { DidResolver, DidDocument } from '@enbox/dids';
import type { DwnRpc, DwnRpcRequest, DwnRpcResponse } from '@enbox/dwn-clients';
import { DataStream } from '@enbox/dwn-sdk-js';

/**
 * Creates a mock DataStore that stores data in memory.
 */
export function createMockDataStore(): DataStore & {
  storage: Map<string, { data: Uint8Array; dataSize: number }>;
} {
  const storage = new Map<string, { data: Uint8Array; dataSize: number }>();

  return {
    storage,
    async open() {},
    async close() {},
    async clear() { storage.clear(); },

    async put(tenant: string, recordId: string, dataCid: string, dataStream: ReadableStream<Uint8Array>): Promise<DataStorePutResult> {
      const bytes = await DataStream.toBytes(dataStream);
      const key = `${tenant}|${recordId}|${dataCid}`;
      storage.set(key, { data: bytes, dataSize: bytes.length });
      return { dataSize: bytes.length };
    },

    async get(tenant: string, recordId: string, dataCid: string): Promise<DataStoreGetResult | undefined> {
      const key = `${tenant}|${recordId}|${dataCid}`;
      const entry = storage.get(key);
      if (!entry) return undefined;
      return {
        dataSize   : entry.dataSize,
        dataStream : DataStream.fromBytes(entry.data),
      };
    },

    async delete(tenant: string, recordId: string, dataCid: string): Promise<void> {
      const key = `${tenant}|${recordId}|${dataCid}`;
      storage.delete(key);
    },
  };
}

/**
 * Creates a mock DID resolver that returns a configurable DID document.
 */
export function createMockDidResolver(documents: Record<string, DidDocument>): DidResolver {
  return {
    async resolve(didUri: string) {
      const doc = documents[didUri];
      if (doc) {
        return {
          didResolutionMetadata : {},
          didDocument           : doc,
          didDocumentMetadata   : {},
        };
      }
      return {
        didResolutionMetadata : { error: 'notFound' },
        didDocument           : null,
        didDocumentMetadata   : {},
      };
    },
  };
}

/**
 * Creates a DID document with DWN service endpoints.
 */
export function createDidDocument(did: string, endpoints: (string | Record<string, unknown>)[]): DidDocument {
  return {
    id      : did,
    service : [{
      id              : `${did}#dwn`,
      type            : 'DecentralizedWebNode',
      serviceEndpoint : endpoints,
    }],
  } as DidDocument;
}

/**
 * Creates a mock RPC client that records requests and returns configurable responses.
 */
export function createMockRpcClient(): DwnRpc & {
  requests: DwnRpcRequest[];
  nextResponses: DwnRpcResponse[];
  pushResponse(response: DwnRpcResponse): void;
} {
  const requests: DwnRpcRequest[] = [];
  const nextResponses: DwnRpcResponse[] = [];

  return {
    requests,
    nextResponses,

    pushResponse(response: DwnRpcResponse) {
      nextResponses.push(response);
    },

    get transportProtocols() {
      return ['http:', 'https:'];
    },

    async sendDwnRequest(request: DwnRpcRequest): Promise<DwnRpcResponse> {
      requests.push(request);
      const response = nextResponses.shift();
      if (response) return response;
      return { status: { code: 200, detail: 'OK' } };
    },
  };
}

/**
 * Create a ReadableStream from a Uint8Array.
 */
export function streamFromBytes(data: Uint8Array): ReadableStream<Uint8Array> {
  return DataStream.fromBytes(data);
}

/**
 * Read a ReadableStream into a Uint8Array.
 */
export async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return DataStream.toBytes(stream);
}

/**
 * Create random bytes.
 */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Default relay config for testing.
 */
export function getTestRelayConfig() {
  return {
    dataRetention           : '72h',
    storageMaxBytes         : 100_000,
    ipfsGatewayUrl          : undefined,
    syncWorkers             : 2,
    syncIntervalSeconds     : 30,
    protocolPolicies        : {} as Record<string, string>,
    evictionIntervalSeconds : 60,
    evictionHighWaterMark   : 0.9,
    evictionLowWaterMark    : 0.7,
    readProxyTimeoutMs      : 5_000,
    readProxyCacheLocally   : true,
    selfUrl                 : 'https://relay.example.com',
  };
}
