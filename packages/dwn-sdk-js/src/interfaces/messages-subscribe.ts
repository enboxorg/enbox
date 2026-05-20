import type { MessagesFilter } from '../types/messages-types.js';
import type { MessageSigner } from '../types/signer.js';
import type { ProgressToken } from '../types/subscriptions.js';
import type { MessagesSubscribeDescriptor, MessagesSubscribeMessage } from '../types/messages-types.js';

import { AbstractMessage } from '../core/abstract-message.js';
import { Message } from '../core/message.js';
import { removeUndefinedProperties } from '@enbox/common';
import { Time } from '../utils/time.js';
import { validateProtocolUrlNormalized } from '../utils/url.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';


export type MessagesSubscribeOptions = {
  signer: MessageSigner;
  messageTimestamp?: string;
  filters?: MessagesFilter[];
  permissionGrantId?: string;
  /**
   * Progress token to resume from. When provided, catch-up events are replayed
   * from the EventLog and an EOSE marker is delivered before live events.
   */
  cursor?: ProgressToken;
};

export class MessagesSubscribe extends AbstractMessage<MessagesSubscribeMessage> {
  public static async parse(message: MessagesSubscribeMessage): Promise<MessagesSubscribe> {
    Message.validateJsonSchema(message);
    await Message.validateSignatureStructure(message.authorization.signature, message.descriptor);

    for (const filter of message.descriptor.filters) {
      if ('protocol' in filter && filter.protocol !== undefined) {
        validateProtocolUrlNormalized(filter.protocol);
      }
    }

    Time.validateTimestamp(message.descriptor.messageTimestamp);
    return new MessagesSubscribe(message);
  }

  /**
   * Creates a MessagesSubscribe message.
   *
   * @throws {DwnError} if json schema validation fails.
   */
  public static async create(
    options: MessagesSubscribeOptions
  ): Promise<MessagesSubscribe> {
    const currentTime = Time.getCurrentTimestamp();

    const descriptor: MessagesSubscribeDescriptor = {
      interface         : DwnInterfaceName.Messages,
      method            : DwnMethodName.Subscribe,
      filters           : options.filters ?? [],
      messageTimestamp  : options.messageTimestamp ?? currentTime,
      permissionGrantId : options.permissionGrantId,
      cursor            : options.cursor,
    };

    removeUndefinedProperties(descriptor);
    const { permissionGrantId, signer } = options;
    const authorization = await Message.createAuthorization({
      descriptor,
      signer,
      permissionGrantId
    });

    const message: MessagesSubscribeMessage = { descriptor, authorization };
    Message.validateJsonSchema(message);
    return new MessagesSubscribe(message);
  }
}
