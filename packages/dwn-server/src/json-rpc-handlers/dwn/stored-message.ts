import type { Dwn, GenericMessage } from '@enbox/dwn-sdk-js';

import { Message, Records } from '@enbox/dwn-sdk-js';

export type StoredMessageState = 'absent' | 'complete' | 'missing-data';

/** Finds the exact message and verifies any external RecordsWrite data it names. */
export async function getStoredMessageState(
  dwn: Dwn,
  tenant: string,
  message: GenericMessage,
): Promise<StoredMessageState> {
  const messageCid = await Message.getCid(message);
  const existingMessage = await dwn.storage.messageStore.get(tenant, messageCid);
  if (existingMessage === undefined) {
    return 'absent';
  }
  return await storedRecordsWriteHasData(dwn, tenant, existingMessage) ? 'complete' : 'missing-data';
}

async function storedRecordsWriteHasData(
  dwn: Dwn,
  tenant: string,
  message: GenericMessage,
): Promise<boolean> {
  if (!Records.isRecordsWrite(message) || message.descriptor.dataSize <= 0) {
    return true;
  }

  if (typeof (message as { encodedData?: unknown }).encodedData === 'string') {
    return true;
  }

  const storedData = await dwn.storage.dataStore.get(tenant, message.recordId, message.descriptor.dataCid);
  await storedData?.dataStream.cancel().catch((): void => {
    // The existence probe is enough; cancellation is best-effort.
  });
  return storedData !== undefined;
}
