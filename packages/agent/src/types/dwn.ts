import type { DidService } from '@enbox/dids';
import type { RequireOnly } from '@enbox/common';

import type {
  GenericMessageReply,
  MessagesQueryMessage,
  MessagesQueryOptions,
  MessagesQueryReply,
  MessagesReadMessage,
  MessagesReadOptions,
  MessagesReadReply,
  MessagesSubscribeMessage,
  MessagesSubscribeOptions,
  MessagesSubscribeReply,
  ProtocolsConfigureMessage,
  ProtocolsConfigureOptions,
  ProtocolsQueryMessage,
  ProtocolsQueryOptions,
  ProtocolsQueryReply,
  RecordsCountMessage,
  RecordsCountOptions,
  RecordsCountReply,
  RecordsDeleteMessage,
  RecordsDeleteOptions,
  RecordsQueryMessage,
  RecordsQueryOptions,
  RecordsQueryReply,
  RecordsReadMessage,
  RecordsReadOptions,
  RecordsReadReply,
  RecordsSubscribeMessage,
  RecordsSubscribeOptions,
  RecordsSubscribeReply,
  RecordsWriteMessage,
  RecordsWriteOptions,
  SubscriptionListener,
} from '@enbox/dwn-sdk-js';

import {
  DwnInterfaceName,
  DwnMethodName,
  MessagesQuery,
  MessagesRead,
  MessagesSubscribe,
  ProtocolsConfigure,
  ProtocolsQuery,
  RecordsCount,
  RecordsDelete,
  RecordsQuery,
  RecordsRead,
  RecordsSubscribe,
  RecordsWrite,
} from '@enbox/dwn-sdk-js';

/**
 * Represents a Decentralized Web Node (DWN) service in a DID Document.
 *
 * A DWN DID service is a specialized type of DID service with the `type` set to
 * `DecentralizedWebNode`. Encryption and signing keys are resolved from the DID document's
 * verification methods, not from the service entry.
 *
 * The `enc` and `sig` properties are optional legacy fields that may be present on existing
 * DID documents for backward compatibility. New implementations should resolve keys from the
 * DID document's verification methods by purpose (`keyAgreement` for encryption,
 * `authentication`/`assertionMethod` for signing).
 *
 * @example
 * ```ts
 * const service: DwnDidService = {
 *   id: 'did:example:123#dwn',
 *   type: 'DecentralizedWebNode',
 *   serviceEndpoint: 'https://enbox-dwn.fly.dev'
 * }
 * ```
 *
 * @see {@link https://github.com/enboxorg/dwn-spec | Enbox DWN Specification}
 */
export interface DwnDidService extends DidService {}

export enum DwnInterface {
  MessagesQuery = DwnInterfaceName.Messages + DwnMethodName.Query,
  MessagesRead = DwnInterfaceName.Messages + DwnMethodName.Read,
  MessagesSubscribe = DwnInterfaceName.Messages + DwnMethodName.Subscribe,
  ProtocolsConfigure = DwnInterfaceName.Protocols + DwnMethodName.Configure,
  ProtocolsQuery = DwnInterfaceName.Protocols + DwnMethodName.Query,
  RecordsCount = DwnInterfaceName.Records + DwnMethodName.Count,
  RecordsDelete = DwnInterfaceName.Records + DwnMethodName.Delete,
  RecordsQuery = DwnInterfaceName.Records + DwnMethodName.Query,
  RecordsRead = DwnInterfaceName.Records + DwnMethodName.Read,
  RecordsSubscribe = DwnInterfaceName.Records + DwnMethodName.Subscribe,
  RecordsWrite = DwnInterfaceName.Records + DwnMethodName.Write
}

export type DwnRecordsInterfaces =
  | DwnInterface.RecordsCount | DwnInterface.RecordsDelete | DwnInterface.RecordsQuery | DwnInterface.RecordsRead
  | DwnInterface.RecordsSubscribe | DwnInterface.RecordsWrite;

export interface DwnMessage {
  [DwnInterface.MessagesQuery] : MessagesQueryMessage;
  [DwnInterface.MessagesRead] : MessagesReadMessage;
  [DwnInterface.MessagesSubscribe] : MessagesSubscribeMessage;
  [DwnInterface.ProtocolsConfigure] : ProtocolsConfigureMessage;
  [DwnInterface.ProtocolsQuery] : ProtocolsQueryMessage;
  [DwnInterface.RecordsCount] : RecordsCountMessage;
  [DwnInterface.RecordsDelete] : RecordsDeleteMessage;
  [DwnInterface.RecordsQuery] : RecordsQueryMessage;
  [DwnInterface.RecordsRead] : RecordsReadMessage;
  [DwnInterface.RecordsSubscribe] : RecordsSubscribeMessage;
  [DwnInterface.RecordsWrite] : RecordsWriteMessage;
}

export interface DwnMessageDescriptor {
  [DwnInterface.MessagesQuery] : MessagesQueryMessage['descriptor'];
  [DwnInterface.MessagesRead] : MessagesReadMessage['descriptor'];
  [DwnInterface.MessagesSubscribe] : MessagesSubscribeMessage['descriptor'];
  [DwnInterface.ProtocolsConfigure] : ProtocolsConfigureMessage['descriptor'];
  [DwnInterface.ProtocolsQuery] : ProtocolsQueryMessage['descriptor'];
  [DwnInterface.RecordsCount] : RecordsCountMessage['descriptor'];
  [DwnInterface.RecordsDelete] : RecordsDeleteMessage['descriptor'];
  [DwnInterface.RecordsQuery] : RecordsQueryMessage['descriptor'];
  [DwnInterface.RecordsRead] : RecordsReadMessage['descriptor'];
  [DwnInterface.RecordsSubscribe] : RecordsSubscribeMessage['descriptor'];
  [DwnInterface.RecordsWrite] : RecordsWriteMessage['descriptor'];
}

export interface DwnMessageParams {
  [DwnInterface.MessagesQuery] : Omit<MessagesQueryOptions, 'signer'>;
  [DwnInterface.MessagesRead] : RequireOnly<MessagesReadOptions, 'messageCid'>;
  [DwnInterface.MessagesSubscribe] : Partial<MessagesSubscribeOptions>;
  [DwnInterface.ProtocolsConfigure] : RequireOnly<ProtocolsConfigureOptions, 'definition'>;
  [DwnInterface.ProtocolsQuery] : ProtocolsQueryOptions;
  [DwnInterface.RecordsCount] : RecordsCountOptions;
  [DwnInterface.RecordsDelete] : RequireOnly<RecordsDeleteOptions, 'recordId'>;
  [DwnInterface.RecordsQuery] : RecordsQueryOptions;
  [DwnInterface.RecordsRead] : RecordsReadOptions;
  [DwnInterface.RecordsSubscribe] : RecordsSubscribeOptions;
  [DwnInterface.RecordsWrite] : RecordsWriteOptions;
}

export interface DwnMessageReply {
  [DwnInterface.MessagesQuery] : MessagesQueryReply;
  [DwnInterface.MessagesRead] : MessagesReadReply;
  [DwnInterface.MessagesSubscribe] : MessagesSubscribeReply;
  [DwnInterface.ProtocolsConfigure] : GenericMessageReply;
  [DwnInterface.ProtocolsQuery] : ProtocolsQueryReply;
  [DwnInterface.RecordsCount] : RecordsCountReply;
  [DwnInterface.RecordsDelete] : GenericMessageReply;
  [DwnInterface.RecordsQuery] : RecordsQueryReply;
  [DwnInterface.RecordsRead] : RecordsReadReply;
  [DwnInterface.RecordsSubscribe] : RecordsSubscribeReply;
  [DwnInterface.RecordsWrite] : GenericMessageReply;
}

export interface MessageHandler {
  [DwnInterface.MessagesSubscribe] : SubscriptionListener;
  [DwnInterface.RecordsSubscribe] : SubscriptionListener;

  // define all of them individually as undefined
  [DwnInterface.MessagesQuery] : undefined;
  [DwnInterface.MessagesRead] : undefined;
  [DwnInterface.ProtocolsConfigure] : undefined;
  [DwnInterface.ProtocolsQuery] : undefined;
  [DwnInterface.RecordsCount] : undefined;
  [DwnInterface.RecordsDelete] : undefined;
  [DwnInterface.RecordsQuery] : undefined;
  [DwnInterface.RecordsRead] : undefined;
  [DwnInterface.RecordsWrite] : undefined;
}

export type DwnRequest<T extends DwnInterface> = {
  author: string;
  target: string;
  messageType: T;
};

/**
 * Defines the structure for response status, including a status code and detail message.
 */
export type DwnResponseStatus = {
  /** Encapsulates the outcome of an operation, providing both a numeric status code and a descriptive message. */
  status: {
    /** Numeric status code representing the outcome of the operation. */
    code: number;

    /** Descriptive detail about the status or error. */
    detail: string;
  };
};

export type ProcessDwnRequest<T extends DwnInterface> = DwnRequest<T> & {
  dataStream?: Blob | ReadableStream;
  rawMessage?: DwnMessage[T];
  messageParams?: DwnMessageParams[T];
  store?: boolean;
  signAsOwner?: boolean;
  signAsOwnerDelegate?: boolean;
  granteeDid?: string;
  subscriptionHandler?: MessageHandler[T];
  /**
   * If true, automatically encrypt protocol records and inject $encryption keys.
    * Requires the identity to have an X25519 keyAgreement key.
   */
  encryption?: boolean;
};

export type SendDwnRequest<T extends DwnInterface> = DwnRequest<T> & (ProcessDwnRequest<T> | { messageCid: string });

export type DwnResponse<T extends DwnInterface> = {
  message?: DwnMessage[T];
  messageCid: string;
  reply: DwnMessageReply[T];
};

/**
 * Per-DWN-interface message factory. Only the static `create` and `parse`
 * methods are part of the contract — the underlying classes have private
 * or protected constructors (factory pattern), so the interface
 * intentionally does not declare `new ()`. Omitting `new ()` lets the
 * mapped-type table below assign class values directly without casts:
 * a class with a private constructor still satisfies a structural type
 * that doesn't require constructability, as long as the static side
 * (`create` / `parse`) lines up.
 */
export interface DwnMessageConstructor<T extends DwnInterface> {
  create(params: DwnMessageParams[T]): Promise<DwnMessageInstance[T]>;
  parse(rawMessage: DwnMessage[T]): Promise<DwnMessageInstance[T]>;
}

export const dwnMessageConstructors: { [T in DwnInterface]: DwnMessageConstructor<T> } = {
  [DwnInterface.MessagesQuery]      : MessagesQuery,
  [DwnInterface.MessagesRead]       : MessagesRead,
  [DwnInterface.MessagesSubscribe]  : MessagesSubscribe,
  [DwnInterface.ProtocolsConfigure] : ProtocolsConfigure,
  [DwnInterface.ProtocolsQuery]     : ProtocolsQuery,
  [DwnInterface.RecordsCount]       : RecordsCount,
  [DwnInterface.RecordsDelete]      : RecordsDelete,
  [DwnInterface.RecordsQuery]       : RecordsQuery,
  [DwnInterface.RecordsRead]        : RecordsRead,
  [DwnInterface.RecordsSubscribe]   : RecordsSubscribe,
  [DwnInterface.RecordsWrite]       : RecordsWrite,
};

export interface DwnMessageInstance {
  [DwnInterface.MessagesQuery] : MessagesQuery;
  [DwnInterface.MessagesRead] : MessagesRead;
  [DwnInterface.MessagesSubscribe] : MessagesSubscribe;
  [DwnInterface.ProtocolsConfigure] : ProtocolsConfigure;
  [DwnInterface.ProtocolsQuery] : ProtocolsQuery;
  [DwnInterface.RecordsCount] : RecordsCount;
  [DwnInterface.RecordsDelete] : RecordsDelete;
  [DwnInterface.RecordsQuery] : RecordsQuery;
  [DwnInterface.RecordsRead] : RecordsRead;
  [DwnInterface.RecordsSubscribe] : RecordsSubscribe;
  [DwnInterface.RecordsWrite] : RecordsWrite;
}

export type DwnMessageWithData<T extends DwnInterface> = {
  message: DwnMessage[T];
  dataStream?: ReadableStream<Uint8Array>;
};

// The following types are exported by the DWN SDK and are re-exported here so that dependent
// packages do not need to import the DWN SDK directly. This ensures that downstream packages are
// always using the same version of the DWN SDK as the agent package.

// Runtime value re-exports (classes, enums, objects)
export {
  DateSort as DwnDateSort,
  DwnConstant,
  ContentEncryptionAlgorithm as DwnContentEncryptionAlgorithm,
  KeyDerivationScheme as DwnKeyDerivationScheme,
  PermissionGrant as DwnPermissionGrant,
  PermissionRequest as DwnPermissionRequest,
  PermissionsProtocol as DwnPermissionsProtocol,
} from '@enbox/dwn-sdk-js';

// Type-only re-exports (interfaces, type aliases)
export type {
  DataEncodedRecordsWriteMessage as DwnDataEncodedRecordsWriteMessage,
  MessageSigner as DwnSigner,
  MessageSubscription as DwnMessageSubscription,
  MessagesPermissionScope as DwnMessagesPermissionScope,
  PaginationCursor as DwnPaginationCursor,
  PermissionConditions as DwnPermissionConditions,
  PermissionGrantData as DwnPermissionGrantData,
  PermissionRequestData as DwnPermissionRequestData,
  PermissionScope as DwnPermissionScope,
  ProtocolDefinition as DwnProtocolDefinition,
  ProtocolPermissionScope as DwnProtocolPermissionScope,
  PublicKeyJwk as DwnPublicKeyJwk,
  RecordsPermissionScope as DwnRecordsPermissionScope,
  SubscriptionListener as DwnSubscriptionListener,
  SubscriptionMessage as DwnSubscriptionMessage,
} from '@enbox/dwn-sdk-js';
