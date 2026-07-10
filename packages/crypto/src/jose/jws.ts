import type { Jwk } from './jwk.js';

/**
 * JSON Object Signing and Encryption (JOSE) Header Parameters
 *
 * The Header Parameter names for use in both JWSs and JWEs are registered in the IANA "JSON Web
 * Signature and Encryption Header Parameters" registry.
 *
 * As indicated by the common registry, JWSs and JWEs share a common Header Parameter space; when a
 * parameter is used by both specifications, its usage must be compatible between the
 * specifications.
 *
 * @see {@link https://datatracker.ietf.org/doc/html/rfc7515#section-4.1 | RFC 7515, Section 4.1}
 */
export interface JoseHeaderParams {
  /** Content Type Header Parameter */
  cty?: string;

  /** JWK Set URL Header Parameter */
  jku?: string;

  /** JSON Web Key Header Parameter */
  jwk?: Jwk;

  /** Key ID Header Parameter */
  kid?: string;

  /** Type Header Parameter */
  typ?: string;

  /** X.509 Certificate Chain Header Parameter */
  x5c?: string[];

  /** X.509 Certificate SHA-1 Thumbprint Header Parameter */
  x5t?: string;

  /** X.509 URL Header Parameter */
  x5u?: string;
}