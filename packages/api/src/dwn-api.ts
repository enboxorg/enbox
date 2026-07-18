/**
 * NOTE: Added reference types here to avoid a `pnpm` bug during build.
 * https://github.com/enboxorg/enbox/pull/507
 */
/// <reference types="@enbox/dwn-sdk-js" />

import type {
  AudienceKeyDeliveryOutcome,
  CreateGrantParams,
  CreateRequestParams,
  DwnMessage,
  DwnMessageParams,
  DwnPaginationCursor,
  DwnPublicKeyJwk,
  DwnResponse,
  DwnResponseStatus,
  EnboxAgent,
  FetchPermissionRequestParams,
  FetchPermissionsParams,
  ProcessDwnRequest } from '@enbox/agent';

import type { DwnSubscriptionMessage } from '@enbox/dwn-clients';

import { AgentPermissionsApi, DwnInterface, getRecordAuthor } from '@enbox/agent';

import { dataToBlob } from './utils.js';
import { LiveQuery } from './live-query.js';
import { PermissionGrant } from './permission-grant.js';
import { PermissionRequest } from './permission-request.js';
import { Protocol } from './protocol.js';
import { Record } from './record.js';
import { describeMessage, MessagesLiveQuery } from './messages-live-query.js';

/**
 * Represents the request payload for fetching permission requests from a Decentralized Web Node (DWN).
 *
 * Optionally, specify a remote DWN target in the `from` property to fetch requests from.
 */
export type FetchRequestsRequest = Omit<FetchPermissionRequestParams, 'author' | 'target' | 'remote'> & {
  /** Optional DID specifying the remote target DWN tenant to be queried. */
  from?: string;
};

/**
 * Represents the request payload for fetching permission grants from a Decentralized Web Node (DWN).
 *
 * Optionally, specify a remote DWN target in the `from` property to fetch requests from.
 * Set `checkRevoked: true` to perform explicit per-grant revocation checks.
 */
export type FetchGrantsRequest = Omit<FetchPermissionsParams, 'author' | 'target' | 'remote'> & {
  /** Optional DID specifying the remote target DWN tenant to be queried. */
  from?: string;
};

/**
 * Represents the request payload for configuring a protocol on a Decentralized Web Node (DWN).
 *
 * This request type is used to specify the configuration options for the protocol.
 */
export type ProtocolsConfigureRequest = Omit<DwnMessageParams[DwnInterface.ProtocolsConfigure], 'signer'> & {
  /** When true, derives and injects $keyAgreement public keys into the protocol definition. */
  encryption?: boolean;
};

/**
 * Encapsulates the response from a protocol configuration request to a Decentralized Web Node (DWN).
 *
 * This response type combines the general operation status with the details of the protocol that
 * was configured, if the operation was successful.
 *
 * @beta
 */
export type ProtocolsConfigureResponse = DwnResponseStatus & {
  /** The configured protocol, if successful. */
  protocol?: Protocol;
};

/**
 * Defines the request structure for querying protocols from a Decentralized Web Node (DWN).
 *
 * This request type is used to specify the target DWN from which protocols should be queried and
 * any additional query filters or options. If the `from` property is not provided, the query will
 * target the local DWN. If the `from` property is provided, the query will target the specified
 * remote DWN.
 */
export type ProtocolsQueryRequest = Omit<DwnMessageParams[DwnInterface.ProtocolsQuery], 'signer'> & {
  /** Optional DID specifying the remote target DWN tenant to be queried. */
  from?: string;
};

/**
 * Wraps the response from a protocols query, including the operation status and the list of
 * protocols.
 */
export type ProtocolsQueryResponse = DwnResponseStatus & {
  /** Array of protocols matching the query. */
  protocols: Protocol[];
};

/**
 * Defines a request to delete a record from the Decentralized Web Node (DWN).
 *
 * This request type optionally specifies the target from which the record should be deleted and the
 * message parameters for the delete operation. If the `from` property is not provided, the record
 * will be deleted from the local DWN.
 */
export type RecordsDeleteRequest = Omit<DwnMessageParams[DwnInterface.RecordsDelete], 'signer'> & {
  /** Optional DID specifying the remote target DWN tenant the record will be deleted from. */
  from?: string;

  /** Protocol URI for permission grant resolution. */
  protocol?: string;
};

/**
 * Encapsulates a request to query records from a Decentralized Web Node (DWN).
 *
 * This request type is used to specify the criteria for querying records, including query
 * parameters, and optionally the target DWN to query from. If the `from` property is not provided,
 * the query will target the local DWN.
 */
export type RecordsQueryRequest = Omit<DwnMessageParams[DwnInterface.RecordsQuery], 'signer'> & {
  /** Optional DID specifying the remote target DWN tenant to query from and return results. */
  from?: string;

  /** When true, automatically decrypts encrypted records in the query results. */
  encryption?: boolean;
};

/**
 * Represents the response from a records query operation, including status, records, and an
 * optional pagination cursor.
 */
export type RecordsQueryResponse = DwnResponseStatus & {
  /** Array of records matching the query. */
  records: Record[];

  /** If there are additional results, the messageCid of the last record will be returned as a pagination cursor. */
  cursor?: DwnPaginationCursor;
};

/**
 * Encapsulates a request to drain every record matching a query from a Decentralized Web Node
 * (DWN) via `records.queryAll()`.
 *
 * Identical to {@link RecordsQueryRequest} except that pagination is managed internally: the
 * drain pages through results with `pageSize`-sized queries until the cursor is exhausted (or
 * the optional `maxRecords` safety cap is reached), so callers never hand-write cursor loops.
 */
export type RecordsQueryAllRequest = Omit<RecordsQueryRequest, 'pagination'> & {
  /**
   * The number of records fetched per underlying query page. Defaults to 100. Tune it down for
   * very large payload-bearing records, or up to reduce round-trips on small records.
   *
   * Must be a positive integer — rejected loudly at call time otherwise.
   */
  pageSize?: number;

  /**
   * Optional safety cap on the total number of records yielded. When set, iteration stops after
   * yielding this many records even if more pages remain — guarding accidental unbounded drains
   * of very large record sets. When omitted, the drain runs to cursor exhaustion.
   *
   * Counts YIELDED records only, so it cannot bound a remote that returns empty pages — that is
   * what {@link RecordsQueryAllRequest.maxPages} and the built-in liveness guards are for.
   *
   * Must be a positive integer — rejected loudly at call time otherwise.
   */
  maxRecords?: number;

  /**
   * Overall page-request budget for the drain, independent of `maxRecords`. Defaults to 1000
   * pages. Exceeding it THROWS (it is a runaway-remote guard, not a truncation knob — use
   * `maxRecords` for intentional truncation).
   *
   * Two built-in liveness guards back it up regardless of this budget: a page that repeats the
   * cursor it was requested with terminates the drain with a thrown error (a repeated cursor is
   * never legitimate), and a run of consecutive empty-but-cursor-bearing pages beyond a small
   * fixed budget does the same.
   *
   * Must be a positive integer — rejected loudly at call time otherwise.
   */
  maxPages?: number;
};

/**
 * Validates the numeric options of a {@link RecordsQueryAllRequest} at CALL time — before any
 * page is fetched — so a malformed budget (NaN, zero, negative, fractional) fails loudly instead
 * of silently disabling a guard. Shared by the raw and typed `queryAll` entry points.
 *
 * @throws `Error` naming the offending option when it is not a positive integer.
 */
export function assertValidQueryAllOptions(
  options: { pageSize?: number; maxRecords?: number; maxPages?: number },
): void {
  const numericOptions: [name: string, value: number | undefined][] = [
    ['pageSize', options.pageSize],
    ['maxRecords', options.maxRecords],
    ['maxPages', options.maxPages],
  ];

  for (const [name, value] of numericOptions) {
    if (value === undefined) {
      continue;
    }
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`DwnApi: records.queryAll() option '${name}' must be a positive integer (got ${value}).`);
    }
  }
}

/**
 * Represents a request to read a specific record from a Decentralized Web Node (DWN).
 *
 * This request type is used to specify the target DWN from which the record should be read and any
 * additional parameters for the read operation. It's useful for fetching the details of a single
 * record by its identifier or other criteria.
 */
export type RecordsReadRequest = Omit<DwnMessageParams[DwnInterface.RecordsRead], 'signer'> & {
  /** Optional DID specifying the remote target DWN tenant the record will be read from. */
  from?: string;

  /** Protocol URI for permission grant resolution. */
  protocol?: string;

  /** When true, automatically decrypts the encrypted record data. */
  encryption?: boolean;
};

/**
 * Encapsulates the response from a record read operation, combining the general operation status
 * with the specific record that was retrieved.
 *
 * When the status code is not in the 2xx range (e.g. 401, 404), `record` will be `undefined`.
 * Always check `status.code` before accessing the record.
 */
export type RecordsReadResponse = DwnResponseStatus & {
  /** The record retrieved by the read operation, or `undefined` if the request failed. */
  record?: Record;
};

/**
 * Represents a request to subscribe to records from a Decentralized Web Node (DWN).
 *
 * Returns a {@link LiveQuery} that atomically provides an initial snapshot of
 * matching records alongside a real-time stream of deduplicated, semantically-
 * typed change events (`create`, `update`, `delete`).
 */
export type RecordsSubscribeRequest = Omit<DwnMessageParams[DwnInterface.RecordsSubscribe], 'signer'> & {
  /** Optional DID specifying the remote target DWN tenant to subscribe from. */
  from?: string;

  /**
   * When true, automatically decrypts encrypted records delivered by the
   * subscription — both the initial snapshot and live change events.
   *
   * Small record payloads are delivered inline with the event and decrypted
   * before the event reaches the {@link LiveQuery}, so `record.data` serves
   * plaintext without a further read round-trip. Records whose data is too
   * large to be inlined carry no event payload — their `data` accessor lazily
   * reads (and decrypts) from the DWN on access, as it always has.
   *
   * A record that cannot be decrypted (e.g. no delivered key covers it) never
   * terminates the subscription: its change event is still delivered, with the
   * undecryptable inline ciphertext withheld, so `record.data` falls back to
   * the lazy read — which rejects with the decryption error, or succeeds later
   * once a usable key has arrived.
   */
  encryption?: boolean;
};

/** Encapsulates the response from a DWN RecordsSubscribeRequest. */
export type RecordsSubscribeResponse = DwnResponseStatus & {
  /** The live query instance, or `undefined` if the request failed. */
  liveQuery?: LiveQuery;
};

/**
 * Represents a request to subscribe to the message-level change feed of a
 * Decentralized Web Node (DWN) tenant.
 *
 * Where {@link RecordsSubscribeRequest} hydrates full `Record` objects for one
 * filter, this is the lightweight change signal: multiple filters per
 * subscription, one `event` per message recorded on the tenant's log, each
 * carrying the raw message plus a routing {@link MessageDescriptor}. Designed
 * for cache invalidation and reactive reads over the local store, which sync
 * keeps populated — including messages applied by sync itself.
 */
export type MessagesSubscribeRequest = Omit<DwnMessageParams[DwnInterface.MessagesSubscribe], 'signer'> & {
  /** Optional DID specifying the remote target DWN tenant to subscribe from. */
  from?: string;
};

/** Encapsulates the response from a DWN MessagesSubscribeRequest. */
export type MessagesSubscribeResponse = DwnResponseStatus & {
  /** The live message feed, or `undefined` if the request failed. */
  liveQuery?: MessagesLiveQuery;
};

/**
 * Defines a request to write (create) a record to a Decentralized Web Node (DWN).
 *
 * This request type allows specifying the data for the new or updated record, along with any
 * additional message parameters required for the write operation, and an optional flag to indicate
 * whether the record should be immediately stored.
 */
export type RecordsWriteRequest = Omit<Partial<DwnMessageParams[DwnInterface.RecordsWrite]>, 'signer' | 'data' | 'protocol' | 'protocolPath' | 'encryption'> &
  Pick<DwnMessageParams[DwnInterface.RecordsWrite], 'protocol' | 'protocolPath'> & {
  /** The data payload for the record, which can be of any type. */
  data: unknown;

  /**
   * Optional DID specifying the remote target DWN tenant the record will be written to.
   *
   * When set, the write targets the specified tenant's remote DWN (via the agent's
   * `sendDwnRequest`, mirroring how remote reads and queries dispatch) instead of the connected
   * DID's local DWN. The author stays the connected (grantee) DID — the grantee signs as
   * themselves — and the remote DWN authorizes the write via `protocolRole` (role-invocation) or
   * grant parameters (`permissionGrantId`/`delegatedGrant`). The returned {@link Record} is
   * stamped with `remoteOrigin` so subsequent data reads target the owner tenant.
   *
   * Remote-path boundaries:
   * - {@link RecordsWriteRequest.recipientRolePublicKey} is NOT supported with `from` — the
   *   agent throws rather than silently ignoring the key (see that field's doc).
   * - {@link RecordsWriteResponse.audienceKeyDelivery} is never present on remote writes —
   *   role-audience key delivery provisioning is a local-processing (`processRequest`-only)
   *   concept.
   * - `store` applies to the local path only and has no effect when `from` is set.
   */
  from?: string;

  /**
   * Optional flag indicating whether the record should be immediately stored. If true, the record
   * is persisted in the DWN as part of the write operation. If false, the record is created,
   * signed, and returned but not persisted.
   */
  store?: boolean;

  /** When true, automatically encrypts the record data using the protocol's encryption keys. */
  encryption?: boolean;

  /**
   * The recipient's role-path public key for this write, forwarded to the agent when writing a
   * `$role` record with a `recipient`.
   *
   * Supply it for recipients whose role-path key cannot be resolved from their DWN (e.g. a bare
   * `did:jwk` publishing no resolvable DWN endpoint); the recipient computes the key locally and
   * carries it out of band for the writer to supply here. When omitted, role-audience key delivery
   * is best-effort and its outcome is reported on
   * {@link RecordsWriteResponse.audienceKeyDelivery} instead of failing the write.
   *
   * Enbox validates only that the supplied key is a usable X25519 public key — it does NOT verify
   * that the key belongs to the recipient. That authenticity binding rests entirely on the
   * out-of-band channel the caller trusts (e.g. a signed join request). A `delivered: true`
   * outcome means the delivery record was written wrapping THIS supplied key; it does not assert
   * the intended recipient can decrypt it — supplying the wrong key yields `delivered: true` and
   * a delivery the real recipient cannot decrypt.
   *
   * NOT supported together with {@link RecordsWriteRequest.from} — role-audience key delivery is
   * provisioned on the owner's local DWN via `processRequest` only, so the agent rejects a
   * supplied key on the remote dispatch path rather than silently ignoring it.
   */
  recipientRolePublicKey?: DwnPublicKeyJwk;
};

/**
 * Encapsulates the response from a record write operation to a Decentralized Web Node (DWN).
 *
 * This request type combines the general operation status with the details of the record that was
 * written, if the operation was successful.
 *
 * The response includes a status object that contains the HTTP-like status code and detail message
 * indicating the success or failure of the write operation. If the operation was successful and a
 * record was created or updated, the `record` property will contain an instance of the `Record`
 * class representing the written record. This allows the caller to access the written record's
 * details and perform additional operations using the provided {@link Record} instance methods.
 */
export type RecordsWriteResponse = DwnResponseStatus & {
  /**
   * The `Record` instance representing the record that was successfully written to the
   * DWN as a result of the write operation, or `undefined` if the write failed.
   *
   * Always check `status.code` before accessing the record.
   */
  record?: Record;

  /**
   * Outcome of role-audience key delivery provisioning, forwarded from the agent. Present only
   * for accepted `$role` record writes with a `recipient` that triggered delivery provisioning.
   *
   * On the best-effort path (no `recipientRolePublicKey` supplied), a recipient whose role-path
   * key could not be resolved is reported here with `delivered: false` instead of failing the
   * write — inspect the outcome and re-write the role record (e.g. with a caller-supplied
   * `recipientRolePublicKey`) to retry delivery.
   *
   * Never present for remote writes ({@link RecordsWriteRequest.from} set): delivery
   * provisioning happens only during local processing (`processRequest`), and its absence on the
   * remote path is structural — not a delivery failure.
   */
  audienceKeyDelivery?: AudienceKeyDeliveryOutcome;
};

/**
 * Interface to interact with DWN Records and Protocols
 */
export class DwnApi {
  /** Default per-page record count used by `records.queryAll()` when no `pageSize` is given. */
  private static readonly QUERY_ALL_DEFAULT_PAGE_SIZE = 100;

  /** Default overall page-request budget for `records.queryAll()` when no `maxPages` is given. */
  private static readonly QUERY_ALL_DEFAULT_MAX_PAGES = 1000;

  /**
   * Liveness budget for `records.queryAll()`: the maximum run of consecutive EMPTY pages that
   * still return a pagination cursor before the drain terminates with a thrown error. A healthy
   * remote never sustains cursor-bearing empty pages; an adversarial or buggy one can emit them
   * forever with ever-changing cursors, which `maxRecords` (counting yielded records) would
   * never bound.
   */
  private static readonly QUERY_ALL_MAX_CONSECUTIVE_EMPTY_PAGES = 3;

  /** Throws before a query when the drain has exhausted its page-request budget. */
  private static assertQueryAllPageBudget(pagesFetched: number, maxPages: number): void {
    if (pagesFetched >= maxPages) {
      throw new Error(
        `DwnApi: records.queryAll() exceeded its page budget of ${maxPages} pages with results still remaining. ` +
        'Raise maxPages for legitimately huge drains, or use maxRecords / pagination for intentional truncation.',
      );
    }
  }

  /** Throws when an underlying query page did not complete successfully. */
  private static assertQueryAllPageSucceeded(status: DwnResponseStatus['status']): void {
    if (status.code < 200 || status.code > 299) {
      throw new Error(`DwnApi: records.queryAll() page failed with status ${status.code}: ${status.detail}`);
    }
  }

  /**
   * Validates cursor progress and returns the next consecutive-empty-page count.
   * These guards bound buggy or adversarial remotes that keep returning cursors
   * without ever yielding a record.
   */
  private static nextQueryAllEmptyPageCount(params: {
    consecutiveEmptyPages: number;
    cursor: DwnPaginationCursor | undefined;
    nextCursor: DwnPaginationCursor | undefined;
    recordCount: number;
  }): number {
    const { consecutiveEmptyPages, cursor, nextCursor, recordCount } = params;
    if (nextCursor === undefined) {
      return consecutiveEmptyPages;
    }

    // A page that hands back the cursor it was requested with would make the
    // next request identical to this one — an infinite loop, and never a
    // legitimate server behavior.
    if (cursor !== undefined && JSON.stringify(nextCursor) === JSON.stringify(cursor)) {
      throw new Error(
        'DwnApi: records.queryAll() terminated: the remote returned a repeated pagination cursor ' +
        '(same cursor as the request that produced it), which can never make progress.',
      );
    }

    if (recordCount > 0) {
      return 0;
    }

    // Empty pages that still carry a (changing) cursor never trip
    // `maxRecords` (it counts yields), so they get their own small budget.
    const nextEmptyPageCount = consecutiveEmptyPages + 1;
    if (nextEmptyPageCount >= DwnApi.QUERY_ALL_MAX_CONSECUTIVE_EMPTY_PAGES) {
      throw new Error(
        `DwnApi: records.queryAll() terminated after ${nextEmptyPageCount} consecutive empty pages ` +
        'that still returned a pagination cursor — the remote is not making progress.',
      );
    }
    return nextEmptyPageCount;
  }

  /**
   * Holds the instance of a {@link EnboxAgent} that represents the current execution context for
   * the `DwnApi`. This agent is used to process DWN requests.
   */
  private readonly agent: EnboxAgent;

  /**
   * The DID of the DWN tenant under which operations are being performed.
   *
   * Exposed as a public getter so that `TypedEnbox` can read it during
   * delegate auto-configure (remote protocol fetch).
   */
  private _connectedDid: string;
  get connectedDid(): string { return this._connectedDid; }
  /** @internal — used by tests to reset state between runs. */
  set connectedDid(did: string) { this._connectedDid = did; }

  /** (optional) The DID of the signer when signing with permissions */
  private readonly delegateDid?: string;

  /** Holds the instance of {@link AgentPermissionsApi} that helps when dealing with permissions protocol records */
  private readonly permissionsApi: AgentPermissionsApi;

  constructor(options: {
    agent: EnboxAgent;
    connectedDid: string;
    delegateDid?: string;
    permissionsApi?: AgentPermissionsApi;
  }) {
    this.agent = options.agent;
    this._connectedDid = options.connectedDid;
    this.delegateDid = options.delegateDid;
    this.permissionsApi = options.permissionsApi ?? new AgentPermissionsApi({ agent: this.agent });
  }

  /** Whether this DWN API instance is operating as a delegate. */
  get isDelegate(): boolean {
    return this.delegateDid !== undefined;
  }

  /**
   * @internal
   * Imports a wallet-owned ProtocolsConfigure message into the local DWN.
   *
   * Delegate sessions use this after fetching the owner's signed protocol
   * configuration from the wallet DWN. The delegate does not receive a
   * Protocols.Configure grant and does not author a new protocol
   * configuration; it only stores the owner's already-signed message locally
   * so owner-tenant record operations can validate and encrypt against it.
   */
  async importProtocolConfiguration(
    protocolsConfigureMessage: DwnMessage[DwnInterface.ProtocolsConfigure],
  ): Promise<ProtocolsConfigureResponse> {
    const agentResponse = await this.agent.processDwnRequest({
      author      : this.connectedDid,
      rawMessage  : protocolsConfigureMessage,
      messageType : DwnInterface.ProtocolsConfigure,
      target      : this.connectedDid,
    });

    const { messageCid, reply: { status } } = agentResponse;
    const response: ProtocolsConfigureResponse = { status };

    if (status.code < 300 || status.code === 409) {
      const metadata = { author: this.connectedDid, messageCid };
      response.protocol = new Protocol(this.agent, protocolsConfigureMessage, metadata);
    }

    return response;
  }

  /**
   * API to interact with Grants
   *
   * NOTE: This is an EXPERIMENTAL API that will change behavior.
   *
   * Currently only supports issuing requests, grants, revokes and queries on behalf without permissions or impersonation.
   * If the agent is connected to a delegateDid, the delegateDid will be used to sign/author the underlying records.
   * If the agent is not connected to a delegateDid, the connectedDid will be used to sign/author the underlying records.
   *
   * @beta
   */
  get permissions(): {
      request: (request: Omit<CreateRequestParams, 'author'>) => Promise<PermissionRequest>;
      grant: (request: Omit<CreateGrantParams, 'author'>) => Promise<PermissionGrant>;
      queryRequests: (request?: FetchRequestsRequest) => Promise<PermissionRequest[]>;
      queryGrants: (request?: FetchGrantsRequest) => Promise<PermissionGrant[]>;
      } {
    return {
      /**
       * Request permission for a specific scope.
       */
      request: async(request: Omit<CreateRequestParams, 'author'>): Promise<PermissionRequest> => {
        const { message } = await this.permissionsApi.createRequest({
          ...request,
          author: this.delegateDid ?? this.connectedDid,
        });

        const requestParams = {
          connectedDid : this.delegateDid ?? this.connectedDid,
          agent        : this.agent,
          message,
        };

        return PermissionRequest.parse(requestParams);
      },
      /**
       * Grant permission for a specific scope to a grantee DID.
       */
      grant: async(request: Omit<CreateGrantParams, 'author'>): Promise<PermissionGrant> => {
        const { message } = await this.permissionsApi.createGrant({
          ...request,
          author: this.delegateDid ?? this.connectedDid,
        });

        const grantParams = {
          connectedDid : this.delegateDid ?? this.connectedDid,
          agent        : this.agent,
          message,
        };

        return PermissionGrant.parse(grantParams);
      },
      /**
       * Query permission requests. You can filter by protocol and specify if you want to query a remote DWN.
       */
      queryRequests: async(request: FetchRequestsRequest= {}): Promise<PermissionRequest[]> => {
        const { from, ...params } = request;
        const fetchResponse = await this.permissionsApi.fetchRequests({
          ...params,
          author : this.delegateDid ?? this.connectedDid,
          target : from ?? this.delegateDid ?? this.connectedDid,
          remote : from !== undefined,
        });

        const requests: PermissionRequest[] = [];
        for (const permission of fetchResponse) {
          const requestParams = {
            connectedDid : this.delegateDid ?? this.connectedDid,
            agent        : this.agent,
            message      : permission.message,
          };
          requests.push(PermissionRequest.parse(requestParams));
        }

        return requests;
      },
      /**
       * Query permission grants. You can filter by grantee, grantor, protocol and specify if you want to query a remote DWN.
       */
      queryGrants: async(request: FetchGrantsRequest = {}): Promise<PermissionGrant[]> => {
        const { from, ...params } = request;
        const remote = from !== undefined;
        const author = this.delegateDid ?? this.connectedDid;
        const target = from ?? this.delegateDid ?? this.connectedDid;
        const fetchResponse = await this.permissionsApi.fetchGrants({
          ...params,
          author,
          target,
          remote,
        });

        const grants: PermissionGrant[] = [];
        for (const permission of fetchResponse) {
          const grantParams = {
            connectedDid : this.delegateDid ?? this.connectedDid,
            agent        : this.agent,
            message      : permission.message,
          };

          grants.push(PermissionGrant.parse(grantParams));
        }

        return grants;
      }
    };
  }

  /**
   * API to interact with DWN protocols (e.g., `dwn.protocols.configure()`).
   */
  get protocols(): {
      configure: (request: ProtocolsConfigureRequest) => Promise<ProtocolsConfigureResponse>;
      query: (request: ProtocolsQueryRequest) => Promise<ProtocolsQueryResponse>;
      } {
    return {
      /**
       * Configure method, used to setup a new protocol (or update) with the passed definitions
       */
      configure: async (request: ProtocolsConfigureRequest): Promise<ProtocolsConfigureResponse> => {
        const { encryption, ...messageParams } = request;

        const agentRequest: ProcessDwnRequest<DwnInterface.ProtocolsConfigure> = {
          author      : this.connectedDid,
          messageParams,
          messageType : DwnInterface.ProtocolsConfigure,
          target      : this.connectedDid,
          encryption,
        };

        if (this.delegateDid) {
          const { message: delegatedGrant } = await this.permissionsApi.getPermissionForRequest({
            connectedDid : this.connectedDid,
            delegateDid  : this.delegateDid,
            protocol     : messageParams.definition.protocol,
            delegate     : true,
            cached       : true,
            messageType  : agentRequest.messageType
          });

          agentRequest.messageParams = {
            ...agentRequest.messageParams,
            delegatedGrant
          };
          agentRequest.granteeDid = this.delegateDid;
        }

        const agentResponse = await this.agent.processDwnRequest(agentRequest);

        const { message, messageCid, reply: { status } } = agentResponse;
        const response: ProtocolsConfigureResponse = { status };

        if (status.code < 300) {
          const metadata = { author: this.connectedDid, messageCid };
          response.protocol = new Protocol(this.agent, message, metadata);
        }

        return response;
      },

      /**
       * Query the available protocols
       */
      query: async (request: ProtocolsQueryRequest): Promise<ProtocolsQueryResponse> => {
        const { from, ...messageParams } = request;

        const agentRequest: ProcessDwnRequest<DwnInterface.ProtocolsQuery> = {
          author      : this.connectedDid,
          messageParams,
          messageType : DwnInterface.ProtocolsQuery,
          target      : from || this.connectedDid,
        };

        if (this.delegateDid) {
          // We attempt to get a grant within a try catch, if there is no grant we will still sign the query with the delegate DID's key
          // If the protocol is public, the query should be successful. This allows the app to query for public protocols without having a grant.

          try {
            const { grant: { id: permissionGrantId } } = await this.permissionsApi.getPermissionForRequest({
              connectedDid : this.connectedDid,
              delegateDid  : this.delegateDid,
              protocol     : messageParams.filter.protocol,
              cached       : true,
              messageType  : agentRequest.messageType
            });

            agentRequest.messageParams = {
              ...agentRequest.messageParams,
              permissionGrantId
            };
            agentRequest.granteeDid = this.delegateDid;
          } catch {
            // if a grant is not found, we should author the request as the delegated DID to get public protocols
            agentRequest.author = this.delegateDid;
          }
        }

        let agentResponse: DwnResponse<DwnInterface.ProtocolsQuery>;

        if (from) {
          agentResponse = await this.agent.sendDwnRequest(agentRequest);
        } else {
          agentResponse = await this.agent.processDwnRequest(agentRequest);
        }

        const reply = agentResponse.reply;
        const { entries = [], status } = reply;

        const protocols = entries.map((entry) => {
          const metadata = { author: this.connectedDid };
          return new Protocol(this.agent, entry, metadata);
        });

        return { protocols, status };
      }
    };
  }

  /**
   * API to observe the DWN's message-level change feed
   * (e.g., `dwn.messages.subscribe()`).
   */
  get messages(): {
      subscribe: (request?: MessagesSubscribeRequest) => Promise<MessagesSubscribeResponse>;
      } {

    return {
      /**
       * Subscribes to the tenant's message-level change feed. One `event`
       * fires per message recorded on the log across every interface the
       * `filters` cover (multiple filters per subscription), each carrying
       * the raw message plus a routing {@link MessageDescriptor}. Without a
       * `from`, the subscription targets the local store — and fires for
       * messages applied by sync as well, making it the primitive for
       * reactive local reads and cache invalidation.
       *
       * Delegated access resolves a `Messages.Read` grant when the filters
       * name exactly one protocol; multi-protocol delegated subscriptions
       * should pass explicit `permissionGrantIds`.
       */
      subscribe: async (request: MessagesSubscribeRequest = {}): Promise<MessagesSubscribeResponse> => {
        const { from, ...messageParams } = request;

        // Constructed BEFORE the request is dispatched: a local cursor
        // catch-up (and its EOSE) replays synchronously inside the subscribe
        // call, and must land in the query's pre-listener buffer, not a void.
        const liveQuery = new MessagesLiveQuery();

        const subscriptionHandler = (msg: DwnSubscriptionMessage): void => {
          if (msg.type === 'eose') {
            liveQuery.handleLifecycleEvent('eose');
            return;
          }

          if (msg.type === 'error') {
            liveQuery.handleError({
              code   : msg.error.code,
              detail : msg.error.detail,
              cursor : msg.cursor,
            });
            Promise.resolve(liveQuery.close()).catch(() => {});
            return;
          }

          if (msg.type === 'disconnected') {
            liveQuery.handleLifecycleEvent('disconnected');
            return;
          }

          if (msg.type === 'reconnected') {
            liveQuery.handleLifecycleEvent('reconnected');
            return;
          }

          if (msg.type === 'reconnecting') {
            liveQuery.handleLifecycleEvent('reconnecting', { attempt: msg.attempt });
            return;
          }

          const { message } = msg.event;
          liveQuery.handleEvent({
            message,
            descriptor : describeMessage(message),
            messageCid : msg.messageCid,
            cursor     : msg.cursor,
          });
        };

        const agentRequest: ProcessDwnRequest<DwnInterface.MessagesSubscribe> = {
          author      : this.connectedDid,
          messageParams,
          messageType : DwnInterface.MessagesSubscribe,
          target      : from || this.connectedDid,
          subscriptionHandler,
        };

        if (this.delegateDid) {
          if (messageParams.permissionGrantIds?.length) {
            // Caller-supplied grants win: no auto-resolution, no clobbering.
            agentRequest.granteeDid = this.delegateDid;
          } else {
            const protocols = [...new Set(
              (messageParams.filters ?? [])
                .map(filter => filter.protocol)
                .filter((protocol): protocol is string => protocol !== undefined),
            )];
            if (protocols.length !== 1) {
              // Deliberately OUTSIDE the grant-lookup try: a precondition
              // failure must reach the caller, not degrade into the
              // public fallback.
              throw new Error('DwnApi: delegated messages.subscribe requires a single-protocol filter set or explicit permissionGrantIds.');
            }
            try {
              const { grant } = await this.permissionsApi.getPermissionForRequest({
                connectedDid : this.connectedDid,
                delegateDid  : this.delegateDid,
                protocol     : protocols[0],
                cached       : true,
                messageType  : agentRequest.messageType,
              });

              agentRequest.messageParams = {
                ...agentRequest.messageParams,
                permissionGrantIds: [grant.id],
              };
              agentRequest.granteeDid = this.delegateDid;
            } catch {
              // Without a usable grant, author as the delegate — mirrors
              // records.subscribe: public/anonymous-visible messages only.
              agentRequest.author = this.delegateDid;
            }
          }
        }

        let agentResponse: DwnResponse<DwnInterface.MessagesSubscribe>;

        if (from) {
          agentResponse = await this.agent.sendDwnRequest(agentRequest);
        } else {
          agentResponse = await this.agent.processDwnRequest(agentRequest);
        }

        const { status, subscription } = agentResponse.reply;

        if (subscription === undefined) {
          return { status };
        }

        liveQuery.attachSubscription(subscription);
        return { status, liveQuery };
      },
    };
  }

  /**
   * API to interact with DWN records (e.g., `dwn.records.write()`).
   */
  get records(): {
      delete: (request: RecordsDeleteRequest) => Promise<DwnResponseStatus>;
      query: (request: RecordsQueryRequest) => Promise<RecordsQueryResponse>;
      queryAll: (request: RecordsQueryAllRequest) => AsyncGenerator<Record, void, undefined>;
      read: (request: RecordsReadRequest) => Promise<RecordsReadResponse>;
      subscribe: (request: RecordsSubscribeRequest) => Promise<RecordsSubscribeResponse>;
      write: (request: RecordsWriteRequest) => Promise<RecordsWriteResponse>;
      } {

    return {
      /**
       * Delete a record
       */
      delete: async (request: RecordsDeleteRequest): Promise<DwnResponseStatus> => {
        const { from, protocol, ...messageParams } = request;

        const agentRequest: ProcessDwnRequest<DwnInterface.RecordsDelete> = {
          /**
           * The `author` is the DID that will sign the message and must be the DID the Enbox app is
           * connected with and is authorized to access the signing private key of.
           */
          author      : this.connectedDid,
          messageParams,
          messageType : DwnInterface.RecordsDelete,
          /**
           * The `target` is the DID of the DWN tenant under which the delete will be executed.
           * If `from` is provided, the delete operation will be executed on a remote DWN.
           * Otherwise, the record will be deleted on the local DWN.
           */
          target      : from || this.connectedDid,
        };

        if (this.delegateDid) {
          const { message: delegatedGrant } = await this.permissionsApi.getPermissionForRequest({
            connectedDid : this.connectedDid,
            delegateDid  : this.delegateDid,
            protocol,
            delegate     : true,
            cached       : true,
            messageType  : agentRequest.messageType
          });

          agentRequest.messageParams = {
            ...agentRequest.messageParams,
            delegatedGrant
          };
          agentRequest.granteeDid = this.delegateDid;
        }

        let agentResponse: DwnResponse<DwnInterface.RecordsDelete>;

        if (from) {
          agentResponse = await this.agent.sendDwnRequest(agentRequest);
        } else {
          agentResponse = await this.agent.processDwnRequest(agentRequest);
        }

        const { reply: { status } } = agentResponse;

        return { status };
      },

      /**
       * Query a single or multiple records based on the given filter
       */
      query: async (request: RecordsQueryRequest): Promise<RecordsQueryResponse> => {
        const { from, encryption, ...messageParams } = request;

        const agentRequest: ProcessDwnRequest<DwnInterface.RecordsQuery> = {
          /**
           * The `author` is the DID that will sign the message and must be the DID the Enbox app is
           * connected with and is authorized to access the signing private key of.
           */
          author      : this.connectedDid,
          messageParams,
          messageType : DwnInterface.RecordsQuery,
          /**
           * The `target` is the DID of the DWN tenant under which the query will be executed.
           * If `from` is provided, the query operation will be executed on a remote DWN.
           * Otherwise, the local DWN will be queried.
           */
          target      : from || this.connectedDid,
          encryption,
        };

        if (this.delegateDid) {
          // if we don't find a delegated grant, we will attempt to query signing as the delegated DID
          // This is to allow the API caller to query public records without needing to impersonate the delegate.
          //
          // NOTE: For anonymous/public queries without explicit permissions, callers can use `DwnReaderApi` via `Enbox.anonymous()`.
          // See: https://github.com/enboxorg/enbox/issues/898
          try {
            const { message: delegatedGrant } = await this.permissionsApi.getPermissionForRequest({
              connectedDid : this.connectedDid,
              delegateDid  : this.delegateDid,
              protocol     : messageParams.filter?.protocol,
              delegate     : true,
              cached       : true,
              messageType  : agentRequest.messageType
            });

            agentRequest.messageParams = {
              ...agentRequest.messageParams,
              delegatedGrant
            };
            agentRequest.granteeDid = this.delegateDid;
          } catch {
            // if a grant is not found, we should author the request as the delegated DID to get public records
            agentRequest.author = this.delegateDid;
          }
        }

        let agentResponse: DwnResponse<DwnInterface.RecordsQuery>;

        if (from) {
          agentResponse = await this.agent.sendDwnRequest(agentRequest);
        } else {
          agentResponse = await this.agent.processDwnRequest(agentRequest);
        }

        const reply = agentResponse.reply;
        const { entries = [], status, cursor } = reply;

        const records = entries.map((entry) => {
          const recordOptions = {
            /**
             * Extract the `author` DID from the record entry since records may be signed by the
             * tenant owner or any other entity.
             */
            author       : getRecordAuthor(entry),
            /**
             * Set the `connectedDid` to currently connected DID so that subsequent calls to
             * {@link Record} instance methods, such as `record.update()` are executed on the
             * local DWN even if the record was returned by a query of a remote DWN.
             */
            connectedDid : this.connectedDid,
            /**
             * If the record was returned by a query of a remote DWN, set the `remoteOrigin` to
             * the DID of the DWN that returned the record. The `remoteOrigin` property will be used
             * to determine which DWN to send subsequent read requests to in the event the data
             * payload exceeds the threshold for being returned with queries.
             */
            remoteOrigin : from,
            delegateDid  : this.delegateDid,
            protocolRole : agentRequest.messageParams.protocolRole,
            ...entry as DwnMessage[DwnInterface.RecordsWrite]
          };
          const record = new Record(this.agent, recordOptions, this.permissionsApi);
          return record;
        });

        return { records, status, cursor };
      },

      /**
       * Drain every record matching the given filter, paging through query
       * results internally so callers never hand-write cursor loops.
       *
       * Returns an async generator — iterate it with `for await...of`. A page
       * that fails with a non-2xx status aborts the drain with a thrown Error
       * (an iterator has no clean status channel), as do the liveness guards:
       * a repeated pagination cursor, a run of consecutive empty
       * cursor-bearing pages, or an exceeded `maxPages` budget.
       */
      queryAll: (request: RecordsQueryAllRequest): AsyncGenerator<Record, void, undefined> => {
        // Validated at CALL time (not first iteration) so malformed budgets
        // fail loudly even if the generator is never consumed.
        assertValidQueryAllOptions(request);
        return this.queryAllRecords(request);
      },

      /**
       * Read a single record based on the given filter
       */
      read: async (request: RecordsReadRequest): Promise<RecordsReadResponse> => {
        const { from, protocol, encryption, ...messageParams } = request;

        const agentRequest: ProcessDwnRequest<DwnInterface.RecordsRead> = {
          /**
           * The `author` is the DID that will sign the message and must be the DID the Enbox app is
           * connected with and is authorized to access the signing private key of.
           */
          author      : this.connectedDid,
          messageParams,
          messageType : DwnInterface.RecordsRead,
          /**
           * The `target` is the DID of the DWN tenant under which the read will be executed.
           * If `from` is provided, the read operation will be executed on a remote DWN.
           * Otherwise, the read will occur on the local DWN.
           */
          target      : from || this.connectedDid,
          encryption,
        };

        if (this.delegateDid) {
          // if we don't find a delegated grant, we will attempt to read signing as the delegated DID
          // This is to allow the API caller to read public records without needing to impersonate the delegate.
          //
          // NOTE: For anonymous/public reads without explicit permissions, callers can use `DwnReaderApi` via `Enbox.anonymous()`.
          // See: https://github.com/enboxorg/enbox/issues/898

          try {
            const { message: delegatedGrant } = await this.permissionsApi.getPermissionForRequest({
              connectedDid : this.connectedDid,
              delegateDid  : this.delegateDid,
              protocol,
              delegate     : true,
              cached       : true,
              messageType  : agentRequest.messageType
            });

            agentRequest.messageParams = {
              ...agentRequest.messageParams,
              delegatedGrant
            };
            agentRequest.granteeDid = this.delegateDid;
          } catch {
            // if a grant is not found, we should author the request as the delegated DID to get public records
            agentRequest.author = this.delegateDid;
          }
        }

        let agentResponse: DwnResponse<DwnInterface.RecordsRead>;

        if (from) {
          agentResponse = await this.agent.sendDwnRequest(agentRequest);
        } else {
          agentResponse = await this.agent.processDwnRequest(agentRequest);
        }

        const { reply: { entry, status } } = agentResponse;

        let record: Record | undefined;
        if (200 <= status.code && status.code <= 299) {
          const recordOptions = {
            /**
             * Extract the `author` DID from the record since records may be signed by the
             * tenant owner or any other entity.
             */
            author       : getRecordAuthor(entry.recordsWrite),
            /**
             * Set the `connectedDid` to currently connected DID so that subsequent calls to
             * {@link Record} instance methods, such as `record.update()` are executed on the
             * local DWN even if the record was read from a remote DWN.
             */
            connectedDid : this.connectedDid,
            /**
             * If the record was returned by reading from a remote DWN, set the `remoteOrigin` to
             * the DID of the DWN that returned the record. The `remoteOrigin` property will be used
             * to determine which DWN to send subsequent read requests to in the event the data
             * payload must be read again (e.g., if the data stream is consumed).
             */
            remoteOrigin : from,
            delegateDid  : this.delegateDid,
            data         : entry.data,
            initialWrite : entry.initialWrite,
            ...entry.recordsWrite,
          };

          record = new Record(this.agent, recordOptions, this.permissionsApi);
        }

        return { record, status };
      },

      /**
       * Subscribe to records matching the given filter.
       *
       * Returns a {@link LiveQuery} that atomically provides an initial snapshot
       * of matching records and a real-time stream of deduplicated, semantically-
       * typed change events (`create`, `update`, `delete`).
       */
      subscribe: async (request: RecordsSubscribeRequest): Promise<RecordsSubscribeResponse> => {
        const { from, encryption, ...messageParams } = request;

        // Build a DWN-level subscription handler that wraps raw RecordEvents
        // into Record objects and feeds them into the LiveQuery.
        let liveQuery: LiveQuery | undefined;

        const remoteOrigin = from;
        const protocolRole = messageParams.protocolRole;

        const subscriptionHandler = (msg: DwnSubscriptionMessage): void => {
          if (msg.type === 'eose') {
            liveQuery?.handleLifecycleEvent('eose');
            return;
          }

          if (msg.type === 'error') {
            liveQuery?.handleError({
              code   : msg.error.code,
              detail : msg.error.detail,
              cursor : msg.cursor,
            });
            Promise.resolve(liveQuery?.close()).catch(() => {});
            return;
          }

          if (msg.type === 'disconnected') {
            liveQuery?.handleLifecycleEvent('disconnected');
            return;
          }

          if (msg.type === 'reconnected') {
            liveQuery?.handleLifecycleEvent('reconnected');
            return;
          }

          if (msg.type === 'reconnecting') {
            liveQuery?.handleLifecycleEvent('reconnecting', { attempt: msg.attempt });
            return;
          }

          const { message, initialWrite } = msg.event;
          const record = new Record(this.agent, {
            ...message as DwnMessage[DwnInterface.RecordsWrite],
            author       : getRecordAuthor(message as DwnMessage[DwnInterface.RecordsWrite]),
            connectedDid : this.connectedDid,
            remoteOrigin,
            initialWrite : initialWrite,
            protocolRole,
            delegateDid  : this.delegateDid,
            // Only when subscription decryption is enabled: attach the event's
            // inline payload (already decrypted by the agent) so `record.data`
            // serves plaintext without a read round-trip. When absent — data
            // too large to inline, or ciphertext withheld after a decryption
            // failure — the lazy read path decrypts on access instead.
            ...(encryption && msg.encodedData !== undefined ? { encodedData: msg.encodedData } : {}),
          }, this.permissionsApi);

          liveQuery?.handleEvent(record);
        };

        const agentRequest: ProcessDwnRequest<DwnInterface.RecordsSubscribe> = {
          author      : this.connectedDid,
          messageParams,
          messageType : DwnInterface.RecordsSubscribe,
          target      : from || this.connectedDid,
          subscriptionHandler,
          encryption,
        };

        if (this.delegateDid) {
          // if we don't find a delegated grant, we will attempt to subscribe signing as the delegated DID
          // This is to allow the API caller to subscribe to public records without needing to impersonate the delegate.
          //
          // NOTE: For anonymous/public subscriptions without explicit permissions, callers can use `DwnReaderApi` via `Enbox.anonymous()`.
          // See: https://github.com/enboxorg/enbox/issues/898
          try {
            const { message: delegatedGrant } = await this.permissionsApi.getPermissionForRequest({
              connectedDid : this.connectedDid,
              delegateDid  : this.delegateDid,
              protocol     : messageParams.filter?.protocol,
              delegate     : true,
              cached       : true,
              messageType  : agentRequest.messageType
            });

            agentRequest.messageParams = {
              ...agentRequest.messageParams,
              delegatedGrant
            };
            agentRequest.granteeDid = this.delegateDid;
          } catch {
            // if a grant is not found, we should author the request as the delegated DID to get public records
            agentRequest.author = this.delegateDid;
          }
        }

        let agentResponse: DwnResponse<DwnInterface.RecordsSubscribe>;

        if (from) {
          agentResponse = await this.agent.sendDwnRequest(agentRequest);
        } else {
          agentResponse = await this.agent.processDwnRequest(agentRequest);
        }

        const reply = agentResponse.reply;
        const { status, subscription, entries = [], cursor } = reply;

        if (subscription) {
          liveQuery = new LiveQuery({
            agent          : this.agent,
            connectedDid   : this.connectedDid,
            delegateDid    : this.delegateDid,
            protocolRole,
            remoteOrigin,
            permissionsApi : this.permissionsApi,
            initialEntries : entries,
            cursor,
            subscription,
          });
        }

        return { status, liveQuery };
      },

      /**
       * Writes a record to the DWN
       *
       * As a convenience, the Record instance returned will cache a copy of the data.  This is done
       * to maintain consistency with other DWN methods, like RecordsQuery, that include relatively
       * small data payloads when returning RecordsWrite message properties. Regardless of data
       * size, methods such as `record.data.stream()` will return the data when called even if it
       * requires fetching from the DWN datastore.
       */
      write: async (request: RecordsWriteRequest): Promise<RecordsWriteResponse> => {
        const { data, from, store, encryption, recipientRolePublicKey, ...restParams } = request;
        const { dataBlob, dataFormat } = dataToBlob(data, restParams.dataFormat);

        const messageParams = { ...restParams, dataFormat };

        const dwnRequestParams: ProcessDwnRequest<DwnInterface.RecordsWrite> = {
          store,
          messageType : DwnInterface.RecordsWrite,
          messageParams,
          /**
           * The `author` is the DID that will sign the message and must be the DID the Enbox app
           * is connected with — even for cross-tenant writes, the grantee signs as themselves.
           */
          author      : this.connectedDid,
          /**
           * The `target` is the DID of the DWN tenant the record will be written to. If `from` is
           * provided, the write is dispatched to that tenant's remote DWN (mirroring the remote
           * branch reads use). Otherwise, the record is written to the local DWN.
           */
          target      : from ?? this.connectedDid,
          dataStream  : dataBlob,
          encryption,
          /**
           * Forwarded verbatim on both paths: the agent REJECTS a supplied key on the remote
           * (`sendDwnRequest`) path — role-audience key delivery is provisioned via local
           * `processRequest` only — so caller misuse surfaces as a thrown error, never a
           * silently dropped key.
           */
          recipientRolePublicKey,
        };

        // if impersonation is enabled, fetch the delegated grant to use with the write operation
        if (this.delegateDid) {
          const { message: delegatedGrant } = await this.permissionsApi.getPermissionForRequest({
            connectedDid : this.connectedDid,
            delegateDid  : this.delegateDid,
            protocol     : messageParams.protocol,
            delegate     : true,
            cached       : true,
            messageType  : dwnRequestParams.messageType
          });

          dwnRequestParams.messageParams = {
            ...dwnRequestParams.messageParams,
            delegatedGrant
          };
          dwnRequestParams.granteeDid = this.delegateDid;
        }

        let agentResponse: DwnResponse<DwnInterface.RecordsWrite>;

        if (from) {
          agentResponse = await this.agent.sendDwnRequest(dwnRequestParams);
        } else {
          agentResponse = await this.agent.processDwnRequest(dwnRequestParams);
        }

        // NOTE: `audienceKeyDelivery` is populated by local processing only — the remote
        // (`sendDwnRequest`) branch never reports one, and none is ever fabricated for it.
        const { message: responseMessage, reply: { status }, audienceKeyDelivery } = agentResponse;

        let record: Record | undefined;
        if (200 <= status.code && status.code <= 299) {
          const recordOptions = {
            /**
             * Assume the author is the connected DID since the record was just signed and written
             * with the connected DID's key — for cross-tenant writes, the grantee authors the
             * record in the owner's tenant.
             */
            author       : this.connectedDid,
            /**
             * Set the `connectedDid` to currently connected DID so that subsequent calls to
             * {@link Record} instance methods, such as `record.update()` are executed on the
             * local DWN.
             */
            connectedDid : this.connectedDid,
            /**
             * If the record was written to a remote DWN, set the `remoteOrigin` to the DID of the
             * target tenant so that subsequent data reads (e.g. `record.data`) are dispatched to
             * the owner tenant that actually stores the record.
             */
            remoteOrigin : from,
            /**
             * Stamp the invoked role so follow-up operations on the returned record (data
             * re-reads, updates) carry the same authorization the write used — mirroring how
             * query/read/subscribe results are stamped.
             */
            protocolRole : messageParams.protocolRole,
            encodedData  : dataBlob,
            delegateDid  : this.delegateDid,
            ...responseMessage,
          };

          record = new Record(this.agent, recordOptions, this.permissionsApi);
        }

        return { record, status, ...(audienceKeyDelivery ? { audienceKeyDelivery } : {}) };
      },
    };
  }

  /**
   * Drains every record matching the given query request by paging through
   * results until the pagination cursor is exhausted (or the `maxRecords`
   * safety cap is reached). Backs `records.queryAll()`.
   *
   * Liveness guards — a remote (or store) must never be able to hold the
   * drain in an infinite loop:
   * - a page that returns the SAME cursor it was requested with terminates
   *   with a thrown error (a repeated cursor is never legitimate);
   * - a run of {@link DwnApi.QUERY_ALL_MAX_CONSECUTIVE_EMPTY_PAGES}
   *   consecutive empty-but-cursor-bearing pages terminates with a thrown
   *   error (a page with records resets the run);
   * - the overall `maxPages` budget (default
   *   {@link DwnApi.QUERY_ALL_DEFAULT_MAX_PAGES}) terminates with a thrown
   *   error independent of `maxRecords`, which only counts yielded records.
   *
   * @throws `Error` when any underlying query page returns a non-2xx status,
   *   or when a liveness guard trips.
   */
  private async * queryAllRecords(request: RecordsQueryAllRequest): AsyncGenerator<Record, void, undefined> {
    const {
      pageSize = DwnApi.QUERY_ALL_DEFAULT_PAGE_SIZE,
      maxRecords,
      maxPages = DwnApi.QUERY_ALL_DEFAULT_MAX_PAGES,
      ...queryRequest
    } = request;

    let cursor: DwnPaginationCursor | undefined;
    let consecutiveEmptyPages = 0;
    let pagesFetched = 0;
    let yielded = 0;

    do {
      DwnApi.assertQueryAllPageBudget(pagesFetched, maxPages);

      const { status, records, cursor: nextCursor } = await this.records.query({
        ...queryRequest,
        pagination: { limit: pageSize, cursor },
      });
      pagesFetched += 1;

      DwnApi.assertQueryAllPageSucceeded(status);

      for (const record of records) {
        if (maxRecords !== undefined && yielded >= maxRecords) {
          return;
        }
        yield record;
        yielded += 1;
      }

      consecutiveEmptyPages = DwnApi.nextQueryAllEmptyPageCount({
        consecutiveEmptyPages,
        cursor,
        nextCursor,
        recordCount: records.length,
      });

      cursor = nextCursor;
    } while (cursor !== undefined && (maxRecords === undefined || yielded < maxRecords));
  }
}
