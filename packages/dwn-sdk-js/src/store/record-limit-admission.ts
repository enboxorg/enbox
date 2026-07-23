import type { KeyValues } from '../types/query-types.js';
import type { MessageStoreRecordLimitCondition } from '../types/message-store.js';

import { DwnConstant } from '../core/dwn-constant.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export type MessageStoreRecordLimitScope = {
  max: number;
  parentId?: string;
  protocol: string;
  protocolPath: string;
  recordId: string;
};

/**
 * Validates a message-store record-limit condition and derives its exact membership scope.
 * Store implementations use this shared boundary so every backend applies the same invariants.
 */
export function parseMessageStoreRecordLimitScope(
  condition: MessageStoreRecordLimitCondition,
  indexes: KeyValues,
): MessageStoreRecordLimitScope {
  if (!Number.isSafeInteger(condition.max) || condition.max < 1 || condition.max > DwnConstant.maxRecordLimit) {
    throw new RangeError(`MessageStore: record limit max must be between 1 and ${DwnConstant.maxRecordLimit}.`);
  }
  if (indexes.interface !== DwnInterfaceName.Records ||
    indexes.method !== DwnMethodName.Write ||
    indexes.isLatestBaseState !== true) {
    throw new Error('MessageStore: record limit admission requires a current RecordsWrite.');
  }

  const { protocol, protocolPath, parentId, recordId } = indexes;
  if (typeof protocol !== 'string' ||
    typeof protocolPath !== 'string' ||
    (parentId !== undefined && typeof parentId !== 'string') ||
    typeof recordId !== 'string') {
    throw new Error('MessageStore: record limit admission requires indexed scope and member fields.');
  }

  return {
    max: condition.max,
    parentId,
    protocol,
    protocolPath,
    recordId,
  };
}
