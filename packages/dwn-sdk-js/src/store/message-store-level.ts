
import type { CompoundIndexDefinition } from './index-level.js';
import type {
  EventLogEntry,
  EventLogReadOptions,
  EventLogReadResult,
  ProgressGapInfo,
  ProgressGapReason,
  ProgressToken,
  ReplicationFeedReader,
  WakePublisher,
} from '../types/subscriptions.js';
import type { Filter, KeyValues, PaginationCursor, QueryOptions } from '../types/query-types.js';
import type { GenericMessage, MessageSort, Pagination } from '../types/message-types.js';
import type { LevelDatabase, LevelWrapperBatchOperation } from './level-wrapper.js';
import type { MessageStore, MessageStoreCompleteDataResult, MessageStoreOptions, MessageStorePutResult } from '../types/message-store.js';

import * as block from 'multiformats/block';
import * as cbor from '@ipld/dag-cbor';

import { Cid } from '../utils/cid.js';
import { CID } from 'multiformats/cid';
import { executeUnlessAborted } from '../utils/abort.js';
import { FilterUtility } from '../utils/filter.js';
import { IndexLevel } from './index-level.js';
import { Message } from '../core/message.js';
import { Replication } from '../utils/replication.js';
import { sha256 } from 'multiformats/hashes/sha2';
import { SortDirection } from '../types/query-types.js';
import { createLevelDatabase, LevelWrapper } from './level-wrapper.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';


/**
 * Default compound indexes that cover the most common DWN query patterns.
 * These are automatically registered unless overridden via config.
 *
 * Each compound index enables a single-scan query when the filter matches
 * all equality properties and the sort matches the sort property.
 */
const DEFAULT_COMPOUND_INDEXES: CompoundIndexDefinition[] = [
  {
    // Covers: RecordsQuery with protocol + protocolPath, sorted by messageTimestamp
    // Example: "all chat messages in protocol X, path 'chat/message', sorted by time"
    name         : 'protocol-protocolPath-messageTimestamp',
    properties   : ['protocol', 'protocolPath'],
    sortProperty : 'messageTimestamp',
  },
  {
    // Covers: RecordsQuery with protocol + protocolPath, sorted by dateCreated
    name         : 'protocol-protocolPath-dateCreated',
    properties   : ['protocol', 'protocolPath'],
    sortProperty : 'dateCreated',
  },
  {
    // Covers: RecordsQuery with schema, sorted by messageTimestamp
    // Example: "all records with schema X, sorted by time"
    name         : 'schema-messageTimestamp',
    properties   : ['schema'],
    sortProperty : 'messageTimestamp',
  },
  {
    // Covers: RecordsQuery with schema, sorted by dateCreated
    name         : 'schema-dateCreated',
    properties   : ['schema'],
    sortProperty : 'dateCreated',
  },
  {
    // Covers: RecordsQuery with protocol + contextId, sorted by messageTimestamp
    // Example: "all messages in a specific protocol context (conversation), sorted by time"
    // NOTE: contextId is often a prefix/range filter. Compound indexes only support equality.
    // This index is useful when contextId is an exact match (e.g., root-level context queries).
    name         : 'protocol-contextId-messageTimestamp',
    properties   : ['protocol', 'contextId'],
    sortProperty : 'messageTimestamp',
  },
];

/**
 * Sublevel names under the single Level root. Every mutation touching multiple partitions is
 * committed as one atomic batch on the root, so store↔log divergence is impossible by construction.
 */
const BLOCKS_PARTITION = 'blocks';
const INDEX_PARTITION = 'idx';
const LOG_PARTITION = 'log';
const CID_TO_SEQ_PARTITION = 'cid';
const REDELIVERY_PARTITION = 'redeliver';
const FINGERPRINT_PARTITION = 'fp';
const HEADS_PARTITION = 'heads';
const META_PARTITION = 'meta';

const EPOCH_KEY = 'epoch';
const CURRENT_PARTITIONS = new Set([
  BLOCKS_PARTITION,
  INDEX_PARTITION,
  LOG_PARTITION,
  CID_TO_SEQ_PARTITION,
  REDELIVERY_PARTITION,
  FINGERPRINT_PARTITION,
  HEADS_PARTITION,
  META_PARTITION,
]);

/**
 * The persisted shape of a replication log row (the value at key `log!<tenant>!<paddedSeq>`).
 */
type LogEntryValue = {
  /** The row's sequence number as a decimal string — also encoded in the row key. */
  seq: string;
  /** The CID of the stored message. */
  messageCid: string;
  /** The row's current query indexes (replaced by `updateIndexes`/`completeData`). */
  indexes: KeyValues;
  /**
   * The row's fingerprint-domain membership, computed once from the insert-time indexes and
   * persisted so deletion can fold the fingerprints without recomputing from mutated state.
   */
  fingerprintScopes: string[];
  /** The redelivery stamp position, present only after `completeData` stamped the row. */
  redeliverSeq?: string;
};

/**
 * The partition handles over the single Level root, created once per store instance.
 */
type StorePartitions = {
  /** The root wrapper — all batches execute here. */
  root: LevelWrapper<string>;
  /** Message blocks (binary values), tenant-partitioned: `blocks!<tenant>!<messageCid>`. */
  blocks: LevelWrapper<Uint8Array>;
  /** Replication log rows, tenant-partitioned: `log!<tenant>!<paddedSeq>`. */
  log: LevelWrapper<string>;
  /** messageCid → seq lookup, tenant-partitioned: `cid!<tenant>!<messageCid>`. */
  cidToSeq: LevelWrapper<string>;
  /** Redelivery stamps, tenant-partitioned: `redeliver!<tenant>!<paddedRedeliverSeq>`. */
  redeliveries: LevelWrapper<string>;
  /** Fingerprint domain values, tenant-partitioned: `fp!<tenant>!<domainKey>` → 64-char hex. */
  fingerprints: LevelWrapper<string>;
  /** Per-tenant counter high-water: `heads!<tenant>` → decimal string. */
  heads: LevelWrapper<string>;
  /** Store-level metadata: `meta!epoch` → persisted store generation. */
  meta: LevelWrapper<string>;
};

/**
 * A {@link MessageStore} and {@link ReplicationFeedReader} implementation that works in both the
 * browser and server-side, backed by a SINGLE LevelDB root: message blocks, query indexes, the
 * per-tenant replication log, the cid→seq index, redelivery stamps, fingerprint domains, the
 * tenant counters, and the store epoch are all sublevels of one Level instance, so every mutation
 * commits as one fully atomic batch.
 *
 * A per-tenant async write mutex spans seq assignment through batch write, so commit order equals
 * seq order by construction. Seq assignment is gap-free (a failed batch never persists the head),
 * while the readable log stays sparse after compaction and under filters — readers never assume
 * contiguity.
 */
export class MessageStoreLevel implements MessageStore, ReplicationFeedReader {
  config: MessageStoreLevelConfig;

  private wakePublisher?: WakePublisher;
  private partitionsPromise?: Promise<StorePartitions>;
  private epochPromise?: Promise<string>;
  private readonly writeLocks: Map<string, Promise<void>> = new Map();

  /**
   * @param {MessageStoreLevelConfig} config
   * @param {string} config.location - must be a directory path (relative or absolute) where
   *  LevelDB will store its files, or in browsers, the name of the
   * {@link https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase IDBDatabase} to be opened.
   * @param {CompoundIndexDefinition[]} config.compoundIndexes - compound indexes to register.
   *   Defaults to DEFAULT_COMPOUND_INDEXES which cover the most common DWN query patterns.
   * @param {WakePublisher} config.wakePublisher - optional bus for store-owned wake publication.
   */
  constructor(config: MessageStoreLevelConfig = {}) {
    this.config = {
      location: 'MESSAGESTORE',
      createLevelDatabase,
      ...config
    };

    this.wakePublisher = this.config.wakePublisher;
  }

  /**
   * Injects the wake publisher after construction — supports wiring contexts that require
   * no-arg store constructors (e.g. the dwn-server plugin contract).
   */
  public setWakePublisher(wakePublisher: WakePublisher): void {
    this.wakePublisher = wakePublisher;
  }

  async open(): Promise<void> {
    const partitions = await this.partitions();
    await partitions.root.open();
    await this.assertNoPreSubstrateLayout(partitions);
    await this.getEpoch();
  }

  async close(): Promise<void> {
    if (this.partitionsPromise === undefined) {
      return;
    }

    const partitions = await this.partitionsPromise;
    await partitions.root.close();
  }

  /**
   * Lazily creates the single Level root and its partition handles.
   */
  private async partitions(): Promise<StorePartitions> {
    this.partitionsPromise ??= this.createPartitions().catch((error) => {
      this.partitionsPromise = undefined;
      throw error;
    });
    return this.partitionsPromise;
  }

  private async createPartitions(): Promise<StorePartitions> {
    const location = this.config.location!;
    const db = await this.config.createLevelDatabase!<string>(location, { keyEncoding: 'utf8', valueEncoding: 'utf8' });

    const root = new LevelWrapper<string>(
      { location, createLevelDatabase: this.config.createLevelDatabase, keyEncoding: 'utf8', valueEncoding: 'utf8' },
      db
    );

    // A binary-valued view over the same underlying Level instance — its partitions carry their
    // own value encoding, so block bytes and JSON strings coexist in one atomic batch domain.
    const binaryView = new LevelWrapper<Uint8Array>(
      { location, createLevelDatabase: this.config.createLevelDatabase as never, keyEncoding: 'utf8', valueEncoding: 'binary' },
      db as unknown as LevelDatabase<Uint8Array>
    );

    return {
      root,
      blocks       : await binaryView.partition(BLOCKS_PARTITION),
      log          : await root.partition(LOG_PARTITION),
      cidToSeq     : await root.partition(CID_TO_SEQ_PARTITION),
      redeliveries : await root.partition(REDELIVERY_PARTITION),
      fingerprints : await root.partition(FINGERPRINT_PARTITION),
      heads        : await root.partition(HEADS_PARTITION),
      meta         : await root.partition(META_PARTITION),
    };
  }

  /**
   * The query index over the shared root. Constructed lazily alongside the partitions.
   */
  private indexPromise?: Promise<IndexLevel>;
  private async index(): Promise<IndexLevel> {
    this.indexPromise ??= (async (): Promise<IndexLevel> => {
      const partitions = await this.partitions();
      const indexRoot = await partitions.root.partition(INDEX_PARTITION);
      return new IndexLevel(
        {
          location            : this.config.location!,
          createLevelDatabase : this.config.createLevelDatabase,
          compoundIndexes     : this.config.compoundIndexes ?? DEFAULT_COMPOUND_INDEXES,
        },
        indexRoot
      );
    })().catch((error) => {
      this.indexPromise = undefined;
      throw error;
    });
    return this.indexPromise;
  }

  /**
   * Returns the persisted store epoch, generating and persisting a fresh `crypto.randomUUID()`
   * at first open. Replaced only by `clear()` — a full local reset with no surviving cursors.
   */
  public async epoch(): Promise<string> {
    return this.getEpoch();
  }

  private async getEpoch(): Promise<string> {
    this.epochPromise ??= this.initializeEpoch().catch((error) => {
      this.epochPromise = undefined;
      throw error;
    });
    return this.epochPromise;
  }

  private async initializeEpoch(): Promise<string> {
    const partitions = await this.partitions();
    const existing = await partitions.meta.get(EPOCH_KEY);
    if (existing !== undefined) {
      return existing;
    }

    const freshEpoch = crypto.randomUUID();
    await partitions.meta.put(EPOCH_KEY, freshEpoch);
    return freshEpoch;
  }

  async get(tenant: string, cidString: string, options?: MessageStoreOptions): Promise<GenericMessage | undefined> {
    options?.signal?.throwIfAborted();

    const partitions = await executeUnlessAborted(this.partitions(), options?.signal);
    const tenantBlocks = await executeUnlessAborted(partitions.blocks.partition(tenant), options?.signal);

    const cid = CID.parse(cidString);
    const bytes = await tenantBlocks.get(cid.toString(), options);

    if (!bytes) {
      return undefined;
    }

    const decodedBlock = await executeUnlessAborted(block.decode({ bytes, codec: cbor, hasher: sha256 }), options?.signal);

    const message = decodedBlock.value as GenericMessage;
    return message;
  }

  async query(
    tenant: string,
    filters: Filter[],
    messageSort?: MessageSort,
    pagination?: Pagination,
    options?: MessageStoreOptions
  ): Promise<{ messages: GenericMessage[], cursor?: PaginationCursor}> {
    options?.signal?.throwIfAborted();

    // creates the query options including sorting and pagination.
    // this adds 1 to the limit if provided, that way we can check to see if there are additional results and provide a return cursor.
    const queryOptions = MessageStoreLevel.buildQueryOptions(messageSort, pagination);
    const index = await this.index();
    const results = await index.query(tenant, filters, queryOptions, options);

    let cursor: PaginationCursor | undefined;
    // checks to see if the returned results are greater than the limit, which would indicate additional results.
    if (pagination?.limit !== undefined && pagination.limit < results.length) {
      // has additional records, remove last record and set cursor
      results.splice(-1);

      // set cursor to the last item remaining after the spliced result.
      cursor = IndexLevel.createCursorFromLastArrayItem(results, queryOptions.sortProperty);
    }

    const messages: GenericMessage[] = [];
    for (let i = 0; i < results.length; i++) {
      const { messageCid } = results[i];
      const message = await this.get(tenant, messageCid, options);
      if (message) { messages.push(message); }
    }

    return { messages, cursor };
  }

  async count(
    tenant: string,
    filters: Filter[],
    messageSort?: MessageSort,
    options?: MessageStoreOptions
  ): Promise<number> {
    options?.signal?.throwIfAborted();

    const queryOptions = MessageStoreLevel.buildQueryOptions(messageSort);
    const index = await this.index();
    return index.count(tenant, filters, queryOptions, options);
  }

  /**
   * Builds the IndexLevel QueryOptions object given MessageStore sort and pagination parameters.
   */
  static buildQueryOptions(messageSort: MessageSort = {}, pagination: Pagination = {}): QueryOptions {
    let { limit, cursor } = pagination;
    const { dateCreated, datePublished, messageTimestamp } = messageSort;

    let sortDirection = SortDirection.Ascending; // default
    // `keyof MessageSort` = name of all properties of `MessageSort` defaults to messageTimestamp
    let sortProperty: keyof MessageSort = 'messageTimestamp';

    // set the sort property
    if (dateCreated !== undefined) {
      sortProperty = 'dateCreated';
    } else if (datePublished !== undefined) {
      sortProperty = 'datePublished';
    } else if (messageTimestamp !== undefined) {
      sortProperty = 'messageTimestamp';
    }

    if (messageSort[sortProperty] !== undefined) {
      sortDirection = messageSort[sortProperty]!;
    }

    // we add one more to the limit to determine whether there are additional results and to return a cursor.
    if (limit !== undefined && limit > 0) {
      limit = limit + 1;
    }

    return { sortDirection, sortProperty, limit, cursor };
  }

  async put(
    tenant: string,
    message: GenericMessage,
    indexes: KeyValues,
    options?: MessageStoreOptions
  ): Promise<MessageStorePutResult> {
    options?.signal?.throwIfAborted();

    const partitions = await executeUnlessAborted(this.partitions(), options?.signal);
    const index = await executeUnlessAborted(this.index(), options?.signal);

    const encodedMessageBlock = await executeUnlessAborted(block.encode({ value: message, codec: cbor, hasher: sha256 }), options?.signal);

    // MessageStore data may contain `encodedData` which is not taken into account when calculating the blockCID as it is optional data.
    const messageCid = Cid.parseCid(await Message.getCid(message)).toString();

    return this.withTenantWriteLock(tenant, async () => {
      options?.signal?.throwIfAborted();

      const tenantCidToSeq = await partitions.cidToSeq.partition(tenant);
      const existingSeq = await tenantCidToSeq.get(messageCid, options);
      if (existingSeq !== undefined) {
        // Duplicates mutate nothing and publish no wake.
        return { status: 'duplicate' as const };
      }

      const head = await this.getHead(partitions, tenant);
      const seq = head + 1n;
      const fingerprintScopes = Replication.computeFingerprintScopes(message, indexes);

      const logEntry: LogEntryValue = {
        seq: seq.toString(),
        messageCid,
        indexes,
        fingerprintScopes,
      };

      const tenantBlocks = await partitions.blocks.partition(tenant);
      const blockOperation = tenantBlocks.createOperation({ type: 'put', key: messageCid, value: encodedMessageBlock.bytes });

      const tenantLog = await partitions.log.partition(tenant);
      const operations: LevelWrapperBatchOperation<string>[] = [
        blockOperation as unknown as LevelWrapperBatchOperation<string>,
        ...await index.createPutOperations(tenant, messageCid, indexes),
        tenantLog.createOperation({ type: 'put', key: Replication.encodePositionKey(seq), value: JSON.stringify(logEntry) }),
        tenantCidToSeq.createOperation({ type: 'put', key: messageCid, value: seq.toString() }),
        partitions.heads.createOperation({ type: 'put', key: tenant, value: seq.toString() }),
        ...await this.createFingerprintFoldOperations(partitions, tenant, messageCid, fingerprintScopes),
      ];

      await partitions.root.batch(operations);

      // Store-owned wake, post-commit, for `inserted` only.
      this.publishWake(tenant, seq);

      return {
        status   : 'inserted' as const,
        position : await this.buildToken(tenant, seq, messageCid),
      };
    });
  }

  async updateIndexes(
    tenant: string,
    messageCid: string,
    indexes: KeyValues,
    options?: MessageStoreOptions
  ): Promise<void> {
    options?.signal?.throwIfAborted();

    const partitions = await executeUnlessAborted(this.partitions(), options?.signal);
    const index = await executeUnlessAborted(this.index(), options?.signal);

    await this.withTenantWriteLock(tenant, async () => {
      const { entry, positionKey, tenantLog } = await this.getLogEntryForMutation(
        partitions, tenant, messageCid, DwnErrorCode.MessageStoreUpdateIndexesMessageNotFound
      );

      const storedMessage = await this.readStoredMessage(
        partitions, tenant, messageCid, DwnErrorCode.MessageStoreUpdateIndexesMessageNotFound, options
      );
      Replication.assertFingerprintScopesUntouched(entry.fingerprintScopes, storedMessage, messageCid, indexes);

      // Same row, same seq: indexes replaced; fingerprint scopes carried forward verbatim;
      // never stamps and never touches the fingerprints or the head.
      const updatedEntry: LogEntryValue = { ...entry, indexes };

      const operations: LevelWrapperBatchOperation<string>[] = [
        ...await index.createDeleteOperations(tenant, messageCid),
        ...await index.createPutOperations(tenant, messageCid, indexes),
        tenantLog.createOperation({ type: 'put', key: positionKey, value: JSON.stringify(updatedEntry) }),
      ];

      await partitions.root.batch(operations);
    });
  }

  async updateMessageAndIndexes(
    tenant: string,
    messageCid: string,
    message: GenericMessage,
    indexes: KeyValues,
    options?: MessageStoreOptions
  ): Promise<void> {
    options?.signal?.throwIfAborted();

    const computedMessageCid = Cid.parseCid(await Message.getCid(message)).toString();
    const normalizedMessageCid = Cid.parseCid(messageCid).toString();
    if (computedMessageCid !== normalizedMessageCid) {
      throw new DwnError(
        DwnErrorCode.MessageStoreUpdateMessageAndIndexesCidMismatch,
        `replacement message CID ${computedMessageCid} does not match target CID ${normalizedMessageCid}`
      );
    }

    const partitions = await executeUnlessAborted(this.partitions(), options?.signal);
    const index = await executeUnlessAborted(this.index(), options?.signal);
    const encodedMessageBlock = await executeUnlessAborted(block.encode({ value: message, codec: cbor, hasher: sha256 }), options?.signal);

    await this.withTenantWriteLock(tenant, async () => {
      const { entry, positionKey, tenantLog } = await this.getLogEntryForMutation(
        partitions, tenant, normalizedMessageCid, DwnErrorCode.MessageStoreUpdateMessageAndIndexesMessageNotFound
      );

      Replication.assertFingerprintScopesUntouched(entry.fingerprintScopes, message, normalizedMessageCid, indexes);

      const updatedEntry: LogEntryValue = { ...entry, indexes };

      const tenantBlocks = await partitions.blocks.partition(tenant);
      const blockOperation = tenantBlocks.createOperation({ type: 'put', key: normalizedMessageCid, value: encodedMessageBlock.bytes });
      const operations: LevelWrapperBatchOperation<string>[] = [
        blockOperation as unknown as LevelWrapperBatchOperation<string>,
        ...await index.createDeleteOperations(tenant, normalizedMessageCid),
        ...await index.createPutOperations(tenant, normalizedMessageCid, indexes),
        tenantLog.createOperation({ type: 'put', key: positionKey, value: JSON.stringify(updatedEntry) }),
      ];

      await partitions.root.batch(operations);
    });
  }

  async completeData(
    tenant: string,
    messageCid: string,
    indexes: KeyValues,
    encodedData?: string,
    options?: MessageStoreOptions
  ): Promise<MessageStoreCompleteDataResult> {
    options?.signal?.throwIfAborted();

    const partitions = await executeUnlessAborted(this.partitions(), options?.signal);
    const index = await executeUnlessAborted(this.index(), options?.signal);

    return this.withTenantWriteLock(tenant, async () => {
      const { entry, positionKey, tenantLog } = await this.getLogEntryForMutation(
        partitions, tenant, messageCid, DwnErrorCode.MessageStoreCompleteDataMessageNotFound
      );

      if (entry.redeliverSeq !== undefined) {
        throw new DwnError(
          DwnErrorCode.MessageStoreCompleteDataAlreadyStamped,
          `message ${messageCid} is already stamped at position ${entry.redeliverSeq}; the dataless-to-data transition cannot repeat`
        );
      }

      const storedMessage = await this.readStoredMessage(
        partitions, tenant, messageCid, DwnErrorCode.MessageStoreCompleteDataMessageNotFound, options
      );
      Replication.assertFingerprintScopesUntouched(entry.fingerprintScopes, storedMessage, messageCid, indexes);

      // The completion is the one substance mutation whose cause does not append a log row, so it
      // stamps the row for redelivery: same CID, same seq, a second delivery position drawn from
      // the same tenant counter in the same atomic batch. No fingerprint change — the CID set is
      // unchanged.
      const head = await this.getHead(partitions, tenant);
      const redeliverSeq = head + 1n;

      const updatedEntry: LogEntryValue = { ...entry, indexes, redeliverSeq: redeliverSeq.toString() };

      let blockOperations: LevelWrapperBatchOperation<string>[] = [];

      if (encodedData !== undefined) {
        const tenantBlocks = await partitions.blocks.partition(tenant);
        const completedMessage = { ...storedMessage, encodedData };
        const reEncodedBlock = await block.encode({ value: completedMessage, codec: cbor, hasher: sha256 });
        const blockOperation = tenantBlocks.createOperation({ type: 'put', key: messageCid, value: reEncodedBlock.bytes });
        blockOperations = [blockOperation as unknown as LevelWrapperBatchOperation<string>];
      }

      const tenantRedeliveries = await partitions.redeliveries.partition(tenant);
      const operations: LevelWrapperBatchOperation<string>[] = [
        ...blockOperations,
        ...await index.createDeleteOperations(tenant, messageCid),
        ...await index.createPutOperations(tenant, messageCid, indexes),
        tenantLog.createOperation({ type: 'put', key: positionKey, value: JSON.stringify(updatedEntry) }),
        tenantRedeliveries.createOperation({
          type  : 'put',
          key   : Replication.encodePositionKey(redeliverSeq),
          value : JSON.stringify({ seq: entry.seq, messageCid }),
        }),
        partitions.heads.createOperation({ type: 'put', key: tenant, value: redeliverSeq.toString() }),
      ];

      await partitions.root.batch(operations);

      // Store-owned wake, post-commit — the stamp advances the head, so the same forward drain
      // delivers the completed row at a strictly increasing position.
      this.publishWake(tenant, redeliverSeq);

      return { position: await this.buildToken(tenant, redeliverSeq, messageCid) };
    });
  }

  async delete(tenant: string, cidString: string, options?: MessageStoreOptions): Promise<void> {
    options?.signal?.throwIfAborted();

    const partitions = await executeUnlessAborted(this.partitions(), options?.signal);
    const index = await executeUnlessAborted(this.index(), options?.signal);

    const messageCid = CID.parse(cidString).toString();

    await this.withTenantWriteLock(tenant, async () => {
      const tenantCidToSeq = await partitions.cidToSeq.partition(tenant);
      const seqString = await tenantCidToSeq.get(messageCid, options);
      if (seqString === undefined) {
        // Idempotent no-op — the row does not exist.
        return;
      }

      const seq = BigInt(seqString);
      const positionKey = Replication.encodePositionKey(seq);
      const tenantLog = await partitions.log.partition(tenant);
      const serializedEntry = await tenantLog.get(positionKey);
      if (serializedEntry === undefined) {
        throw new DwnError(
          DwnErrorCode.MessageStoreDeleteLogEntryMissing,
          `cid index for tenant ${tenant} points to missing log entry at seq ${seqString} (CID ${messageCid})`
        );
      }

      const entry = JSON.parse(serializedEntry) as LogEntryValue;

      const tenantBlocks = await partitions.blocks.partition(tenant);
      const blockOperation = tenantBlocks.createOperation({ type: 'del', key: messageCid });

      // Removing the row removes both delivery appearances — the stamp lives and dies with it.
      let redeliveryOperations: LevelWrapperBatchOperation<string>[] = [];
      if (entry.redeliverSeq !== undefined) {
        const tenantRedeliveries = await partitions.redeliveries.partition(tenant);
        redeliveryOperations = [tenantRedeliveries.createOperation({ type: 'del', key: Replication.encodePositionKey(BigInt(entry.redeliverSeq)) })];
      }

      // XOR is self-inverse: folding the persisted scopes again removes the row's contribution.
      const operations: LevelWrapperBatchOperation<string>[] = [
        blockOperation as unknown as LevelWrapperBatchOperation<string>,
        ...await index.createDeleteOperations(tenant, messageCid),
        tenantLog.createOperation({ type: 'del', key: positionKey }),
        tenantCidToSeq.createOperation({ type: 'del', key: messageCid }),
        ...redeliveryOperations,
        ...await this.createFingerprintFoldOperations(partitions, tenant, messageCid, entry.fingerprintScopes),
      ];

      await partitions.root.batch(operations);
    });
  }

  /**
   * deletes everything in the underlying store, then persists a fresh epoch — a full local
   * reset after which no previously issued cursor is valid.
   */
  async clear(): Promise<void> {
    const partitions = await this.partitions();
    await partitions.root.clear();

    this.epochPromise = undefined;
    await this.getEpoch();
  }

  // ---------------------------------------------------------------------------
  // ReplicationFeedReader
  // ---------------------------------------------------------------------------

  async logRead(tenant: string, options: EventLogReadOptions = {}): Promise<EventLogReadResult> {
    const partitions = await this.partitions();
    const { cursor, limit, filters } = options;

    // Head-captured-first: the per-tenant write mutex serializes commits in position order, so an
    // observed head H is a visibility barrier — every position <= H is already committed when the
    // range scans below run, and anything committed afterward has a position > H and waits for
    // the next page.
    const head = await this.getHead(partitions, tenant);
    if (cursor !== undefined) {
      await this.validateCursor(partitions, tenant, cursor, head);
    }

    const startPosition = cursor === undefined ? 0n : BigInt(cursor.position);

    if (head === 0n || startPosition >= head) {
      // Nothing to scan — caught up at the input position.
      return { events: [], cursor, drained: true };
    }

    const maxResults = limit ?? Number.MAX_SAFE_INTEGER;
    if (maxResults <= 0) {
      return { events: [], cursor, drained: false };
    }

    const tenantLog = await partitions.log.partition(tenant);
    const tenantRedeliveries = await partitions.redeliveries.partition(tenant);
    const tenantBlocks = await partitions.blocks.partition(tenant);

    const iteratorRange = { gt: Replication.encodePositionKey(startPosition), lte: Replication.encodePositionKey(head) };
    const logIterator = tenantLog.iterator(iteratorRange);
    const redeliveryIterator = tenantRedeliveries.iterator(iteratorRange);

    const events: EventLogEntry[] = [];
    let drained = true;
    let lastScannedPosition = startPosition;
    let lastDeliveredPosition: bigint | undefined;
    let lastDeliveredMessageCid: string | undefined;

    for await (const { position, entry } of this.mergePositionStreams(logIterator, redeliveryIterator, tenantLog)) {
      lastScannedPosition = position;

      const event = await this.readEventFromLogEntry(tenantBlocks, entry, filters);
      if (event === undefined) {
        continue;
      }

      events.push(event);
      lastDeliveredPosition = position;
      lastDeliveredMessageCid = event.messageCid;

      if (events.length >= maxResults) {
        drained = position >= head;
        break;
      }
    }

    // High-water cursor: the highest position scanned — head when the scan completed, the stop
    // position otherwise. `messageCid` is set only when the cursor position is a delivered row.
    const cursorPosition = drained ? head : lastScannedPosition;
    const cursorMessageCid = lastDeliveredPosition === cursorPosition ? lastDeliveredMessageCid : undefined;
    const resultCursor = await this.buildToken(tenant, cursorPosition, cursorMessageCid);

    return { events, cursor: resultCursor, drained };
  }

  private async readEventFromLogEntry(
    tenantBlocks: LevelWrapper<Uint8Array>,
    entry: LogEntryValue | undefined,
    filters: Filter[] | undefined,
  ): Promise<EventLogEntry | undefined> {
    if (entry === undefined) {
      // A redelivery stamp whose row vanished between the head capture and this lookup —
      // deletion removes both appearances, so there is nothing to deliver at this position.
      return undefined;
    }

    if (filters !== undefined && filters.length > 0 && !FilterUtility.matchAnyFilter(entry.indexes, filters)) {
      return undefined;
    }

    const bytes = await tenantBlocks.get(entry.messageCid);
    if (bytes === undefined) {
      // The row was deleted after the head capture; skip — its positions are gone with it.
      return undefined;
    }

    const decodedBlock = await block.decode({ bytes, codec: cbor, hasher: sha256 });
    const message = decodedBlock.value as GenericMessage;
    return {
      seq        : entry.seq, // a redelivered entry carries the row's original seq
      event      : { message },
      indexes    : entry.indexes,
      messageCid : entry.messageCid,
    };
  }

  async logBounds(tenant: string): Promise<{ oldest: ProgressToken; latest: ProgressToken } | undefined> {
    const partitions = await this.partitions();
    const head = await this.getHead(partitions, tenant);
    if (head === 0n) {
      return undefined;
    }

    // The log is the live set — replay from zero is always available, so the oldest resumable
    // position is always 0 regardless of compaction.
    const oldest = await this.buildToken(tenant, 0n);

    // Resolve the head position against either column for the latest token's messageCid.
    const headKey = Replication.encodePositionKey(head);
    const tenantLog = await partitions.log.partition(tenant);
    const tenantRedeliveries = await partitions.redeliveries.partition(tenant);

    let headMessageCid: string | undefined;
    const headLogEntry = await tenantLog.get(headKey);
    if (headLogEntry === undefined) {
      const headRedelivery = await tenantRedeliveries.get(headKey);
      if (headRedelivery !== undefined) {
        headMessageCid = (JSON.parse(headRedelivery) as { seq: string, messageCid: string }).messageCid;
      }
    } else {
      headMessageCid = (JSON.parse(headLogEntry) as LogEntryValue).messageCid;
    }

    const latest = await this.buildToken(tenant, head, headMessageCid);
    return { oldest, latest };
  }

  async fingerprint(tenant: string, scopes: string[]): Promise<string> {
    const partitions = await this.partitions();
    const tenantFingerprints = await partitions.fingerprints.partition(tenant);

    let composed = Replication.emptyFingerprint();
    for (const scope of scopes) {
      const storedHex = await tenantFingerprints.get(MessageStoreLevel.fingerprintKey(scope));
      if (storedHex !== undefined) {
        composed = Replication.xorFingerprint(composed, Replication.hexToFingerprint(storedHex));
      }
    }

    return Replication.fingerprintToHex(composed);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Serializes all log-mutating operations for a tenant: the lock spans seq assignment through
   * batch write, so commit order equals seq order (synchronous assignment alone is insufficient —
   * a later batch could land first).
   */
  private async withTenantWriteLock<T>(tenant: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(tenant) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.writeLocks.set(tenant, current);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.writeLocks.get(tenant) === current) {
        this.writeLocks.delete(tenant);
      }
    }
  }

  /**
   * Reads the tenant's counter high-water (the highest position ever issued), `0n` when unused.
   */
  private async getHead(partitions: StorePartitions, tenant: string): Promise<bigint> {
    const headString = await partitions.heads.get(tenant);
    return headString === undefined ? 0n : BigInt(headString);
  }

  private async assertNoPreSubstrateLayout(partitions: StorePartitions): Promise<void> {
    if (await partitions.meta.get(EPOCH_KEY) !== undefined) {
      return;
    }

    for await (const key of partitions.root.keys()) {
      const partition = MessageStoreLevel.parseSublevelPartition(key);
      if (partition === undefined || CURRENT_PARTITIONS.has(partition)) {
        continue;
      }

      throw new DwnError(
        DwnErrorCode.MessageStorePreSubstrateLayout,
        `message store location ${this.config.location} contains pre-substrate Level data; reset the store before opening it`
      );
    }
  }

  private static parseSublevelPartition(key: string): string | undefined {
    if (!key.startsWith('!')) {
      return undefined;
    }

    const end = key.indexOf('!', 1);
    return end === -1 ? undefined : key.slice(1, end);
  }

  private async readStoredMessage(
    partitions: StorePartitions,
    tenant: string,
    messageCid: string,
    notFoundErrorCode: DwnErrorCode,
    options?: MessageStoreOptions,
  ): Promise<GenericMessage> {
    const tenantBlocks = await partitions.blocks.partition(tenant);
    const bytes = await tenantBlocks.get(messageCid, options);
    if (bytes === undefined) {
      throw new DwnError(notFoundErrorCode, `no message block found for tenant ${tenant} with CID ${messageCid}`);
    }

    const decodedBlock = await block.decode({ bytes, codec: cbor, hasher: sha256 });
    return decodedBlock.value as GenericMessage;
  }

  /**
   * Validates a replication cursor against the tenant stream and persisted store epoch.
   * Throws `EventLogProgressGap` with bounds metadata when the cursor cannot be replayed.
   */
  private async validateCursor(partitions: StorePartitions, tenant: string, cursor: ProgressToken, head: bigint): Promise<void> {
    const expectedStreamId = await Replication.deriveStreamId(tenant);

    const reason = await this.validateCursorPosition(partitions, tenant, cursor, head, expectedStreamId);
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

    const error = new DwnError(
      DwnErrorCode.EventLogProgressGap,
      `progress token gap: ${reason}`
    );
    (error as any).gapInfo = gapInfo;
    throw error;
  }

  private async validateCursorPosition(
    partitions: StorePartitions,
    tenant: string,
    cursor: ProgressToken,
    head: bigint,
    expectedStreamId: string,
  ): Promise<ProgressGapReason | undefined> {
    if (cursor.streamId !== expectedStreamId) {
      return 'stream_mismatch';
    }

    if (cursor.epoch !== await this.getEpoch()) {
      return 'epoch_mismatch';
    }

    const cursorPosition = BigInt(cursor.position);
    if (cursorPosition > head) {
      return 'token_too_new';
    }

    if (cursor.messageCid === undefined) {
      return undefined;
    }

    const positionMessageCid = await this.getMessageCidAtPosition(partitions, tenant, cursorPosition);
    if (positionMessageCid !== undefined && positionMessageCid !== cursor.messageCid) {
      return 'message_mismatch';
    }

    return undefined;
  }

  private async getMessageCidAtPosition(partitions: StorePartitions, tenant: string, position: bigint): Promise<string | undefined> {
    if (position <= 0n) {
      return undefined;
    }

    const positionKey = Replication.encodePositionKey(position);
    const tenantLog = await partitions.log.partition(tenant);
    const serializedEntry = await tenantLog.get(positionKey);
    if (serializedEntry !== undefined) {
      return (JSON.parse(serializedEntry) as LogEntryValue).messageCid;
    }

    const tenantRedeliveries = await partitions.redeliveries.partition(tenant);
    const serializedStamp = await tenantRedeliveries.get(positionKey);
    if (serializedStamp !== undefined) {
      return (JSON.parse(serializedStamp) as { seq: string, messageCid: string }).messageCid;
    }

    return undefined;
  }

  /**
   * Resolves the log row for a same-CID mutation, throwing the given code when no row exists.
   */
  private async getLogEntryForMutation(
    partitions: StorePartitions,
    tenant: string,
    messageCid: string,
    notFoundErrorCode: DwnErrorCode,
  ): Promise<{ entry: LogEntryValue, positionKey: string, tenantLog: LevelWrapper<string> }> {
    const tenantCidToSeq = await partitions.cidToSeq.partition(tenant);
    const seqString = await tenantCidToSeq.get(messageCid);
    if (seqString === undefined) {
      throw new DwnError(notFoundErrorCode, `no message found for tenant ${tenant} with CID ${messageCid}`);
    }

    const positionKey = Replication.encodePositionKey(BigInt(seqString));
    const tenantLog = await partitions.log.partition(tenant);
    const serializedEntry = await tenantLog.get(positionKey);
    if (serializedEntry === undefined) {
      throw new DwnError(notFoundErrorCode, `no log entry found for tenant ${tenant} at seq ${seqString} (CID ${messageCid})`);
    }

    return { entry: JSON.parse(serializedEntry) as LogEntryValue, positionKey, tenantLog };
  }

  /**
   * Creates the batch operations that fold a message CID's contribution into the given
   * fingerprint domains. XOR is self-inverse, so the same operations serve insert and delete.
   */
  private async createFingerprintFoldOperations(
    partitions: StorePartitions,
    tenant: string,
    messageCid: string,
    scopes: string[],
  ): Promise<LevelWrapperBatchOperation<string>[]> {
    const contribution = await Replication.hashMessageCid(messageCid);
    const tenantFingerprints = await partitions.fingerprints.partition(tenant);

    const operations: LevelWrapperBatchOperation<string>[] = [];
    for (const scope of scopes) {
      const key = MessageStoreLevel.fingerprintKey(scope);
      const storedHex = await tenantFingerprints.get(key);
      const current = storedHex === undefined ? Replication.emptyFingerprint() : Replication.hexToFingerprint(storedHex);
      const folded = Replication.xorFingerprint(current, contribution);
      operations.push(tenantFingerprints.createOperation({ type: 'put', key, value: Replication.fingerprintToHex(folded) }));
    }

    return operations;
  }

  /**
   * Encodes a fingerprint domain name as a Level key. The uniform prefix keeps the global
   * domain (the empty string) a valid key.
   */
  private static fingerprintKey(scope: string): string {
    return `d${scope}`;
  }

  /**
   * Merges the seq range and the redelivery range in ascending position order beneath the
   * captured head. Position comparisons are numeric via BigInt, never lexicographic. Yields
   * `entry: undefined` for redelivery stamps whose row disappeared mid-scan.
   */
  private async * mergePositionStreams(
    logIterator: AsyncGenerator<[string, string]>,
    redeliveryIterator: AsyncGenerator<[string, string]>,
    tenantLog: LevelWrapper<string>,
  ): AsyncGenerator<{ position: bigint, entry: LogEntryValue | undefined }> {
    try {
      let logNext = await logIterator.next();
      let redeliveryNext = await redeliveryIterator.next();

      while (!logNext.done || !redeliveryNext.done) {
        let useLogStream: boolean;
        if (logNext.done) {
          useLogStream = false;
        } else if (redeliveryNext.done) {
          useLogStream = true;
        } else {
          const logPosition = BigInt(logNext.value[0]);
          const redeliveryPosition = BigInt(redeliveryNext.value[0]);
          useLogStream = logPosition < redeliveryPosition;
        }

        if (useLogStream) {
          const [positionKey, serializedEntry] = logNext.value!;
          yield { position: BigInt(positionKey), entry: JSON.parse(serializedEntry) as LogEntryValue };
          logNext = await logIterator.next();
        } else {
          const [positionKey, serializedStamp] = redeliveryNext.value!;
          const stamp = JSON.parse(serializedStamp) as { seq: string, messageCid: string };
          const serializedEntry = await tenantLog.get(Replication.encodePositionKey(BigInt(stamp.seq)));
          const entry = serializedEntry === undefined ? undefined : JSON.parse(serializedEntry) as LogEntryValue;
          yield { position: BigInt(positionKey), entry };
          redeliveryNext = await redeliveryIterator.next();
        }
      }
    } finally {
      // Close the underlying Level iterators when the merge is abandoned early (e.g. a row limit
      // breaks out of the consuming loop). Calling return() on an exhausted generator is a no-op.
      await logIterator.return(undefined);
      await redeliveryIterator.return(undefined);
    }
  }

  private async buildToken(tenant: string, position: bigint, messageCid?: string): Promise<ProgressToken> {
    const token: ProgressToken = {
      streamId : await Replication.deriveStreamId(tenant),
      epoch    : await this.getEpoch(),
      position : position.toString(),
    };
    if (messageCid !== undefined) {
      token.messageCid = messageCid;
    }
    return token;
  }

  /**
   * Publishes a wake post-commit. Best-effort by contract — never throws into the write path.
   */
  private publishWake(tenant: string, position: bigint): void {
    try {
      this.wakePublisher?.publish({ tenant, seq: position.toString() });
    } catch {
      // A lost wake only delays delivery; consumers' idle re-drain bounds the latency.
    }
  }
}

export type MessageStoreLevelConfig = {
  /**
   * The single directory path (or IndexedDB database name in browsers) backing the whole store —
   * message blocks, query indexes, the replication log, fingerprints, counters, and epoch are all
   * sublevels of one Level instance.
   */
  location?: string,
  createLevelDatabase?: typeof createLevelDatabase,
  compoundIndexes?: CompoundIndexDefinition[],
  wakePublisher?: WakePublisher,
};
