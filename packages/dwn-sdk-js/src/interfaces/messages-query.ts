import type { MessageSigner } from '../types/signer.js';
import type { ProgressToken } from '../types/subscriptions.js';
import type { MessagesFilter, MessagesQueryDescriptor, MessagesQueryMessage } from '../types/messages-types.js';

import { AbstractMessage } from '../core/abstract-message.js';
import { Message } from '../core/message.js';
import { removeUndefinedProperties } from '@enbox/common';
import { Time } from '../utils/time.js';
import { validateProtocolUrlNormalized } from '../utils/url.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export type MessagesQueryOptions = {
  signer: MessageSigner;
  messageTimestamp?: string;
  filters?: MessagesFilter[];
  permissionGrantIds?: string[];
  cursor?: ProgressToken;
  limit?: number;
  cidsOnly?: boolean;
};

export class MessagesQuery extends AbstractMessage<MessagesQueryMessage> {
  public static async parse(message: MessagesQueryMessage): Promise<MessagesQuery> {
    Message.validateJsonSchema(message);
    await Message.validateSignatureStructure(message.authorization.signature, message.descriptor);

    for (const filter of message.descriptor.filters) {
      if ('protocol' in filter && filter.protocol !== undefined) {
        validateProtocolUrlNormalized(filter.protocol);
      }
    }

    Time.validateTimestamp(message.descriptor.messageTimestamp);
    return new MessagesQuery(message);
  }

  /**
   * Creates a MessagesQuery message.
   *
   * @throws {DwnError} if json schema validation fails.
   */
  public static async create(options: MessagesQueryOptions): Promise<MessagesQuery> {
    const permissionGrantInvocation = Message.normalizePermissionGrantInvocation({
      permissionGrantIds: options.permissionGrantIds
    });

    const descriptor: MessagesQueryDescriptor = {
      interface        : DwnInterfaceName.Messages,
      method           : DwnMethodName.Query,
      filters          : options.filters ?? [],
      messageTimestamp : options.messageTimestamp ?? Time.getCurrentTimestamp(),
      cursor           : options.cursor,
      limit            : options.limit,
      cidsOnly         : options.cidsOnly,
      ...permissionGrantInvocation,
    };

    removeUndefinedProperties(descriptor);

    const authorization = await Message.createAuthorization({
      descriptor,
      signer: options.signer,
      ...permissionGrantInvocation,
    });

    const message: MessagesQueryMessage = { descriptor, authorization };
    Message.validateJsonSchema(message);
    return new MessagesQuery(message);
  }
}
