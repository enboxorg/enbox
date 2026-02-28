import type { BearerDid } from '@enbox/dids';
import type { IdentityMetadata, PortableIdentity } from './types/identity.js';

/**
 * Represents an Enbox Identity with its DID and metadata.
 */
export class BearerIdentity {
  /** {@inheritDoc BearerDid} */
  public did: BearerDid;

  /** {@inheritDoc DidMetadata} */
  public metadata: IdentityMetadata;

  constructor({ did, metadata }: {
    did: BearerDid;
    metadata: IdentityMetadata;
  }) {
    this.did = did;
    this.metadata = metadata;
  }

  /**
   * Converts a `BearerIdentity` object to a portable format containing the DID and metadata
   * associated with the Identity.
   *
   * @example
   * ```ts
   * // Assuming `identity` is an instance of BearerIdentity.
   * const portableIdentity = await identity.export();
   * // portableIdentity now contains the and metadata.
   * ```
   *
   * @returns A `PortableIdentity` containing the DID and metadata associated with the
   *          `BearerIdentity`.
   */
  public async export(): Promise<PortableIdentity> {
    return {
      portableDid : await this.did.export(),
      metadata    : { ...this.metadata },
    };
  }
}