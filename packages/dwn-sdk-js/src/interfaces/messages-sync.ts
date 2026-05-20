import type { MessageSigner } from '../types/signer.js';
import type { MessagesSyncAction, MessagesSyncDescriptor, MessagesSyncMessage } from '../types/messages-types.js';

import { AbstractMessage } from '../core/abstract-message.js';
import { Message } from '../core/message.js';
import { removeUndefinedProperties } from '@enbox/common';
import { Time } from '../utils/time.js';
import { validateProtocolUrlNormalized } from '../utils/url.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export type MessagesSyncOptions = {
  signer : MessageSigner;
  action : MessagesSyncAction;
  protocol? : string;
  prefix? : string;
  messageTimestamp? : string;
  permissionGrantId? : string;
  /** For `action: 'diff'`: client's subtree hashes at `depth`. */
  hashes? : Record<string, string>;
  /** For `action: 'diff'`: bit depth at which hashes were computed. */
  depth? : number;
};

export class MessagesSync extends AbstractMessage<MessagesSyncMessage> {

  public static async parse(message: MessagesSyncMessage): Promise<MessagesSync> {
    Message.validateJsonSchema(message);
    await Message.validateSignatureStructure(message.authorization.signature, message.descriptor);

    if (message.descriptor.protocol !== undefined) {
      validateProtocolUrlNormalized(message.descriptor.protocol);
    }

    return new MessagesSync(message);
  }

  public static async create(options: MessagesSyncOptions): Promise<MessagesSync> {
    const descriptor: MessagesSyncDescriptor = {
      interface         : DwnInterfaceName.Messages,
      method            : DwnMethodName.Sync,
      messageTimestamp  : options.messageTimestamp ?? Time.getCurrentTimestamp(),
      action            : options.action,
      protocol          : options.protocol,
      prefix            : options.prefix,
      permissionGrantId : options.permissionGrantId,
      hashes            : options.hashes,
      depth             : options.depth,
    };

    removeUndefinedProperties(descriptor);

    const { permissionGrantId, signer } = options;
    const authorization = await Message.createAuthorization({
      descriptor,
      signer,
      permissionGrantId
    });

    const message = { descriptor, authorization };

    Message.validateJsonSchema(message);

    return new MessagesSync(message);
  }
}
