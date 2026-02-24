/**
 * Connection pool for outbound RPC connections to peer DWN endpoints.
 *
 * Keyed by host (URL origin), not by tenant. This is critical for scaling:
 * 100K tenants across 500 distinct providers = ~500 connections, not 100K.
 *
 * Uses @enbox/dwn-clients Web5Rpc for the underlying transport (HTTP/WS).
 */

// TODO: Implementation
// - Map<hostOrigin, Web5Rpc> for connection reuse
// - Idle timeout: close connections unused for N minutes
// - Max connections per host
// - Health tracking: mark hosts as unreachable after consecutive failures
// - Automatic reconnection with backoff

export class ConnectionPool {
  // Placeholder
}
