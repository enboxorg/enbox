import { Cid, DataStream } from '@enbox/dwn-sdk-js';
import log from 'loglevel';

/**
 * IpfsResolver fetches record data from an IPFS HTTP gateway by dataCid.
 *
 * Since DWN record data uses IPFS-compatible CIDs (DAG-PB/UnixFS), any IPFS
 * peer or gateway that has the content can serve it. The resolver verifies
 * authenticity by recomputing the CID from the fetched bytes.
 *
 * This is only useful for published (unencrypted) records. Encrypted data
 * can technically be fetched from IPFS but provides no CDN benefit since
 * only authorized recipients can decrypt it.
 */
export class IpfsResolver {
  #gatewayUrl: string;
  #timeoutMs: number;

  /**
   * @param gatewayUrl - IPFS HTTP gateway base URL (e.g., "http://localhost:8080").
   * @param timeoutMs - Request timeout in milliseconds.
   */
  constructor(gatewayUrl: string, timeoutMs = 15_000) {
    // Normalize: remove trailing slash
    this.#gatewayUrl = gatewayUrl.replace(/\/+$/, '');
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Attempt to resolve record data by its CID from the IPFS gateway.
   *
   * @param dataCid - The DAG-PB/UnixFS CID of the record data.
   * @returns The verified data stream and its size, or undefined if resolution
   *          failed (timeout, CID mismatch, gateway error).
   */
  async resolve(dataCid: string): Promise<{ dataStream: ReadableStream<Uint8Array>; dataSize: number } | undefined> {
    const url = `${this.#gatewayUrl}/ipfs/${dataCid}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.#timeoutMs);

      const response = await fetch(url, {
        signal  : controller.signal,
        headers : { Accept: 'application/octet-stream' },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        log.debug(`IPFS gateway returned ${response.status} for CID ${dataCid}`);
        return undefined;
      }

      // Read the full response to verify the CID
      const dataBytes = new Uint8Array(await response.arrayBuffer());

      // Verify the CID matches by recomputing from the fetched bytes
      const computedCid = await Cid.computeDagPbCidFromBytes(dataBytes);
      if (computedCid !== dataCid) {
        log.warn(`IPFS CID mismatch for ${dataCid}: computed ${computedCid}`);
        return undefined;
      }

      return {
        dataStream : DataStream.fromBytes(dataBytes),
        dataSize   : dataBytes.length,
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        log.debug(`IPFS gateway timeout for CID ${dataCid}`);
      } else {
        log.debug(`IPFS gateway error for CID ${dataCid}:`, err);
      }
      return undefined;
    }
  }
}
