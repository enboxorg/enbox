import type { DidResolver } from '@enbox/dids';
import type { IpfsResolver } from './ipfs-resolver.js';
import log from 'loglevel';
import type { RelayConfig } from '../config.js';
import { resolveEndpoints } from '../endpoint-resolver.js';
import { Cid, DataStream } from '@enbox/dwn-sdk-js';
import type { DataStore, DataStoreGetResult, GenericMessage } from '@enbox/dwn-sdk-js';
import type { DwnRpc, DwnRpcRequest } from '@enbox/dwn-clients';

/**
 * ReadProxy handles cache-miss reads by fetching record data from
 * alternative sources when the local DataStore does not have it.
 *
 * Resolution order:
 * 1. IPFS (for published records, if IPFS gateway is configured)
 * 2. Peer DWN endpoint (full nodes from the tenant's DID document)
 *
 * The proxy is transparent to the requester — they receive a normal
 * RecordsRead response regardless of where the data was sourced.
 *
 * Data authenticity is verified by recomputing the CID of fetched content
 * and comparing it to the dataCid in the signed message descriptor.
 */
export class ReadProxy {
  #dataStore: DataStore;
  #didResolver: DidResolver;
  #rpcClient: DwnRpc;
  #ipfsResolver?: IpfsResolver;
  #config: RelayConfig;

  constructor(options: {
    dataStore: DataStore;
    didResolver: DidResolver;
    rpcClient: DwnRpc;
    ipfsResolver?: IpfsResolver;
    config: RelayConfig;
  }) {
    this.#dataStore = options.dataStore;
    this.#didResolver = options.didResolver;
    this.#rpcClient = options.rpcClient;
    this.#ipfsResolver = options.ipfsResolver;
    this.#config = options.config;
  }

  /**
   * Attempt to resolve record data for a cache miss.
   *
   * @param tenant - The DID of the tenant.
   * @param recordId - The record ID.
   * @param dataCid - The data CID from the RecordsWrite descriptor.
   * @param dataSize - Expected data size from the descriptor.
   * @param published - Whether the record is published (enables IPFS resolution).
   * @param originalMessage - The original RecordsRead message (for peer proxy).
   * @returns The data stream and size, or undefined if no source is available.
   */
  async resolveData(options: {
    tenant: string;
    recordId: string;
    dataCid: string;
    dataSize: number;
    published?: boolean;
    originalMessage: GenericMessage;
  }): Promise<DataStoreGetResult | undefined> {
    const { tenant, recordId, dataCid, dataSize, published, originalMessage } = options;

    // Strategy 1: IPFS (published records only)
    if (published && this.#ipfsResolver) {
      const ipfsResult = await this.#ipfsResolver.resolve(dataCid);
      if (ipfsResult) {
        log.debug(`ReadProxy: resolved ${dataCid} via IPFS for tenant ${tenant}`);

        // Optionally re-cache locally
        if (this.#config.readProxyCacheLocally) {
          await this.#recache(tenant, recordId, dataCid, ipfsResult.dataStream, ipfsResult.dataSize);
          // Re-fetch from local store since we consumed the stream
          const localResult = await this.#dataStore.get(tenant, recordId, dataCid);
          if (localResult) {
            return localResult;
          }
        }

        return {
          dataSize   : ipfsResult.dataSize,
          dataStream : ipfsResult.dataStream,
        };
      }
    }

    // Strategy 2: Peer DWN proxy (prefer full endpoints)
    const peerResult = await this.#proxyToPeer(tenant, dataCid, dataSize, originalMessage);
    if (peerResult) {
      log.debug(`ReadProxy: resolved ${dataCid} via peer proxy for tenant ${tenant}`);

      if (this.#config.readProxyCacheLocally) {
        await this.#recache(tenant, recordId, dataCid, peerResult.dataStream, peerResult.dataSize);
        const localResult = await this.#dataStore.get(tenant, recordId, dataCid);
        if (localResult) {
          return localResult;
        }
      }

      return peerResult;
    }

    log.debug(`ReadProxy: no data source available for ${dataCid}, tenant ${tenant}`);
    return undefined;
  }

  /**
   * Proxy a RecordsRead to peer DWN endpoints, preferring full nodes.
   */
  async #proxyToPeer(
    tenant: string,
    dataCid: string,
    expectedDataSize: number,
    originalMessage: GenericMessage,
  ): Promise<DataStoreGetResult | undefined> {
    const endpoints = await resolveEndpoints(tenant, this.#didResolver);
    if (endpoints.length === 0) {
      return undefined;
    }

    // Sort: full endpoints first, then cache endpoints
    const sorted = [...endpoints]
      .filter(ep => ep.url !== this.#config.selfUrl)
      .sort((a, b) => {
        if (a.isFull && !b.isFull) {
          return -1;
        }
        if (!a.isFull && b.isFull) {
          return 1;
        }
        return 0;
      });

    for (const endpoint of sorted) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.#config.readProxyTimeoutMs);

        const request: DwnRpcRequest = {
          dwnUrl    : endpoint.url,
          targetDid : tenant,
          message   : originalMessage,
        };

        const response = await this.#rpcClient.sendDwnRequest(request);
        clearTimeout(timeoutId);

        // Check for successful response with data
        if (response.status?.code === 200 && response.entry?.data) {
          const data = response.entry.data as ReadableStream<Uint8Array>;

          // Read and verify CID
          const dataBytes = await DataStream.toBytes(data);
          const computedCid = await Cid.computeDagPbCidFromBytes(dataBytes);

          if (computedCid !== dataCid) {
            log.warn(`ReadProxy: CID mismatch from peer ${endpoint.url} for ${dataCid}`);
            continue;
          }

          return {
            dataSize   : dataBytes.length,
            dataStream : DataStream.fromBytes(dataBytes),
          };
        }
      } catch (err) {
        log.debug(`ReadProxy: peer ${endpoint.url} failed for ${dataCid}:`, err);
        continue;
      }
    }

    return undefined;
  }

  /**
   * Re-cache fetched data into the local DataStore.
   */
  async #recache(
    tenant: string,
    recordId: string,
    dataCid: string,
    dataStream: ReadableStream<Uint8Array>,
    dataSize: number,
  ): Promise<void> {
    try {
      // Clone the stream bytes to create a fresh ReadableStream for storage
      const dataBytes = await DataStream.toBytes(dataStream);
      const freshStream = DataStream.fromBytes(dataBytes);
      await this.#dataStore.put(tenant, recordId, dataCid, freshStream);
      log.debug(`ReadProxy: re-cached ${dataCid} for tenant ${tenant} (${dataSize} bytes)`);
    } catch (err) {
      log.warn(`ReadProxy: failed to re-cache ${dataCid}:`, err);
    }
  }
}
