import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { DirectionCheckpoint, ReplicationLinkState } from './types/sync.js';

import { SyncCheckpoint } from './sync-checkpoint.js';
import { SyncReplicationLinkStoreLevel } from './sync-replication-link-store-level.js';

/**
 * Backwards-compatible Level replication ledger.
 *
 * New sync-engine persistence uses the narrower domain operations inherited
 * from {@link SyncReplicationLinkStoreLevel}. `saveLink()` remains available
 * for existing consumers that intentionally replace a complete link snapshot.
 */
export class ReplicationLedger extends SyncReplicationLinkStoreLevel {
  /** Persist a complete link snapshot. */
  public async saveLink(link: ReplicationLinkState): Promise<void> {
    await this.replaceLink(link);
  }

  /**
   * Compare two tokens by position (BigInt numeric comparison).
   * Returns negative if a < b, zero if equal, positive if a > b.
   * Caller must verify streamId and epoch match before calling.
   */
  public static comparePosition(a: ProgressToken, b: ProgressToken): number {
    return SyncCheckpoint.comparePosition(a, b);
  }

  /**
   * Check whether a token belongs to the same domain (streamId + epoch) as
   * the checkpoint's current baseline. Returns `true` if domains match or if
   * the checkpoint has no baseline yet.
   */
  public static validateTokenDomain(checkpoint: DirectionCheckpoint, token: ProgressToken): boolean {
    return SyncCheckpoint.validateTokenDomain(checkpoint, token);
  }

  /**
   * Update `receivedToken` to the highest seen token (for observability).
   * Does not advance `contiguousAppliedToken`; delivery ordering owns that.
   */
  public static setReceivedToken(checkpoint: DirectionCheckpoint, token: ProgressToken): void {
    SyncCheckpoint.setReceivedToken(checkpoint, token);
  }

  /** Commit a token as the new contiguous applied baseline without regressing within one token domain. */
  public static commitContiguousToken(checkpoint: DirectionCheckpoint, token: ProgressToken): void {
    SyncCheckpoint.commitContiguousToken(checkpoint, token);
  }

  /** Reset a replication checkpoint and optionally establish a new baseline. */
  public static resetCheckpoint(checkpoint: DirectionCheckpoint, token?: ProgressToken): void {
    SyncCheckpoint.reset(checkpoint, token);
  }
}
