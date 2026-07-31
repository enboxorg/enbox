import type { DataEncodedRecordsWriteMessage } from '../types/records-types.js';
import type { MessageSigner } from '../types/signer.js';
import type { ProgressToken } from '../types/subscriptions.js';
import type { MessagesFilter, MessagesQueryDescriptor, MessagesQueryMessage } from '../types/messages-types.js';

import { AbstractMessage } from '../core/abstract-message.js';
import { Message } from '../core/message.js';
import { Records } from '../utils/records.js';
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
  protocolRole?: string;
  /** Delegated grant allowing the signer to act for the logical author. */
  delegatedGrant?: DataEncodedRecordsWriteMessage;
};

export class MessagesQuery extends AbstractMessage<MessagesQueryMessage> {
  public static async parse(message: MessagesQueryMessage): Promise<MessagesQuery> {
    Message.validateJsonSchema(message);
    const signaturePayload = await Message.validateSignatureStructure(message.authorization.signature, message.descriptor);
    await Records.validateDelegatedGrantReferentialIntegrity(message, signaturePayload);

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
      signer         : options.signer,
      protocolRole   : options.protocolRole,
      delegatedGrant : options.delegatedGrant,
      ...permissionGrantInvocation,
    });

    const message: MessagesQueryMessage = { descriptor, authorization };
    Message.validateJsonSchema(message);
    return new MessagesQuery(message);
  }
}
