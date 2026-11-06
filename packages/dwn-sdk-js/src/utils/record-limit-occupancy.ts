import type { ModuleRecordLimitDefinition } from '../types/modules-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { Filter, PaginationCursor } from '../types/query-types.js';
import type { MessageSort, Pagination } from '../types/message-types.js';
import type { MessageStore, RecordLimitOccupancy } from '../types/message-store.js';
import type { RecordsFilter, RecordsWriteMessage } from '../types/records-types.js';

import { getRuleSetAtPath } from './modules.js';
import { preloadModuleDefinitions } from '../core/module-graph-loader.js';
import { Records } from './records.js';
import { resolveModuleGraph } from '../core/module-graph.js';
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
 * occupant population for one concrete module path.
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

  const { module, modulePath } = input.message.descriptor;
  const recordLimit: RecordLimitOccupancy = {
    module,
    modulePath,
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
    module,
    modulePath,
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
  const { contextId, parentId, module, modulePath } = input.recordsFilter;
  if (module === undefined || modulePath === undefined) {
    return undefined;
  }

  const policy = await getRecordLimit({
    validationStateReader : input.validationStateReader,
    tenant                : input.tenant,
    module,
    modulePath,
    messageTimestamp      : input.messageTimestamp,
  });
  if (policy === undefined) {
    return undefined;
  }
  const recordLimitDefinition = policy.recordLimit;
  const recordLimit: RecordLimitOccupancy = {
    module,
    modulePath,
    max: recordLimitDefinition.max,
  };
  if (policy.physicalDepth === 1) {
    return recordLimit;
  }
  if (parentId !== undefined) {
    recordLimit.parentId = parentId;
  }
  if (contextId === undefined) {
    return recordLimit;
  }

  const contextDepth = contextId.split('/').length;
  const modulePathDepth = policy.physicalDepth;
  recordLimit.contextId = contextDepth === modulePathDepth
    ? Records.getParentContextFromOfContextId(contextId)
    : contextId;

  return recordLimit;
}

async function getRecordLimitForMessage(input: RecordLimitOccupancyDependencies & {
  tenant: string;
  message: RecordsWriteMessage;
  messageTimestamp: string;
}): Promise<ModuleRecordLimitDefinition | undefined> {
  const { module, modulePath } = input.message.descriptor;
  if (module === undefined || modulePath === undefined) {
    return undefined;
  }

  const policy = await getRecordLimit({
    validationStateReader : input.validationStateReader,
    tenant                : input.tenant,
    module,
    modulePath,
    messageTimestamp      : input.messageTimestamp,
  });
  return policy?.recordLimit;
}

async function getRecordLimit(input: {
  validationStateReader: ValidationStateReader;
  tenant: string;
  module: string;
  modulePath: string;
  messageTimestamp: string;
}): Promise<{ recordLimit: ModuleRecordLimitDefinition; physicalDepth: number } | undefined> {
  let moduleDefinition;
  try {
    moduleDefinition = await input.validationStateReader.fetchModuleDefinition(
      input.tenant,
      input.module,
      input.messageTimestamp,
    );
  } catch (error) {
    if (error instanceof DwnError && error.code === DwnErrorCode.ModuleAuthorizationModuleNotFound) {
      return undefined;
    }
    throw error;
  }

  const ruleSet = getRuleSetAtPath(input.modulePath, moduleDefinition.structure);
  const recordLimit = ruleSet?.$recordLimit;
  if (recordLimit === undefined) {
    return undefined;
  }
  const definitions = await preloadModuleDefinitions(moduleDefinition,
    uri => input.validationStateReader.fetchModuleDefinition(input.tenant, uri, input.messageTimestamp));
  const graph = resolveModuleGraph(moduleDefinition, uri => definitions.get(uri));
  const node = graph.nodesByDeclaredPath.get(input.modulePath)!;
  return { recordLimit, physicalDepth: node.physicalDepth };
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
