import type { PortableDid } from '@enbox/dids';

/**
 * Represents metadata about a Web5 Identity.
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