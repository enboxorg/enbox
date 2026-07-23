
import type { CompoundIndexDefinition, IndexedItem } from './index-level.js';
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
import type {
  MessageStore,
  MessageStoreLatestStateTransition,
  MessageStoreOptions,
  MessageStorePutResult,
  MessageStoreQueryOptions,
  RecordLimitOccupancy,
} from '../types/message-store.js';

import * as block from 'multiformats/block';
import * as cbor from '@ipld/dag-cbor';

import { runWithCrossContextLock } from '@enbox/common';

import { Cid } from '../utils/cid.js';
import { CID } from 'multiformats/cid';
import { executeUnlessAborted } from '../utils/abort.js';
import { IndexLevel } from './index-level.js';
import { Message } from '../core/message.js';
import { Replication } from '../utils/replication.js';
import { sha256 } from 'multiformats/hashes/sha2';
import { SortDirection } from '../types/query-types.js';
import { assertValidSubtreeFilters, FilterUtility } from '../utils/filter.js';
import { createLevelDatabase, LevelWrapper } from './level-wrapper.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';


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
const FINGERPRINT_PARTITION = 'fp';
const HEADS_PARTITION = 'heads';
const META_PARTITION = 'meta';

const EPOCH_KEY = 'epoch';
const RECORD_LIMIT_RAW_PAGE_SIZE = 128;
const RECORD_LIMIT_GROUP_CACHE_SIZE = RECORD_LIMIT_RAW_PAGE_SIZE;
const CURRENT_PARTITIONS = new Set([
  BLOCKS_PARTITION,
  INDEX_PARTITION,
  LOG_PARTITION,
  CID_TO_SEQ_PARTITION,
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
  /** The row's current query indexes (replaced by `updateIndexes`). */
  indexes: KeyValues;
  /**
   * The row's fingerprint-domain membership, computed once from the insert-time indexes and
   * persisted so deletion can fold the fingerprints without recomputing from mutated state.
   */
  fingerprintScopes: string[];
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
  /** Fingerprint domain values, tenant-partitioned: `fp!<tenant>!<domainKey>` → 64-char hex. */
  fingerprints: LevelWrapper<string>;
  /** Per-tenant counter high-water: `heads!<tenant>` → decimal string. */
  heads: LevelWrapper<string>;
  /** Store-level metadata: `meta!epoch` → persisted store generation. */
  meta: LevelWrapper<string>;
};

type RecordLimitPopulationInput = {
  tenant: string;
  filters: Filter[];
  queryOptions: QueryOptions;
  recordLimit: RecordLimitOccupancy;
  options?: MessageStoreQueryOptions;
};

type RecordLimitOccupantInput = {
  tenant: string;
  index: IndexLevel;
  item: IndexedItem;
  candidateFilter: Filter;
  recordLimit: RecordLimitOccupancy;
  groupCutoffs: Map<string, string>;
  options?: MessageStoreQueryOptions;
};

/**
 * A {@link MessageStore} and {@link ReplicationFeedReader} implementation that works in both the
 * browser and server-side, backed by a SINGLE LevelDB root: message blocks, query indexes, the
 * per-tenant replication log, the cid→seq index, fingerprint domains, the tenant counters, and
 * the store epoch are all sublevels of one Level instance, so every mutation commits as one fully
 * atomic batch.
 *
 * A per-tenant cross-context write lock spans seq assignment through batch write, so commit order
 * equals seq order by construction even when browser tabs, workers, or service workers share the
 * same IndexedDB database. Seq assignment is gap-free (a failed batch never persists the head),
 * while the readable log stays sparse after compaction and under filters — readers never assume
 * contiguity.
 */
export class MessageStoreLevel implements MessageStore, ReplicationFeedReader {
  config: MessageStoreLevelConfig;

  private readonly wakePublisher?: WakePublisher;
  private partitionsPromise?: Promise<StorePartitions>;
  private epochPromise?: Promise<string>;

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
    options?: MessageStoreQueryOptions
  ): Promise<{ messages: GenericMessage[], cursor?: PaginationCursor}> {
    options?.signal?.throwIfAborted();

    // creates the query options including sorting and pagination.
    // this adds 1 to the limit if provided, that way we can check to see if there are additional results and provide a return cursor.
    const queryOptions = MessageStoreLevel.buildQueryOptions(messageSort, pagination);
    const index = await this.index();
    const results = options?.recordLimit === undefined
      ? await index.query(tenant, filters, queryOptions, options)
      : await this.collectRecordLimitPopulation({
        tenant,
        filters,
        queryOptions,
        recordLimit: options.recordLimit,
        options,
      });

    let cursor: PaginationCursor | undefined;
    // checks to see if the returned results are greater than the limit, which would indicate additional results.
    if (pagination?.limit !== undefined && pagination.limit < results.length) {
      // has additional records, remove last record and set cursor
      results.splice(-1);

      // set cursor to the last item remaining after the spliced result.
      cursor = IndexLevel.createCursorFromLastArrayItem(results, queryOptions.sortProperty);
    }

    const messages: GenericMessage[] = [];
    for (const result of results) {
      const { messageCid } = result;
      const message = await this.get(tenant, messageCid, options);
      if (message) { messages.push(message); }
    }

    return { messages, cursor };
  }

  async count(
    tenant: string,
    filters: Filter[],
    messageSort?: MessageSort,
    options?: MessageStoreQueryOptions
  ): Promise<number> {
    options?.signal?.throwIfAborted();

    const queryOptions = MessageStoreLevel.buildQueryOptions(messageSort);
    const index = await this.index();
    if (options?.recordLimit === undefined) {
      return index.count(tenant, filters, queryOptions, options);
    }

    let count = 0;
    for await (const _item of this.iterateRecordLimitPopulation({
      tenant,
      filters,
      queryOptions,
      recordLimit: options.recordLimit,
      options,
    })) {
      count++;
    }
    return count;
  }

  /**
   * Materializes one bounded page from the shared record-limit population iterator.
   */
  private async collectRecordLimitPopulation(input: RecordLimitPopulationInput): Promise<IndexedItem[]> {
    const results: IndexedItem[] = [];
    for await (const item of this.iterateRecordLimitPopulation(input)) {
      results.push(item);
    }
    return results;
  }

  /**
   * Streams caller-filtered records in requested order and admits only records
   * inside their direct-parent group's deterministic rank boundary.
   *
   * Raw candidates are fetched into a small page before any parent lookup is
   * opened. This is deliberate: browser-level/IndexedDB cursors must not be
   * held open while another index transaction is awaited.
   */
  private async * iterateRecordLimitPopulation(input: RecordLimitPopulationInput): AsyncGenerator<IndexedItem> {
    const { filters, options, queryOptions, recordLimit, tenant } = input;
    const index = await this.index();
    const candidateFilter = MessageStoreLevel.buildRecordLimitCandidateFilter(recordLimit);
    const groupCutoffs = new Map<string, string>();
    const outputLimit = queryOptions.limit;
    let outputCount = 0;
    let rawCursor = queryOptions.cursor;

    if (outputLimit !== undefined && outputLimit <= 0) {
      return;
    }

    while (true) {
      const rawItems = await index.queryWithBoundedPaging(tenant, filters, {
        ...queryOptions,
        cursor : rawCursor,
        limit  : RECORD_LIMIT_RAW_PAGE_SIZE,
      }, options);
      if (rawItems.length === 0) {
        return;
      }

      for (const item of rawItems) {
        if (await this.isRecordLimitOccupant({
          tenant,
          index,
          item,
          candidateFilter,
          recordLimit,
          groupCutoffs,
          options,
        })) {
          yield item;
          outputCount++;
          if (outputLimit !== undefined && outputCount >= outputLimit) {
            return;
          }
        }
      }

      if (rawItems.length < RECORD_LIMIT_RAW_PAGE_SIZE) {
        return;
      }
      rawCursor = IndexLevel.createCursorFromItem(rawItems.at(-1)!, queryOptions.sortProperty);
    }
  }

  private async isRecordLimitOccupant(input: RecordLimitOccupantInput): Promise<boolean> {
    if (!FilterUtility.matchFilter(input.item.indexes, input.candidateFilter)) {
      return false;
    }

    const indexedParentId = input.item.indexes.parentId;
    if (indexedParentId !== undefined && typeof indexedParentId !== 'string') {
      throw new TypeError(`MessageStoreLevel: record-limit candidate parentId must be a string.`);
    }
    const parentId = indexedParentId as string | undefined;
    const groupKey = parentId === undefined ? 'root' : `parent:${parentId}`;

    let cutoff = input.groupCutoffs.get(groupKey);
    if (cutoff !== undefined) {
      // Refresh insertion order so the fixed-size map acts as a small LRU.
      input.groupCutoffs.delete(groupKey);
      input.groupCutoffs.set(groupKey, cutoff);
    } else {
      cutoff = await input.index.findRecordLimitRankCutoff(
        input.tenant,
        input.candidateFilter,
        parentId,
        input.recordLimit.max,
        input.options,
      );
      if (cutoff === undefined) {
        return false;
      }
      MessageStoreLevel.cacheRecordLimitCutoff(input.groupCutoffs, groupKey, cutoff);
    }

    return IndexLevel.createRecordLimitRankKey(input.item.indexes) <= cutoff;
  }

  private static cacheRecordLimitCutoff(
    cache: Map<string, string>,
    groupKey: string,
    cutoff: string,
  ): void {
    if (cache.size >= RECORD_LIMIT_GROUP_CACHE_SIZE) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }
    cache.set(groupKey, cutoff);
  }

  private static buildRecordLimitCandidateFilter(recordLimit: RecordLimitOccupancy): Filter {
    const filter: Filter = {
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      protocol          : recordLimit.protocol,
      protocolPath      : recordLimit.protocolPath,
    };
    if (recordLimit.contextId !== undefined) {
      filter.contextId = { subtree: recordLimit.contextId };
    }
    return filter;
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

  async commitLatestState(
    tenant: string,
    transition: MessageStoreLatestStateTransition,
    options?: MessageStoreOptions
  ): Promise<MessageStorePutResult> {
    options?.signal?.throwIfAborted();

    const partitions = await executeUnlessAborted(this.partitions(), options?.signal);
    const index = await executeUnlessAborted(this.index(), options?.signal);

    const { message, indexes } = transition.put;
    const encodedMessageBlock = await executeUnlessAborted(block.encode({ value: message, codec: cbor, hasher: sha256 }), options?.signal);
    const messageCid = Cid.parseCid(await Message.getCid(message)).toString();

    // Validate and encode the retained replacements before entering the write lock.
    const retains: { messageCid: string, message: GenericMessage, indexes: KeyValues, blockBytes: Uint8Array }[] = [];
    for (const retain of transition.retains ?? []) {
      const computedMessageCid = Cid.parseCid(await Message.getCid(retain.message)).toString();
      const normalizedMessageCid = Cid.parseCid(retain.messageCid).toString();
      if (computedMessageCid !== normalizedMessageCid) {
        throw new DwnError(
          DwnErrorCode.MessageStoreUpdateMessageAndIndexesCidMismatch,
          `replacement message CID ${computedMessageCid} does not match target CID ${normalizedMessageCid}`
        );
      }

      const encodedRetainBlock = await executeUnlessAborted(block.encode({ value: retain.message, codec: cbor, hasher: sha256 }), options?.signal);
      retains.push({
        messageCid : normalizedMessageCid,
        message    : retain.message,
        indexes    : retain.indexes,
        blockBytes : encodedRetainBlock.bytes,
      });
    }
    const deleteCids = (transition.deletes ?? []).map((cidString): string => CID.parse(cidString).toString());

    return this.withTenantWriteLock(tenant, async () => {
      options?.signal?.throwIfAborted();

      const tenantBlocks = await partitions.blocks.partition(tenant);
      const tenantLog = await partitions.log.partition(tenant);
      const tenantCidToSeq = await partitions.cidToSeq.partition(tenant);

      const operations: LevelWrapperBatchOperation<string>[] = [];
      const fingerprintFolds: { messageCid: string, scopes: string[] }[] = [];

      // The new message insert. A duplicate inserts nothing but still applies the retains and
      // deletes below, so replaying a transition heals one that previously stopped mid-plan.
      const existingSeq = await tenantCidToSeq.get(messageCid, options);
      const inserted = existingSeq === undefined;
      let seq = 0n;
      if (inserted) {
        const head = await this.getHead(partitions, tenant);
        seq = head + 1n;
        const fingerprintScopes = Replication.computeFingerprintScopes(message, indexes);

        const logEntry: LogEntryValue = {
          seq: seq.toString(),
          messageCid,
          indexes,
          fingerprintScopes,
        };

        operations.push(
          tenantBlocks.createOperation({ type: 'put', key: messageCid, value: encodedMessageBlock.bytes }) as unknown as LevelWrapperBatchOperation<string>,
          ...await index.createPutOperations(tenant, messageCid, indexes),
          tenantLog.createOperation({ type: 'put', key: Replication.encodePositionKey(seq), value: JSON.stringify(logEntry) }),
          tenantCidToSeq.createOperation({ type: 'put', key: messageCid, value: seq.toString() }),
          partitions.heads.createOperation({ type: 'put', key: tenant, value: seq.toString() }),
        );
        fingerprintFolds.push({ messageCid, scopes: fingerprintScopes });
      }

      // Retained displaced writes: same-CID in-place replacement, exactly as `updateMessageAndIndexes`.
      for (const retain of retains) {
        const { entry, positionKey } = await this.getLogEntryForMutation(
          partitions, tenant, retain.messageCid, DwnErrorCode.MessageStoreUpdateMessageAndIndexesMessageNotFound
        );
        Replication.assertFingerprintScopesUntouched(entry.fingerprintScopes, retain.message, retain.messageCid, retain.indexes);

        const updatedEntry: LogEntryValue = { ...entry, indexes: retain.indexes };
        operations.push(
          tenantBlocks.createOperation({ type: 'put', key: retain.messageCid, value: retain.blockBytes }) as unknown as LevelWrapperBatchOperation<string>,
          ...await index.createDeleteOperations(tenant, retain.messageCid),
          ...await index.createPutOperations(tenant, retain.messageCid, retain.indexes),
          tenantLog.createOperation({ type: 'put', key: positionKey, value: JSON.stringify(updatedEntry) }),
        );
      }

      // Non-retained displaced rows: full removal, exactly as `delete`. Absent rows are no-ops.
      for (const deleteCid of deleteCids) {
        const seqString = await tenantCidToSeq.get(deleteCid, options);
        if (seqString === undefined) {
          continue;
        }

        const positionKey = Replication.encodePositionKey(BigInt(seqString));
        const serializedEntry = await tenantLog.get(positionKey);
        if (serializedEntry === undefined) {
          throw new DwnError(
            DwnErrorCode.MessageStoreDeleteLogEntryMissing,
            `cid index for tenant ${tenant} points to missing log entry at seq ${seqString} (CID ${deleteCid})`
          );
        }

        const entry = JSON.parse(serializedEntry) as LogEntryValue;
        operations.push(
          tenantBlocks.createOperation({ type: 'del', key: deleteCid }) as unknown as LevelWrapperBatchOperation<string>,
          ...await index.createDeleteOperations(tenant, deleteCid),
          tenantLog.createOperation({ type: 'del', key: positionKey }),
          tenantCidToSeq.createOperation({ type: 'del', key: deleteCid }),
        );
        fingerprintFolds.push({ messageCid: deleteCid, scopes: entry.fingerprintScopes });
      }

      operations.push(...await this.createFingerprintFoldOperationsForMessages(partitions, tenant, fingerprintFolds));

      if (operations.length > 0) {
        await partitions.root.batch(operations);
      }

      if (!inserted) {
        return { status: 'duplicate' as const };
      }

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
      // fingerprints and head stay untouched.
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

      // XOR is self-inverse: folding the persisted scopes again removes the row's contribution.
      const operations: LevelWrapperBatchOperation<string>[] = [
        blockOperation as unknown as LevelWrapperBatchOperation<string>,
        ...await index.createDeleteOperations(tenant, messageCid),
        tenantLog.createOperation({ type: 'del', key: positionKey }),
        tenantCidToSeq.createOperation({ type: 'del', key: messageCid }),
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
    if (filters !== undefined) {
      assertValidSubtreeFilters(filters);
    }

    // Head-captured-first: the per-tenant write lock serializes commits in position order, so an
    // observed head H is a visibility barrier — every position <= H is already committed when the
    // range scans below run, and anything committed afterward has a position > H and waits for
    // the next page.
    const head = await this.getHead(partitions, tenant);
    if (cursor !== undefined) {
      await this.validateCursor(partitions, tenant, cursor, head);
    }

    const startPosition = cursor === undefined ? 0n : BigInt(cursor.position);

    if (head === 0n) {
      // Nothing to scan — caught up at the input position. A caller without a
      // cursor still gets the position-zero anchor so an empty log yields a
      // checkpointable token instead of forcing a rescan on every pass.
      return { events: [], cursor: cursor ?? await this.buildToken(tenant, 0n), drained: true };
    }

    const maxResults = limit ?? Number.MAX_SAFE_INTEGER;
    if (maxResults <= 0) {
      return { events: [], cursor, drained: startPosition >= head };
    }

    if (startPosition >= head) {
      // Nothing to scan — caught up at the input position.
      return { events: [], cursor, drained: true };
    }

    const tenantLog = await partitions.log.partition(tenant);
    const tenantBlocks = await partitions.blocks.partition(tenant);

    const iteratorRange = { gt: Replication.encodePositionKey(startPosition), lte: Replication.encodePositionKey(head) };
    const logIterator = tenantLog.iterator(iteratorRange);

    const events: EventLogEntry[] = [];
    let drained = true;
    let lastScannedPosition = startPosition;
    let lastDeliveredPosition: bigint | undefined;
    let lastDeliveredMessageCid: string | undefined;

    for await (const [positionKey, serializedEntry] of logIterator) {
      const position = BigInt(positionKey);
      lastScannedPosition = position;
      const entry = JSON.parse(serializedEntry) as LogEntryValue;

      const event = await this.readEventFromLogEntry(tenantBlocks, position, entry, filters);
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
    position: bigint,
    entry: LogEntryValue,
    filters: Filter[] | undefined,
  ): Promise<EventLogEntry | undefined> {
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
      seq        : entry.seq,
      position   : position.toString(),
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

    // Resolve the head position for the latest token's messageCid.
    const headKey = Replication.encodePositionKey(head);
    const tenantLog = await partitions.log.partition(tenant);

    let headMessageCid: string | undefined;
    const headLogEntry = await tenantLog.get(headKey);
    if (headLogEntry !== undefined) {
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
    const lockName = `enbox:dwn-message-store:${JSON.stringify([this.config.location!, tenant])}`;
    return runWithCrossContextLock(lockName, task);
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
    return this.createFingerprintFoldOperationsForMessages(partitions, tenant, [{ messageCid, scopes }]);
  }

  /**
   * Creates the batch operations that fold multiple messages' contributions into their fingerprint
   * domains. Contributions targeting the same domain are XOR-combined before the single
   * read-fold-write per domain — concatenating per-message fold operations into one batch would
   * let the last write to a shared domain silently discard the earlier folds.
   */
  private async createFingerprintFoldOperationsForMessages(
    partitions: StorePartitions,
    tenant: string,
    folds: { messageCid: string, scopes: string[] }[],
  ): Promise<LevelWrapperBatchOperation<string>[]> {
    const combinedContributionByKey = new Map<string, Uint8Array>();
    for (const { messageCid, scopes } of folds) {
      const contribution = await Replication.hashMessageCid(messageCid);
      for (const scope of scopes) {
        const key = MessageStoreLevel.fingerprintKey(scope);
        const combined = combinedContributionByKey.get(key);
        combinedContributionByKey.set(key, combined === undefined ? contribution : Replication.xorFingerprint(combined, contribution));
      }
    }

    const tenantFingerprints = await partitions.fingerprints.partition(tenant);
    const operations: LevelWrapperBatchOperation<string>[] = [];
    for (const [key, contribution] of combinedContributionByKey) {
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
