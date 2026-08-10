import type { DidResolver } from '@enbox/dids';
import type { EnboxRpc } from '@enbox/dwn-clients';
import type { PaginationCursor, RecordsDeleteMessage, RecordsWrite, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { resolveDwnEndpointStatus } from '@enbox/dids';
import { DateSort, DwnInterfaceName, DwnMethodName, Jws, Message } from '@enbox/dwn-sdk-js';

export async function getDwnServiceEndpointUrls(didUri: string, resolver: DidResolver): Promise<string[]> {
  const result = await resolveDwnEndpointStatus(didUri, resolver);
  if (result.status !== 'ready') {
    throw new Error(result.message);
  }

  return result.endpoints;
}

/** Resolves the WebSocket transport advertised for a DWN HTTP endpoint. */
export async function resolveDwnSubscriptionUrl(dwnUrl: string, rpcClient: EnboxRpc): Promise<string> {
  const serverInfo = await rpcClient.getServerInfo(dwnUrl);
  if (!serverInfo.webSocketSupport) {
    throw new Error('WebSocket support is not enabled on the server.');
  }

  const parsedUrl = new URL(dwnUrl);
  parsedUrl.protocol = parsedUrl.protocol === 'http:' ? 'ws:' : 'wss:';
  return parsedUrl.toString();
}

export function getRecordAuthor(record: RecordsWriteMessage | RecordsDeleteMessage): string | undefined {
  return Message.getAuthor(record);
}

/**
 * Get the `protocolRole` string from the signature payload of the given RecordsWriteMessage or RecordsDeleteMessage.
 */
export function getRecordProtocolRole(message: RecordsWriteMessage | RecordsDeleteMessage): string | undefined {
  const signaturePayload = Jws.decodePlainObjectPayload(message.authorization.signature);
  return signaturePayload?.protocolRole;
}

export function isRecordsWrite(obj: unknown): obj is RecordsWrite {
  // Validate that the given value is an object.
  if (!obj || typeof obj !== 'object' || obj === null) {return false;}

  // Validate that the object has the necessary properties of RecordsWrite.
  return (
    'message' in obj && typeof obj.message === 'object' && obj.message !== null &&
    'descriptor' in obj.message && typeof obj.message.descriptor === 'object' && obj.message.descriptor !== null &&
    'interface' in obj.message.descriptor && obj.message.descriptor.interface === DwnInterfaceName.Records &&
    'method' in obj.message.descriptor && obj.message.descriptor.method === DwnMethodName.Write
  );
}

/**
 * Get the CID of the given RecordsWriteMessage.
 */
export function getRecordMessageCid(message: RecordsWriteMessage): Promise<string> {
  return Message.getCid(message);
}

/**
 *  Get the pagination cursor for the given RecordsWriteMessage and DateSort.
 *
 * @param message The RecordsWriteMessage for which to get the pagination cursor.
 * @param dateSort The date sort that will be used in the query or subscription to which the cursor will be applied.
 */
export async function getPaginationCursor(message: RecordsWriteMessage, dateSort: DateSort): Promise<PaginationCursor> {
  let value: string;
  switch (dateSort) {
    case DateSort.CreatedAscending:
    case DateSort.CreatedDescending:
      value = message.descriptor.dateCreated;
      break;
    case DateSort.PublishedAscending:
    case DateSort.PublishedDescending:
      if (message.descriptor.datePublished === undefined) {
        throw new Error('getPaginationCursor: datePublished is missing from the record descriptor.');
      }
      value = message.descriptor.datePublished;
      break;
    case DateSort.UpdatedAscending:
    case DateSort.UpdatedDescending:
      value = message.descriptor.messageTimestamp;
      break;
    default:
      return unsupportedDateSort(dateSort);
  }

  return {
    messageCid: await getRecordMessageCid(message),
    value
  };
}

function unsupportedDateSort(dateSort: never): never {
  throw new Error(`getPaginationCursor: unsupported date sort '${dateSort}'.`);
}

/**
 * Map over an array with bounded concurrency, preserving input order in the
 * output array. Uses a sliding-window pool of workers so the next item is
 * picked up as soon as any in-flight task settles — strictly better than a
 * fixed chunked-batch pattern (no stalling on the slowest item per batch).
 *
 * Semantics match `Promise.all`: the returned promise rejects on the first
 * task rejection. Use {@link mapConcurrentSettled} when individual failures
 * should not abort the whole batch (e.g. best-effort fan-out).
 *
 * @param items Input items to map over.
 * @param concurrency Maximum number of in-flight tasks. Must be >= 1.
 * @param fn Per-item async function. Receives the item and its index.
 * @returns An array of results in the same order as `items`.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`mapConcurrent: concurrency must be a positive integer, got ${concurrency}`);
  }
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i], i);
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Settled variant of {@link mapConcurrent}: never rejects — every task's
 * outcome is captured as a `PromiseSettledResult`. Use this for best-effort
 * fan-outs where partial success is acceptable.
 */
export async function mapConcurrentSettled<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapConcurrent<T, PromiseSettledResult<R>>(items, concurrency, async (item, index) => {
    try {
      const value = await fn(item, index);
      return { status: 'fulfilled', value };
    } catch (reason) {
      return { status: 'rejected', reason };
    }
  });
}
