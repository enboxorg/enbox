/**
 * Enbox SDK — high-level API for Decentralized Web Nodes and DIDs.
 *
 * The SDK provides protocol-scoped access to DWN records with compile-time
 * type safety and DID management.
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
export * from './context-errors.js';
export type {
  ContextInvitationPreview,
} from './context-invitations.js';
export type { ContextView, ContextViewListener, ContextViewState } from './context-view.js';
export { defineProtocol } from './define-protocol.js';
export * from './did-api.js';
export { DwnResponseError, RecordParentNotFoundError, RecordSquashBackstopError } from './dwn-response-error.js';
export * from './dwn-reader-api.js';
export * from './enbox.js';
export type * from './enbox-types.js';
export * from './protocol.js';
export { ProtocolReadinessError } from './protocol-readiness.js';
export type { EnsureProtocolsReadyOptions, ProtocolReadinessApi } from './protocol-readiness.js';
export type {
  ContextRoleGroup,
  ContextRoleGroups,
  ContextRolePath,
  DataFormatAtPath,
  ProtocolPaths,
  ProtocolPathTypeNames,
  ProtocolRecordCodecs,
  ProtocolRolePaths,
  RuleSetPaths,
  SquashProtocolPaths,
  TagKeys,
  TagsAtPath,
  TypedProtocol,
  TypeNameAtPath,
} from './protocol-types.js';
export * from './read-only-record.js';
export {
  RecordValidationError,
  recordCodecs,
  type EncodedRecordData,
  type JsonRecordCodecOptions,
  type RecordCodec,
  type RecordCodecContext,
  type RecordCodecValue,
  type RecordValidationFailure,
  type RecordValidator,
} from './record-codec.js';
export type { RecordFilter, RecordQuery } from './record-query.js';
export { RecordConflictError } from './record-conflict-error.js';
export type { ExpandableRecordView, RecordView, RecordViewListener, RecordViewState } from './record-view.js';
export type { ReplicationCurrentness } from './replication-currentness.js';
export * from './record.js';
export * from './typed-enbox.js';
export {
  AudienceDecryptError,
  type AudienceDecryptFailureCause,
} from '@enbox/agent';
