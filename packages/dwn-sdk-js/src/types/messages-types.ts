import type { RangeCriterion } from './query-types.js';
import type { AuthorizationModel, GenericMessage, GenericMessageReply, MessageSubscription } from './message-types.js';
import type { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import type { ProgressGapInfo, ProgressToken, SubscriptionListener } from './subscriptions.js';

/**
 * filters used when filtering for any type of Message across interfaces
 */
export type MessagesFilter = {
  interface?: string;
  method?: string;
  protocol?: string;
  /** Prefix filter for protocolPath. Matches records whose protocolPath equals
   *  the prefix or starts with the prefix followed by '/'. */
  protocolPathPrefix?: string;
  /** Prefix filter for contextId. Matches records whose contextId equals
   *  the prefix or starts with the prefix followed by '/'. */
  contextIdPrefix?: string;
  messageTimestamp?: RangeCriterion;
};

export type MessagesReadDescriptor = {
  interface : DwnInterfaceName.Messages;
  method: DwnMethodName.Read;
  messageCid: string;
  messageTimestamp: string;
  permissionGrantIds?: string[];
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

export type MessagesQueryDescriptor = {
  interface: DwnInterfaceName.Messages;
  method: DwnMethodName.Query;
  messageTimestamp: string;
  filters: MessagesFilter[];
  permissionGrantIds?: string[];
  cursor?: ProgressToken;
  limit?: number;
  cidsOnly?: boolean;
};

export type MessagesQueryMessage = {
  authorization: AuthorizationModel;
  descriptor: MessagesQueryDescriptor;
};

export type MessagesQueryReplyEntry = {
  seq: string;
  messageCid: string;
  isLatestBaseState: boolean;
  protocol?: string;
  message?: GenericMessage;
  encodedData?: string;
};

export type MessagesQueryReply = GenericMessageReply & {
  entries?: MessagesQueryReplyEntry[];
  cursor?: ProgressToken;
  drained?: boolean;
  fingerprint?: string;
  /** Present when status.code is 410 — structured gap metadata. */
  error?: { code: 'ProgressGap' } & ProgressGapInfo;
};

export type MessagesSubscribeMessageOptions = {
  subscriptionHandler: SubscriptionListener;
};

export type MessagesSubscribeMessage = {
  authorization: AuthorizationModel;
  descriptor: MessagesSubscribeDescriptor;
};

export type MessagesSubscribeReply = GenericMessageReply & {
  subscription?: MessageSubscription;
  /**
   * Feed fingerprint over the subscription's filter scopes, observed after the
   * subscription became active. Present only when the filters map onto
   * fingerprint domains and the message store exposes the replication feed.
   */
  fingerprint?: string;
  /**
   * High-water progress token of the tenant's replication log, observed after
   * the subscription became active — the position-zero anchor when the log is
   * empty. NOT a delivery cursor: adopting it as a checkpoint is sound only
   * after verifying `fingerprint` against the local feed, since resuming from
   * it skips every earlier log position.
   */
  head?: ProgressToken;
  /** Present when status.code is 410 — structured gap metadata. */
  error?: { code: 'ProgressGap' } & ProgressGapInfo;
};

export type MessagesSubscribeDescriptor = {
  interface: DwnInterfaceName.Messages;
  method: DwnMethodName.Subscribe;
  messageTimestamp: string;
  filters: MessagesFilter[];
  permissionGrantIds?: string[];
  /**
   * Progress token to resume from. When provided, the handler replays events
   * from the EventLog starting after this position instead of returning no
   * initial snapshot. An EOSE marker is sent after catch-up.
   */
  cursor?: ProgressToken;
};
