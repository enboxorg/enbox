import type { GenericMessage } from '../types/message-types.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { MessagesReadMessage, MessagesReadReply, MessagesReadReplyEntry } from '../types/messages-types.js';

import { authenticate } from '../core/auth.js';
import { DataStream } from '../utils/data-stream.js';
import { Encoder } from '../utils/encoder.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { Messages } from '../utils/messages.js';
import { MessagesGrantAuthorization } from '../core/messages-grant-authorization.js';
import { MessagesRead } from '../interfaces/messages-read.js';
import { Records } from '../utils/records.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

type HandleArgs = { tenant: string, message: MessagesReadMessage };

export class MessagesReadHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) {}

  public async handle({ tenant, message }: HandleArgs): Promise<MessagesReadReply> {
    let messagesRead: MessagesRead;

    try {
      messagesRead = await MessagesRead.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    try {
      await authenticate(message.authorization, this.deps.didResolver);
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    const messageResult = await this.deps.messageStore.get(tenant, message.descriptor.messageCid);
    if (messageResult === undefined) {
      return { status: { code: 404, detail: 'Not Found' } };
    }

    let metadataOnly: boolean;
    try {
      metadataOnly = await MessagesReadHandler.authorizeMessagesRead(tenant, messagesRead, messageResult, this.deps);
    } catch (error) {
      return messageReplyFromError(error, 401);
    }

    // Owner and protocol-wide RecordsWrite reads include data when available.
    // Subtree grants receive only the signed message and its metadata.
    const { message: replyMessage, encodedData } = Messages.detachEncodedData(messageResult);
    const entry: MessagesReadReplyEntry = { message: replyMessage, messageCid: message.descriptor.messageCid };
    if (!metadataOnly && Records.isRecordsWrite(messageResult)) {
      // RecordsWrite specific handling, if MessageStore has embedded `encodedData` return it with the entry.
      // we store `encodedData` along with the message if the data is below a certain threshold.
      if (encodedData === undefined) {
        // check the data store for the associated data
        const result = await this.deps.dataStore!.get(tenant, messageResult.recordId, messageResult.descriptor.dataCid);
        if (result?.dataStream !== undefined) {
          entry.data = result.dataStream;
        }
      } else {
        const dataBytes = Encoder.base64UrlToBytes(encodedData);
        entry.data = DataStream.fromBytes(dataBytes);
      }
    }

    return {
      status: { code: 200, detail: 'OK' },
      entry
    };
  }

  /**
   * @param deps Used to fetch related permission grant, permission revocation, and/or RecordsWrites for permission scope validation.
   */
  private static async authorizeMessagesRead(
    tenant: string,
    messagesRead: MessagesRead,
    matchedMessage: GenericMessage,
    deps: HandlerDependencies
  ): Promise<boolean> {

    const requester = Message.getRequester(messagesRead.message);
    if (messagesRead.author === tenant && requester === tenant) {
      // If the author is the tenant, no further authorization is needed
      return false;
    }

    const permissionGrantIds = Message.getPermissionGrantIds(messagesRead.signaturePayload!);
    if (requester !== undefined && permissionGrantIds.length > 0) {
      const permissionGrants = await MessagesGrantAuthorization.fetchPermissionGrants(tenant, deps.validationStateReader, permissionGrantIds);
      return MessagesGrantAuthorization.authorizeMessagesRead({
        messagesReadMessage   : messagesRead.message,
        messageToRead         : matchedMessage,
        expectedGrantor       : tenant,
        expectedGrantee       : requester,
        permissionGrants,
        validationStateReader : deps.validationStateReader
      });
    }

    throw new DwnError(DwnErrorCode.MessagesReadAuthorizationFailed, 'protocol message failed authorization');
  }
}
