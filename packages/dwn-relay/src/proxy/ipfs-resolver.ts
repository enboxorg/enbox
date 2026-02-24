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

// TODO: Implementation
// - fetch(`${gatewayUrl}/ipfs/${dataCid}`) with timeout
// - Stream response, compute DAG-PB CID of received bytes
// - Compare computed CID to expected dataCid
// - Return verified data stream, or undefined on mismatch/timeout/error
// - Consider Helia as an alternative to HTTP gateway for direct IPFS participation

export class IpfsResolver {
  // Placeholder
}
