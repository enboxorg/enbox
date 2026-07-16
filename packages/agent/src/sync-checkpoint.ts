import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { DirectionCheckpoint } from './types/sync.js';

/** Backend-neutral operations for directional replication checkpoints. */
export class SyncCheckpoint {
  /** Compare token positions using integer arithmetic without precision loss. */
  public static comparePosition(a: ProgressToken, b: ProgressToken): number {
    const difference = BigInt(a.position) - BigInt(b.position);
    if (difference < BigInt(0)) { return -1; }
    if (difference > BigInt(0)) { return 1; }
    return 0;
  }

  /** Commit a contiguous token without regressing within one token domain. */
  public static commitContiguousToken(checkpoint: DirectionCheckpoint, token: ProgressToken): void {
    if (
      checkpoint.contiguousAppliedToken !== undefined &&
      token.streamId === checkpoint.contiguousAppliedToken.streamId &&
      token.epoch === checkpoint.contiguousAppliedToken.epoch &&
      SyncCheckpoint.comparePosition(token, checkpoint.contiguousAppliedToken) <= 0
    ) {
      return;
    }
    checkpoint.contiguousAppliedToken = token;
  }

  /** Reset a checkpoint and optionally establish a new baseline. */
  public static reset(checkpoint: DirectionCheckpoint, token?: ProgressToken): void {
    checkpoint.contiguousAppliedToken = token;
    checkpoint.receivedToken = token;
  }

  /** Retain the highest received token for observability. */
  public static setReceivedToken(checkpoint: DirectionCheckpoint, token: ProgressToken): void {
    if (
      checkpoint.receivedToken === undefined ||
      SyncCheckpoint.comparePosition(token, checkpoint.receivedToken) > 0
    ) {
      checkpoint.receivedToken = token;
    }
  }

  /** Check whether a token matches a checkpoint's established stream and epoch. */
  public static validateTokenDomain(checkpoint: DirectionCheckpoint, token: ProgressToken): boolean {
    if (checkpoint.contiguousAppliedToken === undefined) { return true; }
    return token.streamId === checkpoint.contiguousAppliedToken.streamId &&
      token.epoch === checkpoint.contiguousAppliedToken.epoch;
  }
}
