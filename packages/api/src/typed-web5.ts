/**
 * A protocol-scoped API returned by {@link Web5.using}.
 *
 * `TypedWeb5` is the **primary developer interface** for interacting with
 * protocol-backed records. It auto-injects the protocol URI, protocolPath,
 * and schema into every operation, and provides compile-time path
 * autocompletion plus typed data payloads via the schema map.
 *
 * @example
 * ```ts
 * const social = web5.using(SocialProtocol);
 *
 * // Install the protocol
 * await social.configure();
 *
 * // Write — path and data type are checked at compile time
 * const { record } = await social.records.write('thread', {
 *   data: { title: 'Hello World', body: '...' },
 * });
 *
 * // Query — protocol and protocolPath are auto-injected
 * const { records } = await social.records.query('thread');
 *
 * // Subscribe — real-time changes via LiveQuery
 * const { liveQuery } = await social.records.subscribe('thread/reply');
 * liveQuery.on('create', (record) => { ... });
 * ```
 */

import type { DwnApi } from './dwn-api.js';
import type { LiveQuery } from './live-query.js';
import type { Protocol } from './protocol.js';
import type { Record } from './record.js';

import type { DateSort, ProtocolDefinition, ProtocolType, RecordsFilter } from '@enbox/dwn-sdk-js';
import type { DwnPaginationCursor, DwnResponseStatus } from '@enbox/agent';
import type { ProtocolPaths, SchemaMap, TypedProtocol, TypeNameAtPath } from './protocol-types.js';

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/**
 * Resolves the TypeScript data type for a given protocol path.
 *
 * If the schema map contains a mapping for the type name at the given path,
 * that type is returned. Otherwise falls back to `unknown`.
 */
type DataForPath<
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

/** Options for {@link TypedWeb5} `records.write()`. */
export type TypedWriteRequest<
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

/** Response from {@link TypedWeb5} `records.write()`. */
export type TypedWriteResponse = DwnResponseStatus & {
  record: Record;
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
export type TypedQueryResponse = DwnResponseStatus & {
  records: Record[];
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
export type TypedReadResponse = DwnResponseStatus & {
  record: Record;
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
export type TypedSubscribeResponse = DwnResponseStatus & {
  /** The live query instance, or `undefined` if the request failed. */
  liveQuery?: LiveQuery;
};

// ---------------------------------------------------------------------------
// TypedWeb5 class
// ---------------------------------------------------------------------------

/**
 * A protocol-scoped API that auto-injects `protocol`, `protocolPath`, and
 * `schema` into every DWN operation.
 *
 * Obtain an instance via `web5.using(typedProtocol)`.
 *
 * @example
 * ```ts
 * const social = web5.using(SocialProtocol);
 *
 * await social.configure();
 *
 * const { record } = await social.records.write('friend', {
 *   data: { did: 'did:example:alice', alias: 'Alice' },
 * });
 *
 * const { records } = await social.records.query('friend', {
 *   filter: { tags: { did: 'did:example:alice' } },
 * });
 * ```
 */
export class TypedWeb5<
  D extends ProtocolDefinition = ProtocolDefinition,
  M extends SchemaMap = SchemaMap,
> {
  private _dwn: DwnApi;
  private _definition: D;

  constructor(dwn: DwnApi, protocol: TypedProtocol<D, M>) {
    this._dwn = dwn;
    this._definition = protocol.definition;
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
        return { status: { code: 200, detail: 'OK' }, protocol: existing };
      }
    }

    // Not installed or definition has changed — configure the new version.
    return this._dwn.protocols.configure({
      definition : this._definition,
      encryption : options?.encryption,
    });
  }

  /**
   * Protocol-scoped record operations.
   *
   * Every method auto-injects the protocol URI, protocolPath, and schema
   * from the protocol definition. Path parameters provide compile-time
   * autocompletion via `ProtocolPaths<D>`.
   */
  public get records(): {
    write: <Path extends ProtocolPaths<D> & string>(path: Path, request: TypedWriteRequest<D, M, Path>) => Promise<TypedWriteResponse>;
    query: <Path extends ProtocolPaths<D> & string>(path: Path, request?: TypedQueryRequest) => Promise<TypedQueryResponse>;
    read: <Path extends ProtocolPaths<D> & string>(path: Path, request: TypedReadRequest) => Promise<TypedReadResponse>;
    delete: <Path extends ProtocolPaths<D> & string>(path: Path, request: TypedDeleteRequest) => Promise<DwnResponseStatus>;
    subscribe: <Path extends ProtocolPaths<D> & string>(path: Path, request?: TypedSubscribeRequest) => Promise<TypedSubscribeResponse>;
    } {
    return {
      /**
       * Write a record at the given protocol path.
       *
       * @param path - The protocol path (e.g. `'friend'`, `'group/member'`).
       * @param request - Write options including typed `data`.
       */
      write: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request: TypedWriteRequest<D, M, Path>,
      ): Promise<TypedWriteResponse> => {
        const typeName = lastSegment(path);
        const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

        return this._dwn.records.write({
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
      ): Promise<TypedQueryResponse> => {
        const typeName = lastSegment(path);
        const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

        return this._dwn.records.query({
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
      ): Promise<TypedReadResponse> => {
        const typeName = lastSegment(path);
        const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

        return this._dwn.records.read({
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
        return this._dwn.records.delete({
          from     : request.from,
          protocol : this._definition.protocol,
          recordId : request.recordId,
        });
      },

      /**
       * Subscribe to records at the given protocol path.
       *
       * Returns a {@link LiveQuery} that atomically provides an initial snapshot
       * and a real-time stream of deduplicated change events.
       *
       * @param path - The protocol path to subscribe to.
       * @param request - Optional filter and role.
       */
      subscribe: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request?: TypedSubscribeRequest,
      ): Promise<TypedSubscribeResponse> => {
        const typeName = lastSegment(path);
        const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

        return this._dwn.records.subscribe({
          from   : request?.from,
          filter : {
            ...request?.filter,
            protocol     : this._definition.protocol,
            protocolPath : path,
            ...(typeEntry?.schema !== undefined ? { schema: typeEntry.schema } : {}),
          },
          protocolRole: request?.protocolRole,
        });
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
