import type { KeyValues } from '../types/query-types.js';
import type { MessageSigner } from '../types/signer.js';
import type { MessageStore } from '../types//message-store.js';
import type { DataEncodedRecordsWriteMessage, RecordsDeleteDescriptor, RecordsDeleteMessage, RecordsWriteMessage } from '../types/records-types.js';

import { AbstractMessage } from '../core/abstract-message.js';
import { Message } from '../core/message.js';
import { PermissionGrant } from '../protocols/permission-grant.js';
import { Records } from '../utils/records.js';
import { RecordsGrantAuthorization } from '../core/records-grant-authorization.js';
import { removeUndefinedProperties } from '@enbox/common';
import { Time } from '../utils/time.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export type RecordsDeleteOptions = {
  recordId: string;
  messageTimestamp?: string;
  protocolRole?: string;
  signer: MessageSigner;

  /**
   * Denotes if all the descendent records should be purged. Defaults to `false`.
   */
  prune?: boolean

  /**
   * The ID of the permission grant authorizing this delete.
   */
  permissionGrantId?: string;

  /**
   * The delegated grant to sign on behalf of the logical author, which is the grantor (`grantedBy`) of the delegated grant.
   */
  delegatedGrant?: DataEncodedRecordsWriteMessage;
};

export class RecordsDelete extends AbstractMessage<RecordsDeleteMessage> {

  public static async parse(message: RecordsDeleteMessage): Promise<RecordsDelete> {
    let signaturePayload;
    if (message.authorization !== undefined) {
      signaturePayload = await Message.validateSignatureStructure(message.authorization.signature, message.descriptor);
    }

    await Records.validateDelegatedGrantReferentialIntegrity(message, signaturePayload);

    Time.validateTimestamp(message.descriptor.messageTimestamp);

    const recordsDelete = new RecordsDelete(message);
    return recordsDelete;
  }

  /**
   * Creates a RecordsDelete message.
   * @param options.recordId If `undefined`, will be auto-filled as a originating message as convenience for developer.
   * @param options.messageTimestamp If `undefined`, it will be auto-filled with current time.
   */
  public static async create(options: RecordsDeleteOptions): Promise<RecordsDelete> {
    const recordId = options.recordId;
    const currentTime = Time.getCurrentTimestamp();
    const permissionGrantInvocation = Message.normalizePermissionGrantInvocation({
      permissionGrantId: options.permissionGrantId,
    });

    const descriptor: RecordsDeleteDescriptor = {
      interface        : DwnInterfaceName.Records,
      method           : DwnMethodName.Delete,
      messageTimestamp : options.messageTimestamp ?? currentTime,
      recordId,
      prune            : options.prune ?? false,
      ...permissionGrantInvocation,
    };

    const authorization = await Message.createAuthorization({
      descriptor,
      signer         : options.signer,
      protocolRole   : options.protocolRole,
      ...permissionGrantInvocation,
      delegatedGrant : options.delegatedGrant
    });
    const message: RecordsDeleteMessage = { descriptor, authorization };

    Message.validateJsonSchema(message);

    return new RecordsDelete(message);
  }

  /**
   * Indexed properties needed for MessageStore indexing.
   *
   * Immutable record facts (`protocol`, `protocolPath`, `recipient`, `schema`, `parentId`,
   * `dateCreated`, `contextId`) come from the initial `RecordsWrite`. Mutable query-visibility
   * facts (flattened `tag.*`, `published`, and `datePublished`) come from the newest retained
   * `RecordsWrite` that existed immediately before this delete, because tombstone visibility must
   * reflect the record state being deleted: without them, tombstones of tagged records never match
   * tag filters (e.g. the permission shadow filters on `tag.protocol`) and tombstones of published
   * records never match `published: true` or `datePublished` queries and subscriptions.
   */
  public constructIndexes(
    initialWrite: RecordsWriteMessage,
    visibilitySourceWrite: RecordsWriteMessage,
  ): KeyValues {
    const message = this.message;
    const descriptor = { ...message.descriptor };

    // we add the immutable properties from the initial RecordsWrite message in order to use them when querying relevant deletes.
    const { protocol, protocolPath, recipient, schema, parentId, dateCreated } = initialWrite.descriptor;

    // Mutable visibility facts come from the newest retained RecordsWrite that held them before deletion.
    const { tags, published, datePublished } = visibilitySourceWrite.descriptor;

    const indexes: { [key:string]: string | number | boolean | string[] | number[] | undefined } = {
      isLatestBaseState : true,
      published         : !!published,
      datePublished,
      protocol, protocolPath, recipient, schema, parentId, dateCreated,
      contextId         : initialWrite.contextId,
      author            : this.author!,
      ...descriptor
    };
    removeUndefinedProperties(indexes);

    // tags are flattened into `tag.<property>` keys to avoid name clashes with first-class index
    // keys, matching the flattening the RecordsWrite indexing path performs.
    if (tags !== undefined) {
      return { ...indexes, ...Records.buildTagIndexes({ ...tags }) } as KeyValues;
    }

    return indexes as KeyValues;
  }

  /*
   * Authorizes the delegate who signed the message.
   * @param messageStore Used to check if the grant has been revoked.
   */
  public async authorizeDelegate(recordsWriteToDelete: RecordsWriteMessage, messageStore: MessageStore): Promise<void> {
    const delegatedGrant = PermissionGrant.parse(this.message.authorization.authorDelegatedGrant!);
    await RecordsGrantAuthorization.authorizeDelete({
      recordsDeleteMessage : this.message,
      recordsWriteToDelete,
      expectedGrantor      : this.author!,
      expectedGrantee      : this.signer!,
      permissionGrant      : delegatedGrant,
      messageStore
    });
  }
}
