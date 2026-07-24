/**
 * NOTE: Added reference types here to avoid a `pnpm` bug during build.
 * https://github.com/enboxorg/enbox/pull/507
 */
/// <reference types="@enbox/dwn-sdk-js" />

import type { AnonymousDwnApi, DwnPaginationCursor, DwnResponseStatus } from '@enbox/agent';
import type {
  DateSort,
  Pagination,
  ProtocolDefinition,
  ProtocolsQueryFilter,
  RecordsFilter,
} from '@enbox/dwn-sdk-js';

import { ReadOnlyRecord } from './read-only-record.js';

// ---------------------------------------------------------------------------
// Request / Response types for records
// ---------------------------------------------------------------------------

/**
 * Request to query public records from a remote DWN.
 *
 * @beta
 */
export type ReaderRecordsQueryRequest = {
  /** The DID of the remote DWN to query (required — reader is remote-only). */
  from: string;
  /** Filter criteria for the query. */
  filter: RecordsFilter;
  /** Sort order for results. */
  dateSort?: DateSort;
  /** Pagination options. */
  pagination?: Pagination;
};

/**
 * Response from a reader records query.
 *
 * @beta
 */
export type ReaderRecordsQueryResponse = DwnResponseStatus & {
  /** Array of read-only records matching the query. */
  records: ReadOnlyRecord[];
  /** Pagination cursor for fetching the next page. */
  cursor?: DwnPaginationCursor;
};

/**
 * Request to read a specific public record from a remote DWN.
 *
 * @beta
 */
export type ReaderRecordsReadRequest = {
  /** The DID of the remote DWN to read from (required — reader is remote-only). */
  from: string;
  /** Filter to identify the record (typically `{ recordId: '...' }`). */
  filter: RecordsFilter;
};

/**
 * Response from a reader records read.
 *
 * @beta
 */
export type ReaderRecordsReadResponse = DwnResponseStatus & {
  /** The read-only record, if found. */
  record?: ReadOnlyRecord;
};

/**
 * Request to count public records on a remote DWN.
 *
 * @beta
 */
export type ReaderRecordsCountRequest = {
  /** The DID of the remote DWN to count records in (required). */
  from: string;
  /** Filter criteria for counting. */
  filter: RecordsFilter;
};

/**
 * Response from a reader records count.
 *
 * @beta
 */
export type ReaderRecordsCountResponse = DwnResponseStatus & {
  /** The number of matching public records. */
  count?: number;
};

// ---------------------------------------------------------------------------
// Request / Response types for protocols
// ---------------------------------------------------------------------------

/**
 * Request to query published protocols from a remote DWN.
 *
 * @beta
 */
export type ReaderProtocolsQueryRequest = {
  /** The DID of the remote DWN to query protocols from (required). */
  from: string;
  /** Optional filter for the protocol query. */
  filter?: ProtocolsQueryFilter;
};

/**
 * Response from a reader protocols query.
 *
 * @beta
 */
export type ReaderProtocolsQueryResponse = DwnResponseStatus & {
  /** Array of published protocol definitions. */
  protocols: ProtocolDefinition[];
};

// ---------------------------------------------------------------------------
// DwnReaderApi
// ---------------------------------------------------------------------------

/**
 * A read-only API for querying public data on remote DWNs without any identity or signing keys.
 *
 * This class mirrors the shape of {@link DwnApi}'s `records` and `protocols`
 * namespaces, but restricts to read-path operations and requires a `from` DID
 * on every call (remote-only). All messages are unsigned, so only published
 * records and protocols are accessible.
 *
 * Obtain an instance via {@link Enbox.anonymous | `Enbox.anonymous()`}.
 *
 * @example
 * ```ts
 * const { dwn } = Enbox.anonymous();
 *
 * const { records } = await dwn.records.query({
 *   from: 'did:dht:alice...',
 *   filter: { protocol: 'https://blog.example/posts', protocolPath: 'post' },
 * });
 *
 * for (const record of records) {
 *   console.log(record.id, await record.data.text());
 * }
 * ```
 *
 * @beta
 */
export class DwnReaderApi {
  private readonly _anonymousDwn: AnonymousDwnApi;

  constructor(anonymousDwn: AnonymousDwnApi) {
    this._anonymousDwn = anonymousDwn;
  }

  /**
   * API to interact with public DWN records (query, read, count).
   */
  get records(): {
    query: (request: ReaderRecordsQueryRequest) => Promise<ReaderRecordsQueryResponse>;
    read: (request: ReaderRecordsReadRequest) => Promise<ReaderRecordsReadResponse>;
    count: (request: ReaderRecordsCountRequest) => Promise<ReaderRecordsCountResponse>;
    } {
    return {
      /**
       * Query public records from a remote DWN.
       * Only published records are returned.
       */
      query: async (request: ReaderRecordsQueryRequest): Promise<ReaderRecordsQueryResponse> => {
        const reply = await this._anonymousDwn.recordsQuery(request.from, {
          filter     : request.filter,
          dateSort   : request.dateSort,
          pagination : request.pagination,
        });

        const { entries = [], status, cursor } = reply;

        const records = entries.map((entry) => new ReadOnlyRecord({
          rawMessage   : entry,
          initialWrite : entry.initialWrite,
          encodedData  : entry.encodedData,
          remoteOrigin : request.from,
          anonymousDwn : this._anonymousDwn,
        }));

        return { records, status, cursor };
      },

      /**
       * Read a specific public record from a remote DWN.
       * Succeeds for published records and protocol records with `{ who: 'anyone', can: ['read'] }`.
       */
      read: async (request: ReaderRecordsReadRequest): Promise<ReaderRecordsReadResponse> => {
        const reply = await this._anonymousDwn.recordsRead(request.from, {
          filter: request.filter,
        });

        const { entry, status } = reply;

        let record: ReadOnlyRecord | undefined;
        if (200 <= status.code && status.code <= 299 && entry?.recordsWrite) {
          record = new ReadOnlyRecord({
            rawMessage   : entry.recordsWrite,
            initialWrite : entry.initialWrite,
            data         : entry.data,
            remoteOrigin : request.from,
            anonymousDwn : this._anonymousDwn,
          });
        }

        return { record, status };
      },

      /**
       * Count public records on a remote DWN.
       * Only published records are counted.
       */
      count: async (request: ReaderRecordsCountRequest): Promise<ReaderRecordsCountResponse> => {
        const reply = await this._anonymousDwn.recordsCount(request.from, {
          filter: request.filter,
        });

        const { count, status } = reply;

        return { count, status };
      },
    };
  }

  /**
   * API to query published protocol definitions from remote DWNs.
   */
  get protocols(): {
    query: (request: ReaderProtocolsQueryRequest) => Promise<ReaderProtocolsQueryResponse>;
    } {
    return {
      /**
       * Query published protocols from a remote DWN.
       * Only protocol definitions with `published: true` are returned.
       */
      query: async (request: ReaderProtocolsQueryRequest): Promise<ReaderProtocolsQueryResponse> => {
        const reply = await this._anonymousDwn.protocolsQuery(request.from, {
          filter: request.filter,
        });

        const { entries = [], status } = reply;

        const protocols = entries.map((entry) => entry.descriptor.definition);

        return { protocols, status };
      },
    };
  }
}
