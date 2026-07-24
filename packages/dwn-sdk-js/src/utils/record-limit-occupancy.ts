import type { ProtocolRecordLimitDefinition } from '../types/protocols-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { Filter, PaginationCursor } from '../types/query-types.js';
import type { MessageSort, Pagination } from '../types/message-types.js';
import type { MessageStore, RecordLimitOccupancy } from '../types/message-store.js';
import type { RecordsFilter, RecordsWriteMessage } from '../types/records-types.js';

import { getRuleSetAtPath } from './protocols.js';
import { Records } from './records.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

type RecordLimitPolicyDependencies = {
  validationStateReader: ValidationStateReader;
};

type RecordLimitOccupancyDependencies = RecordLimitPolicyDependencies & {
  messageStore: MessageStore;
};

type RecordLimitOccupancyQueryInput = {
  messageStore: MessageStore;
  tenant: string;
  filters: Filter[];
  recordLimit?: RecordLimitOccupancy;
  messageSort?: MessageSort;
  pagination?: Pagination;
};

type OccupancyProjectionInput<T extends RecordsWriteMessage> = {
  records: T[];
  max: number;
  getScopeKey(record: T): string;
  compareRecords(left: T, right: T): number;
};

/**
 * Queries the caller-visible portion of the deterministic `$recordLimit`
 * occupant population for one concrete protocol path.
 */
export async function queryRecordsWithRecordLimitOccupancy(
  input: RecordLimitOccupancyQueryInput
): Promise<{ messages: RecordsWriteMessage[]; cursor?: PaginationCursor }> {
  const { messages, cursor } = await input.messageStore.query(
    input.tenant,
    input.filters,
    input.messageSort,
    input.pagination,
    input.recordLimit === undefined ? undefined : { recordLimit: input.recordLimit },
  );

  return { messages: messages.filter(Records.isRecordsWrite), cursor };
}

/**
 * Counts the same deterministic `$recordLimit` occupant population returned
 * by {@link queryRecordsWithRecordLimitOccupancy}.
 */
export async function countRecordsWithRecordLimitOccupancy(
  input: Omit<RecordLimitOccupancyQueryInput, 'pagination'>
): Promise<number> {
  return input.messageStore.count(
    input.tenant,
    input.filters,
    input.messageSort,
    input.recordLimit === undefined ? undefined : { recordLimit: input.recordLimit },
  );
}

/**
 * Returns true when the latest RecordsWrite is part of its path's current
 * `$recordLimit` occupant population.
 */
export async function isRecordLimitOccupant(input: RecordLimitOccupancyDependencies & {
  tenant: string;
  message: RecordsWriteMessage;
  messageTimestamp: string;
}): Promise<boolean> {
  const recordLimitDefinition = await getRecordLimitForMessage(input);
  if (recordLimitDefinition === undefined) {
    return true;
  }

  const { protocol, protocolPath } = input.message.descriptor;
  const recordLimit: RecordLimitOccupancy = {
    protocol,
    protocolPath,
    max: recordLimitDefinition.max,
  };
  const parentContextId = Records.getParentContextFromOfContextId(input.message.contextId);
  if (parentContextId !== undefined && parentContextId !== '') {
    recordLimit.contextId = parentContextId;
  }

  const count = await input.messageStore.count(input.tenant, [{
    interface         : DwnInterfaceName.Records,
    method            : DwnMethodName.Write,
    isLatestBaseState : true,
    protocol,
    protocolPath,
    recordId          : input.message.recordId,
  }], undefined, { recordLimit });

  return count > 0;
}

/** Resolves one incoming Records filter to its store-level occupancy policy. */
export async function resolveRecordLimitOccupancy(input: RecordLimitPolicyDependencies & {
  tenant: string;
  recordsFilter: RecordsFilter;
  messageTimestamp: string;
}): Promise<RecordLimitOccupancy | undefined> {
  const { contextId, parentId, protocol, protocolPath } = input.recordsFilter;
  if (protocol === undefined || protocolPath === undefined) {
    return undefined;
  }

  const recordLimitDefinition = await getRecordLimit({
    validationStateReader : input.validationStateReader,
    tenant                : input.tenant,
    protocol,
    protocolPath,
    messageTimestamp      : input.messageTimestamp,
  });
  if (recordLimitDefinition === undefined) {
    return undefined;
  }

  const recordLimit: RecordLimitOccupancy = {
    protocol,
    protocolPath,
    max: recordLimitDefinition.max,
  };
  if (!protocolPath.includes('/')) {
    return recordLimit;
  }
  if (parentId !== undefined) {
    recordLimit.parentId = parentId;
  }
  if (contextId === undefined) {
    return recordLimit;
  }

  const contextDepth = contextId.split('/').length;
  const protocolPathDepth = protocolPath.split('/').length;
  recordLimit.contextId = contextDepth === protocolPathDepth
    ? Records.getParentContextFromOfContextId(contextId)
    : contextId;

  return recordLimit;
}

async function getRecordLimitForMessage(input: RecordLimitOccupancyDependencies & {
  tenant: string;
  message: RecordsWriteMessage;
  messageTimestamp: string;
}): Promise<ProtocolRecordLimitDefinition | undefined> {
  const { protocol, protocolPath } = input.message.descriptor;
  if (protocol === undefined || protocolPath === undefined) {
    return undefined;
  }

  return getRecordLimit({
    validationStateReader : input.validationStateReader,
    tenant                : input.tenant,
    protocol,
    protocolPath,
    messageTimestamp      : input.messageTimestamp,
  });
}

async function getRecordLimit(input: {
  validationStateReader: ValidationStateReader;
  tenant: string;
  protocol: string;
  protocolPath: string;
  messageTimestamp: string;
}): Promise<ProtocolRecordLimitDefinition | undefined> {
  let protocolDefinition;
  try {
    protocolDefinition = await input.validationStateReader.fetchProtocolDefinition(
      input.tenant,
      input.protocol,
      input.messageTimestamp,
    );
  } catch (error) {
    if (error instanceof DwnError && error.code === DwnErrorCode.ProtocolAuthorizationProtocolNotFound) {
      return undefined;
    }
    throw error;
  }

  const ruleSet = getRuleSetAtPath(input.protocolPath, protocolDefinition.structure);
  const recordLimit = ruleSet?.$recordLimit;
  return recordLimit;
}

/**
 * Selects a bounded occupant set for an in-memory projection whose grouping
 * and ranking policy is supplied by the caller.
 */
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
