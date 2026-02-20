import type { Filter } from '../types/query-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { RecordsWriteMessage } from '../types/records-types.js';

import { RecordsWrite } from '../interfaces/records-write.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

/**
 * Fetches the initial RecordsWrite message associated with the given (tenant + recordId).
 */
export async function fetchInitialWrite(
  tenant: string,
  recordId: string,
  messageStore: MessageStore
): Promise<RecordsWriteMessage | undefined> {

  const query: Filter = {
    interface : DwnInterfaceName.Records,
    method    : DwnMethodName.Write,
    recordId  : recordId
  };
  const { messages } = await messageStore.query(tenant, [query]);

  if (messages.length === 0) {
    return undefined;
  }

  const initialWrite = await RecordsWrite.getInitialWrite(messages);
  return initialWrite;
}

/**
 * Constructs the chain of EXISTING records in the datastore where the first record is the root initial `RecordsWrite` of the record chain
 * and last record is the initial `RecordsWrite` of the descendant record specified.
 * @param descendantRecordId The ID of the descendent record to start constructing the record chain from by repeatedly looking up the parent.
 * @returns the record chain where each record is represented by its initial `RecordsWrite`;
 *          returns empty array if `descendantRecordId` is `undefined`.
 * @throws {DwnError} if `descendantRecordId` is defined but any initial `RecordsWrite` is not found in the chain of records.
 */
export async function constructRecordChain(
  tenant: string,
  descendantRecordId: string | undefined,
  messageStore: MessageStore
): Promise<RecordsWriteMessage[]> {

  if (descendantRecordId === undefined) {
    return [];
  }

  const recordChain: RecordsWriteMessage[] = [];

  // keep walking up the chain from the inbound message's parent, until there is no more parent
  let currentRecordId: string | undefined = descendantRecordId;
  while (currentRecordId !== undefined) {

    const initialWrite = await fetchInitialWrite(tenant, currentRecordId, messageStore);

    // RecordsWrite needed should be available since we perform necessary checks at the time of writes,
    // eg. check the immediate parent in `verifyProtocolPathAndContextId` at the time of writing,
    // so if this condition is triggered, it means there is an unexpected bug that caused an incomplete chain.
    // We add additional defensive check here because returning an unexpected/incorrect record chain could lead to security vulnerabilities.
    if (initialWrite === undefined) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationParentNotFoundConstructingRecordChain,
        `Unexpected error that should never trigger: no parent found with ID ${currentRecordId} when constructing record chain.`
      );
    }

    recordChain.push(initialWrite);
    currentRecordId = initialWrite.descriptor.parentId;
  }

  return recordChain.reverse(); // root record first
}

/**
 * Determines the timestamp that governs which protocol definition version applies to the given RecordsWrite.
 * For an update, this is the initial write's `messageTimestamp` (the protocol version is locked at creation time).
 * For a new initial write, returns `undefined` — the latest protocol definition should be used because the
 * record is being created now and must conform to the current protocol rules.
 */
export async function getGoverningTimestamp(
  tenant: string,
  incomingMessage: RecordsWrite,
  messageStore: MessageStore,
): Promise<string | undefined> {
  const existingInitialWrite = await fetchInitialWrite(
    tenant, incomingMessage.message.recordId, messageStore
  );

  if (existingInitialWrite !== undefined) {
    // update case: use the initial write's timestamp
    return existingInitialWrite.descriptor.messageTimestamp;
  }

  // initial write case: validate against the latest protocol definition
  return undefined;
}
