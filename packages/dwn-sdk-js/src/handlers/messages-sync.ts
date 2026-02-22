import type { MessageStore } from '../types/message-store.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { MessagesSyncMessage, MessagesSyncReply } from '../types/messages-types.js';

import { authenticate } from '../core/auth.js';
import { hashToHex } from '../smt/smt-utils.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { MessagesGrantAuthorization } from '../core/messages-grant-authorization.js';
import { MessagesSync } from '../interfaces/messages-sync.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';


export class MessagesSyncHandler implements MethodHandler {

  constructor(private deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message
  }: { tenant: string, message: MessagesSyncMessage }): Promise<MessagesSyncReply> {
    let messagesSync: MessagesSync;

    try {
      messagesSync = await MessagesSync.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    try {
      await authenticate(message.authorization, this.deps.didResolver);
      await MessagesSyncHandler.authorizeMessagesSync(tenant, messagesSync, this.deps.messageStore);
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    const { action, protocol, prefix } = message.descriptor;

    try {
      switch (action) {
      case 'root': {
        const rootHash = protocol !== undefined
          ? await this.deps.stateIndex!.getProtocolRoot(tenant, protocol)
          : await this.deps.stateIndex!.getRoot(tenant);
        return {
          status : { code: 200, detail: 'OK' },
          root   : hashToHex(rootHash),
        };
      }

      case 'subtree': {
        const bitPath = MessagesSyncHandler.parseBitPrefix(prefix!);
        const hash = protocol !== undefined
          ? await this.deps.stateIndex!.getProtocolSubtreeHash(tenant, protocol, bitPath)
          : await this.deps.stateIndex!.getSubtreeHash(tenant, bitPath);
        return {
          status : { code: 200, detail: 'OK' },
          hash   : hashToHex(hash),
        };
      }

      case 'leaves': {
        const bitPath = MessagesSyncHandler.parseBitPrefix(prefix!);
        const leaves = protocol !== undefined
          ? await this.deps.stateIndex!.getProtocolLeaves(tenant, protocol, bitPath)
          : await this.deps.stateIndex!.getLeaves(tenant, bitPath);
        return {
          status  : { code: 200, detail: 'OK' },
          entries : leaves,
        };
      }

      default: {
        return {
          status: { code: 400, detail: `Unknown action: ${action as string}` },
        };
      }
      }
    } catch (e) {
      return messageReplyFromError(e, 500);
    }
  }

  /**
   * Parse a bit prefix string (e.g. "0110101") into a boolean array.
   */
  private static parseBitPrefix(prefix: string): boolean[] {
    if (!/^[01]*$/.test(prefix)) {
      throw new DwnError(
        DwnErrorCode.MessagesSyncInvalidPrefix,
        `Invalid prefix: must contain only '0' and '1' characters, got: ${prefix}`
      );
    }
    if (prefix.length > 256) {
      throw new DwnError(
        DwnErrorCode.MessagesSyncInvalidPrefix,
        `Invalid prefix: length must be <= 256, got: ${prefix.length}`
      );
    }
    return Array.from(prefix, (ch): boolean => ch === '1');
  }

  private static async authorizeMessagesSync(
    tenant: string,
    messagesSync: MessagesSync,
    messageStore: MessageStore
  ): Promise<void> {
    if (messagesSync.author === tenant) {
      return;
    } else if (messagesSync.author !== undefined && messagesSync.signaturePayload!.permissionGrantId !== undefined) {
      const permissionGrant = await PermissionsProtocol.fetchGrant(tenant, messageStore, messagesSync.signaturePayload!.permissionGrantId);
      await MessagesGrantAuthorization.authorizeSubscribeOrSync({
        incomingMessage : messagesSync.message,
        expectedGrantor : tenant,
        expectedGrantee : messagesSync.author,
        permissionGrant,
        messageStore
      });
    } else {
      throw new DwnError(DwnErrorCode.MessagesSyncAuthorizationFailed, 'message failed authorization');
    }
  }
}
