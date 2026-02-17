import type { MessageEvent } from './subscriptions.js';
import type { RangeCriterion } from './query-types.js';
import type { AuthorizationModel, GenericMessage, GenericMessageReply, MessageSubscription } from './message-types.js';
import type { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

/**
 * filters used when filtering for any type of Message across interfaces
 */
export type MessagesFilter = {
  interface?: string;
  method?: string;
  protocol?: string;
  messageTimestamp?: RangeCriterion;
};

export type MessagesReadDescriptor = {
  interface : DwnInterfaceName.Messages;
  method: DwnMethodName.Read;
  messageCid: string;
  messageTimestamp: string;
  permissionGrantId?: string;
};

export type MessagesReadMessage = GenericMessage & {
  authorization: AuthorizationModel; // overriding `GenericMessage` with `authorization` being required
  descriptor: MessagesReadDescriptor;
};

export type MessagesReadReplyEntry = {
  messageCid: string;
  message: GenericMessage;
  data?: ReadableStream<Uint8Array>;
};

export type MessagesReadReply = GenericMessageReply & {
  entry?: MessagesReadReplyEntry;
};

export type MessagesSyncAction = 'root' | 'subtree' | 'leaves';

export type MessagesSyncDescriptor = {
  interface : DwnInterfaceName.Messages;
  method : DwnMethodName.Sync;
  messageTimestamp : string;
  action : MessagesSyncAction;
  protocol? : string; // optional protocol scope
  prefix? : string; // bit path for subtree/leaves (e.g. "0110101...")
  permissionGrantId? : string;
};

export type MessagesSyncMessage = GenericMessage & {
  authorization : AuthorizationModel; // overriding `GenericMessage` with `authorization` being required
  descriptor : MessagesSyncDescriptor;
};

export type MessagesSyncReply = GenericMessageReply & {
  root? : string; // hex-encoded root hash (for 'root' action)
  hash? : string; // hex-encoded subtree hash (for 'subtree' action)
  entries? : string[]; // messageCid[] (for 'leaves' action)
};

export type MessageSubscriptionHandler = (event: MessageEvent) => void;

export type MessagesSubscribeMessageOptions = {
  subscriptionHandler: MessageSubscriptionHandler;
};

export type MessagesSubscribeMessage = {
  authorization: AuthorizationModel;
  descriptor: MessagesSubscribeDescriptor;
};

export type MessagesSubscribeReply = GenericMessageReply & {
  subscription?: MessageSubscription;
};

export type MessagesSubscribeDescriptor = {
  interface: DwnInterfaceName.Messages;
  method: DwnMethodName.Subscribe;
  messageTimestamp: string;
  filters: MessagesFilter[];
  permissionGrantId?: string;
};
