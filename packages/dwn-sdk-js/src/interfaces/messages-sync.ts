import type { MessageSigner } from '../types/signer.js';
import type { RecordsProjectionScope } from '../sync/records-projection.js';
import type { MessagesSyncAction, MessagesSyncDescriptor, MessagesSyncMessage } from '../types/messages-types.js';

import { AbstractMessage } from '../core/abstract-message.js';
import { Message } from '../core/message.js';
import { RECORDS_PROJECTION_ROOT_VERSION } from '../sync/records-projection.js';
import { removeUndefinedProperties } from '@enbox/common';
import { Time } from '../utils/time.js';
import { validateProtocolUrlNormalized } from '../utils/url.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export type MessagesSyncOptions = {
  signer : MessageSigner;
  action : MessagesSyncAction;
  protocol? : string;
  projectionRootVersion?: string;
  projectionScopes?: RecordsProjectionScope[];
  prefix? : string;
  messageTimestamp? : string;
  permissionGrantIds? : string[];
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
    if (message.descriptor.projectionRootVersion !== undefined &&
      message.descriptor.projectionRootVersion !== RECORDS_PROJECTION_ROOT_VERSION) {
      throw new DwnError(
        DwnErrorCode.MessagesSyncUnsupportedProjectionRootVersion,
        `Unsupported projection root version ${message.descriptor.projectionRootVersion}`
      );
    }
    for (const scope of message.descriptor.projectionScopes ?? []) {
      validateProtocolUrlNormalized(scope.protocol);
    }

    return new MessagesSync(message);
  }

  public static async create(options: MessagesSyncOptions): Promise<MessagesSync> {
    const permissionGrantInvocation = Message.normalizePermissionGrantInvocation({
      permissionGrantIds: options.permissionGrantIds
    });

    const descriptor: MessagesSyncDescriptor = {
      interface             : DwnInterfaceName.Messages,
      method                : DwnMethodName.Sync,
      messageTimestamp      : options.messageTimestamp ?? Time.getCurrentTimestamp(),
      action                : options.action,
      protocol              : options.protocol,
      projectionRootVersion : options.projectionRootVersion,
      projectionScopes      : options.projectionScopes,
      prefix                : options.prefix,
      hashes                : options.hashes,
      depth                 : options.depth,
      ...permissionGrantInvocation,
    };

    removeUndefinedProperties(descriptor);

    const { signer } = options;
    const authorization = await Message.createAuthorization({
      descriptor,
      signer,
      ...permissionGrantInvocation
    });

    const message = { descriptor, authorization };

    Message.validateJsonSchema(message);

    return new MessagesSync(message);
  }
}
