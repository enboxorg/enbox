import type { MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';

import type { SyncMessageEntry } from '../sync-messages.js';

import { Encoder } from '@enbox/dwn-sdk-js';

import { recordsWriteRequiresData } from '../sync-fetch-helpers.js';

type DataStreamFactory = (
  entry: MessagesQueryReplyEntry,
) => () => Promise<ReadableStream<Uint8Array> | undefined>;

/** Convert received feed envelopes into the normal admission input shape. */
export function syncEntriesFromFeedEntries(
  entries: readonly MessagesQueryReplyEntry[],
  dataStreamFactory?: DataStreamFactory,
): SyncMessageEntry[] {
  const prepared: SyncMessageEntry[] = [];
  for (const entry of entries) {
    if (entry.initialWrite !== undefined) {
      prepared.push({ message: entry.initialWrite, isLatestBaseState: false });
    }
    if (entry.message === undefined) {
      continue;
    }
    const current: SyncMessageEntry = {
      message           : entry.message,
      messageCid        : entry.messageCid,
      isLatestBaseState : entry.isLatestBaseState,
    };
    if (entry.encodedData !== undefined) {
      current.bufferedData = Encoder.base64UrlToBytes(entry.encodedData);
    } else if (
      dataStreamFactory !== undefined &&
      entry.isLatestBaseState &&
      recordsWriteRequiresData(entry.message)
    ) {
      current.dataStreamFactory = dataStreamFactory(entry);
    }
    prepared.push(current);
  }
  return prepared;
}

/** Build one exact source token from a page domain and entry sequence. */
export function sourceTokenFromFeedEntry(
  pageCursor: ProgressToken,
  entry: MessagesQueryReplyEntry,
): ProgressToken {
  return {
    epoch      : pageCursor.epoch,
    messageCid : entry.messageCid,
    position   : entry.seq,
    streamId   : pageCursor.streamId,
  };
}
