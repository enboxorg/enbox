import type { ObjectUrlLease } from './object-url-reference.js';

import { ObjectUrlReference } from './object-url-reference.js';

/** A reference-counted lease for a browser object URL. */
export type BlobUrlLease = ObjectUrlLease;

/** Owns object URLs for Blob identities until their last lease is released. */
export interface BlobUrlPool {
  acquire(blob: Blob): BlobUrlLease;
  dispose(): void;
}

class DefaultBlobUrlPool implements BlobUrlPool {
  private readonly _references = new Map<Blob, ObjectUrlReference>();
  private _isDisposed = false;

  public acquire(blob: Blob): BlobUrlLease {
    if (this._isDisposed) {
      throw new Error('BlobUrlPool is disposed.');
    }

    let reference = this._references.get(blob);
    if (reference === undefined) {
      reference = new ObjectUrlReference(blob, (released): void => {
        this._references.delete(blob);
        released.revoke();
      });
      this._references.set(blob, reference);
    }
    return reference.acquire();
  }

  public dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this._isDisposed = true;
    for (const reference of this._references.values()) {
      reference.revoke();
    }
    this._references.clear();
  }
}

/** Create a terminally disposable, reference-counted object URL pool. */
export function createBlobUrlPool(): BlobUrlPool {
  return new DefaultBlobUrlPool();
}
