import type { FlowContext } from '../../src/connect/lifecycle.js';

/** Give a directly exercised connect flow an explicit test-owned session lifetime. */
export function createFlowContext(context: Omit<FlowContext, 'sessionSignal'>): FlowContext {
  return {
    ...context,
    sessionSignal: new AbortController().signal,
  };
}
