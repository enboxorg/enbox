/**
 * Enforces process-local WebSocket connection limits with synchronous reservations.
 * A successful reservation holds capacity until its idempotent release handle is called.
 */
export class WebSocketConnectionLimiter {
  private readonly _connectionsByPeer: Map<string, number> = new Map();
  private _count = 0;

  public constructor(
    private readonly maxConnections: number,
    private readonly maxConnectionsPerPeer: number,
  ) {
    if (!Number.isSafeInteger(maxConnections) || maxConnections <= 0 ||
      !Number.isSafeInteger(maxConnectionsPerPeer) || maxConnectionsPerPeer <= 0) {
      throw new RangeError('WebSocketConnectionLimiter: limits must be positive safe integers.');
    }
  }

  /** Number of connection reservations currently held. */
  public get count(): number {
    return this._count;
  }

  /**
   * Atomically reserves total and per-peer connection capacity.
   */
  public reserve(peerIp: string):
    | { release: () => void; status: 'accepted' }
    | { reason: 'peer-limit' | 'total-limit'; status: 'rejected' } {
    if (this._count >= this.maxConnections) {
      return { reason: 'total-limit', status: 'rejected' };
    }

    const peerCount = this._connectionsByPeer.get(peerIp) ?? 0;
    if (peerCount >= this.maxConnectionsPerPeer) {
      return { reason: 'peer-limit', status: 'rejected' };
    }

    this._count++;
    this._connectionsByPeer.set(peerIp, peerCount + 1);

    let isReleased = false;
    return {
      status  : 'accepted',
      release : (): void => {
        if (isReleased) {
          return;
        }
        isReleased = true;

        this._count--;
        const remainingPeerCount = this._connectionsByPeer.get(peerIp)! - 1;
        if (remainingPeerCount === 0) {
          this._connectionsByPeer.delete(peerIp);
        } else {
          this._connectionsByPeer.set(peerIp, remainingPeerCount);
        }
      },
    };
  }
}
