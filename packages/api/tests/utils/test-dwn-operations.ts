import type { DwnMessage, DwnResponseStatus, EnboxPlatformAgent } from '@enbox/agent';

import { DwnInterface } from '@enbox/agent';
import { Message } from '@enbox/dwn-sdk-js';

import { DwnResponseError } from '../../src/dwn-response-error.js';
import type { Protocol } from '../../src/protocol.js';
import type { Record } from '../../src/record.js';

/** Publish a locally stored protocol message through the raw agent escape hatch. */
export async function publishProtocol(
  agent: EnboxPlatformAgent,
  protocol: Protocol,
  author: string,
  target: string,
): Promise<DwnResponseStatus> {
  const messageCid = await Message.getCid(protocol.toJSON());
  const { reply } = await agent.sendDwnRequest({
    author,
    messageCid  : messageCid,
    messageType : DwnInterface.ProtocolsConfigure,
    target,
  });
  return { status: reply.status };
}

/** Publish a locally stored record message through the raw agent escape hatch. */
export async function publishRecord(
  agent: EnboxPlatformAgent,
  record: Record,
  author: string,
  target: string,
): Promise<void> {
  if (record.initialWrite !== undefined) {
    await agent.sendDwnRequest({
      author,
      messageType : DwnInterface.RecordsWrite,
      rawMessage  : record.initialWrite,
      target,
    });
  }

  if (record.deleted || record.encryption === undefined) {
    const { reply } = await agent.sendDwnRequest({
      author,
      ...(record.deleted ? {} : { dataStream: await record.data.stream() }),
      messageType : record.deleted ? DwnInterface.RecordsDelete : DwnInterface.RecordsWrite,
      rawMessage  : record.rawMessage as DwnMessage[DwnInterface.RecordsWrite | DwnInterface.RecordsDelete],
      target,
    });
    if (reply.status.code < 200 || reply.status.code > 299) {
      throw new DwnResponseError('publishRecord', reply.status);
    }
    return;
  }

  const messageCid = await Message.getCid(record.rawMessage);
  const { reply } = await agent.sendDwnRequest({
    author,
    messageCid  : messageCid,
    messageType : record.deleted ? DwnInterface.RecordsDelete : DwnInterface.RecordsWrite,
    target,
  });
  if (reply.status.code < 200 || reply.status.code > 299) {
    throw new DwnResponseError('publishRecord', reply.status);
  }
}

/** Publish an unencrypted, deliberately unstored write through the raw agent escape hatch. */
export async function publishUnstoredRecord(
  agent: EnboxPlatformAgent,
  record: Record,
  author: string,
  target: string,
): Promise<DwnResponseStatus> {
  if (record.encryption !== undefined || record.deleted) {
    throw new TypeError('publishUnstoredRecord requires an unencrypted RecordsWrite.');
  }

  const { reply } = await agent.sendDwnRequest({
    author,
    dataStream  : await record.data.stream(),
    messageType : DwnInterface.RecordsWrite,
    rawMessage  : record.rawMessage as DwnMessage[DwnInterface.RecordsWrite],
    target,
  });
  if (reply.status.code < 200 || reply.status.code > 299) {
    throw new DwnResponseError('publishUnstoredRecord', reply.status);
  }
  return { status: reply.status };
}
