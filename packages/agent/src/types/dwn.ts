import type { DidService } from '@enbox/dids';
import type { RequireOnly } from '@enbox/common';

import type {
  GenericMessageReply,
  MessagesReadMessage,
  MessagesReadOptions,
  MessagesReadReply,
  MessagesSubscribeMessage,
  MessagesSubscribeOptions,
  MessagesSubscribeReply,
  MessagesSyncMessage,
  MessagesSyncReply,
  ProtocolsConfigureMessage,
  ProtocolsConfigureOptions,
  ProtocolsQueryMessage,
  ProtocolsQueryOptions,
  ProtocolsQueryReply,
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

import type { MessagesSyncOptions } from '@enbox/dwn-sdk-js';

import {
  DwnInterfaceName,
  DwnMethodName,
  MessagesRead,
  MessagesSubscribe,
  MessagesSync,
  ProtocolsConfigure,
  ProtocolsQuery,
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
 * `DecentralizedWebNode`. It includes specific properties `enc` and `sig` that are used to identify
 * the public keys that can be used to interact with the DID Subject. The values of these properties
 * are strings or arrays of strings containing one or more verification method `id` values present in
 * the same DID document. If the `enc` and/or `sig` properties are an array of strings, an entity
 * interacting with the DID subject is expected to use the verification methods in the order they
 * are listed.
 *
 * @example
 * ```ts
 * const service: DwnDidService = {
 *   id: 'did:example:123#dwn',
 *   type: 'DecentralizedWebNode',
 *   serviceEndpoint: 'https://enbox-dwn.fly.dev',
 *   enc: 'did:example:123#key-1',
 *   sig: 'did:example:123#key-2'
 * }
 * ```
 *
 * @see {@link https://identity.foundation/decentralized-web-node/spec/ | DIF Decentralized Web Node (DWN) Specification}
 */
export interface DwnDidService extends DidService {
  /**
   * One or more verification method `id` values that can be used to encrypt information
   * intended for the DID subject.
   */
  enc?: string | string[];

  /**
   * One or more verification method `id` values that will be used by the DID subject to sign data
   * or by another entity to verify signatures created by the DID subject.
   */
  sig: string | string[];
}

export enum DwnInterface {
  MessagesRead = DwnInterfaceName.Messages + DwnMethodName.Read,
  MessagesSubscribe = DwnInterfaceName.Messages + DwnMethodName.Subscribe,
  MessagesSync = DwnInterfaceName.Messages + DwnMethodName.Sync,
  ProtocolsConfigure = DwnInterfaceName.Protocols + DwnMethodName.Configure,
  ProtocolsQuery = DwnInterfaceName.Protocols + DwnMethodName.Query,
  RecordsDelete = DwnInterfaceName.Records + DwnMethodName.Delete,
  RecordsQuery = DwnInterfaceName.Records + DwnMethodName.Query,
  RecordsRead = DwnInterfaceName.Records + DwnMethodName.Read,
  RecordsSubscribe = DwnInterfaceName.Records + DwnMethodName.Subscribe,
  RecordsWrite = DwnInterfaceName.Records + DwnMethodName.Write
}

export type DwnRecordsInterfaces =
  | DwnInterface.RecordsDelete | DwnInterface.RecordsQuery | DwnInterface.RecordsRead
  | DwnInterface.RecordsSubscribe | DwnInterface.RecordsWrite;

export interface DwnMessage {
  [DwnInterface.MessagesRead] : MessagesReadMessage;
  [DwnInterface.MessagesSubscribe] : MessagesSubscribeMessage;
  [DwnInterface.MessagesSync] : MessagesSyncMessage;
  [DwnInterface.ProtocolsConfigure] : ProtocolsConfigureMessage;
  [DwnInterface.ProtocolsQuery] : ProtocolsQueryMessage;
  [DwnInterface.RecordsDelete] : RecordsDeleteMessage;
  [DwnInterface.RecordsQuery] : RecordsQueryMessage;
  [DwnInterface.RecordsRead] : RecordsReadMessage;
  [DwnInterface.RecordsSubscribe] : RecordsSubscribeMessage;
  [DwnInterface.RecordsWrite] : RecordsWriteMessage;
}

export interface DwnMessageDescriptor {
  [DwnInterface.MessagesRead] : MessagesReadMessage['descriptor'];
  [DwnInterface.MessagesSubscribe] : MessagesSubscribeMessage['descriptor'];
  [DwnInterface.MessagesSync] : MessagesSyncMessage['descriptor'];
  [DwnInterface.ProtocolsConfigure] : ProtocolsConfigureMessage['descriptor'];
  [DwnInterface.ProtocolsQuery] : ProtocolsQueryMessage['descriptor'];
  [DwnInterface.RecordsDelete] : RecordsDeleteMessage['descriptor'];
  [DwnInterface.RecordsQuery] : RecordsQueryMessage['descriptor'];
  [DwnInterface.RecordsRead] : RecordsReadMessage['descriptor'];
  [DwnInterface.RecordsSubscribe] : RecordsSubscribeMessage['descriptor'];
  [DwnInterface.RecordsWrite] : RecordsWriteMessage['descriptor'];
}

export interface DwnMessageParams {
  [DwnInterface.MessagesRead] : RequireOnly<MessagesReadOptions, 'messageCid'>;
  [DwnInterface.MessagesSubscribe] : Partial<MessagesSubscribeOptions>;
  [DwnInterface.MessagesSync] : RequireOnly<MessagesSyncOptions, 'action'>;
  [DwnInterface.ProtocolsConfigure] : RequireOnly<ProtocolsConfigureOptions, 'definition'>;
  [DwnInterface.ProtocolsQuery] : ProtocolsQueryOptions;
  [DwnInterface.RecordsDelete] : RequireOnly<RecordsDeleteOptions, 'recordId'>;
  [DwnInterface.RecordsQuery] : RecordsQueryOptions;
  [DwnInterface.RecordsRead] : RecordsReadOptions;
  [DwnInterface.RecordsSubscribe] : RecordsSubscribeOptions;
  [DwnInterface.RecordsWrite] : RecordsWriteOptions;
}

export interface DwnMessageReply {
  [DwnInterface.MessagesRead] : MessagesReadReply;
  [DwnInterface.MessagesSubscribe] : MessagesSubscribeReply;
  [DwnInterface.MessagesSync] : MessagesSyncReply;
  [DwnInterface.ProtocolsConfigure] : GenericMessageReply;
  [DwnInterface.ProtocolsQuery] : ProtocolsQueryReply;
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
  [DwnInterface.MessagesRead] : undefined;
  [DwnInterface.MessagesSync] : undefined;
  [DwnInterface.ProtocolsConfigure] : undefined;
  [DwnInterface.ProtocolsQuery] : undefined;
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

export interface DwnMessageConstructor<T extends DwnInterface> {
  new (): DwnMessageInstance[T];
  create(params: DwnMessageParams[T]): Promise<DwnMessageInstance[T]>;
  parse(rawMessage: DwnMessage[T]): Promise<DwnMessageInstance[T]>;
}

export const dwnMessageConstructors: { [T in DwnInterface]: DwnMessageConstructor<T> } = {
  [DwnInterface.MessagesRead]       : MessagesRead as any,
  [DwnInterface.MessagesSubscribe]  : MessagesSubscribe as any,
  [DwnInterface.MessagesSync]       : MessagesSync as any,
  [DwnInterface.ProtocolsConfigure] : ProtocolsConfigure as any,
  [DwnInterface.ProtocolsQuery]     : ProtocolsQuery as any,
  [DwnInterface.RecordsDelete]      : RecordsDelete as any,
  [DwnInterface.RecordsQuery]       : RecordsQuery as any,
  [DwnInterface.RecordsRead]        : RecordsRead as any,
  [DwnInterface.RecordsSubscribe]   : RecordsSubscribe as any,
  [DwnInterface.RecordsWrite]       : RecordsWrite as any,
} as const;

export interface DwnMessageInstance {
  [DwnInterface.MessagesRead] : MessagesRead;
  [DwnInterface.MessagesSubscribe] : MessagesSubscribe;
  [DwnInterface.MessagesSync] : MessagesSync;
  [DwnInterface.ProtocolsConfigure] : ProtocolsConfigure;
  [DwnInterface.ProtocolsQuery] : ProtocolsQuery;
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