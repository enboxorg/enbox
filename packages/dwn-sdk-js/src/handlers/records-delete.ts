import type { CoreProtocolRegistry } from '../core/core-protocol.js';
import type { GenericMessageReply } from '../types/message-types.js';
import type { MessageStore } from '../types//message-store.js';
import type { RecordsDeleteMessage } from '../types/records-types.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';

import { authenticate } from '../core/auth.js';
import { DwnInterfaceName } from '../enums/dwn-interface-method.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
import { ProtocolAuthorization } from '../core/protocol-authorization.js';
import { Records } from '../utils/records.js';
import { RecordsDelete } from '../interfaces/records-delete.js';
import { RecordsGrantAuthorization } from '../core/records-grant-authorization.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { ResumableTaskName } from '../core/resumable-task-manager.js';

export class RecordsDeleteHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message
  }: { tenant: string, message: RecordsDeleteMessage}): Promise<GenericMessageReply> {
    let recordsDelete: RecordsDelete;
    try {
      recordsDelete = await RecordsDelete.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    // authentication
    try {
      await authenticate(message.authorization, this.deps.didResolver);
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    // get existing records matching the `recordId`
    const query = {
      interface : DwnInterfaceName.Records,
      recordId  : message.descriptor.recordId
    };
    const { messages: existingMessages } = await this.deps.messageStore.query(tenant, [ query ]);

    // find which message is the newest, and if the incoming message is the newest
    const newestExistingMessage = await Message.getNewestMessage(existingMessages);

    if (newestExistingMessage === undefined) {
      return {
        status: { code: 404, detail: 'Not Found' }
      };
    }

    // Tombstone lattice: an incoming tombstone displaces ANY RecordsWrite, even a newer one — the
    // write handler already rejects writes-after-delete regardless of timestamp, so this is the
    // only rule that makes both arrival orders reach the same terminal state. Among competing
    // tombstones one canonical winner stands on every replica: a prune beats a plain delete
    // regardless of timestamp (the cascade is a side effect that must run everywhere), and within
    // the same class the newest (messageTimestamp, then CID) wins. A beaten delete is a Conflict
    // no-op; replication classifies the 409 as Superseded.
    if (await Records.isDeleteBeatenByExistingTombstone(message, newestExistingMessage)) {
      return {
        status: { code: 409, detail: 'Conflict' }
      };
    }

    // authorization
    try {
      // NOTE: We need a RecordsWrite (doesn't have to be initial) to access the immutable properties for delete processing,
      // but if the latest record state is a RecordsDelete (ie. when we are pruning a non-prune delete),
      // we'd need to use the initial write because RecordsDelete does not contain the immutable properties needed for processing.
      const initialWrite = await RecordsWrite.fetchInitialRecordsWrite(this.deps.messageStore, tenant, message.descriptor.recordId);

      await RecordsDeleteHandler.authorizeRecordsDelete(
        tenant,
        recordsDelete,
        initialWrite!,
        this.deps.messageStore,
        this.deps.coreProtocols,
      );
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    await this.deps.resumableTaskManager!.run({
      name : ResumableTaskName.RecordsDelete,
      data : { tenant, message }
    });

    const messageReply = {
      status: { code: 202, detail: 'Accepted' }
    };
    return messageReply;
  };

  /**
   * Authorizes a RecordsDelete message.
   *
   * @param recordsWrite A RecordsWrite of the record to be deleted.
   */
  private static async authorizeRecordsDelete(
    tenant: string,
    recordsDelete: RecordsDelete,
    recordsWrite: RecordsWrite,
    messageStore: MessageStore,
    coreProtocols?: CoreProtocolRegistry,
  ): Promise<void> {

    if (Message.isSignedByAuthorDelegate(recordsDelete.message)) {
      await recordsDelete.authorizeDelegate(recordsWrite.message, messageStore);
    }

    if (recordsDelete.author === tenant) {
      return;
    } else if (recordsDelete.author !== undefined && Message.getPermissionGrantId(recordsDelete.signaturePayload!) !== undefined) {
      const permissionGrantId = Message.getPermissionGrantId(recordsDelete.signaturePayload!)!;
      const permissionGrant = await PermissionsProtocol.fetchGrant(tenant, messageStore, permissionGrantId);
      await RecordsGrantAuthorization.authorizeDelete({
        recordsDeleteMessage : recordsDelete.message,
        recordsWriteToDelete : recordsWrite.message,
        expectedGrantor      : tenant,
        expectedGrantee      : recordsDelete.author,
        permissionGrant,
        messageStore,
      });
    } else {
      await ProtocolAuthorization.authorizeDelete(tenant, recordsDelete, recordsWrite, messageStore, coreProtocols);
    }
  }
};
