import type { ProgressToken } from './subscriptions.js';
import type { Filter, KeyValues, PaginationCursor } from './query-types.js';
import type { GenericMessage, MessageSort, Pagination } from './message-types.js';

export interface MessageStoreOptions {
  signal?: AbortSignal;
}

/**
 * Read-time `$recordLimit` occupancy policy for one concrete protocol path.
 *
 * Stores partition matching latest RecordsWrites by `parentId`, rank each
 * partition by `dateCreated` then `recordId` ascending, and apply `max`
 * before the caller's filters, sort, and pagination.
 */
export type RecordLimitOccupancy = {
  protocol: string;
  protocolPath: string;
  /**
   * Root of the candidate context subtree. An exact-record request supplies
   * its direct-parent context here so sibling candidates still consume slots.
   * Omitted for root protocol paths.
   */
  contextId?: string;
  max: number;
};

export interface MessageStoreQueryOptions extends MessageStoreOptions {
  recordLimit?: RecordLimitOccupancy;
}

/**
 * Result of a {@link MessageStore.put} operation.
 */
export type MessageStorePutResult = {
  /**
   * `inserted` when a new row was created; `duplicate` when a row for the same
   * `(tenant, messageCid)` already exists.
   */
  status: 'inserted' | 'duplicate';

  /**
   * The inserted row's log position. Present for stores that maintain a
   * replication log; omitted for duplicates and store implementations whose
   * durable log support has not landed.
   */
  position?: ProgressToken;
};

/**
 * A latest-state transition applied by {@link MessageStore.commitLatestState}: the insert of a new
 * message together with the displacement of the messages it supersedes.
 */
export type MessageStoreLatestStateTransition = {
  /**
   * The new message to insert, with its insert-time indexes.
   */
  put: { message: GenericMessage; indexes: KeyValues };

  /**
   * Displaced writes retained as non-latest state: same-CID in-place replacements
   * (same row, same log sequence) applied with the insert.
   */
  retains?: { messageCid: string; message: GenericMessage; indexes: KeyValues }[];

  /**
   * Message CIDs of displaced messages that are not retained, deleted with the insert.
   */
  deletes?: string[];
};

export interface MessageStore {
  /**
   * opens a connection to the underlying store
   */
  open(): Promise<void>;

  /**
   * closes the connection to the underlying store
   */
  close(): Promise<void>;

  /**
   * adds a message to the underlying store. Uses the message's cid as the key
   * @param indexes indexes (key-value pairs) to be included as part of this put operation
   */
  put(
    tenant: string,
    message: GenericMessage,
    indexes: KeyValues,
    options?: MessageStoreOptions
  ): Promise<MessageStorePutResult>;

  /**
   * Atomically inserts a new message and displaces the messages it supersedes: retained writes are
   * replaced in place with their demoted state, and the remaining displaced rows are deleted, all
   * in one commit. Readers can never observe an intermediate state where both the new message and
   * a displaced message carry latest-state indexes.
   *
   * When the new message already exists, returns `duplicate` and still applies the retains and
   * deletes, so replaying a transition heals one that was only partially planned before a crash.
   */
  commitLatestState(
    tenant: string,
    transition: MessageStoreLatestStateTransition,
    options?: MessageStoreOptions
  ): Promise<MessageStorePutResult>;

  /**
   * Fetches a single message by `cid` from the underlying store.
   * Returns `undefined` no message was found.
   */
  get(tenant: string, cid: string, options?: MessageStoreOptions): Promise<GenericMessage | undefined>;

  /**
   * Queries the underlying store for messages that matches the provided filters.
   * Supplying multiple filters establishes an OR condition between the filters.
   */
  query(
    tenant: string,
    filters: Filter[],
    messageSort?: MessageSort,
    pagination?: Pagination,
    options?: MessageStoreQueryOptions
  ): Promise<{ messages: GenericMessage[], cursor?: PaginationCursor}>;

  /**
   * Counts the number of messages matching the provided filters without loading full message data.
   * More efficient than query() when only the count is needed, especially when compound indexes are available.
   */
  count(
    tenant: string,
    filters: Filter[],
    messageSort?: MessageSort,
    options?: MessageStoreQueryOptions
  ): Promise<number>;

  /**
   * Replaces the indexes of an existing message in place: same row and same log
   * sequence.
   */
  updateIndexes(
    tenant: string,
    messageCid: string,
    indexes: KeyValues,
    options?: MessageStoreOptions
  ): Promise<void>;

  /**
   * Replaces the stored same-CID message payload and indexes in place: same
   * row and same log sequence. The replacement message must resolve to
   * `messageCid` under DWN CID rules.
   */
  updateMessageAndIndexes(
    tenant: string,
    messageCid: string,
    message: GenericMessage,
    indexes: KeyValues,
    options?: MessageStoreOptions
  ): Promise<void>;

  /**
   * Deletes the message associated with the id provided.
   */
  delete(tenant: string, cid: string, options?: MessageStoreOptions): Promise<void>;

  /**
   * Clears the entire store. Mainly used for cleaning up in test environment.
   */
  clear(): Promise<void>;
}
