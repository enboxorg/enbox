import type { MessageSigner } from '../types/signer.js';
import type { Pagination } from '../types/message-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { DataEncodedRecordsWriteMessage, RecordsFilter, RecordsQueryDescriptor, RecordsQueryMessage } from '../types/records-types.js';

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
import { validateProtocolUrlNormalized, validateSchemaUrlNormalized } from '../utils/url.js';

export type RecordsQueryOptions = {
  messageTimestamp?: string;
  filter: RecordsFilter;
  dateSort?: DateSort;
  pagination?: Pagination;
  signer?: MessageSigner;
  permissionGrantId?: string;
  protocolRole?: string;

  /**
   * The delegated grant to sign on behalf of the logical author, which is the grantor (`grantedBy`) of the delegated grant.
   */
  delegatedGrant?: DataEncodedRecordsWriteMessage;
};

/**
 * A class representing a RecordsQuery DWN message.
 */
export class RecordsQuery extends AbstractMessage<RecordsQueryMessage> {

  public static async parse(message: RecordsQueryMessage): Promise<RecordsQuery> {

    if (message.descriptor.filter.published === false) {
      if (message.descriptor.dateSort === DateSort.PublishedAscending || message.descriptor.dateSort === DateSort.PublishedDescending) {
        throw new DwnError(
          DwnErrorCode.RecordsQueryParseFilterPublishedSortInvalid,
          `queries must not filter for \`published:false\` and sort by ${message.descriptor.dateSort}`
        );
      }
    }

    let signaturePayload;
    if (message.authorization !== undefined) {
      signaturePayload = await Message.validateSignatureStructure(message.authorization.signature, message.descriptor);
    }

    await Records.validateDelegatedGrantReferentialIntegrity(message, signaturePayload);
    Records.validateNestedProtocolPathScope(
      message.descriptor.filter,
      DwnErrorCode.RecordsQueryNestedProtocolPathContextIdInvalid,
      'RecordsQuery'
    );

    if (signaturePayload?.protocolRole !== undefined) {
      if (message.descriptor.filter.protocolPath === undefined) {
        throw new DwnError(
          DwnErrorCode.RecordsQueryFilterMissingRequiredProperties,
          'Role-authorized queries must include `protocolPath` in the filter'
        );
      }
    }

    if (message.descriptor.filter.protocol !== undefined) {
      validateProtocolUrlNormalized(message.descriptor.filter.protocol);
    }
    if (message.descriptor.filter.schema !== undefined) {
      validateSchemaUrlNormalized(message.descriptor.filter.schema);
    }

    Time.validateTimestamp(message.descriptor.messageTimestamp);

    return new RecordsQuery(message);
  }

  public static async create(options: RecordsQueryOptions): Promise<RecordsQuery> {
    const permissionGrantInvocation = Message.normalizePermissionGrantInvocation({
      permissionGrantId: options.permissionGrantId,
    });

    const descriptor: RecordsQueryDescriptor = {
      interface        : DwnInterfaceName.Records,
      method           : DwnMethodName.Query,
      messageTimestamp : options.messageTimestamp ?? Time.getCurrentTimestamp(),
      filter           : Records.normalizeFilter(options.filter),
      ...permissionGrantInvocation,
      dateSort         : options.dateSort,
      pagination       : options.pagination,
    };

    if (options.filter.published === false) {
      if (options.dateSort === DateSort.PublishedAscending || options.dateSort === DateSort.PublishedDescending) {
        throw new DwnError(
          DwnErrorCode.RecordsQueryCreateFilterPublishedSortInvalid,
          `queries must not filter for \`published:false\` and sort by ${options.dateSort}`
        );
      }
    }

    // delete all descriptor properties that are `undefined` else the code will encounter the following IPLD issue when attempting to generate CID:
    // Error: `undefined` is not supported by the IPLD Data Model and cannot be encoded
    removeUndefinedProperties(descriptor);

    // only generate the `authorization` property if signature input is given
    const signer = options.signer;
    let authorization;
    if (signer) {
      authorization = await Message.createAuthorization({
        descriptor,
        signer,
        ...permissionGrantInvocation,
        protocolRole   : options.protocolRole,
        delegatedGrant : options.delegatedGrant
      });
    }
    const message = { descriptor, authorization };

    Message.validateJsonSchema(message);

    return new RecordsQuery(message);
  }

  /**
   * Authorizes the delegate who signed this message.
   * @param validationStateReader Used to check if the grant has been revoked.
   */
  public async authorizeDelegate(validationStateReader: ValidationStateReader): Promise<void> {
    const delegatedGrant = PermissionGrant.parse(this.message.authorization!.authorDelegatedGrant!);
    await RecordsGrantAuthorization.authorizeQueryOrSubscribe({
      incomingMessage : this.message,
      expectedGrantee : this.signer!,
      expectedGrantor : this.author!,
      permissionGrant : delegatedGrant,
      validationStateReader
    });
  }
}
