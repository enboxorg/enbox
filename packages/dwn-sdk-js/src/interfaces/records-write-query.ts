import type { GenericMessage } from '../types/message-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { RecordsWrite } from './records-write.js';
import type { InternalRecordsWriteMessage, RecordsWriteMessage } from '../types/records-types.js';

import { Jws } from '../utils/jws.js';
import { Message } from '../core/message.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

// Late-bound import to avoid circular dependency at module-evaluation time.
// `RecordsWrite` imports this module; this module needs `RecordsWrite.isInitialWrite` and `.parse`.
let _RecordsWriteClass: typeof RecordsWrite;
async function getRecordsWrite(): Promise<typeof RecordsWrite> {
  if (!_RecordsWriteClass) {
    const mod = await import('./records-write.js');
    _RecordsWriteClass = mod.RecordsWrite;
  }
  return _RecordsWriteClass;
}

/**
 * Gets the initial write from the given list of messages.
 */
export async function getInitialWrite(messages: GenericMessage[]): Promise<RecordsWriteMessage> {
  const RW = await getRecordsWrite();
  for (const message of messages) {
    if (await RW.isInitialWrite(message)) {
      return message as RecordsWriteMessage;
    }
  }

  throw new DwnError(DwnErrorCode.RecordsWriteGetInitialWriteNotFound, `Initial write is not found.`);
}

/**
 * Verifies that immutable properties of the two given messages are identical.
 * @throws {DwnError} if immutable properties between two RecordsWrite messages differ.
 */
export function verifyEqualityOfImmutableProperties(
  existingWriteMessage: RecordsWriteMessage, newMessage: RecordsWriteMessage
): boolean {
  const mutableDescriptorProperties = ['dataCid', 'dataSize', 'dataFormat', 'datePublished', 'published', 'messageTimestamp', 'tags'];

  // get distinct property names that exist in either the existing message given or new message
  let descriptorPropertyNames: string[] = [];
  descriptorPropertyNames.push(...Object.keys(existingWriteMessage.descriptor));
  descriptorPropertyNames.push(...Object.keys(newMessage.descriptor));
  descriptorPropertyNames = [...new Set(descriptorPropertyNames)]; // step to remove duplicates

  // ensure all immutable properties are not modified
  for (const descriptorPropertyName of descriptorPropertyNames) {
    // if property is supposed to be immutable
    if (mutableDescriptorProperties.indexOf(descriptorPropertyName) === -1) {
      const valueInExistingWrite = (existingWriteMessage.descriptor as Record<string, unknown>)[descriptorPropertyName];
      const valueInNewMessage = (newMessage.descriptor as Record<string, unknown>)[descriptorPropertyName];
      if (valueInNewMessage !== valueInExistingWrite) {
        throw new DwnError(
          DwnErrorCode.RecordsWriteImmutablePropertyChanged,
          `${descriptorPropertyName} is an immutable property: cannot change '${valueInExistingWrite}' to '${valueInNewMessage}'`
        );
      }
    }
  }

  return true;
}

/**
 * Gets the DID of the attesters of the given message.
 */
export function getAttesters(message: InternalRecordsWriteMessage): string[] {
  const attestationSignatures = message.attestation?.signatures ?? [];
  const attesters = attestationSignatures.map((signature): string => Jws.getSignerDid(signature));
  return attesters;
}

/**
 * Fetches the newest RecordsWrite for a given recordId from the message store.
 * @throws {DwnError} if no write is found.
 */
export async function fetchNewestRecordsWrite(
  messageStore: MessageStore,
  tenant: string,
  recordId: string,
): Promise<RecordsWriteMessage> {
  // get existing RecordsWrite messages matching the `recordId`
  const query = {
    interface : DwnInterfaceName.Records,
    method    : DwnMethodName.Write,
    recordId  : recordId
  };

  const { messages: existingMessages } = await messageStore.query(tenant, [ query ]);
  const newestWrite = await Message.getNewestMessage(existingMessages);
  if (newestWrite !== undefined) {
    return newestWrite as RecordsWriteMessage;
  }

  throw new DwnError(DwnErrorCode.RecordsWriteGetNewestWriteRecordNotFound, 'record not found');
}

/**
 * Fetches the initial RecordsWrite of a record.
 * @returns The initial RecordsWrite if found; `undefined` otherwise.
 */
export async function fetchInitialRecordsWrite(
  messageStore: MessageStore,
  tenant: string,
  recordId: string
): Promise<RecordsWrite | undefined> {
  const initialRecordsWriteMessage = await fetchInitialRecordsWriteMessage(messageStore, tenant, recordId);
  if (initialRecordsWriteMessage === undefined) {
    return undefined;
  }

  const RW = await getRecordsWrite();
  const initialRecordsWrite = await RW.parse(initialRecordsWriteMessage);
  return initialRecordsWrite;
}

/**
 * Fetches the initial RecordsWrite message of a record.
 * @returns The initial RecordsWriteMessage if found; `undefined` otherwise.
 */
export async function fetchInitialRecordsWriteMessage(
  messageStore: MessageStore,
  tenant: string,
  recordId: string
): Promise<RecordsWriteMessage | undefined> {
  // `entryId === recordId` identifies the initial write. Do not also filter on
  // `isLatestBaseState:false`: that mutable index is updated after a newer
  // write is inserted, so it can still be `true` during the update transition.
  const query = { entryId: recordId };
  const { messages } = await messageStore.query(tenant, [query]);

  if (messages.length === 0) {
    return undefined;
  }

  return messages[0] as RecordsWriteMessage;
}
