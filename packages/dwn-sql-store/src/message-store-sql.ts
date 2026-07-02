import type { Dialect } from './dialect/dialect.js';
import type { DwnDatabaseType, KeyValues } from './types.js';
import type {
  EventLogEntry,
  EventLogReadOptions,
  EventLogReadResult,
  Filter,
  GenericMessage,
  MessageSort,
  MessageStore,
  MessageStoreOptions,
  MessageStorePutResult,
  Pagination,
  PaginationCursor,
  ProgressGapInfo,
  ProgressGapReason,
  ProgressToken,
  ReplicationFeedReader,
  WakePublisher,
} from '@enbox/dwn-sdk-js';
import type { InsertObject, Kysely, Selectable, Transaction, UpdateObject } from 'kysely';

import * as block from 'multiformats/block';
import * as cbor from '@ipld/dag-cbor';

import { executeWithTransaction } from './utils/transaction.js';
import { extractTagsAndSanitizeIndexes } from './utils/sanitize.js';
import { filterSelectQuery } from './utils/filter.js';
import { sha256 } from 'multiformats/hashes/sha2';
import { TagTables } from './utils/tags.js';
import {
  DwnError,
  DwnErrorCode,
  DwnInterfaceName,
  DwnMethodName,
  executeUnlessAborted,
  Message,
  Replication,
  SortDirection,
} from '@enbox/dwn-sdk-js';
import { isDuplicateKeyError, isMessageCidDuplicateKeyError } from './utils/duplicate-key-error.js';
import { Kysely as KyselyDatabase, sql } from 'kysely';

type MessageStoreSystemColumn =
  'id' |
  'tenant' |
  'messageCid' |
  'encodedMessageBytes' |
  'encodedData' |
  'seq' |
  'fingerprintScopes';
type MessageStoreIndexColumn = Exclude<keyof DwnDatabaseType['messageStoreMessages'], MessageStoreSystemColumn>;
type MessageStoreRow = Selectable<DwnDatabaseType['messageStoreMessages']>;
type MessageStoreExecutor = Kysely<DwnDatabaseType> | Transaction<DwnDatabaseType>;
// Replication positions must be read through these text columns, populated by
// `Dialect.bigIntColumnAsText` (`CAST(... AS CHAR/TEXT)`). Reading the raw bigint columns instead lets
// the MySQL/SQLite drivers narrow them to a JS `number`, truncating positions above 2^53.
type PositionTextColumns = {
  seqText: string | null;
};
type LogRow = MessageStoreRow & PositionTextColumns;

const EPOCH_KEY = 'epoch';

const MESSAGE_STORE_INDEX_COLUMN_COVERAGE = {
  interface         : true,
  method            : true,
  schema            : true,
  dataCid           : true,
  dataSize          : true,
  dateCreated       : true,
  messageTimestamp  : true,
  dataFormat        : true,
  isLatestBaseState : true,
  published         : true,
  author            : true,
  recordId          : true,
  entryId           : true,
  datePublished     : true,
  protocol          : true,
  attester          : true,
  protocolPath      : true,
  recipient         : true,
  contextId         : true,
  parentId          : true,
  permissionGrantId : true,
  prune             : true,
  squash            : true,
  controlClass      : true,
  roleAudienceHash  : true,
  recipientHash     : true,
} as const satisfies Record<MessageStoreIndexColumn, true>;

const MESSAGE_STORE_INDEX_COLUMNS = Object.keys(MESSAGE_STORE_INDEX_COLUMN_COVERAGE) as MessageStoreIndexColumn[];

const NULLED_INDEX_COLUMNS = Object.fromEntries(
  MESSAGE_STORE_INDEX_COLUMNS.map((column) => [column, null])
) as Record<MessageStoreIndexColumn, null>;

const BOOLEAN_INDEX_COLUMNS = new Set<MessageStoreIndexColumn>([
  'isLatestBaseState',
  'published',
  'prune',
  'squash',
]);

/**
 * SQL-backed MessageStore with the durable replication feed embedded in the message table.
 *
 * Every mutating operation that can affect replay state takes the tenant counter lock before it
 * reads or writes row/fingerprint state. This keeps tenant positions gap-free and serializes the
 * fingerprint folds without requiring backend-specific advisory locks.
 */
export class MessageStoreSql implements MessageStore, ReplicationFeedReader {
  readonly #dialect: Dialect;
  readonly #tags: TagTables;
  #db: Kysely<DwnDatabaseType> | null = null;
  #epochPromise?: Promise<string>;
  readonly #streamIdPromises = new Map<string, Promise<string>>();
  #wakePublisher?: WakePublisher;

  public constructor(dialect: Dialect, wakePublisher?: WakePublisher) {
    this.#dialect = dialect;
    this.#tags = new TagTables(dialect);
    this.#wakePublisher = wakePublisher;
  }

  public setWakePublisher(wakePublisher: WakePublisher | undefined): void {
    this.#wakePublisher = wakePublisher;
  }

  public async open(): Promise<void> {
    if (this.#db) {
      return;
    }

    this.#db = new KyselyDatabase<DwnDatabaseType>({ dialect: this.#dialect });

    await this.assertTablesExist();
    await this.assertNoPreSubstrateRows();
    await this.epoch();
  }

  public async close(): Promise<void> {
    await this.#db?.destroy();
    this.#db = null;
    this.#epochPromise = undefined;
    this.#streamIdPromises.clear();
  }

  public async put(
    tenant: string,
    message: GenericMessage,
    indexes: KeyValues,
    options?: MessageStoreOptions
  ): Promise<MessageStorePutResult> {
    const db = this.requireDb('put');
    options?.signal?.throwIfAborted();

    const { messageToStore, encodedData } = MessageStoreSql.detachInlineData(message);
    const encodedMessageBlock = await executeUnlessAborted(
      block.encode({ value: messageToStore, codec: cbor, hasher: sha256 }),
      options?.signal
    );

    const messageCid = encodedMessageBlock.cid.toString();
    const encodedMessageBytes = Buffer.from(encodedMessageBlock.bytes);

    try {
      const position = await executeWithTransaction(db, async (tx) => {
        await this.#dialect.lockReplicationCounter(tx, tenant);

        const existing = await tx
          .selectFrom('messageStoreMessages')
          .select('id')
          .where('tenant', '=', tenant)
          .where('messageCid', '=', messageCid)
          .executeTakeFirst();

        if (existing !== undefined) {
          return undefined;
        }

        const seq = await this.#dialect.incrementReplicationCounter(tx, tenant);
        const projection = await Replication.projectIndexes(message, indexes);
        const { indexes: putIndexes, tags } = extractTagsAndSanitizeIndexes(projection.indexes);

        const messageIndexValues: InsertObject<DwnDatabaseType, 'messageStoreMessages'> = {
          tenant,
          messageCid,
          encodedMessageBytes,
          encodedData,
          seq               : seq.toString(),
          fingerprintScopes : JSON.stringify(projection.fingerprintScopes),
          ...putIndexes,
        };

        const result = await this.#dialect
          .insertThenReturnId(tx, 'messageStoreMessages', messageIndexValues, 'id as insertId')
          .executeTakeFirstOrThrow();

        if (Object.keys(tags).length > 0) {
          await this.#tags.executeTagsInsert(result.insertId, tags, tx);
        }

        await this.foldFingerprints(tx, tenant, messageCid, projection.fingerprintScopes);
        return seq;
      });

      if (position === undefined) {
        return { status: 'duplicate' };
      }

      this.publishWake(tenant, position);
      return {
        status   : 'inserted',
        position : await this.buildToken(tenant, position, messageCid),
      };
    } catch (error: unknown) {
      if (isMessageCidDuplicateKeyError(error) && await this.hasMessage(tenant, messageCid)) {
        return { status: 'duplicate' };
      }
      throw error;
    }
  }

  public async get(
    tenant: string,
    cid: string,
    options?: MessageStoreOptions
  ): Promise<GenericMessage | undefined> {
    const db = this.requireDb('get');
    options?.signal?.throwIfAborted();

    const result = await executeUnlessAborted(
      db
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

  public async query(
    tenant: string,
    filters: Filter[],
    messageSort?: MessageSort,
    pagination?: Pagination,
    options?: MessageStoreOptions
  ): Promise<{ messages: GenericMessage[], cursor?: PaginationCursor }> {
    const db = this.requireDb('query');
    options?.signal?.throwIfAborted();

    const { property: sortProperty, direction: sortDirection } = this.extractSortProperties(messageSort);

    let query = db
      .selectFrom('messageStoreMessages')
      .select('messageCid')
      .distinct()
      .select([
        'encodedMessageBytes',
        'encodedData',
        sortProperty,
      ])
      .where('tenant', '=', tenant);

    query = filterSelectQuery(filters, query);

    if (pagination?.cursor !== undefined) {
      const cursorValue = pagination.cursor.value as string;
      const cursorMessageId = pagination.cursor.messageCid;

      query = query.where(({ eb, refTuple, tuple }) => {
        const direction = sortDirection === SortDirection.Ascending ? '>' : '<';
        return eb(refTuple(sortProperty, 'messageCid'), direction, tuple(cursorValue, cursorMessageId));
      });
    }

    const orderDirection = sortDirection === SortDirection.Ascending ? 'asc' : 'desc';
    query = query
      .orderBy(sortProperty, orderDirection)
      .orderBy('messageCid', orderDirection);

    if (pagination?.limit !== undefined && pagination?.limit > 0) {
      query = query.limit(pagination.limit + 1);
    }

    const results = await executeUnlessAborted(
      query.execute(),
      options?.signal
    );

    return this.processPaginationResults(results, sortProperty, pagination?.limit, options);
  }

  public async count(
    tenant: string,
    filters: Filter[],
    messageSort?: MessageSort,
    options?: MessageStoreOptions
  ): Promise<number> {
    const db = this.requireDb('count');
    options?.signal?.throwIfAborted();

    let query = db
      .selectFrom('messageStoreMessages')
      .select(sql<number>`count(distinct ${sql.ref('messageStoreMessages.messageCid')})`.as('count'))
      .where('tenant', '=', tenant);

    query = filterSelectQuery(filters, query);

    const result = await executeUnlessAborted(query.executeTakeFirstOrThrow(), options?.signal);

    return Number(result.count);
  }

  public async updateIndexes(
    tenant: string,
    messageCid: string,
    indexes: KeyValues,
    options?: MessageStoreOptions
  ): Promise<void> {
    this.requireDb('updateIndexes');
    options?.signal?.throwIfAborted();

    await this.replaceRowIndexes({
      tenant,
      messageCid,
      indexes,
      notFoundErrorCode: DwnErrorCode.MessageStoreUpdateIndexesMessageNotFound,
    });
  }

  public async updateMessageAndIndexes(
    tenant: string,
    messageCid: string,
    message: GenericMessage,
    indexes: KeyValues,
    options?: MessageStoreOptions
  ): Promise<void> {
    this.requireDb('updateMessageAndIndexes');
    options?.signal?.throwIfAborted();

    const computedMessageCid = await Message.getCid(message);
    if (computedMessageCid !== messageCid) {
      throw new DwnError(
        DwnErrorCode.MessageStoreUpdateMessageAndIndexesCidMismatch,
        `replacement message CID ${computedMessageCid} does not match target CID ${messageCid}`
      );
    }

    const { messageToStore, encodedData } = MessageStoreSql.detachInlineData(message);
    const encodedMessageBlock = await executeUnlessAborted(
      block.encode({ value: messageToStore, codec: cbor, hasher: sha256 }),
      options?.signal
    );

    await this.replaceRowIndexes({
      tenant,
      messageCid,
      indexes,
      messageForScopeCheck : message,
      encodedMessageBytes  : Buffer.from(encodedMessageBlock.bytes),
      encodedData,
      notFoundErrorCode    : DwnErrorCode.MessageStoreUpdateMessageAndIndexesMessageNotFound,
    });
  }

  public async delete(
    tenant: string,
    cid: string,
    options?: MessageStoreOptions
  ): Promise<void> {
    const db = this.requireDb('delete');
    options?.signal?.throwIfAborted();
    if (options?.signal?.aborted === true) {
      throw options.signal.reason;
    }

    await executeUnlessAborted(
      executeWithTransaction(db, async (tx) => {
        await this.#dialect.lockReplicationCounter(tx, tenant);

        const row = await tx
          .selectFrom('messageStoreMessages')
          .select(['id', 'messageCid', 'fingerprintScopes'])
          .where('tenant', '=', tenant)
          .where('messageCid', '=', cid)
          .executeTakeFirst();

        if (row === undefined) {
          return;
        }

        await tx
          .deleteFrom('messageStoreMessages')
          .where('id', '=', row.id)
          .execute();

        await this.foldFingerprints(tx, tenant, row.messageCid, MessageStoreSql.parseFingerprintScopes(row.fingerprintScopes, row.messageCid));
      }),
      options?.signal
    );
  }

  /**
   * Deletes all message-store rows and rotates the replication epoch. This invalidates all cursors
   * issued before the reset.
   */
  public async clear(): Promise<void> {
    const db = this.requireDb('clear');

    await executeWithTransaction(db, async (tx) => {
      await tx
        .deleteFrom('messageStoreRecordsTags')
        .execute();

      await tx
        .deleteFrom('messageStoreMessages')
        .execute();

      await tx
        .deleteFrom('replicationCounters')
        .execute();

      await tx
        .deleteFrom('replicationFingerprints')
        .execute();

      await tx
        .deleteFrom('replicationMeta')
        .execute();
    });

    this.#epochPromise = undefined;
    await this.epoch();
  }

  public async logRead(tenant: string, options: EventLogReadOptions = {}): Promise<EventLogReadResult> {
    const db = this.requireDb('logRead');
    const { cursor, limit, filters } = options;

    const head = await this.getHead(db, tenant);
    if (cursor !== undefined) {
      await this.validateCursor(tenant, cursor, head);
    }

    const startPosition = cursor === undefined ? 0n : BigInt(cursor.position);

    if (head === 0n) {
      return { events: [], cursor, drained: true };
    }

    const maxResults = limit ?? Number.MAX_SAFE_INTEGER;
    if (maxResults <= 0) {
      return { events: [], cursor, drained: startPosition >= head };
    }

    if (startPosition >= head) {
      return { events: [], cursor, drained: true };
    }

    const rows = await this.selectLogRows(db, tenant, startPosition, head, filters, maxResults);
    const events = await this.buildEventEntries(db, rows);
    const lastDelivered = events.at(-1);
    const lastDeliveredPosition = lastDelivered === undefined ? undefined : BigInt(lastDelivered.position ?? lastDelivered.seq);
    const lastScannedPosition = rows.at(-1)?.position ?? startPosition;
    const drained = events.length < maxResults || lastScannedPosition >= head;
    const cursorPosition = drained ? head : lastScannedPosition;
    const cursorMessageCid = lastDeliveredPosition === cursorPosition ? lastDelivered?.messageCid : undefined;

    return {
      events,
      cursor: await this.buildToken(tenant, cursorPosition, cursorMessageCid),
      drained,
    };
  }

  public async logBounds(tenant: string): Promise<{ oldest: ProgressToken; latest: ProgressToken } | undefined> {
    const db = this.requireDb('logBounds');
    const head = await this.getHead(db, tenant);
    if (head === 0n) {
      return undefined;
    }

    const oldest = await this.buildToken(tenant, 0n);
    const latest = await this.buildToken(tenant, head, await this.getMessageCidAtPosition(tenant, head));

    return { oldest, latest };
  }

  public async fingerprint(tenant: string, scopes: string[]): Promise<string> {
    const db = this.requireDb('fingerprint');

    let composed = Replication.emptyFingerprint();
    for (const scope of scopes) {
      const row = await db
        .selectFrom('replicationFingerprints')
        .select('fingerprint')
        .where('tenant', '=', tenant)
        .where('scope', '=', scope)
        .executeTakeFirst();

      if (row !== undefined) {
        composed = Replication.xorFingerprint(composed, Replication.hexToFingerprint(row.fingerprint));
      }
    }

    return Replication.fingerprintToHex(composed);
  }

  public async epoch(): Promise<string> {
    const db = this.requireDb('epoch');
    this.#epochPromise ??= this.initializeEpoch(db).catch((error) => {
      this.#epochPromise = undefined;
      throw error;
    });
    return this.#epochPromise;
  }

  private async replaceRowIndexes(input: {
    tenant: string;
    messageCid: string;
    indexes: KeyValues;
    encodedMessageBytes?: Buffer;
    encodedData?: string | null;
    messageForScopeCheck?: GenericMessage;
    notFoundErrorCode: DwnErrorCode;
  }): Promise<void> {
    const { tenant, messageCid, indexes, encodedMessageBytes, encodedData, messageForScopeCheck, notFoundErrorCode } = input;
    const db = this.requireDb('replaceRowIndexes');

    await executeWithTransaction(db, async (tx) => {
      await this.#dialect.lockReplicationCounter(tx, tenant);

      const existingRow = await tx
        .selectFrom('messageStoreMessages')
        .selectAll()
        .where('tenant', '=', tenant)
        .where('messageCid', '=', messageCid)
        .executeTakeFirst();

      if (existingRow === undefined) {
        throw new DwnError(notFoundErrorCode, `no message found for tenant ${tenant} with CID ${messageCid}`);
      }

      const message = messageForScopeCheck ?? await this.parseEncodedMessage(existingRow.encodedMessageBytes, existingRow.encodedData);
      const projection = await Replication.projectIndexes(message, indexes);
      Replication.assertFingerprintScopesMatch(
        MessageStoreSql.parseFingerprintScopes(existingRow.fingerprintScopes, messageCid),
        projection.fingerprintScopes,
        messageCid
      );
      const { indexes: replacementIndexes, tags } = extractTagsAndSanitizeIndexes(projection.indexes);

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

      await tx
        .deleteFrom('messageStoreRecordsTags')
        .where('messageInsertId', '=', existingRow.id)
        .execute();

      if (Object.keys(tags).length > 0) {
        await this.#tags.executeTagsInsert(existingRow.id, tags, tx);
      }
    });
  }

  private async selectLogRows(
    executor: MessageStoreExecutor,
    tenant: string,
    startPosition: bigint,
    head: bigint,
    filters: Filter[] | undefined,
    maxResults: number,
  ): Promise<Array<{ row: LogRow; position: bigint }>> {
    let query = executor
      .selectFrom('messageStoreMessages')
      .selectAll('messageStoreMessages')
      .select([
        this.#dialect.bigIntColumnAsText('messageStoreMessages.seq').as('seqText'),
      ])
      .distinct()
      .where('tenant', '=', tenant)
      .where('seq', '>', startPosition.toString())
      .where('seq', '<=', head.toString())
      .orderBy('seq', 'asc');

    if (filters !== undefined && filters.length > 0) {
      query = filterSelectQuery(filters, query);
    }

    if (maxResults < Number.MAX_SAFE_INTEGER) {
      query = query.limit(maxResults);
    }

    const rows = await query.execute() as LogRow[];
    return rows.map((row) => ({
      row,
      position: MessageStoreSql.requirePosition(row),
    }));
  }

  private async buildEventEntries(
    executor: MessageStoreExecutor,
    positionedRows: Array<{ row: LogRow; position: bigint }>,
  ): Promise<EventLogEntry[]> {
    const tagMap = await this.fetchTagsByMessageIds(positionedRows.map(({ row }) => row.id), executor);
    const entries: EventLogEntry[] = [];

    for (const { row, position } of positionedRows) {
      const message = await this.parseEncodedMessage(row.encodedMessageBytes, row.encodedData);
      entries.push({
        seq        : MessageStoreSql.requirePosition(row).toString(),
        position   : position.toString(),
        event      : { message },
        indexes    : MessageStoreSql.rowToIndexes(row, tagMap.get(row.id)),
        messageCid : row.messageCid,
      });
    }

    return entries;
  }

  private async fetchTagsByMessageIds(
    messageInsertIds: number[],
    executor: MessageStoreExecutor,
  ): Promise<Map<number, KeyValues>> {
    const tagsByMessageId = new Map<number, KeyValues>();
    if (messageInsertIds.length === 0) {
      return tagsByMessageId;
    }

    const rows = await executor
      .selectFrom('messageStoreRecordsTags')
      .select(['messageInsertId', 'tag', 'valueNumber', 'valueString'])
      .where('messageInsertId', 'in', messageInsertIds)
      .execute();

    for (const row of rows) {
      const tags = tagsByMessageId.get(row.messageInsertId) ?? {};
      const tagValue = row.valueString === null ? Number(row.valueNumber) : row.valueString;
      const existing = tags[row.tag];
      if (existing === undefined) {
        tags[row.tag] = tagValue;
      } else {
        tags[row.tag] = MessageStoreSql.appendTagValue(existing, tagValue);
      }
      tagsByMessageId.set(row.messageInsertId, tags);
    }

    return tagsByMessageId;
  }

  private async foldFingerprints(
    tx: Transaction<DwnDatabaseType>,
    tenant: string,
    messageCid: string,
    scopes: string[],
  ): Promise<void> {
    const contribution = await Replication.hashMessageCid(messageCid);

    for (const scope of scopes) {
      const existing = await tx
        .selectFrom('replicationFingerprints')
        .select('fingerprint')
        .where('tenant', '=', tenant)
        .where('scope', '=', scope)
        .executeTakeFirst();

      const current = existing === undefined ? Replication.emptyFingerprint() : Replication.hexToFingerprint(existing.fingerprint);
      const folded = Replication.fingerprintToHex(Replication.xorFingerprint(current, contribution));

      if (existing === undefined) {
        await tx
          .insertInto('replicationFingerprints')
          .values({ tenant, scope, fingerprint: folded })
          .execute();
      } else {
        await tx
          .updateTable('replicationFingerprints')
          .set({ fingerprint: folded })
          .where('tenant', '=', tenant)
          .where('scope', '=', scope)
          .execute();
      }
    }
  }

  private async validateCursor(tenant: string, cursor: ProgressToken, head: bigint): Promise<void> {
    const expectedStreamId = await Replication.deriveStreamId(tenant);
    const reason = await this.validateCursorPosition(tenant, cursor, head, expectedStreamId);
    if (reason === undefined) {
      return;
    }

    const bounds = await this.logBounds(tenant);
    const gapInfo: ProgressGapInfo = {
      requested       : cursor,
      oldestAvailable : bounds?.oldest ?? cursor,
      latestAvailable : bounds?.latest ?? cursor,
      reason,
    };

    const error = Object.assign(new DwnError(
      DwnErrorCode.EventLogProgressGap,
      `progress token gap: ${reason}`
    ), { gapInfo });
    throw error;
  }

  private async validateCursorPosition(
    tenant: string,
    cursor: ProgressToken,
    head: bigint,
    expectedStreamId: string,
  ): Promise<ProgressGapReason | undefined> {
    if (cursor.streamId !== expectedStreamId) {
      return 'stream_mismatch';
    }

    if (cursor.epoch !== await this.epoch()) {
      return 'epoch_mismatch';
    }

    const cursorPosition = BigInt(cursor.position);
    if (cursorPosition > head) {
      return 'token_too_new';
    }

    if (cursor.messageCid === undefined) {
      return undefined;
    }

    const positionMessageCid = await this.getMessageCidAtPosition(tenant, cursorPosition);
    if (positionMessageCid !== undefined && positionMessageCid !== cursor.messageCid) {
      return 'message_mismatch';
    }

    return undefined;
  }

  private async getMessageCidAtPosition(tenant: string, position: bigint): Promise<string | undefined> {
    if (position <= 0n) {
      return undefined;
    }

    const db = this.requireDb('getMessageCidAtPosition');
    const positionString = position.toString();
    const row = await db
      .selectFrom('messageStoreMessages')
      .select('messageCid')
      .where('tenant', '=', tenant)
      .where('seq', '=', positionString)
      .executeTakeFirst();

    return row?.messageCid;
  }

  private async getHead(executor: MessageStoreExecutor, tenant: string): Promise<bigint> {
    const row = await executor
      .selectFrom('replicationCounters')
      .select(this.#dialect.bigIntColumnAsText('replicationCounters.seq').as('seq'))
      .where('tenant', '=', tenant)
      .executeTakeFirst();

    return row?.seq === undefined || row.seq === null ? 0n : BigInt(row.seq);
  }

  private async hasMessage(tenant: string, messageCid: string): Promise<boolean> {
    const db = this.requireDb('hasMessage');
    const existing = await db
      .selectFrom('messageStoreMessages')
      .select('id')
      .where('tenant', '=', tenant)
      .where('messageCid', '=', messageCid)
      .executeTakeFirst();

    return existing !== undefined;
  }

  private async initializeEpoch(db: Kysely<DwnDatabaseType>): Promise<string> {
    const existing = await db
      .selectFrom('replicationMeta')
      .select('value')
      .where('key', '=', EPOCH_KEY)
      .executeTakeFirst();

    if (existing !== undefined) {
      return existing.value;
    }

    const epoch = crypto.randomUUID();
    try {
      await db
        .insertInto('replicationMeta')
        .values({ key: EPOCH_KEY, value: epoch })
        .execute();
      return epoch;
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      const row = await db
        .selectFrom('replicationMeta')
        .select('value')
        .where('key', '=', EPOCH_KEY)
        .executeTakeFirstOrThrow();

      return row.value;
    }
  }

  private async buildToken(tenant: string, position: bigint, messageCid?: string): Promise<ProgressToken> {
    const token: ProgressToken = {
      streamId : await this.getStreamId(tenant),
      epoch    : await this.epoch(),
      position : position.toString(),
    };

    if (messageCid !== undefined) {
      token.messageCid = messageCid;
    }

    return token;
  }

  private getStreamId(tenant: string): Promise<string> {
    let streamIdPromise = this.#streamIdPromises.get(tenant);
    if (streamIdPromise !== undefined) {
      return streamIdPromise;
    }

    streamIdPromise = Replication.deriveStreamId(tenant);
    this.#streamIdPromises.set(tenant, streamIdPromise);
    return streamIdPromise;
  }

  private publishWake(tenant: string, position: bigint): void {
    try {
      this.#wakePublisher?.publish({ tenant, seq: position.toString() });
    } catch {
      // A lost wake only delays delivery; consumers' idle re-drain bounds the latency.
    }
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
      hasher : sha256,
    });

    const message = decodedBlock.value as GenericMessage;
    if (message !== undefined && encodedData !== undefined && encodedData !== null) {
      message.encodedData = encodedData;
    }
    return message;
  }

  private async processPaginationResults(
    results: any[],
    sortProperty: string,
    limit?: number,
    options?: MessageStoreOptions,
  ): Promise<{ messages: GenericMessage[], cursor?: PaginationCursor }> {
    let cursor: PaginationCursor | undefined;
    if (limit !== undefined && results.length > limit) {
      results = results.slice(0, limit);
      const lastMessage = results.at(-1);
      const cursorValue = lastMessage[sortProperty];
      cursor = { messageCid: lastMessage.messageCid, value: cursorValue };
    }

    const messages: Promise<GenericMessage>[] = results.map(
      (result): Promise<GenericMessage> => this.parseEncodedMessage(result.encodedMessageBytes, result.encodedData, options)
    );
    return { messages: await Promise.all(messages), cursor };
  }

  private extractSortProperties(
    messageSort?: MessageSort
  ): { property: 'dateCreated' | 'datePublished' | 'messageTimestamp', direction: SortDirection } {
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

  private async assertTablesExist(): Promise<void> {
    const tables = [
      'messageStoreMessages',
      'messageStoreRecordsTags',
      'replicationCounters',
      'replicationFingerprints',
      'replicationMeta',
    ] as const;

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

  private async assertNoPreSubstrateRows(): Promise<void> {
    const row = await this.#db!
      .selectFrom('messageStoreMessages')
      .select('messageCid')
      .where(({ eb, or }) => or([
        eb('seq', 'is', null),
        eb('fingerprintScopes', 'is', null),
      ]))
      .executeTakeFirst();

    if (row !== undefined) {
      throw new DwnError(
        DwnErrorCode.MessageStorePreSubstrateLayout,
        'messageStoreMessages contains rows without replication log metadata; reset the SQL store before opening it'
      );
    }
  }

  private requireDb(operation: string): Kysely<DwnDatabaseType> {
    if (!this.#db) {
      throw new Error(
        `Connection to database not open. Call \`open\` before using \`${operation}\`.`
      );
    }

    return this.#db;
  }

  private static detachInlineData(message: GenericMessage): {
    messageToStore: GenericMessage;
    encodedData: string | null;
  } {
    const messageToStore = { ...message };
    let encodedData: string | null = null;

    if (messageToStore.descriptor.interface === DwnInterfaceName.Records && messageToStore.descriptor.method === DwnMethodName.Write) {
      const data = messageToStore.encodedData;
      if (data !== undefined) {
        delete messageToStore.encodedData;
        encodedData = data;
      }
    }

    return { messageToStore, encodedData };
  }

  private static rowToIndexes(row: MessageStoreRow, tags: KeyValues = {}): KeyValues {
    const indexes: KeyValues = {};

    for (const column of MESSAGE_STORE_INDEX_COLUMNS) {
      const value = row[column];
      if (value === null || value === undefined) {
        continue;
      }

      indexes[column] = BOOLEAN_INDEX_COLUMNS.has(column) ? MessageStoreSql.toBooleanIndex(value) : value as string | number;
    }

    for (const [tag, value] of Object.entries(tags)) {
      indexes[`tag.${tag}`] = value;
    }

    return indexes;
  }

  private static toBooleanIndex(value: unknown): boolean {
    return value === true || value === 1 || value === '1';
  }

  private static appendTagValue(
    existing: string | number | boolean | string[] | number[],
    tagValue: string | number,
  ): string[] | number[] {
    if (Array.isArray(existing)) {
      if (existing.every((value) => typeof value === 'number') && typeof tagValue === 'number') {
        return [...existing, tagValue] as number[];
      }

      return [...existing.map(String), String(tagValue)];
    }

    if (typeof existing === 'number' && typeof tagValue === 'number') {
      return [existing, tagValue];
    }

    return [String(existing), String(tagValue)];
  }

  private static requirePosition(row: MessageStoreRow & Partial<PositionTextColumns>): bigint {
    // Prefer the cast text column (BigInt-exact). The raw-column fallback is NOT safe above 2^53 —
    // every position-bearing read (logRead/getHead/increment) selects the `*Text` columns, so the
    // fallback should never carry a real position; it exists only for rows fetched without them.
    const value = row.seqText ?? row.seq;
    if (value === null || value === undefined) {
      throw new DwnError(
        DwnErrorCode.MessageStorePreSubstrateLayout,
        `message ${row.messageCid} is missing replication position seq`
      );
    }

    return BigInt(String(value));
  }

  private static parseFingerprintScopes(scopes: string | null, messageCid: string): string[] {
    if (scopes === null) {
      throw new DwnError(
        DwnErrorCode.MessageStorePreSubstrateLayout,
        `message ${messageCid} is missing persisted fingerprint scopes`
      );
    }

    const parsed = JSON.parse(scopes);
    if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== 'string')) {
      throw new DwnError(
        DwnErrorCode.MessageStoreFingerprintScopeMutation,
        `message ${messageCid} has invalid persisted fingerprint scopes`
      );
    }

    return parsed;
  }
}

export { isDuplicateKeyError, isMessageCidDuplicateKeyError } from './utils/duplicate-key-error.js';
