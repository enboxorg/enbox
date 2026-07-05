import type {
  DwnInterface,
  DwnMessageReply,
  DwnResponse,
  ProcessDwnRequest,
  SendDwnRequest,
} from './types/dwn.js';

import { logger } from '@enbox/common';

export type DwnReadThroughExecutor = {
  process<T extends DwnInterface>(request: ProcessDwnRequest<T>): Promise<DwnResponse<T>>;
  send<T extends DwnInterface>(request: SendDwnRequest<T>): Promise<DwnResponse<T>>;
};

/**
 * Reads from the local DWN first, then falls through to the remote DWN when the
 * local reply is well-formed but missing the requested durable dependency.
 */
export async function processDwnRequestWithRemoteFallback<T extends DwnInterface>(
  executor: DwnReadThroughExecutor,
  request: ProcessDwnRequest<T>,
  hasUsableReply: (reply: DwnMessageReply[T]) => boolean,
): Promise<DwnResponse<T>> {
  const localResponse = await executor.process(request);
  if (hasUsableReply(localResponse.reply)) {
    return localResponse;
  }

  try {
    return await executor.send(request as SendDwnRequest<T>);
  } catch (error) {
    logger.log(
      `AgentDwnApi: remote fallback for ${request.messageType} to '${request.target}' failed: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
    return localResponse;
  }
}
