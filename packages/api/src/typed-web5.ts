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

/** Options for {@link TypedWeb5} `records.create()`. */
export type TypedCreateRequest<
  D extends ProtocolDefinition,
  M extends SchemaMap,
  Path extends string,
> = {
  /** The data payload. Type-checked against the schema map. */
  data: DataForPath<D, M, Path>;

  parentContextId?: string;
  published?: boolean;
  datePublished?: string;
  recipient?: string;
  protocolRole?: string;
  dataFormat?: DataFormatForPath<D, Path>;
  tags?: globalThis.Record<string, string | number | boolean | string[] | number[]>;

  /** Whether to persist immediately (defaults to `true`). */
  store?: boolean;

  /** Whether to auto-encrypt (follows protocol definition if omitted). */
  encryption?: boolean;
};

/** Response from {@link TypedWeb5} `records.create()`. */
export type TypedCreateResponse<T = unknown> = DwnResponseStatus & {
  record: TypedRecord<T>;
};

/** Filter options for {@link TypedWeb5} `records.query()`. */
export type TypedQueryFilter = Omit<RecordsFilter, 'protocol' | 'protocolPath' | 'schema'> & {
  tags?: globalThis.Record<string, string | number | boolean | (string | number)[]>;
};

/** Options for {@link TypedWeb5} `records.query()`. */
export type TypedQueryRequest = {
  /** Optional remote DWN DID to query from. */
  from?: string;

  /** Query filter (protocol, protocolPath, schema are injected). */
  filter?: TypedQueryFilter;
  dateSort?: DateSort;
  pagination?: { limit?: number; cursor?: DwnPaginationCursor };
  protocolRole?: string;

  /** When true, automatically decrypts encrypted records. */
  encryption?: boolean;
};

/** Response from {@link TypedWeb5} `records.query()`. */
export type TypedQueryResponse<T = unknown> = DwnResponseStatus & {
  records: TypedRecord<T>[];
  cursor?: DwnPaginationCursor;
};

/** Options for {@link TypedWeb5} `records.read()`. */
export type TypedReadRequest = {
  /** Optional remote DWN DID to read from. */
  from?: string;

  /** Filter to identify the record (protocol and protocolPath are injected). */
  filter: Omit<RecordsFilter, 'protocol' | 'protocolPath' | 'schema'>;

  /** When true, automatically decrypts the record. */
  encryption?: boolean;
};

/** Response from {@link TypedWeb5} `records.read()`. */
export type TypedReadResponse<T = unknown> = DwnResponseStatus & {
  record: TypedRecord<T>;
};

/** Options for {@link TypedWeb5} `records.delete()`. */
export type TypedDeleteRequest = {
  /** Optional remote DWN DID to delete from. */
  from?: string;

  /** The `recordId` of the record to delete. */
  recordId: string;
};

/** Options for {@link TypedWeb5} `records.subscribe()`. */
export type TypedSubscribeRequest = {
  /** Optional remote DWN DID to subscribe to. */
  from?: string;

  /** Subscription filter (protocol, protocolPath, schema are injected). */
  filter?: TypedQueryFilter;
  protocolRole?: string;
};

/** Response from {@link TypedWeb5} `records.subscribe()`. */
export type TypedSubscribeResponse<T = unknown> = DwnResponseStatus & {
  /** The typed live query instance, or `undefined` if the request failed. */
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
  private _dwn: DwnApi;
  private _definition: D;
  private _configured: boolean = false;
  private _validPaths: Set<string>;

  constructor(dwn: DwnApi, protocol: TypedProtocol<D, M>) {
    this._dwn = dwn;
    this._definition = protocol.definition;
    this._validPaths = collectPaths(this._definition.structure);
  }

  /** The protocol URI. */
  public get protocol(): string {
    return this._definition.protocol;
  }

  /** The raw protocol definition. */
  public get definition(): D {
    return this._definition;
  }

  /**
   * Configures (installs) this protocol on the local DWN.
   *
   * If the protocol is already installed with an identical definition,
   * this is a no-op and returns the existing protocol. If the definition
   * has changed (e.g. new types, modified structure), the protocol is
   * re-configured with the updated definition.
   *
   * @param options - Optional overrides like `encryption`.
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

  /** Whether the protocol has been configured (installed) on the local DWN. */
  public get isConfigured(): boolean {
    return this._configured;
  }

  /**
   * Validates that the protocol has been configured and that the path is
   * recognized. Throws a descriptive error if either check fails.
   */
  private _assertReady(path: string): void {
    if (!this._configured) {
      throw new Error(
        `TypedWeb5: protocol '${this._definition.protocol}' has not been configured. ` +
        'Call configure() before performing record operations.',
      );
    }

    if (!this._validPaths.has(path)) {
      throw new Error(
        `TypedWeb5: invalid protocol path '${path}'. ` +
        `Valid paths are: ${[...this._validPaths].join(', ')}.`,
      );
    }
  }

  /**
   * Protocol-scoped record operations.
   *
   * Every method auto-injects the protocol URI, protocolPath, and schema
   * from the protocol definition. Path parameters provide compile-time
   * autocompletion via `ProtocolPaths<D>`.
   *
   * All methods return {@link TypedRecord} or {@link TypedLiveQuery} instances
   * that carry the resolved data type from the schema map.
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
    return {
      /**
       * Create a new record at the given protocol path.
       *
       * @param path - The protocol path (e.g. `'friend'`, `'group/member'`).
       * @param request - Create options including typed `data`.
       */
      create: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request: TypedCreateRequest<D, M, Path>,
      ): Promise<TypedCreateResponse<DataForPath<D, M, Path>>> => {
        this._assertReady(path);
        const typeName = lastSegment(path);
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
          protocolPath    : path,
          ...(typeEntry?.schema !== undefined ? { schema: typeEntry.schema } : {}),
          dataFormat      : request.dataFormat ?? typeEntry?.dataFormats?.[0],
        });

        return {
          status,
          record: new TypedRecord<DataForPath<D, M, Path>>(record),
        };
      },

      /**
       * Query records at the given protocol path.
       *
       * @param path - The protocol path to query.
       * @param request - Optional filter, sort, and pagination.
       */
      query: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request?: TypedQueryRequest,
      ): Promise<TypedQueryResponse<DataForPath<D, M, Path>>> => {
        this._assertReady(path);
        const typeName = lastSegment(path);
        const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

        const { status, records, cursor } = await this._dwn.records.query({
          from       : request?.from,
          encryption : request?.encryption,
          filter     : {
            ...request?.filter,
            protocol     : this._definition.protocol,
            protocolPath : path,
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
       * @param path - The protocol path to read from.
       * @param request - Read options including a filter to identify the record.
       */
      read: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request: TypedReadRequest,
      ): Promise<TypedReadResponse<DataForPath<D, M, Path>>> => {
        this._assertReady(path);
        const typeName = lastSegment(path);
        const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

        const { status, record } = await this._dwn.records.read({
          from       : request.from,
          encryption : request.encryption,
          protocol   : this._definition.protocol,
          filter     : {
            ...request.filter,
            protocol     : this._definition.protocol,
            protocolPath : path,
            ...(typeEntry?.schema !== undefined ? { schema: typeEntry.schema } : {}),
          },
        });

        return {
          status,
          record: new TypedRecord<DataForPath<D, M, Path>>(record),
        };
      },

      /**
       * Delete a record at the given protocol path.
       *
       * @param path - The protocol path (used for permission scoping).
       * @param request - Delete options including the `recordId`.
       */
      delete: async <Path extends ProtocolPaths<D> & string>(
        _path: Path,
        request: TypedDeleteRequest,
      ): Promise<DwnResponseStatus> => {
        this._assertReady(_path);
        return this._dwn.records.delete({
          from     : request.from,
          protocol : this._definition.protocol,
          recordId : request.recordId,
        });
      },

      /**
       * Subscribe to records at the given protocol path.
       *
       * Returns a {@link TypedLiveQuery} that atomically provides an initial
       * snapshot and a real-time stream of deduplicated change events, with
       * all records typed as `TypedRecord<T>`.
       *
       * @param path - The protocol path to subscribe to.
       * @param request - Optional filter and role.
       */
      subscribe: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request?: TypedSubscribeRequest,
      ): Promise<TypedSubscribeResponse<DataForPath<D, M, Path>>> => {
        this._assertReady(path);
        const typeName = lastSegment(path);
        const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

        const { status, liveQuery } = await this._dwn.records.subscribe({
          from   : request?.from,
          filter : {
            ...request?.filter,
            protocol     : this._definition.protocol,
            protocolPath : path,
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
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
