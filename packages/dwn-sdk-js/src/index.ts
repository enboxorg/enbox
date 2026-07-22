// export everything that we want to be consumable
export type { DwnConfig } from './dwn.js';
export type { EventLog, EventLogEntry, EventLogReadOptions, EventLogReadResult, EventLogSubscribeOptions, EventSubscription, MessageEvent, ProgressGapInfo, ProgressGapReason, ProgressToken, ReplicationFeedReader, SubscriptionEose, SubscriptionError, SubscriptionEvent, SubscriptionListener, SubscriptionMessage, SubscriptionReply, Wake, WakePublisher, WakeSubscriber } from './types/subscriptions.js';
export type { AuthorizationModel, Descriptor, DelegatedGrantRecordsWriteMessage, GenericMessage, GenericMessageReply, GenericSignaturePayload, MessageSort, MessageSubscription, Pagination, QueryResultEntry, Status } from './types/message-types.js';
export type { DependencyRef, ReplicationApplyOptions, ReplicationApplyResult, ReplicationApplyResultContext } from './core/replication-apply.js';
export { replicationApplyResultFromReply } from './core/replication-apply.js';
export type { ValidationStateReader } from './types/validation-state-reader.js';
export { StoreValidationStateReader } from './core/validation-state-reader.js';
export type { RecordedValidationRead } from './core/recording-validation-state-reader.js';
export { RecordingValidationStateReader } from './core/recording-validation-state-reader.js';
export type { MessagesFilter, MessagesQueryDescriptor, MessagesQueryMessage, MessagesQueryReply, MessagesQueryReplyEntry, MessagesReadMessage, MessagesReadReply, MessagesReadReplyEntry, MessagesReadDescriptor, MessagesSubscribeDescriptor, MessagesSubscribeMessage, MessagesSubscribeReply, MessagesSubscribeMessageOptions } from './types/messages-types.js';
export type { GT, LT, Filter, FilterValue, KeyValues, EqualFilter, OneOfFilter, RangeFilter, RangeCriterion, PaginationCursor, QueryOptions, RangeValue, StartsWithFilter, SubtreeFilter } from './types/query-types.js';
export type { ProtocolsConfigureDescriptor, ProtocolDefinition, ProtocolTypes, ProtocolRuleSet, ProtocolsQueryFilter, ProtocolsConfigureMessage, ProtocolsQueryMessage, ProtocolsQueryReply, ProtocolActionRule, ProtocolDeliveryStrategy, ProtocolKeyAgreement, ProtocolsQueryDescriptor, ProtocolRecordLimitDefinition, ProtocolSizeDefinition, ProtocolTagsDefinition, ProtocolTagSchema, ProtocolType, ProtocolUses } from './types/protocols-types.js';
export { ProtocolRecordLimitStrategy } from './types/protocols-types.js';
export type { DataEncodedRecordsWriteMessage, RecordsCountDescriptor, RecordsCountMessage, RecordsCountReply, RecordsDeleteMessage, RecordsFilter, RecordsQueryMessage, RecordsQueryReply, RecordsQueryReplyEntry, RecordsReadMessage, RecordsReadReply, RecordsSubscribeDescriptor, RecordsSubscribeMessage, RecordsSubscribeReply, RecordsWriteDescriptor, RecordsWriteTags, RecordsWriteTagValue, RecordsWriteMessage, RecordsWriteSignaturePayload, RecordsDeleteDescriptor, RecordsQueryDescriptor, RecordsReadDescriptor, RecordsSubscribeMessageOptions, RecordsWriteMessageOptions, InternalRecordsWriteMessage, RecordEvent, RecordsWriteTagsFilter } from './types/records-types.js';
export type { GeneralJws, SignatureEntry } from './types/jws-types.js';
export { authenticate } from './core/auth.js';
export { CoreProtocolRegistry } from './core/core-protocol.js';
export { EncryptionControl } from './core/encryption-control.js';
export {
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_AUDIENCE_SCHEMA_URI,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  ENCRYPTION_CONTROL_DELIVERY_SCHEMA_URI,
  ENCRYPTION_CONTROL_PATHS,
  ENCRYPTION_CONTROL_ROOT_PATH,
  ENCRYPTION_PROTOCOL_URI,
  ENCRYPTION_PROTOCOL_GRANT_KEY_PATH,
  ENCRYPTION_PROTOCOL_WRAPPED_GRANT_KEY_PATH,
  PERMISSIONS_REVOCATION_PATH,
  isEncryptionControlPath,
} from './core/constants.js';
export type { EncryptionControlPath } from './core/constants.js';
export type { CoreProtocol, CoreProtocolStores } from './core/core-protocol.js';
export { AllowAllTenantGate } from './core/tenant-gate.js';
export type { ActiveTenantCheckResult, TenantGate } from './core/tenant-gate.js';
export { Cid } from './utils/cid.js';
export { RecordsCount } from './interfaces/records-count.js';
export type { RecordsCountOptions } from './interfaces/records-count.js';
export { RecordsQuery } from './interfaces/records-query.js';
export type { RecordsQueryOptions } from './interfaces/records-query.js';
export type { DataStore, DataStorePutResult, DataStoreGetResult } from './types/data-store.js';
export type { ResumableTaskStore, ManagedResumableTask } from './types/resumable-task-store.js';
export { DataStream } from './utils/data-stream.js';
export { getGrantKeyDeliveryScopes, grantKeyScopeCoversDeliveredScope, isGrantKeyEligibleRecordsScope, isGrantKeyRecordsScope } from './utils/grant-key-coverage.js';
export type { GrantKeyEligibleRecordsScope, GrantKeyProtocolPathScope, GrantKeyReadRecordsScope, GrantKeyRecordsScope, GrantKeyWriteRecordsScope } from './utils/grant-key-coverage.js';
export { HdKey, KeyDerivationScheme } from './utils/hd-key.js';
export type { DerivedPrivateJwk } from './utils/hd-key.js';
export { Dwn } from './dwn.js';
export type { MessageOptions } from './dwn.js';
export { DwnConstant } from './core/dwn-constant.js';
export { DwnError, DwnErrorCode } from './core/dwn-error.js';
export type { DwnErrorInfo } from './core/dwn-error.js';
export { DwnInterfaceName, DwnMethodName } from './enums/dwn-interface-method.js';
export { Encoder } from './utils/encoder.js';
export { assertValidSubtreeFilters, isSubtreeFilter } from './utils/filter.js';
export { MessagesSubscribe } from './interfaces/messages-subscribe.js';
export type { MessagesSubscribeOptions } from './interfaces/messages-subscribe.js';
export { Encryption, ContentEncryptionAlgorithm, KeyAgreementAlgorithm, ROLE_AUDIENCE_DERIVATION_SCHEME, SEAL_DERIVATION_SCHEME } from './utils/encryption.js';
export type {
  DwnEncryption,
  KeyUnwrapPayload,
  ProtocolPathKeyEncryption,
  ProtocolPathKeyEncryptionInput,
  SealKeyWrap,
  SealKeyWrapInput,
  SealUnwrapInput,
  SealWrapInput,
  SourceRoleAudienceKeyEncryption,
  SourceRoleAudienceKeyEncryptionInput,
  X25519KeyEncryption,
  X25519KeyEncryptionInput,
  X25519KeyWrapInput,
} from './utils/encryption.js';
export { RecordsWrite } from './interfaces/records-write.js';
export type { EncryptionInput, RecordsWriteOptions, CreateFromOptions } from './interfaces/records-write.js';
export { executeUnlessAborted } from './utils/abort.js';
export { Jws } from './utils/jws.js';
export type { KeyMaterial, PrivateKeyJwk, PublicKeyJwk, Jwk } from './types/jose-types.js';
export { Message } from './core/message.js';
export { MessagesRead } from './interfaces/messages-read.js';
export type { MessagesReadOptions } from './interfaces/messages-read.js';
export { MessagesQuery } from './interfaces/messages-query.js';
export type { MessagesQueryOptions } from './interfaces/messages-query.js';
export type { UnionMessageReply } from './core/message-reply.js';
export type { MessageStore, MessageStoreLatestStateTransition, MessageStoreOptions, MessageStorePutResult } from './types/message-store.js';
export { Replication } from './utils/replication.js';
export type { MessageInterface } from './types/message-interface.js';
export { PermissionGrant } from './protocols/permission-grant.js';
export { PermissionRequest } from './protocols/permission-request.js';
export { PermissionsProtocol } from './protocols/permissions.js';
export { EncryptionProtocol, WRAPPED_GRANT_KEY_FORMAT, assertWrappedGrantKeyEnvelope } from './protocols/encryption.js';
export type { WrappedGrantKeyEnvelope } from './protocols/encryption.js';
export type { PermissionGrantCreateOptions, PermissionRequestCreateOptions, PermissionRevocationCreateOptions } from './protocols/permissions.js';
export { PermissionScopeMatcher } from './utils/permission-scope.js';
export type { ProtocolScope } from './utils/permission-scope.js';
export { PrivateKeySigner } from './utils/private-key-signer.js';
export type { PrivateKeySignerOptions } from './utils/private-key-signer.js';
export {
  Protocols,
  getRoleAudienceContextId,
  getRoleContextPrefix,
  getRuleSetAtPath,
  getTypeName,
  isCrossProtocolRef,
  parseCrossProtocolRef,
} from './utils/protocols.js';
export type { CrossProtocolRef } from './utils/protocols.js';
export { ProtocolsConfigure } from './interfaces/protocols-configure.js';
export type { ProtocolsConfigureOptions } from './interfaces/protocols-configure.js';
export { ProtocolsQuery } from './interfaces/protocols-query.js';
export type { ProtocolsQueryOptions } from './interfaces/protocols-query.js';
export { Records } from './utils/records.js';
export { RecordsDelete } from './interfaces/records-delete.js';
export type { RecordsDeleteOptions } from './interfaces/records-delete.js';
export { RecordsRead } from './interfaces/records-read.js';
export type { RecordsReadOptions } from './interfaces/records-read.js';
export { RecordsSubscribe } from './interfaces/records-subscribe.js';
export type { RecordsSubscribeOptions } from './interfaces/records-subscribe.js';
export { Secp256k1 } from './utils/secp256k1.js';
export { Secp256r1 } from './utils/secp256r1.js';
export type { SupportedCurve } from './jose/algorithms/signing/signature-algorithms.js';
export type { MessageSigner } from './types/signer.js';
export { SortDirection } from './types/query-types.js';
export type {
  EncryptionControlAudiencePayload,
  EncryptionControlDeliveryPayload,
  EncryptionControlDeliveryTags,
  EncryptionControlSeal,
  EncryptionKeyDeriver,
  KeyDecrypter,
  KeyDecrypterDerivationScheme,
  RoleAudienceKeyId,
  RoleAudienceKeyMaterial,
  RoleAudienceTuple,
} from './types/encryption-types.js';
export { EncryptionControlDeliveryRecipientAuthority } from './types/encryption-types.js';
export { Time } from './utils/time.js';
export * from './types/permission-types.js';
export * from './types/records-types.js';

// concrete event log implementations
export { BroadcastChannelWakePublisher } from './event-stream/broadcast-channel-wake-publisher.js';
export { EventEmitterWakePublisher } from './event-stream/event-emitter-wake-publisher.js';
export { DurableEventLog } from './event-stream/durable-event-log.js';
export type { DurableEventLogConfig, DurableEventLogStore } from './event-stream/durable-event-log.js';

// test library exports
export type { GenerateFromRecordsWriteInput, GenerateFromRecordsWriteOut, GenerateGrantCreateInput, GenerateGrantCreateOutput, GenerateMessagesQueryInput, GenerateMessagesQueryOutput, GenerateMessagesReadInput, GenerateMessagesReadOutput, GenerateMessagesSubscribeInput, GenerateMessagesSubscribeOutput, GenerateProtocolsConfigureInput, GenerateProtocolsConfigureOutput, GenerateProtocolsQueryInput, GenerateProtocolsQueryOutput, GenerateRecordsCountInput, GenerateRecordsCountOutput, GenerateRecordsDeleteInput, GenerateRecordsDeleteOutput, GenerateRecordsQueryInput, GenerateRecordsQueryOutput, GenerateRecordsSubscribeInput, GenerateRecordsSubscribeOutput, GenerateRecordsWriteInput, GenerateRecordsWriteOutput, Persona } from '../tests/utils/test-data-generator.js';
export { TestDataGenerator } from '../tests/utils/test-data-generator.js';
export { Poller } from '../tests/utils/poller.js';
