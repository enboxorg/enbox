import {
  DwnInterfaceName,
  DwnMethodName,
  executeUnlessAborted,
  Filter,
  GenericMessage,
  MessageStore,
  MessageStoreOptions,
  MessageSort,
  Pagination,
  SortDirection,
  PaginationCursor,
} from '@tbd54566975/dwn-sdk-js';

import { Kysely, Transaction } from 'kysely';
import { DwnDatabaseType, KeyValues } from './types.js';
import * as block from 'multiformats/block';
import * as cbor from '@ipld/dag-cbor';
import { Dialect } from './dialect/dialect.js';
import { executeWithRetryIfDatabaseIsLocked } from './utils/transaction.js';
import { extractTagsAndSanitizeIndexes } from './utils/sanitize.js';
import { filterSelectQuery } from './utils/filter.js';
import { sha256 } from 'multiformats/hashes/sha2';
import { TagTables } from './utils/tags.js';


export class MessageStoreSql implements MessageStore {
  #dialect: Dialect;
  #tags: TagTables;
  #db: Kysely<DwnDatabaseType> | null = null;

  constructor(dialect: Dialect) {
    this.#dialect = dialect;
    this.#tags = new TagTables(dialect, 'messageStoreMessages');
  }

  async open(): Promise<void> {
    if (this.#db) {
      return;
    }

    this.#db = new Kysely<DwnDatabaseType>({ dialect: this.#dialect });

    // create messages table if it does not exist
    const messagesTableName = 'messageStoreMessages';
    const messagesTableExists = await this.#dialect.hasTable(this.#db, messagesTableName);
    if (!messagesTableExists) {
      let createMessagesTable = this.#db.schema
        .createTable(messagesTableName)
        .ifNotExists()
        .addColumn('tenant', 'varchar(100)', (col) => col.notNull())
        .addColumn('messageCid', 'varchar(60)', (col) => col.notNull())
        .addColumn('interface', 'varchar(20)')
        .addColumn('method', 'varchar(20)')
        .addColumn('recordId', 'varchar(60)')
        .addColumn('entryId','varchar(60)')
        .addColumn('parentId', 'varchar(60)')
        .addColumn('protocol', 'varchar(200)')
        .addColumn('protocolPath', 'varchar(200)')
        .addColumn('contextId', 'varchar(500)')
        .addColumn('schema', 'varchar(200)')
        .addColumn('author', 'varchar(100)')
        .addColumn('recipient', 'varchar(100)')
        .addColumn('messageTimestamp', 'varchar(30)')
        .addColumn('dateCreated', 'varchar(30)')
        .addColumn('datePublished', 'varchar(30)')
        .addColumn('isLatestBaseState', 'boolean')
        .addColumn('published', 'boolean')
        .addColumn('prune', 'boolean')
        .addColumn('dataFormat', 'varchar(30)')
        .addColumn('dataCid', 'varchar(60)')
        .addColumn('dataSize', 'integer')
        .addColumn('encodedData', 'text') // we optionally store encoded data if it is below a threshold
        .addColumn('attester', 'text')
        .addColumn('permissionGrantId', 'varchar(60)')
        .addColumn('latest', 'text'); // TODO: obsolete, remove once `dwn-sdk-js` tests are updated

      // Add columns that have dialect-specific constraints
      createMessagesTable = this.#dialect.addAutoIncrementingColumn(createMessagesTable, 'id', (col) => col.primaryKey());
      createMessagesTable = this.#dialect.addBlobColumn(createMessagesTable, 'encodedMessageBytes', (col) => col.notNull());
      await createMessagesTable.execute();

      // add indexes to the table
      await this.createIndexes(this.#db, messagesTableName, [
        ['tenant'], // baseline protection to prevent full table scans across all tenants
        ['tenant', 'recordId'], // multiple uses, notably heavily depended by record chain construction for protocol authorization
        ['tenant', 'parentId'], // used to walk down hierarchy of records, use cases include purging of records
        ['tenant', 'protocol', 'published', 'messageTimestamp'], // index used for basically every external query.
        ['tenant', 'interface'], // mainly for fast fetch of ProtocolsConfigure for authorization, not needed if protocol was a DWN Record
        ['tenant', 'contextId', 'messageTimestamp'], // expected to be used for common query pattern
        ['tenant', 'permissionGrantId'], // for deleting grant-authorized messages though pending https://github.com/TBD54566975/dwn-sdk-js/issues/716
        // other potential indexes
        // ['tenant', 'author'],
        // ['tenant', 'recipient'],
        // ['tenant', 'schema', 'dataFormat'],
        // ['tenant', 'dateCreated'],
        // ['tenant', 'datePublished'],
        // ['tenant', 'messageCid'],
        // ['tenant', 'protocolPath'],
      ]);
    }

    // create tags table
    const tagsTableName = 'messageStoreRecordsTags';
    const tagsTableExists = await this.#dialect.hasTable(this.#db, tagsTableName);
    if (!tagsTableExists) {
      let createRecordsTagsTable = this.#db.schema
        .createTable(tagsTableName)
        .ifNotExists()
        .addColumn('tag', 'varchar(30)', (col) => col.notNull())
        .addColumn('valueString', 'varchar(200)')
        .addColumn('valueNumber', 'decimal');

      // Add columns that have dialect-specific constraints
      const foreignMessageInsertId = 'messageInsertId';
      createRecordsTagsTable = this.#dialect.addAutoIncrementingColumn(createRecordsTagsTable, 'id', (col) => col.primaryKey());
      createRecordsTagsTable = this.#dialect.addReferencedColumn(createRecordsTagsTable, tagsTableName, foreignMessageInsertId, 'integer', 'messageStoreMessages', 'id', 'cascade');
      await createRecordsTagsTable.execute();

      // add indexes to the table
      await this.createIndexes(this.#db, tagsTableName, [
        [foreignMessageInsertId],
        ['tag', 'valueString'],
        ['tag', 'valueNumber']
      ]);
    }
  }

  /**
   *  Creates indexes on the given table.
   * @param tableName The name of the table to create the indexes on.
   * @param indexes Each inner array represents a single index and contains the column names to be indexed as a composite index.
   *                If the inner array contains only one element, it will be treated as a single column index.
   */
  async createIndexes<T>(database: Kysely<T>, tableName: string, indexes: string[][]): Promise<void> {
    for (const columnNames of indexes) {
      const indexName = 'index_' + columnNames.join('_'); // e.g. index_tenant_protocol
      await database.schema
        .createIndex(indexName)
        // .ifNotExists() // intentionally kept commented out code to show that it is not supported by all dialects (ie. MySQL)
        .on(tableName)
        .columns(columnNames)
        .execute();
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
  ): Promise<void> {
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
      let encodedData: string|null = null;
      if (message.descriptor.interface === DwnInterfaceName.Records && message.descriptor.method === DwnMethodName.Write) {
        const data = (message as any).encodedData as string|undefined;
        if(data) {
          delete (message as any).encodedData;
          encodedData = data;
        }
      }
      return { message, encodedData };
    };

    const { message: messageToProcess, encodedData} = getEncodedData(message);

    const encodedMessageBlock = await executeUnlessAborted(
      block.encode({ value: messageToProcess, codec: cbor, hasher: sha256}),
      options?.signal
    );

    const messageCid = encodedMessageBlock.cid.toString();
    const encodedMessageBytes = Buffer.from(encodedMessageBlock.bytes);

    // we execute the insert in a transaction as we are making multiple inserts into multiple tables.
    // if any of these inserts would throw, the whole transaction would be rolled back.
    // otherwise it is committed.
    const putMessageOperation = this.constructPutMessageOperation({ tenant, messageCid, encodedMessageBytes, encodedData, indexes });
    await executeWithRetryIfDatabaseIsLocked(this.#db, putMessageOperation);
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

    if(pagination?.cursor !== undefined) {
      // currently the sort property is explicitly either `dateCreated` | `messageTimestamp` | `datePublished` which are all strings
      // TODO: https://github.com/TBD54566975/dwn-sdk-js/issues/664 to handle the edge case
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
    query =  query
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
    // https://github.com/TBD54566975/dwn-sdk-js/pull/456
    if (message !== undefined && encodedData !== undefined && encodedData !== null) {
      (message as any).encodedData = encodedData;
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
    if(messageSort?.dateCreated !== undefined)  {
      return  { property: 'dateCreated', direction: messageSort.dateCreated };
    } else if(messageSort?.datePublished !== undefined) {
      return  { property: 'datePublished', direction: messageSort.datePublished };
    } else if (messageSort?.messageTimestamp !== undefined) {
      return  { property: 'messageTimestamp', direction: messageSort.messageTimestamp };
    } else {
      return  { property: 'messageTimestamp', direction: SortDirection.Ascending };
    }
  }
}