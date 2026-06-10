import type { GenericMessage } from '@enbox/dwn-sdk-js';
import type { RequestContext } from '../../lib/json-rpc-router.js';

import log from 'loglevel';

export function invokeMessageProcessedHooks(
  context: RequestContext,
  tenant: string,
  message: GenericMessage,
  status: { code: number; detail: string },
): void {
  if (context.messageProcessedHooks === undefined) {
    return;
  }

  const hookContext = { tenant, message, status, transport: context.transport };
  for (const hook of context.messageProcessedHooks) {
    try {
      const result = hook.onMessageProcessed(hookContext);
      if (result instanceof Promise) {
        result.catch((err: unknown): void => {
          log.error('MessageProcessedHook error', err);
        });
      }
    } catch (err) {
      log.error('MessageProcessedHook error', err);
    }
  }
}
