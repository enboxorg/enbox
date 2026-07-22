import type { MessageStore } from '../types/message-store.js';
import type { ProtocolRecordLimitDefinition } from '../types/protocols-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { Filter, PaginationCursor } from '../types/query-types.js';
import type { MessageSort, Pagination } from '../types/message-types.js';
import type { RecordsFilter, RecordsWriteMessage } from '../types/records-types.js';

import { getRuleSetAtPath } from './protocols.js';
import { isSubtreeFilter } from './filter.js';
import { lexicographicalCompare } from './string.js';
import { ProtocolRecordLimitStrategy } from '../types/protocols-types.js';
import { Records } from './records.js';
import { SortDirection } from '../types/query-types.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

type RecordLimitOccupancyDependencies = {
  messageStore: MessageStore;
  validationStateReader: ValidationStateReader;
};

type RecordLimitOccupancyQueryInput = RecordLimitOccupancyDependencies & {
  tenant: string;
  filters: Filter[];
  messageTimestamp: string;
  messageSort?: MessageSort;
  pagination?: Pagination;
};

type RecordLimitScope = {
  protocol: string;
  protocolPath: string;
  parentContextId: string;
};

type RecordLimitScopeResolution =
  | { kind: 'ancestor' }
  | { kind: 'scope'; scope: RecordLimitScope };

type RecordLimitFilterResolution = {
  projectedFilters: Filter[];
};

type OccupancyProjectionInput<T extends RecordsWriteMessage> = {
  records: T[];
  max: number;
  getScopeKey(record: T): string;
  compareRecords(left: T, right: T): number;
};

/**
 * Queries records with bounded `$recordLimit` occupancy projection when every limited filter targets one concrete scope.
 *
 * Broad filters keep the store's native query path. Projecting those without a store-level grouping primitive would require
 * scanning the full matching set, which is worse than leaving them unprojected until a bounded broad-query strategy exists.
 */
export async function queryRecordsWithRecordLimitOccupancy(
  input: RecordLimitOccupancyQueryInput
): Promise<{ messages: RecordsWriteMessage[]; cursor?: PaginationCursor }> {
  const filterResolution = await resolveRecordLimitFilters(input);
  if (filterResolution === undefined) {
    const { messages, cursor } = await input.messageStore.query(input.tenant, input.filters, input.messageSort, input.pagination);
    return { messages: messages.filter(Records.isRecordsWrite), cursor };
  }

  if (filterResolution.projectedFilters.length === 0) {
    return { messages: [] };
  }

  const { messages, cursor } = await input.messageStore.query(
    input.tenant,
    filterResolution.projectedFilters,
    input.messageSort,
    input.pagination
  );

  return { messages: messages.filter(Records.isRecordsWrite), cursor };
}

/**
 * Counts records with bounded `$recordLimit` occupancy projection when every limited filter targets one concrete scope.
 */
export async function countRecordsWithRecordLimitOccupancy(input: Omit<RecordLimitOccupancyQueryInput, 'pagination'>): Promise<number> {
  const filterResolution = await resolveRecordLimitFilters(input);
  if (filterResolution === undefined) {
    return input.messageStore.count(input.tenant, input.filters, input.messageSort);
  }

  if (filterResolution.projectedFilters.length === 0) {
    return 0;
  }

  return input.messageStore.count(input.tenant, filterResolution.projectedFilters, input.messageSort);
}

/**
 * Returns true when the latest RecordsWrite is visible under the `$recordLimit` projection.
 */
export async function isRecordLimitOccupant(input: RecordLimitOccupancyDependencies & {
  tenant: string;
  message: RecordsWriteMessage;
  messageTimestamp: string;
}): Promise<boolean> {
  const recordLimit = await getRecordLimitForMessage({
    messageStore           : input.messageStore,
    validationStateReader  : input.validationStateReader,
    tenant                 : input.tenant,
    message                : input.message,
    messageTimestamp       : input.messageTimestamp,
    recordLimitDefinitions : new Map(),
  });

  if (recordLimit === undefined) {
    return true;
  }

  const occupantRecordIds = await findOccupantRecordIds({
    messageStore : input.messageStore,
    tenant       : input.tenant,
    scope        : getRecordLimitScope(input.message),
    recordLimit,
  });

  return occupantRecordIds.has(input.message.recordId);
}

/**
 * Rejects an ancestor selection that would span multiple independent
 * `$recordLimit` parent scopes. The current store contract has no grouped
 * top-N primitive, so treating this as a broad native query would expose
 * stored candidates that occupancy projection deliberately hides.
 */
export async function validateRecordLimitContextScope(input: RecordLimitOccupancyDependencies & {
  tenant: string;
  filter: RecordsFilter;
  messageTimestamp: string;
}): Promise<void> {
  const { contextId, protocol, protocolPath } = input.filter;
  if (contextId === undefined || protocol === undefined || protocolPath === undefined) {
    return;
  }

  const contextDepth = contextId.split('/').length;
  const protocolPathDepth = protocolPath.split('/').length;
  if (contextDepth >= protocolPathDepth - 1) {
    return;
  }

  const recordLimit = await getRecordLimitForFilter({
    messageStore          : input.messageStore,
    validationStateReader : input.validationStateReader,
    tenant                : input.tenant,
    filter                : {
      ...Records.convertFilter(input.filter),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
    },
    messageTimestamp       : input.messageTimestamp,
    recordLimitDefinitions : new Map(),
  });
  if (recordLimit !== undefined) {
    throw new DwnError(
      DwnErrorCode.RecordsRecordLimitAncestorScopeUnsupported,
      `ancestor context scopes are not supported for protocol paths with a $recordLimit`,
    );
  }
}

async function resolveRecordLimitFilters(
  input: Omit<RecordLimitOccupancyQueryInput, 'pagination'>
): Promise<RecordLimitFilterResolution | undefined> {
  const recordLimitDefinitions = new Map<string, ProtocolRecordLimitDefinition | undefined>();
  const projectedFilters: Filter[] = [];
  let projectionApplied = false;

  for (const filter of input.filters) {
    const recordLimit = await getRecordLimitForFilter({
      messageStore          : input.messageStore,
      validationStateReader : input.validationStateReader,
      tenant                : input.tenant,
      filter,
      messageTimestamp      : input.messageTimestamp,
      recordLimitDefinitions,
    });

    if (recordLimit === undefined) {
      projectedFilters.push(filter);
      continue;
    }

    const scopeResolution = getRecordLimitScopeFromFilter(filter);
    if (scopeResolution === undefined) {
      return undefined;
    }
    if (scopeResolution.kind === 'ancestor') {
      throw new DwnError(
        DwnErrorCode.RecordsRecordLimitAncestorScopeUnsupported,
        `ancestor context scopes are not supported for protocol paths with a $recordLimit`,
      );
    }

    const occupantRecordIds = await findOccupantRecordIds({
      messageStore : input.messageStore,
      tenant       : input.tenant,
      scope        : scopeResolution.scope,
      recordLimit,
    });

    const projectedFilter = buildProjectedFilter(filter, occupantRecordIds);
    if (projectedFilter !== undefined) {
      projectedFilters.push(projectedFilter);
    }
    projectionApplied = true;
  }

  return projectionApplied ? { projectedFilters } : undefined;
}

async function getRecordLimitForMessage(input: RecordLimitOccupancyDependencies & {
  tenant: string;
  message: RecordsWriteMessage;
  messageTimestamp: string;
  recordLimitDefinitions: Map<string, ProtocolRecordLimitDefinition | undefined>;
}): Promise<ProtocolRecordLimitDefinition | undefined> {
  const { protocol, protocolPath } = input.message.descriptor;
  if (protocol === undefined || protocolPath === undefined) {
    return undefined;
  }

  return getRecordLimit({
    validationStateReader  : input.validationStateReader,
    tenant                 : input.tenant,
    protocol,
    protocolPath,
    messageTimestamp       : input.messageTimestamp,
    recordLimitDefinitions : input.recordLimitDefinitions,
  });
}

async function getRecordLimitForFilter(input: RecordLimitOccupancyDependencies & {
  tenant: string;
  filter: Filter;
  messageTimestamp: string;
  recordLimitDefinitions: Map<string, ProtocolRecordLimitDefinition | undefined>;
}): Promise<ProtocolRecordLimitDefinition | undefined> {
  if (input.filter.interface !== DwnInterfaceName.Records ||
    input.filter.method !== DwnMethodName.Write ||
    input.filter.isLatestBaseState !== true
  ) {
    return undefined;
  }

  const { protocol, protocolPath } = input.filter;
  if (typeof protocol !== 'string' || typeof protocolPath !== 'string') {
    return undefined;
  }

  return getRecordLimit({
    validationStateReader  : input.validationStateReader,
    tenant                 : input.tenant,
    protocol,
    protocolPath,
    messageTimestamp       : input.messageTimestamp,
    recordLimitDefinitions : input.recordLimitDefinitions,
  });
}

async function getRecordLimit(input: {
  validationStateReader: ValidationStateReader;
  tenant: string;
  protocol: string;
  protocolPath: string;
  messageTimestamp: string;
  recordLimitDefinitions: Map<string, ProtocolRecordLimitDefinition | undefined>;
}): Promise<ProtocolRecordLimitDefinition | undefined> {
  const key = `${input.protocol}\u0000${input.protocolPath}`;
  if (!input.recordLimitDefinitions.has(key)) {
    let protocolDefinition;
    try {
      protocolDefinition = await input.validationStateReader.fetchProtocolDefinition(
        input.tenant,
        input.protocol,
        input.messageTimestamp,
      );
    } catch (error) {
      if (error instanceof DwnError && error.code === DwnErrorCode.ProtocolAuthorizationProtocolNotFound) {
        input.recordLimitDefinitions.set(key, undefined);
        return undefined;
      }
      throw error;
    }

    const ruleSet = getRuleSetAtPath(input.protocolPath, protocolDefinition.structure);
    const recordLimit = ruleSet?.$recordLimit;
    input.recordLimitDefinitions.set(
      key,
      recordLimit?.strategy === ProtocolRecordLimitStrategy.Reject ? recordLimit : undefined
    );
  }

  return input.recordLimitDefinitions.get(key);
}

async function findOccupantRecordIds(input: {
  messageStore: MessageStore;
  tenant: string;
  scope: RecordLimitScope;
  recordLimit: ProtocolRecordLimitDefinition;
}): Promise<Set<string>> {
  const scopeFilter = buildRecordLimitScopeFilter(input.scope);
  const messageSort = { dateCreated: SortDirection.Ascending };
  const { messages: firstPage } = await input.messageStore.query(
    input.tenant,
    [scopeFilter],
    messageSort,
    { limit: input.recordLimit.max }
  );
  const firstPageCandidates = firstPage.filter(Records.isRecordsWrite);
  if (firstPageCandidates.length === 0) {
    return new Set();
  }

  const boundaryDateCreated = firstPageCandidates.at(-1)!.descriptor.dateCreated;
  const beforeBoundary = firstPageCandidates.filter(
    (message): boolean => message.descriptor.dateCreated < boundaryDateCreated
  );
  let boundaryCandidates = firstPageCandidates.filter(
    (message): boolean => message.descriptor.dateCreated === boundaryDateCreated
  );

  if (firstPageCandidates.length === input.recordLimit.max) {
    const { messages } = await input.messageStore.query(
      input.tenant,
      [{ ...scopeFilter, dateCreated: boundaryDateCreated }],
      messageSort
    );
    boundaryCandidates = messages.filter(Records.isRecordsWrite);
  }

  boundaryCandidates.sort(compareRecordLimitCandidates);

  const rankedCandidates = [
    ...beforeBoundary,
    ...boundaryCandidates,
  ];

  return selectOccupantRecordIds({
    records        : rankedCandidates,
    max            : input.recordLimit.max,
    getScopeKey    : (): string => '',
    compareRecords : compareRecordLimitCandidates,
  });
}

function buildRecordLimitScopeFilter(scope: RecordLimitScope): Filter {
  const filter: Filter = {
    interface         : DwnInterfaceName.Records,
    method            : DwnMethodName.Write,
    isLatestBaseState : true,
    protocol          : scope.protocol,
    protocolPath      : scope.protocolPath,
  };

  if (scope.parentContextId !== '') {
    filter.contextId = { subtree: scope.parentContextId };
  }

  return filter;
}

function getRecordLimitScopeFromFilter(filter: Filter): RecordLimitScopeResolution | undefined {
  const { protocol, protocolPath } = filter;
  if (typeof protocol !== 'string' || typeof protocolPath !== 'string') {
    return undefined;
  }

  if (!protocolPath.includes('/')) {
    return { kind: 'scope', scope: { protocol, protocolPath, parentContextId: '' } };
  }

  const { contextId } = filter;
  if (contextId === undefined || !isSubtreeFilter(contextId)) {
    return undefined;
  }

  const contextDepth = contextId.subtree.split('/').length;
  const protocolPathDepth = protocolPath.split('/').length;
  if (contextDepth < protocolPathDepth - 1) {
    return { kind: 'ancestor' };
  }

  const parentContextId = contextDepth === protocolPathDepth
    ? Records.getParentContextFromOfContextId(contextId.subtree)
    : contextId.subtree;
  if (parentContextId === undefined) {
    return undefined;
  }

  return { kind: 'scope', scope: { protocol, protocolPath, parentContextId } };
}

function getRecordLimitScope(message: RecordsWriteMessage): RecordLimitScope {
  return {
    protocol        : message.descriptor.protocol,
    protocolPath    : message.descriptor.protocolPath,
    parentContextId : Records.getParentContextFromOfContextId(message.contextId) ?? '',
  };
}

function buildProjectedFilter(filter: Filter, occupantRecordIds: Set<string>): Filter | undefined {
  let projectedRecordIds = Array.from(occupantRecordIds);
  const existingRecordIdFilter = filter.recordId;
  if (typeof existingRecordIdFilter === 'string') {
    projectedRecordIds = occupantRecordIds.has(existingRecordIdFilter) ? [existingRecordIdFilter] : [];
  } else if (Array.isArray(existingRecordIdFilter)) {
    projectedRecordIds = existingRecordIdFilter
      .filter((recordId): recordId is string => typeof recordId === 'string' && occupantRecordIds.has(recordId));
  }

  if (projectedRecordIds.length === 0) {
    return undefined;
  }

  return {
    ...filter,
    recordId: projectedRecordIds,
  };
}

function compareRecordLimitCandidates(left: RecordsWriteMessage, right: RecordsWriteMessage): number {
  const dateComparison = lexicographicalCompare(left.descriptor.dateCreated, right.descriptor.dateCreated);
  if (dateComparison !== 0) {
    return dateComparison;
  }

  return lexicographicalCompare(left.recordId, right.recordId);
}

export function selectOccupantRecordIds<T extends RecordsWriteMessage>(input: OccupancyProjectionInput<T>): Set<string> {
  const occupants = new Set<string>();
  const groups = new Map<string, T[]>();

  for (const record of input.records) {
    const scopeKey = input.getScopeKey(record);
    const group = groups.get(scopeKey) ?? [];
    group.push(record);
    groups.set(scopeKey, group);
  }

  for (const group of groups.values()) {
    group.sort(input.compareRecords);
    for (const record of group.slice(0, input.max)) {
      occupants.add(record.recordId);
    }
  }

  return occupants;
}
