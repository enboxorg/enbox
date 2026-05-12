/**
 * Enbox SDK — high-level API for Decentralized Web Nodes, DIDs, and VCs.
 *
 * The SDK provides protocol-scoped access to DWN records with compile-time
 * type safety, DID management, and Verifiable Credential operations.
 *
 * Common authentication and identity setup is available through
 * `Enbox.connect()`. Advanced session management can use `@enbox/auth` or
 * `@enbox/agent` directly.
 *
 * @example
 * ```ts
 * import { Enbox } from '@enbox/api';
 *
 * const { enbox } = await Enbox.connect({
 *   createIdentity: true,
 *   sync: '15s',
 * });
 * ```
 *
 * [Link to GitHub Repo](https://github.com/enboxorg/enbox)
 *
 * @packageDocumentation
 */

export * from './define-protocol.js';
export * from './did-api.js';
export * from './dwn-reader-api.js';
export * from './enbox.js';
export * from './grant-revocation.js';
export * from './live-query.js';
export * from './permission-grant.js';
export * from './permission-request.js';
export * from './protocol.js';
export * from './protocol-types.js';
export * from './read-only-record.js';
export * from './record.js';
export * from './record-data.js';
export * from './record-types.js';
export * from './repository.js';
export * from './repository-types.js';
export * from './typed-enbox.js';
export * from './typed-live-query.js';
export * from './typed-record.js';
export * from './vc-api.js';

import * as utils from './utils.js';
export { utils };
export { isOk } from './utils.js';
