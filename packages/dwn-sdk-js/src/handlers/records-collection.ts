import type { HandlerDependencies } from '../types/method-handler.js';
import type { RecordsCount } from '../interfaces/records-count.js';
import type { RecordsQuery } from '../interfaces/records-query.js';
import type { RecordsSubscribe } from '../interfaces/records-subscribe.js';
import type { Filter, PaginationCursor } from '../types/query-types.js';
import type { RecordsFilter, RecordsQueryReplyEntry } from '../types/records-types.js';

import { authenticate } from '../core/auth.js';
import { DateSort } from '../types/records-types.js';
import { EncryptionControl } from '../core/encryption-control.js';
import { Message } from '../core/message.js';
import { ProtocolAuthorization } from '../core/protocol-authorization.js';
import { Records } from '../utils/records.js';
import { RecordsGrantAuthorization } from '../core/records-grant-authorization.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { queryRecordsWithRecordLimitOccupancy, resolveRecordLimitOccupancy } from '../utils/record-limit-occupancy.js';

type RecordsCollectionRequest = RecordsCount | RecordsQuery | RecordsSubscribe;

export type RecordsCollectionVisibility = 'nonOwner' | 'owner' | 'published';

/**
 * Resolves the visible population for a Records collection request, authenticating and
 * authorizing every request that is not an anonymous published-records read.
 */
export async function resolveRecordsCollectionVisibility(
  tenant: string,
  request: RecordsCollectionRequest,
  deps: HandlerDependencies,
): Promise<RecordsCollectionVisibility> {
  const recordsFilter = request.message.descriptor.filter;
  if (Records.filterIncludesPublishedRecords(recordsFilter) && request.author === undefined) {
    return 'published';
  }

  await authenticate(request.message.authorization!, deps.didResolver);

  if (Message.isSignedByAuthorDelegate(request.message) && !EncryptionControl.filterTargetsOnlyControlRecords(recordsFilter)) {
    await request.authorizeDelegate(deps.validationStateReader);
  } else if (EncryptionControl.filterTargetsOnlyControlRecords(recordsFilter)) {
    await EncryptionControl.authorizeControlReadRequest({
      tenant,
      incomingMessage       : request.message,
      requester             : Message.getRequester(request.message),
      validationStateReader : deps.validationStateReader,
    });
  }

  const permissionGrantId = Message.getPermissionGrantId(request.signaturePayload!);
  if (permissionGrantId !== undefined) {
    const permissionGrant = await deps.validationStateReader.fetchGrant(tenant, permissionGrantId);
    await RecordsGrantAuthorization.authorizeQueryOrSubscribe({
      incomingMessage       : request.message,
      expectedGrantor       : tenant,
      expectedGrantee       : request.author!,
      permissionGrant,
      validationStateReader : deps.validationStateReader,
    });
  } else if (invokesProtocolRole(request)) {
    // A protocol filter alone does not require protocol authorization because unauthorized
    // records are removed by the visibility filters. An invoked protocol role does.
    await ProtocolAuthorization.authorizeQueryOrSubscribe(tenant, request, deps.validationStateReader);
  }

  return request.author === tenant ? 'owner' : 'nonOwner';
}

/** Builds latest-write filters shared by Records Query, Count, and Subscribe snapshots. */
export function buildRecordsSnapshotFilters(
  request: RecordsCollectionRequest,
  visibility: RecordsCollectionVisibility,
): Filter[] {
  const descriptor = request.message.descriptor;
  const dateSort = 'dateSort' in descriptor ? descriptor.dateSort : undefined;
  return buildRecordsVisibilityFilters({
    request,
    visibility,
    filter  : descriptor.filter,
    purpose : 'snapshot',
    dateSort,
  });
}

/** Builds Write-and-Delete filters for Records Subscribe event delivery. */
export function buildRecordsEventFilters(
  request: RecordsSubscribe,
  visibility: RecordsCollectionVisibility,
): Filter[] {
  return buildRecordsVisibilityFilters({
    request,
    visibility,
    filter  : request.message.descriptor.filter,
    purpose : 'event',
  });
}

/**
 * Queries one visible Records page after applying record-limit occupancy, current-audience
 * projection, and encryption-control authorization in their required order.
 */
export async function queryVisibleRecordsPage(input: {
  deps: HandlerDependencies;
  request: RecordsQuery | RecordsSubscribe;
  tenant: string;
  visibility: RecordsCollectionVisibility;
}): Promise<{ messages: RecordsQueryReplyEntry[]; cursor?: PaginationCursor }> {
  const { deps, request, tenant, visibility } = input;
  const { dateSort, filter, messageTimestamp, pagination } = request.message.descriptor;
  const filters = buildRecordsSnapshotFilters(request, visibility);
  const recordLimit = await resolveRecordLimitOccupancy({
    validationStateReader : deps.validationStateReader,
    tenant,
    recordsFilter         : filter,
    messageTimestamp,
  });
  const controlFilters = Records.buildControlRecordsFilters(filters);
  const currentAudienceRecordIdCache = new Map<string, string | undefined>();
  const requester = Message.getRequester(request.message);
  const messageSort = Records.convertDateSort(dateSort ?? DateSort.CreatedAscending);

  const queryProjectedPage = async (page = pagination): Promise<{
    messages: RecordsQueryReplyEntry[];
    cursor?: PaginationCursor;
  }> => {
    const result = await queryRecordsWithRecordLimitOccupancy({
      messageStore : deps.messageStore,
      tenant,
      filters,
      recordLimit,
      messageSort,
      pagination   : page,
    });
    return EncryptionControl.projectCurrentAudienceRecordPage({
      messageStore: deps.messageStore,
      tenant,
      filters,
      currentAudienceRecordIdCache,
      result,
    });
  };

  const filterVisibleControlRecords = (messages: RecordsQueryReplyEntry[]): Promise<RecordsQueryReplyEntry[]> =>
    EncryptionControl.filterVisibleControlRecords({
      tenant,
      incomingMessage       : request.message,
      requester,
      recordsWriteMessages  : messages,
      validationStateReader : deps.validationStateReader,
    });

  if (controlFilters.length === 0) {
    return queryProjectedPage();
  }

  if (pagination?.limit === undefined || pagination.limit <= 0) {
    const result = await queryProjectedPage();
    return {
      messages : await filterVisibleControlRecords(result.messages),
      cursor   : result.cursor,
    };
  }

  const visibleMessages: RecordsQueryReplyEntry[] = [];
  let cursor = pagination.cursor;
  let nextCursor: PaginationCursor | undefined;
  // Keeps visible-page pagination stable until #1100 moves control visibility into indexed store filters.
  do {
    const remainingLimit = pagination.limit - visibleMessages.length;
    const result = await queryProjectedPage({ ...pagination, cursor, limit: remainingLimit });
    visibleMessages.push(...await filterVisibleControlRecords(result.messages));
    nextCursor = result.cursor;
    cursor = result.cursor;
  } while (visibleMessages.length < pagination.limit && cursor !== undefined);

  return { messages: visibleMessages, cursor: nextCursor };
}

function buildRecordsVisibilityFilters(input: {
  dateSort?: DateSort;
  filter: RecordsFilter;
  purpose: 'event' | 'snapshot';
  request: RecordsCollectionRequest;
  visibility: RecordsCollectionVisibility;
}): Filter[] {
  const { dateSort, filter, purpose, request, visibility } = input;
  if (visibility === 'owner') {
    return [buildRecordsFilter({ dateSort, filter, purpose })];
  }

  if (visibility === 'published') {
    return [buildRecordsFilter({ dateSort, filter, purpose, published: true })];
  }

  const filters: Filter[] = [];
  if (Records.filterIncludesPublishedRecords(filter)) {
    filters.push(buildRecordsFilter({ dateSort, filter, purpose, published: true }));
  }

  if (!Records.filterIncludesUnpublishedRecords(filter)) {
    return filters;
  }

  if (EncryptionControl.isExactAudienceFilter(filter)) {
    filters.push(buildRecordsFilter({ dateSort, filter, purpose, published: false }));
  }

  if (shouldBuildUnpublishedAuthorFilter(filter, request.author!)) {
    filters.push(buildRecordsFilter({ author: request.author, dateSort, filter, purpose, published: false }));
  }

  if (invokesProtocolRole(request) || Message.getPermissionGrantId(request.signaturePayload!) !== undefined) {
    filters.push(buildRecordsFilter({ dateSort, filter, purpose, published: false }));
  }

  if (shouldBuildUnpublishedRecipientFilter(filter, request.author!)) {
    filters.push(buildRecordsFilter({ dateSort, filter, purpose, published: false, recipient: request.author }));
  }

  return filters;
}

function buildRecordsFilter(input: {
  author?: string;
  dateSort?: DateSort;
  filter: RecordsFilter;
  purpose: 'event' | 'snapshot';
  published?: boolean;
  recipient?: string;
}): Filter {
  const { author, dateSort, filter, purpose, published, recipient } = input;
  const result: Filter = {
    ...Records.convertFilter(filter, purpose === 'snapshot' ? dateSort : undefined),
    interface : DwnInterfaceName.Records,
    method    : purpose === 'snapshot' ? DwnMethodName.Write : [DwnMethodName.Write, DwnMethodName.Delete],
  };

  if (purpose === 'snapshot') {
    result.isLatestBaseState = true;
  }
  if (author !== undefined) {
    result.author = author;
  }
  if (published !== undefined) {
    result.published = published;
  }
  if (recipient !== undefined) {
    result.recipient = recipient;
  }

  return result;
}

function invokesProtocolRole(request: RecordsCollectionRequest): boolean {
  return request.signaturePayload?.protocolRole !== undefined;
}

function shouldBuildUnpublishedRecipientFilter(filter: RecordsFilter, recipient: string): boolean {
  const { recipient: recipientFilter } = filter;
  return Array.isArray(recipientFilter)
    ? recipientFilter.length === 0 || recipientFilter.includes(recipient)
    : recipientFilter === undefined || recipientFilter === recipient;
}

function shouldBuildUnpublishedAuthorFilter(filter: RecordsFilter, author: string): boolean {
  const { author: authorFilter } = filter;
  return Array.isArray(authorFilter)
    ? authorFilter.length === 0 || authorFilter.includes(author)
    : authorFilter === undefined || authorFilter === author;
}
