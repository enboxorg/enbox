import type { Dialect } from './dialect/dialect.js';
import type { DwnDatabaseType, KeyValues } from './types.js';
import type {
  Filter,
  GenericMessage,
  MessageSort,
  MessageStore,
  MessageStoreCompleteDataResult,
  MessageStoreOptions,
  MessageStorePutResult,
  Pagination,
  PaginationCursor,
  WakePublisher } from '@enbox/dwn-sdk-js';
import type { Transaction, UpdateObject } from 'kysely';

import * as block from 'multiformats/block';
import * as cbor from '@ipld/dag-cbor';
import { executeWithTransaction } from './utils/transaction.js';
import { extractTagsAndSanitizeIndexes } from './utils/sanitize.js';
import { filterSelectQuery } from './utils/filter.js';
import { isDuplicateKeyError } from './utils/duplicate-key-error.js';
import { sha256 } from 'multiformats/hashes/sha2';
import { TagTables } from './utils/tags.js';
import {
  DwnError,
  DwnErrorCode,
  DwnInterfaceName,
  DwnMethodName,
  executeUnlessAborted,
  Message,
  SortDirection
} from '@enbox/dwn-sdk-js';
import { Kysely, sql } from 'kysely';

/**
 * Every index column of `messageStoreMessages`, nulled. Index replacement operations spread the
 * new indexes over this object so columns absent from the replacement are cleared — matching the
 * semantics of a delete + re-put without losing the row (and its `encodedData`).
 */
const NULLED_INDEX_COLUMNS = {
  interface         : null,
  method            : null,
  schema            : null,
  dataCid           : null,
  dataSize          : null,
  dateCreated       : null,
  messageTimestamp  : null,
  dataFormat        : null,
  isLatestBaseState : null,
  published         : null,
  author            : null,
  recordId          : null,
  entryId           : null,
  datePublished     : null,
  protocol          : null,
  attester          : null,
  protocolPath      : null,
  recipient         : null,
  contextId         : null,
  parentId          : null,
  permissionGrantId : null,
  prune             : null,
  squash            : null,
} as const;

export class MessageStoreSql implements MessageStore {
  readonly #dialect: Dialect;
  readonly #tags: TagTables;
  #db: Kysely<DwnDatabaseType> | null = null;

  /**
   * Optional bus for store-owned wake publication. Accepted ahead of the SQL replication log:
   * wakes carry `{tenant, seq}`, so publication begins once the SQL log (seq column and tenant
   * counters) lands and this store can construct them.
   */
  protected wakePublisher?: WakePublisher;

  constructor(dialect: Dialect, wakePublisher?: WakePublisher) {
    this.#dialect = dialect;
    this.#tags = new TagTables(dialect);
    this.wakePublisher = wakePublisher;
  }

  /**
   * Injects the wake publisher after construction — supports the dwn-server plugin contract,
   * which requires no-arg store constructors.
   */
  public setWakePublisher(wakePublisher: WakePublisher): void {
    this.wakePublisher = wakePublisher;
  }

  async open(): Promise<void> {
    if (this.#db) {
      return;
    }

    this.#db = new Kysely<DwnDatabaseType>({ dialect: this.#dialect });

    // Fail fast if migrations have not been run — tables must already exist.
    await this.#assertTablesExist();
  }

  /**
   * Verifies that the required tables exist by executing a zero-row SELECT.
   * Throws a clear error directing the caller to run migrations first.
   */
  async #assertTablesExist(): Promise<void> {
    const tables = ['messageStoreMessages', 'messageStoreRecordsTags'] as const;
    for (const table of tables) {
      try {
        await sql`SELECT 1 FROM ${sql.table(table)} LIMIT 0`.execute(this.#db!);
      } catch {
        throw new Error(
          `MessageStoreSql: table '${table}' does not exist. Run DWN store migrations before opening stores.`
        );
      }
    }
  }

  async close(): Promise<void> {
    await this.#db?.destroy();
    this.#db = null;
  }

  async put(
    tenant: string,
    message: GenericMessage,
    indexes: KeyValues,
    options?: MessageStoreOptions
  ): Promise<MessageStorePutResult> {
    if (!this.#db) {
      throw new Error(
        'Connection to database not open. Call `open` before using `put`.'
      );
    }

    options?.signal?.throwIfAborted();

    // gets the encoded data and removes it from the message
    // we remove it from the message as it would cause the `encodedMessageBytes` to be greater than the
    // maximum bytes allowed by SQL
    const getEncodedData = (message: GenericMessage): { message: GenericMessage, encodedData: string|null} => {
      const messageToProcess = { ...message };
      let encodedData: string|null = null;
      if (messageToProcess.descriptor.interface === DwnInterfaceName.Records && messageToProcess.descriptor.method === DwnMethodName.Write) {
        const data = messageToProcess.encodedData;
        if (data) {
          delete messageToProcess.encodedData;
          encodedData = data;
        }
      }
      return { message: messageToProcess, encodedData };
    };

    const { message: messageToProcess, encodedData } = getEncodedData(message);

    const encodedMessageBlock = await executeUnlessAborted(
      block.encode({ value: messageToProcess, codec: cbor, hasher: sha256 }),
      options?.signal
    );

    const messageCid = encodedMessageBlock.cid.toString();
    const encodedMessageBytes = Buffer.from(encodedMessageBlock.bytes);

    // we execute the insert in a transaction as we are making multiple inserts into multiple tables.
    // if any of these inserts would throw, the whole transaction would be rolled back.
    // otherwise it is committed.
    const putMessageOperation = this.constructPutMessageOperation({ tenant, messageCid, encodedMessageBytes, encodedData, indexes });
    try {
      await executeWithTransaction(this.#db, putMessageOperation);
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        // Idempotent write — the exact same message already exists.
        // This is expected when sync or protocol.send() re-delivers a
        // message the DWN already has.  A race between the handler's
        // duplicate-CID check and the actual insert makes this
        // unavoidable in concurrent environments.
        // NOTE: `position` is omitted until the SQL replication log lands (no seq column yet).
        return { status: 'duplicate' };
      }
      throw error;
    }

    return { status: 'inserted' };
  }

  /**
   * Replaces the indexes of an existing message in place — a row UPDATE that also syncs the tag
   * tables (tags are indexed only while `isLatestBaseState` is true, so an index flip must add or
   * remove tag rows in the same transaction). The row — and its `encodedData` — is never deleted.
   */
  async updateIndexes(
    tenant: string,
    messageCid: string,
    indexes: KeyValues,
    options?: MessageStoreOptions
  ): Promise<void> {
    if (!this.#db) {
      throw new Error(
        'Connection to database not open. Call `open` before using `updateIndexes`.'
      );
    }

    options?.signal?.throwIfAborted();

    await this.replaceRowIndexes({
      tenant,
      messageCid,
      indexes,
      notFoundErrorCode: DwnErrorCode.MessageStoreUpdateIndexesMessageNotFound,
    });
  }

  /**
   * Replaces the same-CID row payload and indexes in place. This is used when an inline-data
   * RecordsWrite is retained only for lineage/reconstruction and must no longer expose data.
   */
  async updateMessageAndIndexes(
    tenant: string,
    messageCid: string,
    message: GenericMessage,
    indexes: KeyValues,
    options?: MessageStoreOptions
  ): Promise<void> {
    if (!this.#db) {
      throw new Error(
        'Connection to database not open. Call `open` before using `updateMessageAndIndexes`.'
      );
    }

    options?.signal?.throwIfAborted();

    const computedMessageCid = await Message.getCid(message);
    if (computedMessageCid !== messageCid) {
      throw new DwnError(
        DwnErrorCode.MessageStoreUpdateMessageAndIndexesCidMismatch,
        `replacement message CID ${computedMessageCid} does not match target CID ${messageCid}`
      );
    }

    let encodedData: string | null = null;
    const messageToProcess = { ...message };
    if (messageToProcess.descriptor.interface === DwnInterfaceName.Records && messageToProcess.descriptor.method === DwnMethodName.Write) {
      if (messageToProcess.encodedData !== undefined) {
        encodedData = messageToProcess.encodedData;
        delete messageToProcess.encodedData;
      }
    }

    const encodedMessageBlock = await executeUnlessAborted(
      block.encode({ value: messageToProcess, codec: cbor, hasher: sha256 }),
      options?.signal
    );

    await this.replaceRowIndexes({
      tenant,
      messageCid,
      indexes,
      encodedMessageBytes : Buffer.from(encodedMessageBlock.bytes),
      encodedData,
      notFoundErrorCode   : DwnErrorCode.MessageStoreUpdateMessageAndIndexesMessageNotFound,
    });
  }

  /**
   * Completes a previously dataless row with its data: same CID, same row. Attaches the inline
   * `encodedData` column when given and flips the row's indexes (syncing the tag tables).
   *
   * NOTE: redelivery stamping (`redeliverSeq` from the tenant counter) and the post-commit wake
   * land with the SQL replication log; until then this store returns no `position`.
   */
  async completeData(
    tenant: string,
    messageCid: string,
    indexes: KeyValues,
    encodedData?: string,
    options?: MessageStoreOptions
  ): Promise<MessageStoreCompleteDataResult> {
    if (!this.#db) {
      throw new Error(
        'Connection to database not open. Call `open` before using `completeData`.'
      );
    }

    options?.signal?.throwIfAborted();

    await this.replaceRowIndexes({
      tenant,
      messageCid,
      indexes,
      encodedData,
      notFoundErrorCode: DwnErrorCode.MessageStoreCompleteDataMessageNotFound,
    });

    return {};
  }

  /**
   * Shared row-UPDATE implementation for `updateIndexes` and `completeData`: nulls every index
   * column, overlays the sanitized replacement indexes, optionally attaches `encodedData`, and
   * rebuilds the row's tag table entries — all in one transaction.
   */
  private async replaceRowIndexes(input: {
    tenant: string;
    messageCid: string;
    indexes: KeyValues;
    encodedMessageBytes?: Buffer;
    encodedData?: string | null;
    notFoundErrorCode: DwnErrorCode;
  }): Promise<void> {
    const { tenant, messageCid, indexes, encodedMessageBytes, encodedData, notFoundErrorCode } = input;

    // we extract the tag indexes into their own object to be inserted separately.
    // we also sanitize the indexes to convert any `boolean` values to `number` representations.
    const { indexes: replacementIndexes, tags } = extractTagsAndSanitizeIndexes(indexes);

    await executeWithTransaction(this.#db!, async (tx) => {
      const existingRow = await tx
        .selectFrom('messageStoreMessages')
        .select(['id'])
        .where('tenant', '=', tenant)
        .where('messageCid', '=', messageCid)
        .executeTakeFirst();

      if (existingRow === undefined) {
        throw new DwnError(notFoundErrorCode, `no message found for tenant ${tenant} with CID ${messageCid}`);
      }

      const replacementColumns = {
        ...NULLED_INDEX_COLUMNS,
        ...replacementIndexes,
        ...(encodedMessageBytes !== undefined && { encodedMessageBytes }),
        ...(encodedData !== undefined && { encodedData }),
      };

      await tx
        .updateTable('messageStoreMessages')
        .set(replacementColumns as UpdateObject<DwnDatabaseType, 'messageStoreMessages'>)
        .where('id', '=', existingRow.id)
        .execute();

      // rebuild the tag rows to mirror the replacement indexes
      await tx
        .deleteFrom('messageStoreRecordsTags')
        .where('messageInsertId', '=', existingRow.id)
        .execute();

      if (Object.keys(tags).length > 0) {
        await this.#tags.executeTagsInsert(existingRow.id, tags, tx);
      }
    });
  }

  /**
   * Constructs the transactional operation to insert the given message into the database.
   */
  private constructPutMessageOperation(queryOptions: {
    tenant: string;
    messageCid: string;
    encodedMessageBytes: Buffer;
    encodedData: string | null;
    indexes: KeyValues;
  }): (tx: Transaction<DwnDatabaseType>) => Promise<void> {
    const { tenant, messageCid, encodedMessageBytes, encodedData, indexes } = queryOptions;

    // we extract the tag indexes into their own object to be inserted separately.
    // we also sanitize the indexes to convert any `boolean` values to `text` representations.
    const { indexes: putIndexes, tags } = extractTagsAndSanitizeIndexes(indexes);

    return async (tx) => {

      const messageIndexValues = {
        tenant,
        messageCid,
        encodedMessageBytes,
        encodedData,
        ...putIndexes
      };

      // we use the dialect-specific `insertThenReturnId` in order to be able to extract the `insertId`
      const result = await this.#dialect
        .insertThenReturnId(tx, 'messageStoreMessages', messageIndexValues, 'id as insertId')
        .executeTakeFirstOrThrow();

      // if tags exist, we execute those within the transaction associating them with the `insertId`.
      if (Object.keys(tags).length > 0) {
        await this.#tags.executeTagsInsert(result.insertId, tags, tx);
      }

    };
  }

  async get(
    tenant: string,
    cid: string,
    options?: MessageStoreOptions
  ): Promise<GenericMessage | undefined> {
    if (!this.#db) {
      throw new Error(
        'Connection to database not open. Call `open` before using `get`.'
      );
    }

    options?.signal?.throwIfAborted();

    const result = await executeUnlessAborted(
      this.#db
        .selectFrom('messageStoreMessages')
        .selectAll()
        .where('tenant', '=', tenant)
        .where('messageCid', '=', cid)
        .executeTakeFirst(),
      options?.signal
    );

    if (!result) {
      return undefined;
    }

    return this.parseEncodedMessage(result.encodedMessageBytes, result.encodedData, options);
  }

  async query(
    tenant: string,
    filters: Filter[],
    messageSort?: MessageSort,
    pagination?: Pagination,
    options?: MessageStoreOptions
  ): Promise<{ messages: GenericMessage[], cursor?: PaginationCursor}> {
    if (!this.#db) {
      throw new Error(
        'Connection to database not open. Call `open` before using `query`.'
      );
    }

    options?.signal?.throwIfAborted();

    // extract sort property and direction from the supplied messageSort
    const { property: sortProperty, direction: sortDirection } = this.extractSortProperties(messageSort);

    let query = this.#db
      .selectFrom('messageStoreMessages')
      .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
      .select('messageCid')
      .distinct()
      .select([
        'encodedMessageBytes',
        'encodedData',
        sortProperty,
      ])
      .where('tenant', '=', tenant);

    // filter sanitization takes place within `filterSelectQuery`
    query = filterSelectQuery(filters, query);

    if (pagination?.cursor !== undefined) {
      // currently the sort property is explicitly either `dateCreated` | `messageTimestamp` | `datePublished` which are all strings
      // TODO: https://github.com/enboxorg/enbox/issues/664 to handle the edge case
      const cursorValue = pagination.cursor.value as string;
      const cursorMessageId = pagination.cursor.messageCid;

      query = query.where(({ eb, refTuple, tuple }) => {
        const direction = sortDirection === SortDirection.Ascending ? '>' : '<';
        // https://kysely-org.github.io/kysely-apidoc/interfaces/ExpressionBuilder.html#refTuple
        return eb(refTuple(sortProperty, 'messageCid'), direction, tuple(cursorValue, cursorMessageId));
      });
    }

    const orderDirection = sortDirection === SortDirection.Ascending ? 'asc' : 'desc';
    // sorting by the provided sort property, the tiebreak is always in ascending order regardless of sort
    query = query
      .orderBy(sortProperty, orderDirection)
      .orderBy('messageCid', orderDirection);

    if (pagination?.limit !== undefined && pagination?.limit > 0) {
      // we query for one additional record to decide if we return a pagination cursor or not.
      query = query.limit(pagination.limit + 1);
    }

    const results = await executeUnlessAborted(
      query.execute(),
      options?.signal
    );

    // prunes the additional requested message, if it exists, and adds a cursor to the results.
    // also parses the encoded message for each of the returned results.
    return this.processPaginationResults(results, sortProperty, pagination?.limit, options);
  }

  async count(
    tenant: string,
    filters: Filter[],
    messageSort?: MessageSort,
    options?: MessageStoreOptions
  ): Promise<number> {
    if (!this.#db) {
      throw new Error(
        'Connection to database not open. Call `open` before using `count`.'
      );
    }

    options?.signal?.throwIfAborted();

    let query = this.#db
      .selectFrom('messageStoreMessages')
      .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
      .select(sql<number>`count(distinct ${sql.ref('messageStoreMessages.messageCid')})`.as('count'))
      .where('tenant', '=', tenant);

    query = filterSelectQuery(filters, query);

    const result = await executeUnlessAborted(query.executeTakeFirstOrThrow(), options?.signal);

    return Number(result.count);
  }

  async delete(
    tenant: string,
    cid: string,
    options?: MessageStoreOptions
  ): Promise<void> {
    if (!this.#db) {
      throw new Error(
        'Connection to database not open. Call `open` before using `delete`.'
      );
    }

    options?.signal?.throwIfAborted();

    await executeUnlessAborted(
      this.#db
        .deleteFrom('messageStoreMessages')
        .where('tenant', '=', tenant)
        .where('messageCid', '=', cid)
        .execute(),
      options?.signal
    );
  }

  async clear(): Promise<void> {
    if (!this.#db) {
      throw new Error(
        'Connection to database not open. Call `open` before using `clear`.'
      );
    }

    await this.#db
      .deleteFrom('messageStoreMessages')
      .execute();
  }

  private async parseEncodedMessage(
    encodedMessageBytes: Uint8Array,
    encodedData: string | null | undefined,
    options?: MessageStoreOptions
  ): Promise<GenericMessage> {
    options?.signal?.throwIfAborted();

    const decodedBlock = await block.decode({
      bytes  : encodedMessageBytes,
      codec  : cbor,
      hasher : sha256
    });

    const message = decodedBlock.value as GenericMessage;
    // If encodedData is stored within the MessageStore we include it in the response.
    // We store encodedData when the data is below a certain threshold.
    // https://github.com/enboxorg/enbox/pull/456
    if (message !== undefined && encodedData !== undefined && encodedData !== null) {
      message.encodedData = encodedData;
    }
    return message;
  }

  /**
   * Processes the paginated query results.
   * Builds a pagination cursor if there are additional messages to paginate.
   * Accepts more messages than the limit, as we query for additional records to check if we should paginate.
   *
   * @param messages a list of messages, potentially larger than the provided limit.
   * @param limit the maximum number of messages to be returned
   *
   * @returns the pruned message results and an optional pagination cursor
   */
  private async processPaginationResults(
    results: any[],
    sortProperty: string,
    limit?: number,
    options?: MessageStoreOptions,
  ): Promise<{ messages: GenericMessage[], cursor?: PaginationCursor}> {
    // we queried for one additional message to determine if there are any additional messages beyond the limit
    // we now check if the returned results are greater than the limit, if so we pluck the last item out of the result set
    // the cursor is always the last item in the *returned* result so we use the last item in the remaining result set to build a cursor
    let cursor: PaginationCursor | undefined;
    if (limit !== undefined && results.length > limit) {
      results = results.slice(0, limit);
      const lastMessage = results.at(-1);
      const cursorValue = lastMessage[sortProperty];
      cursor = { messageCid: lastMessage.messageCid, value: cursorValue };
    }

    // extracts the full encoded message from the stored blob for each result item.
    const messages: Promise<GenericMessage>[] = results.map(r => this.parseEncodedMessage(r.encodedMessageBytes, r.encodedData, options));
    return { messages: await Promise.all(messages), cursor };
  }

  /**
   * Extracts the appropriate sort property and direction given a MessageSort object.
   */
  private extractSortProperties(
    messageSort?: MessageSort
  ):{ property: 'dateCreated' | 'datePublished' | 'messageTimestamp', direction: SortDirection } {
    if (messageSort?.dateCreated !== undefined) {
      return { property: 'dateCreated', direction: messageSort.dateCreated };
    } else if (messageSort?.datePublished !== undefined) {
      return { property: 'datePublished', direction: messageSort.datePublished };
    } else if (messageSort?.messageTimestamp === undefined) {
      return { property: 'messageTimestamp', direction: SortDirection.Ascending };
    } else {
      return { property: 'messageTimestamp', direction: messageSort.messageTimestamp };
    }
  }
}

export { isDuplicateKeyError } from './utils/duplicate-key-error.js';
