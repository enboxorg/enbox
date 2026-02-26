/**
 * A protocol-scoped API returned by {@link Web5.using}.
 *
 * `TypedWeb5` is the **primary developer interface** for interacting with
 * protocol-backed records. It auto-injects the protocol URI, protocolPath,
 * and schema into every operation, and provides compile-time path
 * autocompletion plus typed data payloads via the schema map.
 *
 * All record-returning methods wrap the underlying `Record` instances in
 * {@link TypedRecord} so that type information flows through reads, queries,
 * updates, and subscriptions without manual casts.
 *
 * @example
 * ```ts
 * const social = web5.using(SocialProtocol);
 *
 * // Install the protocol
 * await social.configure();
 *
 * // Create — path and data type are checked at compile time
 * const { record } = await social.records.create('thread', {
 *   data: { title: 'Hello World', body: '...' },
 * });
 * // record is TypedRecord<ThreadData>
 *
 * const data = await record.data.json(); // ThreadData — no cast needed
 *
 * // Query — protocol and protocolPath are auto-injected
 * const { records } = await social.records.query('thread');
 * // records is TypedRecord<ThreadData>[]
 *
 * // Subscribe — real-time changes via TypedLiveQuery
 * const { liveQuery } = await social.records.subscribe('thread/reply');
 * liveQuery.on('create', (record) => {
 *   // record is TypedRecord<ReplyData>
 * });
 * ```
 */

import type { DwnApi } from './dwn-api.js';
import type { Protocol } from './protocol.js';

import type { DateSort, ProtocolDefinition, ProtocolType, RecordsFilter } from '@enbox/dwn-sdk-js';
import type { DwnPaginationCursor, DwnResponseStatus } from '@enbox/agent';
import type { ProtocolPaths, SchemaMap, TypedProtocol, TypeNameAtPath } from './protocol-types.js';

import { TypedLiveQuery } from './typed-live-query.js';
import { TypedRecord } from './typed-record.js';

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/**
 * Resolves the TypeScript data type for a given protocol path.
 *
 * If the schema map contains a mapping for the type name at the given path,
 * that type is returned. Otherwise falls back to `unknown`.
 */
export type DataForPath<
  _D extends ProtocolDefinition,
  M extends SchemaMap,
  Path extends string,
> = TypeNameAtPath<Path> extends keyof M ? M[TypeNameAtPath<Path>] : unknown;

/**
 * Resolves the `ProtocolType` entry for a given protocol path.
 */
type ProtocolTypeForPath<
  D extends ProtocolDefinition,
  Path extends string,
> = TypeNameAtPath<Path> extends keyof D['types']
  ? D['types'][TypeNameAtPath<Path>] extends ProtocolType
    ? D['types'][TypeNameAtPath<Path>]
    : undefined
  : undefined;

/**
 * Resolves a `dataFormat` string literal union for a path, or `string` if none.
 */
type DataFormatForPath<
  D extends ProtocolDefinition,
  Path extends string,
> = ProtocolTypeForPath<D, Path> extends { dataFormats: infer F }
  ? F extends readonly string[]
    ? F[number]
    : string
  : string;

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

/**
 * Options for {@link TypedWeb5} `records.create()`.
 *
 * The `data` field is type-checked against the protocol's schema map for
 * the given path, providing compile-time safety for record payloads.
 *
 * @typeParam D - The protocol definition type.
 * @typeParam M - The schema map mapping type names to TypeScript types.
 * @typeParam Path - The protocol path string literal.
 *
 * @example
 * ```ts
 * await proto.records.create('notebook/page', {
 *   data: { title: 'My Page', body: '...' },       // type-checked as PageData
 *   parentContextId: notebook.contextId,             // link to parent
 *   tags: { category: 'draft' },
 * });
 * ```
 */
export type TypedCreateRequest<
  D extends ProtocolDefinition,
  M extends SchemaMap,
  Path extends string,
> = {
  /** The data payload. Type-checked against the schema map for the given path. */
  data: DataForPath<D, M, Path>;

  /**
   * The context ID of the parent record.
   *
   * Required when creating a child record under a parent in a hierarchical
   * protocol structure. Use the parent record's {@link TypedRecord.contextId | contextId}
   * as this value.
   *
   * @example
   * ```ts
   * const { record: notebook } = await proto.records.create('notebook', {
   *   data: { name: 'My Notebook' },
   * });
   *
   * // Create a page under the notebook
   * await proto.records.create('notebook/page', {
   *   data: { title: 'Page 1' },
   *   parentContextId: notebook.contextId,
   * });
   * ```
   */
  parentContextId?: string;

  /**
   * Whether the record should be publicly published.
   *
   * Published records can be read by anyone without authorization.
   */
  published?: boolean;

  /**
   * ISO 8601 timestamp for when the record is considered published.
   * Only meaningful when `published` is `true`.
   */
  datePublished?: string;

  /**
   * The DID of the intended recipient.
   *
   * Sets the recipient for permission-scoped records. The recipient may
   * have special read/write permissions as defined by the protocol's
   * `$actions` rules.
   */
  recipient?: string;

  /**
   * The protocol role under which to create this record.
   *
   * The DWN will verify that the author is authorized to write under
   * this role per the protocol's `$actions` configuration.
   */
  protocolRole?: string;

  /**
   * The MIME type / data format for the record.
   *
   * If omitted, defaults to the first entry in the protocol type's
   * `dataFormats` array (typically `'application/json'`).
   */
  dataFormat?: DataFormatForPath<D, Path>;

  /**
   * Key-value metadata tags to attach to the record.
   *
   * Tags are indexed by the DWN and can be used in query filters for
   * efficient lookups. Values can be strings, numbers, booleans, or
   * arrays of strings/numbers.
   */
  tags?: globalThis.Record<string, string | number | boolean | string[] | number[]>;

  /**
   * Whether to persist the record to the local DWN immediately.
   *
   * Defaults to `true`. Set to `false` to create the record in memory
   * only — you can call {@link TypedRecord.store | record.store()} later.
   */
  store?: boolean;

  /**
   * Whether to auto-encrypt the record.
   *
   * If omitted, encryption follows the protocol definition. Set to `true`
   * to force encryption or `false` to skip it.
   */
  encryption?: boolean;
};

/**
 * Response from {@link TypedWeb5} `records.create()`.
 *
 * Uses a discriminated union so that TypeScript narrows `record` to
 * `TypedRecord<T>` after a `status.code` check:
 *
 * ```ts
 * const result = await proto.records.create('notebook', { data });
 * if (result.record) {
 *   // TypeScript knows `record` is TypedRecord<NotebookData> here
 *   console.log(result.record.id);
 * }
 * ```
 *
 * @typeParam T - The data type of the created record.
 */
export type TypedCreateResponse<T = unknown> =
  | (DwnResponseStatus & { record: TypedRecord<T> })
  | (DwnResponseStatus & { record: undefined });

/**
 * Filter options for {@link TypedWeb5} `records.query()` and `records.subscribe()`.
 *
 * The `protocol`, `protocolPath`, and `schema` fields are automatically
 * injected by {@link TypedWeb5} — you only need to supply additional
 * filter criteria.
 *
 * Common filter fields inherited from `RecordsFilter`:
 *
 * - **`parentId`** — Filter by parent context ID. Despite the name, this
 *   filters on the parent record's **context ID** (i.e. pass
 *   `parent.contextId`, not `parent.id`). Use this to find child records
 *   under a specific parent in a hierarchical protocol.
 * - **`recordId`** — Match a specific record by its unique ID.
 * - **`recipient`** — Filter by recipient DID.
 * - **`dataFormat`** — Filter by MIME type.
 * - **`dateCreated`** — Range filter on creation date.
 * - **`contextId`** — Filter by context ID directly.
 *
 * @example
 * ```ts
 * // Find pages under a specific notebook
 * const { records } = await proto.records.query('notebook/page', {
 *   filter: {
 *     parentId: notebook.contextId,  // filters by parent's context ID
 *     tags: { status: 'published' },
 *   },
 * });
 * ```
 */
export type TypedQueryFilter = Omit<RecordsFilter, 'protocol' | 'protocolPath' | 'schema'> & {
  /**
   * Filter records by tag values.
   *
   * Only records whose tags match **all** specified key-value pairs are
   * returned. Array values match if the record's tag contains any of the
   * specified values.
   */
  tags?: globalThis.Record<string, string | number | boolean | (string | number)[]>;
  /** Alias for `parentId` — filters records by parent context ID. */
  parentContextId?: string;
};

/**
 * Options for {@link TypedWeb5} `records.query()`.
 *
 * All fields are optional — calling `query(path)` with no request object
 * returns all records at that path.
 *
 * @example
 * ```ts
 * const { records, cursor } = await proto.records.query('notebook', {
 *   filter: { tags: { archived: false } },
 *   dateSort: DateSort.CreatedDescending,
 *   pagination: { limit: 25 },
 * });
 *
 * // Paginate for more
 * if (cursor) {
 *   const { records: next } = await proto.records.query('notebook', {
 *     pagination: { limit: 25, cursor },
 *   });
 * }
 * ```
 */
export type TypedQueryRequest = {
  /**
   * A remote DWN DID to query from.
   *
   * When set, the query is sent to the specified DID's remote DWN instead
   * of the local DWN.
   */
  from?: string;

  /**
   * Filter criteria for the query.
   *
   * The `protocol`, `protocolPath`, and `schema` fields are auto-injected.
   * See {@link TypedQueryFilter} for available filter fields.
   */
  filter?: TypedQueryFilter;

  /**
   * Sort order for the returned records.
   *
   * Use `DateSort.CreatedAscending`, `DateSort.CreatedDescending`,
   * `DateSort.PublishedAscending`, or `DateSort.PublishedDescending`.
   */
  dateSort?: DateSort;

  /**
   * Pagination options.
   *
   * - `limit` — Maximum number of records to return.
   * - `cursor` — A pagination cursor from a previous query response to
   *   resume from where the last page left off.
   */
  pagination?: { limit?: number; cursor?: DwnPaginationCursor };

  /**
   * The protocol role under which to execute the query.
   *
   * Required when the protocol's `$actions` rules restrict read access
   * to specific roles.
   */
  protocolRole?: string;

  /**
   * When `true`, automatically decrypts encrypted records in the results.
   *
   * If omitted, encrypted records are returned as-is (data accessors will
   * return encrypted bytes).
   */
  encryption?: boolean;
};

/**
 * Response from {@link TypedWeb5} `records.query()`.
 *
 * @typeParam T - The data type of the queried records.
 */
export type TypedQueryResponse<T = unknown> = DwnResponseStatus & {
  /**
   * The matching records, each wrapped as {@link TypedRecord | TypedRecord<T>}.
   *
   * The array is empty if no records match the filter criteria.
   */
  records: TypedRecord<T>[];

  /**
   * A pagination cursor for fetching the next page of results.
   *
   * Pass this to a subsequent `query()` call's `pagination.cursor` to
   * continue from where this page ended. `undefined` when there are no
   * more results.
   */
  cursor?: DwnPaginationCursor;
};

/**
 * Options for {@link TypedWeb5} `records.read()`.
 *
 * A `filter` is required to identify which record to read. The most common
 * approach is to filter by `recordId`.
 *
 * @example
 * ```ts
 * // Read a specific record by ID
 * const { record } = await proto.records.read('notebook', {
 *   filter: { recordId: notebookId },
 * });
 *
 * // Read from a remote DWN
 * const { record: remote } = await proto.records.read('notebook', {
 *   from: 'did:example:alice',
 *   filter: { recordId: notebookId },
 * });
 * ```
 */
export type TypedReadRequest = {
  /**
   * A remote DWN DID to read from.
   *
   * When set, the read is performed against the specified DID's remote
   * DWN instead of the local DWN.
   */
  from?: string;

  /**
   * Filter to identify the record to read.
   *
   * The `protocol`, `protocolPath`, and `schema` fields are auto-injected.
   * Typically you filter by `recordId` to read a specific record. Other
   * fields from `RecordsFilter` (like `contextId`, `parentId`, `recipient`)
   * are also available.
   */
  filter: Omit<RecordsFilter, 'protocol' | 'protocolPath' | 'schema'> & {
    /** Alias for `parentId` — filters records by parent context ID. */
    parentContextId?: string;
  };

  /**
   * When `true`, automatically decrypts the record if it is encrypted.
   *
   * If omitted, encrypted records are returned as-is.
   */
  encryption?: boolean;
};

/**
 * Response from {@link TypedWeb5} `records.read()`.
 *
 * Uses a discriminated union so that TypeScript narrows `record` to
 * `TypedRecord<T>` after a truthiness check:
 *
 * ```ts
 * const result = await proto.records.read('notebook', { filter: { recordId } });
 * if (result.record) {
 *   const data = await result.record.data.json(); // NotebookData
 * }
 * ```
 *
 * @typeParam T - The data type of the read record.
 */
export type TypedReadResponse<T = unknown> =
  | (DwnResponseStatus & { record: TypedRecord<T> })
  | (DwnResponseStatus & { record: undefined });

/**
 * Options for {@link TypedWeb5} `records.delete()`.
 *
 * @example
 * ```ts
 * const { status } = await proto.records.delete('notebook', {
 *   recordId: notebook.id,
 * });
 * ```
 */
export type TypedDeleteRequest = {
  /**
   * A remote DWN DID to delete from.
   *
   * When set, the delete is performed on the specified DID's remote DWN.
   */
  from?: string;

  /**
   * The unique `recordId` of the record to delete.
   *
   * Use {@link TypedRecord.id | record.id} to obtain this value.
   */
  recordId: string;
};

/**
 * Options for {@link TypedWeb5} `records.subscribe()`.
 *
 * @example
 * ```ts
 * const { liveQuery } = await proto.records.subscribe('notebook/page', {
 *   filter: { parentId: notebook.contextId },
 * });
 *
 * liveQuery.on('create', (record) => {
 *   console.log('New page:', await record.data.json());
 * });
 * ```
 */
export type TypedSubscribeRequest = {
  /**
   * A remote DWN DID to subscribe to.
   *
   * When set, the subscription listens to the specified DID's remote DWN.
   */
  from?: string;

  /**
   * Filter criteria for the subscription.
   *
   * The `protocol`, `protocolPath`, and `schema` fields are auto-injected.
   * See {@link TypedQueryFilter} for available filter fields.
   */
  filter?: TypedQueryFilter;

  /**
   * The protocol role under which to subscribe.
   *
   * Required when the protocol's `$actions` rules restrict read access
   * to specific roles.
   */
  protocolRole?: string;
};

/**
 * Response from {@link TypedWeb5} `records.subscribe()`.
 *
 * @typeParam T - The data type of records in the subscription.
 */
export type TypedSubscribeResponse<T = unknown> = DwnResponseStatus & {
  /**
   * The typed live query instance for receiving real-time record changes.
   *
   * `undefined` if the subscription request failed (check `status.code`).
   * When defined, use `liveQuery.on('create' | 'update' | 'delete', callback)`
   * to react to changes. Call `liveQuery.close()` to stop the subscription.
   */
  liveQuery?: TypedLiveQuery<T>;
};

// ---------------------------------------------------------------------------
// TypedWeb5 class
// ---------------------------------------------------------------------------

/**
 * A protocol-scoped API that auto-injects `protocol`, `protocolPath`, and
 * `schema` into every DWN operation.
 *
 * All record-returning methods wrap results in {@link TypedRecord} so that
 * the data type `T` (resolved from the schema map) flows end-to-end — from
 * write through read, query, update, and subscribe — without manual casts.
 *
 * Obtain an instance via `web5.using(typedProtocol)`.
 *
 * @example
 * ```ts
 * const social = web5.using(SocialProtocol);
 *
 * await social.configure();
 *
 * const { record } = await social.records.create('friend', {
 *   data: { did: 'did:example:alice', alias: 'Alice' },
 * });
 * const data = await record.data.json(); // FriendData — no cast
 *
 * const { records } = await social.records.query('friend', {
 *   filter: { tags: { did: 'did:example:alice' } },
 * });
 * for (const r of records) {
 *   const d = await r.data.json(); // FriendData
 * }
 * ```
 */
export class TypedWeb5<
  D extends ProtocolDefinition = ProtocolDefinition,
  M extends SchemaMap = SchemaMap,
> {
  /** @internal */
  private _dwn: DwnApi;
  /** @internal */
  private _definition: D;
  /** @internal */
  private _configured: boolean = false;
  /** @internal */
  private _ensureReadyPromise: Promise<void> | null = null;
  /** @internal */
  private _validPaths: Set<string>;
  /** @internal */
  private _records?: TypedWeb5<D, M>['records'];

  /**
   * @internal Create a new `TypedWeb5` instance. Use `web5.using(protocol)` instead.
   * @param dwn - The underlying DWN API instance.
   * @param protocol - The typed protocol containing the definition and schema map.
   */
  constructor(dwn: DwnApi, protocol: TypedProtocol<D, M>) {
    this._dwn = dwn;
    this._definition = protocol.definition;
    this._validPaths = collectPaths(this._definition.structure);
  }

  /**
   * The protocol URI string (e.g. `'https://example.com/social'`).
   *
   * This is the globally unique identifier for the protocol and is
   * auto-injected into every record operation.
   */
  public get protocol(): string {
    return this._definition.protocol;
  }

  /**
   * The raw protocol definition object.
   *
   * Contains the full `protocol`, `types`, and `structure` that define
   * the protocol's schema and permission rules.
   */
  public get definition(): D {
    return this._definition;
  }

  /**
   * Configures (installs) this protocol on the local DWN.
   *
   * If the protocol is already installed with an identical definition,
   * this is a no-op and returns the existing protocol with status `200`.
   * If the definition has changed (e.g. new types, modified structure),
   * the protocol is re-configured with the updated definition and returns
   * status `202`.
   *
   * **Must be called before any record operations.** Methods like
   * `records.create()`, `records.query()`, etc. will throw if the protocol
   * has not been configured.
   *
   * @param options - Optional configuration overrides.
   * @param options.encryption - Whether to enable auto-encryption for the
   *   protocol. If omitted, follows the protocol definition defaults.
   * @returns The DWN response status and the installed protocol object.
   *
   * @example
   * ```ts
   * const proto = web5.using(NotebookProtocol);
   *
   * const { status, protocol } = await proto.configure();
   * console.log(status.code); // 202 (first install) or 200 (already installed)
   *
   * // Now you can use records.create(), records.query(), etc.
   * ```
   */
  public async configure(options?: { encryption?: boolean }): Promise<DwnResponseStatus & { protocol?: Protocol }> {
    // Query for an existing installation of this protocol.
    const { protocols } = await this._dwn.protocols.query({
      filter: { protocol: this._definition.protocol },
    });

    // If already installed with the same definition, return it as-is.
    if (protocols.length > 0) {
      const existing = protocols[0];
      if (definitionsEqual(existing.definition, this._definition)) {
        this._configured = true;
        return { status: { code: 200, detail: 'OK' }, protocol: existing };
      }
    }

    // Not installed or definition has changed — configure the new version.
    const result = await this._dwn.protocols.configure({
      definition : this._definition,
      encryption : options?.encryption,
    });

    if (result.status.code === 202) {
      this._configured = true;
    }

    return result;
  }

  /**
   * Whether the protocol has been configured (installed) on the local DWN.
   *
   * Returns `true` after a successful call to {@link TypedWeb5.configure | configure()}.
   * Record operations will throw if this is `false`.
   */
  public get isConfigured(): boolean {
    return this._configured;
  }

  /**
   * Validates that the path is recognized.
   * Throws a descriptive error if the path is not a valid protocol path.
   */
  private _assertValidPath(path: string): void {
    if (!this._validPaths.has(path)) {
      throw new Error(
        `TypedWeb5: invalid protocol path '${path}'. ` +
        `Valid paths are: ${[...this._validPaths].join(', ')}.`,
      );
    }
  }

  /**
   * Ensures the protocol is configured before performing record operations.
   *
   * On first call, queries for an existing protocol installation:
   * - If found with an identical definition → marks as configured.
   * - If found with a different definition → marks as configured but warns
   *   that the local definition differs from the installed one.
   * - If not found → installs the protocol via `protocols.configure()`.
   *
   * Concurrent calls are deduplicated via a shared Promise so the network
   * call only happens once.
   */
  private async _ensureReady(path: string): Promise<void> {
    if (this._configured) {
      this._assertValidPath(path);
      return;
    }

    if (this._ensureReadyPromise === null) {
      this._ensureReadyPromise = this._autoConfigureOnce();
    }

    await this._ensureReadyPromise;
    this._assertValidPath(path);
  }

  /**
   * Performs the one-time auto-configuration check. Called at most once;
   * subsequent calls reuse the same Promise via `_ensureReadyPromise`.
   */
  private async _autoConfigureOnce(): Promise<void> {
    const { protocols } = await this._dwn.protocols.query({
      filter: { protocol: this._definition.protocol },
    });

    if (protocols.length > 0) {
      const existing = protocols[0];
      if (definitionsEqual(existing.definition, this._definition)) {
        this._configured = true;
        return;
      }

      // Installed but definitions differ — allow operations but warn.
      console.warn(
        `TypedWeb5: installed protocol '${this._definition.protocol}' differs from the provided definition. ` +
        'Call configure() to update it.',
      );
      this._configured = true;
      return;
    }

    // Not installed — configure it now.
    const result = await this._dwn.protocols.configure({
      definition: this._definition,
    });

    if (result.status.code === 202) {
      this._configured = true;
    }
  }

  /**
   * Protocol-scoped record operations.
   *
   * Every method auto-injects the `protocol`, `protocolPath`, and `schema`
   * from the protocol definition — you never need to specify them manually.
   * Path parameters provide **compile-time autocompletion** via
   * `ProtocolPaths<D>`, and data types are resolved from the schema map.
   *
   * All methods return {@link TypedRecord} or {@link TypedLiveQuery} instances
   * that carry the resolved data type from the schema map, providing
   * end-to-end type safety.
   *
   * Available methods:
   * - {@link TypedWeb5.records.create | create(path, request)} — Create a new record
   * - {@link TypedWeb5.records.query | query(path, request?)} — Query records with filters
   * - {@link TypedWeb5.records.read | read(path, request)} — Read a single record
   * - {@link TypedWeb5.records.delete | delete(path, request)} — Delete a record by ID
   * - {@link TypedWeb5.records.subscribe | subscribe(path, request?)} — Real-time subscription
   */
  public get records(): {
    create: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request: TypedCreateRequest<D, M, Path>,
    ) => Promise<TypedCreateResponse<DataForPath<D, M, Path>>>;

    query: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request?: TypedQueryRequest,
    ) => Promise<TypedQueryResponse<DataForPath<D, M, Path>>>;

    read: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request: TypedReadRequest,
    ) => Promise<TypedReadResponse<DataForPath<D, M, Path>>>;

    delete: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request: TypedDeleteRequest,
    ) => Promise<DwnResponseStatus>;

    subscribe: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request?: TypedSubscribeRequest,
    ) => Promise<TypedSubscribeResponse<DataForPath<D, M, Path>>>;
    } {
    if (this._records !== undefined) {
      return this._records;
    }

    const cached = {
      /**
       * Create a new record at the given protocol path.
       *
       * The `protocol`, `protocolPath`, and `schema` are auto-injected from
       * the protocol definition. The `data` field is type-checked against
       * the schema map for the given path.
       *
       * @param path - The protocol path (e.g. `'notebook'`, `'notebook/page'`).
       *   Provides compile-time autocompletion for valid paths.
       * @param request - Create options including the typed `data` payload
       *   and optional fields like `parentContextId`, `tags`, `recipient`.
       * @returns A {@link TypedCreateResponse} containing the DWN response
       *   `status` and the created {@link TypedRecord}.
       *
       * @example
       * ```ts
       * const { status, record } = await proto.records.create('notebook', {
       *   data: { name: 'My Notebook' },
       * });
       *
       * // Create a child page under the notebook's context
       * const { record: page } = await proto.records.create('notebook/page', {
       *   data: { title: 'First Page', body: '' },
       *   parentContextId: record.contextId,
       * });
       * ```
       */
      create: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request: TypedCreateRequest<D, M, Path>,
      ): Promise<TypedCreateResponse<DataForPath<D, M, Path>>> => {
        const normalizedPath = normalizePath(path);
        await this._ensureReady(normalizedPath);
        const typeName = lastSegment(normalizedPath);
        const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

        const { status, record } = await this._dwn.records.write({
          data            : request.data,
          store           : request.store,
          encryption      : request.encryption,
          parentContextId : request.parentContextId,
          published       : request.published,
          datePublished   : request.datePublished,
          recipient       : request.recipient,
          protocolRole    : request.protocolRole,
          tags            : request.tags,
          protocol        : this._definition.protocol,
          protocolPath    : normalizedPath,
          ...(typeEntry?.schema !== undefined ? { schema: typeEntry.schema } : {}),
          dataFormat      : request.dataFormat ?? typeEntry?.dataFormats?.[0],
        });

        return {
          status,
          record: record ? new TypedRecord<DataForPath<D, M, Path>>(record) : undefined,
        };
      },

      /**
       * Query records at the given protocol path.
       *
       * Returns all matching records as an array of typed records, with
       * an optional pagination cursor for fetching additional pages.
       *
       * @param path - The protocol path to query (e.g. `'notebook'`,
       *   `'notebook/page'`).
       * @param request - Optional filter, sort, and pagination options.
       *   Omit entirely to return all records at the path.
       * @returns A {@link TypedQueryResponse} containing `status`, `records`
       *   (as {@link TypedRecord | TypedRecord<T>[]}), and an optional
       *   `cursor` for pagination.
       *
       * @example
       * ```ts
       * // Query all notebooks
       * const { records } = await proto.records.query('notebook');
       *
       * // Query pages under a specific notebook
       * const { records: pages } = await proto.records.query('notebook/page', {
       *   filter: { parentId: notebook.contextId },
       * });
       *
       * for (const page of pages) {
       *   const data = await page.data.json(); // PageData
       * }
       *
       * // Paginated query
       * const { records: batch, cursor } = await proto.records.query('notebook', {
       *   pagination: { limit: 10 },
       *   dateSort: DateSort.CreatedDescending,
       * });
       * ```
       */
      query: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request?: TypedQueryRequest,
      ): Promise<TypedQueryResponse<DataForPath<D, M, Path>>> => {
        const normalizedPath = normalizePath(path);
        await this._ensureReady(normalizedPath);
        const typeName = lastSegment(normalizedPath);
        const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

        const queryFilter = mapParentContextId(request?.filter);

        const { status, records, cursor } = await this._dwn.records.query({
          from       : request?.from,
          encryption : request?.encryption,
          filter     : {
            ...queryFilter,
            protocol     : this._definition.protocol,
            protocolPath : normalizedPath,
            ...(typeEntry?.schema !== undefined ? { schema: typeEntry.schema } : {}),
          },
          dateSort     : request?.dateSort,
          pagination   : request?.pagination,
          protocolRole : request?.protocolRole,
        });

        return {
          status,
          records: records.map((r) => new TypedRecord<DataForPath<D, M, Path>>(r)),
          cursor,
        };
      },

      /**
       * Read a single record at the given protocol path.
       *
       * Unlike `query()`, which returns an array, `read()` returns exactly
       * one record. Use `filter.recordId` to target a specific record.
       *
       * @param path - The protocol path to read from.
       * @param request - Read options including a `filter` to identify the
       *   record. See {@link TypedReadRequest} for details.
       * @returns A {@link TypedReadResponse} containing `status` and the
       *   matching {@link TypedRecord}.
       *
       * @example
       * ```ts
       * const { record } = await proto.records.read('notebook', {
       *   filter: { recordId: notebookId },
       * });
       *
       * const data = await record.data.json(); // NotebookData
       * console.log(data.name);
       * ```
       */
      read: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request: TypedReadRequest,
      ): Promise<TypedReadResponse<DataForPath<D, M, Path>>> => {
        const normalizedPath = normalizePath(path);
        await this._ensureReady(normalizedPath);
        const typeName = lastSegment(normalizedPath);
        const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

        const readFilter = mapParentContextId(request.filter);

        const { status, record } = await this._dwn.records.read({
          from       : request.from,
          encryption : request.encryption,
          protocol   : this._definition.protocol,
          filter     : {
            ...readFilter,
            protocol     : this._definition.protocol,
            protocolPath : normalizedPath,
            ...(typeEntry?.schema !== undefined ? { schema: typeEntry.schema } : {}),
          },
        });

        return {
          status,
          record: record ? new TypedRecord<DataForPath<D, M, Path>>(record) : undefined,
        };
      },

      /**
       * Delete a record at the given protocol path.
       *
       * The path is used for protocol validation and permission scoping,
       * while the actual record is identified by `recordId`.
       *
       * @param path - The protocol path (used for permission scoping and
       *   path validation).
       * @param request - Delete options. `recordId` is required; `from` is
       *   optional for remote deletes.
       * @returns The DWN response status.
       *
       * @example
       * ```ts
       * const { status } = await proto.records.delete('notebook', {
       *   recordId: notebook.id,
       * });
       *
       * if (status.code === 202) {
       *   console.log('Notebook deleted');
       * }
       * ```
       */
      delete: async <Path extends ProtocolPaths<D> & string>(
        _path: Path,
        request: TypedDeleteRequest,
      ): Promise<DwnResponseStatus> => {
        await this._ensureReady(normalizePath(_path));
        return this._dwn.records.delete({
          from     : request.from,
          protocol : this._definition.protocol,
          recordId : request.recordId,
        });
      },

      /**
       * Subscribe to real-time changes at the given protocol path.
       *
       * Returns a {@link TypedLiveQuery} that atomically provides an initial
       * snapshot and a real-time stream of deduplicated change events, with
       * all records typed as `TypedRecord<T>`.
       *
       * @param path - The protocol path to subscribe to.
       * @param request - Optional filter and role. Use `filter.parentId`
       *   to scope the subscription to children of a specific parent.
       * @returns A {@link TypedSubscribeResponse} containing `status` and
       *   a {@link TypedLiveQuery} for receiving events.
       *
       * @example
       * ```ts
       * const { liveQuery } = await proto.records.subscribe('notebook/page', {
       *   filter: { parentId: notebook.contextId },
       * });
       *
       * liveQuery.on('create', (record) => {
       *   // record is TypedRecord<PageData>
       *   console.log('New page created');
       * });
       *
       * liveQuery.on('update', (record) => {
       *   const data = await record.data.json(); // PageData
       * });
       *
       * liveQuery.on('delete', (record) => {
       *   console.log('Page deleted:', record.id);
       * });
       *
       * // Stop listening
       * liveQuery.close();
       * ```
       */
      subscribe: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request?: TypedSubscribeRequest,
      ): Promise<TypedSubscribeResponse<DataForPath<D, M, Path>>> => {
        const normalizedPath = normalizePath(path);
        await this._ensureReady(normalizedPath);
        const typeName = lastSegment(normalizedPath);
        const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

        const subFilter = mapParentContextId(request?.filter);

        const { status, liveQuery } = await this._dwn.records.subscribe({
          from   : request?.from,
          filter : {
            ...subFilter,
            protocol     : this._definition.protocol,
            protocolPath : normalizedPath,
            ...(typeEntry?.schema !== undefined ? { schema: typeEntry.schema } : {}),
          },
          protocolRole: request?.protocolRole,
        });

        return {
          status,
          liveQuery: liveQuery ? new TypedLiveQuery<DataForPath<D, M, Path>>(liveQuery) : undefined,
        };
      },
    };

    this._records = cached;
    return cached;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maps the `parentContextId` alias to the underlying `parentId` field
 * expected by the DWN SDK. If both are provided, `parentId` takes precedence.
 * Returns a new object (or `undefined` if the input was `undefined`).
 */
function mapParentContextId<T extends Record<string, unknown>>(
  filter: T | undefined,
): Omit<T, 'parentContextId'> | undefined {
  if (!filter) { return undefined; }
  const { parentContextId, ...rest } = filter as Record<string, unknown>;
  if (parentContextId !== undefined && rest.parentId === undefined) {
    rest.parentId = parentContextId;
  }
  return rest as Omit<T, 'parentContextId'>;
}

/**
 * Compares two protocol definitions for deep equality using deterministic
 * JSON serialization.
 *
 * Keys are sorted recursively so that semantically identical definitions
 * with different key ordering are treated as equal.
 */
function definitionsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Strips leading and trailing slashes from a path.
 *
 * `'friend/'` → `'friend'`, `'/group/member/'` → `'group/member'`.
 */
function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/**
 * Returns the last segment of a slash-delimited path.
 */
function lastSegment(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

/**
 * Recursively collects all valid protocol path strings from a structure object.
 *
 * Given `{ foo: { bar: { $actions: [...] } } }`, returns `Set(['foo', 'foo/bar'])`.
 * Keys starting with `$` are skipped.
 */
function collectPaths(
  structure: Record<string, unknown>,
  prefix: string = '',
): Set<string> {
  const paths = new Set<string>();

  for (const key of Object.keys(structure)) {
    if (key.startsWith('$')) { continue; }

    const fullPath = prefix ? `${prefix}/${key}` : key;
    paths.add(fullPath);

    const child = structure[key];
    if (child !== null && typeof child === 'object') {
      for (const nested of collectPaths(child as Record<string, unknown>, fullPath)) {
        paths.add(nested);
      }
    }
  }

  return paths;
}

/**
 * Deterministic JSON serialization with sorted keys.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }

  const keys = Object.keys(value as globalThis.Record<string, unknown>).sort();
  const pairs = keys.map((key) =>
    JSON.stringify(key) + ':' + stableStringify((value as globalThis.Record<string, unknown>)[key])
  );
  return '{' + pairs.join(',') + '}';
}
