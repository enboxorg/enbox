import type { MessageSigner } from '../types/signer.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { DataEncodedRecordsWriteMessage, RecordsFilter , RecordsReadDescriptor, RecordsReadMessage, RecordsWriteMessage } from '../types/records-types.js';

import { AbstractMessage } from '../core/abstract-message.js';
import { DateSort } from '../types/records-types.js';
import { Message } from '../core/message.js';
import { PermissionGrant } from '../protocols/permission-grant.js';
import { Records } from '../utils/records.js';
import { RecordsGrantAuthorization } from '../core/records-grant-authorization.js';
import { removeUndefinedProperties } from '@enbox/common';
import { Time } from '../utils/time.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export type RecordsReadOptions = {
  filter: RecordsFilter;
  messageTimestamp?: string;
  dateSort?: DateSort;
  signer?: MessageSigner;
  permissionGrantId?: string;
  /**
   * Used when authorizing protocol records.
   * The protocol path to the role record type whose recipient is the author of this RecordsRead
   */
  protocolRole?: string;

  /**
   * The delegated grant to sign on behalf of the logical author, which is the grantor (`grantedBy`) of the delegated grant.
   */
  delegatedGrant?: DataEncodedRecordsWriteMessage;

  /** @internal Includes the bounded dependency closure needed to seed a role-holder replica. */
  includeReplicationSupport?: boolean;
};

export class RecordsRead extends AbstractMessage<RecordsReadMessage> {

  public static async parse(message: RecordsReadMessage): Promise<RecordsRead> {
    if (message.descriptor.filter.published === false) {
      if (message.descriptor.dateSort === DateSort.PublishedAscending || message.descriptor.dateSort === DateSort.PublishedDescending) {
        throw new DwnError(
          DwnErrorCode.RecordsReadParseFilterPublishedSortInvalid,
          `reads must not filter for \`published:false\` and sort by ${message.descriptor.dateSort}`
        );
      }
    }

    let signaturePayload;
    if (message.authorization !== undefined) {
      signaturePayload = await Message.validateSignatureStructure(message.authorization.signature, message.descriptor);
    }

    await Records.validateDelegatedGrantReferentialIntegrity(message, signaturePayload);

    Time.validateTimestamp(message.descriptor.messageTimestamp);

    const recordsRead = new RecordsRead(message);
    return recordsRead;
  }

  /**
   * Creates a RecordsRead message.
   * @param options.recordId If `undefined`, will be auto-filled as a originating message as convenience for developer.
   * @param options.date If `undefined`, it will be auto-filled with current time.
   *
   * @throws {DwnError} when a combination of required RecordsReadOptions are missing
   */
  public static async create(options: RecordsReadOptions): Promise<RecordsRead> {
    const { filter, signer, protocolRole, dateSort } = options;
    const currentTime = Time.getCurrentTimestamp();
    const permissionGrantInvocation = Message.normalizePermissionGrantInvocation({
      permissionGrantId: options.permissionGrantId
    });

    if (options.filter.published === false) {
      if (dateSort === DateSort.PublishedAscending || dateSort === DateSort.PublishedDescending) {
        throw new DwnError(
          DwnErrorCode.RecordsReadCreateFilterPublishedSortInvalid,
          `reads must not filter for \`published:false\` and sort by ${dateSort}`
        );
      }
    }

    const descriptor: RecordsReadDescriptor = {
      interface                 : DwnInterfaceName.Records,
      method                    : DwnMethodName.Read,
      filter                    : Records.normalizeFilter(filter),
      messageTimestamp          : options.messageTimestamp ?? currentTime,
      dateSort,
      includeReplicationSupport : options.includeReplicationSupport,
      ...permissionGrantInvocation,
    };

    removeUndefinedProperties(descriptor);

    // only generate the `authorization` property if signature input is given
    let authorization = undefined;
    if (signer !== undefined) {
      authorization = await Message.createAuthorization({
        descriptor,
        signer,
        ...permissionGrantInvocation,
        protocolRole,
        delegatedGrant: options.delegatedGrant
      });
    }
    const message: RecordsReadMessage = { descriptor, authorization };

    Message.validateJsonSchema(message);

    return new RecordsRead(message);
  }

  /**
   * Authorizes the delegate who signed this message.
   * @param validationStateReader Used to check if the grant has been revoked.
   */
  public async authorizeDelegate(matchedRecordsWrite: RecordsWriteMessage, validationStateReader: ValidationStateReader): Promise<void> {
    const delegatedGrant = PermissionGrant.parse(this.message.authorization!.authorDelegatedGrant!);
    await RecordsGrantAuthorization.authorizeRead({
      recordsReadMessage          : this.message,
      recordsWriteMessageToBeRead : matchedRecordsWrite,
      expectedGrantor             : this.author!,
      expectedGrantee             : this.signer!,
      permissionGrant             : delegatedGrant,
      validationStateReader
    });
  }
}
