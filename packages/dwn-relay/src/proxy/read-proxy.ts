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

// TODO: Implementation
// - Detect cache miss: message exists in MessageStore, data missing from DataStore
// - Check if record is published (descriptor.published === true) and IPFS is configured
//   - If yes, try IpfsResolver.resolve(dataCid)
//   - Verify CID of fetched content matches descriptor.dataCid
// - If IPFS miss or not applicable, resolve tenant's DID document
//   - Find full peer endpoints (bare string or map without dataRetention: "cache")
//   - Forward RecordsRead with original authorization to peer
// - Optionally re-cache fetched data in local DataStore
// - Return data to requester

export class ReadProxy {
  // Placeholder
}
