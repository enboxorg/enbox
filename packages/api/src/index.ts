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

export * from './application-manifest.js';
export * from './connection-store.js';
export { defineProtocol } from './define-protocol.js';
export * from './did-api.js';
export { DwnResponseError } from './dwn-response-error.js';
export * from './dwn-reader-api.js';
export * from './enbox.js';
export type * from './enbox-types.js';
export * from './grant-revocation.js';
export * from './permission-grant.js';
export * from './permission-request.js';
export * from './protocol.js';
export type {
  DataFormatAtPath,
  ProtocolPaths,
  ProtocolPathTypeNames,
  ProtocolRecordCodecs,
  ProtocolRolePaths,
  RuleSetPaths,
  TagKeys,
  TagsAtPath,
  TypedProtocol,
  TypeNameAtPath,
} from './protocol-types.js';
export * from './read-only-record.js';
export { recordCodecs, type EncodedRecordData, type RecordCodec, type RecordCodecValue } from './record-codec.js';
export type { RecordFilter, RecordQuery } from './record-query.js';
export type { RecordView, RecordViewListener, RecordViewSnapshot, RecordViewState } from './record-view.js';
export * from './record.js';
export * from './typed-enbox.js';
export * from './vc-api.js';

export { AudienceDecryptError, type AudienceDecryptFailureCause } from '@enbox/agent';
