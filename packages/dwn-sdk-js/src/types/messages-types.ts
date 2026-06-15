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

export type MessagesSyncAction = 'root' | 'subtree' | 'leaves' | 'diff';

export type MessagesSyncDescriptor = {
  interface : DwnInterfaceName.Messages;
  method : DwnMethodName.Sync;
  messageTimestamp : string;
  action : MessagesSyncAction;
  protocol? : string; // optional protocol scope
  prefix? : string; // bit path for subtree/leaves (e.g. "0110101...")
  permissionGrantIds? : string[];
  /**
   * For `action: 'diff'`: a map of `{ bitPrefix: hexHash }` representing the client's
   * subtree hashes at `depth`. The server compares each hash against its own tree
   * and returns the set difference in a single round-trip.
   *
   * Only non-default (non-empty) subtree hashes need to be included — prefixes
   * whose hash equals the default empty-subtree hash may be omitted.
   */
  hashes? : Record<string, string>;
  /**
   * For `action: 'diff'`: the bit depth at which the client computed its subtree
   * hashes. Required when `action` is `'diff'`.
   */
  depth? : number;
};

export type MessagesSyncMessage = GenericMessage & {
  authorization : AuthorizationModel; // overriding `GenericMessage` with `authorization` being required
  descriptor : MessagesSyncDescriptor;
};

/**
 * Entry in a diff response representing a message the server has that the
 * client does not (or vice versa). Optionally includes the full message
 * and inline data for small payloads.
 */
export type MessagesSyncDiffEntry = {
  messageCid : string;
  message? : GenericMessage;
  /** Base64url-encoded data for small RecordsWrite payloads (≤ maxInlineDataSize). */
  encodedData? : string;
};

export type MessagesSyncReply = GenericMessageReply & {
  root? : string; // hex-encoded root hash (for 'root' action)
  hash? : string; // hex-encoded subtree hash (for 'subtree' action)
  entries? : string[]; // messageCid[] (for 'leaves' action)
  /** For 'diff' action: messageCids (or full messages) that the server has but the client doesn't. */
  onlyRemote? : MessagesSyncDiffEntry[];
  /** For 'diff' action: bit prefixes where the client has entries the server doesn't. */
  onlyLocal? : string[];
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
