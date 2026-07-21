import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { DirectionCheckpoint } from './types/sync.js';

/**
 * Whether every progress-token field is non-empty. Tokens with empty fields
 * would fail MessagesSubscribe/MessagesQuery JSON schema validation
 * (`minLength: 1`) and indicate corruption rather than progress.
 */
export function isValidProgressToken(token: ProgressToken): boolean {
  return Boolean(token.streamId && token.epoch && token.position);
}

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
  }

  /**
   * Whether `token` is the immediate successor of the checkpoint: the very
   * next position in the same stream domain, or a stream's first position
   * onto an empty checkpoint. Verified at the point of use — a live
   * observation carries no proof about the span below it, so only the
   * gap-free next position may advance a checkpoint that replay does not
   * anchor.
   */
  public static isImmediateSuccessor(checkpoint: DirectionCheckpoint, token: ProgressToken): boolean {
    const current = checkpoint.contiguousAppliedToken;
    if (current === undefined) {
      return BigInt(token.position) === BigInt(1);
    }

    return token.streamId === current.streamId &&
      token.epoch === current.epoch &&
      BigInt(token.position) === BigInt(current.position) + BigInt(1);
  }

  /** Check whether a token matches a checkpoint's established stream and epoch. */
  public static validateTokenDomain(checkpoint: DirectionCheckpoint, token: ProgressToken): boolean {
    if (checkpoint.contiguousAppliedToken === undefined) { return true; }
    return token.streamId === checkpoint.contiguousAppliedToken.streamId &&
      token.epoch === checkpoint.contiguousAppliedToken.epoch;
  }
}
