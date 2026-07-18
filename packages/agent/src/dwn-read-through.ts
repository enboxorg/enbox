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
 * Outcome of the remote leg of a read-through:
 *
 * - `'ok'` — the remote replied authoritatively: a usable reply, or an
 *   authoritative empty (a 200 reply that simply has no matching entries).
 * - `'failed'` — the remote was unreachable or replied non-200, so an empty
 *   local projection cannot be treated as authoritative absence.
 * - `'skipped'` — the remote was never consulted: the local reply was already
 *   usable, or the tenant advertises no remote DWN endpoint to consult.
 */
export type RemoteReadOutcome = 'failed' | 'ok' | 'skipped';

/**
 * Reads from the local DWN first, then falls through to the remote DWN when the
 * local reply is well-formed but missing the requested durable dependency.
 * Identical response selection to {@link processDwnRequestWithRemoteFallback},
 * plus the {@link RemoteReadOutcome} of the remote leg so callers can
 * distinguish authoritative absence from an unreachable remote.
 */
export async function processDwnRequestWithRemoteFallbackDetailed<T extends DwnInterface>(
  executor: DwnReadThroughExecutor,
  request: ProcessDwnRequest<T>,
  hasUsableReply: (reply: DwnMessageReply[T]) => boolean,
): Promise<{ response: DwnResponse<T>; remote: RemoteReadOutcome }> {
  const localResponse = await executor.process(request);
  if (hasUsableReply(localResponse.reply)) {
    return { remote: 'skipped', response: localResponse };
  }

  try {
    const remoteResponse = await executor.send(request as SendDwnRequest<T>);
    const authoritative = hasUsableReply(remoteResponse.reply) || remoteResponse.reply.status.code === 200;
    return { remote: authoritative ? 'ok' : 'failed', response: remoteResponse };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.log(`AgentDwnApi: remote fallback for ${request.messageType} to '${request.target}' failed: ${detail}`);
    // A tenant with no DWN service endpoint has no remote to consult — expected local-only shape, not a transport failure.
    const noRemoteEndpoint = detail.includes('DID Service is missing or malformed');
    return { remote: noRemoteEndpoint ? 'skipped' : 'failed', response: localResponse };
  }
}

/**
 * Reads from the local DWN first, then falls through to the remote DWN when the
 * local reply is well-formed but missing the requested durable dependency.
 */
export async function processDwnRequestWithRemoteFallback<T extends DwnInterface>(
  executor: DwnReadThroughExecutor,
  request: ProcessDwnRequest<T>,
  hasUsableReply: (reply: DwnMessageReply[T]) => boolean,
): Promise<DwnResponse<T>> {
  return (await processDwnRequestWithRemoteFallbackDetailed(executor, request, hasUsableReply)).response;
}
