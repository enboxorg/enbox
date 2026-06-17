import type { PaginationCursor } from '../types/query-types.js';
import type { ProgressToken } from '../types/subscriptions.js';
import type { ProtocolsConfigureMessage } from '../types/protocols-types.js';
import type { RecordsReadReplyEntry } from '../types/records-types.js';
import type { GenericMessageReply, MessageSubscription, QueryResultEntry } from '../types/message-types.js';
import type { MessagesQueryReplyEntry, MessagesReadReplyEntry } from '../types/messages-types.js';

export function messageReplyFromError(e: unknown, code: number): GenericMessageReply {

  const detail = e instanceof Error ? e.message : 'Error';

  return { status: { code, detail } };
}

/**
 * Catch-all message reply type. It is recommended to use GenericMessageReply or a message-specific reply type wherever possible.
 */
export type UnionMessageReply = GenericMessageReply & {
  /**
   * A container for the data returned from a `RecordsRead` or `MessagesRead`.
   * Mutually exclusive with (`entries` + `cursor`) and `subscription`.
   */
  entry?: MessagesReadReplyEntry & RecordsReadReplyEntry;

  /**
   * Resulting message entries or events returned from the invocation of the corresponding message.
   * e.g. the resulting messages from a RecordsQuery or MessagesQuery.
   * Mutually exclusive with `record`.
   */
  entries?: QueryResultEntry[] | ProtocolsConfigureMessage[] | MessagesQueryReplyEntry[] | string[];

  /**
   * A cursor for pagination if applicable (e.g. RecordsQuery).
   * Mutually exclusive with `record`.
   */
  cursor?: PaginationCursor | ProgressToken;

  /**
   * A subscription object if a subscription was requested.
   */
  subscription?: MessageSubscription;
};
