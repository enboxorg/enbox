/**
 * A type-safe wrapper around {@link DwnApi} scoped to a single protocol.
 *
 * `TypedDwnApi` is created via `dwn.using(typedProtocol)` and provides
 * autocompletion for protocol paths, typed data payloads, and tag shapes.
 *
 * Every method delegates to the corresponding `dwn.records.*` method,
 * injecting the protocol URI, protocolPath, and schema automatically.
 */

import type { Protocol } from './protocol.js';
import type { Record } from './record.js';
import type { DateSort, ProtocolDefinition, ProtocolType, RecordsFilter } from '@enbox/dwn-sdk-js';
import type { DwnApi, RecordsSubscriptionHandler } from './dwn-api.js';
import type { DwnMessageSubscription, DwnPaginationCursor, DwnResponseStatus } from '@enbox/agent';
import type { ProtocolPaths, SchemaMap, TypedProtocol, TypeNameAtPath } from './protocol-types.js';

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/**
 * Resolves the TypeScript data type for a given protocol path.
 *
 * If the schema map contains a mapping for the type name at the given path,
 * that type is returned.  Otherwise falls back to `unknown`.
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

/** Options for `TypedDwnApi.write()`. */
export type TypedWriteRequest<
  D extends ProtocolDefinition,
  M extends SchemaMap,
  Path extends string,
> = {
  /** The data payload. Type-checked against the schema map. */
  data: DataForPath<D, M, Path>;

  /** Additional message parameters (protocolPath and protocol are injected). */
  message?: {
    parentContextId? : string;
    published? : boolean;
    datePublished? : string;
    recipient? : string;
    protocolRole? : string;
    dataFormat? : DataFormatForPath<D, Path>;
    tags? : globalThis.Record<string, string | number | boolean | string[] | number[]>;
  };

  /** Whether to persist immediately (defaults to `true`). */
  store?: boolean;

  /** Whether to auto-encrypt (follows protocol definition if omitted). */
  encryption?: boolean;
};

/** Response from `TypedDwnApi.write()`. */
export type TypedWriteResponse = DwnResponseStatus & {
  record?: Record;
};

/** Filter options for `TypedDwnApi.query()`. */
export type TypedQueryFilter = Omit<RecordsFilter, 'protocol' | 'protocolPath' | 'schema'> & {
  tags?: globalThis.Record<string, string | number | boolean | (string | number)[]>;
};

/** Options for `TypedDwnApi.query()`. */
export type TypedQueryRequest = {
  /** Optional remote DWN DID to query from. */
  from?: string;

  /** Query filter (protocol, protocolPath, schema are injected). */
  filter? : TypedQueryFilter;
  dateSort? : DateSort;
  pagination? : { limit?: number; cursor?: DwnPaginationCursor };
  protocolRole? : string;

  /** When true, automatically decrypts encrypted records. */
  encryption?: boolean;
};

/** Response from `TypedDwnApi.query()`. */
export type TypedQueryResponse = DwnResponseStatus & {
  records?: Record[];
  cursor? : DwnPaginationCursor;
};

/** Options for `TypedDwnApi.read()`. */
export type TypedReadRequest = {
  /** Optional remote DWN DID to read from. */
  from?: string;

  /** Filter to identify the record (protocol and protocolPath are injected). */
  filter: Omit<RecordsFilter, 'protocol' | 'protocolPath' | 'schema'>;

  /** When true, automatically decrypts the record. */
  encryption?: boolean;
};

/** Response from `TypedDwnApi.read()`. */
export type TypedReadResponse = DwnResponseStatus & {
  record: Record;
};

/** Options for `TypedDwnApi.delete()`. */
export type TypedDeleteRequest = {
  /** Optional remote DWN DID to delete from. */
  from?: string;

  /** The `recordId` of the record to delete. */
  recordId: string;
};

/** Options for `TypedDwnApi.subscribe()`. */
export type TypedSubscribeRequest = {
  /** Optional remote DWN DID to subscribe to. */
  from?: string;

  /** Subscription filter (protocol, protocolPath, schema are injected). */
  filter? : TypedQueryFilter;
  protocolRole? : string;
  subscriptionHandler : RecordsSubscriptionHandler;

  /** When true, indicates encryption is active. */
  encryption?: boolean;
};

/** Response from `TypedDwnApi.subscribe()`. */
export type TypedSubscribeResponse = DwnResponseStatus & {
  subscription?: DwnMessageSubscription;
};

// ---------------------------------------------------------------------------
// TypedDwnApi class
// ---------------------------------------------------------------------------

/**
 * A protocol-scoped wrapper around `DwnApi` that automatically injects
 * the `protocol` URI, `protocolPath`, and `schema` into every DWN operation.
 *
 * Obtain an instance via `dwn.using(typedProtocol)`.
 *
 * @example
 * ```ts
 * const social = dwn.using(SocialGraphProtocol);
 *
 * // Write — path and data type are checked at compile time
 * const { record } = await social.write('friend', {
 *   data: { did: 'did:example:alice', alias: 'Alice' },
 * });
 *
 * // Query — protocol and protocolPath are auto-injected
 * const { records } = await social.query('friend', {
 *   filter: { tags: { did: 'did:example:alice' } },
 * });
 * ```
 */
export class TypedDwnApi<
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
   * @param options - Optional overrides like `encryption`.
   */
  public async configure(options?: { encryption?: boolean }): Promise<DwnResponseStatus & { protocol?: Protocol }> {
    return this._dwn.protocols.configure({
      message    : { definition: this._definition },
      encryption : options?.encryption,
    });
  }

  /**
   * Write a record at the given protocol path.
   *
   * @param path - The protocol path (e.g. `'friend'`, `'group/member'`).
   * @param request - Write options including typed `data`.
   */
  public async write<Path extends ProtocolPaths<D> & string>(
    path : Path,
    request : TypedWriteRequest<D, M, Path>,
  ): Promise<TypedWriteResponse> {
    const typeName = lastSegment(path);
    const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

    return this._dwn.records.write({
      data       : request.data,
      store      : request.store,
      encryption : request.encryption,
      message    : {
        ...request.message,
        protocol     : this._definition.protocol,
        protocolPath : path,
        schema       : typeEntry?.schema,
        dataFormat   : request.message?.dataFormat ?? typeEntry?.dataFormats?.[0],
      },
    });
  }

  /**
   * Query records at the given protocol path.
   *
   * @param path - The protocol path to query.
   * @param request - Query options including optional filter, sort, and pagination.
   */
  public async query<Path extends ProtocolPaths<D> & string>(
    path : Path,
    request? : TypedQueryRequest,
  ): Promise<TypedQueryResponse> {
    const typeName = lastSegment(path);
    const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

    return this._dwn.records.query({
      from       : request?.from,
      protocol   : this._definition.protocol,
      encryption : request?.encryption,
      message    : {
        filter: {
          ...request?.filter,
          protocol     : this._definition.protocol,
          protocolPath : path,
          schema       : typeEntry?.schema,
        },
        dateSort     : request?.dateSort,
        pagination   : request?.pagination,
        protocolRole : request?.protocolRole,
      },
    });
  }

  /**
   * Read a single record at the given protocol path.
   *
   * @param path - The protocol path to read from.
   * @param request - Read options including a filter to identify the record.
   */
  public async read<Path extends ProtocolPaths<D> & string>(
    path : Path,
    request : TypedReadRequest,
  ): Promise<TypedReadResponse> {
    const typeName = lastSegment(path);
    const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

    return this._dwn.records.read({
      from       : request.from,
      protocol   : this._definition.protocol,
      encryption : request.encryption,
      message    : {
        filter: {
          ...request.filter,
          protocol     : this._definition.protocol,
          protocolPath : path,
          schema       : typeEntry?.schema,
        },
      },
    });
  }

  /**
   * Delete a record at the given protocol path.
   *
   * @param path - The protocol path (used for permission scoping).
   * @param request - Delete options including the `recordId`.
   */
  public async delete<Path extends ProtocolPaths<D> & string>(
    _path : Path,
    request : TypedDeleteRequest,
  ): Promise<DwnResponseStatus> {
    return this._dwn.records.delete({
      from     : request.from,
      protocol : this._definition.protocol,
      message  : {
        recordId: request.recordId,
      },
    });
  }

  /**
   * Subscribe to records at the given protocol path.
   *
   * @param path - The protocol path to subscribe to.
   * @param request - Subscribe options including the subscription handler.
   */
  public async subscribe<Path extends ProtocolPaths<D> & string>(
    path : Path,
    request : TypedSubscribeRequest,
  ): Promise<TypedSubscribeResponse> {
    const typeName = lastSegment(path);
    const typeEntry = this._definition.types[typeName] as ProtocolType | undefined;

    return this._dwn.records.subscribe({
      from                : request.from,
      protocol            : this._definition.protocol,
      encryption          : request.encryption,
      subscriptionHandler : request.subscriptionHandler,
      message             : {
        filter: {
          ...request.filter,
          protocol     : this._definition.protocol,
          protocolPath : path,
          schema       : typeEntry?.schema,
        },
        protocolRole: request.protocolRole,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the last segment of a slash-delimited path.
 */
function lastSegment(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}
