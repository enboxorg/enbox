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
 * });
 * ```
 *
 * [Link to GitHub Repo](https://github.com/enboxorg/enbox)
 *
 * @packageDocumentation
 */

export * from './connection-store.js';
export * from './define-protocol.js';
export * from './did-api.js';
export type {
  RecordsCountResponse,
  RecordsQueryResponse,
  RecordsReadResponse,
  RecordsWriteResponse,
} from './dwn-api.js';
export * from './dwn-reader-api.js';
export * from './enbox.js';
export type * from './enbox-types.js';
export * from './grant-revocation.js';
export * from './permission-grant.js';
export * from './permission-request.js';
export * from './protocol.js';
export * from './protocol-types.js';
export * from './read-only-record.js';
export type { RecordFilter, RecordQuery } from './record-query.js';
export type { RecordView, RecordViewListener, RecordViewSnapshot, RecordViewState } from './record-view.js';
export * from './record.js';
export * from './typed-enbox.js';
export * from './vc-api.js';

// Agent types surfaced on public API responses — re-exported so apps can name
// them without depending on `@enbox/agent` directly.
export type { AudienceKeyDeliveryOutcome } from '@enbox/agent';
export { AudienceDecryptError, type AudienceDecryptFailureCause } from '@enbox/agent';

export * as utils from './utils.js';
export { isOk } from './utils.js';
