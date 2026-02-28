import type { PortableDid } from '@enbox/dids';

/**
 * Represents metadata about an Enbox Identity.
 */
export interface IdentityMetadata {
  name: string;
  tenant: string;
  uri: string;
  connectedDid?: string;
}

export interface PortableIdentity {
  portableDid: PortableDid;

  /** {@inheritDoc IdentityMetadata} */
  metadata: IdentityMetadata;
}