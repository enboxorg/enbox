/**
 * NOTE: Added reference types here to avoid a `pnpm` bug during build.
 * https://github.com/enboxorg/enbox/pull/507
 */
/// <reference types="@enbox/dwn-sdk-js" />

import type { DwnSubscriptionHandler, DwnSubscriptionMessage } from '@enbox/dwn-clients';

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

import type { MessagesFilter, MessagesSubscribeReply, RecordsSubscribeReply } from '@enbox/dwn-sdk-js';

import type { RecordDataAccess, RecordExecutionContext, RecordOptions, StoredRecordData } from './record-types.js';

import { captureRecordDataAccess } from './record-data-access.js';
import { ContextNotReadyError } from './context-errors.js';
import { dataToBlob } from './utils.js';
import { DwnResponseError } from './dwn-response-error.js';
import { PermissionGrant } from './permission-grant.js';
import { PermissionRequest } from './permission-request.js';
import { Protocol } from './protocol.js';
import { Record } from './record.js';
import { Records } from '@enbox/dwn-sdk-js';
import { AgentPermissionsApi, DwnInterface, getRecordAuthor, PermissionGrantNotFoundError } from '@enbox/agent';

type ReadInterface =
  | DwnInterface.MessagesSubscribe
  | DwnInterface.RecordsCount
  | DwnInterface.RecordsQuery
  | DwnInterface.RecordsRead
  | DwnInterface.RecordsSubscribe;

type ReadScope = {
  protocol?: string;
  protocolPath?: string;
  contextId?: string;
};

type MissingReadGrantPolicy = 'fallback' | 'reject';

type RecordMutationReadResponse<T = unknown> = RecordsReadResponse<T> & {
  /** Whether the authority returned an existing tombstone, and whether it prunes descendants. */
  tombstonePrune?: boolean;
};

/** A delete converged only when this tombstone was stored or another tombstone already wins. */
function isDurableRecordsDeleteStatus(code: number): boolean {
  return (code >= 200 && code < 300) || code === 409;
}

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
export type ProtocolsConfigureRequest = Omit<DwnMessageParams[DwnInterface.ProtocolsConfigure], 'signer'>;

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
 * Encapsulates a request to count records in a Decentralized Web Node (DWN).
 *
 * If the `from` property is not provided, the local DWN will be counted. If `from` is provided,
 * the count will be performed against the specified remote DWN tenant.
 */
export type RecordsCountRequest = Omit<DwnMessageParams[DwnInterface.RecordsCount], 'signer'> & {
  /** Optional DID specifying the remote target DWN tenant whose records will be counted. */
  from?: string;
};

/**
 * Represents the response from a records count operation.
 *
 * A successful count always includes `count`, including `0` when no records match. Error replies
 * leave `count` undefined so callers can distinguish an empty result from a failed request.
 */
export type RecordsCountResponse = DwnResponseStatus & {
  /** The number of matching records, or `undefined` when the request failed. */
  count?: number;
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

  /** Protocol path for permission grant resolution. This field is not sent in the delete message. */
  protocolPath?: string;

  /** Context ID for permission grant resolution. This field is not sent in the delete message. */
  contextId?: string;
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
};

/**
 * Represents the response from a records query operation, including status, records, and an
 * optional pagination cursor.
 *
 * @typeParam T - The payload type exposed by each returned record.
 */
export type RecordsQueryResponse<T = unknown> = DwnResponseStatus & {
  /** Array of records matching the query. */
  records: Record<T>[];

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
};

/**
 * Encapsulates the response from a record read operation, combining the general operation status
 * with the specific record that was retrieved.
 *
 * When the status code is not in the 2xx range (e.g. 401, 404), `record` will be `undefined`.
 * Always check `status.code` before accessing the record.
 *
 * @typeParam T - The payload type exposed by the returned record.
 */
export type RecordsReadResponse<T = unknown> = DwnResponseStatus & {
  /** The record retrieved by the read operation, or `undefined` if the request failed. */
  record: Record<T> | undefined;
};

/**
 * Represents a raw RecordsSubscribe request to a Decentralized Web Node (DWN).
 * The callback must be installed before dispatch so it can receive synchronous
 * catch-up events as well as later transport lifecycle messages.
 */
export type RecordsSubscribeRequest = Omit<DwnMessageParams[DwnInterface.RecordsSubscribe], 'signer'> & {
  /** Optional DID specifying the remote target DWN tenant to subscribe from. */
  from?: string;

  /** Receives raw record events and subscription lifecycle messages. */
  subscriptionHandler: DwnSubscriptionHandler;
};

/** The unmodified DWN RecordsSubscribe reply. */
export type RecordsSubscribeResponse = RecordsSubscribeReply;

/**
 * Represents a request to subscribe to the message-level change feed of a
 * Decentralized Web Node (DWN) tenant.
 *
 * This is the low-level message-log change signal used by higher-level
 * materialized views: subscription payloads are wake hints, never collection
 * truth.
 */
export type MessagesSubscribeRequest = Omit<DwnMessageParams[DwnInterface.MessagesSubscribe], 'signer'> & {
  /** Optional DID specifying the remote target DWN tenant to subscribe from. */
  from?: string;

  /** Receives raw message events and subscription lifecycle messages. */
  subscriptionHandler: DwnSubscriptionHandler;
};

/** The unmodified DWN MessagesSubscribe reply. */
export type MessagesSubscribeResponse = MessagesSubscribeReply;

/**
 * Defines a request to write (create) a record to a Decentralized Web Node (DWN).
 *
 * This request type allows specifying the data for the new or updated record, along with any
 * additional message parameters required for the write operation, and an optional flag to indicate
 * whether the record should be immediately stored.
 */
export type RecordsWriteRequest = Omit<
  Partial<DwnMessageParams[DwnInterface.RecordsWrite]>,
  'signer' | 'data' | 'protocol' | 'protocolPath' | 'encryption' | 'encryptionInput'
> &
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
   * grant parameters (`permissionGrantId`/`delegatedGrant`). The returned {@link Record} captures
   * the successful request's remote routing and authorization context for later data reads.
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
 *
 * @typeParam T - The payload type exposed by the returned record.
 */
export type RecordsWriteResponse<T = unknown> = DwnResponseStatus & {
  /**
   * The `Record` instance representing the record that was successfully written to the
   * DWN as a result of the write operation, or `undefined` if the write failed.
   *
   * Always check `status.code` before accessing the record.
   */
  record: Record<T> | undefined;

  /**
   * Outcome of role-audience key delivery provisioning, forwarded from the agent. Present only
   * for accepted `$role` record writes with a `recipient` that triggered delivery provisioning.
   *
   * On the best-effort path (no `recipientRolePublicKey` supplied), a recipient whose role-path
   * key could not be resolved is reported here with `delivered: false` instead of failing the
   * write. The owned-context membership API projects and retries the persisted lifecycle without
   * exposing role-record IDs to application code.
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
  /**
   * Applies delegated authorization shared by read-shaped records requests
   * and context-bound message subscriptions.
   */
  private async prepareReadRequest<T extends ReadInterface>(
    request: ProcessDwnRequest<T>,
    scope: ReadScope,
    missingGrantPolicy: MissingReadGrantPolicy = 'fallback',
  ): Promise<ProcessDwnRequest<T>> {
    if (this.delegateDid === undefined) {
      return request;
    }

    try {
      const { message: delegatedGrant } = await this.permissionsApi.getPermissionForRequest({
        connectedDid : this.connectedDid,
        delegateDid  : this.delegateDid,
        protocol     : scope.protocol,
        protocolPath : scope.protocolPath,
        contextId    : scope.contextId,
        delegate     : true,
        messageType  : request.messageType,
      });

      return {
        ...request,
        messageParams: {
          ...request.messageParams,
          delegatedGrant,
        },
        granteeDid: this.delegateDid,
      };
    } catch (error: unknown) {
      if (!(error instanceof PermissionGrantNotFoundError) || missingGrantPolicy === 'reject') {
        throw error;
      }
      // A delegate without a matching owner grant can still request records
      // visible to the delegate itself, including public records.
      return { ...request, author: this.delegateDid };
    }
  }

  /** Execute one RecordsQuery with the selected delegated-grant policy. */
  private async queryRecords(
    request: RecordsQueryRequest,
    missingGrantPolicy: MissingReadGrantPolicy,
    authoritativeContext: boolean = false,
  ): Promise<RecordsQueryResponse> {
    const { from, ...requestedMessageParams } = request;
    const { messageParams, remoteTarget, target } = await this.resolveRecordsRoute(
      from,
      requestedMessageParams,
      authoritativeContext,
    );

    const agentRequest = await this.prepareReadRequest({
      author      : this.connectedDid,
      messageParams,
      messageType : DwnInterface.RecordsQuery,
      target,
    }, {
      protocol     : messageParams.filter?.protocol,
      protocolPath : messageParams.filter?.protocolPath,
      contextId    : messageParams.filter?.contextId,
    }, missingGrantPolicy);

    const agentResponse = await this.dispatchDwnRequest(agentRequest, remoteTarget);
    const { entries = [], status, cursor } = agentResponse.reply;
    const dataAccess = captureRecordDataAccess(agentRequest, remoteTarget !== undefined);
    const records = entries.map((entry) => {
      const { encodedData, initialWrite, ...recordsWrite } = entry;
      return this.createRecordHandle({
        dataAccess,
        initialWrite,
        message      : recordsWrite as DwnMessage[DwnInterface.RecordsWrite],
        protocolRole : agentRequest.messageParams.protocolRole,
        storedData   : encodedData,
      });
    });

    return { records, status, cursor };
  }

  /** Execute one RecordsRead, optionally routing a bound context to its authority. */
  private async readRecord(
    request: RecordsReadRequest,
    authoritativeContext: boolean,
  ): Promise<RecordMutationReadResponse> {
    const { from, ...requestedMessageParams } = request;
    const { messageParams, remoteTarget, target } = await this.resolveRecordsRoute(
      from,
      requestedMessageParams,
      authoritativeContext,
    );

    const agentRequest = await this.prepareReadRequest({
      author      : this.connectedDid,
      messageParams,
      messageType : DwnInterface.RecordsRead,
      target,
    }, {
      protocol     : messageParams.filter?.protocol,
      protocolPath : messageParams.filter?.protocolPath,
      contextId    : messageParams.filter?.contextId,
    });

    const agentResponse = await this.dispatchDwnRequest(agentRequest, remoteTarget);
    const { entry, roleRecordId, status } = agentResponse.reply;

    let record: Record | undefined;
    if (200 <= status.code && status.code <= 299) {
      record = this.createRecordHandle({
        dataAccess   : captureRecordDataAccess(agentRequest, remoteTarget !== undefined),
        initialWrite : entry.initialWrite,
        message      : entry.recordsWrite,
        protocolRole : agentRequest.messageParams.protocolRole,
        storedData   : entry.data,
      });
    }

    const tombstonePrune = authoritativeContext && entry?.recordsDelete !== undefined
      ? entry.recordsDelete.descriptor.prune === true
      : undefined;

    const followedSourceId = this.recordExecutionContext?.followedSourceId;
    if ((record !== undefined || tombstonePrune !== undefined)
      && followedSourceId !== undefined
      && roleRecordId !== followedSourceId) {
      throw new ContextNotReadyError(
        new Error('DwnApi: the active context role changed while reading the record authority.'),
      );
    }
    return {
      record,
      status,
      ...(tombstonePrune === undefined ? {} : { tombstonePrune }),
    };
  }

  /** @internal Read the authority before a context-bound read/modify/write operation. */
  public readRecordForMutation(request: RecordsReadRequest): Promise<RecordMutationReadResponse> {
    return this.readRecord(request, true);
  }

  /** Dispatches one prepared request through the local or remote agent path. */
  private dispatchDwnRequest<T extends DwnInterface>(
    request: ProcessDwnRequest<T>,
    remoteTarget?: string,
  ): Promise<DwnResponse<T>> {
    return remoteTarget
      ? this.agent.sendDwnRequest(request)
      : this.agent.processDwnRequest(request);
  }

  /** Build a RecordsDelete request with its routing and delegated authority resolved once. */
  private async prepareDeleteRecord(request: RecordsDeleteRequest): Promise<{
    agentRequest: ProcessDwnRequest<DwnInterface.RecordsDelete>;
    remoteTarget?: string;
  }> {
    const { from, protocol, protocolPath, contextId, ...requestedMessageParams } = request;
    const { messageParams, remoteTarget, target } = await this.resolveRecordsRoute(
      from,
      requestedMessageParams,
      true,
    );

    const agentRequest: ProcessDwnRequest<DwnInterface.RecordsDelete> = {
      author      : this.connectedDid,
      messageParams,
      messageType : DwnInterface.RecordsDelete,
      target,
    };

    if (this.delegateDid) {
      const { message: delegatedGrant } = await this.permissionsApi.getPermissionForRequest({
        connectedDid : this.connectedDid,
        delegateDid  : this.delegateDid,
        protocol,
        protocolPath,
        contextId,
        delegate     : true,
        messageType  : agentRequest.messageType
      });

      agentRequest.messageParams = {
        ...agentRequest.messageParams,
        delegatedGrant
      };
      agentRequest.granteeDid = this.delegateDid;
    }

    return { agentRequest, remoteTarget };
  }

  /** Construct a canonical record handle from a DWN response message. */
  private createRecordHandle(params: {
    dataAccess: RecordDataAccess;
    initialWrite?: DwnMessage[DwnInterface.RecordsWrite];
    message: DwnMessage[DwnInterface.RecordsWrite | DwnInterface.RecordsDelete];
    protocolRole?: string;
    storedData?: StoredRecordData;
  }): Record {
    const options = {
      author       : getRecordAuthor(params.message),
      connectedDid : this.connectedDid,
      dataAccess   : params.dataAccess,
      delegateDid  : this.delegateDid,
      protocolRole : params.protocolRole,
      ...params.message,
      ...(params.initialWrite === undefined ? {} : { initialWrite: params.initialWrite }),
      ...(params.storedData === undefined ? {} : { storedData: params.storedData }),
    } as RecordOptions;

    return new Record(this.agent, options, this.permissionsApi, this.recordExecutionContext);
  }

  /** Open one RecordsSubscribe after its authorization context is fully resolved. */
  private async openRecordsSubscription(
    request: Omit<RecordsSubscribeRequest, 'subscriptionHandler'>,
    subscriptionHandler: DwnSubscriptionHandler,
  ): Promise<RecordsSubscribeResponse> {
    const { from, ...requestedMessageParams } = request;
    const { messageParams, remoteTarget, target } = await this.resolveRecordsRoute(
      from,
      requestedMessageParams,
      false,
    );

    const agentRequest = await this.prepareReadRequest({
      author      : this.connectedDid,
      messageParams,
      messageType : DwnInterface.RecordsSubscribe,
      target,
      subscriptionHandler,
    }, {
      protocol     : messageParams.filter?.protocol,
      protocolPath : messageParams.filter?.protocolPath,
      contextId    : messageParams.filter?.contextId,
    });

    return (await this.dispatchDwnRequest(agentRequest, remoteTarget)).reply;
  }

  /** @internal Subscribe to exact record paths with canonical frame records attached. */
  public async subscribeRecordFrames(
    request: { paths: readonly string[]; protocol: string },
    subscriptionHandler: (message: DwnSubscriptionMessage, record?: Record) => void | Promise<void>,
  ): Promise<MessagesSubscribeResponse> {
    const contextId = this.recordExecutionContext?.contextId;
    const filters: MessagesFilter[] = request.paths.map(protocolPath => ({
      interface : 'Records',
      protocol  : request.protocol,
      protocolPath,
      ...(contextId === undefined ? {} : { contextIdPrefix: contextId }),
    }));
    const requestedMessageParams: { filters: MessagesFilter[]; protocolRole?: string } = {
      filters,
    };
    const { messageParams, target } = await this.resolveRecordsRoute(
      undefined,
      requestedMessageParams,
      false,
    );
    const dataRequest = await this.prepareReadRequest({
      author        : this.connectedDid,
      messageParams : {
        filter       : { protocol: request.protocol, ...(contextId === undefined ? {} : { contextId }) },
        protocolRole : messageParams.protocolRole,
      },
      messageType: DwnInterface.RecordsRead,
      target,
    }, { contextId, protocol: request.protocol }, 'reject');
    const dataAccess = captureRecordDataAccess(dataRequest, false);
    const handleFrame = (message: DwnSubscriptionMessage): void | Promise<void> => {
      if (message.type !== 'event') {
        return subscriptionHandler(message);
      }

      const descriptor = message.event.message.descriptor;
      if (descriptor.interface !== 'Records'
        || (descriptor.method !== 'Write' && descriptor.method !== 'Delete')) {
        return;
      }
      const recordsWrite = Records.isRecordsWrite(message.event.message)
        ? message.event.message
        : message.event.initialWrite;
      if (recordsWrite === undefined
        || recordsWrite.descriptor.protocol !== request.protocol
        || !request.paths.includes(recordsWrite.descriptor.protocolPath ?? '')) {
        return;
      }
      const record = this.createRecordHandle({
        dataAccess,
        initialWrite : message.event.initialWrite,
        message      : message.event.message as DwnMessage[DwnInterface.RecordsWrite | DwnInterface.RecordsDelete],
        protocolRole : messageParams.protocolRole,
        storedData   : message.encodedData,
      });
      return subscriptionHandler(message, record);
    };

    if (messageParams.protocolRole === undefined) {
      return this.messages.subscribe({ filters, subscriptionHandler: handleFrame });
    }

    const pendingFrames: DwnSubscriptionMessage[] = [];
    let roleVerified = false;
    const agentRequest = await this.prepareReadRequest({
      author              : this.connectedDid,
      messageParams,
      messageType         : DwnInterface.MessagesSubscribe,
      target,
      subscriptionHandler : (message): void | Promise<void> => {
        if (!roleVerified) {
          pendingFrames.push(message);
          return;
        }
        return handleFrame(message);
      },
    }, { contextId, protocol: request.protocol }, 'reject');
    const reply = (await this.dispatchDwnRequest(agentRequest)).reply;
    if (reply.status.code < 200 || reply.status.code >= 300 || reply.subscription === undefined) {
      return reply;
    }
    const followedSourceId = this.recordExecutionContext?.followedSourceId;
    if (followedSourceId !== undefined && reply.roleRecordId !== followedSourceId) {
      await reply.subscription.close();
      throw new ContextNotReadyError(
        new Error('DwnApi: the active context role changed while opening the record subscription.'),
      );
    }
    try {
      for (let index = 0; index < pendingFrames.length; index++) {
        await handleFrame(pendingFrames[index]);
      }
    } catch (error: unknown) {
      await reply.subscription.close();
      throw error;
    }
    pendingFrames.length = 0;
    roleVerified = true;
    return reply;
  }

  /** Apply the routing and role carried by an internally bound context. */
  private async resolveRecordsRoute<T extends { protocolRole?: string }>(
    from: string | undefined,
    requestedMessageParams: T,
    mutation: boolean,
  ): Promise<{ messageParams: T; remoteTarget?: string; target: string }> {
    const context = this.recordExecutionContext;
    if (context === undefined) {
      return {
        messageParams : requestedMessageParams,
        remoteTarget  : from,
        target        : from ?? this.connectedDid,
      };
    }

    await context.assertActive();
    if (from !== undefined && from !== context.tenantDid) {
      throw new TypeError('Context-bound operations cannot target another tenant.');
    }
    if (requestedMessageParams.protocolRole !== undefined
      && requestedMessageParams.protocolRole !== context.protocolRole) {
      throw new TypeError('Context-bound operations cannot invoke another protocol role.');
    }

    return {
      messageParams: context.protocolRole === undefined
        ? requestedMessageParams
        : { ...requestedMessageParams, protocolRole: context.protocolRole },
      remoteTarget : mutation && context.tenantDid !== this.connectedDid ? context.tenantDid : undefined,
      target       : context.tenantDid,
    };
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

  /** @internal Tenant whose local replica backs this records API. */
  public get recordTenantDid(): string {
    return this.recordExecutionContext?.tenantDid ?? this.connectedDid;
  }

  /** @internal Exact followed context, when this records API is context-bound. */
  public get followedContextId(): string | undefined {
    return this.recordExecutionContext?.followedSourceId === undefined
      ? undefined
      : this.recordExecutionContext.contextId;
  }

  /** @internal Opaque local acceptance backing this records API. */
  public get followedSourceAcceptanceId(): string | undefined {
    return this.recordExecutionContext?.followedSourceAcceptanceId;
  }

  /** @internal Role record backing this followed-context records API. */
  public get followedSourceId(): string | undefined {
    return this.recordExecutionContext?.followedSourceId;
  }

  /** @internal Current delegate used to author records requests for the connected DID. */
  public get recordDelegateDid(): string | undefined {
    return this.delegateDid;
  }

  /** (optional) The DID of the signer when signing with permissions */
  private readonly delegateDid?: string;

  /** Holds the instance of {@link AgentPermissionsApi} that helps when dealing with permissions protocol records */
  private readonly permissionsApi: AgentPermissionsApi;

  /** Optional routing for a locally replicated foreign tenant. */
  private readonly recordExecutionContext?: RecordExecutionContext;

  constructor(options: {
    agent: EnboxAgent;
    connectedDid: string;
    delegateDid?: string;
    permissionsApi?: AgentPermissionsApi;
    recordExecutionContext?: RecordExecutionContext;
  }) {
    this.agent = options.agent;
    this._connectedDid = options.connectedDid;
    this.delegateDid = options.delegateDid;
    this.permissionsApi = options.permissionsApi ?? new AgentPermissionsApi({ agent: this.agent });
    this.recordExecutionContext = options.recordExecutionContext;
  }

  /** @internal Bind the existing records API to one locally replicated foreign tenant. */
  public withRecordExecutionContext(context: RecordExecutionContext): DwnApi {
    return new DwnApi({
      agent                  : this.agent,
      connectedDid           : this.connectedDid,
      delegateDid            : this.delegateDid,
      permissionsApi         : this.permissionsApi,
      recordExecutionContext : context,
    });
  }

  /** Whether this DWN API instance is operating as a delegate. */
  get isDelegate(): boolean {
    return this.delegateDid !== undefined;
  }

  /**
   * @internal
   * Query as the connected identity without falling back to the delegate's
   * independently visible records when a Records.Read grant is missing. A
   * bound context selects from its authoritative tenant for mutation safety.
   */
  public queryRecordsWithRequiredGrant(request: RecordsQueryRequest): Promise<RecordsQueryResponse> {
    return this.queryRecords(request, 'reject', this.recordExecutionContext !== undefined);
  }

  /** @internal Delete at every hosted endpoint, then apply the exact signed tombstone locally. */
  public async deleteRemoteRecordAndStoreLocal(
    request: RecordsDeleteRequest & { from: string },
  ): Promise<void> {
    const { agentRequest, remoteTarget } = await this.prepareDeleteRecord(request);
    if (remoteTarget === undefined) {
      throw new TypeError('DwnApi: deleteRemoteRecordAndStoreLocal requires a remote target.');
    }

    const { message, replies } = await this.agent.sendDwnDeleteToAllRemoteEndpoints(agentRequest);
    for (const { dwnUrl, reply } of replies) {
      if (!isDurableRecordsDeleteStatus(reply.status.code)) {
        throw new DwnResponseError(`Delete record at remote DWN '${dwnUrl}'`, reply.status);
      }
    }

    const localResponse = await this.agent.processDwnRequest({
      author      : this.connectedDid,
      messageType : DwnInterface.RecordsDelete,
      rawMessage  : message,
      store       : true,
      target      : agentRequest.target,
    });
    if (!isDurableRecordsDeleteStatus(localResponse.reply.status.code)) {
      throw new DwnResponseError('Store remote RecordsDelete locally', localResponse.reply.status);
    }
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
        const agentRequest: ProcessDwnRequest<DwnInterface.ProtocolsConfigure> = {
          author        : this.connectedDid,
          messageParams : request,
          messageType   : DwnInterface.ProtocolsConfigure,
          target        : this.connectedDid,
        };

        if (this.delegateDid) {
          const { message: delegatedGrant } = await this.permissionsApi.getPermissionForRequest({
            connectedDid : this.connectedDid,
            delegateDid  : this.delegateDid,
            protocol     : request.definition.protocol,
            delegate     : true,
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
              messageType  : agentRequest.messageType
            });

            agentRequest.messageParams = {
              ...agentRequest.messageParams,
              permissionGrantId
            };
            agentRequest.granteeDid = this.delegateDid;
          } catch (error: unknown) {
            if (!(error instanceof PermissionGrantNotFoundError)) {
              throw error;
            }
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
      subscribe: (request: MessagesSubscribeRequest) => Promise<MessagesSubscribeResponse>;
      } {

    return {
      /**
       * Subscribes to the tenant's raw message-level change feed. The caller's
       * handler is installed before dispatch and receives the protocol's event,
       * catch-up, error, and transport lifecycle messages unchanged.
       *
       * Delegated access resolves a `Messages.Read` grant when the filters
       * name exactly one protocol; multi-protocol delegated subscriptions
       * should pass explicit `permissionGrantIds`.
       */
      subscribe: async (request: MessagesSubscribeRequest): Promise<MessagesSubscribeResponse> => {
        const { from, subscriptionHandler, ...messageParams } = request;

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
                messageType  : agentRequest.messageType,
              });

              agentRequest.messageParams = {
                ...agentRequest.messageParams,
                permissionGrantIds: [grant.id],
              };
              agentRequest.granteeDid = this.delegateDid;
            } catch (error: unknown) {
              if (!(error instanceof PermissionGrantNotFoundError)) {
                throw error;
              }
              // Without a usable grant, author as the delegate so only
              // public or otherwise delegate-visible messages are delivered.
              agentRequest.author = this.delegateDid;
            }
          }
        }

        const agentResponse = await this.dispatchDwnRequest(agentRequest, from);
        return agentResponse.reply;
      },
    };
  }

  /**
   * API to interact with DWN records (e.g., `dwn.records.write()`).
   */
  get records(): {
      count: (request: RecordsCountRequest) => Promise<RecordsCountResponse>;
      delete: (request: RecordsDeleteRequest) => Promise<DwnResponseStatus>;
      query: (request: RecordsQueryRequest) => Promise<RecordsQueryResponse>;
      read: (request: RecordsReadRequest) => Promise<RecordsReadResponse>;
      subscribe: (request: RecordsSubscribeRequest) => Promise<RecordsSubscribeResponse>;
      write: (request: RecordsWriteRequest) => Promise<RecordsWriteResponse>;
      } {

    return {
      /**
       * Count records matching the given filter.
       */
      count: async (request: RecordsCountRequest): Promise<RecordsCountResponse> => {
        const { from, ...requestedMessageParams } = request;
        const { messageParams, remoteTarget, target } = await this.resolveRecordsRoute(
          from,
          requestedMessageParams,
          false,
        );

        const agentRequest = await this.prepareReadRequest({
          author      : this.connectedDid,
          messageParams,
          messageType : DwnInterface.RecordsCount,
          target,
        }, {
          protocol     : messageParams.filter?.protocol,
          protocolPath : messageParams.filter?.protocolPath,
          contextId    : messageParams.filter?.contextId,
        });

        const agentResponse = await this.dispatchDwnRequest(agentRequest, remoteTarget);

        const { count, status } = agentResponse.reply;
        return { count, status };
      },

      /**
       * Delete a record
       */
      delete: async (request: RecordsDeleteRequest): Promise<DwnResponseStatus> => {
        const { agentRequest, remoteTarget } = await this.prepareDeleteRecord(request);
        const response = await this.dispatchDwnRequest(agentRequest, remoteTarget);
        if (response.reply.status.code >= 200 && response.reply.status.code < 300) {
          await this.recordExecutionContext?.mutationAccepted?.();
        }
        return { status: response.reply.status };
      },

      /**
       * Query a single or multiple records based on the given filter
       */
      query: async (request: RecordsQueryRequest): Promise<RecordsQueryResponse> => {
        return this.queryRecords(request, 'fallback');
      },

      /**
       * Read a single record based on the given filter
       */
      read: async (request: RecordsReadRequest): Promise<RecordsReadResponse> => {
        return this.readRecord(request, false);
      },

      /** Subscribe to raw record events matching the given filter. */
      subscribe: async (request: RecordsSubscribeRequest): Promise<RecordsSubscribeResponse> => {
        const { subscriptionHandler, ...requestedMessageParams } = request;
        return this.openRecordsSubscription(requestedMessageParams, subscriptionHandler);
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
        const { data, from, store, recipientRolePublicKey, ...restParams } = request;
        const { dataBlob, dataFormat } = dataToBlob(data, restParams.dataFormat);
        const route = await this.resolveRecordsRoute(from, { ...restParams, dataFormat }, true);
        const { messageParams, remoteTarget, target } = route;

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
          target,
          dataStream  : dataBlob,
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
          // Mirror RecordsWrite.create(): root context IDs equal recordId;
          // nested context IDs append recordId to parentContextId. Before an
          // ID is generated, parentContextId is the narrowest available scope.
          let permissionContextId = messageParams.parentContextId;
          if (messageParams.recordId !== undefined) {
            permissionContextId = messageParams.parentContextId === undefined
              ? messageParams.recordId
              : `${messageParams.parentContextId}/${messageParams.recordId}`;
          }
          const { message: delegatedGrant } = await this.permissionsApi.getPermissionForRequest({
            connectedDid : this.connectedDid,
            delegateDid  : this.delegateDid,
            protocol     : messageParams.protocol,
            protocolPath : messageParams.protocolPath,
            contextId    : permissionContextId,
            delegate     : true,
            messageType  : dwnRequestParams.messageType
          });

          dwnRequestParams.messageParams = {
            ...dwnRequestParams.messageParams,
            delegatedGrant
          };
          dwnRequestParams.granteeDid = this.delegateDid;
        }

        const agentResponse: DwnResponse<DwnInterface.RecordsWrite> =
          await this.dispatchDwnRequest(dwnRequestParams, remoteTarget);

        // NOTE: `audienceKeyDelivery` is populated by local processing only — the remote
        // (`sendDwnRequest`) branch never reports one, and none is ever fabricated for it.
        const { message: responseMessage, reply: { status }, audienceKeyDelivery, data: responseData } = agentResponse;

        let record: Record | undefined;
        if (200 <= status.code && status.code <= 299) {
          record = this.createRecordHandle({
            dataAccess: captureRecordDataAccess(
              dwnRequestParams,
              remoteTarget !== undefined && this.recordExecutionContext === undefined,
            ),
            message      : responseMessage,
            protocolRole : messageParams.protocolRole,
            storedData   : responseData,
          });
          await this.recordExecutionContext?.mutationAccepted?.();
        }

        return { record, status, ...(audienceKeyDelivery ? { audienceKeyDelivery } : {}) };
      },
    };
  }

}
