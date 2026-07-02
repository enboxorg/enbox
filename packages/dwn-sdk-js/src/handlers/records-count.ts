import type { Filter } from '../types/query-types.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { RecordsCountMessage, RecordsCountReply, RecordsWriteMessage } from '../types/records-types.js';

import { authenticate } from '../core/auth.js';
import { EncryptionControl } from '../core/encryption-control.js';
import { isEncryptionControlPath } from '../core/constants.js';
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

    // if this is an anonymous count and the filter supports published records, count only published records
    if (Records.filterIncludesPublishedRecords(recordsCount.message.descriptor.filter) && recordsCount.author === undefined) {
      count = await this.countPublishedRecords(tenant, recordsCount);
    } else {
      // authentication and authorization
      try {
        await authenticate(message.authorization!, this.deps.didResolver);

        await RecordsCountHandler.authorizeRecordsCount(tenant, recordsCount, this.deps);
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

    return this.countProjectedRecords(tenant, recordsCount, [countFilter]);
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
      if (EncryptionControl.isExactAudienceFilter(filter)) {
        filters.push(RecordsCountHandler.buildUnpublishedControlRecordsFilter(recordsCount));
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

    return this.countProjectedRecordsAsNonOwner(tenant, recordsCount, filters);
  }

  /**
   * Counts only published records.
   */
  private async countPublishedRecords(tenant: string, recordsCount: RecordsCount): Promise<number> {
    const filter = RecordsCountHandler.buildPublishedRecordsFilter(recordsCount);
    return this.countProjectedRecords(tenant, recordsCount, [filter]);
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

  private async countProjectedRecordsAsNonOwner(tenant: string, recordsCount: RecordsCount, filters: Filter[]): Promise<number> {
    if (!RecordsCountHandler.filtersMayIncludeControlRecords(filters)) {
      return this.countProjectedRecords(tenant, recordsCount, filters);
    }

    const { messages } = await queryRecordsWithRecordLimitOccupancy({
      messageStore          : this.deps.messageStore,
      validationStateReader : this.deps.validationStateReader,
      tenant,
      filters,
      messageTimestamp      : recordsCount.message.descriptor.messageTimestamp,
    });
    const visibleMessages = await this.filterControlRecordsForNonOwner(tenant, recordsCount, messages);
    return visibleMessages.length;
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

  private static buildUnpublishedControlRecordsFilter(recordsCount: RecordsCount): Filter {
    const { filter } = recordsCount.message.descriptor;
    return {
      ...Records.convertFilter(filter),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      published         : false,
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

  private static filtersMayIncludeControlRecords(filters: Filter[]): boolean {
    return filters.some((filter): boolean => {
      const protocolPath = filter.protocolPath;
      return typeof protocolPath !== 'string' || isEncryptionControlPath(protocolPath);
    });
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

  private async filterControlRecordsForNonOwner(
    tenant: string,
    recordsCount: RecordsCount,
    recordsWrites: RecordsWriteMessage[],
  ): Promise<RecordsWriteMessage[]> {
    const visibleRecordsWrites: RecordsWriteMessage[] = [];
    for (const recordsWrite of recordsWrites) {
      if (!EncryptionControl.isControlMessage(recordsWrite)) {
        visibleRecordsWrites.push(recordsWrite);
        continue;
      }

      if (await EncryptionControl.canRead({
        tenant,
        incomingMessage       : recordsCount.message,
        requester             : recordsCount.author,
        recordsWriteMessage   : recordsWrite,
        validationStateReader : this.deps.validationStateReader,
      })) {
        visibleRecordsWrites.push(recordsWrite);
      }
    }

    return visibleRecordsWrites;
  }
}
