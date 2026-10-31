/**
 * Enbox SDK — high-level API for Decentralized Web Nodes and DIDs.
 *
 * The SDK provides protocol-scoped access to DWN records with compile-time
 * type safety and DID management.
 *
 * Common authentication and identity setup is available through the
 * framework-agnostic connection store. Advanced session management can use
 * `@enbox/auth` or `@enbox/agent` directly.
 *
 * @example
 * ```ts
 * import { createConnectionStore } from '@enbox/api';
 *
 * const store = createConnectionStore({ application });
 * const snapshot = await store.connectVault({ createIdentity: true });
 * if (snapshot.phase !== 'connected') throw snapshot.error ?? new Error('Connection failed.');
 * ```
 *
 * [Link to GitHub Repo](https://github.com/enboxorg/enbox)
 *
 * @packageDocumentation
 */

export * from './application-manifest.js';
export { createApplication } from './store/application.js';
export type {
  ApplicationRuntime,
  CreateApplicationOptions,
} from './store/application.js';
export { defineStore } from './store/definition.js';
export type { DefineStoreOptions, StoreContext, StoreDefinition, StoreDefinitions, StoreInstance, StoreProtocols } from './store/definition.js';
export type { ProtocolStore, StoreCollection, StoreCollectionFamily, StoreCollectionOptions } from './store/protocol-store.js';
export type { StoreCommand, StoreCommandState } from './store/command.js';
export type { StoreCollectionState } from './store/observed-store.js';
export type { ObservationFactory, ObservedStore, ObservedStoreState } from './store/observed-store.js';
export { StoreNotConnectedError, StoreRetiredError } from './store/scope.js';
export * from './connection-store.js';
export * from './context-errors.js';
export { protocolContextKey } from './shared-context-protocol.js';
export type { ContextInvitationPreview } from './shared-context-protocol.js';
export type { ContextView, ContextViewState, SavedContextFollow } from './context-view.js';
export { defineProtocol } from './define-protocol.js';
export * from './did-api.js';
export { DwnResponseError, RecordParentNotFoundError, RecordSquashBackstopError } from './dwn-response-error.js';
export * from './dwn-reader-api.js';
export * from './enbox.js';
export type * from './enbox-types.js';
export type {
  FileEnvelopeCodec,
  FileEnvelopeCodecOptions,
  FileEnvelopeData,
} from './file-envelope-codec.js';
export * from './protocol.js';
export type { ObservableStore } from './observable-store.js';
export { ProtocolReadinessError } from './protocol-readiness.js';
export type { EnsureProtocolsReadyOptions, ProtocolReadinessApi } from './protocol-readiness.js';
export type {
  ContextRolePath,
  ContextRolesAtPath,
  ContextRootPath,
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
export type { ExpandableRecordView, RecordView, RecordViewState } from './record-view.js';
export * from './record.js';
export * from './service-config-protocol.js';
export * from './typed-enbox.js';
export {
  AudienceDecryptError,
  type AudienceDecryptFailureCause,
  type ReplicationCurrentness,
} from '@enbox/agent';
export type { DwnEndpointResolution } from '@enbox/dids';
export { Time } from '@enbox/dwn-sdk-js';
