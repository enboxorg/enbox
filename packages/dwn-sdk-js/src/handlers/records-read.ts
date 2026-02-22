import type { DataStore } from '../types/data-store.js';
import type { DidResolver } from '@enbox/dids';
import type { Filter } from '../types/query-types.js';
import type { MessageStore } from '../types//message-store.js';
import type { MethodHandler } from '../types/method-handler.js';
import type { RecordsDeleteMessage, RecordsQueryReplyEntry, RecordsReadMessage, RecordsReadReply } from '../types/records-types.js';

import { authenticate } from '../core/auth.js';
import { DataStream } from '../utils/data-stream.js';
import { Encoder } from '../utils/encoder.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
import { ProtocolAuthorization } from '../core/protocol-authorization.js';
import { Records } from '../utils/records.js';
import { RecordsGrantAuthorization } from '../core/records-grant-authorization.js';
import { RecordsRead } from '../interfaces/records-read.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export class RecordsReadHandler implements MethodHandler {

  constructor(private didResolver: DidResolver, private messageStore: MessageStore, private dataStore: DataStore) { }

  public async handle({
    tenant,
    message
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
        await authenticate(message.authorization!, this.didResolver);
      }
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    // get the latest active message matching the supplied filter, sorted and limited to 1 result
    const query: Filter = {
      // NOTE: we don't filter by `method` so that we get both RecordsWrite and RecordsDelete messages
      interface         : DwnInterfaceName.Records,
      isLatestBaseState : true,
      ...Records.convertFilter(message.descriptor.filter)
    };
    const messageSort = Records.convertDateSort(message.descriptor.dateSort);
    const { messages: existingMessages } = await this.messageStore.query(tenant, [ query ], messageSort, { limit: 1 });
    if (existingMessages.length === 0) {
      return {
        status: { code: 404, detail: 'Not Found' }
      };
    }

    const matchedMessage = existingMessages[0];

    // If the matched message is a RecordsDelete, authorize against the newest RecordsWrite
    // (for parity with the live-record path which authorizes against the latest write),
    // then return 404 with both the RecordsDelete and the initial RecordsWrite.
    if (matchedMessage.descriptor.method === DwnMethodName.Delete) {
      const recordsDeleteMessage = matchedMessage as RecordsDeleteMessage;
      const recordId = recordsDeleteMessage.descriptor.recordId;

      const initialWrite = await RecordsWrite.fetchInitialRecordsWriteMessage(this.messageStore, tenant, recordId);
      if (initialWrite === undefined) {
        return messageReplyFromError(new DwnError(
          DwnErrorCode.RecordsReadInitialWriteNotFound,
          'initial write for deleted record not found'
        ), 400);
      }

      // Authorize against the newest RecordsWrite so that mutable properties like `published`
      // reflect the record's state at the time of deletion, not just the initial write.
      let newestWrite;
      try {
        newestWrite = await RecordsWrite.fetchNewestRecordsWrite(this.messageStore, tenant, recordId);
      } catch {
        // If newest write is not found (should not happen since initial write exists),
        // fall back to the initial write for authorization.
        newestWrite = initialWrite;
      }
      const parsedNewestWrite = await RecordsWrite.parse(newestWrite);

      try {
        await RecordsReadHandler.authorizeRecordsRead(tenant, recordsRead, parsedNewestWrite, this.messageStore);
      } catch (error) {
        return messageReplyFromError(error, 401);
      }

      return {
        status : { code: 404, detail: 'Not Found' },
        entry  : {
          recordsDelete: recordsDeleteMessage,
          initialWrite,
        }
      };
    }

    // else the matched message is a RecordsWrite
    const matchedRecordsWrite = matchedMessage as RecordsQueryReplyEntry;

    try {
      await RecordsReadHandler.authorizeRecordsRead(tenant, recordsRead, await RecordsWrite.parse(matchedRecordsWrite), this.messageStore);
    } catch (error) {
      return messageReplyFromError(error, 401);
    }

    let data;
    if (matchedRecordsWrite.encodedData !== undefined) {
      const dataBytes = Encoder.base64UrlToBytes(matchedRecordsWrite.encodedData);
      data = DataStream.fromBytes(dataBytes);
      delete matchedRecordsWrite.encodedData;
    } else {
      const result = await this.dataStore.get(tenant, matchedRecordsWrite.recordId, matchedRecordsWrite.descriptor.dataCid);
      if (result?.dataStream === undefined) {
        return {
          status: { code: 404, detail: 'Not Found' }
        };
      }
      data = result.dataStream;
    }

    const recordsReadReply: RecordsReadReply = {
      status : { code: 200, detail: 'OK' },
      entry  : {
        recordsWrite: matchedRecordsWrite,
        data
      }
    };

    // attach initial write if latest RecordsWrite is not initial write
    if (!await RecordsWrite.isInitialWrite(matchedRecordsWrite)) {
      const initialWriteQueryResult = await this.messageStore.query(
        tenant,
        [{ recordId: matchedRecordsWrite.recordId, isLatestBaseState: false, method: DwnMethodName.Write }]
      );
      const initialWrite = initialWriteQueryResult.messages[0] as RecordsQueryReplyEntry;
      delete initialWrite.encodedData; // just defensive because technically should already be deleted when a later RecordsWrite is written
      recordsReadReply.entry!.initialWrite = initialWrite;
    }

    return recordsReadReply;
  };

  /**
   * @param messageStore Used to check if the grant has been revoked.
   */
  private static async authorizeRecordsRead(
    tenant: string,
    recordsRead: RecordsRead,
    matchedRecordsWrite: RecordsWrite,
    messageStore: MessageStore
  ): Promise<void> {
    if (Message.isSignedByAuthorDelegate(recordsRead.message)) {
      await recordsRead.authorizeDelegate(matchedRecordsWrite.message, messageStore);
    }

    const { descriptor } = matchedRecordsWrite.message;

    // if author is the same as the target tenant, we can directly grant access
    if (recordsRead.author === tenant) {
      return;
    } else if (descriptor.published === true) {
      // authentication is not required for published data
      return;
    } else if (recordsRead.author !== undefined &&
      (recordsRead.author === descriptor.recipient || recordsRead.author === matchedRecordsWrite.author)
    ) {
      // The recipient or author of a message may always read it
      return;
    } else if (recordsRead.author !== undefined && recordsRead.signaturePayload!.permissionGrantId !== undefined) {
      const permissionGrant = await PermissionsProtocol.fetchGrant(tenant, messageStore, recordsRead.signaturePayload!.permissionGrantId);
      await RecordsGrantAuthorization.authorizeRead({
        recordsReadMessage          : recordsRead.message,
        recordsWriteMessageToBeRead : matchedRecordsWrite.message,
        expectedGrantor             : tenant,
        expectedGrantee             : recordsRead.author,
        permissionGrant,
        messageStore
      });
    } else {
      await ProtocolAuthorization.authorizeRead(tenant, recordsRead, matchedRecordsWrite, messageStore);
    }
  }
}
