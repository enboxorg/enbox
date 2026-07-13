import type { Filter, PaginationCursor } from '../types/query-types.js';
import type { GenericMessage, MessageSort } from '../types/message-types.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { RecordsQueryMessage, RecordsQueryReply, RecordsQueryReplyEntry } from '../types/records-types.js';

import { attachInitialWrites } from '../utils/initial-write-attachment.js';
import { authenticate } from '../core/auth.js';
import { DateSort } from '../types/records-types.js';
import { EncryptionControl } from '../core/encryption-control.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { ProtocolAuthorization } from '../core/protocol-authorization.js';
import { queryRecordsWithRecordLimitOccupancy } from '../utils/record-limit-occupancy.js';
import { Records } from '../utils/records.js';
import { RecordsGrantAuthorization } from '../core/records-grant-authorization.js';
import { RecordsQuery } from '../interfaces/records-query.js';
import { SortDirection } from '../types/query-types.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

type RecordsQueryProjectionInput = {
  tenant: string;
  recordsQuery: RecordsQuery;
  requester: string | undefined;
  filters: Filter[];
  messageSort: MessageSort;
  pagination?: { cursor?: PaginationCursor; limit?: number };
};

export class RecordsQueryHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message,
  }: {tenant: string, message: RecordsQueryMessage}): Promise<RecordsQueryReply> {
    let recordsQuery: RecordsQuery;
    try {
      recordsQuery = await RecordsQuery.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    let recordsWrites: RecordsQueryReplyEntry[];
    let cursor: PaginationCursor | undefined;
    const requester = Message.getRequester(recordsQuery.message);
    // if this is an anonymous query and the filter supports published records, query only published records
    if (Records.filterIncludesPublishedRecords(recordsQuery.message.descriptor.filter) && recordsQuery.author === undefined) {
      const results = await this.fetchPublishedRecords(tenant, recordsQuery, requester);
      recordsWrites = results.messages as RecordsQueryReplyEntry[];
      cursor = results.cursor;
    } else {
      // authentication and authorization
      try {
        await authenticate(message.authorization!, this.deps.didResolver);

        await RecordsQueryHandler.authorizeRecordsQuery(tenant, recordsQuery, this.deps);
      } catch (e) {
        return messageReplyFromError(e, 401);
      }

      if (recordsQuery.author === tenant) {
        const results = requester === tenant
          ? await this.fetchRecordsAsOwner(tenant, recordsQuery)
          : await this.fetchRecordsAsOwnerDelegate(tenant, recordsQuery, requester);
        recordsWrites = results.messages as RecordsQueryReplyEntry[];
        cursor = results.cursor;
      } else {
        const results = await this.fetchRecordsAsNonOwner(tenant, recordsQuery, requester);
        recordsWrites = results.messages as RecordsQueryReplyEntry[];
        cursor = results.cursor;
      }
    }

    // attach the retained initial write to every entry that is not itself an initial write
    const completeRecordsWrites = await attachInitialWrites({
      messageStore  : this.deps.messageStore,
      tenant,
      recordsWrites,
      operationName : 'RecordsQuery',
    });

    return {
      status  : { code: 200, detail: 'OK' },
      entries : completeRecordsWrites,
      cursor
    };
  }

  /**
   * Convert an incoming DateSort to a sort type accepted by MessageStore
   * Defaults to 'dateCreated' in Descending order if no sort is supplied.
   *
   * @param dateSort the optional DateSort from the RecordsQuery message descriptor.
   * @returns {MessageSort} for MessageStore sorting.
   */
  private convertDateSort(dateSort?: DateSort): MessageSort {
    switch (dateSort) {
    case DateSort.CreatedAscending:
      return { dateCreated: SortDirection.Ascending };
    case DateSort.CreatedDescending:
      return { dateCreated: SortDirection.Descending };
    case DateSort.PublishedAscending:
      return { datePublished: SortDirection.Ascending };
    case DateSort.PublishedDescending:
      return { datePublished: SortDirection.Descending };
    case DateSort.UpdatedAscending:
      return { messageTimestamp: SortDirection.Ascending };
    case DateSort.UpdatedDescending:
      return { messageTimestamp: SortDirection.Descending };
    default:
      return { dateCreated: SortDirection.Ascending };
    }
  }

  /**
   * Fetches the records as the owner of the DWN with no additional filtering.
   */
  private async fetchRecordsAsOwner(
    tenant: string,
    recordsQuery: RecordsQuery
  ): Promise<{ messages: GenericMessage[], cursor?: PaginationCursor }> {
    const { dateSort, filter, pagination } = recordsQuery.message.descriptor;
    // fetch all published records matching the query
    const queryFilter = {
      ...Records.convertFilter(filter, dateSort),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true
    };

    const messageSort = this.convertDateSort(dateSort);
    return this.queryRecordsWithVisibleControlFiltering({
      tenant,
      recordsQuery,
      requester : tenant,
      filters   : [queryFilter],
      messageSort,
      pagination,
    });
  }

  private async fetchRecordsAsOwnerDelegate(
    tenant: string,
    recordsQuery: RecordsQuery,
    requester: string | undefined,
  ): Promise<{ messages: GenericMessage[], cursor?: PaginationCursor }> {
    const { dateSort, filter, pagination } = recordsQuery.message.descriptor;
    const queryFilter = {
      ...Records.convertFilter(filter, dateSort),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true
    };

    const messageSort = this.convertDateSort(dateSort);
    return this.queryRecordsWithVisibleControlFiltering({
      tenant,
      recordsQuery,
      requester,
      filters: [queryFilter],
      messageSort,
      pagination,
    });
  }

  /**
   * Fetches the records as a non-owner.
   *
   * Filters can support returning both published and unpublished records,
   * as well as explicitly only published or only unpublished records.
   *
   * A) BOTH published and unpublished:
   *    1. published records; and
   *    2. unpublished records intended for the query author (where `recipient` is the query author); and
   *    3. unpublished records authorized by a protocol rule.
   *
   * B) PUBLISHED:
   *    1. only published records;
   *
   * C) UNPUBLISHED:
   *    1. unpublished records intended for the query author (where `recipient` is the query author); and
   *    2. unpublished records authorized by a protocol rule.
   *
   */
  private async fetchRecordsAsNonOwner(
    tenant: string,
    recordsQuery: RecordsQuery,
    requester: string | undefined,
  ): Promise<{ messages: GenericMessage[], cursor?: PaginationCursor }> {
    const { dateSort, pagination, filter } = recordsQuery.message.descriptor;
    const filters = [];
    if (Records.filterIncludesPublishedRecords(filter)) {
      filters.push(RecordsQueryHandler.buildPublishedRecordsFilter(recordsQuery));
    }

    if (Records.filterIncludesUnpublishedRecords(filter)) {
      if (EncryptionControl.isExactAudienceFilter(filter)) {
        filters.push(Records.buildUnpublishedControlRecordsFilter(filter, dateSort));
      }

      if (Records.shouldBuildUnpublishedAuthorFilter(filter, recordsQuery.author!)) {
        filters.push(RecordsQueryHandler.buildUnpublishedRecordsByQueryAuthorFilter(recordsQuery));
      }

      if (Records.shouldProtocolAuthorize(recordsQuery.signaturePayload!)) {
        filters.push(RecordsQueryHandler.buildUnpublishedProtocolAuthorizedRecordsFilter(recordsQuery));
      }

      if (Message.getPermissionGrantId(recordsQuery.signaturePayload!) !== undefined) {
        filters.push(RecordsQueryHandler.buildUnpublishedPermissionGrantAuthorizedRecordsFilter(recordsQuery));
      }

      if (Records.shouldBuildUnpublishedRecipientFilter(filter, recordsQuery.author!)) {
        filters.push(RecordsQueryHandler.buildUnpublishedRecordsForQueryAuthorFilter(recordsQuery));
      }
    }

    const messageSort = this.convertDateSort(dateSort);
    return this.queryRecordsWithVisibleControlFiltering({
      tenant,
      recordsQuery,
      requester,
      filters,
      messageSort,
      pagination,
    });
  }

  /**
   * Fetches only published records.
   */
  private async fetchPublishedRecords(
    tenant: string,
    recordsQuery: RecordsQuery,
    requester: string | undefined,
  ): Promise<{ messages: GenericMessage[], cursor?: PaginationCursor }> {
    const { dateSort, pagination } = recordsQuery.message.descriptor;
    const filter = RecordsQueryHandler.buildPublishedRecordsFilter(recordsQuery);
    const messageSort = this.convertDateSort(dateSort);
    return this.queryRecordsWithVisibleControlFiltering({
      tenant,
      recordsQuery,
      requester,
      filters: [filter],
      messageSort,
      pagination,
    });
  }

  private async queryRecordsWithVisibleControlFiltering(
    input: RecordsQueryProjectionInput
  ): Promise<{ messages: RecordsQueryReplyEntry[], cursor?: PaginationCursor }> {
    const {
      tenant, recordsQuery, requester, filters, messageSort, pagination
    } = input;
    const controlFilters = Records.buildControlRecordsFilters(filters);
    const currentAudienceRecordIdCache = new Map<string, string | undefined>();
    if (controlFilters.length === 0) {
      const result = await queryRecordsWithRecordLimitOccupancy({
        messageStore          : this.deps.messageStore,
        validationStateReader : this.deps.validationStateReader,
        tenant,
        filters,
        messageSort,
        pagination,
        messageTimestamp      : recordsQuery.message.descriptor.messageTimestamp,
      });
      return EncryptionControl.projectCurrentAudienceRecordPage({
        messageStore : this.deps.messageStore,
        tenant,
        filters,
        currentAudienceRecordIdCache,
        result       : {
          messages : result.messages as RecordsQueryReplyEntry[],
          cursor   : result.cursor,
        },
      });
    }

    if (pagination?.limit === undefined || pagination.limit <= 0) {
      const result = await queryRecordsWithRecordLimitOccupancy({
        messageStore          : this.deps.messageStore,
        validationStateReader : this.deps.validationStateReader,
        tenant,
        filters,
        messageSort,
        pagination,
        messageTimestamp      : recordsQuery.message.descriptor.messageTimestamp,
      });
      const projectedResult = await EncryptionControl.projectCurrentAudienceRecordPage({
        messageStore : this.deps.messageStore,
        tenant,
        filters,
        currentAudienceRecordIdCache,
        result       : {
          messages : result.messages as RecordsQueryReplyEntry[],
          cursor   : result.cursor,
        },
      });
      return {
        messages : await this.filterControlRecordsForRequester(tenant, recordsQuery, requester, projectedResult.messages),
        cursor   : projectedResult.cursor,
      };
    }

    const visibleMessages: RecordsQueryReplyEntry[] = [];
    let cursor = pagination.cursor;
    let nextCursor: PaginationCursor | undefined;
    // Keeps visible-page pagination stable until #1100 moves control visibility into indexed store filters.
    do {
      const remainingLimit = pagination.limit - visibleMessages.length;
      const result = await queryRecordsWithRecordLimitOccupancy({
        messageStore          : this.deps.messageStore,
        validationStateReader : this.deps.validationStateReader,
        tenant,
        filters,
        messageSort,
        pagination            : { ...pagination, cursor, limit: remainingLimit },
        messageTimestamp      : recordsQuery.message.descriptor.messageTimestamp,
      });
      const projectedResult = await EncryptionControl.projectCurrentAudienceRecordPage({
        messageStore : this.deps.messageStore,
        tenant,
        filters,
        currentAudienceRecordIdCache,
        result       : {
          messages : result.messages as RecordsQueryReplyEntry[],
          cursor   : result.cursor,
        },
      });
      const filteredMessages = await this.filterControlRecordsForRequester(
        tenant,
        recordsQuery,
        requester,
        projectedResult.messages,
      );
      visibleMessages.push(...filteredMessages);
      nextCursor = projectedResult.cursor;
      cursor = projectedResult.cursor;
    } while (visibleMessages.length < pagination.limit && cursor !== undefined);

    return { messages: visibleMessages, cursor: nextCursor };
  }

  private static buildPublishedRecordsFilter(recordsQuery: RecordsQuery): Filter {
    const { dateSort, filter } = recordsQuery.message.descriptor;
    // fetch all published records matching the query
    return {
      ...Records.convertFilter(filter, dateSort),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      published         : true,
      isLatestBaseState : true
    };
  }

  /**
   * Creates a filter for unpublished records that are intended for the query author (where `recipient` is the author).
   */
  private static buildUnpublishedRecordsForQueryAuthorFilter(recordsQuery: RecordsQuery): Filter {
    const { dateSort, filter } = recordsQuery.message.descriptor;
    // include records where recipient is query author
    return {
      ...Records.convertFilter(filter, dateSort),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      recipient         : recordsQuery.author!,
      isLatestBaseState : true,
      published         : false
    };
  }

  /**
   * Creates a filter for unpublished records that are within the specified protocol.
   * Validation that `protocol` and other required protocol-related fields occurs before this method.
   */
  private static buildUnpublishedProtocolAuthorizedRecordsFilter(recordsQuery: RecordsQuery): Filter {
    const { dateSort, filter } = recordsQuery.message.descriptor;
    return {
      ...Records.convertFilter(filter, dateSort),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      published         : false
    };
  }

  /**
   * Creates a filter for unpublished records authorized by a permission grant.
   */
  private static buildUnpublishedPermissionGrantAuthorizedRecordsFilter(recordsQuery: RecordsQuery): Filter {
    const { dateSort, filter } = recordsQuery.message.descriptor;
    return {
      ...Records.convertFilter(filter, dateSort),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      published         : false
    };
  }

  /**
   * Creates a filter for only unpublished records where the author is the same as the query author.
   */
  private static buildUnpublishedRecordsByQueryAuthorFilter(recordsQuery: RecordsQuery): Filter {
    const { dateSort, filter } = recordsQuery.message.descriptor;
    // include records where author is the same as the query author
    return {
      ...Records.convertFilter(filter, dateSort),
      author            : recordsQuery.author!,
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      published         : false
    };
  }

  /**
   * @param messageStore Used to check if the grant has been revoked.
   */
  private static async authorizeRecordsQuery(
    tenant: string,
    recordsQuery: RecordsQuery,
    deps: HandlerDependencies,
  ): Promise<void> {

    if (Message.isSignedByAuthorDelegate(recordsQuery.message) &&
        !EncryptionControl.filterTargetsOnlyControlRecords(recordsQuery.message.descriptor.filter)) {
      await recordsQuery.authorizeDelegate(deps.validationStateReader);
    } else if (EncryptionControl.filterTargetsOnlyControlRecords(recordsQuery.message.descriptor.filter)) {
      await EncryptionControl.authorizeControlReadRequest({
        tenant,
        incomingMessage       : recordsQuery.message,
        requester             : Message.getRequester(recordsQuery.message),
        validationStateReader : deps.validationStateReader,
      });
    }

    const permissionGrantId = Message.getPermissionGrantId(recordsQuery.signaturePayload!);
    if (permissionGrantId !== undefined) {
      const permissionGrant = await deps.validationStateReader.fetchGrant(tenant, permissionGrantId);
      await RecordsGrantAuthorization.authorizeQueryOrSubscribe({
        incomingMessage       : recordsQuery.message,
        expectedGrantor       : tenant,
        expectedGrantee       : recordsQuery.author!,
        permissionGrant,
        validationStateReader : deps.validationStateReader,
      });
      return;
    }

    // NOTE: not all RecordsQuery messages require protocol authorization even if the filter includes protocol-related fields,
    // this is because we dynamically filter out records that the caller is not authorized to see.
    // Currently only run protocol authorization if message deliberately invokes a protocol role.
    if (Records.shouldProtocolAuthorize(recordsQuery.signaturePayload!)) {
      await ProtocolAuthorization.authorizeQueryOrSubscribe(tenant, recordsQuery, deps.validationStateReader);
    }
  }

  private async filterControlRecordsForRequester(
    tenant: string,
    recordsQuery: RecordsQuery,
    requester: string | undefined,
    recordsWrites: RecordsQueryReplyEntry[],
  ): Promise<RecordsQueryReplyEntry[]> {
    return EncryptionControl.filterVisibleControlRecords({
      tenant,
      incomingMessage       : recordsQuery.message,
      requester,
      recordsWriteMessages  : recordsWrites,
      validationStateReader : this.deps.validationStateReader,
    });
  }
}
