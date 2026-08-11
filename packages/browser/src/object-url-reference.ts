export type ObjectUrlLease = Readonly<{
  url: string;
  /** Release immediately, cancelling any deferred release. Idempotent. */
  release(): void;
  /** Release after a grace period. The first deferred release wins. */
  releaseAfter(delayMs: number): void;
}>;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function assertReleaseDelay(delayMs: number): void {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`delayMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}.`);
  }
}

/** Private reference-counted ownership for one object URL. */
export class ObjectUrlReference {
  public readonly url: string;
  private _isRevoked = false;
  private _references = 0;
  private readonly _releaseTimers = new Set<ReturnType<typeof setTimeout>>();

  public constructor(blob: Blob, private readonly _onEmpty: (reference: ObjectUrlReference) => void) {
    this.url = globalThis.URL.createObjectURL(blob);
  }

  public get references(): number {
    return this._references;
  }

  public acquire(): ObjectUrlLease {
    if (this._isRevoked) {
      throw new Error('Object URL has been revoked.');
    }

    this._references += 1;
    let released = false;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      if (releaseTimer !== undefined) {
        clearTimeout(releaseTimer);
        this._releaseTimers.delete(releaseTimer);
      }
      if (this._isRevoked) {
        return;
      }
      this._references -= 1;
      if (this._references === 0) {
        this._onEmpty(this);
      }
    };
    return Object.freeze({
      url          : this.url,
      release,
      releaseAfter : (delayMs: number): void => {
        assertReleaseDelay(delayMs);
        if (released || this._isRevoked || releaseTimer !== undefined) {
          return;
        }
        releaseTimer = setTimeout(release, delayMs);
        this._releaseTimers.add(releaseTimer);
      },
    });
  }

  public revoke(): void {
    if (!this._isRevoked) {
      this._isRevoked = true;
      for (const timer of this._releaseTimers) {
        clearTimeout(timer);
      }
      this._releaseTimers.clear();
      this._references = 0;
      globalThis.URL.revokeObjectURL(this.url);
    }
  }
}
