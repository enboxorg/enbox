import type { Filter } from '../types/query-types.js';
import type { ValidationMode } from '../types/validation-state-reader.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { RecordsCountMessage, RecordsCountReply } from '../types/records-types.js';

import { authenticate } from '../core/auth.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { ProtocolAuthorization } from '../core/protocol-authorization.js';
import { Records } from '../utils/records.js';
import { RecordsCount } from '../interfaces/records-count.js';
import { RecordsGrantAuthorization } from '../core/records-grant-authorization.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export class RecordsCountHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message,
    validationMode = 'live'
  }: {tenant: string, message: RecordsCountMessage, validationMode?: ValidationMode}): Promise<RecordsCountReply> {
    let recordsCount: RecordsCount;
    try {
      recordsCount = await RecordsCount.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    let count: number;

    // if this is an anonymous count and the filter supports published records, count only published records
    if (Records.filterIncludesPublishedRecords(recordsCount.message.descriptor.filter) && recordsCount.author === undefined) {
      count = await this.countPublishedRecords(tenant, recordsCount);
    } else {
      // authentication and authorization
      try {
        await authenticate(message.authorization!, this.deps.didResolver);

        await RecordsCountHandler.authorizeRecordsCount(tenant, recordsCount, this.deps, validationMode);
      } catch (e) {
        return messageReplyFromError(e, 401);
      }

      if (recordsCount.author === tenant) {
        count = await this.countRecordsAsOwner(tenant, recordsCount);
      } else {
        count = await this.countRecordsAsNonOwner(tenant, recordsCount);
      }
    }

    return {
      status: { code: 200, detail: 'OK' },
      count,
    };
  }

  /**
   * Counts records as the owner of the DWN with no additional filtering.
   */
  private async countRecordsAsOwner(tenant: string, recordsCount: RecordsCount): Promise<number> {
    const { filter } = recordsCount.message.descriptor;
    const countFilter = {
      ...Records.convertFilter(filter),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true
    };

    return this.deps.messageStore.count(tenant, [countFilter]);
  }

  /**
   * Counts records as a non-owner, applying the same filter logic as RecordsQuery.
   */
  private async countRecordsAsNonOwner(tenant: string, recordsCount: RecordsCount): Promise<number> {
    const { filter } = recordsCount.message.descriptor;
    const filters: Filter[] = [];

    if (Records.filterIncludesPublishedRecords(filter)) {
      filters.push(RecordsCountHandler.buildPublishedRecordsFilter(recordsCount));
    }

    if (Records.filterIncludesUnpublishedRecords(filter)) {
      if (Records.shouldBuildUnpublishedAuthorFilter(filter, recordsCount.author!)) {
        filters.push(RecordsCountHandler.buildUnpublishedRecordsByCountAuthorFilter(recordsCount));
      }

      if (Records.shouldProtocolAuthorize(recordsCount.signaturePayload!)) {
        filters.push(RecordsCountHandler.buildUnpublishedProtocolAuthorizedRecordsFilter(recordsCount));
      }

      if (Message.getPermissionGrantId(recordsCount.signaturePayload!) !== undefined) {
        filters.push(RecordsCountHandler.buildUnpublishedPermissionGrantAuthorizedRecordsFilter(recordsCount));
      }

      if (Records.shouldBuildUnpublishedRecipientFilter(filter, recordsCount.author!)) {
        filters.push(RecordsCountHandler.buildUnpublishedRecordsForCountAuthorFilter(recordsCount));
      }
    }

    return this.deps.messageStore.count(tenant, filters);
  }

  /**
   * Counts only published records.
   */
  private async countPublishedRecords(tenant: string, recordsCount: RecordsCount): Promise<number> {
    const filter = RecordsCountHandler.buildPublishedRecordsFilter(recordsCount);
    return this.deps.messageStore.count(tenant, [filter]);
  }

  private static buildPublishedRecordsFilter(recordsCount: RecordsCount): Filter {
    const { filter } = recordsCount.message.descriptor;
    return {
      ...Records.convertFilter(filter),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      published         : true,
      isLatestBaseState : true
    };
  }

  /**
   * Creates a filter for unpublished records that are intended for the count author (where `recipient` is the author).
   */
  private static buildUnpublishedRecordsForCountAuthorFilter(recordsCount: RecordsCount): Filter {
    const { filter } = recordsCount.message.descriptor;
    return {
      ...Records.convertFilter(filter),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      recipient         : recordsCount.author!,
      isLatestBaseState : true,
      published         : false
    };
  }

  /**
   * Creates a filter for unpublished records that are within the specified protocol.
   */
  private static buildUnpublishedProtocolAuthorizedRecordsFilter(recordsCount: RecordsCount): Filter {
    const { filter } = recordsCount.message.descriptor;
    return {
      ...Records.convertFilter(filter),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      published         : false
    };
  }

  /**
   * Creates a filter for unpublished records authorized by a permission grant.
   */
  private static buildUnpublishedPermissionGrantAuthorizedRecordsFilter(recordsCount: RecordsCount): Filter {
    const { filter } = recordsCount.message.descriptor;
    return {
      ...Records.convertFilter(filter),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      published         : false
    };
  }

  /**
   * Creates a filter for only unpublished records where the author is the same as the count author.
   */
  private static buildUnpublishedRecordsByCountAuthorFilter(recordsCount: RecordsCount): Filter {
    const { filter } = recordsCount.message.descriptor;
    return {
      ...Records.convertFilter(filter),
      author            : recordsCount.author!,
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      published         : false
    };
  }

  /**
   * @param messageStore Used to check if the grant has been revoked.
   */
  private static async authorizeRecordsCount(
    tenant: string,
    recordsCount: RecordsCount,
    deps: HandlerDependencies,
    validationMode: ValidationMode,
  ): Promise<void> {

    if (Message.isSignedByAuthorDelegate(recordsCount.message)) {
      await recordsCount.authorizeDelegate(deps.validationStateReader);
    }

    const permissionGrantId = Message.getPermissionGrantId(recordsCount.signaturePayload!);
    if (permissionGrantId !== undefined) {
      const permissionGrant = await deps.validationStateReader.fetchGrant(tenant, permissionGrantId);
      await RecordsGrantAuthorization.authorizeQueryOrSubscribe({
        incomingMessage       : recordsCount.message,
        expectedGrantor       : tenant,
        expectedGrantee       : recordsCount.author!,
        permissionGrant,
        validationStateReader : deps.validationStateReader,
      });
      return;
    }

    // NOTE: not all RecordsCount messages require protocol authorization even if the filter includes protocol-related fields,
    // this is because we dynamically filter out records that the caller is not authorized to see.
    // Currently only run protocol authorization if message deliberately invokes a protocol role.
    if (Records.shouldProtocolAuthorize(recordsCount.signaturePayload!)) {
      await ProtocolAuthorization.authorizeQueryOrSubscribe(tenant, recordsCount, deps.validationStateReader, validationMode);
    }
  }
}
