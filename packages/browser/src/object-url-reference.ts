export type ObjectUrlLease = Readonly<{
  url: string;
  release(): void;
}>;

/** Private reference-counted ownership for one object URL. */
export class ObjectUrlReference {
  public readonly url: string;
  private _isRevoked = false;
  private _references = 0;

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
    return Object.freeze({
      url     : this.url,
      release : (): void => {
        if (released) {
          return;
        }
        released = true;
        this._references -= 1;
        if (this._references === 0) {
          this._onEmpty(this);
        }
      },
    });
  }

  public revoke(): void {
    if (!this._isRevoked) {
      this._isRevoked = true;
      globalThis.URL.revokeObjectURL(this.url);
    }
  }
}
