/**
 * NOTE: Added reference types here to avoid a `pnpm` bug during build.
 * https://github.com/enboxorg/enbox/pull/507
 */
/// <reference types="@enbox/dwn-sdk-js" />

import type {
  CreateGrantParams,
  CreateRequestParams,
  DwnMessage,
  DwnMessageParams,
  DwnPaginationCursor,
  DwnResponse,
  DwnResponseStatus,
  FetchPermissionRequestParams,
  FetchPermissionsParams,
  ProcessDwnRequest,
  Web5Agent } from '@enbox/agent';

import type { DwnSubscriptionMessage } from '@enbox/dwn-clients';

import {
  AgentPermissionsApi,
} from '@enbox/agent';

import { DwnInterface, getRecordAuthor } from '@enbox/agent';

import { dataToBlob } from './utils.js';
import { LiveQuery } from './live-query.js';
import { PermissionGrant } from './permission-grant.js';
import { PermissionRequest } from './permission-request.js';
import { Protocol } from './protocol.js';
import { Record } from './record.js';

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
 * Revoked grants are filtered out by default; set `checkRevoked: false` to include them.
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
  /** When true, derives and injects $encryption public keys into the protocol definition. */
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
};

/** Encapsulates the response from a DWN RecordsSubscribeRequest. */
export type RecordsSubscribeResponse = DwnResponseStatus & {
  /** The live query instance, or `undefined` if the request failed. */
  liveQuery?: LiveQuery;
};

/**
 * Defines a request to write (create) a record to a Decentralized Web Node (DWN).
 *
 * This request type allows specifying the data for the new or updated record, along with any
 * additional message parameters required for the write operation, and an optional flag to indicate
 * whether the record should be immediately stored.
 */
export type RecordsWriteRequest = Omit<Partial<DwnMessageParams[DwnInterface.RecordsWrite]>, 'signer' | 'data' | 'protocol' | 'protocolPath'> &
  Pick<DwnMessageParams[DwnInterface.RecordsWrite], 'protocol' | 'protocolPath'> & {
  /** The data payload for the record, which can be of any type. */
  data: unknown;

  /**
   * Optional flag indicating whether the record should be immediately stored. If true, the record
   * is persisted in the DWN as part of the write operation. If false, the record is created,
   * signed, and returned but not persisted.
   */
  store?: boolean;

  /** When true, automatically encrypts the record data using the protocol's encryption keys. */
  encryption?: boolean;
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
};

/**
 * Interface to interact with DWN Records and Protocols
 */
export class DwnApi {
  /**
   * Holds the instance of a {@link Web5Agent} that represents the current execution context for
   * the `DwnApi`. This agent is used to process DWN requests.
   */
  private agent: Web5Agent;

  /** The DID of the DWN tenant under which operations are being performed. */
  private connectedDid: string;

  /** (optional) The DID of the signer when signing with permissions */
  private delegateDid?: string;

  /** Holds the instance of {@link AgentPermissionsApi} that helps when dealing with permissions protocol records */
  private permissionsApi: AgentPermissionsApi;

  constructor(options: { agent: Web5Agent, connectedDid: string, delegateDid?: string }) {
    this.agent = options.agent;
    this.connectedDid = options.connectedDid;
    this.delegateDid = options.delegateDid;
    this.permissionsApi = new AgentPermissionsApi({ agent: this.agent });
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
   * API to interact with DWN records (e.g., `dwn.records.write()`).
   */
  get records(): {
      delete: (request: RecordsDeleteRequest) => Promise<DwnResponseStatus>;
      query: (request: RecordsQueryRequest) => Promise<RecordsQueryResponse>;
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
           * The `author` is the DID that will sign the message and must be the DID the Web5 app is
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
           * The `author` is the DID that will sign the message and must be the DID the Web5 app is
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
          // NOTE: For anonymous/public queries without explicit permissions, callers can use `DwnReaderApi` via `Web5.anonymous()`.
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
       * Read a single record based on the given filter
       */
      read: async (request: RecordsReadRequest): Promise<RecordsReadResponse> => {
        const { from, protocol, encryption, ...messageParams } = request;

        const agentRequest: ProcessDwnRequest<DwnInterface.RecordsRead> = {
          /**
           * The `author` is the DID that will sign the message and must be the DID the Web5 app is
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
          // NOTE: For anonymous/public reads without explicit permissions, callers can use `DwnReaderApi` via `Web5.anonymous()`.
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
        const { from, ...messageParams } = request;

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
            initialWrite : initialWrite as DwnMessage[DwnInterface.RecordsWrite] | undefined,
            protocolRole,
            delegateDid  : this.delegateDid,
          }, this.permissionsApi);

          liveQuery?.handleEvent(record);
        };

        const agentRequest: ProcessDwnRequest<DwnInterface.RecordsSubscribe> = {
          author      : this.connectedDid,
          messageParams,
          messageType : DwnInterface.RecordsSubscribe,
          target      : from || this.connectedDid,
          subscriptionHandler,
        };

        if (this.delegateDid) {
          // if we don't find a delegated grant, we will attempt to subscribe signing as the delegated DID
          // This is to allow the API caller to subscribe to public records without needing to impersonate the delegate.
          //
          // NOTE: For anonymous/public subscriptions without explicit permissions, callers can use `DwnReaderApi` via `Web5.anonymous()`.
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
        const { data, store, encryption, ...restParams } = request;
        const { dataBlob, dataFormat } = dataToBlob(data, restParams.dataFormat);

        const messageParams = { ...restParams, dataFormat };

        const dwnRequestParams: ProcessDwnRequest<DwnInterface.RecordsWrite> = {
          store,
          messageType : DwnInterface.RecordsWrite,
          messageParams,
          author      : this.connectedDid,
          target      : this.connectedDid,
          dataStream  : dataBlob,
          encryption,
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

        const agentResponse = await this.agent.processDwnRequest(dwnRequestParams);

        const { message: responseMessage, reply: { status } } = agentResponse;

        let record: Record | undefined;
        if (200 <= status.code && status.code <= 299) {
          const recordOptions = {
            /**
             * Assume the author is the connected DID since the record was just written to the
             * local DWN.
             */
            author       : this.connectedDid,
            /**
             * Set the `connectedDid` to currently connected DID so that subsequent calls to
             * {@link Record} instance methods, such as `record.update()` are executed on the
             * local DWN.
             */
            connectedDid : this.connectedDid,
            encodedData  : dataBlob,
            delegateDid  : this.delegateDid,
            ...responseMessage,
          };

          record = new Record(this.agent, recordOptions, this.permissionsApi);
        }

        return { record, status };
      },
    };
  }
}