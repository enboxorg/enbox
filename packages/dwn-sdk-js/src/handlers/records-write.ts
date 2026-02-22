import type { GenericMessageReply } from '../types/message-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { RecordsQueryReplyEntry, RecordsWriteMessage } from '../types/records-types.js';

import { authenticate } from '../core/auth.js';
import { Cid } from '../utils/cid.js';
import { DataStream } from '../utils/data-stream.js';
import { DwnConstant } from '../core/dwn-constant.js';
import { Encoder } from '../utils/encoder.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
import { ProtocolAuthorization } from '../core/protocol-authorization.js';
import { RecordsGrantAuthorization } from '../core/records-grant-authorization.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { StorageController } from '../store/storage-controller.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

type HandlerArgs = { tenant: string, message: RecordsWriteMessage, dataStream?: ReadableStream<Uint8Array>};

export class RecordsWriteHandler implements MethodHandler {

  constructor(private deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message,
    dataStream
  }: HandlerArgs): Promise<GenericMessageReply> {
    let recordsWrite: RecordsWrite;
    try {
      recordsWrite = await RecordsWrite.parse(message);

      await ProtocolAuthorization.validateReferentialIntegrity(tenant, recordsWrite, this.deps.messageStore, this.deps.coreProtocols);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    // authentication & authorization
    try {
      await authenticate(message.authorization, this.deps.didResolver, message.attestation);
      await this.authorizeRecordsWrite(tenant, recordsWrite, this.deps.messageStore);
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    // get existing messages matching the `recordId`
    const query = {
      interface : DwnInterfaceName.Records,
      recordId  : message.recordId
    };
    const { messages: existingMessages } = await this.deps.messageStore.query(tenant, [ query ]);

    // if the incoming write is not the initial write, then it must not modify any immutable properties defined by the initial write
    const newMessageIsInitialWrite = await recordsWrite.isInitialWrite();
    let initialWrite: RecordsWriteMessage | undefined;
    if (!newMessageIsInitialWrite) {
      try {
        initialWrite = await RecordsWrite.getInitialWrite(existingMessages);
        RecordsWrite.verifyEqualityOfImmutableProperties(initialWrite, message);
      } catch (e) {
        return messageReplyFromError(e, 400);
      }
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
      return {
        status: { code: 409, detail: 'Conflict' }
      };
    }

    // Look up the core protocol (if any) for the incoming message so that lifecycle hooks
    // can be dispatched generically rather than checking for specific protocol URIs.
    const coreProtocol = message.descriptor.protocol !== undefined
      ? this.deps.coreProtocols?.get(message.descriptor.protocol)
      : undefined;

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
        await coreProtocol.preProcessWrite(tenant, message, this.deps.messageStore);
      }

      // NOTE: We allow isLatestBaseState to be true ONLY if the incoming message comes with data, or if the incoming message is NOT an initial write
      // This would allow an initial write to be written to the DB without data, but having it not queryable,
      // because query implementation filters on `isLatestBaseState` being `true`
      // thus preventing a user's attempt to gain authorized access to data by referencing the dataCid of a private data in their initial writes,
      // See: https://github.com/enboxorg/enbox/issues/359 for more info
      let isLatestBaseState = false;
      let messageWithOptionalEncodedData = message as RecordsQueryReplyEntry;

      if (dataStream !== undefined) {
        messageWithOptionalEncodedData = await this.processMessageWithDataStream(tenant, message, dataStream);
        isLatestBaseState = true;
      } else {
        // else data stream is NOT provided

        // if the incoming message is not an initial write, and no dataStream is provided, we would allow it provided it passes validation
        // processMessageWithoutDataStream() abstracts that logic
        if (!newMessageIsInitialWrite) {
          const newestExistingWrite = newestExistingMessage as RecordsQueryReplyEntry;
          messageWithOptionalEncodedData = await this.processMessageWithoutDataStream(tenant, message, newestExistingWrite );
          isLatestBaseState = true;
        }
      }

      const indexes = await recordsWrite.constructIndexes(isLatestBaseState);
      await this.deps.messageStore.put(tenant, messageWithOptionalEncodedData, indexes);
      await this.deps.stateIndex!.insert(tenant, await Message.getCid(message), indexes);

      // NOTE: We only emit a `RecordsWrite` when the message is the latest base state.
      // Because we allow a `RecordsWrite` which is not the latest state to be written, but not queried, we shouldn't emit it either.
      // It will be emitted as a part of a subsequent next write, if it is the latest base state.
      if (this.deps.eventLog !== undefined && isLatestBaseState) {
        await this.deps.eventLog.emit(tenant, { message, initialWrite }, indexes);
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

    // delete all existing messages of the same record that are not newest, except for the initial write
    await StorageController.deleteAllOlderMessagesButKeepInitialWrite(
      tenant, existingMessages, newestMessage, this.deps.messageStore, this.deps.dataStore!, this.deps.stateIndex!
    );

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
      const dataBytes = await DataStream.toBytes(dataStream!);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);
      RecordsWriteHandler.validateDataIntegrity(message.descriptor.dataCid, message.descriptor.dataSize, dataCid, dataBytes.length);

      // Dispatch schema validation to the core protocol, if applicable.
      const coreProtocol = message.descriptor.protocol !== undefined
        ? this.deps.coreProtocols?.get(message.descriptor.protocol)
        : undefined;
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

        RecordsWriteHandler.validateDataIntegrity(message.descriptor.dataCid, message.descriptor.dataSize, dataCid, DataStorePutResult.dataSize);
      } catch (error) {
        // unwind/delete data if we have issue with storage or the data failed integrity validation
        await this.deps.dataStore!.delete(tenant, message.recordId, message.descriptor.dataCid);

        throw error;
      }
    }

    return messageWithOptionalEncodedData;
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
    RecordsWriteHandler.validateDataIntegrity(dataCid, dataSize, newestExistingWrite.descriptor.dataCid, newestExistingWrite.descriptor.dataSize);

    if (dataSize <= DwnConstant.maxDataSizeAllowedToBeEncoded) {
      // we encode the data from the original write if it is smaller than the data-store threshold
      if (newestExistingWrite.encodedData !== undefined) {
        messageWithOptionalEncodedData.encodedData = newestExistingWrite.encodedData;
      } else {
        throw new DwnError(
          DwnErrorCode.RecordsWriteMissingEncodedDataInPrevious,
          `No dataStream was provided and unable to get data from previous message`
        );
      }
    } else {
      // else just make sure the data is in the data store

      // attempt to retrieve the data from the previous message
      const DataStoreGetResult = await this.deps.dataStore!.get(tenant, newestExistingWrite.recordId, message.descriptor.dataCid);

      if (DataStoreGetResult === undefined) {
        throw new DwnError(
          DwnErrorCode.RecordsWriteMissingDataInPrevious,
          `No dataStream was provided and unable to get data from previous message`
        );
      }
    }

    return messageWithOptionalEncodedData;
  }

  /**
   * Validates the expected `dataCid` and `dataSize` in the descriptor vs the received data.
   *
   * @throws {DwnError} with `DwnErrorCode.RecordsWriteDataCidMismatch`
   *                    if the data stream resulted in a data CID that mismatches with `dataCid` in the given message
   * @throws {DwnError} with `DwnErrorCode.RecordsWriteDataSizeMismatch`
   *                    if `dataSize` in `descriptor` given mismatches the actual data size
   */
  private static validateDataIntegrity(
    expectedDataCid: string,
    expectedDataSize: number,
    actualDataCid: string,
    actualDataSize: number
  ): void {
    if (expectedDataCid !== actualDataCid) {
      throw new DwnError(
        DwnErrorCode.RecordsWriteDataCidMismatch,
        `actual data CID ${actualDataCid} does not match dataCid in descriptor: ${expectedDataCid}`
      );
    }

    if (expectedDataSize !== actualDataSize) {
      throw new DwnError(
        DwnErrorCode.RecordsWriteDataSizeMismatch,
        `actual data size ${actualDataSize} bytes does not match dataSize in descriptor: ${expectedDataSize}`
      );
    }
  }

  private async authorizeRecordsWrite(tenant: string, recordsWrite: RecordsWrite, messageStore: MessageStore): Promise<void> {
    // if owner signature is given (`owner` is not `undefined`), it must be the same as the tenant DID
    if (recordsWrite.owner !== undefined && recordsWrite.owner !== tenant) {
      throw new DwnError(
        DwnErrorCode.RecordsWriteOwnerAndTenantMismatch,
        `Owner ${recordsWrite.owner} must be the same as tenant ${tenant} when specified.`
      );
    }

    if (recordsWrite.isSignedByAuthorDelegate) {
      await recordsWrite.authorizeAuthorDelegate(messageStore);
    }

    if (recordsWrite.isSignedByOwnerDelegate) {
      await recordsWrite.authorizeOwnerDelegate(messageStore);
    }

    if (recordsWrite.owner !== undefined) {
      // if incoming message is a write retained by this tenant, we by-design always allow
      // NOTE: the "owner === tenant" check is already done earlier in this method
      return;
    } else if (recordsWrite.author === tenant) {
      // if author is the same as the target tenant, we can directly grant access
      return;
    } else if (recordsWrite.author !== undefined && recordsWrite.signaturePayload!.permissionGrantId !== undefined) {
      const permissionGrant = await PermissionsProtocol.fetchGrant(tenant, messageStore, recordsWrite.signaturePayload!.permissionGrantId);
      await RecordsGrantAuthorization.authorizeWrite({
        recordsWriteMessage : recordsWrite.message,
        expectedGrantor     : tenant,
        expectedGrantee     : recordsWrite.author,
        permissionGrant,
        messageStore
      });
    } else {
      await ProtocolAuthorization.authorizeWrite(tenant, recordsWrite, messageStore, this.deps.coreProtocols);
    }
  }
}
