import type { GenericMessage, GenericMessageReply } from '../types/message-types.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { RecordsQueryReplyEntry, RecordsWriteMessage } from '../types/records-types.js';

import { authenticate } from '../core/auth.js';
import { Cid } from '../utils/cid.js';
import { DataStream } from '../utils/data-stream.js';
import { DwnConstant } from '../core/dwn-constant.js';
import { Encoder } from '../utils/encoder.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { ProtocolAuthorization } from '../core/protocol-authorization.js';
import { Records } from '../utils/records.js';
import { RecordsGrantAuthorization } from '../core/records-grant-authorization.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { ResumableTaskName } from '../core/resumable-task-manager.js';
import { StorageController } from '../store/storage-controller.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

type HandlerArgs = { tenant: string, message: RecordsWriteMessage, dataStream?: ReadableStream<Uint8Array> };

export class RecordsWriteHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message,
    dataStream,
  }: HandlerArgs): Promise<GenericMessageReply> {
    let recordsWrite: RecordsWrite;
    try {
      recordsWrite = await RecordsWrite.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    // get existing messages matching the `recordId`
    const query = {
      interface : DwnInterfaceName.Records,
      recordId  : message.recordId
    };
    const { messages: existingMessages } = await this.deps.messageStore.query(tenant, [ query ]);

    // If the exact same message already exists, return 409 before re-running
    // mutable validation. An already-stored message has already passed
    // admission; replay should not be reinterpreted against current protocol,
    // parent, role, grant, or record-limit state.
    //
    // Exception: an initial write may have been stored earlier without data
    // (204). A later delivery of the same message with data must be allowed
    // to complete the record.
    const incomingCid = await Message.getCid(message);
    for (const existingMessage of existingMessages) {
      if (await Message.getCid(existingMessage) !== incomingCid) {
        continue;
      }

      const canCompleteMissingData = await this.existingInitialWriteLacksData(
        tenant,
        existingMessage as RecordsWriteMessage,
        message,
        dataStream !== undefined,
      );

      if (!canCompleteMissingData) {
        return { status: { code: 409, detail: 'Conflict' } };
      }
    }

    const newMessageIsInitialWrite = await recordsWrite.isInitialWrite();

    let initialWrite: RecordsWriteMessage | undefined;
    try {
      initialWrite = await this.validateNonInitialWrite(message, existingMessages, newMessageIsInitialWrite);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    try {
      await ProtocolAuthorization.validateReferentialIntegrity(tenant, recordsWrite, this.deps.validationStateReader);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    // authentication & authorization
    try {
      await authenticate(message.authorization, this.deps.didResolver, message.attestation);
      await this.authorizeRecordsWrite(tenant, recordsWrite);
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    // Squash backstop: if the protocol path has $squash: true, reject any write whose
    // messageTimestamp is <= the most recent squash record at the same path and parent context.
    // The squash record acts as a temporal floor — no record older than the latest squash can exist.
    try {
      await this.enforceSquashBackstop(tenant, message);
    } catch (e) {
      return messageReplyFromError(e, 409);
    }

    const newestExistingMessage = await Message.getNewestMessage(existingMessages);

    let incomingMessageIsNewest = false;
    let newestMessage; // keep reference of newest message for pruning later
    if (newestExistingMessage === undefined || await Message.isNewer(message, newestExistingMessage)) {
      incomingMessageIsNewest = true;
      newestMessage = message;
    } else { // existing message is the same age or newer than the incoming message
      newestMessage = newestExistingMessage;
    }

    if (!incomingMessageIsNewest) {
      // Allow re-processing when the existing record was stored as an
      // initial write without data (isLatestBaseState = false, status 204)
      // and the incoming message now supplies data.  This happens during
      // sync when a live pull initially stores the message without data
      // and a subsequent poll or retry delivers the same message with data.
      //
      // We detect the incomplete state by checking whether the existing
      // message is an initial write that lacks both inline encodedData and
      // DataStore data — indicating it was stored without data.
      let existingLacksData = false;
      if (newestExistingMessage) {
        existingLacksData = await this.existingInitialWriteLacksData(
          tenant,
          newestExistingMessage as RecordsWriteMessage,
          message,
          dataStream !== undefined,
        );
      }

      if (!existingLacksData) {
        return {
          status: { code: 409, detail: 'Conflict' }
        };
      }
    }

    // Look up the core protocol (if any) for the incoming message so that lifecycle hooks
    // can be dispatched generically rather than checking for specific protocol URIs.
    const coreProtocol = message.descriptor.protocol === undefined
      ? undefined
      : this.deps.coreProtocols?.get(message.descriptor.protocol);

    try {
      if (newestExistingMessage?.descriptor.method === DwnMethodName.Delete) {
        throw new DwnError(
          DwnErrorCode.RecordsWriteNotAllowedAfterDelete,
          'RecordsWrite is not allowed after a RecordsDelete.'
        );
      }

      // Dispatch pre-processing hooks to the core protocol, if applicable.
      // This allows core protocols to perform cross-record validation before storage
      // (e.g. ensuring revocation tag consistency with the parent grant's scoped protocol).
      if (coreProtocol?.preProcessWrite !== undefined) {
        await coreProtocol.preProcessWrite(tenant, message, this.deps.validationStateReader);
      }

      // NOTE: We allow isLatestBaseState to be true ONLY if the incoming message comes with data, or if the incoming message is NOT an initial write
      // This would allow an initial write to be written to the DB without data, but having it not queryable,
      // because query implementation filters on `isLatestBaseState` being `true`
      // thus preventing a user's attempt to gain authorized access to data by referencing the dataCid of a private data in their initial writes,
      // See: https://github.com/enboxorg/enbox/issues/359 for more info
      let isLatestBaseState = false;
      let messageWithOptionalEncodedData = message as RecordsQueryReplyEntry;

      if (dataStream === undefined) {
        // data stream is NOT provided

        // if the incoming message is not an initial write, and no dataStream is provided, we would allow it provided it passes validation
        // processMessageWithoutDataStream() abstracts that logic
        if (!newMessageIsInitialWrite) {
          const newestExistingWrite = newestExistingMessage as RecordsQueryReplyEntry;
          messageWithOptionalEncodedData = await this.processMessageWithoutDataStream(tenant, message, newestExistingWrite );
          isLatestBaseState = true;
        }
      } else {
        messageWithOptionalEncodedData = await this.processMessageWithDataStream(tenant, message, dataStream);
        isLatestBaseState = true;
      }

      const indexes = await recordsWrite.constructIndexes(isLatestBaseState);
      await this.deps.messageStore.put(tenant, messageWithOptionalEncodedData, indexes);
      const messageCid = await Message.getCid(message);
      await this.deps.stateIndex!.insert(tenant, messageCid, indexes);

      // NOTE: We only emit a `RecordsWrite` when the message is the latest base state.
      // Because we allow a `RecordsWrite` which is not the latest state to be written, but not queried, we shouldn't emit it either.
      // It will be emitted as a part of a subsequent next write, if it is the latest base state.
      //
      // We emit `messageWithOptionalEncodedData` (not the raw `message`) so
      // that WebSocket subscribers receive inline `encodedData` for small
      // records (<= 30 KB).  This allows live sync to store the record
      // immediately without a separate MessagesRead round-trip.
      if (this.deps.eventLog !== undefined && isLatestBaseState) {
        await this.deps.eventLog.emit(tenant, { message: messageWithOptionalEncodedData, initialWrite }, indexes, messageCid);
      }
    } catch (error) {
      if (error instanceof DwnError) {
        if (error.code === DwnErrorCode.RecordsWriteMissingEncodedDataInPrevious ||
          error.code === DwnErrorCode.RecordsWriteMissingDataInPrevious ||
          error.code === DwnErrorCode.RecordsWriteNotAllowedAfterDelete ||
          error.code === DwnErrorCode.RecordsWriteDataCidMismatch ||
          error.code === DwnErrorCode.RecordsWriteDataSizeMismatch ||
          error.code.startsWith('SchemaValidator') ||
          this.deps.coreProtocols?.mapErrorToStatusCode(error.code) !== undefined) {
          return messageReplyFromError(error, 400);
        }
      }

      // else throw
      throw error;
    }

    const messageReply = {
      // In order to discern between something that was accepted as a queryable write and something that was accepted
      // as an initial state we use separate response codes. See https://github.com/enboxorg/enbox/issues/695
      // for more details.
      status: (newMessageIsInitialWrite && dataStream === undefined) ?
        { code: 204, detail: 'No Content' } :
        { code: 202, detail: 'Accepted' }
    };

    // displace every other message for this record, retaining only the initial write as non-latest state
    await StorageController.deleteDisplacedMessagesAndRetainWrites(
      tenant, existingMessages, newestMessage, this.deps.messageStore, this.deps.dataStore!, this.deps.stateIndex!, []
    );

    // Squash processing: if the incoming write is a squash, delete all older sibling records
    // at the same protocol path and parent context. Uses the resumable task system for crash safety.
    if (message.descriptor.squash === true) {
      await this.deps.resumableTaskManager!.run({
        name : ResumableTaskName.RecordsSquash,
        data : { tenant, message }
      });
    }

    // Dispatch post-processing hooks to the core protocol, if applicable.
    // This allows core protocols to perform cascading side effects after a successful write
    // (e.g. deleting messages authorized by a revoked grant).
    if (coreProtocol?.postProcessWrite !== undefined) {
      await coreProtocol.postProcessWrite(tenant, recordsWrite, {
        messageStore : this.deps.messageStore,
        dataStore    : this.deps.dataStore!,
        stateIndex   : this.deps.stateIndex!,
      });
    }

    return messageReply;
  };

  /**
   * Returns a `RecordsQueryReplyEntry` with a copy of the incoming message and the incoming data encoded to `Base64URL`.
   */
  public async cloneAndAddEncodedData(message: RecordsWriteMessage, dataBytes: Uint8Array):Promise<RecordsQueryReplyEntry> {
    const recordsWrite: RecordsQueryReplyEntry = { ...message };
    recordsWrite.encodedData = Encoder.bytesToBase64Url(dataBytes);
    return recordsWrite;
  }

  private async processMessageWithDataStream(
    tenant: string,
    message: RecordsWriteMessage,
    dataStream: ReadableStream<Uint8Array>,
  ):Promise<RecordsQueryReplyEntry> {
    let messageWithOptionalEncodedData: RecordsQueryReplyEntry = message;

    // if data is below the threshold, we store it within MessageStore
    if (message.descriptor.dataSize <= DwnConstant.maxDataSizeAllowedToBeEncoded) {
      // validate data integrity before setting.
      const dataBytes = await DataStream.toBytes(dataStream);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);
      RecordsWrite.validateDataIntegrity(message.descriptor.dataCid, message.descriptor.dataSize, dataCid, dataBytes.length);

      // Dispatch schema validation to the core protocol, if applicable.
      const coreProtocol = message.descriptor.protocol === undefined
        ? undefined
        : this.deps.coreProtocols?.get(message.descriptor.protocol);
      if (coreProtocol?.validateRecord !== undefined) {
        coreProtocol.validateRecord(message, dataBytes);
      }

      messageWithOptionalEncodedData = await this.cloneAndAddEncodedData(message, dataBytes);
    } else {
      // split the dataStream into two: one for CID computation and one for storage
      const [dataStreamCopy1, dataStreamCopy2] = DataStream.duplicateDataStream(dataStream, 2);

      try {
        // perform storage and CID computation in parallel
        const [dataCid, DataStorePutResult] = await Promise.all([
          Cid.computeDagPbCidFromStream(dataStreamCopy1),
          this.deps.dataStore!.put(tenant, message.recordId, message.descriptor.dataCid, dataStreamCopy2)
        ]);

        RecordsWrite.validateDataIntegrity(message.descriptor.dataCid, message.descriptor.dataSize, dataCid, DataStorePutResult.dataSize);
      } catch (error) {
        // unwind/delete data if we have issue with storage or the data failed integrity validation
        await this.deps.dataStore!.delete(tenant, message.recordId, message.descriptor.dataCid);

        throw error;
      }
    }

    return messageWithOptionalEncodedData;
  }

  private async existingInitialWriteLacksData(
    tenant: string,
    existingMessage: RecordsWriteMessage,
    incomingMessage: RecordsWriteMessage,
    incomingHasData: boolean,
  ): Promise<boolean> {
    if (!incomingHasData) {
      return false;
    }

    const isInitial = await RecordsWrite.isInitialWrite(existingMessage);
    if (!isInitial) {
      return false;
    }

    const hasInlineData = !!(existingMessage as RecordsQueryReplyEntry).encodedData;
    const hasStoredData = await this.deps.validationStateReader.hasStoredData(
      tenant,
      existingMessage.recordId,
      incomingMessage.descriptor.dataCid,
    );

    return !hasInlineData && !hasStoredData;
  }

  private async validateNonInitialWrite(
    message: RecordsWriteMessage,
    existingMessages: GenericMessage[],
    newMessageIsInitialWrite: boolean,
  ): Promise<RecordsWriteMessage | undefined> {
    if (newMessageIsInitialWrite) {
      return undefined;
    }

    const initialWrite = await RecordsWrite.getInitialWrite(existingMessages);
    RecordsWrite.verifyEqualityOfImmutableProperties(initialWrite, message);
    return initialWrite;
  }

  private async processMessageWithoutDataStream(
    tenant: string,
    message: RecordsWriteMessage,
    newestExistingWrite: RecordsQueryReplyEntry,
  ):Promise<RecordsQueryReplyEntry> {
    const messageWithOptionalEncodedData: RecordsQueryReplyEntry = { ...message }; // clone
    const { dataCid, dataSize } = message.descriptor;

    // Since incoming message is not an initial write, and no dataStream is provided, we first check integrity against newest existing write.
    // we preform the dataCid check in case a user attempts to gain access to data by referencing a different known dataCid,
    // so we insure that the data is already associated with the existing newest message
    // See: https://github.com/enboxorg/enbox/issues/359 for more info
    RecordsWrite.validateDataIntegrity(dataCid, dataSize, newestExistingWrite.descriptor.dataCid, newestExistingWrite.descriptor.dataSize);

    if (dataSize <= DwnConstant.maxDataSizeAllowedToBeEncoded) {
      // we encode the data from the original write if it is smaller than the data-store threshold
      if (newestExistingWrite.encodedData === undefined) {
        throw new DwnError(
          DwnErrorCode.RecordsWriteMissingEncodedDataInPrevious,
          `No dataStream was provided and unable to get data from previous message`
        );
      } else {
        messageWithOptionalEncodedData.encodedData = newestExistingWrite.encodedData;
      }
    } else {
      // else just make sure the data is in the data store

      // attempt to retrieve the data from the previous message
      const priorDataExists = await this.deps.validationStateReader.hasStoredData(tenant, newestExistingWrite.recordId, message.descriptor.dataCid);

      if (!priorDataExists) {
        throw new DwnError(
          DwnErrorCode.RecordsWriteMissingDataInPrevious,
          `No dataStream was provided and unable to get data from previous message`
        );
      }
    }

    return messageWithOptionalEncodedData;
  }

  /**
   * Enforces the squash backstop: if the incoming message is at a protocol path with `$squash: true`,
   * and there exists a squash record at the same protocol path and parent context whose
   * `messageTimestamp` is >= the incoming message's `messageTimestamp`, reject with 409.
   *
   * This check only applies to protocol-based records at `$squash: true` paths.
   */
  private async enforceSquashBackstop(tenant: string, message: RecordsWriteMessage): Promise<void> {
    // Only applies to protocol-based records
    if (message.descriptor.protocol === undefined || message.descriptor.protocolPath === undefined) {
      return;
    }

    // Fetch the protocol definition active at the incoming message timestamp to check if $squash is enabled at this path.
    // The reader resolves core protocols (e.g. permissions) from the registry.
    let protocolDefinition;
    try {
      protocolDefinition = await this.deps.validationStateReader.fetchProtocolDefinition(
        tenant,
        message.descriptor.protocol,
        message.descriptor.messageTimestamp,
      );
    } catch (error) {
      // If the protocol definition can't be found, skip the backstop check.
      // Authorization will handle the missing protocol error later.
      console.warn(`enforceSquashBackstop: failed to fetch protocol definition for '${message.descriptor.protocol}':`, error);
      return;
    }

    // Walk the structure to find the rule set for this protocol path
    const pathSegments = message.descriptor.protocolPath.split('/');
    let ruleSet = protocolDefinition.structure[pathSegments[0]];
    for (let i = 1; i < pathSegments.length && ruleSet !== undefined; i++) {
      ruleSet = ruleSet[pathSegments[i]] as typeof ruleSet;
    }

    if (ruleSet?.$squash !== true) {
      return;
    }

    const parentContextId = Records.getParentContextFromOfContextId(message.contextId);
    const contextIdPrefix = parentContextId !== undefined && parentContextId !== '' ? parentContextId : undefined;
    const newestSquash = await this.deps.validationStateReader.fetchLatestSquashRecordAtScope({
      tenant,
      protocol     : message.descriptor.protocol,
      protocolPath : message.descriptor.protocolPath,
      contextIdPrefix,
    });

    if (newestSquash === undefined) {
      return;
    }

    // Reject if the incoming message's timestamp is <= the squash record's timestamp
    if (message.descriptor.messageTimestamp <= newestSquash.descriptor.messageTimestamp) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationSquashBackstop,
        `incoming message timestamp '${message.descriptor.messageTimestamp}' is not newer than ` +
        `the most recent squash record timestamp '${newestSquash.descriptor.messageTimestamp}' ` +
        `at protocol path '${message.descriptor.protocolPath}'.`
      );
    }
  }

  private async authorizeRecordsWrite(tenant: string, recordsWrite: RecordsWrite): Promise<void> {
    // if owner signature is given (`owner` is not `undefined`), it must be the same as the tenant DID
    if (recordsWrite.owner !== undefined && recordsWrite.owner !== tenant) {
      throw new DwnError(
        DwnErrorCode.RecordsWriteOwnerAndTenantMismatch,
        `Owner ${recordsWrite.owner} must be the same as tenant ${tenant} when specified.`
      );
    }

    if (recordsWrite.isSignedByAuthorDelegate) {
      await recordsWrite.authorizeAuthorDelegate(this.deps.validationStateReader);
    }

    if (recordsWrite.isSignedByOwnerDelegate) {
      await recordsWrite.authorizeOwnerDelegate(this.deps.validationStateReader);
    }

    if (recordsWrite.owner !== undefined) {
      // if incoming message is a write retained by this tenant, we by-design always allow
      // NOTE: the "owner === tenant" check is already done earlier in this method
      return;
    } else if (recordsWrite.author === tenant) {
      // if author is the same as the target tenant, we can directly grant access
      return;
    } else if (recordsWrite.author !== undefined && Message.getPermissionGrantId(recordsWrite.signaturePayload!) !== undefined) {
      const permissionGrantId = Message.getPermissionGrantId(recordsWrite.signaturePayload!)!;
      const permissionGrant = await this.deps.validationStateReader.fetchGrant(tenant, permissionGrantId);
      await RecordsGrantAuthorization.authorizeWrite({
        recordsWriteMessage   : recordsWrite.message,
        expectedGrantor       : tenant,
        expectedGrantee       : recordsWrite.author,
        permissionGrant,
        validationStateReader : this.deps.validationStateReader
      });
    } else {
      await ProtocolAuthorization.authorizeWrite(tenant, recordsWrite, this.deps.validationStateReader);
    }
  }
}
