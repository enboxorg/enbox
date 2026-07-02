import type { Filter } from '../types/query-types.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { RecordsCountMessage, RecordsCountReply } from '../types/records-types.js';

import { authenticate } from '../core/auth.js';
import { EncryptionControl } from '../core/encryption-control.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { ProtocolAuthorization } from '../core/protocol-authorization.js';
import { Records } from '../utils/records.js';
import { RecordsCount } from '../interfaces/records-count.js';
import { RecordsGrantAuthorization } from '../core/records-grant-authorization.js';
import { countRecordsWithRecordLimitOccupancy, queryRecordsWithRecordLimitOccupancy } from '../utils/record-limit-occupancy.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export class RecordsCountHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message,
  }: {tenant: string, message: RecordsCountMessage}): Promise<RecordsCountReply> {
    let recordsCount: RecordsCount;
    try {
      recordsCount = await RecordsCount.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    let count: number;
    const requester = EncryptionControl.getRequester(recordsCount.message);

    // if this is an anonymous count and the filter supports published records, count only published records
    if (Records.filterIncludesPublishedRecords(recordsCount.message.descriptor.filter) && recordsCount.author === undefined) {
      count = await this.countPublishedRecords(tenant, recordsCount, requester);
    } else {
      // authentication and authorization
      try {
        await authenticate(message.authorization!, this.deps.didResolver);

        await RecordsCountHandler.authorizeRecordsCount(tenant, recordsCount, this.deps);
      } catch (e) {
        return messageReplyFromError(e, 401);
      }

      if (recordsCount.author === tenant && requester === tenant) {
        count = await this.countRecordsAsOwner(tenant, recordsCount);
      } else if (recordsCount.author === tenant) {
        count = await this.countRecordsAsOwnerDelegate(tenant, recordsCount, requester);
      } else {
        count = await this.countRecordsAsNonOwner(tenant, recordsCount, requester);
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

    return this.countProjectedRecords(tenant, recordsCount, [countFilter]);
  }

  private async countRecordsAsOwnerDelegate(
    tenant: string,
    recordsCount: RecordsCount,
    requester: string | undefined,
  ): Promise<number> {
    const { filter } = recordsCount.message.descriptor;
    const countFilter = {
      ...Records.convertFilter(filter),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true
    };

    return this.countProjectedRecordsForRequester(tenant, recordsCount, requester, [countFilter]);
  }

  /**
   * Counts records as a non-owner, applying the same filter logic as RecordsQuery.
   */
  private async countRecordsAsNonOwner(
    tenant: string,
    recordsCount: RecordsCount,
    requester: string | undefined,
  ): Promise<number> {
    const { filter } = recordsCount.message.descriptor;
    const filters: Filter[] = [];

    if (Records.filterIncludesPublishedRecords(filter)) {
      filters.push(RecordsCountHandler.buildPublishedRecordsFilter(recordsCount));
    }

    if (Records.filterIncludesUnpublishedRecords(filter)) {
      if (EncryptionControl.isExactAudienceFilter(filter)) {
        filters.push(Records.buildUnpublishedControlRecordsFilter(filter));
      }

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

    return this.countProjectedRecordsForRequester(tenant, recordsCount, requester, filters);
  }

  /**
   * Counts only published records.
   */
  private async countPublishedRecords(
    tenant: string,
    recordsCount: RecordsCount,
    requester: string | undefined,
  ): Promise<number> {
    const filter = RecordsCountHandler.buildPublishedRecordsFilter(recordsCount);
    return this.countProjectedRecordsForRequester(tenant, recordsCount, requester, [filter]);
  }

  private async countProjectedRecords(tenant: string, recordsCount: RecordsCount, filters: Filter[]): Promise<number> {
    return countRecordsWithRecordLimitOccupancy({
      messageStore          : this.deps.messageStore,
      validationStateReader : this.deps.validationStateReader,
      tenant,
      filters,
      messageTimestamp      : recordsCount.message.descriptor.messageTimestamp,
    });
  }

  private async countProjectedRecordsForRequester(
    tenant: string,
    recordsCount: RecordsCount,
    requester: string | undefined,
    filters: Filter[],
  ): Promise<number> {
    const controlFilters = Records.buildControlRecordsFilters(filters);
    if (controlFilters.length === 0) {
      return this.countProjectedRecords(tenant, recordsCount, filters);
    }

    const totalCount = await this.countProjectedRecords(tenant, recordsCount, filters);
    const controlCount = await this.countProjectedRecords(tenant, recordsCount, controlFilters);
    if (controlCount === 0) {
      return totalCount;
    }

    const { messages } = await queryRecordsWithRecordLimitOccupancy({
      messageStore          : this.deps.messageStore,
      validationStateReader : this.deps.validationStateReader,
      tenant,
      filters               : controlFilters,
      messageTimestamp      : recordsCount.message.descriptor.messageTimestamp,
    });
    const visibleMessages = await EncryptionControl.filterVisibleControlRecords({
      tenant,
      incomingMessage       : recordsCount.message,
      requester,
      recordsWriteMessages  : messages,
      validationStateReader : this.deps.validationStateReader,
    });
    return totalCount - controlCount + visibleMessages.length;
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
      await ProtocolAuthorization.authorizeQueryOrSubscribe(tenant, recordsCount, deps.validationStateReader);
    }
  }

}
