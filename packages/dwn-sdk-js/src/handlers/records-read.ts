import type { ResolvedProtocolRole } from '../core/protocol-authorization-action.js';
import type { Filter, PaginationCursor } from '../types/query-types.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { RecordsDeleteMessage, RecordsQueryReplyEntry, RecordsReadMessage, RecordsReadReply } from '../types/records-types.js';

import { authenticate } from '../core/auth.js';
import { DataStream } from '../utils/data-stream.js';
import { Encoder } from '../utils/encoder.js';
import { EncryptionControl } from '../core/encryption-control.js';
import { isRecordLimitOccupant } from '../utils/record-limit-occupancy.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { Messages } from '../utils/messages.js';
import { ProtocolAuthorization } from '../core/protocol-authorization.js';
import { Records } from '../utils/records.js';
import { RecordsGrantAuthorization } from '../core/records-grant-authorization.js';
import { RecordsRead } from '../interfaces/records-read.js';
import { RecordsReadReplicationSupport } from '../core/records-read-replication-support.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

/**
 * Number of ordered candidates fetched per store page when resolving a broad
 * RecordsRead. Pages bound per-query work while the skip loop guarantees a
 * hidden record can never shadow the first result the requester may read.
 */
const recordsReadPageSize = 25;

/**
 * Authorization-denial codes that make a candidate invisible to the requester.
 * A broad Read skips candidates denied with one of these codes. Any other failure
 * (malformed retained state, unresolvable protocol, store or validation-state
 * failure) propagates fail-closed instead of becoming invisibility. Codes added
 * later fail closed by construction until classified here. (DWN-PROTO-001)
 */
const authorizationDenialCodes: ReadonlySet<string> = new Set([
  DwnErrorCode.EncryptionControlReadUnauthorized,
  DwnErrorCode.GrantAuthorizationGrantExpired,
  DwnErrorCode.GrantAuthorizationGrantMissing,
  DwnErrorCode.GrantAuthorizationGrantNotYetActive,
  DwnErrorCode.GrantAuthorizationGrantRevoked,
  DwnErrorCode.GrantAuthorizationInterfaceMismatch,
  DwnErrorCode.GrantAuthorizationMethodMismatch,
  DwnErrorCode.GrantAuthorizationNotGrantedForTenant,
  DwnErrorCode.GrantAuthorizationNotGrantedToAuthor,
  DwnErrorCode.ProtocolAuthorizationActionNotAllowed,
  DwnErrorCode.ProtocolAuthorizationActionRulesNotFound,
  DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound,
  DwnErrorCode.ProtocolAuthorizationMissingContextId,
  DwnErrorCode.ProtocolAuthorizationNotARole,
  DwnErrorCode.RecordsGrantAuthorizationConditionPublicationProhibited,
  DwnErrorCode.RecordsGrantAuthorizationConditionPublicationRequired,
  DwnErrorCode.RecordsGrantAuthorizationScopeContextIdMismatch,
  DwnErrorCode.RecordsGrantAuthorizationScopeMismatch,
  DwnErrorCode.RecordsGrantAuthorizationScopeProtocolMismatch,
  DwnErrorCode.RecordsGrantAuthorizationScopeProtocolPathMismatch,
]);

export class RecordsReadHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message,
  }: { tenant: string, message: RecordsReadMessage }): Promise<RecordsReadReply> {

    let recordsRead: RecordsRead;
    try {
      recordsRead = await RecordsRead.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    // authentication
    try {
      if (recordsRead.author !== undefined) {
        await authenticate(message.authorization!, this.deps.didResolver);
      }
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    // A broad Read is a top-1 query over the readable population: walk the ordered
    // candidates page by page so a hidden record cannot shadow the first result the
    // requester is allowed to read. Exact-ID reads retain their 401/404 shape.
    const query: Filter = {
      // NOTE: we don't filter by `method` so that we get both RecordsWrite and RecordsDelete messages
      interface         : DwnInterfaceName.Records,
      isLatestBaseState : true,
      ...Records.convertFilter(message.descriptor.filter)
    };
    const messageSort = Records.convertDateSort(message.descriptor.dateSort);
    const isPointRead = message.descriptor.filter.recordId !== undefined;

    let cursor: PaginationCursor | undefined = undefined;
    for (;;) {
      const { messages: candidates, cursor: nextCursor } = await this.deps.messageStore.query(
        tenant, [query], messageSort, { cursor, limit: recordsReadPageSize }
      );
      if (candidates.length === 0) {
        return {
          status: { code: 404, detail: 'Not Found' }
        };
      }

      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const hasMoreCandidates = index + 1 < candidates.length || nextCursor !== undefined;

        if (candidate.descriptor.method === DwnMethodName.Delete) {
          const tombstoneReply = await this.replyForTombstoneCandidate(
            tenant, recordsRead, candidate as RecordsDeleteMessage, isPointRead, hasMoreCandidates
          );
          if (tombstoneReply === undefined) {
            continue;
          }
          return tombstoneReply;
        }

        // else the candidate is a RecordsWrite
        const writeReply = await this.replyForWriteCandidate(
          tenant, recordsRead, candidate as RecordsQueryReplyEntry, isPointRead, hasMoreCandidates
        );
        if (writeReply === undefined) {
          continue;
        }
        return writeReply;
      }

      if (nextCursor === undefined) {
        return {
          status: { code: 404, detail: 'Not Found' }
        };
      }
      cursor = nextCursor;
    }
  };

  /**
   * Resolves one ordered Write candidate to its reply. Returns `undefined` when a broad
   * read must skip the candidate and consider the next one instead.
   */
  private async replyForWriteCandidate(
    tenant: string,
    recordsRead: RecordsRead,
    candidate: RecordsQueryReplyEntry,
    isPointRead: boolean,
    hasMoreCandidates: boolean,
  ): Promise<RecordsReadReply | undefined> {
    if (!await isRecordLimitOccupant({
      messageStore          : this.deps.messageStore,
      validationStateReader : this.deps.validationStateReader,
      tenant,
      message               : candidate,
      messageTimestamp      : recordsRead.message.descriptor.messageTimestamp,
    })) {
      if (!isPointRead && hasMoreCandidates) {
        return undefined;
      }
      return {
        status: { code: 404, detail: 'Not Found' }
      };
    }

    let parsedWrite: RecordsWrite;
    try {
      parsedWrite = await RecordsWrite.parse(candidate);
    } catch (error) {
      if (isPointRead) {
        return messageReplyFromError(error, 401);
      }
      throw error;
    }

    let resolvedRole: ResolvedProtocolRole | undefined;
    try {
      resolvedRole = await RecordsReadHandler.authorizeRecordsRead(
        tenant, recordsRead, parsedWrite, this.deps,
      );
    } catch (error) {
      if (!isPointRead && !RecordsReadHandler.isAuthorizationDenial(error)) {
        throw error;
      }
      if (!isPointRead && hasMoreCandidates) {
        return undefined;
      }
      if (isPointRead) {
        return messageReplyFromError(error, 401);
      }
      return {
        status: { code: 404, detail: 'Not Found' }
      };
    }

    return this.buildActiveRecordReply(tenant, recordsRead, candidate, resolvedRole);
  }

  private async buildActiveRecordReply(
    tenant: string,
    recordsRead: RecordsRead,
    matchedRecordsWrite: RecordsQueryReplyEntry,
    resolvedRole: ResolvedProtocolRole | undefined,
  ): Promise<RecordsReadReply> {
    const recordsReadReply: RecordsReadReply = {
      status : { code: 200, detail: 'OK' },
      entry  : {
        recordsWrite: matchedRecordsWrite,
      }
    };
    if (resolvedRole?.roleRecordId !== undefined) {
      recordsReadReply.roleRecordId = resolvedRole.roleRecordId;
    }

    try {
      // Attach the initial write by its stable entry ID. Looking it up through
      // `isLatestBaseState:false` races with the update that demotes it.
      if (!await RecordsWrite.isInitialWrite(matchedRecordsWrite)) {
        const storedInitialWrite = await RecordsWrite.fetchInitialRecordsWriteMessage(
          this.deps.messageStore,
          tenant,
          matchedRecordsWrite.recordId,
        );
        if (storedInitialWrite === undefined) {
          throw new DwnError(
            DwnErrorCode.RecordsWriteGetInitialWriteNotFound,
            `initial write not found for record ${matchedRecordsWrite.recordId}`,
          );
        }

        const { message: initialWrite } = Messages.detachEncodedData(storedInitialWrite);
        recordsReadReply.entry!.initialWrite = initialWrite as RecordsQueryReplyEntry;
      }
    } catch (error) {
      return messageReplyFromError(error, 500);
    }

    if (recordsRead.message.descriptor.includeReplicationSupport === true) {
      try {
        await this.attachReplicationSupport(tenant, recordsRead, matchedRecordsWrite, resolvedRole, recordsReadReply);
      } catch (error) {
        return messageReplyFromError(error, 400);
      }
      const { message } = Messages.detachEncodedData(matchedRecordsWrite);
      recordsReadReply.entry!.recordsWrite = message as RecordsQueryReplyEntry;
      return recordsReadReply;
    }

    if (matchedRecordsWrite.encodedData === undefined) {
      const result = await this.deps.dataStore!.get(tenant, matchedRecordsWrite.recordId, matchedRecordsWrite.descriptor.dataCid);
      if (result?.dataStream === undefined) {
        // The message envelope exists but the record data is unavailable (e.g., evicted
        // by a storage-constrained node, or read proxying to peer endpoints failed).
        // Return 410 with the recordsWrite so the requester can try an alternative endpoint.
        return {
          status : { code: 410, detail: 'Record data not available' },
          entry  : { recordsWrite: matchedRecordsWrite },
        };
      }
      recordsReadReply.entry!.data = result.dataStream;
    } else {
      const dataBytes = Encoder.base64UrlToBytes(matchedRecordsWrite.encodedData);
      recordsReadReply.entry!.data = DataStream.fromBytes(dataBytes);
      delete matchedRecordsWrite.encodedData;
    }

    return recordsReadReply;
  }

  private async attachReplicationSupport(
    tenant: string,
    recordsRead: RecordsRead,
    matchedRecordsWrite: RecordsQueryReplyEntry,
    resolvedRole: ResolvedProtocolRole | undefined,
    reply: RecordsReadReply,
    recordsDelete?: RecordsDeleteMessage,
  ): Promise<void> {
    if (recordsRead.author === undefined || resolvedRole === undefined) {
      throw new DwnError(
        DwnErrorCode.RecordsReadReplicationSupportUnsupported,
        'replication support requires an authenticated protocol-role invocation.'
      );
    }
    reply.support = await RecordsReadReplicationSupport.build({
      deps      : this.deps,
      matchedRecordsWrite,
      ...(recordsDelete === undefined ? {} : { recordsDelete }),
      requester : recordsRead.author,
      resolvedRole,
      tenant,
    });
  }

  /**
   * Resolves one ordered tombstone candidate to its reply. Returns `undefined` when a broad
   * read must skip the candidate and consider the next one instead.
   */
  private async replyForTombstoneCandidate(
    tenant: string,
    recordsRead: RecordsRead,
    recordsDeleteMessage: RecordsDeleteMessage,
    isPointRead: boolean,
    hasMoreCandidates: boolean,
  ): Promise<RecordsReadReply | undefined> {
    let initialWrite: RecordsQueryReplyEntry;
    let parsedNewestWrite: RecordsWrite;
    try {
      ({ initialWrite, parsedNewestWrite } = await this.fetchDeleteAuthorizationBasis(tenant, recordsDeleteMessage));
    } catch (error) {
      if (error instanceof DwnError && error.code === DwnErrorCode.RecordsReadInitialWriteNotFound) {
        return messageReplyFromError(error, 400);
      }
      throw error;
    }

    let resolvedRole: ResolvedProtocolRole | undefined;
    try {
      resolvedRole = await RecordsReadHandler.authorizeRecordsRead(tenant, recordsRead, parsedNewestWrite, this.deps);
    } catch (error) {
      if (!isPointRead && !RecordsReadHandler.isAuthorizationDenial(error)) {
        throw error;
      }
      if (!isPointRead && hasMoreCandidates) {
        return undefined;
      }
      if (isPointRead) {
        return messageReplyFromError(error, 401);
      }
      return {
        status: { code: 404, detail: 'Not Found' }
      };
    }

    return this.buildDeletedRecordReply(tenant, recordsRead, recordsDeleteMessage, initialWrite, resolvedRole);
  }

  /**
   * Fetches the writes a deleted-record read authorizes against. Throws
   * `RecordsReadInitialWriteNotFound` when the initial write is missing.
   */
  private async fetchDeleteAuthorizationBasis(
    tenant: string,
    recordsDeleteMessage: RecordsDeleteMessage,
  ): Promise<{ initialWrite: RecordsQueryReplyEntry; parsedNewestWrite: RecordsWrite }> {
    const recordId = recordsDeleteMessage.descriptor.recordId;

    const initialWrite = await RecordsWrite.fetchInitialRecordsWriteMessage(this.deps.messageStore, tenant, recordId);
    if (initialWrite === undefined) {
      throw new DwnError(
        DwnErrorCode.RecordsReadInitialWriteNotFound,
        'initial write for deleted record not found'
      );
    }

    // Authorize against the newest RecordsWrite so that mutable properties like `published`
    // reflect the record's state at the time of deletion, not just the initial write.
    let newestWrite;
    try {
      newestWrite = await RecordsWrite.fetchNewestRecordsWrite(this.deps.messageStore, tenant, recordId);
    } catch {
      // If newest write is not found (should not happen since initial write exists),
      // fall back to the initial write for authorization.
      newestWrite = initialWrite;
    }
    const parsedNewestWrite = await RecordsWrite.parse(newestWrite);

    return { initialWrite, parsedNewestWrite };
  }

  private async buildDeletedRecordReply(
    tenant: string,
    recordsRead: RecordsRead,
    recordsDeleteMessage: RecordsDeleteMessage,
    initialWrite: RecordsQueryReplyEntry,
    resolvedRole: ResolvedProtocolRole | undefined,
  ): Promise<RecordsReadReply> {
    const reply: RecordsReadReply = {
      status : { code: 404, detail: 'Not Found' },
      entry  : {
        recordsDelete: recordsDeleteMessage,
        initialWrite,
      },
      ...(resolvedRole?.roleRecordId === undefined ? {} : { roleRecordId: resolvedRole.roleRecordId }),
    };
    if (recordsRead.message.descriptor.includeReplicationSupport === true) {
      try {
        await this.attachReplicationSupport(
          tenant,
          recordsRead,
          initialWrite,
          resolvedRole,
          reply,
          recordsDeleteMessage,
        );
      } catch (error) {
        return messageReplyFromError(error, 400);
      }
      const { message: supportInitialWrite } = Messages.detachEncodedData(initialWrite);
      reply.entry!.initialWrite = supportInitialWrite as RecordsQueryReplyEntry;
    }
    return reply;
  }

  /**
   * Whether the error is a classified authorization denial that makes a candidate
   * invisible to the requester. All other failures propagate fail-closed.
   */
  private static isAuthorizationDenial(error: unknown): boolean {
    return error instanceof DwnError && authorizationDenialCodes.has(error.code);
  }

  /**
   * @param messageStore Used to check if the grant has been revoked.
   */
  private static async authorizeRecordsRead(
    tenant: string,
    recordsRead: RecordsRead,
    matchedRecordsWrite: RecordsWrite,
    deps: HandlerDependencies,
  ): Promise<ResolvedProtocolRole | undefined> {
    const { descriptor } = matchedRecordsWrite.message;

    if (EncryptionControl.isControlMessage(matchedRecordsWrite.message)) {
      await EncryptionControl.authorizeControlReadRequest({
        tenant,
        incomingMessage       : recordsRead.message,
        requester             : Message.getRequester(recordsRead.message),
        validationStateReader : deps.validationStateReader,
      });
      await EncryptionControl.authorizeRead({
        tenant,
        incomingMessage       : recordsRead.message,
        requester             : Message.getRequester(recordsRead.message),
        recordsWriteMessage   : matchedRecordsWrite.message,
        validationStateReader : deps.validationStateReader,
      });
      return undefined;
    }

    if (Message.isSignedByAuthorDelegate(recordsRead.message)) {
      await recordsRead.authorizeDelegate(matchedRecordsWrite.message, deps.validationStateReader);
    }

    // Owner authority and published data authorize a read on their own, so an invoked role
    // never has to resolve for them. A replication-support read is the one exception: its
    // response closure is scoped to the invoked role, so that role must resolve even when
    // another rule would already have allowed the read.
    const requiresResolvedRole = recordsRead.message.descriptor.includeReplicationSupport === true;
    if (!requiresResolvedRole && (recordsRead.author === tenant || descriptor.published === true)) {
      // The tenant may read its own records, and published data needs no authorization.
      return undefined;
    }

    if (recordsRead.signaturePayload?.protocolRole !== undefined) {
      return ProtocolAuthorization.authorizeRead(tenant, recordsRead, matchedRecordsWrite, deps.validationStateReader);
    }

    if (recordsRead.author === tenant) {
      // if author is the same as the target tenant, we can directly grant access
      return undefined;
    } else if (descriptor.published === true) {
      // authentication is not required for published data
      return undefined;
    } else if (recordsRead.author !== undefined &&
      (recordsRead.author === descriptor.recipient || recordsRead.author === matchedRecordsWrite.author)
    ) {
      // The recipient or author of a message may always read it
      return undefined;
    } else if (recordsRead.author !== undefined && Message.getPermissionGrantId(recordsRead.signaturePayload!) !== undefined) {
      const permissionGrantId = Message.getPermissionGrantId(recordsRead.signaturePayload!)!;
      const permissionGrant = await deps.validationStateReader.fetchGrant(tenant, permissionGrantId);
      await RecordsGrantAuthorization.authorizeRead({
        recordsReadMessage          : recordsRead.message,
        recordsWriteMessageToBeRead : matchedRecordsWrite.message,
        expectedGrantor             : tenant,
        expectedGrantee             : recordsRead.author,
        permissionGrant,
        validationStateReader       : deps.validationStateReader
      });
      return undefined;
    } else {
      return ProtocolAuthorization.authorizeRead(tenant, recordsRead, matchedRecordsWrite, deps.validationStateReader);
    }
  }
}
